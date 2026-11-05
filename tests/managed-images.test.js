import assert from "node:assert/strict";
import test from "node:test";

import { createCmsHistoricalImageRecovery, createCmsHostPolicyBundle,
    createCmsManagedImageService, stagedCmsImageKey } from "../src/server/index.js";

const NOW = "2026-11-04T12:00:00.000Z";
const SHA = "a".repeat(40);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const fields = [
    { sectionPath: "home.hero", schemaId: "home-hero", fieldKey: "image.src",
        destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/" },
    { sectionPath: "about.hero", schemaId: "about-hero", fieldKey: "image.src",
        destinationDirectory: "public/images/about", publicPathPrefix: "/images/about/" },
];
const policy = {
    classifyPublic(raw) { return { kind: "current", content: raw }; },
    normalizePersisted(raw) { return raw; },
    validateCurrent(raw) { return raw; },
    historicalManagedAssetReferences(content) {
        return new Set(content?.retiredImage ? [content.retiredImage] : []);
    },
};

class Store {
    entries = new Map();
    seq = 0;
    writes = [];
    async set(key, data, options = {}) {
        this.writes.push({ key, data, options });
        if (options.onlyIfNew && this.entries.has(key)) return { modified: false };
        const etag = `etag-${++this.seq}`;
        this.entries.set(key, { data: data.slice(0), metadata: options.metadata, etag });
        return { modified: true, etag };
    }
    async getWithMetadata(key, options) {
        assert.deepEqual(options, { type: "arrayBuffer", consistency: "strong" });
        return this.entries.get(key) ?? null;
    }
    async getMetadata(key, options) {
        assert.deepEqual(options, { consistency: "strong" });
        const entry = this.entries.get(key);
        return entry ? { etag: entry.etag, metadata: entry.metadata } : null;
    }
    async delete(key) { this.entries.delete(key); }
}

function setup() {
    const store = new Store();
    const assets = createCmsHostPolicyBundle({ contentPolicy: policy,
        managedImages: fields }).assets;
    const leases = {
        acquired: 0, renewals: 0,
        async acquire() { this.acquired += 1; return { owner: "test" }; },
        async renew(lease) { this.renewals += 1; return lease; },
        async release() { return true; },
    };
    const service = createCmsManagedImageService({ store, assets, leases,
        previewUrlForPath: (path) => `/api/cms/draft-image?path=${encodeURIComponent(path)}`,
        now: () => new Date(NOW),
        createId: () => "12345678-1234-1234-1234-123456789abc" });
    const reads = [];
    const github = { async readFileAtCommit(path, commit) {
        reads.push({ path, commit });
        return Buffer.from(png);
    } };
    const recovery = createCmsHistoricalImageRecovery({ store, github, assets });
    return { store, assets, leases, service, recovery, reads, github };
}

function upload(file = new File([png], "hero.png", { type: "image/png" })) {
    return { sectionPath: "home.hero", schemaId: "home-hero",
        fieldKey: "image.src", file };
}

test("registered upload validates bytes and stages one exact create-only record under a lease", async () => {
    const f = setup();
    const result = await f.service.stage(upload(), { email: "editor@example.test" });
    assert.match(result.src, /^\/images\/home\/cms-[a-z0-9]+-1234567812341234\.png$/);
    assert.equal(result.previewUrl, `/api/cms/draft-image?path=${encodeURIComponent(result.src)}`);
    assert.equal(f.leases.acquired, 1);
    assert.ok(f.leases.renewals >= 2);
    assert.equal(f.store.writes.length, 1);
    assert.equal(f.store.writes[0].key, stagedCmsImageKey(result.src));
    assert.equal(f.store.writes[0].options.onlyIfNew, true);
    assert.deepEqual(f.store.writes[0].options.metadata, {
        contentType: "image/png", publicPath: result.src,
        uploadedAt: NOW, uploadedBy: "editor@example.test",
    });
    assert.deepEqual(new Uint8Array((await f.service.readStaged(result.src)).data), png);
});

test("wrong field, filename, MIME, size, and signature stop before a lease or write", async () => {
    const f = setup();
    const cases = [
        [{ ...upload(), schemaId: "wrong" }, "IMAGE_FIELD_NOT_ALLOWED"],
        [upload(new File([png], "../bad.png", { type: "image/png" })), "INVALID_IMAGE_FILENAME"],
        [upload(new File([png], "hero.gif", { type: "image/gif" })), "INVALID_IMAGE_TYPE"],
        [upload(new File([], "empty.png", { type: "image/png" })), "INVALID_IMAGE_SIZE"],
        [upload(new File([new Uint8Array(4 * 1024 * 1024 + 1)], "large.png",
            { type: "image/png" })), "INVALID_IMAGE_SIZE"],
        [upload(new File([Uint8Array.from([1, 2, 3])], "fake.png",
            { type: "image/png" })), "IMAGE_SIGNATURE_MISMATCH"],
    ];
    for (const [request, code] of cases) {
        await assert.rejects(f.service.stage(request, { email: "editor@example.test" }),
            { code });
    }
    assert.equal(f.leases.acquired, 0);
    assert.equal(f.store.writes.length, 0);
});

test("create-only collision and lost lease never overwrite staged bytes", async () => {
    const f = setup();
    const first = await f.service.stage(upload(), { email: "editor@example.test" });
    const before = f.store.entries.get(stagedCmsImageKey(first.src));
    await assert.rejects(f.service.stage(upload(), { email: "editor@example.test" }),
        { code: "IMAGE_COLLISION", status: 409 });
    assert.strictEqual(f.store.entries.get(stagedCmsImageKey(first.src)), before);
    await assert.rejects(f.service.stage({ ...upload(), sectionPath: "about.hero",
        schemaId: "about-hero" }, { email: "editor@example.test" }),
    { code: "IMAGE_COLLISION" });
    await assert.rejects(f.service.preview(first.src.replace("/images/home/", "/images/about/")),
        { code: "INVALID_STAGED_IMAGE" });
    f.leases.renew = async () => {
        throw Object.assign(new Error("lost"), { code: "CMS_STATE_LOCKED", status: 423 });
    };
    const writesBefore = f.store.writes.length;
    await assert.rejects(f.service.stage(upload(), { email: "editor@example.test" }),
        { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(f.store.writes.length, writesBefore);
});

test("recovery create-only race accepts only a matching path and returns no rollback", async () => {
    const f = setup();
    const publicPath = "/images/home/cms-race.png";
    const snapshot = { content: { home: { hero: { image: { src: publicPath } } } },
        commit: SHA };
    const originalSet = f.store.set.bind(f.store);
    f.store.set = async (key, data, options) => {
        await originalSet(key, data, { metadata: { contentType: "image/png", publicPath } });
        return { modified: false };
    };
    assert.equal(await f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => {} }), undefined);
    assert.equal(f.store.entries.has(stagedCmsImageKey(publicPath)), true);
});

test("preview serves staged bytes first and redirects only on normal absence", async () => {
    const f = setup();
    const path = "/images/home/cms-existing.png";
    const missing = await f.service.preview(path);
    assert.equal(missing.status, 307);
    assert.equal(missing.headers.get("Location"), path);
    assert.equal(missing.headers.get("Cache-Control"), "private, no-store");
    await f.store.set(stagedCmsImageKey(path), png.buffer, {
        metadata: { contentType: "image/png", publicPath: path },
    });
    const staged = await f.service.preview(path);
    assert.equal(staged.status, 200);
    assert.equal(staged.headers.get("Location"), null);
    assert.equal(staged.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(staged.headers.get("Content-Length"), String(png.length));
    assert.deepEqual(new Uint8Array(await staged.arrayBuffer()), png);
});

test("same-basename cross-directory data, invalid metadata, and provider failure never fall back", async () => {
    const f = setup();
    const aboutPath = "/images/about/cms-shared.png";
    const homePath = "/images/home/cms-shared.png";
    await f.store.set(stagedCmsImageKey(homePath), png.buffer, {
        metadata: { contentType: "image/png", publicPath: homePath },
    });
    await assert.rejects(f.service.preview(aboutPath),
        { code: "INVALID_STAGED_IMAGE", status: 500 });
    f.store.entries.get(stagedCmsImageKey(homePath)).metadata = { contentType: "text/plain",
        publicPath: homePath };
    await assert.rejects(f.service.preview(homePath), { code: "INVALID_STAGED_IMAGE" });
    f.store.entries.get(stagedCmsImageKey(homePath)).metadata = { contentType: "image/png" };
    await assert.rejects(f.service.preview(homePath), { code: "INVALID_STAGED_IMAGE" });
    f.store.getWithMetadata = async () => { throw new Error("provider down"); };
    await assert.rejects(f.service.preview(homePath), /provider down/);
    const misleadingMiss = Object.assign(new Error("provider down"), { code: "IMAGE_NOT_FOUND" });
    f.store.getWithMetadata = async () => { throw misleadingMiss; };
    await assert.rejects(f.service.preview(homePath), (error) => error === misleadingMiss);
});

test("developer-owned and wrong-prefix paths reject before staged read", async () => {
    const f = setup();
    f.store.getWithMetadata = async () => assert.fail("No staged read");
    for (const path of ["/images/home/developer-owned.png",
        "/images/other/cms-test.png", "/images/home/../cms-test.png"]) {
        await assert.rejects(f.service.preview(path), { code: "INVALID_IMAGE_PATH" });
    }
});

test("trusted retired snapshot permits exact-commit recovery and ETag-guarded rollback", async () => {
    const f = setup();
    const publicPath = "/images/legacy/cms-retired.png";
    const snapshot = { content: { retiredImage: publicPath }, commit: SHA,
        assets: [publicPath] };
    const checks = [];
    const undo = await f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => checks.push("active") });
    assert.deepEqual(f.reads, [{ path: `public${publicPath}`, commit: SHA }]);
    assert.deepEqual(checks, ["active"]);
    const entry = f.store.entries.get(stagedCmsImageKey(publicPath));
    assert.equal(entry.metadata.restoredFrom, SHA);
    assert.equal(entry.metadata.publicPath, publicPath);
    assert.deepEqual(new Uint8Array(entry.data), png);
    const preview = await f.service.preview(publicPath,
        { contentSnapshot: snapshot.content });
    assert.equal(preview.status, 200);
    await undo();
    assert.equal(f.store.entries.has(stagedCmsImageKey(publicPath)), false);
    assert.deepEqual(checks, ["active", "active", "active"]);
});

test("recovery rejects unowned paths, recorded-only assets, and non-SHA commits before Git", async () => {
    const f = setup();
    const owned = "/images/home/cms-owned.png";
    const snapshot = { content: { home: { hero: { image: { src: owned } } } },
        commit: SHA, assets: [owned] };
    for (const [path, record] of [
        ["/images/home/developer-owned.png", snapshot],
        ["/images/about/cms-owned.png", snapshot],
        [owned, { ...snapshot, assets: ["/images/home/cms-recorded-only.png"] }],
        [owned, { ...snapshot, commit: "main" }],
    ]) {
        await assert.rejects(f.recovery.recover({ publicPath: path, snapshot: record,
            ensureActive: async () => {} }), { code: "REVISION_ASSET_UNAVAILABLE" });
    }
    assert.deepEqual(f.reads, []);
});

test("recovery collision validates exact metadata and preserves existing bytes", async () => {
    const f = setup();
    const publicPath = "/images/home/cms-shared.png";
    const otherPath = "/images/about/cms-shared.png";
    const snapshot = { content: { home: { hero: { image: { src: publicPath } } } },
        commit: SHA };
    await f.store.set(stagedCmsImageKey(otherPath), png.buffer, {
        metadata: { contentType: "image/png", publicPath: otherPath },
    });
    const before = f.store.entries.get(stagedCmsImageKey(otherPath));
    await assert.rejects(f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => {} }), { code: "INVALID_STAGED_IMAGE" });
    assert.strictEqual(f.store.entries.get(stagedCmsImageKey(otherPath)), before);
    assert.deepEqual(f.reads, []);
    before.metadata.publicPath = publicPath;
    assert.equal(await f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => {} }), undefined);
    assert.strictEqual(f.store.entries.get(stagedCmsImageKey(otherPath)), before);
});

test("recovery provider failure, lost lease, and changed ETag stop without deleting other bytes", async () => {
    const f = setup();
    const publicPath = "/images/home/cms-recover.png";
    const snapshot = { content: { home: { hero: { image: { src: publicPath } } } },
        commit: SHA };
    f.github.readFileAtCommit = async () => { throw new Error("Git unavailable"); };
    await assert.rejects(f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => {} }), { code: "REVISION_ASSET_UNAVAILABLE", status: 502 });
    assert.equal(f.store.writes.length, 0);
    f.github.readFileAtCommit = async () => Buffer.from(png);
    await assert.rejects(f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => { throw new Error("lease lost"); } }), /lease lost/);
    assert.equal(f.store.writes.length, 0);
    const undo = await f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => {} });
    await f.store.set(stagedCmsImageKey(publicPath), png.buffer, {
        metadata: { contentType: "image/png", publicPath },
    });
    await assert.rejects(undo(), { code: "CMS_STATE_CONFLICT", status: 409 });
    assert.equal(f.store.entries.has(stagedCmsImageKey(publicPath)), true);
});

test("malformed recovery metadata lookup is never treated as a normal miss", async () => {
    const f = setup();
    const publicPath = "/images/home/cms-metadata.png";
    const snapshot = { content: { home: { hero: { image: { src: publicPath } } } },
        commit: SHA };
    for (const malformed of [undefined, false, {}, { metadata: {} },
        { etag: "etag", metadata: null }]) {
        f.store.getMetadata = async () => malformed;
        await assert.rejects(f.recovery.recover({ publicPath, snapshot,
            ensureActive: async () => {} }),
        { code: "INVALID_STAGED_IMAGE", status: 500 });
    }
    assert.equal(f.store.writes.length, 0);
    assert.deepEqual(f.reads, []);
});

test("rollback stops on changed public path or lost lease before deletion", async () => {
    const f = setup();
    const publicPath = "/images/home/cms-rollback.png";
    const snapshot = { content: { home: { hero: { image: { src: publicPath } } } },
        commit: SHA };
    let checks = 0;
    const ensureActive = async () => {
        checks += 1;
        if (checks === 2) {
            throw Object.assign(new Error("lease lost"), { code: "CMS_STATE_LOCKED" });
        }
    };
    const undo = await f.recovery.recover({ publicPath, snapshot, ensureActive });
    const key = stagedCmsImageKey(publicPath);
    await assert.rejects(undo(), { code: "CMS_STATE_LOCKED" });
    assert.equal(f.store.entries.has(key), true);
    const stableUndo = await f.recovery.recover({ publicPath, snapshot,
        ensureActive: async () => {} });
    assert.equal(stableUndo, undefined);
    f.store.entries.get(key).metadata.publicPath = "/images/about/cms-rollback.png";
    await assert.rejects(undo(), { code: "INVALID_STAGED_IMAGE" });
    assert.equal(f.store.entries.has(key), true);
});
