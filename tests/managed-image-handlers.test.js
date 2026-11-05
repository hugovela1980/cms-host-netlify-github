import assert from "node:assert/strict";
import test from "node:test";

import { createCmsHostPolicyBundle, createCmsManagedImageHandlers,
    createCmsManagedImageService, stagedCmsImageKey } from "../src/server/index.js";

const actor = Object.freeze({ id: "editor@example.test", email: "editor@example.test" });
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const path = "/images/home/cms-existing.png";
const url = "https://example.test/api/cms/draft-image";

function formRequest({ schemaId = "home-hero", file = new File([png], "hero.png",
    { type: "image/png" }) } = {}) {
    const form = new FormData();
    form.set("sectionPath", "home.hero");
    form.set("schemaId", schemaId);
    form.set("fieldKey", "image.src");
    form.set("file", file);
    form.set("actor", "forged@example.test");
    return new Request(url, { method: "POST", body: form });
}

function fixture({ sweep = async () => ({ deleted: [] }), logger = { error() {} } } = {}) {
    const entries = new Map();
    const reads = [];
    const writes = [];
    const store = {
        async set(key, data, options) {
            writes.push({ key, options });
            entries.set(key, { data, metadata: options.metadata, etag: "etag-1" });
            return { modified: true, etag: "etag-1" };
        },
        async getWithMetadata(key, options) {
            reads.push({ key, options });
            return entries.get(key) ?? null;
        },
    };
    const assets = createCmsHostPolicyBundle({ contentPolicy: {
        classifyPublic(raw) { return { kind: "current", content: raw }; },
        normalizePersisted(raw) { return raw; },
        validateCurrent(raw) { return raw; },
        historicalManagedAssetReferences() { return new Set(); },
    }, managedImages: [{ sectionPath: "home.hero", schemaId: "home-hero",
        fieldKey: "image.src", destinationDirectory: "public/images/home",
        publicPathPrefix: "/images/home/" }] }).assets;
    const leases = { acquired: 0,
        async acquire() { this.acquired += 1; return { owner: "fixture" }; },
        async renew(lease) { return lease; },
        async release() { return true; },
    };
    const images = createCmsManagedImageService({ store, assets, leases,
        previewUrlForPath: (src) => `/api/cms/draft-image?path=${encodeURIComponent(src)}`,
        now: () => new Date("2026-11-04T12:00:00.000Z"),
        createId: () => "12345678-1234-1234-1234-123456789abc" });
    const handlers = createCmsManagedImageHandlers({ images, cleanup: { sweep }, logger });
    return { entries, reads, writes, leases, store, handlers };
}

async function json(response, status, body) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.deepEqual(await response.json(), body);
}

test("upload parses exact fields, stages once, and returns 201 before cleanup settles", async () => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const scheduled = [];
    const f = fixture({ sweep: () => pending });
    const response = await f.handlers.uploadImage({ request: formRequest(), actor,
        context: { waitUntil(promise) { scheduled.push(promise); } } });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.deepEqual(await response.json(), {
        src: "/images/home/cms-mw22e800-1234567812341234.png",
        previewUrl: "/api/cms/draft-image?path=%2Fimages%2Fhome%2Fcms-mw22e800-1234567812341234.png",
    });
    assert.equal(f.leases.acquired, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].options.metadata.uploadedBy, actor.email);
    assert.equal(scheduled.length, 1);
    finish();
    await scheduled[0];
});

test("method, actor and invalid upload stop before storage or cleanup", async () => {
    const f = fixture();
    await json(await f.handlers.uploadImage({ request: new Request(url), actor }), 405,
        { code: "METHOD_NOT_ALLOWED", message: "Use POST for this endpoint." });
    await json(await f.handlers.uploadImage({ request: formRequest() }), 500,
        { code: "CMS_SERVICE_ERROR", message: "The CMS service could not complete the request." });
    await json(await f.handlers.uploadImage({ request: formRequest({ schemaId: "wrong" }), actor }), 403,
        { code: "IMAGE_FIELD_NOT_ALLOWED",
            message: "This CMS field does not accept managed image uploads." });
    assert.equal(f.writes.length, 0);
    assert.equal(f.leases.acquired, 0);
});

test("draft image serves staged bytes, redirects normal miss, and fails closed", async () => {
    const f = fixture();
    const get = (imagePath = path) => f.handlers.draftImage({
        request: new Request(`${url}?path=${encodeURIComponent(imagePath)}`), actor });
    const missing = await get();
    assert.equal(missing.status, 307);
    assert.equal(missing.headers.get("Location"), path);
    assert.equal(missing.headers.get("Cache-Control"), "private, no-store");
    assert.equal(missing.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(missing.headers.get("Content-Type"), null);
    f.entries.set(stagedCmsImageKey(path), { data: png.buffer,
        metadata: { contentType: "image/png", publicPath: path } });
    const staged = await get();
    assert.equal(staged.status, 200);
    assert.equal(staged.headers.get("Content-Type"), "image/png");
    assert.equal(staged.headers.get("Content-Length"), String(png.byteLength));
    assert.equal(staged.headers.get("Cache-Control"), "private, no-store");
    assert.equal(staged.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(staged.headers.get("Location"), null);
    assert.deepEqual(new Uint8Array(await staged.arrayBuffer()), png);
    f.entries.get(stagedCmsImageKey(path)).metadata = { contentType: "text/plain", publicPath: path };
    await json(await get(), 500, { code: "INVALID_STAGED_IMAGE",
        message: "The staged image metadata is invalid." });
    await json(await get("/images/home/developer.png"), 400,
        { code: "INVALID_IMAGE_PATH", message: "The image path is not CMS-managed." });
    f.store.getWithMetadata = async () => { throw new Error("private provider detail"); };
    const failed = await get();
    await json(failed, 500, { code: "CMS_SERVICE_ERROR",
        message: "The CMS service could not complete the request." });
    assert.equal(failed.headers.get("Location"), null);
    assert.equal((await f.handlers.draftImage({ request: new Request(url, { method: "POST" }),
        actor })).status, 405);
    assert.equal((await f.handlers.draftImage({ request: new Request(url) })).status, 500);
});

test("cleanup failure and scheduling failure are logged without changing upload success", async () => {
    const logged = [];
    const f = fixture({ sweep: async () => { throw new Error("cleanup failed"); },
        logger: { error(...args) { logged.push(args); } } });
    const scheduled = [];
    const first = await f.handlers.uploadImage({ request: formRequest(), actor,
        context: { waitUntil(promise) { scheduled.push(promise); } } });
    assert.equal(first.status, 201);
    await scheduled[0];
    assert.equal(logged[0][0], "Unable to sweep abandoned CMS images.");
    const second = await f.handlers.uploadImage({ request: formRequest(), actor,
        context: { waitUntil() { throw new Error("schedule failed"); } } });
    assert.equal(second.status, 201);
    assert.equal(logged.at(-1)[0], "Unable to schedule abandoned CMS image cleanup.");
});
