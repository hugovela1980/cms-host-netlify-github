import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { createHash } from "node:crypto";

import { createCmsHostPolicyBundle, createCmsJsonRecordStore,
    createCmsLeaseManager, createCmsLegalCapability, createCmsLegalService,
    createCmsPublicationService, PUBLICATION_TIMEOUT_MS } from
    "../src/server/index.js";
import { syntheticDocx, syntheticLegalConfig, syntheticPdf } from
    "./fixtures/legal.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const PARENT = "c".repeat(40);
const TREE = "d".repeat(40);
const IMAGE = "/images/home/cms-published.png";
const actor = { email: "editor@example.test" };
const imageField = { sectionPath: "home.hero", schemaId: "hero",
    fieldKey: "image.src", destinationDirectory: "public/images/home",
    publicPathPrefix: "/images/home/" };

class Store {
    entries = new Map();
    sequence = 0;
    failDraft = 0;
    async getWithMetadata(key) { return structuredClone(this.entries.get(key) ?? null); }
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
}

async function fixture({ legal = false, includeImage = true } = {}) {
    const store = new Store();
    let currentTime = new Date("2026-11-04T12:00:00.000Z");
    const now = () => currentTime;
    const bundle = legal ? null : createCmsHostPolicyBundle({
        contentPolicy: {
            classifyPublic(raw) { return { kind: "current", content: raw }; },
            normalizePersisted(raw) { return structuredClone(raw); },
            validateCurrent(raw) { if (!raw?.home?.hero?.heading) throw new TypeError("heading");
                return raw; },
            historicalManagedAssetReferences() { return new Set(); },
        }, managedImages: [imageField],
    });
    const capability = legal ? await createCmsLegalCapability(
        syntheticLegalConfig({ managedImages: [imageField] })) : null;
    const activeBundle = capability?.assetBundle ?? bundle;
    const records = createCmsJsonRecordStore({ store, keys: {
        draft: "state/draft", confirmedLive: "state/live",
        baseline: "state/baseline", publication: "state/publication",
        revisions: "state/revisions", coordination: "state/coordination",
    } });
    const leases = createCmsLeaseManager({ records, now,
        createOwner: () => "synthetic-owner" });
    const legalService = capability ? createCmsLegalService({ capability, store,
        records, leases, now }) : undefined;
    const liveContent = { home: { hero: { heading: "Initial" } } };
    const draftContent = { home: { hero: { heading: "Published change",
        ...(includeImage ? { image: { src: IMAGE } } : {}) } } };
    const originals = legalService?.initialPairs();
    await records.writeIfVersion("confirmedLive", { content: liveContent,
        ...(originals ? { legal: originals } : {}), revisionId: OLD,
        commit: OLD, assets: [] }, null);
    await records.writeIfVersion("baseline", { content: liveContent,
        ...(originals ? { legal: originals } : {}),
        revisionId: "developer-baseline", sourceCommit: OLD, commit: OLD,
        assets: [] }, null);
    let draftLegal = originals;
    if (legalService) {
        const document = await legalService.stage({ page: "privacy", kind: "document",
            file: new File([syntheticDocx("Privacy Policy", "Published wording.")],
                "changed.docx") }, actor);
        const pdf = await legalService.stage({ page: "privacy", kind: "pdf",
            file: new File([syntheticPdf("Privacy Policy Published wording.")],
                "changed.pdf") }, actor);
        draftLegal = { ...originals, privacy: await legalService.composePair("privacy",
            document.hash, pdf.hash) };
    }
    const saved = await records.writeIfVersion("draft", { content: draftContent,
        ...(draftLegal ? { legal: draftLegal } : {}), baseRevision: OLD,
        hasUnpublishedChanges: true, note: "", cleanupCandidates: [] }, null);
    const fileCalls = [];
    let createError = null;
    let marker = null;
    let deployState = { state: "pending", deploy: null };
    const github = { async createCommit(request) {
        fileCalls.push(request);
        if (createError) throw createError;
        return { commitSha: NEW, parentSha: PARENT, treeSha: TREE };
    }, async findPublicationCommit() { return marker; } };
    const netlify = { async findExactProductionDeploy(sha) {
        assert.equal(sha, NEW);
        return deployState;
    } };
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;
    const images = { async readStaged(path) {
        assert.equal(path, IMAGE);
        return { data: imageBytes, contentType: "image/png" };
    } };
    const cleanupCalls = [];
    let cleanupError = null;
    const cleanup = { async cleanupCandidates(candidates, options) {
        cleanupCalls.push(candidates);
        await options.ensureActive();
        if (cleanupError) throw cleanupError;
        return [];
    } };
    const service = createCmsPublicationService({ records, github, netlify,
        bundle: activeBundle, pages: [{ contentKey: "home",
            contentFile: "content/home.yaml" }], images, legalService,
        cleanup, leases, now, createId: () => "publication-id",
        summarizeChanges: () => [{ label: "Hero", page: "home",
            pageLabel: "Home" }] });
    return { store, records, leases, service, capability, legalService,
        github, images,
        liveContent, draftContent, draftLegal, saved, fileCalls, cleanupCalls,
        setTime(value) { currentTime = new Date(value); },
        setCreateError(value) { createError = value; },
        setCleanupError(value) { cleanupError = value; },
        setMarker(value) { marker = value; },
        setDeployState(value) { deployState = value; } };
}

function exactDeploy() {
    return { state: "confirmed", deploy: { id: "deploy-new", state: "ready",
        commit_ref: NEW, published_at: "2026-11-04T12:02:00.000Z",
        ssl_url: "https://example.test", site_id: "synthetic-site" } };
}

test("one content/image commit confirms only after exact READY and appends revision one", async () => {
    const f = await fixture();
    const baseline = await f.records.read("baseline");
    const started = await f.service.start({ expectedDraftVersion: f.saved.etag,
        actor });
    assert.equal(started.status, "deploying");
    assert.equal(f.fileCalls.length, 1);
    assert.deepEqual(f.fileCalls[0].files.map(({ path }) => path), [
        "content/home.yaml", `public${IMAGE}`,
    ]);
    assert.deepEqual(YAML.parse(Buffer.from(f.fileCalls[0].files[0].base64,
        "base64").toString("utf8")), f.draftContent.home);
    assert.equal((await f.records.read("revisions")), null);
    assert.equal((await f.service.refresh()).status, "deploying");
    f.setDeployState(exactDeploy());
    const confirmed = await f.service.refresh();
    assert.equal(confirmed.status, "confirmed");
    assert.equal((await f.records.read("confirmedLive")).data.revisionId, NEW);
    assert.equal((await f.records.read("draft")).data.hasUnpublishedChanges, false);
    const revisions = await f.records.read("revisions");
    assert.equal(revisions.data.nextNumber, 2);
    assert.equal(revisions.data.entries[0].number, 1);
    assert.equal((await f.service.refresh()).status, "confirmed");
    assert.equal((await f.records.read("revisions")).etag, revisions.etag);
    assert.deepEqual(await f.records.read("baseline"), baseline);
    assert.equal(f.cleanupCalls.length, 1);
});

test("stale draft and base reject before Git and durable committing", async () => {
    const f = await fixture();
    await assert.rejects(f.service.start({ expectedDraftVersion: "stale",
        actor }), { code: "DRAFT_CONFLICT" });
    const draft = await f.records.read("draft");
    await f.records.writeIfVersion("draft", { ...draft.data,
        baseRevision: PARENT }, draft.etag);
    await assert.rejects(f.service.start({ expectedDraftVersion:
        (await f.records.read("draft")).etag, actor }),
    { code: "DRAFT_BASE_STALE" });
    assert.equal(f.fileCalls.length, 0);
    assert.equal(await f.records.read("publication"), null);
});

test("a new image already at the exact live commit is verified before serialization", async () => {
    const f = await fixture();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`)
        .update(bytes).digest("hex");
    f.images.readStaged = async () => {
        throw Object.assign(new Error("normal miss"), { code: "IMAGE_NOT_FOUND" });
    };
    f.github.readFileAtCommit = async (path, commit) => {
        assert.equal(path, `public${IMAGE}`);
        assert.equal(commit, OLD);
        return bytes;
    };
    f.github.readManagedAssetBlobIdentitiesAtCommit = async () =>
        new Map([[`public${IMAGE}`, { sha, size: bytes.length }]]);
    await f.service.start({ expectedDraftVersion: f.saved.etag, actor });
    assert.equal(f.fileCalls[0].files.find(({ path }) => path === `public${IMAGE}`)
        .base64, bytes.toString("base64"));
});

test("ambiguous Git result recovers by marker without a second commit", async () => {
    const f = await fixture();
    f.setCreateError(new Error("response lost"));
    await assert.rejects(f.service.start({ expectedDraftVersion: f.saved.etag,
        actor }), { code: "PUBLICATION_COMMIT_UNCERTAIN" });
    assert.equal((await f.records.read("publication")).data.status, "committing");
    f.setMarker({ commitSha: NEW, parentSha: PARENT, treeSha: TREE });
    assert.equal((await f.service.refresh()).status, "deploying");
    assert.equal(f.fileCalls.length, 1);
    await assert.rejects(f.service.start({ expectedDraftVersion: f.saved.etag,
        actor }), { code: "PUBLICATION_ALREADY_ACTIVE" });
});

test("status polling cannot take an active start request's lease", async () => {
    const f = await fixture({ includeImage: false });
    let entered;
    const atCommit = new Promise((resolve) => { entered = resolve; });
    let complete;
    const commitFinished = new Promise((resolve) => { complete = resolve; });
    f.github.createCommit = async () => {
        entered();
        await commitFinished;
        return { commitSha: NEW, parentSha: PARENT, treeSha: TREE };
    };
    const starting = f.service.start({ expectedDraftVersion: f.saved.etag,
        actor });
    await atCommit;
    assert.equal((await f.service.refresh()).status, "committing");
    complete();
    assert.equal((await starting).status, "deploying");
    f.setDeployState(exactDeploy());
    assert.equal((await f.service.refresh()).status, "confirmed");
});

test("expired committing lease is reacquired before uncertain status blocks another start", async () => {
    const f = await fixture();
    f.setCreateError(new Error("unknown commit result"));
    await assert.rejects(f.service.start({ expectedDraftVersion: f.saved.etag,
        actor }), { code: "PUBLICATION_COMMIT_UNCERTAIN" });
    f.setTime(new Date(Date.parse("2026-11-04T12:00:00.000Z") +
        PUBLICATION_TIMEOUT_MS + 120_000));
    const status = await f.service.refresh();
    assert.equal(status.status, "uncertain");
    assert.equal(status.errorCode, "PUBLICATION_COMMIT_RECOVERY_TIMEOUT");
    await assert.rejects(f.service.start({ expectedDraftVersion: f.saved.etag,
        actor }), { code: "PUBLICATION_ALREADY_ACTIVE" });
});

test("partial finalization retries without duplicate revision or newer-draft overwrite", async () => {
    const f = await fixture({ includeImage: false });
    await f.service.start({ expectedDraftVersion: f.saved.etag, actor });
    f.setDeployState(exactDeploy());
    f.store.failDraft = 1;
    await assert.rejects(f.service.refresh(), { code: "DRAFT_CONFLICT" });
    assert.equal((await f.records.read("revisions")).data.nextNumber, 2);
    assert.equal((await f.records.read("confirmedLive")).data.revisionId, NEW);
    assert.equal((await f.records.read("draft")).data.baseRevision, OLD);
    assert.equal((await f.service.refresh()).status, "confirmed");
    assert.equal((await f.records.read("revisions")).data.entries.length, 1);
    const newer = await fixture({ includeImage: false });
    await newer.service.start({ expectedDraftVersion: newer.saved.etag, actor });
    const draft = await newer.records.read("draft");
    await newer.records.writeIfVersion("draft", { ...draft.data,
        note: "Keep newer work" }, draft.etag);
    newer.setDeployState(exactDeploy());
    await newer.service.refresh();
    assert.equal((await newer.records.read("draft")).data.note, "Keep newer work");
    assert.equal((await newer.records.read("draft")).data.hasUnpublishedChanges, true);
});

test("optional legal pair adds exact manifest, rendered, source and PDF files", async () => {
    const f = await fixture({ legal: true, includeImage: false });
    const baseline = await f.records.read("baseline");
    const started = await f.service.start({ expectedDraftVersion: f.saved.etag,
        actor });
    assert.equal(started.status, "deploying");
    const paths = f.fileCalls[0].files.map(({ path }) => path);
    assert.deepEqual(paths.slice(0, 3), ["content/home.yaml",
        f.capability.renderedPath, f.capability.manifestPath]);
    assert.equal(paths.includes(f.capability.sourcePath("privacy",
        f.draftLegal.privacy.document)), true);
    assert.equal(paths.includes(f.capability.requirePage("privacy").pdfPath), true);
    f.setDeployState(exactDeploy());
    await f.service.refresh();
    assert.deepEqual((await f.records.read("confirmedLive")).data.legal,
        f.draftLegal);
    assert.deepEqual((await f.records.read("revisions")).data.entries[0].legal,
        f.draftLegal);
    assert.deepEqual(await f.records.read("baseline"), baseline);
});

test("failed deploy and exact late READY use different terminal outcomes", async () => {
    const failed = await fixture({ includeImage: false });
    await failed.service.start({ expectedDraftVersion: failed.saved.etag, actor });
    failed.setDeployState({ state: "failed", deploy: { id: "deploy-failed",
        state: "error", commit_ref: NEW } });
    const failure = await failed.service.refresh();
    assert.equal(failure.status, "failed");
    assert.equal(failure.errorCode, "PUBLIC_DEPLOYMENT_FAILED");
    assert.equal(await failed.records.read("revisions"), null);
    assert.equal((await failed.records.read("draft")).data.hasUnpublishedChanges, true);
    const late = await fixture({ includeImage: false });
    await late.service.start({ expectedDraftVersion: late.saved.etag, actor });
    late.setTime(new Date(Date.parse("2026-11-04T12:00:00.000Z") +
        PUBLICATION_TIMEOUT_MS + 120_000));
    late.setDeployState(exactDeploy());
    assert.equal((await late.service.refresh()).status, "confirmed");
});

test("cleanup failure cannot undo an exact confirmed deployment", async () => {
    const f = await fixture({ includeImage: false });
    await f.service.start({ expectedDraftVersion: f.saved.etag, actor });
    f.setDeployState(exactDeploy());
    f.setCleanupError(new Error("cleanup unavailable"));
    assert.equal((await f.service.refresh()).status, "confirmed");
    assert.equal((await f.records.read("publication")).data.status, "confirmed");
});

test("refresh cannot finalize while another owner holds the expired lease", async () => {
    const f = await fixture({ includeImage: false });
    await f.service.start({ expectedDraftVersion: f.saved.etag, actor });
    f.setTime("2026-11-04T12:20:00.000Z");
    const other = await f.leases.acquire({ kind: "mutation", owner: "other" });
    f.setDeployState(exactDeploy());
    assert.equal((await f.service.refresh()).status, "deploying");
    assert.equal(await f.records.read("revisions"), null);
    assert.equal((await f.records.read("confirmedLive")).data.revisionId, OLD);
    assert.equal(await f.leases.release(other), true);
    assert.equal((await f.service.refresh()).status, "confirmed");
});

test("changed live base and mismatched exact-deploy result block finalization", async () => {
    const wrongDeploy = await fixture({ includeImage: false });
    await wrongDeploy.service.start({ expectedDraftVersion:
        wrongDeploy.saved.etag, actor });
    wrongDeploy.setDeployState({ state: "confirmed", deploy: {
        ...exactDeploy().deploy, commit_ref: PARENT } });
    await assert.rejects(wrongDeploy.service.refresh(),
        { code: "CMS_STATE_CONFLICT" });
    assert.equal(await wrongDeploy.records.read("revisions"), null);
    const changedLive = await fixture({ includeImage: false });
    await changedLive.service.start({ expectedDraftVersion:
        changedLive.saved.etag, actor });
    const live = await changedLive.records.read("confirmedLive");
    await changedLive.records.writeIfVersion("confirmedLive", {
        ...live.data, revisionId: PARENT, commit: PARENT }, live.etag);
    changedLive.setDeployState(exactDeploy());
    await assert.rejects(changedLive.service.refresh(),
        { code: "CMS_STATE_CONFLICT" });
    assert.equal(await changedLive.records.read("revisions"), null);
});

test("a mismatched legal pair rejects before durable publication or Git", async () => {
    const f = await fixture({ legal: true, includeImage: false });
    const original = f.legalService.initialPairs();
    const draft = await f.records.read("draft");
    const mismatched = { ...f.draftLegal,
        privacy: await f.legalService.composePair("privacy",
            f.draftLegal.privacy.document.hash, original.privacy.pdf.hash) };
    const updated = await f.records.writeIfVersion("draft", { ...draft.data,
        legal: mismatched }, draft.etag);
    await assert.rejects(f.service.start({ expectedDraftVersion: updated.etag,
        actor }), { code: "LEGAL_CONTENT_DIFFERENT" });
    assert.equal(f.fileCalls.length, 0);
    assert.equal(await f.records.read("publication"), null);
});

test("a changed legal source cannot claim to be an original document", async () => {
    const f = await fixture({ legal: true, includeImage: false });
    const draft = await f.records.read("draft");
    const updated = await f.records.writeIfVersion("draft", { ...draft.data,
        legal: { ...draft.data.legal, privacy: {
            ...draft.data.legal.privacy,
            document: { ...draft.data.legal.privacy.document, original: true },
        } } }, draft.etag);
    await assert.rejects(f.service.start({ expectedDraftVersion: updated.etag,
        actor }), { code: "PUBLICATION_FILES_INVALID" });
    assert.equal(f.fileCalls.length, 0);
});
