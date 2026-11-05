import assert from "node:assert/strict";
import test from "node:test";

import {
    CmsApiError, cmsJsonResponse, cmsErrorResponse, createCmsEndpoint,
    readJsonRequest, requireMethod,
} from "../src/server/http.js";

test("HTTP helpers retain JSON headers and known/unknown error semantics", async () => {
    const response = cmsJsonResponse({ ok: true }, { status: 201, headers: { "X-Test": "yes" } });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("X-Test"), "yes");
    assert.deepEqual(await response.json(), { ok: true });

    const known = cmsErrorResponse(new CmsApiError("EXAMPLE_ERROR", "Example failed.", 409, { field: "title" }));
    assert.equal(known.status, 409);
    assert.deepEqual(await known.json(), { code: "EXAMPLE_ERROR", message: "Example failed.", details: { field: "title" } });
    const unknown = cmsErrorResponse(new Error("private detail"));
    assert.equal(unknown.status, 500);
    assert.deepEqual(await unknown.json(), { code: "CMS_SERVICE_ERROR", message: "The CMS service could not complete the request." });
});

test("method and JSON body validation preserve the existing response codes", async () => {
    assert.throws(() => requireMethod(new Request("https://example.test", { method: "GET" }), "POST"),
        { code: "METHOD_NOT_ALLOWED", status: 405 });
    assert.deepEqual(await readJsonRequest(new Request("https://example.test", { method: "POST", body: "" })), {});
    await assert.rejects(readJsonRequest(new Request("https://example.test", { method: "POST", body: "[]" })),
        { code: "INVALID_JSON", status: 400 });
    await assert.rejects(readJsonRequest(new Request("https://example.test", { method: "POST", body: "é" }), { maxBytes: 1 }),
        { code: "REQUEST_TOO_LARGE", status: 413 });
});

test("endpoint wrapper converts thrown errors to CMS responses", async () => {
    const endpoint = createCmsEndpoint(async ({ allowed }) => {
        if (!allowed) throw new CmsApiError("BLOCKED", "Blocked.", 403);
        return cmsJsonResponse({ ok: true });
    });
    assert.equal((await endpoint({ allowed: false })).status, 403);
    assert.deepEqual(await (await endpoint({ allowed: true })).json(), { ok: true });
});
