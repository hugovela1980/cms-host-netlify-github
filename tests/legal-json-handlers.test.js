import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { createCmsHostPolicyBundle, createCmsJsonRecordStore,
    createCmsLeaseManager, createCmsLegalCapability, createCmsLegalService,
    createCmsOptionalLegalJsonHandlers } from "../src/server/index.js";
import { syntheticDocx, syntheticLegalConfig, syntheticPdf } from "./fixtures/legal.js";

const actor = Object.freeze({ id: "editor@example.test", email: "editor@example.test" });
const now = () => new Date("2026-11-04T12:00:00.000Z");
const endpoint = "https://example.test/api/cms/legal-reference";

async function fixture({ previewBasePath, sweep = async () => ({}),
    logger = { error() {} } } = {}) {
    const entries = new Map();
    let sequence = 0;
    const store = {
        async getWithMetadata(key) { return structuredClone(entries.get(key) ?? null); },
        async set(key, data, options) { return this.write(key, data, options); },
        async setJSON(key, data, options) { return this.write(key, data, options); },
        async write(key, data, options = {}) {
            const current = entries.get(key);
            if (options.onlyIfNew && current) return { modified: false };
            if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
                return { modified: false };
            }
            const etag = `etag-${++sequence}`;
            entries.set(key, { data: structuredClone(data), etag,
                metadata: structuredClone(options.metadata ?? {}) });
            return { modified: true, etag };
        },
    };
    const records = createCmsJsonRecordStore({ store, keys: {
        draft: "state/draft", confirmedLive: "state/live",
        coordination: "state/coordination",
    } });
    const capability = await createCmsLegalCapability(syntheticLegalConfig());
    const bundle = capability.assetBundle;
    const leases = createCmsLeaseManager({ records, now,
        createOwner: () => "legal-handler-fixture" });
    const legalService = createCmsLegalService({ capability, store, records, leases,
        now, ...(previewBasePath ? { previewBasePath } : {}) });
    await records.writeIfVersion("confirmedLive", { content: { home: { heading: "Live" } },
        revisionId: "live-1", legal: legalService.initialPairs() }, null);
    const calls = [];
    const handlers = createCmsOptionalLegalJsonHandlers({ bundle, legalService,
        cleanup: { sweep },
        foundation: { async ensure(input) { calls.push("foundation");
            assert.deepEqual(input, { canonicalContent: { home: { heading: "Checkout" } } }); } },
        canonicalContent() { calls.push("canonical"); return { home: { heading: "Checkout" } }; },
        logger });
    return { entries, store, records, leases, capability, bundle, legalService, handlers, calls };
}

function uploadRequest(kind, file) {
    const form = new FormData();
    form.set("page", "privacy");
    form.set("kind", kind);
    form.set("file", file);
    form.set("actor", "forged@example.test");
    return new Request(endpoint, { method: "POST", body: form });
}

function post(body) {
    return new Request(endpoint, { method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function json(response, status) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("ETag"), null);
    return response.json();
}

test("optional handlers are absent for no-legal host and reject mismatched services", async () => {
    const bundle = createCmsHostPolicyBundle({ contentPolicy: {
        classifyPublic(raw) { return { kind: "current", content: raw }; },
        normalizePersisted(raw) { return raw; },
        validateCurrent(raw) { return raw; },
        historicalManagedAssetReferences() { return new Set(); },
    }, managedImages: [] });
    assert.deepEqual(Object.keys(createCmsOptionalLegalJsonHandlers({ bundle })), []);
    const f = await fixture();
    assert.throws(() => createCmsOptionalLegalJsonHandlers({ bundle,
        legalService: f.legalService }), TypeError);
    assert.throws(() => createCmsOptionalLegalJsonHandlers({ bundle: f.bundle,
        legalService: f.legalService, cleanup: { sweep() {} } }), TypeError);
    assert.throws(() => createCmsLegalService({ capability: f.capability,
        store: f.store, records: f.records, leases: f.leases,
        previewBasePath: "//evil.test" }), TypeError);
});

test("upload and original/staged reference preserve full JSON shapes and preview paths", async () => {
    const f = await fixture();
    const scheduled = [];
    const documentBytes = syntheticDocx("Privacy Policy", "Updated wording.");
    const documentHash = createHash("sha256").update(documentBytes).digest("hex");
    const document = await json(await f.handlers.uploadLegal({
        request: uploadRequest("document", new File([documentBytes], "policy.docx")), actor,
        context: { waitUntil(promise) { scheduled.push(promise); } },
    }), 201);
    assert.deepEqual(document, { page: "privacy", kind: "document", hash: documentHash,
        name: "policy.docx", versionId: documentHash,
        previewUrl: `/api/cms/legal-preview?page=privacy&kind=document&hash=${documentHash}` });
    assert.equal(scheduled.length, 1);
    await scheduled[0];
    const staged = await json(await f.handlers.legalReference({ actor,
        request: new Request(`${endpoint}?page=privacy&kind=document&hash=${document.hash}`),
    }), 200);
    assert.deepEqual(staged, { name: "policy.docx", previewUrl: document.previewUrl });
    const original = f.legalService.initialPairs().privacy.pdf;
    assert.deepEqual(await json(await f.handlers.legalReference({ actor,
        request: new Request(`${endpoint}?page=privacy&kind=pdf&hash=${original.hash}`),
    }), 200), { name: original.name,
        previewUrl: `/api/cms/legal-preview?page=privacy&kind=pdf&hash=${original.hash}` });
    assert.equal(f.entries.get(`legal/staged/privacy/document/${document.hash}/metadata`).data
        .uploadedBy, actor.email);
    const custom = await fixture({ previewBasePath: "/editor/cms" });
    const customOriginal = custom.legalService.initialPairs().privacy.pdf;
    assert.deepEqual(await json(await custom.handlers.legalReference({ actor,
        request: new Request(`${endpoint}?page=privacy&kind=pdf&hash=${customOriginal.hash}`),
    }), 200), { name: customOriginal.name,
        previewUrl: `/editor/cms/legal-preview?page=privacy&kind=pdf&hash=${customOriginal.hash}` });
    const customUpload = await json(await custom.handlers.uploadLegal({ actor,
        request: uploadRequest("document", new File([syntheticDocx("Privacy Policy",
            "Custom route wording.")], "custom.docx")),
    }), 201);
    assert.equal(customUpload.previewUrl,
        `/editor/cms/legal-preview?page=privacy&kind=document&hash=${customUpload.hash}`);
});

test("legal-only Save and exact confirmation use foundation only for Save", async () => {
    const f = await fixture();
    const doc = await f.legalService.stage({ page: "privacy", kind: "document",
        file: new File([syntheticDocx("Privacy Policy", "New wording.")], "policy.docx") }, actor);
    const pdf = await f.legalService.stage({ page: "privacy", kind: "pdf",
        file: new File([syntheticPdf("")], "policy.pdf") }, actor);
    const saved = await json(await f.handlers.saveLegalDraft({ actor, request: post({
        page: "privacy", documentHash: doc.hash, pdfHash: pdf.hash,
        expectedDraftVersion: null,
    }) }), 200);
    const pair = await f.legalService.composePair("privacy", doc.hash, pdf.hash);
    const savedRecord = await f.records.read("draft");
    assert.deepEqual(saved, { legal: { privacy: pair },
        draftVersion: savedRecord.etag, hasSavedDraft: true });
    assert.equal(pair.verification.status, "could-not-verify");
    assert.deepEqual(f.calls, ["canonical", "foundation"]);
    const stale = await json(await f.handlers.confirmLegal({ actor, request: post({
        page: "privacy", documentHash: doc.hash, pdfHash: pdf.hash,
        expectedDraftVersion: "stale",
    }) }), 409);
    assert.equal(stale.code, "DRAFT_CONFLICT");
    const confirmed = await json(await f.handlers.confirmLegal({ actor, request: post({
        page: "privacy", documentHash: doc.hash, pdfHash: pdf.hash,
        expectedDraftVersion: saved.draftVersion,
    }) }), 200);
    const confirmation = { documentHash: doc.hash,
        pdfHash: pdf.hash, editor: actor.email, at: now().toISOString() };
    assert.deepEqual(confirmed, { legal: { privacy: { ...pair, confirmation } },
        draftVersion: (await f.records.read("draft")).etag, confirmation });
    assert.deepEqual(f.calls, ["canonical", "foundation"]);
});

test("method, actor, JSON and file errors happen before writes", async () => {
    const f = await fixture();
    assert.equal((await f.handlers.uploadLegal({ request: new Request(endpoint), actor })).status, 405);
    assert.equal((await f.handlers.legalReference({ request: post({}), actor })).status, 405);
    assert.equal((await f.handlers.saveLegalDraft({ request: new Request(endpoint), actor })).status, 405);
    assert.equal((await f.handlers.confirmLegal({ request: new Request(endpoint), actor })).status, 405);
    assert.equal((await f.handlers.legalReference({ request: new Request(endpoint) })).status, 500);
    assert.equal((await f.handlers.uploadLegal({ request: uploadRequest("pdf",
        new File([syntheticPdf()], "policy.pdf")) })).status, 500);
    assert.equal((await f.handlers.uploadLegal({ request: post("not multipart"), actor })).status, 500);
    assert.equal((await f.handlers.saveLegalDraft({ request: post("[]"), actor })).status, 400);
    assert.equal((await f.handlers.confirmLegal({ request: post("x".repeat(256_001)), actor })).status, 413);
    const invalid = await json(await f.handlers.uploadLegal({ actor,
        request: uploadRequest("pdf", new File(["not pdf"], "policy.pdf")),
    }), 415);
    assert.equal(invalid.code, "INVALID_LEGAL_PDF");
    const tooLarge = await json(await f.handlers.uploadLegal({ actor,
        request: uploadRequest("document", new File([new Uint8Array(8 * 1024 * 1024 + 1)],
            "large.docx")),
    }), 413);
    assert.equal(tooLarge.code, "INVALID_LEGAL_FILE_SIZE");
    assert.deepEqual(f.calls, []);
});

test("legal upload returns before a pending cleanup sweep", async () => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const f = await fixture({ sweep: () => pending });
    const scheduled = [];
    const result = await f.handlers.uploadLegal({ actor,
        request: uploadRequest("document", new File([syntheticDocx("Privacy Policy",
            "Waiting cleanup.")], "waiting.docx")),
        context: { waitUntil(promise) { scheduled.push(promise); } },
    });
    assert.equal(result.status, 201);
    assert.equal(scheduled.length, 1);
    finish();
    await scheduled[0];
});

test("cleanup rejection retains 201 while synchronous waitUntil throw masks a staged upload", async () => {
    const logged = [];
    const f = await fixture({ sweep: async () => { throw new Error("cleanup failed"); },
        logger: { error(...args) { logged.push(args); } } });
    const request = () => uploadRequest("document", new File([
        syntheticDocx("Privacy Policy", "Changed wording.")], "policy.docx"));
    const scheduled = [];
    assert.equal((await f.handlers.uploadLegal({ request: request(), actor,
        context: { waitUntil(promise) { scheduled.push(promise); } } })).status, 201);
    await scheduled[0];
    assert.equal(logged[0][0], "Unable to sweep abandoned legal files.");
    const failed = await json(await f.handlers.uploadLegal({ request: request(), actor,
        context: { waitUntil() { throw new Error("schedule failed"); } } }), 500);
    assert.deepEqual(failed, { code: "CMS_SERVICE_ERROR",
        message: "The CMS service could not complete the request." });
});
