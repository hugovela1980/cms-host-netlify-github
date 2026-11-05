import assert from "node:assert/strict";
import test from "node:test";

import { createCmsDeveloperBaselineService, createCmsHostPolicyBundle,
    createCmsLegalCapability, createCmsPublicLegalVerifier } from "../src/server/index.js";
import { syntheticLegalConfig } from "./fixtures/packed-legal.mjs";

const oldCommit = "a".repeat(40);
const liveCommit = "b".repeat(40);
const content = { home: { heading: "Current example" } };
const time = "2026-11-05T12:00:00.000Z";

async function fixture({ legal = false } = {}) {
    const state = new Map();
    let sequence = 0;
    let writes = 0;
    const records = {
        async read(name) { const entry = state.get(name);
            return entry ? structuredClone(entry) : null; },
        async writeIfVersion(name, data, expected) {
            const prior = state.get(name);
            if (prior?.etag !== expected) return { modified: false };
            const etag = `v${++sequence}`;
            state.set(name, { data: structuredClone(data), etag });
            writes += 1;
            return { modified: true, etag };
        },
    };
    const put = (name, data) => state.set(name, { data: structuredClone(data),
        etag: `${name}-etag` });
    let ready = { id: "example-ready", state: "ready", commit_ref: liveCommit,
        published_at: time };
    let secondReady = null;
    let readyReads = 0;
    let publicContent = structuredClone(content);
    let failRenew = false;
    let failCas = false;
    let renewals = 0;
    const leases = {
        async acquire() { return { etag: "lease-1" }; },
        async renew(lease) { renewals += 1;
            if (failRenew) throw new Error("lease lost");
            return lease; },
        async release() { return true; },
    };
    const originalWrite = records.writeIfVersion;
    records.writeIfVersion = async (name, data, expected) =>
        failCas && name === "baseline" ? { modified: false } :
            originalWrite(name, data, expected);
    const legalConfig = legal ? syntheticLegalConfig() : null;
    const bundle = createCmsHostPolicyBundle({ contentPolicy: {
        classifyPublic(raw) { return { kind: "current", content: raw }; },
        normalizePersisted(raw) { return raw; },
        validateCurrent(raw) {
            if (!raw?.home?.heading) throw new TypeError("Missing home heading.");
            return raw;
        },
        historicalManagedAssetReferences() { return new Set(); },
    }, managedImages: [], ...(legal ? { legal: { pdfPaths: legalConfig.pdfPaths } } : {}) });
    let legalVerifier;
    let pairs;
    if (legal) {
        const { pdfPaths, renderHtml, ...config } = legalConfig;
        const capability = await createCmsLegalCapability({ ...config,
            assetBundle: bundle });
        const github = { async readFileAtCommit() { return null; } };
        legalVerifier = createCmsPublicLegalVerifier({ capability, github });
        pairs = capability.initialPairs();
    }
    put("confirmedLive", { content, ...(legal ? { legal: pairs } : {}),
        revisionId: liveCommit, commit: liveCommit, deployId: ready.id,
        confirmedAt: ready.published_at, assets: [] });
    put("baseline", { content: { home: { heading: "Earlier example" } },
        ...(legal ? { legal: pairs } : {}), revisionId: "developer-baseline",
        sourceCommit: oldCommit, commit: oldCommit, assets: [] });
    put("publication", { status: "confirmed", commitSha: liveCommit });
    put("draft", { content, baseRevision: liveCommit,
        hasUnpublishedChanges: true });
    const service = createCmsDeveloperBaselineService({ records,
        netlify: { async findLatestReadyProductionDeploy() {
            readyReads += 1;
            return structuredClone(readyReads > 1 && secondReady ? secondReady : ready); } },
        reader: { async readAtCommit() { return { kind: "current",
            rawContent: structuredClone(publicContent) }; } },
        canonicalContent: () => structuredClone(content), bundle,
        missingRequiredContent: (raw) => raw?.home?.heading ? [] : ["home.heading"],
        ...(legalVerifier && { legalVerifier }), leases,
        now: () => new Date("2026-11-05T12:05:00.000Z") });
    return { service, state, put, get writes() { return writes; },
        get renewals() { return renewals; },
        setReady(value) { ready = value; },
        setSecondReady(value) { secondReady = value; },
        setPublicContent(value) { publicContent = value; },
        loseLease() { failRenew = true; }, failBaselineCas() { failCas = true; },
        pairs };
}

for (const legal of [false, true]) {
    test(`${legal ? "legal" : "no-legal"} baseline inspection is read-only and explicit promotion writes only baseline`, async () => {
        const sample = await fixture({ legal });
        assert.equal((await sample.service.read()).etag, "baseline-etag");
        const before = await sample.service.inspect();
        assert.deepEqual(before.issues, []);
        assert.equal(before.baselineStatus, "OUTDATED");
        assert.equal(sample.writes, 0);
        const draft = structuredClone(sample.state.get("draft"));
        const publication = structuredClone(sample.state.get("publication"));
        const result = await sample.service.promote({ expectedLiveCommit: liveCommit,
            expectedBaselineVersion: "baseline-etag" });
        assert.equal(result.data.sourceCommit, liveCommit);
        assert.equal(result.data.deployId, "example-ready");
        assert.equal(result.data.capturedAt, "2026-11-05T12:05:00.000Z");
        assert.equal(Object.hasOwn(result.data, "legal"), legal);
        assert.equal(sample.writes, 1);
        assert.ok(sample.renewals > 0);
        assert.deepEqual(sample.state.get("draft"), draft);
        assert.deepEqual(sample.state.get("publication"), publication);
        assert.equal((await sample.service.inspect()).baselineStatus, "CURRENT");
        await assert.rejects(sample.service.promote({ expectedLiveCommit: liveCommit,
            expectedBaselineVersion: result.etag }), { code: "BASELINE_ALREADY_CURRENT" });
    });
}

test("inspection and promotion reject unsafe PUBLIC, content, draft, asset and legal state", async () => {
    const cases = [
        ["PUBLICATION_UNRESOLVED", (sample) => sample.put("publication", { status: "uncertain" })],
        ["CONFIRMED_LIVE_STALE", (sample) => sample.put("confirmedLive", {
            ...sample.state.get("confirmedLive").data, commit: oldCommit })],
        ["CONFIRMED_LIVE_DEPLOY_MISMATCH", (sample) => sample.put("confirmedLive", {
            ...sample.state.get("confirmedLive").data, deployId: "other-deploy" })],
        ["READY_DEPLOY_INVALID", (sample) => sample.setReady({ id: "bad",
            state: "building", commit_ref: liveCommit, published_at: time })],
        ["READY_DEPLOY_INVALID", (sample) => sample.setReady({ id: "bad",
            commit_ref: liveCommit, published_at: time })],
        ["CONFIRMED_LIVE_CONTENT_INCOMPLETE", (sample) => sample.put("confirmedLive", {
            ...sample.state.get("confirmedLive").data, content: { home: {} } })],
        ["CONFIRMED_LIVE_CONTENT_MISMATCH", (sample) => sample.setPublicContent({
            home: { heading: "Different PUBLIC content" } })],
        ["DRAFT_BASE_MISMATCH", (sample) => sample.put("draft", {
            ...sample.state.get("draft").data, baseRevision: oldCommit })],
        ["CONFIRMED_LIVE_ASSETS_INVALID", (sample) => sample.put("confirmedLive", {
            ...sample.state.get("confirmedLive").data, assets: ["/images/unknown.png"] })],
        ["LEGAL_CAPABILITY_REQUIRED", (sample) => sample.put("draft", {
            ...sample.state.get("draft").data, legal: {} })],
        ["LEGAL_CAPABILITY_REQUIRED", (sample) => sample.put("publication", {
            status: "confirmed", draft: { legal: {} } })],
        ["LEGAL_CAPABILITY_REQUIRED", (sample) => sample.put("revisions", {
            entries: [{ id: oldCommit, legal: {} }] })],
    ];
    for (const [code, change] of cases) {
        const sample = await fixture();
        change(sample);
        assert.ok((await sample.service.inspect()).issues.some((item) => item.code === code), code);
        await assert.rejects(sample.service.promote({ expectedLiveCommit: liveCommit,
            expectedBaselineVersion: "baseline-etag" }), (error) =>
            error.code === "BASELINE_CHECKPOINT_UNSAFE" &&
            error.details.issues.some((item) => item.code === code), code);
        assert.equal(sample.writes, 0);
    }
    const legal = await fixture({ legal: true });
    legal.put("confirmedLive", { ...legal.state.get("confirmedLive").data,
        legal: {} });
    assert.ok((await legal.service.inspect()).issues.some((item) =>
        item.code === "CONFIRMED_LIVE_LEGAL_INVALID"));
    await assert.rejects(legal.service.promote({ expectedLiveCommit: liveCommit,
        expectedBaselineVersion: "baseline-etag" }), { code: "BASELINE_CHECKPOINT_UNSAFE" });
    assert.equal(legal.writes, 0);
});

test("stale preflight, lost lease and baseline CAS race cannot promote", async () => {
    const staleCommit = await fixture();
    await assert.rejects(staleCommit.service.promote({ expectedLiveCommit: oldCommit,
        expectedBaselineVersion: "baseline-etag" }), { code: "BASELINE_CHECKPOINT_CHANGED" });
    const staleVersion = await fixture();
    await assert.rejects(staleVersion.service.promote({ expectedLiveCommit: liveCommit,
        expectedBaselineVersion: "stale" }), { code: "BASELINE_CHECKPOINT_CHANGED" });
    const lost = await fixture();
    lost.loseLease();
    await assert.rejects(lost.service.promote({ expectedLiveCommit: liveCommit,
        expectedBaselineVersion: "baseline-etag" }), /lease lost/);
    const race = await fixture();
    race.failBaselineCas();
    await assert.rejects(race.service.promote({ expectedLiveCommit: liveCommit,
        expectedBaselineVersion: "baseline-etag" }), { code: "BASELINE_CHECKPOINT_CHANGED" });
    const staleReady = await fixture();
    staleReady.setSecondReady({ id: "example-ready", state: "building",
        commit_ref: liveCommit, published_at: time });
    await assert.rejects(staleReady.service.promote({ expectedLiveCommit: liveCommit,
        expectedBaselineVersion: "baseline-etag" }), { code: "BASELINE_CHECKPOINT_CHANGED" });
    for (const sample of [staleCommit, staleVersion, lost, race, staleReady]) {
        assert.equal(sample.writes, 0);
    }
});
