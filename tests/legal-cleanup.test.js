import assert from "node:assert/strict";
import test from "node:test";

import { createCmsDraftRecordService, createCmsLegalCleanup,
    LEGAL_MAX_DELETE_COUNT, LEGAL_MAX_SCAN_COUNT } from "../src/server/index.js";
import { inventoryDurableLegalReferences } from "../src/server/legal/references.js";
import { syntheticPdf } from "./fixtures/legal.js";
import { createLegalState, LEGAL_NOW, LEGAL_OLD } from "./fixtures/legal-state.js";

const actor = { email: "editor@example.test" };

async function oldStagedPdf(f) {
    const upload = await f.service.stage({ page: "privacy", kind: "pdf",
        file: new File([syntheticPdf("Privacy Policy Changed wording.")], "changed.pdf") }, actor);
    const key = f.capability.stagedKey("privacy", "pdf", upload.hash);
    f.entries.get(key).metadata.uploadedAt = LEGAL_OLD;
    f.entries.get(`${key}/metadata`).data.uploadedAt = LEGAL_OLD;
    return { key, upload };
}

test("all durable roots protect exact legal hashes; partial state blocks deletion", async () => {
    const f = await createLegalState();
    const { key, upload } = await oldStagedPdf(f);
    const originals = f.service.initialPairs();
    const pair = { ...originals.privacy,
        pdf: { hash: upload.hash, name: upload.name } };
    for (const root of ["baseline", "confirmedLive", "draft", "revisions",
        "publication"]) {
        const roots = { baseline: { legal: originals }, confirmedLive: { legal: originals },
            revisions: { entries: [] } };
        const record = { legal: { privacy: pair } };
        if (root === "revisions") roots.revisions.entries.push(record);
        else if (root === "publication") roots.publication = { status: "uncertain", draft: record };
        else roots[root] = record;
        const inventory = inventoryDurableLegalReferences(roots, f.capability);
        assert.deepEqual(inventory.errors, []);
        assert.equal(inventory.protectedKeys.has(key), true, root);
    }
    const missing = inventoryDurableLegalReferences({ confirmedLive: { legal: originals } },
        f.capability);
    assert.ok(missing.errors.some((error) => error.root === "baseline"));
    const partial = inventoryDurableLegalReferences({ baseline: { legal: originals },
        confirmedLive: { legal: { privacy: { document: originals.privacy.document } } } },
    f.capability);
    assert.ok(partial.errors.some((error) => error.reason === "reference-invalid"));
});

test("bounded sweep removes only old unreferenced bytes and sidecars", async () => {
    const f = await createLegalState();
    const { key } = await oldStagedPdf(f);
    const cleanup = createCmsLegalCleanup({ capability: f.capability,
        store: f.store, records: f.records, leases: f.leases,
        now: () => LEGAL_NOW });
    const result = await cleanup.sweep();
    assert.equal(result.scanned, 2);
    assert.equal(result.deletionAttempts, 2);
    assert.deepEqual(result.deleted, [key]);
    assert.equal(f.entries.has(key), false);
    assert.equal(f.entries.has(`${key}/metadata`), false);
    await assert.rejects(cleanup.sweep({ maxScanned: LEGAL_MAX_SCAN_COUNT + 1 }), TypeError);
    await assert.rejects(cleanup.sweep({ maxDeletions: LEGAL_MAX_DELETE_COUNT + 1 }), TypeError);
});

test("malformed optional records and recently repaired sidecars block cleanup", async () => {
    const f = await createLegalState();
    const { key } = await oldStagedPdf(f);
    const cleanup = createCmsLegalCleanup({ capability: f.capability,
        store: f.store, records: f.records, leases: f.leases,
        now: () => LEGAL_NOW });
    await f.store.setJSON("state/draft", null);
    await assert.rejects(cleanup.sweep(), { code: "LEGAL_REFERENCES_INCOMPLETE" });
    assert.equal(f.entries.has(key), true);
    f.entries.delete("state/draft");
    f.entries.get(`${key}/metadata`).data.uploadedAt = LEGAL_NOW.toISOString();
    assert.deepEqual((await cleanup.sweep()).deleted, []);
    assert.equal(f.entries.has(key), true);
    assert.equal(f.entries.has(`${key}/metadata`), true);
});

test("deletion bound counts each provider delete and leaves a safe retry", async () => {
    const f = await createLegalState();
    const { key } = await oldStagedPdf(f);
    const cleanup = createCmsLegalCleanup({ capability: f.capability,
        store: f.store, records: f.records, leases: f.leases,
        now: () => LEGAL_NOW });
    const first = await cleanup.sweep({ maxDeletions: 1 });
    assert.equal(first.deletionAttempts, 1);
    assert.deepEqual(first.deleted, []);
    assert.equal(first.failed[0].reason, "limit");
    assert.equal(f.entries.has(key), true);
    assert.equal(f.entries.has(`${key}/metadata`), false);
    assert.deepEqual((await cleanup.sweep({ maxDeletions: 1 })).deleted, [key]);
});

test("partial delete stays retryable and is never reported as complete", async () => {
    const f = await createLegalState();
    const { key } = await oldStagedPdf(f);
    const cleanup = createCmsLegalCleanup({ capability: f.capability,
        store: f.store, records: f.records, leases: f.leases,
        now: () => LEGAL_NOW });
    f.failDelete(key);
    const partial = await cleanup.sweep();
    assert.deepEqual(partial.deleted, []);
    assert.equal(partial.failed[0].phase, "bytes");
    assert.equal(partial.failed[0].metadataDeleted, true);
    assert.equal(f.entries.has(key), true);
    assert.equal(f.entries.has(`${key}/metadata`), false);
    f.failDelete(null);
    assert.deepEqual((await cleanup.sweep()).deleted, [key]);
    assert.equal(f.entries.has(key), false);
});

test("orphan sidecar and a busy lease are handled without touching protected files", async () => {
    const f = await createLegalState();
    const { key } = await oldStagedPdf(f);
    const cleanup = createCmsLegalCleanup({ capability: f.capability,
        store: f.store, records: f.records, leases: f.leases,
        now: () => LEGAL_NOW });
    const held = await f.leases.acquire({ kind: "draft" });
    assert.deepEqual(await cleanup.sweep(), { skipped: true, reason: "busy" });
    assert.equal(f.entries.has(key), true);
    assert.equal(await f.leases.release(held), true);
    f.entries.delete(key);
    assert.deepEqual((await cleanup.sweep()).deleted, [`${key}/metadata`]);
});

test("prepared draft cannot add a legal reference deleted while it waits for the lease", async () => {
    const f = await createLegalState();
    const { key, upload } = await oldStagedPdf(f);
    const pair = await f.service.composePair("privacy",
        f.service.initialPairs().privacy.document.hash, upload.hash);
    const cleanup = createCmsLegalCleanup({ capability: f.capability,
        store: f.store, records: f.records, leases: f.leases,
        now: () => LEGAL_NOW });
    let entered;
    let proceed;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { proceed = resolve; });
    const writerLeases = { acquire: async (options) => { entered(); await gate;
        return f.leases.acquire(options); },
    renew: (...args) => f.leases.renew(...args),
    release: (...args) => f.leases.release(...args) };
    const github = { async readManagedAssetBlobIdentitiesAtCommit() { return new Map(); },
        async readFileAtCommit() { throw new Error("not deployed"); } };
    const drafts = createCmsDraftRecordService({ records: f.records,
        content: f.capability.assetBundle.content,
        assets: f.capability.assetBundle.assets, store: f.store,
        leases: writerLeases, github, legalService: f.service });
    const pending = drafts.writePrepared({ record: {
        content: { home: {} }, legal: { privacy: pair } },
    expectedDraftVersion: null });
    await waiting;
    assert.deepEqual((await cleanup.sweep()).deleted, [key]);
    proceed();
    await assert.rejects(pending, { code: "LEGAL_FILE_NOT_FOUND" });
    assert.equal(await f.records.read("draft"), null);
});
