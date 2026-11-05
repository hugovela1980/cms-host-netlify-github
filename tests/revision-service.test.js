import assert from "node:assert/strict";
import test from "node:test";

import { createCmsHostPolicyBundle, createCmsJsonRecordStore,
    createCmsLeaseManager, createCmsHistoricalImageRecovery,
    createCmsHistoricalLegalRecovery, createCmsRevisionService,
    CMS_BASELINE_REVISION_ID, stagedCmsImageKey } from "../src/server/index.js";
import { createLegalState } from "./fixtures/legal-state.js";
import { syntheticDocx, syntheticPdf } from "./fixtures/legal.js";

const LIVE = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const IMAGE = "/images/home/cms-old.png";
const actor = { email: "editor@example.test" };

class Store {
    entries = new Map();
    sequence = 0;
    failDraft = 0;
    async getWithMetadata(key) { return structuredClone(this.entries.get(key) ?? null); }
    async getMetadata(key) {
        const entry = this.entries.get(key);
        return entry ? { etag: entry.etag, metadata: structuredClone(entry.metadata) } : null;
    }
    async set(key, data, options) { return this.write(key, data, options); }
    async setJSON(key, data, options) { return this.write(key, data, options); }
    async write(key, data, options = {}) {
        if (key === "state/draft" && this.failDraft > 0) {
            this.failDraft -= 1;
            return { modified: false };
        }
        const previous = this.entries.get(key);
        if (options.onlyIfNew && previous) return { modified: false };
        if (options.onlyIfMatch !== undefined && previous?.etag !== options.onlyIfMatch) {
            return { modified: false };
        }
        const etag = `etag-${++this.sequence}`;
        this.entries.set(key, { data: structuredClone(data), etag,
            metadata: structuredClone(options.metadata ?? {}) });
        return { modified: true, etag };
    }
    async delete(key) { this.entries.delete(key); }
}

function historyPolicy() {
    return {
        validateHistorical(content) {
            if (!content?.home?.hero?.heading) throw new TypeError("historical heading");
        },
        restoreContent(raw, live) {
            return { home: { ...structuredClone(raw.home),
                footer: structuredClone(raw.home.footer ?? live.home.footer) } };
        },
        describeRevision(content, legal) {
            return { values: { "home.hero.heading": content.home.hero.heading,
                ...(legal ? { "legal.privacy.document": legal.privacy.document.name } : {}) },
            fieldLabels: { "home.hero.heading": "Hero: Heading",
                ...(legal ? { "legal.privacy.document": "Privacy: Page document" } : {}) } };
        },
        changedSections(content, live) {
            return content.home.hero.heading === live.home.hero.heading ? [] :
                [{ sectionPath: "home.hero", label: "Hero" }];
        },
    };
}

async function fixture({ image = false } = {}) {
    const store = new Store();
    const keys = { draft: "state/draft", baseline: "state/baseline",
        confirmedLive: "state/live", revisions: "state/revisions",
        coordination: "state/coordination" };
    const records = createCmsJsonRecordStore({ store, keys });
    const leases = createCmsLeaseManager({ records,
        now: () => new Date("2026-11-04T12:00:00.000Z") });
    const bundle = createCmsHostPolicyBundle({ contentPolicy: {
        classifyPublic(raw) { return { kind: "current", content: raw }; },
        normalizePersisted(raw) { return raw; },
        validateCurrent(content) {
            if (!content?.home?.footer) throw new TypeError("footer");
            return content;
        },
        historicalManagedAssetReferences() { return new Set(); },
    }, managedImages: [{ sectionPath: "home.hero", schemaId: "hero",
        fieldKey: "image.src", destinationDirectory: "public/images/home",
        publicPathPrefix: "/images/home/" }] });
    const liveContent = { home: { hero: { heading: "Current" },
        footer: { text: "Current footer" } } };
    const oldContent = { home: { hero: { heading: "Earlier",
        ...(image ? { image: { src: IMAGE } } : {}) } } };
    await records.writeIfVersion("baseline", { content: oldContent,
        sourceCommit: BASE, capturedAt: "2026-10-01T00:00:00.000Z" }, null);
    await records.writeIfVersion("confirmedLive", { content: liveContent,
        commit: LIVE, revisionId: LIVE }, null);
    const revision = { id: OLD, number: 1, title: "Earlier site", note: "Saved",
        date: "2026-10-02T00:00:00.000Z", commit: OLD, content: oldContent };
    await records.writeIfVersion("revisions", { entries: [revision], nextNumber: 2 }, null);
    const calls = [];
    const github = { async readFileAtCommit(path, commit) {
        calls.push({ path, commit });
        assert.equal(path, `public${IMAGE}`);
        assert.equal(commit, OLD);
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    } };
    const imageRecovery = createCmsHistoricalImageRecovery({ store, github,
        assets: bundle.assets });
    const service = createCmsRevisionService({ records, bundle,
        historyPolicy: historyPolicy(), imageRecovery, leases,
        now: () => new Date("2026-11-04T12:00:00.000Z") });
    return { store, records, leases, service, calls, oldContent, liveContent,
        bundle, imageRecovery };
}

test("empty reset history keeps the baseline head and current identity", async () => {
    const f = await fixture();
    const revisions = await f.records.read("revisions");
    await f.records.writeIfVersion("revisions", { entries: [], nextNumber: 1 },
        revisions.etag);
    const live = await f.records.read("confirmedLive");
    await f.records.writeIfVersion("confirmedLive", { ...live.data,
        commit: BASE, revisionId: BASE }, live.etag);
    const list = await f.service.list();
    assert.equal(list.head, CMS_BASELINE_REVISION_ID);
    assert.equal(list.baseline.current, true);
    assert.deepEqual(list.revisions, []);
    assert.equal(list.nextPage, null);
    await assert.rejects(f.service.list({ head: OLD }),
        { code: "REVISION_HISTORY_CHANGED" });
});

test("history paginates twenty rows and view uses host descriptions", async () => {
    const f = await fixture();
    const revisions = await f.records.read("revisions");
    const entries = Array.from({ length: 21 }, (_, index) => {
        const id = index === 0 ? LIVE : String(index).padStart(40, "0");
        return { ...revisions.data.entries[0], id, commit: id,
            number: 21 - index };
    });
    await f.records.writeIfVersion("revisions", { entries, nextNumber: 22 },
        revisions.etag);
    const first = await f.service.list({ highlightedRevision: entries[20].id });
    assert.equal(first.revisions.length, 20);
    assert.equal(first.revisions[0].current, true);
    assert.equal(first.nextPage, 2);
    assert.equal(first.highlighted.id, entries[20].id);
    assert.equal((await f.service.list({ page: 2, head: first.head })).revisions.length, 1);
    await assert.rejects(f.service.list({ page: 0 }), { code: "INVALID_PAGE" });
    const viewed = await f.service.view(entries[20].id);
    assert.equal(viewed.revision.values["home.hero.heading"], "Earlier");
    assert.equal(viewed.revision.fieldLabels["home.hero.heading"], "Hero: Heading");
    assert.equal(viewed.draftVersion, null);
    assert.equal(Object.hasOwn(viewed.revision, "legal"), false);
});

test("host descriptions cannot overwrite package-owned revision identity", async () => {
    const f = await fixture();
    const policy = historyPolicy();
    policy.describeRevision = () => ({ values: {}, fieldLabels: {},
        id: "forged", current: true, baseline: true });
    const service = createCmsRevisionService({ records: f.records,
        bundle: f.bundle, historyPolicy: policy,
        imageRecovery: f.imageRecovery, leases: f.leases });
    const viewed = await service.view(OLD);
    assert.equal(viewed.revision.id, OLD);
    assert.equal(viewed.revision.current, false);
    assert.equal(viewed.revision.baseline, false);
});

test("Restore stages an exact historical image and writes only a draft", async () => {
    const f = await fixture({ image: true });
    const beforeLive = await f.records.read("confirmedLive");
    const beforeHistory = await f.records.read("revisions");
    const restored = await f.service.restore({ id: OLD, expectedDraftVersion: null,
        actor });
    assert.equal(restored.draft.home.hero.heading, "Earlier");
    assert.equal(restored.draft.home.footer.text, "Current footer");
    assert.deepEqual(f.calls, [{ path: `public${IMAGE}`, commit: OLD }]);
    const draft = await f.records.read("draft");
    assert.equal(draft.data.note, "");
    assert.equal(draft.data.restoredFrom, OLD);
    assert.equal(draft.data.baseRevision, LIVE);
    assert.equal(draft.data.hasUnpublishedChanges, true);
    assert.deepEqual(draft.data.sections.map(({ sectionPath }) => sectionPath),
        ["home.hero"]);
    assert.deepEqual(await f.records.read("confirmedLive"), beforeLive);
    assert.deepEqual(await f.records.read("revisions"), beforeHistory);
});

test("stale version and current revision reject before staging", async () => {
    const f = await fixture({ image: true });
    await assert.rejects(f.service.restore({ id: OLD,
        expectedDraftVersion: "stale", actor }), { code: "DRAFT_CONFLICT" });
    const live = await f.records.read("confirmedLive");
    await f.records.writeIfVersion("confirmedLive", { ...live.data,
        commit: OLD, revisionId: OLD }, live.etag);
    await assert.rejects(f.service.restore({ id: OLD,
        expectedDraftVersion: null, actor }), { code: "REVISION_ALREADY_CURRENT" });
    assert.deepEqual(f.calls, []);
    assert.equal(await f.records.read("draft"), null);
});

test("no-legal host rejects legal fields in durable roots before Restore", async () => {
    for (const name of ["baseline", "revisions", "confirmedLive", "draft"]) {
        const f = await fixture({ image: true });
        const current = await f.records.read(name);
        const data = name === "revisions" ? { ...current.data,
            entries: [current.data.entries[0], { ...current.data.entries[0],
                id: BASE, legal: {} }] } :
            { ...(current?.data ?? { content: f.liveContent }), legal: {} };
        await f.records.writeIfVersion(name, data, current?.etag ?? null);
        if (name !== "draft") {
            await assert.rejects(f.service.list(), { code: "CMS_STATE_CONFLICT" });
        }
        await assert.rejects(f.service.restore({ id: OLD,
            expectedDraftVersion: name === "draft"
                ? (await f.records.read("draft")).etag : null, actor }),
        { code: "CMS_STATE_CONFLICT" });
        assert.deepEqual(f.calls, []);
        if (name !== "draft") assert.equal(await f.records.read("draft"), null);
    }
});

test("draft CAS failure rolls back only the image staged by Restore", async () => {
    const f = await fixture({ image: true });
    f.store.failDraft = 1;
    await assert.rejects(f.service.restore({ id: OLD,
        expectedDraftVersion: null, actor }), { code: "DRAFT_CONFLICT" });
    assert.equal(await f.store.getMetadata(stagedCmsImageKey(IMAGE)), null);
    assert.equal(await f.records.read("draft"), null);
});

test("failed rollback reports incomplete cleanup and keeps PUBLIC records", async () => {
    const f = await fixture({ image: true });
    const beforeLive = await f.records.read("confirmedLive");
    const beforeHistory = await f.records.read("revisions");
    f.store.failDraft = 1;
    const service = createCmsRevisionService({ records: f.records,
        bundle: f.bundle, historyPolicy: historyPolicy(), leases: f.leases,
        imageRecovery: { async recover() {
            return async () => { throw new Error("delete unavailable"); };
        } } });
    await assert.rejects(service.restore({ id: OLD,
        expectedDraftVersion: null, actor }), (error) =>
        error.code === "RESTORE_CLEANUP_FAILED" &&
        error.details?.originalCode === "DRAFT_CONFLICT" &&
        error.details?.count === 1);
    assert.equal(await f.records.read("draft"), null);
    assert.deepEqual(await f.records.read("confirmedLive"), beforeLive);
    assert.deepEqual(await f.records.read("revisions"), beforeHistory);
});

test("lease loss after staging reports incomplete Restore cleanup", async () => {
    const f = await fixture({ image: true });
    let renewals = 0;
    let undoCalls = 0;
    const leases = { ...f.leases, async renew(...args) {
        renewals += 1;
        if (renewals >= 3) {
            throw Object.assign(new Error("lease lost"),
                { code: "CMS_STATE_LOCKED" });
        }
        return f.leases.renew(...args);
    } };
    const service = createCmsRevisionService({ records: f.records,
        bundle: f.bundle, historyPolicy: historyPolicy(), leases,
        imageRecovery: { async recover() {
            return async () => { undoCalls += 1; };
        } } });
    await assert.rejects(service.restore({ id: OLD,
        expectedDraftVersion: null, actor }), (error) =>
        error.code === "RESTORE_CLEANUP_FAILED" &&
        error.details?.originalCode === "CMS_STATE_LOCKED" &&
        error.details?.count === 1);
    assert.equal(undoCalls, 0);
    assert.equal(await f.records.read("draft"), null);
});

test("a competing lease holder stops Restore before recovery or draft writes", async () => {
    const f = await fixture({ image: true });
    const held = await f.leases.acquire({ kind: "mutation", owner: "other" });
    await assert.rejects(f.service.restore({ id: OLD,
        expectedDraftVersion: null, actor }), { code: "CMS_STATE_LOCKED" });
    assert.deepEqual(f.calls, []);
    assert.equal(await f.records.read("draft"), null);
    assert.equal(await f.leases.release(held), true);
});

test("a live change before lease acquisition stops Restore without staging", async () => {
    const f = await fixture({ image: true });
    const leases = { ...f.leases, acquire: async (...args) => {
        const live = await f.records.read("confirmedLive");
        await f.records.writeIfVersion("confirmedLive", { ...live.data,
            commit: BASE, revisionId: BASE }, live.etag);
        return f.leases.acquire(...args);
    } };
    const service = createCmsRevisionService({ records: f.records,
        bundle: f.bundle, historyPolicy: historyPolicy(),
        imageRecovery: f.imageRecovery, leases });
    await assert.rejects(service.restore({ id: OLD,
        expectedDraftVersion: null, actor }), { code: "CMS_STATE_CONFLICT" });
    assert.deepEqual(f.calls, []);
});

test("legal Restore composes the historical pair and omits legal for no-legal hosts", async () => {
    const f = await createLegalState();
    const document = syntheticDocx("Privacy Policy", "Earlier wording.");
    const pdf = syntheticPdf("Privacy Policy Earlier wording.");
    const stagedDoc = await f.service.stage({ page: "privacy", kind: "document",
        file: new File([document], "earlier.docx") }, actor);
    const stagedPdf = await f.service.stage({ page: "privacy", kind: "pdf",
        file: new File([pdf], "earlier.pdf") }, actor);
    const pair = await f.service.composePair("privacy", stagedDoc.hash, stagedPdf.hash);
    for (const [kind, hash] of [["document", stagedDoc.hash], ["pdf", stagedPdf.hash]]) {
        const key = f.capability.stagedKey("privacy", kind, hash);
        await f.store.delete(key);
        await f.store.delete(`${key}/metadata`);
    }
    const historicalLegal = { ...f.service.initialPairs(), privacy: pair };
    await f.records.writeIfVersion("revisions", { nextNumber: 2, entries: [{
        id: OLD, number: 1, title: "Earlier legal", date: "2026-10-01",
        commit: OLD, content: { home: { hero: { heading: "Earlier" } } },
        legal: historicalLegal }] }, (await f.records.read("revisions")).etag);
    const live = await f.records.read("confirmedLive");
    await f.records.writeIfVersion("confirmedLive", { ...live.data,
        content: { home: { hero: { heading: "Current" },
            footer: { text: "Current footer" } } }, revisionId: LIVE,
        commit: LIVE }, live.etag);
    const sourcePath = f.capability.sourcePath("privacy", pair.document);
    const pdfPath = f.capability.requirePage("privacy").pdfPath;
    const calls = [];
    const github = { async readFileAtCommit(path, commit) {
        calls.push({ path, commit });
        assert.equal(commit, OLD);
        return path === sourcePath ? document : path === pdfPath ? pdf : null;
    } };
    const legalRecovery = createCmsHistoricalLegalRecovery({ capability: f.capability,
        service: f.service, store: f.store, github,
        now: () => new Date("2026-11-04T12:00:00.000Z") });
    const service = createCmsRevisionService({ records: f.records,
        bundle: f.capability.assetBundle, historyPolicy: historyPolicy(),
        legalService: f.service, legalRecovery,
        imageRecovery: { async recover() { assert.fail("No historical image"); } },
        leases: f.leases, now: () => new Date("2026-11-04T12:00:00.000Z") });
    const viewed = await service.view(OLD);
    assert.equal(viewed.revision.legal.privacy.document.hash, stagedDoc.hash);
    assert.equal(viewed.revision.values["legal.privacy.document"], "earlier.docx");
    const restored = await service.restore({ id: OLD,
        expectedDraftVersion: null, actor });
    assert.equal(restored.draft.home.hero.heading, "Earlier");
    assert.deepEqual((await f.records.read("draft")).data.legal, historicalLegal);
    assert.deepEqual(calls, [{ path: sourcePath, commit: OLD },
        { path: pdfPath, commit: OLD }]);
});
