import assert from "node:assert/strict";
import test from "node:test";

import { createCmsHostPolicyBundle, createCmsManagedImageCleanup,
    STAGED_IMAGE_MIN_AGE_MS, stagedCmsImageKey } from "../src/server/index.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - STAGED_IMAGE_MIN_AGE_MS).toISOString();
const YOUNG = new Date(NOW.getTime() - STAGED_IMAGE_MIN_AGE_MS + 1).toISOString();
const home = (name) => `/images/home/cms-${name}.png`;
const about = (name) => `/images/about/cms-${name}.png`;
const content = (path) => ({ home: { hero: { image: { src: path } } } });
const policy = {
    classifyPublic(raw) { return { kind: "current", content: raw }; },
    normalizePersisted(raw) { return raw; },
    validateCurrent(raw) { return raw; },
    historicalManagedAssetReferences(raw) {
        return new Set(raw?.retired ? [raw.retired] : []);
    },
};
const fields = [
    { sectionPath: "home.hero", schemaId: "hero", fieldKey: "image.src",
        destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/" },
    { sectionPath: "about.hero", schemaId: "about", fieldKey: "image.src",
        destinationDirectory: "public/images/about", publicPathPrefix: "/images/about/" },
];

function setup() {
    const assets = createCmsHostPolicyBundle({ contentPolicy: policy,
        managedImages: fields }).assets;
    const states = new Map([
        ["baseline", { content: content(home("baseline")) }],
        ["confirmedLive", { content: content(home("live")) }],
        ["revisions", { entries: [] }],
    ]);
    const records = { async read(name) {
        return states.has(name) ? { data: states.get(name), etag: `${name}-etag` } : null;
    } };
    const staged = new Map();
    const deleted = [];
    let sequence = 0;
    const store = {
        async getMetadata(key, options) {
            assert.deepEqual(options, { consistency: "strong" });
            return staged.get(key) ?? null;
        },
        async delete(key) { deleted.push(key); staged.delete(key); },
        async *list(options) {
            assert.deepEqual(options, { prefix: "images/staged/", paginate: true });
            const blobs = [...staged].map(([key, item]) => ({ key, etag: item.etag }));
            for (let index = 0; index < blobs.length; index += 13) {
                yield { blobs: blobs.slice(index, index + 13) };
            }
        },
    };
    function add(path, metadata = {}) {
        const key = stagedCmsImageKey(path);
        staged.set(key, { etag: `etag-${++sequence}`, metadata: {
            publicPath: path, contentType: "image/png", uploadedAt: OLD,
            uploadedBy: "editor@example.test", ...metadata,
        } });
        return key;
    }
    const leases = {
        acquired: [], renewals: 0,
        async acquire(request) { this.acquired.push(request); return { owner: "cleanup" }; },
        async renew(lease) { this.renewals += 1; return lease; },
        async release() { return true; },
    };
    const cleanup = createCmsManagedImageCleanup({ store, records, assets, leases,
        now: () => NOW });
    return { assets, states, staged, deleted, store, records, leases, cleanup, add };
}

test("candidate cleanup protects every durable root and deletes only an exact unreferenced path", async () => {
    const f = setup();
    const candidate = home("superseded");
    const baseline = home("baseline");
    const live = home("live");
    const draft = home("draft");
    const revision = home("revision");
    const publication = home("publication");
    const recorded = home("recorded-only");
    const retired = "/images/legacy/cms-retired.png";
    for (const path of [candidate, baseline, live, draft, revision,
        publication, recorded, retired]) f.add(path);
    f.states.set("baseline", { content: { ...content(baseline), retired },
        assets: [baseline, retired] });
    f.states.set("draft", { content: content(draft) });
    f.states.set("revisions", { entries: [{ content: content(revision) }] });
    f.states.set("publication", { status: "uncertain",
        draft: { content: content(publication) }, assets: [publication] });
    let checks = 0;
    const deleted = await f.cleanup.cleanupCandidates([candidate, baseline, live, draft,
        revision, publication, retired, candidate],
    { ensureActive: async () => { checks += 1; } });
    assert.deepEqual(deleted, [candidate]);
    assert.deepEqual(f.deleted, [stagedCmsImageKey(candidate)]);
    assert.ok(checks >= 3);
    assert.equal(f.staged.has(stagedCmsImageKey(retired)), true);
    // A recorded-only path cannot authorize deletion of any other key.
    f.states.set("publication", { status: "uncertain",
        draft: { content: content(publication) }, assets: [recorded] });
    await assert.rejects(f.cleanup.cleanupCandidates([home("another")],
        { ensureActive: async () => {} }),
    { code: "CMS_ASSET_REFERENCES_INCOMPLETE", status: 503 });
});

test("missing or malformed durable roots stop before listing or deletion", async () => {
    for (const mutate of [
        (f) => f.states.delete("baseline"),
        (f) => f.states.delete("confirmedLive"),
        (f) => f.states.set("revisions", { entries: "invalid" }),
        (f) => f.states.set("publication", { status: "uncertain" }),
        (f) => f.states.set("draft", { content: null }),
    ]) {
        const f = setup();
        f.add(home("eligible"));
        mutate(f);
        await assert.rejects(f.cleanup.sweep(),
            { code: "CMS_ASSET_REFERENCES_INCOMPLETE", status: 503 });
        assert.deepEqual(f.deleted, []);
    }
});

test("GC requires exact metadata, seven days of age, and source ownership", async () => {
    const f = setup();
    const eligible = home("eligible");
    const young = home("young");
    const missingOwner = home("missing-owner");
    const protectedPath = home("baseline");
    const wrongPath = home("same-name");
    f.add(eligible);
    f.add(young, { uploadedAt: YOUNG });
    f.add(missingOwner, { uploadedBy: "" });
    f.add(protectedPath);
    f.add(wrongPath, { publicPath: about("same-name") });
    f.states.set("draft", { content: content(wrongPath) });
    const result = await f.cleanup.sweep();
    assert.deepEqual(result.deleted, [eligible]);
    assert.deepEqual(f.deleted, [stagedCmsImageKey(eligible)]);
    assert.equal(f.staged.has(stagedCmsImageKey(young)), true);
    assert.equal(f.staged.has(stagedCmsImageKey(protectedPath)), true);
    assert.equal(f.staged.has(stagedCmsImageKey(wrongPath)), true);
    assert.equal(f.leases.acquired[0].kind, "asset-cleanup");
});

test("candidate cleanup protects a staged basename used by another durable path", async () => {
    const f = setup();
    const protectedPath = home("shared");
    const candidate = about("shared");
    f.states.set("baseline", { content: content(protectedPath) });
    f.add(candidate);
    assert.deepEqual(await f.cleanup.cleanupCandidates([candidate],
        { ensureActive: async () => {} }), []);
    assert.equal(f.staged.has(stagedCmsImageKey(candidate)), true);
    assert.deepEqual(f.deleted, []);
});

test("GC stops at 100 scanned and 50 attempted, counting failed deletes", async () => {
    const f = setup();
    for (let index = 0; index < 110; index += 1) {
        f.add(home(`item-${String(index).padStart(3, "0")}`));
    }
    const firstKey = stagedCmsImageKey(home("item-000"));
    const originalDelete = f.store.delete;
    f.store.delete = async (key) => {
        if (key === firstKey) throw new Error("delete failed");
        return originalDelete(key);
    };
    const failures = [];
    const result = await f.cleanup.sweep({ onDeleteError(error, path) {
        failures.push([error.message, path]);
    } });
    assert.equal(result.deletionAttempts, 50);
    assert.equal(result.deleted.length, 49);
    assert.deepEqual(result.failed, [home("item-000")]);
    assert.deepEqual(failures, [["delete failed", home("item-000")]]);
    assert.ok(result.scanned <= 100);
    await assert.rejects(f.cleanup.sweep({ maxScanned: 101 }), TypeError);
});

test("busy lease skips without listing; lease loss stops before delete", async () => {
    const f = setup();
    f.add(home("eligible"));
    f.leases.acquire = async () => {
        throw Object.assign(new Error("busy"), { code: "CMS_STATE_LOCKED" });
    };
    assert.deepEqual(await f.cleanup.sweep(), { skipped: true, reason: "busy" });
    assert.deepEqual(f.deleted, []);
    const g = setup();
    g.add(home("eligible"));
    g.leases.renew = async () => {
        throw Object.assign(new Error("lost"), { code: "CMS_STATE_LOCKED" });
    };
    await assert.rejects(g.cleanup.sweep(), { code: "CMS_STATE_LOCKED" });
    assert.deepEqual(g.deleted, []);
});

test("stale list ETag and changed metadata stop without deleting the affected key", async () => {
    const f = setup();
    f.add(home("eligible"));
    f.store.list = async function* () {
        yield { blobs: [{ key: stagedCmsImageKey(home("eligible")), etag: "stale" }] };
    };
    await assert.rejects(f.cleanup.sweep(), { code: "CMS_STATE_CONFLICT" });
    assert.deepEqual(f.deleted, []);
    const g = setup();
    const path = home("eligible");
    g.add(path);
    let reads = 0;
    const originalRead = g.store.getMetadata;
    g.store.getMetadata = async (...args) => {
        reads += 1;
        const item = await originalRead(...args);
        if (reads === 2) return { ...item, etag: "changed" };
        return item;
    };
    await assert.rejects(g.cleanup.sweep(), { code: "CMS_STATE_CONFLICT" });
    assert.deepEqual(g.deleted, []);
});

test("candidate cleanup stops when its publication lease or metadata read fails", async () => {
    const f = setup();
    const path = home("candidate");
    f.add(path);
    let checks = 0;
    await assert.rejects(f.cleanup.cleanupCandidates([path], {
        ensureActive: async () => {
            checks += 1;
            if (checks === 3) throw new Error("lease lost");
        },
    }), /lease lost/);
    assert.deepEqual(f.deleted, []);
    const g = setup();
    g.add(path);
    g.store.getMetadata = async () => { throw new Error("metadata unavailable"); };
    await assert.rejects(g.cleanup.cleanupCandidates([path],
        { ensureActive: async () => {} }), /metadata unavailable/);
    assert.deepEqual(g.deleted, []);
});

test("required record and listing errors fail closed; one metadata read error skips its candidate", async () => {
    const f = setup();
    f.add(home("eligible"));
    f.records.read = async () => { throw new Error("record provider down"); };
    await assert.rejects(f.cleanup.sweep(), /record provider down/);
    assert.deepEqual(f.deleted, []);
    const g = setup();
    g.add(home("eligible"));
    g.store.list = async function* () { throw new Error("list down"); };
    await assert.rejects(g.cleanup.sweep(), /list down/);
    assert.deepEqual(g.deleted, []);
    const h = setup();
    h.add(home("eligible"));
    h.store.getMetadata = async () => { throw new Error("metadata down"); };
    const result = await h.cleanup.sweep();
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(h.deleted, []);
});
