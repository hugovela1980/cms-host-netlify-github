import assert from "node:assert/strict";
import test from "node:test";

import { createCmsJsonRecordStore, createCmsLeaseManager,
    createCmsLegalCapability, createCmsLegalService,
    createCmsHostPolicyBundle } from "../src/server/index.js";
import { syntheticDocx, syntheticLegalConfig, syntheticPdf } from "./fixtures/legal.js";

const actor = { email: "editor@example.test" };
const fixedNow = () => new Date("2026-11-04T12:00:00.000Z");

async function fixture() {
    const entries = new Map();
    let sequence = 0;
    let failure = null;
    const store = {
        async getWithMetadata(key) {
            if (failure?.method === "getWithMetadata") throw failure.error;
            return structuredClone(entries.get(key) ?? null);
        },
        async get(key) {
            if (failure?.method === "get") throw failure.error;
            return structuredClone(entries.get(key)?.data ?? null);
        },
        async getMetadata(key) {
            const value = entries.get(key);
            return value ? { etag: value.etag, metadata: structuredClone(value.metadata) } : null;
        },
        async set(key, data, options) { return this.write(key, data, options); },
        async setJSON(key, data, options) { return this.write(key, data, options); },
        async write(key, data, options) {
            if (failure?.method === "write") throw failure.error;
            const current = entries.get(key);
            if (options?.onlyIfNew && current) return { modified: false };
            if (options?.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
                return { modified: false };
            }
            const etag = `v${++sequence}`;
            entries.set(key, { data: structuredClone(data), etag,
                metadata: structuredClone(options?.metadata ?? {}) });
            return { modified: true, etag };
        },
    };
    const records = createCmsJsonRecordStore({ store, keys: {
        draft: "state/draft", confirmedLive: "state/confirmed-live",
        coordination: "state/coordination",
    } });
    const leases = createCmsLeaseManager({ records, now: fixedNow,
        createOwner: () => "legal-fixture" });
    const capability = await createCmsLegalCapability(syntheticLegalConfig());
    const writerLeases = { acquire: (...args) => leases.acquire(...args),
        renew: (...args) => leases.renew(...args),
        release: (...args) => leases.release(...args) };
    const service = createCmsLegalService({ capability, store, records,
        leases: writerLeases, now: fixedNow });
    await records.writeIfVersion("confirmedLive", { content: { home: { heading: "Live" } },
        revisionId: "live-commit", legal: service.initialPairs() }, null);
    return { entries, store, records, leases, writerLeases, capability, service,
        fail(method, error = new Error("provider unavailable")) {
            failure = method ? { method, error } : null;
        } };
}

async function stagePair(service, documentText = "Edited wording.", pdfText = null) {
    const document = await service.stage({ page: "privacy", kind: "document",
        file: new File([syntheticDocx("Privacy Policy", documentText)], "policy.docx") }, actor);
    const pdf = await service.stage({ page: "privacy", kind: "pdf",
        file: new File([syntheticPdf(pdfText ?? `Privacy Policy ${documentText}`)], "policy.pdf") }, actor);
    return { document, pdf };
}

test("approved originals are loaded from exact host paths and malformed originals fail closed", async () => {
    const capability = await createCmsLegalCapability(syntheticLegalConfig());
    const originals = capability.initialPairs();
    assert.equal(originals.privacy.verification.status, "matches");
    assert.match(originals.privacy.document.hash, /^[0-9a-f]{64}$/);
    assert.equal(capability.sourcePath("privacy", originals.privacy.document),
        `content/legal-documents/privacy-${originals.privacy.document.hash}.docx`);
    await assert.rejects(createCmsLegalCapability(syntheticLegalConfig({
        readOriginal: async (path) => path.endsWith(".pdf") ? syntheticPdf("Different")
            : syntheticDocx(),
    })), { code: "LEGAL_ORIGINAL_UNAVAILABLE" });
    await assert.rejects(createCmsLegalCapability(syntheticLegalConfig({
        readOriginal: async (path) => path.endsWith(".pdf") ? Buffer.from("not a PDF")
            : syntheticDocx(),
    })), { code: "LEGAL_ORIGINAL_UNAVAILABLE" });
    const config = syntheticLegalConfig();
    const noLegal = createCmsHostPolicyBundle({ contentPolicy: {
        classifyPublic(raw) { return { kind: "current", content: raw }; },
        normalizePersisted(raw) { return raw; }, validateCurrent(raw) { return raw; },
        historicalManagedAssetReferences() { return new Set(); },
    }, managedImages: [] });
    await assert.rejects(createCmsLegalCapability({ ...config, assetBundle: noLegal }),
        TypeError);
    await assert.rejects(createCmsLegalCapability({ ...config, pages: {
        privacy: { ...config.pages.privacy,
            originalPdfPath: config.pages.privacy.pdfPath },
    } }), TypeError);
    await assert.rejects(createCmsLegalCapability({ ...config,
        renderedPath: config.manifestPath }), TypeError);
    await assert.rejects(createCmsLegalCapability({ ...config,
        manifestPath: `${config.sourceDirectory}/privacy.json` }), TypeError);
});

test("staging and pair composition distinguish matching, different, and unreadable PDF text", async () => {
    const f = await fixture();
    const matching = await stagePair(f.service);
    assert.equal((await f.service.composePair("privacy", matching.document.hash,
        matching.pdf.hash)).verification.status, "matches");
    const different = await f.service.stage({ page: "privacy", kind: "pdf",
        file: new File([syntheticPdf("Privacy Policy Wrong wording.")], "wrong.pdf") }, actor);
    const differentPair = await f.service.composePair("privacy", matching.document.hash,
        different.hash);
    assert.equal(differentPair.verification.status, "different");
    assert.throws(() => f.service.requirePublicationReady({ privacy: differentPair },
        f.service.initialPairs()), { code: "LEGAL_CONTENT_DIFFERENT" });
    const unreadable = await f.service.stage({ page: "privacy", kind: "pdf",
        file: new File([syntheticPdf("")], "image-only.pdf") }, actor);
    const inconclusive = await f.service.composePair("privacy", matching.document.hash,
        unreadable.hash);
    assert.equal(inconclusive.verification.status, "could-not-verify");
    assert.throws(() => f.service.requirePublicationReady({ privacy: inconclusive },
        f.service.initialPairs()), { code: "LEGAL_CONFIRMATION_REQUIRED" });
});

test("legal-only Save and exact confirmation preserve record and result shapes", async () => {
    const f = await fixture();
    const pair = await stagePair(f.service, "New wording.", "");
    const saved = await f.service.saveDraft({ page: "privacy",
        documentHash: pair.document.hash, pdfHash: pair.pdf.hash,
        expectedDraftVersion: null }, actor);
    assert.equal(saved.hasSavedDraft, true);
    assert.equal(saved.legal.privacy.verification.status, "could-not-verify");
    const draft = await f.records.read("draft");
    assert.deepEqual(draft.data.content, { home: { heading: "Live" } });
    assert.equal(draft.data.updatedBy, actor.email);
    assert.equal(draft.data.baseRevision, "live-commit");
    await assert.rejects(f.service.confirmPair({ page: "privacy",
        expectedDraftVersion: saved.draftVersion,
        documentHash: pair.document.hash, pdfHash: "wrong" }, actor),
    { code: "LEGAL_CONFIRMATION_INVALID" });
    const confirmed = await f.service.confirmPair({ page: "privacy",
        expectedDraftVersion: saved.draftVersion,
        documentHash: pair.document.hash, pdfHash: pair.pdf.hash }, actor);
    assert.deepEqual(confirmed.confirmation, { documentHash: pair.document.hash,
        pdfHash: pair.pdf.hash, editor: actor.email,
        at: "2026-11-04T12:00:00.000Z" });
    await f.service.verifyPublication(confirmed.legal, f.service.initialPairs());
    const replacement = await stagePair(f.service, "Other wording.", "");
    const changed = await f.service.saveDraft({ page: "privacy",
        documentHash: replacement.document.hash, pdfHash: replacement.pdf.hash,
        expectedDraftVersion: confirmed.draftVersion }, actor);
    assert.equal(changed.legal.privacy.confirmation, null);
    assert.throws(() => f.service.requirePublicationReady(changed.legal,
        f.service.initialPairs()), { code: "LEGAL_CONFIRMATION_REQUIRED" });
});

test("mixed content and legal composition is a read-only future orchestration seam", async () => {
    const f = await fixture();
    const pair = await stagePair(f.service);
    const initial = f.service.initialPairs();
    const changed = await f.service.composeChanges(initial, [
        { path: "legal.privacy.document", value: pair.document.hash },
        { path: "legal.privacy.pdf", value: pair.pdf.hash },
    ]);
    assert.equal(changed.privacy.verification.status, "matches");
    assert.equal(await f.records.read("draft"), null);
    await assert.rejects(f.service.composeChanges(initial, [
        { path: "legal.privacy.pdf", value: pair.pdf.hash },
        { path: "legal.privacy.pdf", value: pair.pdf.hash },
    ]), { code: "UNKNOWN_FIELD" });
});

test("same bytes with a different document format, missing metadata, and corrupted bytes fail closed", async () => {
    const f = await fixture();
    const first = await f.service.stage({ page: "privacy", kind: "document",
        file: new File(["# Policy"], "first.txt") }, actor);
    await assert.rejects(f.service.stage({ page: "privacy", kind: "document",
        file: new File(["# Policy"], "second.md") }, actor),
    { code: "LEGAL_VERSION_FORMAT_CONFLICT" });
    f.entries.delete(`${f.capability.stagedKey("privacy", "document", first.hash)}/metadata`);
    await assert.rejects(f.service.composePair("privacy", first.hash,
        f.service.initialPairs().privacy.pdf.hash), { code: "LEGAL_FILE_NOT_FOUND" });
    const key = f.capability.stagedKey("privacy", "document", first.hash);
    const current = f.entries.get(key);
    current.metadata.page = "other";
    await assert.rejects(f.service.readFile("privacy", "document", first.hash),
        { code: "LEGAL_FILE_NOT_FOUND" });
    f.entries.set(f.capability.stagedKey("privacy", "document", first.hash), {
        data: Buffer.from("changed").buffer, etag: "corrupt", metadata: {} });
    await assert.rejects(f.service.readFile("privacy", "document", first.hash),
        { code: "LEGAL_FILE_NOT_FOUND" });
});

test("a PDF sidecar with a non-PDF name cannot form a pair", async () => {
    const f = await fixture();
    const pdf = await f.service.stage({ page: "privacy", kind: "pdf",
        file: new File([syntheticPdf("Privacy Policy Altered wording.")], "policy.pdf") }, actor);
    const sidecar = f.entries.get(`${f.capability.stagedKey("privacy", "pdf", pdf.hash)}/metadata`);
    sidecar.data.name = "policy.txt";
    await assert.rejects(f.service.composePair("privacy",
        f.service.initialPairs().privacy.document.hash, pdf.hash),
    { code: "LEGAL_FILE_NOT_FOUND" });
});

test("busy or lost lease and provider failure never create a legal draft reference", async () => {
    const f = await fixture();
    const pair = await stagePair(f.service);
    const request = { page: "privacy", documentHash: pair.document.hash,
        pdfHash: pair.pdf.hash, expectedDraftVersion: null };
    const held = await f.leases.acquire({ kind: "cleanup" });
    await assert.rejects(f.service.saveDraft(request, actor),
        { code: "CMS_STATE_LOCKED" });
    assert.equal(await f.records.read("draft"), null);
    assert.equal(await f.leases.release(held), true);
    f.writerLeases.renew = async () => { throw new Error("lease lost"); };
    await assert.rejects(f.service.saveDraft(request, actor), /lease lost/);
    assert.equal(await f.records.read("draft"), null);
    const provider = await fixture();
    const providerPair = await stagePair(provider.service);
    provider.fail("getWithMetadata", new Error("blob provider failed"));
    await assert.rejects(provider.service.saveDraft({ ...request,
        documentHash: providerPair.document.hash,
        pdfHash: providerPair.pdf.hash }, actor), /blob provider failed/);
    provider.fail(null);
    assert.equal(await provider.records.read("draft"), null);
});
