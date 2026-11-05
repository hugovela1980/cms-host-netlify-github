import assert from "node:assert/strict";
import test from "node:test";

import { createCmsContentDraftSaveService, createCmsDraftRecordService,
    createCmsDraftRevertService, createCmsHostPolicyBundle,
    createCmsJsonRecordStore, createCmsLeaseManager,
    createCmsManagedImageCleanup, stagedCmsImageKey } from "../src/server/index.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const OLD = "2026-10-20T12:00:00.000Z";
const path = "/images/home/cms-overlap.png";
const liveContent = { home: { hero: { heading: "Live", image: { src: "/images/home/cms-live.png" } } } };
const referencedContent = { home: { hero: { heading: "Draft", image: { src: path } } } };
const contentPolicy = {
    classifyPublic(raw) { return { kind: "current", content: raw }; },
    normalizePersisted(raw) { return structuredClone(raw); },
    validateCurrent(raw) { return raw; },
    historicalManagedAssetReferences() { return new Set(); },
};
const field = { sectionPath: "home.hero", schemaId: "hero", fieldKey: "image.src",
    destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/" };

async function fixture({ commit = "live", deployedIdentity = null,
    deployedFailure = null } = {}) {
    const state = new Map();
    const blobs = new Map();
    let sequence = 0;
    let onDraftWrite = null;
    let onWriterAcquire = null;
    let metadataFailure = null;
    const store = {
        async getWithMetadata(key) { return structuredClone(state.get(key) ?? null); },
        async setJSON(key, data, options) {
            if (key === "state/draft" && onDraftWrite) {
                const callback = onDraftWrite;
                onDraftWrite = null;
                await callback();
            }
            const current = state.get(key);
            if (options.onlyIfNew && current) return { modified: false };
            if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
                return { modified: false };
            }
            const etag = `state-${++sequence}`;
            state.set(key, { data: structuredClone(data), etag, metadata: {} });
            return { modified: true, etag };
        },
        async getMetadata(key) {
            if (metadataFailure) throw metadataFailure;
            return blobs.get(key) ?? null;
        },
        async delete(key) { blobs.delete(key); },
        async *list() {
            yield { blobs: [...blobs].map(([key, item]) => ({ key, etag: item.etag })) };
        },
    };
    const records = createCmsJsonRecordStore({ store, keys: {
        draft: "state/draft", baseline: "state/baseline",
        confirmedLive: "state/confirmed-live", revisions: "state/revisions",
        publication: "state/publication", coordination: "state/coordination",
    } });
    await records.writeIfVersion("baseline", { content: liveContent }, null);
    await records.writeIfVersion("confirmedLive", { content: liveContent,
        revisionId: commit }, null);
    await records.writeIfVersion("revisions", { entries: [] }, null);
    blobs.set(stagedCmsImageKey(path), { etag: "image-etag", metadata: {
        publicPath: path, contentType: "image/png", uploadedAt: OLD,
        uploadedBy: "editor@example.test",
    } });
    const leases = createCmsLeaseManager({ records, now: () => NOW,
        createOwner: () => "operation" });
    const writerLeases = { acquire: async (options) => {
        if (onWriterAcquire) await onWriterAcquire();
        return leases.acquire(options);
    }, renew: (...args) => leases.renew(...args),
    release: (...args) => leases.release(...args) };
    const bundle = createCmsHostPolicyBundle({ contentPolicy, managedImages: [field] });
    const imageProof = { store, assets: bundle.assets,
        github: { async readManagedAssetBlobIdentitiesAtCommit(paths, requestedCommit, options) {
            assert.deepEqual(paths, [`public${path}`]);
            assert.equal(requestedCommit, commit);
            assert.deepEqual(options.content, referencedContent);
            if (deployedFailure) throw deployedFailure;
            return deployedIdentity ? new Map([[`public${path}`, deployedIdentity]]) : new Map();
        } } };
    const cleanup = createCmsManagedImageCleanup({ store, records,
        assets: bundle.assets, leases, now: () => NOW });
    const prepared = createCmsDraftRecordService({ records,
        content: bundle.content, leases: writerLeases, ...imageProof });
    const save = createCmsContentDraftSaveService({ records,
        content: bundle.content, leases: writerLeases, ...imageProof,
        applyContentChanges() { return referencedContent; },
        deriveSections() { return []; },
        validateNote(value) { return value ?? ""; },
        validateCleanupCandidates(value) { return value ?? []; },
        now: () => NOW });
    const revert = createCmsDraftRevertService({ records,
        content: bundle.content, leases: writerLeases,
        validateNote(value) { return value ?? ""; },
        now: () => NOW });
    return { state, blobs, store, records, leases, writerLeases, cleanup, prepared, save, revert,
        onDraftWrite(callback) { onDraftWrite = callback; },
        onWriterAcquire(callback) { onWriterAcquire = callback; },
        failMetadata(error) { metadataFailure = error; } };
}

test("asset-cleanup lease blocks every package draft writer before it adds a reference", async () => {
    const f = await fixture();
    let held = await f.leases.acquire({ kind: "asset-cleanup" });
    const active = async () => { held = await f.leases.renew(held); };
    await assert.rejects(f.prepared.writePrepared({ record: { content: referencedContent },
        expectedDraftVersion: null }), { code: "CMS_STATE_LOCKED", status: 423 });
    await assert.rejects(f.save.save({ request: { expectedDraftVersion: null,
        changes: [{ path: "home.hero.image.src", value: path }] },
    actor: { email: "editor@example.test" }, confirmedFallbackContent: liveContent }),
    { code: "CMS_STATE_LOCKED", status: 423 });
    await assert.rejects(f.revert.revert({ request: { expectedDraftVersion: null },
        actor: { email: "editor@example.test" },
        confirmedFallbackContent: liveContent }),
    { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(await f.records.read("draft"), null);
    assert.deepEqual(await f.cleanup.cleanupCandidates([path],
        { ensureActive: active }), [path]);
    assert.equal(f.blobs.has(stagedCmsImageKey(path)), false);
    assert.equal(await f.leases.release(held), true);
});

test("draft writer lease makes GC skip; its new reference protects the later sweep", async () => {
    const f = await fixture();
    let duringWrite;
    f.onDraftWrite(async () => { duringWrite = await f.cleanup.sweep(); });
    const result = await f.prepared.writePrepared({
        record: { content: referencedContent, hasUnpublishedChanges: true },
        expectedDraftVersion: null,
    });
    assert.match(result.draftVersion, /^state-\d+$/);
    assert.deepEqual(duringWrite, { skipped: true, reason: "busy" });
    assert.equal(f.blobs.has(stagedCmsImageKey(path)), true);
    assert.deepEqual((await f.cleanup.sweep()).deleted, []);
    assert.equal(f.blobs.has(stagedCmsImageKey(path)), true);
});

async function cleanupBeforeWriterAcquires(f, write) {
    let entered;
    let proceed;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { proceed = resolve; });
    f.onWriterAcquire(async () => { entered(); await gate; });
    const pending = write();
    await waiting;
    assert.deepEqual((await f.cleanup.sweep()).deleted, [path]);
    proceed();
    await assert.rejects(pending,
        { code: "MANAGED_ASSET_IDENTITY_UNAVAILABLE", status: 502 });
    assert.equal(await f.records.read("draft"), null);
}

test("Save fails closed when cleanup deletes its new image before lease acquisition", async () => {
    const f = await fixture();
    await cleanupBeforeWriterAcquires(f, () => f.save.save({
        request: { expectedDraftVersion: null,
            changes: [{ path: "home.hero.image.src", value: path }] },
        actor: { email: "editor@example.test" }, confirmedFallbackContent: liveContent,
    }));
});

test("prepared write fails closed when cleanup deletes its image before lease acquisition", async () => {
    const f = await fixture();
    await cleanupBeforeWriterAcquires(f, () => f.prepared.writePrepared({
        record: { content: referencedContent }, expectedDraftVersion: null,
    }));
});

test("new image at an exact PUBLIC commit blob identity can be saved without staging", async () => {
    const commit = "a".repeat(40);
    const f = await fixture({ commit,
        deployedIdentity: { sha: "b".repeat(40), size: 123 } });
    f.blobs.delete(stagedCmsImageKey(path));
    const result = await f.prepared.writePrepared({
        record: { content: referencedContent }, expectedDraftVersion: null,
    });
    assert.match(result.draftVersion, /^state-\d+$/);
    assert.deepEqual((await f.records.read("draft")).data.content, referencedContent);
});

test("ambiguous staged metadata and Git identity provider errors cannot create references", async () => {
    const staged = await fixture();
    staged.blobs.get(stagedCmsImageKey(path)).metadata.publicPath =
        "/images/other/cms-overlap.png";
    await assert.rejects(staged.prepared.writePrepared({
        record: { content: referencedContent }, expectedDraftVersion: null,
    }), { code: "MANAGED_ASSET_IDENTITY_UNAVAILABLE", status: 502 });
    assert.equal(await staged.records.read("draft"), null);

    const deployed = await fixture({ commit: "a".repeat(40),
        deployedFailure: new Error("Git provider unavailable") });
    deployed.blobs.delete(stagedCmsImageKey(path));
    await assert.rejects(deployed.prepared.writePrepared({
        record: { content: referencedContent }, expectedDraftVersion: null,
    }), { code: "MANAGED_ASSET_IDENTITY_UNAVAILABLE", status: 502 });
    assert.equal(await deployed.records.read("draft"), null);
});

test("staged metadata provider failure and lost lease prevent a new reference write", async () => {
    const f = await fixture();
    f.failMetadata(new Error("staged provider unavailable"));
    await assert.rejects(f.prepared.writePrepared({
        record: { content: referencedContent }, expectedDraftVersion: null,
    }), /staged provider unavailable/);
    assert.equal(await f.records.read("draft"), null);
    f.failMetadata(null);
    f.writerLeases.renew = async () => { throw new Error("lease lost"); };
    await assert.rejects(f.prepared.writePrepared({
        record: { content: referencedContent }, expectedDraftVersion: null,
    }), /lease lost/);
    assert.equal(await f.records.read("draft"), null);
});

test("Revert only writes confirmed-live references that cleanup already protects", async () => {
    const f = await fixture();
    const livePath = liveContent.home.hero.image.src;
    f.blobs.set(stagedCmsImageKey(livePath), { etag: "live-image", metadata: {
        publicPath: livePath, contentType: "image/png", uploadedAt: OLD,
        uploadedBy: "editor@example.test",
    } });
    const reverted = await f.revert.revert({ request: { expectedDraftVersion: null },
        actor: { email: "editor@example.test" }, confirmedFallbackContent: liveContent });
    assert.deepEqual(reverted.draft, liveContent);
    assert.deepEqual((await f.cleanup.sweep()).deleted, [path]);
    assert.equal(f.blobs.has(stagedCmsImageKey(livePath)), true);
});

test("Revert rejects stale live content after foundation and cleanup run before its lease", async () => {
    const f = await fixture();
    const oldLivePath = liveContent.home.hero.image.src;
    f.blobs.set(stagedCmsImageKey(oldLivePath), { etag: "old-live-image", metadata: {
        publicPath: oldLivePath, contentType: "image/png", uploadedAt: OLD,
        uploadedBy: "editor@example.test",
    } });
    const baseline = await f.records.read("baseline");
    await f.records.writeIfVersion("baseline", { content: referencedContent }, baseline.etag);
    let entered;
    let proceed;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { proceed = resolve; });
    f.onWriterAcquire(async () => { entered(); await gate; });
    const pending = f.revert.revert({ request: { expectedDraftVersion: null },
        actor: { email: "editor@example.test" }, confirmedFallbackContent: liveContent });
    await waiting;
    let foundationLease = await f.leases.acquire({ kind: "foundation" });
    foundationLease = await f.leases.renew(foundationLease);
    const live = await f.records.read("confirmedLive");
    await f.records.writeIfVersion("confirmedLive", { content: referencedContent,
        revisionId: "new-live" }, live.etag);
    assert.equal(await f.leases.release(foundationLease), true);
    assert.ok((await f.cleanup.sweep()).deleted.includes(oldLivePath));
    proceed();
    await assert.rejects(pending, { code: "CMS_STATE_CONFLICT", status: 409 });
    assert.equal(await f.records.read("draft"), null);
});
