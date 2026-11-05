import assert from "node:assert/strict";
import test from "node:test";

import { createCmsDraftRevertService, createCmsJsonRecordStore } from "../src/server/index.js";

const fallback = { heading: "Checkout", image: "checkout.png" };
const actor = { email: "editor@example.com" };
const fixedNow = () => new Date("2026-11-04T12:00:00.000Z");

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
    const leases = { async acquire() { return { owner: "revert" }; },
        async renew(lease) { return lease; }, async release() { return true; } };
    const content = {
        normalizePersisted(raw, base) {
            return { ...structuredClone(base), ...structuredClone(raw) };
        },
        validateCurrent(value) {
            if (!value?.heading) throw new TypeError("Missing heading.");
            return value;
        },
    };
    const validateNote = (value) => value == null ? "" : String(value).trim();
    const service = createCmsDraftRevertService({ records, content, validateNote, leases,
        legalFromRecord, now: fixedNow });
    return { entries, calls, service, leases, setRace(fn) { race = fn; } };
}

function seed(entries, key, data, etag) {
    const record = { data: structuredClone(data), etag, metadata: {} };
    entries.set(key, record);
    return record;
}

function conflict(error) {
    return error.code === "DRAFT_CONFLICT" && error.status === 409 &&
        error.message === "The draft changed. Reload it before trying again.";
}

test("first Revert creates a clean neutral record without legal", async () => {
    const { entries, calls, service } = fixture();
    const live = seed(entries, "state/confirmed-live", {
        content: { heading: "Live" }, revisionId: "live-sha", legal: { privacy: "unused" },
    }, "live-etag");
    const result = await service.revert({ request: { expectedDraftVersion: null }, actor,
        confirmedFallbackContent: fallback });
    const expectedRecord = { content: { heading: "Live", image: "checkout.png" },
        note: "", updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: actor.email,
        cleanupCandidates: [], baseRevision: "live-sha", sections: [],
        hasUnpublishedChanges: false };
    assert.deepEqual(result, { draft: expectedRecord.content, draftVersion: "v1",
        hasSavedDraft: false, metadata: expectedRecord });
    assert.deepEqual(entries.get("state/draft").data, expectedRecord);
    assert.deepEqual(entries.get("state/confirmed-live"), live);
    assert.equal(Object.hasOwn(result, "legal"), false);
    assert.deepEqual(calls.filter(({ method }) => method === "write")
        .map(({ key, options }) => ({ key, options })), [
        { key: "state/draft", options: { onlyIfNew: true } },
    ]);
});

test("existing draft Revert retains note and cleanup, takes legal only from live", async () => {
    const legalFromRecord = (record) => ({ privacy: record?.legal?.privacy ?? "initial" });
    const { entries, service } = fixture(legalFromRecord);
    seed(entries, "state/confirmed-live", { content: { heading: "Live" },
        legal: { privacy: "live-pdf" }, revisionId: "live-sha" }, "live-etag");
    seed(entries, "state/draft", { content: { heading: "Unpublished" },
        legal: { privacy: "draft-pdf" }, note: "Keep note", cleanupCandidates: ["old.png"],
        hasUnpublishedChanges: true }, "draft-etag");
    const result = await service.revert({ request: { expectedDraftVersion: "draft-etag" },
        actor, confirmedFallbackContent: fallback });
    assert.deepEqual(result.legal, { privacy: "live-pdf" });
    assert.deepEqual(result.metadata.legal, result.legal);
    assert.equal(result.metadata.note, "Keep note");
    assert.deepEqual(result.metadata.cleanupCandidates, ["old.png"]);
    assert.equal(result.metadata.baseRevision, "live-sha");
    assert.equal(result.metadata.hasUnpublishedChanges, false);
    assert.equal(result.draftVersion, "v1");
    const clean = await service.revert({ request: { expectedDraftVersion: "v1",
        note: "  New note  " }, actor, confirmedFallbackContent: fallback });
    assert.equal(clean.metadata.note, "New note");
    assert.deepEqual(clean.metadata.cleanupCandidates, ["old.png"]);
});

test("stale and omitted versions stop before live read; CAS race cannot overwrite", async () => {
    const { entries, calls, service, setRace } = fixture();
    seed(entries, "state/draft", { content: { heading: "Draft" } }, "draft-etag");
    seed(entries, "state/confirmed-live", { content: { heading: "Live" } }, "live-etag");
    for (const version of [undefined, null, "stale"]) {
        calls.length = 0;
        await assert.rejects(service.revert({ request: { expectedDraftVersion: version }, actor,
            confirmedFallbackContent: fallback }), conflict);
        assert.deepEqual(calls.map(({ key }) => key), ["state/draft"]);
    }
    setRace(() => seed(entries, "state/draft", { content: { heading: "Racer" } }, "raced"));
    await assert.rejects(service.revert({ request: { expectedDraftVersion: "draft-etag" },
        actor, confirmedFallbackContent: fallback }), conflict);
    assert.equal(entries.get("state/draft").data.content.heading, "Racer");
});

test("missing foundation, invalid inputs, and provider errors fail without writes", async () => {
    const { calls, service } = fixture();
    await assert.rejects(service.revert({ request: { expectedDraftVersion: null }, actor,
        confirmedFallbackContent: fallback }),
    (error) => error.code === "CMS_FOUNDATION_NOT_INITIALIZED" && error.status === 503);
    assert.equal(calls.some(({ method }) => method === "write"), false);
    calls.length = 0;
    await assert.rejects(service.revert({ request: {}, actor: { email: "" },
        confirmedFallbackContent: fallback }), TypeError);
    assert.deepEqual(calls, []);
    assert.throws(() => createCmsDraftRevertService({}), TypeError);
    const failure = new Error("provider read failed");
    const broken = createCmsDraftRevertService({ records: {
        async read() { throw failure; }, async writeIfVersion() { throw failure; },
    }, content: { normalizePersisted(value) { return value; }, validateCurrent(value) { return value; } },
    leases: { async acquire() {}, async renew() {}, async release() {} },
    validateNote(value) { return value; } });
    await assert.rejects(broken.revert({ request: {}, actor,
        confirmedFallbackContent: fallback }), (error) => error === failure);
});

test("busy or lost mutation lease stops Revert before its conditional write", async () => {
    const f = fixture();
    seed(f.entries, "state/confirmed-live", { content: { heading: "Live" },
        revisionId: "live" }, "live-etag");
    const request = { request: { expectedDraftVersion: null }, actor,
        confirmedFallbackContent: fallback };
    f.leases.acquire = async () => {
        throw Object.assign(new Error("busy"), { code: "CMS_STATE_LOCKED", status: 423 });
    };
    await assert.rejects(f.service.revert(request), { code: "CMS_STATE_LOCKED" });
    assert.equal(f.entries.has("state/draft"), false);
    f.leases.acquire = async () => ({ owner: "revert" });
    f.leases.renew = async () => {
        throw Object.assign(new Error("lost"), { code: "CMS_STATE_LOCKED", status: 423 });
    };
    await assert.rejects(f.service.revert(request), { code: "CMS_STATE_LOCKED" });
    assert.equal(f.entries.has("state/draft"), false);
});
