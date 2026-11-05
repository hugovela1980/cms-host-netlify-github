import assert from "node:assert/strict";

import { createCmsHostPolicyBundle, createCmsJsonRecordStore, createCmsDraftRecordService,
    createCmsDraftStateReader,
    createCmsDraftRevertService,
    createCmsContentDraftSaveService,
    createGitHubPublicationClient, readCmsPublicationConfig,
    createCmsLeaseManager, withCmsMutationLease } from "@hugovela/cms-host-netlify-github/server";
import { createCmsRepositoryContentReader, createCmsFoundationService } from
    "@hugovela/cms-host-netlify-github/server";
import { createCmsManagedImageService, createCmsHistoricalImageRecovery,
    stagedCmsImageKey } from "@hugovela/cms-host-netlify-github/server";
import { createCmsManagedImageCleanup } from "@hugovela/cms-host-netlify-github/server";
import { createCmsLegalCapability, createCmsLegalService } from
    "@hugovela/cms-host-netlify-github/server";
import { createCmsPublicationService } from
    "@hugovela/cms-host-netlify-github/server";
import { createCmsApiClient, createCmsEditorHostRuntime,
    pollPublicationConfirmation } from
    "@hugovela/cms-host-netlify-github/client";
import { createCmsRevisionService } from
    "@hugovela/cms-host-netlify-github/server";

assert.equal(typeof createCmsLegalCapability, "function");
assert.equal(typeof createCmsLegalService, "function");

const heroImage = "/images/home/cms-hero.png";
const legalPdf = "public/downloads/legal/Example_Privacy.pdf";
const contentPolicy = {
    classifyPublic(raw) {
        return { kind: raw.home?.hero ? "current" : "legacy", content: raw };
    },
    normalizePersisted(raw, fallback) {
        const content = structuredClone(raw);
        content.home ??= {};
        content.home.hero ??= structuredClone(fallback.home.hero);
        return content;
    },
    validateCurrent(content) {
        if (!content.home?.hero?.heading) throw new TypeError("Missing hero heading.");
        return content;
    },
    historicalManagedAssetReferences(content) {
        return new Set(content.retiredImage ? [content.retiredImage] : []);
    },
};
const managedImages = [{
    sectionPath: "home.hero", schemaId: "example-hero", fieldKey: "image.src",
    destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/",
}];
const canonical = { home: { hero: { heading: "Example site", image: { src: heroImage } } } };
const raw = { home: {}, retiredImage: "/images/legacy/cms-old.png" };
const withoutLegal = createCmsHostPolicyBundle({ contentPolicy, managedImages });
const withLegal = createCmsHostPolicyBundle({ contentPolicy, managedImages,
    legal: { pdfPaths: [legalPdf] } });

const publicContent = withoutLegal.content.readPublic(raw, canonical);
assert.equal(publicContent.kind, "legacy");
assert.strictEqual(publicContent.rawContent, raw);
assert.equal(publicContent.workingContent.home.hero.heading, "Example site");
assert.equal(withoutLegal.assets.isFieldImagePath(managedImages[0], heroImage), true);
assert.equal(withoutLegal.assets.repositoryPathsForContent(canonical).has(`public${heroImage}`), true);
assert.equal(withoutLegal.assets.repositoryPathsForContent(canonical).has(legalPdf), false);
assert.equal(withLegal.assets.repositoryPathsForContent(canonical).has(legalPdf), true);
assert.equal(withoutLegal.legalAssetsEnabled, false);
assert.equal(withLegal.legalAssetsEnabled, true);

const stored = new Map();
let version = 0;
const fakeBlobStore = {
    async getMetadata(key, options) {
        assert.deepEqual(options, { consistency: "strong" });
        return stored.get(key) ?? null;
    },
    async getWithMetadata(key, options) {
        assert.deepEqual(options, { type: "json", consistency: "strong" });
        return stored.get(key) ?? null;
    },
    async setJSON(key, data, options) {
        const current = stored.get(key);
        if (options.onlyIfNew && current) return { modified: false };
        if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
            return { modified: false };
        }
        const etag = `example-${++version}`;
        stored.set(key, { data: structuredClone(data), etag, metadata: {} });
        return { modified: true, etag };
    },
};
const records = createCmsJsonRecordStore({ store: fakeBlobStore,
    keys: { draft: "state/draft", confirmedLive: "state/confirmed-live",
        publication: "state/publication", coordination: "state/coordination" } });
const leases = createCmsLeaseManager({ records,
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    createOwner: () => "example-operation" });
const draftAssetProof = { store: fakeBlobStore, assets: withoutLegal.assets,
    github: { async readManagedAssetBlobIdentitiesAtCommit() {
        throw new Error("No deployed image lookup is expected in this example.");
    } } };
assert.equal(await records.read("draft"), null);
assert.deepEqual(await records.writeIfVersion("draft", { content: canonical,
    hasUnpublishedChanges: false }, null),
    { modified: true, etag: "example-1" });
assert.deepEqual(await records.writeIfVersion("draft", raw, "stale"),
    { modified: false });
assert.deepEqual((await records.read("draft")).data.content, canonical);

const drafts = createCmsDraftRecordService({ records, content: withoutLegal.content,
    leases, ...draftAssetProof });
const clean = await drafts.read({ fallbackContent: canonical });
assert.equal(clean.draftVersion, "example-1");
assert.equal(clean.hasSavedDraft, false);
assert.deepEqual(clean.workingContent, canonical);
const prepared = { content: { home: { hero: { heading: "Edited example" } } },
    note: "Review", hasUnpublishedChanges: true };
const preparedWrite = await drafts.writePrepared({ record: prepared,
    expectedDraftVersion: clean.draftVersion });
assert.match(preparedWrite.draftVersion, /^example-\d+$/);
assert.notEqual(preparedWrite.draftVersion, clean.draftVersion);
assert.deepEqual((await records.read("draft")).data, prepared);
assert.equal((await drafts.read({ fallbackContent: canonical })).workingContent.home.hero.heading,
    "Edited example");

await records.writeIfVersion("confirmedLive", { content: canonical,
    revisionId: "example-live" }, null);
const stateReader = createCmsDraftStateReader({ records, content: withoutLegal.content });
const state = await stateReader.read({ confirmedFallbackContent: canonical });
assert.equal(state.draft.home.hero.heading, "Edited example");
assert.equal(state.draftVersion, preparedWrite.draftVersion);
assert.equal(state.confirmedRevision, "example-live");
assert.equal(Object.hasOwn(state, "legal"), false);
const legalReader = createCmsDraftStateReader({ records, content: withLegal.content,
    legalFromRecord: (record) => ({ privacy: record?.legal?.privacy ?? { pdf: legalPdf } }) });
assert.deepEqual((await legalReader.read({ confirmedFallbackContent: canonical })).legal,
    { privacy: { pdf: legalPdf } });

const revert = createCmsDraftRevertService({ records, content: withoutLegal.content, leases,
    validateNote: (value) => String(value ?? "").trim(),
    now: () => new Date("2026-11-04T12:00:00.000Z") });
const reverted = await revert.revert({ request: { expectedDraftVersion: state.draftVersion },
    actor: { email: "editor@example.com" }, confirmedFallbackContent: canonical });
assert.match(reverted.draftVersion, /^example-\d+$/);
assert.notEqual(reverted.draftVersion, state.draftVersion);
assert.equal(reverted.hasSavedDraft, false);
assert.deepEqual(reverted.draft, canonical);
assert.equal(Object.hasOwn(reverted.metadata, "legal"), false);
assert.equal((await records.read("draft")).data.hasUnpublishedChanges, false);

const saveContent = createCmsContentDraftSaveService({ records, content: withoutLegal.content,
    leases, ...draftAssetProof,
    applyContentChanges(source, changes) {
        const next = structuredClone(source);
        for (const change of changes) {
            if (change.path !== "home.hero.heading") throw new TypeError("Unknown example field.");
            next.home.hero.heading = change.value;
        }
        return next;
    },
    deriveSections: () => [{ sectionPath: "home.hero", schemaId: "example-hero" }],
    validateNote: (value) => String(value ?? "").trim(),
    validateCleanupCandidates: (value) => value ?? [],
    now: () => new Date("2026-11-04T12:00:00.000Z") });
const savedContent = await saveContent.save({ request: {
    expectedDraftVersion: reverted.draftVersion,
    changes: [{ path: "home.hero.heading", value: "Saved through package" }],
    saveData: { note: "Example change" },
}, actor: { email: "editor@example.com" }, confirmedFallbackContent: canonical });
assert.match(savedContent.draftVersion, /^example-\d+$/);
assert.notEqual(savedContent.draftVersion, reverted.draftVersion);
assert.equal((await stateReader.read({ confirmedFallbackContent: canonical })).draft.home.hero.heading,
    "Saved through package");
const revertedAgain = await revert.revert({ request: {
    expectedDraftVersion: savedContent.draftVersion },
actor: { email: "editor@example.com" }, confirmedFallbackContent: canonical });
assert.match(revertedAgain.draftVersion, /^example-\d+$/);
assert.notEqual(revertedAgain.draftVersion, savedContent.draftVersion);
assert.deepEqual(revertedAgain.draft, canonical);

const publicationConfig = readCmsPublicationConfig({
    GITHUB_REPOSITORY_TOKEN: "fake-github-token",
    GITHUB_REPOSITORY_OWNER: "example-owner",
    GITHUB_REPOSITORY_NAME: "example-site",
    GITHUB_REPOSITORY_BRANCH: "main",
    NETLIFY_API_TOKEN: "fake-netlify-token",
    NETLIFY_PUBLIC_SITE_ID: "example-public-site",
});
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);
let githubCalls = 0;
const github = createGitHubPublicationClient(publicationConfig, {
    assetIdentity: withoutLegal.assets,
    async fetchObject(url) {
        githubCalls += 1;
        const body = url.includes("/git/commits/")
            ? { sha: commitSha, tree: { sha: treeSha } }
            : { sha: treeSha, truncated: false, tree: [
                { path: `public${heroImage}`, type: "blob", mode: "100644",
                    sha: blobSha, size: 25 },
            ] };
        return new Response(JSON.stringify(body), { status: 200 });
    },
});
assert.deepEqual(await github.readManagedAssetBlobIdentitiesAtCommit(
    [`public${heroImage}`], commitSha, { content: canonical }),
new Map([[`public${heroImage}`, { sha: blobSha, size: 25 }]]));
const beforeRejectedPath = githubCalls;
await assert.rejects(github.readManagedAssetBlobIdentitiesAtCommit(
    ["public/images/home/developer-owned.png"], commitSha, { content: canonical }),
(error) => error.code === "MANAGED_ASSET_IDENTITY_UNAVAILABLE");
assert.equal(githubCalls, beforeRejectedPath);

const lease = await leases.acquire({ kind: "mutation" });
assert.equal(lease.owner, "example-operation");
assert.equal(await leases.release(lease), true);
assert.equal(await withCmsMutationLease(leases, async (ensureActive) => {
    await ensureActive();
    return "saved";
}, { ttlMs: 90, renewEveryMs: 20, schedule: () => () => {} }), "saved");

const foundationRecords = createCmsJsonRecordStore({ store: fakeBlobStore,
    keys: { draft: "neutral/draft", confirmedLive: "neutral/live",
        baseline: "neutral/baseline", publication: "neutral/publication",
        revisions: "neutral/revisions",
        coordination: "neutral/coordination" } });
const foundationGitHub = {
    async readFileAtCommit(path, sha, { allowMissing }) {
        assert.equal(path, "content/home.yaml");
        assert.equal(sha, commitSha);
        assert.equal(allowMissing, false);
        return Buffer.from(`hero:\n  heading: Example site\n  image:\n    src: ${heroImage}\n`);
    },
    async readManagedAssetBlobIdentitiesAtCommit() {
        throw new Error("Initial capture does not need an asset identity comparison.");
    },
};
const foundationReader = createCmsRepositoryContentReader({ github: foundationGitHub,
    pages: [{ contentKey: "home", contentFile: "content/home.yaml", allowMissing: false }],
    content: withoutLegal.content });
const foundationLeases = createCmsLeaseManager({ records: foundationRecords,
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    createOwner: () => "neutral-foundation" });
const foundation = createCmsFoundationService({ records: foundationRecords,
    reader: foundationReader, github: foundationGitHub,
    netlify: { async findLatestReadyProductionDeploy() {
        return { id: "neutral-ready", commit_ref: commitSha,
            published_at: "2026-11-04T12:00:00.000Z" };
    } }, bundle: withoutLegal,
    leases: foundationLeases,
    now: () => new Date("2026-11-04T12:00:00.000Z") });
const captured = await foundation.ensure({ canonicalContent: canonical });
assert.deepEqual(captured.live.data.content, canonical);
assert.equal(captured.baseline.data.revisionId, "developer-baseline");
assert.equal((await foundation.ensure({ canonicalContent: canonical })).baseline.etag,
    captured.baseline.etag);

const imageBlobs = new Map();
let imageVersion = 0;
const imageStore = {
    async set(key, data, options) {
        if (options.onlyIfNew && imageBlobs.has(key)) return { modified: false };
        const etag = `image-${++imageVersion}`;
        imageBlobs.set(key, { data: data.slice(0), metadata: options.metadata, etag });
        return { modified: true, etag };
    },
    async getWithMetadata(key) { return imageBlobs.get(key) ?? null; },
    async getMetadata(key) {
        const item = imageBlobs.get(key);
        return item ? { etag: item.etag, metadata: item.metadata } : null;
    },
    async delete(key) { imageBlobs.delete(key); },
    async *list({ prefix, paginate }) {
        assert.equal(prefix, "images/staged/");
        assert.equal(paginate, true);
        yield { blobs: [...imageBlobs].map(([key, entry]) =>
            ({ key, etag: entry.etag })) };
    },
};
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const images = createCmsManagedImageService({ store: imageStore,
    assets: withoutLegal.assets, leases: foundationLeases,
    previewUrlForPath: (path) => `/api/cms/draft-image?path=${encodeURIComponent(path)}`,
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    createId: () => "12345678-1234-1234-1234-123456789abc" });
const uploaded = await images.stage({ sectionPath: "home.hero",
    schemaId: "example-hero", fieldKey: "image.src",
    file: new File([png], "example.png", { type: "image/png" }) },
{ email: "editor@example.com" });
assert.equal((await images.preview(uploaded.src)).status, 200);
assert.equal((await images.preview(heroImage)).status, 307);
const historicalPath = "/images/legacy/cms-historical.png";
const recovery = createCmsHistoricalImageRecovery({ store: imageStore,
    assets: withoutLegal.assets,
    github: { async readFileAtCommit(path, sha) {
        assert.equal(path, `public${historicalPath}`);
        assert.equal(sha, commitSha);
        return Buffer.from(png);
    } } });
const undoHistorical = await recovery.recover({ publicPath: historicalPath,
    snapshot: { content: { retiredImage: historicalPath }, commit: commitSha },
    ensureActive: async () => {} });
assert.equal((await images.preview(historicalPath,
    { contentSnapshot: { retiredImage: historicalPath } })).status, 200);
await undoHistorical();
assert.equal(imageBlobs.has(stagedCmsImageKey(historicalPath)), false);
const cleanup = createCmsManagedImageCleanup({ store: imageStore,
    records: foundationRecords, assets: withoutLegal.assets, leases: foundationLeases,
    now: () => new Date("2026-11-12T12:00:00.000Z") });
assert.deepEqual(await cleanup.cleanupCandidates([uploaded.src],
    { ensureActive: async () => {} }), [uploaded.src]);
const uploadedAgain = await images.stage({ sectionPath: "home.hero",
    schemaId: "example-hero", fieldKey: "image.src",
    file: new File([png], "example.png", { type: "image/png" }) },
{ email: "editor@example.com" });
assert.deepEqual((await cleanup.sweep()).deleted, [uploadedAgain.src]);

const changedContent = structuredClone(canonical);
changedContent.home.hero.heading = "Published neutral example";
const publicationDraft = await foundationRecords.writeIfVersion("draft", {
    content: changedContent, baseRevision: commitSha,
    hasUnpublishedChanges: true, note: "" }, null);
let committedPaths;
foundationGitHub.createCommit = async ({ files }) => {
    committedPaths = files.map(({ path }) => path);
    return { commitSha: "b".repeat(40), parentSha: commitSha,
        treeSha: "c".repeat(40) };
};
foundationGitHub.findPublicationCommit = async () => null;
const publisher = createCmsPublicationService({ records: foundationRecords,
    github: foundationGitHub, bundle: withoutLegal,
    pages: [{ contentKey: "home", contentFile: "content/home.yaml" }],
    images, cleanup, leases: foundationLeases,
    summarizeChanges: () => [{ label: "Hero", page: "home",
        pageLabel: "Home" }],
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    createId: () => "neutral-publication",
    netlify: { async findExactProductionDeploy() { return { state: "confirmed",
        deploy: { id: "neutral-ready-new", state: "ready",
            commit_ref: "b".repeat(40),
            published_at: "2026-11-04T12:02:00.000Z" } }; } },
});
assert.equal((await publisher.start({ expectedDraftVersion: publicationDraft.etag,
    actor: { email: "editor@example.test" } })).status, "deploying");
assert.deepEqual(committedPaths, ["content/home.yaml"]);
assert.equal((await publisher.refresh()).status, "confirmed");
assert.equal(Object.hasOwn((await foundationRecords.read("confirmedLive")).data,
    "legal"), false);

const history = createCmsRevisionService({ records: foundationRecords,
    bundle: withoutLegal, leases: foundationLeases,
    imageRecovery: createCmsHistoricalImageRecovery({ store: imageStore,
        assets: withoutLegal.assets, github: {
            async readFileAtCommit(path, sha) {
                assert.equal(path, `public${heroImage}`);
                assert.equal(sha, commitSha);
                return Buffer.from(png);
            },
        } }),
    historyPolicy: {
        validateHistorical(content) { assert.ok(content.home.hero.heading); },
        restoreContent(content) { return structuredClone(content); },
        describeRevision(content) { return {
            values: { "home.hero.heading": content.home.hero.heading },
            fieldLabels: { "home.hero.heading": "Hero: Heading" },
        }; },
        changedSections() { return [{ sectionPath: "home.hero" }]; },
    }, now: () => new Date("2026-11-04T12:03:00.000Z") });
assert.equal((await history.list()).head, "b".repeat(40));
assert.equal((await history.list()).baseline.current, false);
assert.equal((await history.view("developer-baseline")).revision.values[
    "home.hero.heading"], "Example site");
const currentDraft = await foundationRecords.read("draft");
const restored = await history.restore({ id: "developer-baseline",
    expectedDraftVersion: currentDraft.etag,
    actor: { email: "editor@example.test" } });
assert.equal(restored.draft.home.hero.heading, "Example site");
assert.equal((await foundationRecords.read("draft")).data.restoredFrom,
    "developer-baseline");
assert.equal(Object.hasOwn((await foundationRecords.read("draft")).data,
    "legal"), false);

const browserRequests = [];
const browserApi = createCmsApiClient({ basePath: "/neutral/cms",
    fetchObject: async (path, options) => {
        browserRequests.push({ path, options });
        return new Response(JSON.stringify(path.endsWith("/draft")
            ? { draft: canonical, published: canonical,
                draftVersion: "neutral-v1", hasSavedDraft: true,
                publicationStatus: { status: "idle" } }
            : { draftVersion: "neutral-v2" }));
    } });
assert.equal(Object.hasOwn(browserApi, "uploadLegal"), false);
assert.equal((await browserApi.loadDraft()).draftVersion, "neutral-v1");
assert.equal(browserRequests[0].path, "/neutral/cms/draft");
let hydrated = false;
const browserRuntime = createCmsEditorHostRuntime({ api: browserApi,
    async hydrate(initialDraft) {
        assert.equal(initialDraft.draftVersion, "neutral-v1");
        hydrated = true;
    } });
await browserRuntime.start();
assert.equal(hydrated, true);
assert.equal(browserRuntime.state().ready, true);
assert.equal(browserRuntime.state().canPublish, true);
await browserRuntime.saveChanges({ changes: [], saveData: { draftNote: "Note" } });
assert.equal(browserRuntime.state().draftVersion, "neutral-v2");
assert.deepEqual(browserRuntime.state().legal, {});
let pollIndex = 0;
assert.equal((await pollPublicationConfirmation({
    api: { async publicationStatus() { return { publication: {
        status: pollIndex++ ? "confirmed" : "deploying" } }; } },
    wait: async () => {}, maxPolls: 2,
})).status, "confirmed");

console.log("Neutral host consumer passed.");
