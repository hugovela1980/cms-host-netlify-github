import assert from "node:assert/strict";
import test from "node:test";

import { createCmsDraftStateReader, createCmsJsonRecordStore } from "../src/server/index.js";

function fixture(legalFromRecord) {
    const entries = new Map();
    const calls = [];
    const store = {
        async getWithMetadata(key, options) {
            calls.push({ key, options });
            return structuredClone(entries.get(key) ?? null);
        },
        async setJSON() { assert.fail("Draft-state reads must not write."); },
    };
    const records = createCmsJsonRecordStore({ store, keys: {
        draft: "state/draft", confirmedLive: "state/confirmed-live",
        publication: "state/publication",
    } });
    const content = { normalizePersisted(raw, fallback) {
        return { ...structuredClone(fallback), ...structuredClone(raw) };
    } };
    return { entries, calls, reader: createCmsDraftStateReader({ records, content,
        legalFromRecord }) };
}

function seed(entries, key, data, etag) {
    const record = { data: structuredClone(data), etag, metadata: { fixture: true } };
    entries.set(key, record);
    return record;
}

test("missing live has the established error; fallback is explicit", async () => {
    const { reader, calls } = fixture();
    await assert.rejects(reader.read(), TypeError);
    assert.deepEqual(calls, []);
    await assert.rejects(reader.read({ confirmedFallbackContent: { heading: "Checkout" } }),
        (error) => error.code === "CMS_FOUNDATION_NOT_INITIALIZED" && error.status === 503 &&
            error.message === "Initial PUBLIC CMS state has not been captured.");
    assert.deepEqual(calls.map(({ key }) => key), [
        "state/draft", "state/confirmed-live", "state/publication",
    ]);
    assert.ok(calls.every(({ options }) =>
        options.type === "json" && options.consistency === "strong"));
});

test("absent and clean draft use normalized live, retain clean ETag and metadata", async () => {
    const { entries, reader } = fixture();
    const checkout = { heading: "Checkout", image: "checkout.png" };
    const live = seed(entries, "state/confirmed-live", {
        content: { heading: "Live" }, revisionId: "live-1", extra: true,
    }, "live-etag");
    assert.deepEqual(await reader.read({ confirmedFallbackContent: checkout }), {
        draft: { heading: "Live", image: "checkout.png" }, draftVersion: null,
        hasSavedDraft: false, metadata: null,
        published: { heading: "Live", image: "checkout.png" },
        confirmedRevision: "live-1", publicationStatus: null,
    });
    const clean = seed(entries, "state/draft", {
        content: { heading: "Obsolete" }, hasUnpublishedChanges: false,
        note: "Published", updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: "editor@example.com",
        legal: { unused: true }, extra: "kept",
    }, "draft-etag");
    const result = await reader.read({ confirmedFallbackContent: checkout });
    assert.deepEqual(result.draft, { heading: "Live", image: "checkout.png" });
    assert.equal(result.draftVersion, "draft-etag");
    assert.equal(result.hasSavedDraft, false);
    assert.deepEqual(result.metadata, { note: "Published",
        updatedAt: "2026-11-04T12:00:00.000Z", updatedBy: "editor@example.com" });
    assert.equal(Object.hasOwn(result, "legal"), false);
    assert.equal(Object.hasOwn(result, "publishedLegal"), false);
    assert.deepEqual(entries.get("state/draft"), clean);
    assert.deepEqual(entries.get("state/confirmed-live"), live);
});

test("active historical draft and publication project with optional legal defaults", async () => {
    const defaults = { privacy: { pdf: "initial.pdf" }, terms: { pdf: "terms.pdf" } };
    const legalFromRecord = (record) => ({ ...structuredClone(defaults),
        ...(record?.legal ?? {}) });
    const { entries, reader } = fixture(legalFromRecord);
    const live = seed(entries, "state/confirmed-live", {
        content: { heading: "Live", image: "live.png" },
        legal: { terms: { pdf: "live-terms.pdf" } }, revisionId: "live-2",
    }, "live-etag");
    const draft = seed(entries, "state/draft", {
        content: { heading: "Draft" }, legal: { privacy: { pdf: "draft.pdf" } },
        hasUnpublishedChanges: true, extra: { retained: true },
    }, "draft-etag");
    const publication = seed(entries, "state/publication", {
        id: "publication-1", status: "deploying", startedBy: "editor@example.com",
        commitSha: "target-sha", internalLease: "hidden",
    }, "publication-etag");
    const result = await reader.read({ confirmedFallbackContent: { heading: "Checkout" } });
    assert.deepEqual(result, {
        draft: { heading: "Draft", image: "live.png" }, draftVersion: "draft-etag",
        hasSavedDraft: true,
        metadata: { note: "", updatedAt: null, updatedBy: null },
        published: { heading: "Live", image: "live.png" },
        legal: { privacy: { pdf: "draft.pdf" }, terms: { pdf: "terms.pdf" } },
        publishedLegal: { privacy: { pdf: "initial.pdf" },
            terms: { pdf: "live-terms.pdf" } },
        confirmedRevision: "live-2",
        publicationStatus: { id: "publication-1", status: "deploying", startedAt: null,
            updatedAt: null, startedBy: "editor@example.com", title: null,
            commitSha: "target-sha", confirmedAt: null, errorCode: null, deploy: null },
    });
    assert.deepEqual(entries.get("state/confirmed-live"), live);
    assert.deepEqual(entries.get("state/draft"), draft);
    assert.deepEqual(entries.get("state/publication"), publication);
});

test("invalid configuration and provider errors propagate", async () => {
    assert.throws(() => createCmsDraftStateReader({}), TypeError);
    assert.throws(() => createCmsDraftStateReader({ records: { read() {} },
        content: { normalizePersisted() {} }, legalFromRecord: true }), TypeError);
    const failure = new Error("provider unavailable");
    const reader = createCmsDraftStateReader({ records: { async read() { throw failure; } },
        content: { normalizePersisted() {} } });
    await assert.rejects(reader.read({ confirmedFallbackContent: {} }),
        (error) => error === failure);
});
