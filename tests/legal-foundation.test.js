import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";

import { createCmsFoundationService, createCmsLegalCapability,
    createCmsPublicLegalVerifier, createCmsRepositoryContentReader } from
    "../src/server/index.js";
import { legalHash, parseLegalDocx } from "../src/server/legal/document.js";
import { syntheticDocx, syntheticLegalConfig, syntheticPdf } from "./fixtures/legal.js";

const OLD = "a".repeat(40);
const NEXT = "b".repeat(40);
const NOW = "2026-11-04T12:00:00.000Z";
const canonical = { home: { heading: "Initial" } };

class Records {
    map = new Map();
    sequence = 0;
    reject = new Map();
    async read(name) { return structuredClone(this.map.get(name) ?? null); }
    async writeIfVersion(name, data, expected) {
        if ((this.reject.get(name) ?? 0) > 0) {
            this.reject.set(name, this.reject.get(name) - 1);
            return { modified: false };
        }
        const previous = this.map.get(name);
        if (expected === null ? Boolean(previous) : previous?.etag !== expected) {
            return { modified: false };
        }
        const etag = `etag-${++this.sequence}`;
        this.map.set(name, { etag, data: structuredClone(data) });
        return { modified: true, etag };
    }
    put(name, data) {
        this.map.set(name, { etag: `etag-${++this.sequence}`,
            data: structuredClone(data) });
    }
}

async function fixture({ allowManifestlessOriginals = true,
    managedImage = false, identityChanged = false } = {}) {
    const managedImages = managedImage ? [{ sectionPath: "home", schemaId: "home",
        fieldKey: "image", destinationDirectory: "public/images/home",
        publicPathPrefix: "/images/home/" }] : [];
    const capability = await createCmsLegalCapability({
        ...syntheticLegalConfig({ managedImages }),
        allowManifestlessOriginals });
    const bundle = capability.assetBundle;
    const records = new Records();
    const files = new Map();
    const calls = [];
    let ready = OLD;
    let lookup = 0;
    let lookupOverride;
    const netlify = { async findLatestReadyProductionDeploy() {
        lookup += 1;
        return lookupOverride?.(lookup, ready) ?? { id: `deploy-${ready}`,
            commit_ref: ready, published_at: NOW };
    } };
    const github = {
        async readFileAtCommit(path, sha) {
            calls.push({ path, sha });
            return files.get(`${sha}:${path}`) ?? null;
        },
        async readManagedAssetBlobIdentitiesAtCommit(paths, sha) {
            calls.push({ paths, sha });
            return new Map(paths.map((path) => [path, {
                sha: identityChanged && sha === NEXT ? "changed" : "same", size: 10 }]));
        },
    };
    const reader = createCmsRepositoryContentReader({ github,
        content: bundle.content, pages: [{ contentKey: "home",
            contentFile: "content/home.yaml", allowMissing: false }] });
    const legalVerifier = createCmsPublicLegalVerifier({ capability, github });
    const leases = { async acquire() { return { owner: "foundation" }; },
        async renew(lease) { return lease; }, async release() { return true; } };
    function foundation() {
        return createCmsFoundationService({ records, reader, legalVerifier,
            netlify, github, bundle, leases, now: () => new Date(NOW) });
    }
    function content(sha, value = canonical) {
        files.set(`${sha}:content/home.yaml`, Buffer.from(YAML.stringify(value.home)));
    }
    function changedLegal(sha, wording = "Changed wording.") {
        const source = syntheticDocx("Privacy Policy", wording);
        const pdfBytes = syntheticPdf(`Privacy Policy ${wording}`);
        const document = { ...parseLegalDocx(source,
            { sourceTitles: ["Privacy Policy"] }), hash: legalHash(source),
        name: "changed.docx" };
        const pdf = { hash: legalHash(pdfBytes), name: "changed.pdf" };
        const pair = { document, pdf,
            verification: { status: "matches", explanation: "The document and PDF text match." },
            confirmation: null };
        const legal = { privacy: pair };
        files.set(`${sha}:${capability.manifestPath}`, Buffer.from(JSON.stringify(legal)));
        files.set(`${sha}:${capability.renderedPath}`, Buffer.from(JSON.stringify({
            privacy: { sourceTitle: document.sourceTitle, blocks: document.blocks },
        })));
        files.set(`${sha}:${capability.sourcePath("privacy", document)}`, source);
        files.set(`${sha}:${capability.requirePage("privacy").pdfPath}`, pdfBytes);
        return legal;
    }
    content(OLD);
    return { capability, bundle, records, files, calls, github, netlify, leases,
        foundation, content, changedLegal, setReady(sha) { ready = sha; },
        onLookup(callback) { lookupOverride = callback; },
        get lookupCount() { return lookup; } };
}

test("legal foundation requires a package verifier bound to its bundle and provider", async () => {
    const f = await fixture();
    const common = { records: f.records, reader: {}, netlify: f.netlify,
        github: f.github, bundle: f.bundle, leases: f.leases };
    assert.throws(() => createCmsFoundationService({ ...common,
        reader: { readAtCommit() {} }, legalVerifier: { readAtCommit() {} } }),
    /package-owned legal verification/);
    const other = await fixture();
    assert.throws(() => createCmsFoundationService({ ...common,
        reader: { readAtCommit() {} }, legalVerifier:
            createCmsPublicLegalVerifier({ capability: other.capability, github: f.github }) }),
    /package-owned legal verification/);
    assert.ok(f.foundation());
});

test("initial predecessor captures raw content and exact verified originals", async () => {
    const f = await fixture();
    f.content(OLD, { home: {} });
    const first = await f.foundation().ensure({ canonicalContent: canonical });
    assert.deepEqual(first.live.data.content, { home: {} });
    assert.deepEqual(first.live.data.legal, f.capability.initialPairs());
    assert.deepEqual(first.baseline.data.legal, first.live.data.legal);
    assert.equal(first.baseline.data.sourceCommit, OLD);
    assert.deepEqual((await f.foundation().ensure({ canonicalContent: canonical })).baseline,
        first.baseline);
});

test("current READY reconciles a changed legal pair and clean draft only", async () => {
    const f = await fixture();
    const first = await f.foundation().ensure({ canonicalContent: canonical });
    f.records.put("draft", { content: canonical, legal: first.live.data.legal,
        baseRevision: OLD, hasUnpublishedChanges: false, note: "Keep" });
    const changed = f.changedLegal(NEXT);
    f.content(NEXT);
    f.setReady(NEXT);
    const next = await f.foundation().ensure({ canonicalContent: canonical });
    assert.deepEqual(next.live.data.legal, changed);
    assert.equal(next.live.data.revisionId, NEXT);
    assert.deepEqual((await f.records.read("draft")).data.legal, changed);
    assert.equal((await f.records.read("draft")).data.note, "Keep");
    assert.deepEqual(next.baseline, first.baseline);
    f.records.put("draft", { content: canonical, legal: first.live.data.legal,
        baseRevision: OLD, hasUnpublishedChanges: true });
    const unpublished = await f.records.read("draft");
    await f.foundation().ensure({ canonicalContent: canonical });
    assert.deepEqual(await f.records.read("draft"), unpublished);
});

test("identity-only movement requires old and new exact legal proof", async () => {
    const f = await fixture();
    const first = await f.foundation().ensure({ canonicalContent: canonical });
    f.content(NEXT);
    f.setReady(NEXT);
    const advanced = await f.foundation().ensure({ canonicalContent: canonical });
    assert.equal(advanced.live.data.revisionId, NEXT);
    assert.deepEqual(advanced.live.data.legal, first.live.data.legal);
    assert.deepEqual(advanced.baseline, first.baseline);
    const broken = await fixture();
    await broken.foundation().ensure({ canonicalContent: canonical });
    broken.content(NEXT);
    broken.setReady(NEXT);
    broken.files.set(`${OLD}:${broken.capability.renderedPath}`, Buffer.from("{}"));
    broken.records.put("draft", { content: canonical, baseRevision: OLD,
        hasUnpublishedChanges: false });
    const priorDraft = await broken.records.read("draft");
    const held = await broken.foundation().ensure({ canonicalContent: canonical });
    assert.equal(held.live.data.revisionId, OLD);
    assert.deepEqual(await broken.records.read("draft"), priorDraft);
});

test("a legacy clean draft can gain explicit legal during identity movement", async () => {
    const f = await fixture();
    const first = await f.foundation().ensure({ canonicalContent: canonical });
    f.records.put("draft", { content: canonical, baseRevision: OLD,
        hasUnpublishedChanges: false, note: "Keep" });
    f.content(NEXT);
    f.setReady(NEXT);
    const moved = await f.foundation().ensure({ canonicalContent: canonical });
    assert.equal(moved.live.data.revisionId, NEXT);
    const draft = await f.records.read("draft");
    assert.equal(draft.data.baseRevision, NEXT);
    assert.deepEqual(draft.data.legal, first.live.data.legal);
    assert.equal(draft.data.note, "Keep");
});

test("missing live legal cannot bypass image proof or an inconsistent clean draft", async () => {
    const withImage = { home: { ...canonical.home,
        image: "/images/home/cms-example.png" } };
    for (const mode of ["image", "draft"]) {
        const f = await fixture({ managedImage: true,
            identityChanged: mode === "image" });
        f.content(OLD, withImage);
        const first = await f.foundation().ensure({ canonicalContent: withImage });
        const legacyLive = structuredClone(first.live.data);
        delete legacyLive.legal;
        f.records.put("confirmedLive", legacyLive);
        if (mode === "draft") {
            f.records.put("draft", { content: { home: { ...withImage.home,
                heading: "Inconsistent" } }, baseRevision: OLD,
            hasUnpublishedChanges: false });
        }
        const priorDraft = await f.records.read("draft");
        f.content(NEXT, withImage);
        f.setReady(NEXT);
        const held = await f.foundation().ensure({ canonicalContent: withImage });
        assert.equal(held.live.data.revisionId, OLD, mode);
        assert.equal(Object.hasOwn(held.live.data, "legal"), false, mode);
        assert.deepEqual(await f.records.read("draft"), priorDraft, mode);
    }
});

test("manifestless policy, partial proof and READY movement stop legal writes", async () => {
    const strict = await fixture({ allowManifestlessOriginals: false });
    await assert.rejects(strict.foundation().ensure({ canonicalContent: canonical }),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
    assert.equal(await strict.records.read("confirmedLive"), null);
    const partial = await fixture();
    partial.files.set(`${OLD}:${partial.capability.renderedPath}`, Buffer.from("{}"));
    await assert.rejects(partial.foundation().ensure({ canonicalContent: canonical }),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
    assert.equal(await partial.records.read("confirmedLive"), null);
    const moving = await fixture();
    moving.onLookup((count, ready) => count === 1
        ? { id: `deploy-${ready}`, commit_ref: ready, published_at: NOW }
        : { id: "moved", commit_ref: NEXT, published_at: NOW });
    const result = await moving.foundation().ensure({ canonicalContent: canonical });
    assert.equal(result.live, null);
    assert.equal(await moving.records.read("confirmedLive"), null);
});

test("legal live write and failed clean-draft CAS converge on retry", async () => {
    const f = await fixture();
    const first = await f.foundation().ensure({ canonicalContent: canonical });
    f.records.put("draft", { content: canonical, legal: first.live.data.legal,
        baseRevision: OLD, hasUnpublishedChanges: false });
    const changed = f.changedLegal(NEXT);
    f.content(NEXT);
    f.setReady(NEXT);
    f.records.reject.set("draft", 2);
    await assert.rejects(f.foundation().ensure({ canonicalContent: canonical }),
        { code: "CMS_STATE_CONFLICT" });
    assert.deepEqual((await f.records.read("confirmedLive")).data.legal, changed);
    assert.equal((await f.records.read("draft")).data.baseRevision, OLD);
    const repaired = await f.foundation().ensure({ canonicalContent: canonical });
    assert.equal((await f.records.read("draft")).data.baseRevision, NEXT);
    assert.deepEqual((await f.records.read("draft")).data.legal, changed);
    assert.deepEqual(repaired.baseline, first.baseline);
});

test("unresolved publication and lost foundation lease preserve legal state", async () => {
    const unresolved = await fixture();
    const first = await unresolved.foundation().ensure({ canonicalContent: canonical });
    unresolved.records.put("publication", { status: "uncertain",
        draft: { content: canonical, legal: first.live.data.legal } });
    unresolved.changedLegal(NEXT);
    unresolved.content(NEXT);
    unresolved.setReady(NEXT);
    const lookupCount = unresolved.lookupCount;
    const held = await unresolved.foundation().ensure({ canonicalContent: canonical });
    assert.deepEqual(held.live, first.live);
    assert.equal(unresolved.lookupCount, lookupCount);
    const lost = await fixture();
    const captured = await lost.foundation().ensure({ canonicalContent: canonical });
    lost.changedLegal(NEXT);
    lost.content(NEXT);
    lost.setReady(NEXT);
    lost.leases.renew = async () => {
        throw Object.assign(new Error("lease lost"), { code: "CMS_STATE_LOCKED",
            status: 423 });
    };
    await assert.rejects(lost.foundation().ensure({ canonicalContent: canonical }),
        { code: "CMS_STATE_LOCKED" });
    assert.deepEqual(await lost.records.read("confirmedLive"), captured.live);
});
