import assert from "node:assert/strict";
import test from "node:test";

import { createCmsHistoricalLegalRecovery } from "../src/server/index.js";
import { syntheticDocx, syntheticPdf } from "./fixtures/legal.js";
import { createLegalState } from "./fixtures/legal-state.js";

const actor = { email: "editor@example.test" };
const COMMIT = "b".repeat(40);

async function fixture() {
    const f = await createLegalState();
    const documentBytes = syntheticDocx("Privacy Policy", "Historical wording.");
    const pdfBytes = syntheticPdf("Privacy Policy Historical wording.");
    const document = await f.service.stage({ page: "privacy", kind: "document",
        file: new File([documentBytes], "historical.docx") }, actor);
    const pdf = await f.service.stage({ page: "privacy", kind: "pdf",
        file: new File([pdfBytes], "historical.pdf") }, actor);
    const pair = await f.service.composePair("privacy", document.hash, pdf.hash);
    const snapshot = { commit: COMMIT, content: { home: {} },
        legal: { privacy: pair } };
    const documentPath = f.capability.sourcePath("privacy", pair.document);
    const pdfPath = f.capability.requirePage("privacy").pdfPath;
    const files = new Map([[documentPath, documentBytes], [pdfPath, pdfBytes]]);
    for (const kind of ["document", "pdf"]) {
        const key = f.capability.stagedKey("privacy", kind, pair[kind].hash);
        f.entries.delete(key);
        f.entries.delete(`${key}/metadata`);
    }
    const reads = [];
    const github = { async readFileAtCommit(path, commit) {
        reads.push({ path, commit });
        return files.get(path) ?? null;
    } };
    const recovery = createCmsHistoricalLegalRecovery({ capability: f.capability,
        service: f.service, store: f.store, github });
    let lease = await f.leases.acquire({ kind: "restore" });
    const ensureActive = async () => { lease = await f.leases.renew(lease); };
    return { ...f, snapshot, pair, files, reads, github, recovery,
        ensureActive, release: () => f.leases.release(lease) };
}

test("exact historical commit restores source and PDF bytes with guarded rollback", async () => {
    const f = await fixture();
    const undoDocument = await f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive });
    const undoPdf = await f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "pdf", ensureActive: f.ensureActive });
    assert.equal(typeof undoDocument, "function");
    assert.equal(typeof undoPdf, "function");
    assert.deepEqual(f.reads, [
        { path: f.capability.sourcePath("privacy", f.pair.document), commit: COMMIT },
        { path: f.capability.requirePage("privacy").pdfPath, commit: COMMIT },
    ]);
    for (const kind of ["document", "pdf"]) {
        const key = f.capability.stagedKey("privacy", kind, f.pair[kind].hash);
        assert.equal(f.entries.has(key), true);
        assert.equal(f.entries.has(`${key}/metadata`), true);
        assert.equal((await f.service.readFile("privacy", kind, f.pair[kind].hash)).length > 0, true);
    }
    await undoPdf();
    await undoDocument();
    for (const kind of ["document", "pdf"]) {
        const key = f.capability.stagedKey("privacy", kind, f.pair[kind].hash);
        assert.equal(f.entries.has(key), false);
        assert.equal(f.entries.has(`${key}/metadata`), false);
    }
    assert.equal(await f.release(), true);
});

test("an existing exact staged pair is preserved without a Git read or rollback", async () => {
    const f = await fixture();
    const undo = await f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive });
    assert.equal(typeof undo, "function");
    const readCount = f.reads.length;
    assert.equal(await f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive }), undefined);
    assert.equal(f.reads.length, readCount);
    assert.equal(await f.release(), true);
});

test("existing staged bytes must match the snapshot's parsed document", async () => {
    const f = await fixture();
    await f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive });
    const altered = structuredClone(f.snapshot);
    altered.legal.privacy.document.blocks[0].text = "Different rendered text";
    await assert.rejects(f.recovery.recover({ snapshot: altered,
        page: "privacy", kind: "document", ensureActive: f.ensureActive }),
    { code: "REVISION_ASSET_UNAVAILABLE" });
    assert.equal(await f.release(), true);
});

test("wrong commit, changed Git bytes, malformed snapshot, and changed rollback ETag fail closed", async () => {
    const f = await fixture();
    await assert.rejects(f.recovery.recover({ snapshot: { ...f.snapshot,
        commit: "not-a-sha" }, page: "privacy", kind: "document",
    ensureActive: f.ensureActive }), { code: "REVISION_ASSET_UNAVAILABLE" });
    const path = f.capability.sourcePath("privacy", f.pair.document);
    f.files.set(path, Buffer.from("changed"));
    await assert.rejects(f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive }),
    { code: "REVISION_ASSET_UNAVAILABLE" });
    f.files.set(path, syntheticDocx("Privacy Policy", "Historical wording."));
    await assert.rejects(f.recovery.recover({ snapshot: { ...f.snapshot,
        legal: { privacy: { document: f.pair.document } } },
    page: "privacy", kind: "document", ensureActive: f.ensureActive }),
    { code: "REVISION_ASSET_UNAVAILABLE" });
    const undo = await f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive });
    const key = f.capability.stagedKey("privacy", "document", f.pair.document.hash);
    f.entries.get(key).etag = "changed-etag";
    await assert.rejects(undo(), { code: "CMS_STATE_CONFLICT" });
    assert.equal(f.entries.has(key), true);
    assert.equal(await f.release(), true);
});

test("metadata write failure rolls back only newly staged bytes", async () => {
    const f = await fixture();
    const originalSetJSON = f.store.setJSON;
    f.store.setJSON = async function(key, data, options) {
        if (key.endsWith("/metadata")) throw new Error("metadata unavailable");
        return originalSetJSON.call(this, key, data, options);
    };
    await assert.rejects(f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive }),
    /metadata unavailable/);
    const key = f.capability.stagedKey("privacy", "document", f.pair.document.hash);
    assert.equal(f.entries.has(key), false);
    assert.equal(f.entries.has(`${key}/metadata`), false);
    assert.equal(await f.release(), true);
});

test("post-write verification failure rolls back both newly created keys", async () => {
    const f = await fixture();
    const key = f.capability.stagedKey("privacy", "document", f.pair.document.hash);
    const sidecar = `${key}/metadata`;
    const originalRead = f.store.getWithMetadata;
    let failed = false;
    f.store.getWithMetadata = async function(target, options) {
        if (target === sidecar && f.entries.has(sidecar) && !failed) {
            failed = true;
            throw new Error("sidecar read failed");
        }
        return originalRead.call(this, target, options);
    };
    await assert.rejects(f.recovery.recover({ snapshot: f.snapshot,
        page: "privacy", kind: "document", ensureActive: f.ensureActive }),
    /sidecar read failed/);
    assert.equal(f.entries.has(key), false);
    assert.equal(f.entries.has(sidecar), false);
    assert.equal(await f.release(), true);
});
