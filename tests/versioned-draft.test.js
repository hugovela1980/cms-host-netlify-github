import assert from "node:assert/strict";
import test from "node:test";

import { createCmsDraftRecordService, createCmsJsonRecordStore } from "../src/server/index.js";

function fixture() {
    const entries = new Map();
    let sequence = 0;
    let beforeWrite = null;
    const store = {
        async getWithMetadata(key, options) {
            assert.equal(key, "state/draft");
            assert.deepEqual(options, { type: "json", consistency: "strong" });
            return structuredClone(entries.get(key) ?? null);
        },
        async setJSON(key, data, options) {
            beforeWrite?.();
            beforeWrite = null;
            const current = entries.get(key);
            if (options.onlyIfNew && current) return { modified: false };
            if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
                return { modified: false };
            }
            const etag = `v${++sequence}`;
            entries.set(key, { data: structuredClone(data), etag, metadata: { source: "fixture" } });
            return { modified: true, etag };
        },
    };
    const records = createCmsJsonRecordStore({ store, keys: { draft: "state/draft" } });
    const leases = { async acquire() { return { owner: "prepared" }; },
        async renew(lease) { return lease; }, async release() { return true; } };
    const content = {
        normalizePersisted(raw, fallback) {
            return { ...structuredClone(fallback), ...structuredClone(raw) };
        },
        validateCurrent(value) {
            if (!value?.heading) throw new TypeError("Missing heading.");
            return value;
        },
    };
    const imageProof = { store: { async getMetadata() { return null; } },
        github: { async readManagedAssetBlobIdentitiesAtCommit() { return new Map(); } },
        assets: { contentImagePaths() { return new Set(); }, isManagedImagePath() { return false; } } };
    return { entries, records, content, leases,
        service: createCmsDraftRecordService({ records, content, leases, ...imageProof }),
        race(write) { beforeWrite = write; } };
}

function isConflict(error) {
    return error.code === "DRAFT_CONFLICT" && error.status === 409 &&
        error.message === "The draft changed. Reload it before trying again.";
}

test("absent, historical and clean drafts keep raw record and explicit working fallback", async () => {
    const { entries, service } = fixture();
    const fallback = { heading: "Live", image: "live.png" };
    await assert.rejects(service.read(), TypeError);
    assert.deepEqual(await service.read({ fallbackContent: fallback }), {
        record: null, draftVersion: null, hasSavedDraft: false, workingContent: fallback,
    });
    const historical = { content: { heading: "Draft" }, legal: { privacy: { pdf: "p.pdf" } },
        extra: { value: 1 }, hasUnpublishedChanges: true };
    const stored = { data: structuredClone(historical), etag: "old", metadata: { source: "fixture" } };
    entries.set("state/draft", stored);
    const read = await service.read({ fallbackContent: fallback });
    assert.deepEqual(read.record, stored);
    assert.equal(read.draftVersion, "old");
    assert.equal(read.hasSavedDraft, true);
    assert.deepEqual(read.workingContent, { heading: "Draft", image: "live.png" });
    assert.deepEqual(entries.get("state/draft"), stored);
    entries.set("state/draft", { ...stored,
        data: { ...historical, hasUnpublishedChanges: false } });
    const clean = await service.read({ fallbackContent: fallback });
    assert.equal(clean.draftVersion, "old");
    assert.equal(clean.hasSavedDraft, false);
    assert.strictEqual(clean.workingContent, fallback);
    assert.deepEqual(clean.record.data.legal, historical.legal);
});

test("prepared records pass through unchanged on create and matching ETag update", async () => {
    const { records, service } = fixture();
    const prepared = { content: { heading: "First" }, legal: { privacy: { pdf: "p.pdf" } },
        note: "Review", updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: "editor@example.com",
        cleanupCandidates: ["old.png"], sections: [{ sectionPath: "home.hero" }],
        baseRevision: "live-1", hasUnpublishedChanges: true, extension: { id: 7 } };
    assert.deepEqual(await service.writePrepared({ record: prepared, expectedDraftVersion: null }),
        { draftVersion: "v1" });
    assert.deepEqual((await records.read("draft")).data, prepared);
    const next = { ...prepared, content: { heading: "Second" } };
    assert.deepEqual(await service.writePrepared({ record: next, expectedDraftVersion: "v1" }),
        { draftVersion: "v2" });
    assert.deepEqual((await records.read("draft")).data, next);
    assert.deepEqual(prepared.content, { heading: "First" });
});

test("stale, omitted and racing versions conflict without overwriting", async () => {
    const { entries, service, race } = fixture();
    const first = { content: { heading: "First" } };
    await service.writePrepared({ record: first, expectedDraftVersion: null });
    for (const version of [undefined, null, "stale"]) {
        await assert.rejects(service.writePrepared({ record: { content: { heading: "Lost" } },
            expectedDraftVersion: version }), isConflict);
    }
    assert.deepEqual(entries.get("state/draft").data, first);
    race(() => entries.set("state/draft", { data: { content: { heading: "Racer" } },
        etag: "raced", metadata: {} }));
    await assert.rejects(service.writePrepared({ record: { content: { heading: "Lost" } },
        expectedDraftVersion: "v1" }), isConflict);
    assert.equal(entries.get("state/draft").data.content.heading, "Racer");
});

test("invalid content and provider failures propagate without write", async () => {
    const { entries, service } = fixture();
    await assert.rejects(service.writePrepared({ record: {} }), TypeError);
    await assert.rejects(service.writePrepared({ record: { content: {} },
        expectedDraftVersion: null }), TypeError);
    assert.equal(entries.size, 0);
    const failure = new Error("provider unavailable");
    const broken = createCmsDraftRecordService({ content: {
        normalizePersisted: (value) => value, validateCurrent: (value) => value,
    }, records: { async read() { throw failure; }, async writeIfVersion() { throw failure; } },
    leases: { async acquire() {}, async renew() {}, async release() {} },
    store: { async getMetadata() {} },
    github: { async readManagedAssetBlobIdentitiesAtCommit() {} },
    assets: { contentImagePaths() { return new Set(); }, isManagedImagePath() {} } });
    await assert.rejects(broken.read({ fallbackContent: {} }), (error) => error === failure);
    await assert.rejects(broken.writePrepared({ record: { content: {} } }),
        (error) => error === failure);
    assert.throws(() => createCmsDraftRecordService({}), TypeError);
});

test("busy or lost mutation lease stops a prepared draft write", async () => {
    const f = fixture();
    const request = { record: { content: { heading: "Prepared" } },
        expectedDraftVersion: null };
    f.leases.acquire = async () => {
        throw Object.assign(new Error("busy"), { code: "CMS_STATE_LOCKED", status: 423 });
    };
    await assert.rejects(f.service.writePrepared(request), { code: "CMS_STATE_LOCKED" });
    assert.equal(f.entries.size, 0);
    f.leases.acquire = async () => ({ owner: "prepared" });
    f.leases.renew = async () => {
        throw Object.assign(new Error("lost"), { code: "CMS_STATE_LOCKED", status: 423 });
    };
    await assert.rejects(f.service.writePrepared(request), { code: "CMS_STATE_LOCKED" });
    assert.equal(f.entries.size, 0);
});
