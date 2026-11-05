import assert from "node:assert/strict";
import test from "node:test";

import { CmsApiError, createCmsContentDraftSaveService,
    createCmsJsonRecordStore } from "../src/server/index.js";

const fallback = { heading: "Checkout", image: "checkout.png" };
const actor = { email: "editor@example.com" };

function fixture(legalFromRecord) {
    const entries = new Map();
    const calls = [];
    let sequence = 0;
    let race = null;
    const store = {
        async getWithMetadata(key, options) {
            calls.push({ method: "read", key, options });
            return structuredClone(entries.get(key) ?? null);
        },
        async setJSON(key, data, options) {
            calls.push({ method: "write", key, data: structuredClone(data), options });
            race?.();
            race = null;
            const current = entries.get(key);
            if (options.onlyIfNew && current) return { modified: false };
            if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
                return { modified: false };
            }
            const etag = `v${++sequence}`;
            entries.set(key, { data: structuredClone(data), etag, metadata: {} });
            return { modified: true, etag };
        },
    };
    const records = createCmsJsonRecordStore({ store, keys: {
        draft: "state/draft", confirmedLive: "state/confirmed-live",
    } });
    const leases = { async acquire() { return { owner: "save" }; },
        async renew(lease) { return lease; }, async release() { return true; } };
    const content = {
        normalizePersisted(raw, base) { return { ...structuredClone(base), ...structuredClone(raw) }; },
        validateCurrent(value) {
            if (!value?.heading) throw new TypeError("Missing heading.");
            return value;
        },
    };
    const imageProof = { store: { async getMetadata() { return null; } },
        github: { async readManagedAssetBlobIdentitiesAtCommit() { return new Map(); } },
        assets: { contentImagePaths() { return new Set(); }, isManagedImagePath() { return false; } } };
    const service = createCmsContentDraftSaveService({ records, content, leases,
        ...imageProof,
        applyContentChanges(source, changes, live) {
            const next = { ...structuredClone(live), ...structuredClone(source) };
            for (const change of changes) {
                if (change?.path !== "heading") {
                    throw new CmsApiError("UNKNOWN_FIELD", "The field is not editable.");
                }
                next.heading = change.value;
            }
            return next;
        },
        deriveSections: () => [{ sectionPath: "home.hero", schemaId: "example-hero" }],
        validateNote: (value) => value == null ? "" : String(value).trim(),
        validateCleanupCandidates: (value) => value ?? [],
        legalFromRecord,
        now: () => new Date("2026-11-04T12:00:00.000Z"),
    });
    return { entries, calls, service, leases, setRace(fn) { race = fn; } };
}

function seed(entries, key, data, etag) {
    const record = { data: structuredClone(data), etag, metadata: {} };
    entries.set(key, record);
    return record;
}

function save(service, request, trustedActor = actor) {
    return service.save({ request, actor: trustedActor, confirmedFallbackContent: fallback });
}

function conflict(error) {
    return error.code === "DRAFT_CONFLICT" && error.status === 409 &&
        error.message === "The draft changed. Reload it before trying again.";
}

test("first content Save creates the complete neutral record without legal", async () => {
    const { entries, calls, service } = fixture();
    const live = seed(entries, "state/confirmed-live", {
        content: { heading: "Live" }, revisionId: "live-sha", legal: { unused: true },
    }, "live-etag");
    const request = { expectedDraftVersion: null,
        changes: [{ path: "heading", value: "Draft" }],
        saveData: { note: "  Review  " }, cleanupCandidates: ["new.png"],
        actor: { email: "forged@example.com" } };
    const result = await save(service, request);
    const expected = { content: { heading: "Draft", image: "checkout.png" },
        note: "Review", updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: actor.email,
        cleanupCandidates: ["new.png"],
        sections: [{ sectionPath: "home.hero", schemaId: "example-hero" }],
        baseRevision: "live-sha", hasUnpublishedChanges: true };
    assert.deepEqual(result, { draft: expected.content, draftVersion: "v1",
        hasSavedDraft: true, metadata: expected });
    assert.deepEqual(entries.get("state/draft").data, expected);
    assert.deepEqual(entries.get("state/confirmed-live"), live);
    assert.equal(Object.hasOwn(result, "legal"), false);
    assert.deepEqual(calls.filter(({ method }) => method === "write")
        .map(({ key, options }) => ({ key, options })), [
        { key: "state/draft", options: { onlyIfNew: true } },
    ]);
});

test("active raw draft and clean draft select different sources and legal defaults", async () => {
    const legalFromRecord = (record) => ({ privacy: record?.legal?.privacy ?? "original" });
    const { entries, service } = fixture(legalFromRecord);
    seed(entries, "state/confirmed-live", { content: { heading: "Live", image: "live.png" },
        legal: { privacy: "live.pdf" }, revisionId: "live-sha" }, "live-etag");
    seed(entries, "state/draft", { content: { heading: "Old draft" },
        legal: { privacy: "draft.pdf" }, note: "Keep", cleanupCandidates: ["old.png"],
        baseRevision: "old-sha", hasUnpublishedChanges: true }, "draft-etag");
    const active = await save(service, { expectedDraftVersion: "draft-etag",
        changes: [{ path: "heading", value: "Edited draft" }],
        cleanupCandidates: ["old.png", "new.png"] });
    assert.equal(active.draft.heading, "Edited draft");
    assert.equal(active.draft.image, "live.png");
    assert.deepEqual(active.legal, { privacy: "draft.pdf" });
    assert.equal(active.metadata.note, "Keep");
    assert.equal(active.metadata.baseRevision, "old-sha");
    assert.deepEqual(active.metadata.cleanupCandidates, ["old.png", "new.png"]);
    seed(entries, "state/draft", { content: { heading: "Obsolete clean" },
        legal: { privacy: "old.pdf" }, baseRevision: "older-sha",
        hasUnpublishedChanges: false }, "clean-etag");
    const clean = await save(service, { expectedDraftVersion: "clean-etag",
        changes: [{ path: "heading", value: "Edited live" }] });
    assert.equal(clean.draft.heading, "Edited live");
    assert.deepEqual(clean.legal, { privacy: "live.pdf" });
    assert.equal(clean.metadata.baseRevision, "live-sha");
});

test("empty, invalid and legal changes fail before writing", async () => {
    const { entries, calls, service } = fixture();
    seed(entries, "state/confirmed-live", { content: { heading: "Live" } }, "live-etag");
    for (const changes of [undefined, []]) {
        await assert.rejects(save(service, { expectedDraftVersion: null, changes }),
            (error) => error.code === "NO_CHANGES");
    }
    await assert.rejects(save(service, { expectedDraftVersion: null,
        changes: [{ path: "legal.privacy.pdf", value: "unhandled" }] }),
    (error) => error.code === "UNKNOWN_FIELD");
    await assert.rejects(save(service, { expectedDraftVersion: null,
        changes: [{ path: "heading", value: "" }] }), TypeError);
    assert.equal(entries.has("state/draft"), false);
    assert.equal(calls.some(({ method }) => method === "write"), false);
});

test("stale and omitted versions stop before live read; CAS race cannot overwrite", async () => {
    const { entries, calls, service, setRace } = fixture();
    seed(entries, "state/draft", { content: { heading: "Draft" } }, "draft-etag");
    seed(entries, "state/confirmed-live", { content: { heading: "Live" } }, "live-etag");
    for (const version of [undefined, null, "stale"]) {
        calls.length = 0;
        await assert.rejects(save(service, { expectedDraftVersion: version,
            changes: [{ path: "heading", value: "Lost" }] }), conflict);
        assert.deepEqual(calls.map(({ key }) => key), ["state/draft"]);
    }
    setRace(() => seed(entries, "state/draft", { content: { heading: "Racer" } }, "raced"));
    await assert.rejects(save(service, { expectedDraftVersion: "draft-etag",
        changes: [{ path: "heading", value: "Lost" }] }), conflict);
    assert.equal(entries.get("state/draft").data.content.heading, "Racer");
});

test("missing foundation, malformed input, and provider errors fail closed", async () => {
    const { calls, service } = fixture();
    await assert.rejects(save(service, { expectedDraftVersion: null,
        changes: [{ path: "heading", value: "Draft" }] }),
    (error) => error.code === "CMS_FOUNDATION_NOT_INITIALIZED" && error.status === 503);
    assert.equal(calls.some(({ method }) => method === "write"), false);
    calls.length = 0;
    await assert.rejects(save(service, {}, { email: "" }), TypeError);
    assert.deepEqual(calls, []);
    assert.throws(() => createCmsContentDraftSaveService({}), TypeError);
    const failure = new Error("provider unavailable");
    const broken = createCmsContentDraftSaveService({ records: {
        async read() { throw failure; }, async writeIfVersion() { throw failure; },
    }, content: { normalizePersisted(value) { return value; }, validateCurrent(value) { return value; } },
    leases: { async acquire() {}, async renew() {}, async release() {} },
    store: { async getMetadata() {} },
    github: { async readManagedAssetBlobIdentitiesAtCommit() {} },
    assets: { contentImagePaths() { return new Set(); }, isManagedImagePath() {} },
    applyContentChanges(value) { return value; }, deriveSections() { return []; },
    validateNote(value) { return value; }, validateCleanupCandidates() { return []; } });
    await assert.rejects(save(broken, { changes: [{ path: "heading", value: "Draft" }] }),
        (error) => error === failure);
});

test("busy or lost mutation lease stops content Save before its conditional write", async () => {
    const f = fixture();
    seed(f.entries, "state/confirmed-live", { content: { heading: "Live" },
        revisionId: "live" }, "live-etag");
    const request = { expectedDraftVersion: null,
        changes: [{ path: "heading", value: "New" }] };
    f.leases.acquire = async () => {
        throw new CmsApiError("CMS_STATE_LOCKED", "busy", 423);
    };
    await assert.rejects(save(f.service, request),
        { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(f.entries.has("state/draft"), false);
    f.leases.acquire = async () => ({ owner: "save" });
    f.leases.renew = async () => {
        throw new CmsApiError("CMS_STATE_LOCKED", "lost", 423);
    };
    await assert.rejects(save(f.service, request),
        { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(f.entries.has("state/draft"), false);
});
