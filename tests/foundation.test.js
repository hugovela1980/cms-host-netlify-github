import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";

import { createCmsFoundationService, createCmsHostPolicyBundle,
    createCmsRepositoryContentReader } from "../src/server/index.js";

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const IMAGE = "/images/home/cms-hero.png";
const NOW = "2026-11-04T12:00:00.000Z";
const canonical = { home: { hero: { heading: "Original", image: { src: IMAGE } } } };
const imageField = { sectionPath: "home.hero", schemaId: "hero", fieldKey: "image.src",
    destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/" };
const policy = {
    classifyPublic(raw) { return { kind: raw.home?.hero ? "current" : "predecessor", content: raw }; },
    normalizePersisted(raw, fallback) {
        const next = structuredClone(raw);
        next.home ??= {};
        next.home.hero ??= structuredClone(fallback.home.hero);
        return next;
    },
    validateCurrent(content) {
        if (!content.home?.hero?.heading) throw new TypeError("Missing heading.");
        return content;
    },
    historicalManagedAssetReferences() { return new Set(); },
};

class Records {
    map = new Map();
    seq = 0;
    writes = [];
    rejectNext = null;
    rejectCounts = new Map();
    async read(name) { return structuredClone(this.map.get(name) ?? null); }
    async writeIfVersion(name, data, etag) {
        if (this.rejectNext === name) {
            this.rejectNext = null;
            return { modified: false };
        }
        if ((this.rejectCounts.get(name) ?? 0) > 0) {
            this.rejectCounts.set(name, this.rejectCounts.get(name) - 1);
            return { modified: false };
        }
        const prior = this.map.get(name);
        if (etag === null ? Boolean(prior) : prior?.etag !== etag) return { modified: false };
        const next = { data: structuredClone(data), etag: `etag-${++this.seq}` };
        this.map.set(name, next);
        this.writes.push({ name, data: structuredClone(data), expected: etag });
        return { modified: true, etag: next.etag };
    }
    put(name, data) {
        this.map.set(name, { data: structuredClone(data), etag: `etag-${++this.seq}` });
    }
}

function fixture({ content = canonical, readySha = SHA1, identity = "same" } = {}) {
    const records = new Records();
    const bundle = createCmsHostPolicyBundle({ contentPolicy: policy, managedImages: [imageField] });
    const requests = [];
    let deploy = { id: `deploy-${readySha}`, commit_ref: readySha, published_at: NOW };
    let lookup = 0;
    let onLookup = null;
    const netlify = { async findLatestReadyProductionDeploy() {
        lookup += 1;
        return onLookup ? onLookup(lookup, deploy) : deploy;
    } };
    const github = {
        async readFileAtCommit(path, sha, options) {
            requests.push({ path, sha, options });
            assert.equal(path, "content/home.yaml");
            return Object.hasOwn(content, "home") ? Buffer.from(YAML.stringify(content.home)) : null;
        },
        async readManagedAssetBlobIdentitiesAtCommit(paths, sha, { content: snapshot }) {
            requests.push({ paths, sha, snapshot });
            if (identity === "missing") throw new Error("Tree unavailable");
            return new Map(paths.map((path) => [path, {
                sha: identity === "changed" && sha === readySha ? "different" : "same-blob",
                size: 42,
            }]));
        },
    };
    const reader = createCmsRepositoryContentReader({ github, content: bundle.content,
        pages: [{ contentKey: "home", contentFile: "content/home.yaml", allowMissing: true }] });
    const leases = {
        async acquire() { return { owner: "foundation" }; },
        async renew(lease) { return lease; },
        async release() { return true; },
    };
    const foundation = createCmsFoundationService({ records, reader, netlify, github,
        bundle, leases, now: () => new Date(NOW) });
    return { records, bundle, github, netlify, foundation, requests, leases,
        setDeploy(value) { deploy = value; },
        onLookup(value) { onLookup = value; },
        get lookupCount() { return lookup; } };
}

test("initial predecessor capture keeps raw content and baseline immutable", async () => {
    const f = fixture({ content: { home: {} } });
    const first = await f.foundation.ensure({ canonicalContent: canonical });
    assert.deepEqual(first.live.data.content, { home: {} });
    assert.deepEqual(first.baseline.data.content, { home: {} });
    assert.equal(first.live.data.revisionId, SHA1);
    assert.equal(first.baseline.data.revisionId, "developer-baseline");
    assert.deepEqual(f.records.writes.map((write) => [write.name, write.expected]),
        [["confirmedLive", null], ["baseline", null]]);
    assert.equal((await f.foundation.ensure({ canonicalContent: canonical })).baseline.etag,
        first.baseline.etag);
});

test("current READY content updates live and only a clean draft; baseline stays fixed", async () => {
    const f = fixture();
    const first = await f.foundation.ensure({ canonicalContent: canonical });
    f.records.put("draft", { content: canonical, baseRevision: SHA1,
        hasUnpublishedChanges: false, note: "Keep me", sections: [] });
    const changed = structuredClone(canonical);
    changed.home.hero.heading = "Deployed change";
    const g = fixture({ content: changed, readySha: SHA2 });
    // Use the same durable records as the initial capture.
    g.records.map = f.records.map;
    g.records.seq = f.records.seq;
    const next = await g.foundation.ensure({ canonicalContent: canonical });
    assert.deepEqual(next.live.data.content, changed);
    assert.equal(next.live.data.revisionId, SHA2);
    assert.deepEqual((await g.records.read("draft")).data, { content: changed,
        baseRevision: SHA2, hasUnpublishedChanges: false, note: "Keep me", sections: [] });
    assert.deepEqual(next.baseline, first.baseline);
    g.records.put("draft", { content: { home: { hero: { heading: "My draft" } } },
        baseRevision: SHA2, hasUnpublishedChanges: true });
    const unpublished = await g.records.read("draft");
    await g.foundation.ensure({ canonicalContent: canonical });
    assert.deepEqual(await g.records.read("draft"), unpublished);
});

test("unresolved publication preserves records without provider lookup", async () => {
    const f = fixture();
    const first = await f.foundation.ensure({ canonicalContent: canonical });
    f.records.put("publication", { status: "uncertain" });
    const before = f.lookupCount;
    const result = await f.foundation.ensure({ canonicalContent: canonical });
    assert.equal(result.live.etag, first.live.etag);
    assert.equal(f.lookupCount, before);
});

test("identity-only READY move requires exact asset proof and current deploy", async () => {
    for (const identity of ["same", "changed", "missing"]) {
        const f = fixture();
        const first = await f.foundation.ensure({ canonicalContent: canonical });
        const g = fixture({ readySha: SHA2, identity });
        g.records.map = f.records.map;
        g.records.seq = f.records.seq;
        const result = await g.foundation.ensure({ canonicalContent: canonical });
        assert.equal(result.live.data.revisionId, identity === "same" ? SHA2 : SHA1);
        assert.equal(result.baseline.etag, first.baseline.etag);
        if (identity === "same") {
            assert.equal(g.requests.filter((request) => request.paths).length, 2);
        }
    }
});

test("READY movement under the lease stops reconciliation", async () => {
    const f = fixture();
    const first = await f.foundation.ensure({ canonicalContent: canonical });
    const changed = structuredClone(canonical);
    changed.home.hero.heading = "New READY";
    const g = fixture({ content: changed, readySha: SHA2 });
    g.records.map = f.records.map;
    g.records.seq = f.records.seq;
    g.onLookup((count, deploy) => count === 1 ? deploy :
        { ...deploy, id: "moved" });
    const before = g.records.writes.length;
    const result = await g.foundation.ensure({ canonicalContent: canonical });
    assert.equal(result.live.etag, first.live.etag);
    assert.equal(g.records.writes.length, before);
});

test("READY lookup uncertainty and inconsistent clean draft block identity movement", async () => {
    const f = fixture();
    const first = await f.foundation.ensure({ canonicalContent: canonical });
    for (const mode of ["lookup", "draft"]) {
        const g = fixture({ readySha: SHA2 });
        g.records.map = f.records.map;
        g.records.seq = f.records.seq;
        if (mode === "lookup") {
            g.onLookup((count, deploy) => {
                if (count > 1) throw new Error("READY unavailable");
                return deploy;
            });
        } else {
            g.records.put("draft", { content: { home: { hero: { heading: "Wrong" } } },
                baseRevision: SHA1, hasUnpublishedChanges: false });
        }
        const before = await g.records.read("draft");
        const result = await g.foundation.ensure({ canonicalContent: canonical });
        assert.equal(result.live.etag, first.live.etag);
        assert.deepEqual(await g.records.read("draft"), before);
    }
});

test("busy identity lease returns strong current records; busy content lease remains a conflict", async () => {
    const f = fixture();
    const first = await f.foundation.ensure({ canonicalContent: canonical });
    const busy = Object.assign(new Error("busy"), { code: "CMS_STATE_LOCKED", status: 423 });
    const identity = fixture({ readySha: SHA2 });
    identity.records.map = f.records.map;
    identity.records.seq = f.records.seq;
    identity.leases.acquire = async () => { throw busy; };
    const result = await identity.foundation.ensure({ canonicalContent: canonical });
    assert.equal(result.live.etag, first.live.etag);
    assert.equal(result.baseline.etag, first.baseline.etag);
    identity.records.put("draft", { content: { home: { hero: { heading: "Wrong" } } },
        baseRevision: SHA1, hasUnpublishedChanges: false });
    const inconsistent = await identity.records.read("draft");
    const stillReadable = await identity.foundation.ensure({ canonicalContent: canonical });
    assert.equal(stillReadable.live.etag, first.live.etag);
    assert.deepEqual(await identity.records.read("draft"), inconsistent);
    const changed = structuredClone(canonical);
    changed.home.hero.heading = "READY change";
    const content = fixture({ content: changed, readySha: SHA2 });
    content.records.map = f.records.map;
    content.records.seq = f.records.seq;
    content.leases.acquire = async () => { throw busy; };
    await assert.rejects(content.foundation.ensure({ canonicalContent: canonical }),
        { code: "CMS_STATE_LOCKED", status: 423 });
});

test("lease renewal loss cannot report a successful identity move", async () => {
    const f = fixture();
    await f.foundation.ensure({ canonicalContent: canonical });
    const g = fixture({ readySha: SHA2 });
    g.records.map = f.records.map;
    g.records.seq = f.records.seq;
    let renewals = 0;
    g.leases.renew = async (lease) => {
        renewals += 1;
        if (renewals === 2) {
            throw Object.assign(new Error("lost"), { code: "CMS_STATE_LOCKED", status: 423 });
        }
        return lease;
    };
    await assert.rejects(g.foundation.ensure({ canonicalContent: canonical }),
        { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(renewals, 2);
    assert.equal((await g.records.read("confirmedLive")).data.revisionId, SHA2);
});

test("failed clean-draft CAS after live write converges on retry", async () => {
    const f = fixture();
    await f.foundation.ensure({ canonicalContent: canonical });
    f.records.put("draft", { content: canonical, baseRevision: SHA1,
        hasUnpublishedChanges: false });
    const changed = structuredClone(canonical);
    changed.home.hero.heading = "Developer change";
    const g = fixture({ content: changed, readySha: SHA2 });
    g.records.map = f.records.map;
    g.records.seq = f.records.seq;
    g.records.rejectNext = "draft";
    await g.foundation.ensure({ canonicalContent: canonical });
    assert.equal((await g.records.read("confirmedLive")).data.revisionId, SHA2);
    assert.equal((await g.records.read("draft")).data.baseRevision, SHA2);
});

test("partial live write with repeated draft CAS loss converges on the next ensure", async () => {
    const f = fixture();
    const first = await f.foundation.ensure({ canonicalContent: canonical });
    f.records.put("draft", { content: canonical, baseRevision: SHA1,
        hasUnpublishedChanges: false });
    const changed = structuredClone(canonical);
    changed.home.hero.heading = "New deployed content";
    const g = fixture({ content: changed, readySha: SHA2 });
    g.records.map = f.records.map;
    g.records.seq = f.records.seq;
    g.records.rejectCounts.set("draft", 2);
    await assert.rejects(g.foundation.ensure({ canonicalContent: canonical }),
        { code: "CMS_STATE_CONFLICT", status: 409 });
    assert.equal((await g.records.read("confirmedLive")).data.revisionId, SHA2);
    assert.equal((await g.records.read("draft")).data.baseRevision, first.live.data.revisionId);
    const repaired = await g.foundation.ensure({ canonicalContent: canonical });
    assert.equal(repaired.live.data.revisionId, SHA2);
    assert.equal((await g.records.read("draft")).data.baseRevision, SHA2);
    assert.equal(repaired.baseline.etag, first.baseline.etag);
});

test("legal configuration and existing legal records fail closed", async () => {
    const f = fixture();
    const withLegal = createCmsHostPolicyBundle({ contentPolicy: policy,
        managedImages: [imageField],
        legal: { pdfPaths: ["public/downloads/legal/Example_Privacy.pdf"] } });
    assert.throws(() => createCmsFoundationService({ records: f.records,
        reader: { readAtCommit() {} }, netlify: f.netlify, github: f.github,
        bundle: withLegal, leases: { acquire() {} } }),
    /package-owned legal verification/);
    f.records.put("confirmedLive", { content: canonical, legal: {} });
    await assert.rejects(f.foundation.ensure({ canonicalContent: canonical }),
        /package-owned legal verification/);
});

test("repository reader reports unavailable and invalid YAML at exact commit", async () => {
    const bundle = fixture().bundle;
    for (const [value, code] of [[undefined, "INITIAL_PUBLIC_CONTENT_UNAVAILABLE"],
        ["hero: [", "INITIAL_PUBLIC_CONTENT_INVALID"]]) {
        const reader = createCmsRepositoryContentReader({
            github: { async readFileAtCommit() { return value === undefined ? null : Buffer.from(value); } },
            content: bundle.content,
            pages: [{ contentKey: "home", contentFile: "content/home.yaml", allowMissing: false }],
        });
        await assert.rejects(reader.readAtCommit(SHA1, canonical), { code, status: 502 });
    }
});
