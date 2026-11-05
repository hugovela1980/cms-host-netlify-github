import assert from "node:assert/strict";
import test from "node:test";

import { CmsApiError, createCmsCoreJsonHandlers } from "../src/server/index.js";

const actor = Object.freeze({ id: "editor@example.test", email: "editor@example.test" });
const content = { home: { heading: "Example" } };
const url = "https://example.test/api/cms/route";

function request(method = "GET", body, query = "") {
    return new Request(url + query, { method,
        ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body ?? {}) } : {}) });
}

function fixture({ legalEnabled = false, stored = {}, legalResult = false } = {}) {
    const calls = [];
    const publication = { id: "publication-1", status: "deploying",
        startedBy: actor.email, commitSha: "a".repeat(40) };
    const result = { draft: content, draftVersion: "etag-2", hasSavedDraft: true,
        metadata: { updatedBy: actor.email } };
    const handlers = createCmsCoreJsonHandlers({ bundle: { legalAssetsEnabled: legalEnabled },
        records: { async read(name) { calls.push(`read:${name}`); return stored[name] ?? null; } },
        async canonicalContent() { calls.push("canonical"); return content; },
        foundation: { async ensure(input) { calls.push("foundation");
            assert.deepEqual(input, { canonicalContent: content }); } },
        draftState: { async read(input) { calls.push("draft");
            assert.deepEqual(input, { confirmedFallbackContent: content });
            return { ...result, published: content, publicationStatus: null,
                ...(legalResult ? { legal: { terms: {} } } : {}) }; } },
        draftSave: { async save(input) { calls.push("save");
            assert.equal(input.actor, actor);
            assert.equal(input.confirmedFallbackContent, content);
            return result; } },
        draftRevert: { async revert(input) { calls.push("revert");
            assert.equal(input.actor, actor);
            return { ...result, hasSavedDraft: false }; } },
        publication: {
            async start(input) { calls.push("publish");
                assert.deepEqual(input, { expectedDraftVersion: "etag-1", actor });
                return publication; },
            async refresh() { calls.push("refresh"); return publication; },
        },
        revisions: {
            async list(input) { calls.push("list"); return { ...input, revisions: [] }; },
            async view(id) { calls.push("view"); return { revision: { id }, draftVersion: "etag-2" }; },
            async restore(input) { calls.push("restore");
                assert.deepEqual(input, { id: "rev-1", expectedDraftVersion: "etag-1", actor });
                return result; },
        },
    });
    return { handlers, calls, result, publication };
}

async function response(response, status, body) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("ETag"), null);
    assert.deepEqual(await response.json(), body);
}

test("eight named handlers keep response shapes, status, actor, query and setup order", async () => {
    const { handlers, calls, result, publication } = fixture();
    assert.deepEqual(Object.keys(handlers), ["draft", "saveDraft", "revertDraft",
        "publish", "publication", "revisions", "revision", "restoreRevision"]);
    await response(await handlers.draft({ request: request(), actor }), 200,
        { ...result, published: content, publicationStatus: null });
    await response(await handlers.saveDraft({ request: request("POST", {
        changes: [], actor: { email: "forged@example.test" } }), actor }), 200, result);
    await response(await handlers.revertDraft({ request: request("POST", {}), actor }),
    200, { ...result, hasSavedDraft: false });
    await response(await handlers.publish({ request: request("POST", {
        expectedDraftVersion: "etag-1" }), actor }), 202,
    { publication: { id: publication.id, status: "deploying", startedAt: null,
        updatedAt: null, startedBy: actor.email, title: null,
        commitSha: publication.commitSha, confirmedAt: null,
        errorCode: null, deploy: null } });
    await response(await handlers.publication({ request: request(), actor }), 200,
    { publication: { id: publication.id, status: "deploying", startedAt: null,
        updatedAt: null, startedBy: actor.email, title: null,
        commitSha: publication.commitSha, confirmedAt: null,
        errorCode: null, deploy: null } });
    await response(await handlers.revisions({ request: request("GET", null,
        "?page=2&head=head-1&highlightedRevision=rev-1"), actor }), 200,
    { page: "2", head: "head-1", highlightedRevision: "rev-1", revisions: [] });
    await response(await handlers.revision({ request: request("GET", null,
        "?id=rev-1"), actor }), 200, { revision: { id: "rev-1" }, draftVersion: "etag-2" });
    await response(await handlers.restoreRevision({ request: request("POST", {
        id: "rev-1", expectedDraftVersion: "etag-1" }), actor }), 200, result);
    assert.equal(calls.filter((call) => call === "foundation").length, 7);
    assert.equal(calls.filter((call) => call === "refresh").length, 1);
    assert.equal(calls[calls.indexOf("refresh") - 1], "read:revisions");
});

test("method and JSON failures happen before configuration and provider work", async () => {
    const { handlers, calls } = fixture();
    await response(await handlers.saveDraft({ request: request() }), 405,
        { code: "METHOD_NOT_ALLOWED", message: "Use POST for this endpoint." });
    await response(await handlers.saveDraft({ request: request("POST", "[]"), actor }), 400,
        { code: "INVALID_JSON", message: "The CMS request must contain a JSON object." });
    await response(await handlers.saveDraft({ request: request("POST", "x".repeat(256_001)), actor }), 413,
        { code: "REQUEST_TOO_LARGE", message: "The CMS request is too large." });
    assert.deepEqual(calls, []);
});

test("missing actor and incompatible no-legal state fail closed", async () => {
    const plain = fixture();
    await response(await plain.handlers.draft({ request: request() }), 500,
        { code: "CMS_SERVICE_ERROR", message: "The CMS service could not complete the request." });
    await response(await plain.handlers.publish({ request: request("POST", {}) }), 500,
        { code: "CMS_SERVICE_ERROR", message: "The CMS service could not complete the request." });
    assert.deepEqual(plain.calls, []);
    const withLegal = fixture({ stored: { revisions: { data: {
        entries: [{ id: "rev-1", legal: { terms: {} } }] } } } });
    await response(await withLegal.handlers.publication({ request: request(), actor }), 500,
        { code: "CMS_SERVICE_ERROR", message: "The CMS service could not complete the request." });
    assert.equal(withLegal.calls.includes("refresh"), false);
    await response(await withLegal.handlers.draft({ request: request(), actor }), 500,
        { code: "CMS_SERVICE_ERROR", message: "The CMS service could not complete the request." });
    assert.equal(withLegal.calls.includes("foundation"), false);
    const pendingLegal = fixture({ stored: { publication: { data: {
        draft: { legal: { terms: {} } } } } } });
    assert.equal((await pendingLegal.handlers.publication({ request: request(), actor })).status, 500);
    assert.equal(pendingLegal.calls.includes("refresh"), false);
    const enabled = fixture({ legalEnabled: true, stored: { draft: { data: { legal: {} } } } });
    assert.equal((await enabled.handlers.publication({ request: request(), actor })).status, 200);
    const mismatched = fixture({ legalResult: true });
    await response(await mismatched.handlers.draft({ request: request(), actor }), 500,
        { code: "CMS_SERVICE_ERROR", message: "The CMS service could not complete the request." });
});

test("service conflicts and unknown failures retain CMS error mapping", async () => {
    // The HTTP wrapper is shared with existing endpoints; verify a service error
    // through a configured handler instead of accepting a client-supplied code.
    const site = fixture();
    site.handlers = createCmsCoreJsonHandlers({
        records: { async read() { return null; } }, bundle: { legalAssetsEnabled: true },
        canonicalContent: () => content,
        foundation: { ensure: async () => {} },
        draftState: { read: async () => ({}) },
        draftSave: { save: async () => { throw new CmsApiError("DRAFT_CONFLICT",
            "The draft changed.", 409); } },
        draftRevert: { revert: async () => ({}) },
        publication: { start: async () => ({}), refresh: async () => ({}) },
        revisions: { list: async () => ({}), view: async () => ({}),
            restore: async () => ({}) },
    });
    await response(await site.handlers.saveDraft({ request: request("POST", {}), actor }),
        409, { code: "DRAFT_CONFLICT", message: "The draft changed." });
});
