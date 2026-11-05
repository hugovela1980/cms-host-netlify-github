import assert from "node:assert/strict";
import test from "node:test";

import { createCmsHostPolicyBundle, createCmsLegalCapability,
    createCmsLegalService, createCmsOptionalLegalPreviewHandlers } from
    "../src/server/index.js";
import { syntheticDocx, syntheticLegalConfig, syntheticPdf } from "./fixtures/legal.js";

const actor = { id: "editor@example.test", email: "editor@example.test" };
const url = "https://example.test/api/cms/legal-preview";

async function fixture(renderHtml = (document, page) =>
    `<main>${page}:${document.sourceTitle}:${document.blocks.length}</main>`,
{ previewCompatibility } = {}) {
    const entries = new Map();
    let sequence = 0;
    const store = {
        async getWithMetadata(key) { return structuredClone(entries.get(key) ?? null); },
        async get(key) { return structuredClone(entries.get(key)?.data ?? null); },
        async set(key, data, options) { return this.write(key, data, options); },
        async setJSON(key, data, options) { return this.write(key, data, options); },
        async write(key, data, options = {}) {
            const current = entries.get(key);
            if (options.onlyIfNew && current) return { modified: false };
            const etag = `etag-${++sequence}`;
            entries.set(key, { data: structuredClone(data), etag,
                metadata: structuredClone(options.metadata ?? {}) });
            return { modified: true, etag };
        },
    };
    const capability = await createCmsLegalCapability(syntheticLegalConfig());
    const legalService = createCmsLegalService({ capability, store,
        records: { read() {}, writeIfVersion() {} },
        leases: { async acquire() { return { owner: "fixture" }; },
            async renew(lease) { return lease; }, async release() { return true; } },
        now: () => new Date("2026-11-04T12:00:00.000Z") });
    const handlers = createCmsOptionalLegalPreviewHandlers({
        bundle: capability.assetBundle, legalService, renderHtml,
        previewCompatibility });
    const request = (page, kind, hash, method = "GET") => new Request(
        `${url}?page=${page}&kind=${kind}&hash=${hash}`, { method });
    return { entries, store, capability, legalService, handlers, request };
}

async function assertError(response, status, code, message) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.deepEqual(await response.json(), { code, message });
}

test("no-legal host exposes no preview and legal host requires its exact capability", async () => {
    const noLegal = createCmsHostPolicyBundle({ contentPolicy: {
        classifyPublic(raw) { return { kind: "current", content: raw }; },
        normalizePersisted(raw) { return raw; },
        validateCurrent(raw) { return raw; },
        historicalManagedAssetReferences() { return new Set(); },
    }, managedImages: [] });
    assert.deepEqual(Object.keys(createCmsOptionalLegalPreviewHandlers({ bundle: noLegal })), []);
    const f = await fixture();
    assert.throws(() => createCmsOptionalLegalPreviewHandlers({ bundle: noLegal,
        legalService: f.legalService }), TypeError);
    assert.throws(() => createCmsOptionalLegalPreviewHandlers({
        bundle: f.capability.assetBundle, legalService: f.legalService }), TypeError);
    assert.throws(() => createCmsOptionalLegalPreviewHandlers({ bundle: noLegal,
        previewCompatibility: "legacy" }), TypeError);
    assert.throws(() => createCmsOptionalLegalPreviewHandlers({
        bundle: f.capability.assetBundle, legalService: f.legalService,
        renderHtml: () => "<main>ok</main>", previewCompatibility: "unknown" }), TypeError);
});

test("approved original and staged PDFs return exact bytes and security headers", async () => {
    const f = await fixture(() => assert.fail("PDF must not render HTML"));
    const original = f.legalService.initialPairs().privacy.pdf;
    const first = await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "pdf", original.hash) });
    assert.equal(first.status, 200);
    assert.deepEqual(Object.fromEntries(first.headers), {
        "cache-control": "private, no-store",
        "content-disposition": "inline",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff",
    });
    assert.deepEqual(Buffer.from(await first.arrayBuffer()),
        f.capability.originalBytes("privacy", "pdf"));
    const pdf = syntheticPdf("Privacy Policy Changed wording.");
    const staged = await f.legalService.stage({ page: "privacy", kind: "pdf",
        file: new File([pdf], "changed.pdf") }, actor);
    const second = await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "pdf", staged.hash) });
    assert.equal(second.status, 200);
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), pdf);
    assert.deepEqual(Object.fromEntries(second.headers), Object.fromEntries(first.headers));
});

test("original and staged DOCX, Markdown and text reach only the host renderer", async () => {
    const seen = [];
    const f = await fixture((document, page) => {
        seen.push({ document, page });
        return `<main>${page}:${document.sourceTitle}:${document.blocks.length}</main>`;
    });
    const original = f.legalService.initialPairs().privacy.document;
    const files = [
        { hash: original.hash, expected: original },
        { file: new File([syntheticDocx("Privacy Policy", "New wording.")], "new.docx") },
        { file: new File(["# Updated title\n\nA paragraph."], "new.md") },
        { file: new File(["Plain text."], "new.txt") },
    ];
    for (const item of files) {
        const hash = item.hash ?? (await f.legalService.stage({ page: "privacy",
            kind: "document", file: item.file }, actor)).hash;
        const response = await f.handlers.legalPreview({ actor,
            request: f.request("privacy", "document", hash) });
        assert.equal(response.status, 200);
        assert.deepEqual(Object.fromEntries(response.headers), {
            "cache-control": "private, no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "content-type": "text/html; charset=utf-8",
            "x-content-type-options": "nosniff",
        });
        const passed = seen.at(-1);
        assert.equal(passed.page, "privacy");
        assert.deepEqual(passed.document, await f.legalService.entry("privacy", "document", hash));
        assert.equal(await response.text(),
            `<main>privacy:${passed.document.sourceTitle}:${passed.document.blocks.length}</main>`);
    }
});

test("method, actor, reference, provider and renderer failures preserve masked errors", async () => {
    const f = await fixture();
    const hash = f.legalService.initialPairs().privacy.document.hash;
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "document", hash, "POST") }), 405,
    "METHOD_NOT_ALLOWED", "Use GET for this endpoint.");
    await assertError(await f.handlers.legalPreview({
        request: f.request("privacy", "document", hash) }), 500,
    "CMS_SERVICE_ERROR", "The CMS service could not complete the request.");
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("unknown", "document", hash) }), 403,
    "LEGAL_PAGE_NOT_ALLOWED", "Unknown legal page.");
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "bad-kind", hash) }), 422,
    "INVALID_LEGAL_REFERENCE", "Invalid legal file reference.");
    await assertError(await f.handlers.legalPreview({ actor,
        request: new Request(`${url}?page=privacy&hash=${hash}`) }), 422,
    "INVALID_LEGAL_REFERENCE", "Invalid legal file reference.");
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "pdf", "bad-hash") }), 422,
    "INVALID_LEGAL_REFERENCE", "Invalid legal file reference.");
    const staged = await f.legalService.stage({ page: "privacy", kind: "document",
        file: new File(["# Staged"], "staged.md") }, actor);
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "bad-kind", staged.hash) }), 422,
    "INVALID_LEGAL_REFERENCE", "Invalid legal file reference.");
    const key = f.capability.stagedKey("privacy", "document", staged.hash);
    const sidecar = f.entries.get(`${key}/metadata`);
    f.entries.delete(`${key}/metadata`);
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "document", staged.hash) }), 404,
    "LEGAL_FILE_NOT_FOUND", "The staged legal file was not found.");
    f.entries.set(`${key}/metadata`, sidecar);
    f.entries.get(key).data = new TextEncoder().encode("changed").buffer;
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "document", staged.hash) }), 404,
    "LEGAL_FILE_NOT_FOUND", "The staged legal file was not found.");
    f.store.getWithMetadata = async () => { throw new Error("private provider detail"); };
    await assertError(await f.handlers.legalPreview({ actor,
        request: f.request("privacy", "document", staged.hash) }), 500,
    "CMS_SERVICE_ERROR", "The CMS service could not complete the request.");
    const broken = await fixture(() => { throw new Error("private renderer detail"); });
    await assertError(await broken.handlers.legalPreview({ actor,
        request: broken.request("privacy", "document",
            broken.legalService.initialPairs().privacy.document.hash) }), 500,
    "CMS_SERVICE_ERROR", "The CMS service could not complete the request.");
    const malformed = await fixture(() => ({ unsafe: "result" }));
    await assertError(await malformed.handlers.legalPreview({ actor,
        request: malformed.request("privacy", "document",
            malformed.legalService.initialPairs().privacy.document.hash) }), 500,
    "CMS_SERVICE_ERROR", "The CMS service could not complete the request.");
});

test("preview-only legacy option preserves route errors and matching-hash staged bytes", async () => {
    const legacy = await fixture(undefined, { previewCompatibility: "legacy" });
    const strict = await fixture();
    const originalHash = legacy.legalService.initialPairs().privacy.document.hash;
    const originalWithUnknownKind = await legacy.handlers.legalPreview({ actor,
        request: legacy.request("privacy", "bad-kind", originalHash) });
    assert.equal(originalWithUnknownKind.status, 200);
    assert.equal(await originalWithUnknownKind.text(), "<main>privacy:Privacy Policy:1</main>");
    const originalWithoutKind = await legacy.handlers.legalPreview({ actor,
        request: new Request(`${url}?page=privacy&hash=${originalHash}`) });
    assert.equal(originalWithoutKind.status, 200);
    for (const kind of ["document", "pdf"]) {
        await assertError(await legacy.handlers.legalPreview({ actor,
            request: legacy.request("unknown", kind, originalHash) }), 422,
        "INVALID_LEGAL_REFERENCE", "Invalid legal file reference.");
    }
    const pdfBytes = syntheticPdf("Privacy Policy Changed wording.");
    const legacyPdf = await legacy.legalService.stage({ page: "privacy", kind: "pdf",
        file: new File([pdfBytes], "changed.pdf") }, actor);
    const strictPdf = await strict.legalService.stage({ page: "privacy", kind: "pdf",
        file: new File([pdfBytes], "changed.pdf") }, actor);
    const legacyPdfKey = legacy.capability.stagedKey("privacy", "pdf", legacyPdf.hash);
    const strictPdfKey = strict.capability.stagedKey("privacy", "pdf", strictPdf.hash);
    for (const [f, key] of [[legacy, legacyPdfKey], [strict, strictPdfKey]]) {
        f.entries.get(key).etag = "";
        f.entries.get(key).metadata = {};
    }
    const accepted = await legacy.handlers.legalPreview({ actor,
        request: legacy.request("privacy", "pdf", legacyPdf.hash) });
    assert.equal(accepted.status, 200);
    assert.deepEqual(Object.fromEntries(accepted.headers), {
        "cache-control": "private, no-store",
        "content-disposition": "inline",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff",
    });
    assert.deepEqual(Buffer.from(await accepted.arrayBuffer()), pdfBytes);
    await assert.rejects(legacy.legalService.readFile("privacy", "pdf", legacyPdf.hash),
        { code: "LEGAL_FILE_NOT_FOUND", status: 404 });
    await assertError(await strict.handlers.legalPreview({ actor,
        request: strict.request("privacy", "pdf", strictPdf.hash) }), 404,
    "LEGAL_FILE_NOT_FOUND", "The staged legal file was not found.");
    legacy.entries.delete(legacyPdfKey);
    await assertError(await legacy.handlers.legalPreview({ actor,
        request: legacy.request("privacy", "pdf", legacyPdf.hash) }), 404,
    "LEGAL_FILE_NOT_FOUND", "The staged legal file is unavailable or changed.");

    const docBytes = syntheticDocx("Privacy Policy", "Legacy wording.");
    const doc = await legacy.legalService.stage({ page: "privacy", kind: "document",
        file: new File([docBytes], "legacy.docx") }, actor);
    const docKey = legacy.capability.stagedKey("privacy", "document", doc.hash);
    legacy.entries.get(docKey).etag = "";
    legacy.entries.get(docKey).metadata = {};
    legacy.entries.get(`${docKey}/metadata`).etag = "";
    const document = await legacy.handlers.legalPreview({ actor,
        request: legacy.request("privacy", "document", doc.hash) });
    assert.equal(document.status, 200);
    assert.deepEqual(Object.fromEntries(document.headers), {
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
    });
    assert.equal(await document.text(), "<main>privacy:Privacy Policy:1</main>");
    await assert.rejects(legacy.legalService.entry("privacy", "document", doc.hash),
        { code: "LEGAL_FILE_NOT_FOUND", status: 404 });
    legacy.entries.delete(`${docKey}/metadata`);
    await assertError(await legacy.handlers.legalPreview({ actor,
        request: legacy.request("privacy", "document", doc.hash) }), 404,
    "LEGAL_FILE_NOT_FOUND", "The staged legal file was not found.");
    const broken = await legacy.legalService.stage({ page: "privacy", kind: "document",
        file: new File(["# Another"], "another.md") }, actor);
    const brokenKey = legacy.capability.stagedKey("privacy", "document", broken.hash);
    legacy.entries.get(brokenKey).data = new TextEncoder().encode("changed").buffer;
    await assertError(await legacy.handlers.legalPreview({ actor,
        request: legacy.request("privacy", "document", broken.hash) }), 404,
    "LEGAL_FILE_NOT_FOUND", "The staged legal file is unavailable or changed.");
});
