import assert from "node:assert/strict";
import test from "node:test";

import { createCmsJsonRecordStore } from "../src/server/index.js";

class FakeStore {
    entries = new Map();
    calls = [];
    sequence = 0;
    async getWithMetadata(key, options) {
        this.calls.push({ method: "getWithMetadata", key, options });
        const record = this.entries.get(key);
        return record ? structuredClone(record) : null;
    }
    async setJSON(key, data, options) {
        this.calls.push({ method: "setJSON", key, data, options });
        const current = this.entries.get(key);
        if (options.onlyIfNew && current) return { modified: false };
        if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
            return { modified: false };
        }
        const etag = `v${++this.sequence}`;
        this.entries.set(key, { data: structuredClone(data), etag, metadata: { source: "example" } });
        return { modified: true, etag };
    }
}

test("missing record, strong JSON read, and ETag record shape", async () => {
    const store = new FakeStore();
    const records = createCmsJsonRecordStore({ store, keys: { draft: "state/draft" } });
    assert.equal(await records.read("draft"), null);
    assert.deepEqual(store.calls[0], { method: "getWithMetadata", key: "state/draft",
        options: { type: "json", consistency: "strong" } });
    assert.deepEqual(await records.writeIfVersion("draft", { heading: "First" }, null),
        { modified: true, etag: "v1" });
    assert.deepEqual(await records.read("draft"), { data: { heading: "First" },
        etag: "v1", metadata: { source: "example" } });
});

test("create-only collision and stale replacement preserve provider CAS outcomes", async () => {
    const store = new FakeStore();
    const records = createCmsJsonRecordStore({ store, keys: { draft: "state/draft" } });
    await records.writeIfVersion("draft", { heading: "First" }, null);
    assert.deepEqual(await records.writeIfVersion("draft", { heading: "Collision" }, null),
        { modified: false });
    assert.deepEqual(await records.writeIfVersion("draft", { heading: "Second" }, "v1"),
        { modified: true, etag: "v2" });
    assert.deepEqual(await records.writeIfVersion("draft", { heading: "Stale" }, "v1"),
        { modified: false });
    assert.deepEqual((await records.read("draft")).data, { heading: "Second" });
    assert.deepEqual(store.calls.filter((call) => call.method === "setJSON")
        .map(({ options }) => options), [
        { onlyIfNew: true }, { onlyIfNew: true },
        { onlyIfMatch: "v1" }, { onlyIfMatch: "v1" },
    ]);
});

test("invalid configuration and versions cannot select an arbitrary key or unconditional write", async () => {
    const store = new FakeStore();
    for (const config of [{}, { store, keys: {} }, { store, keys: { a: "same", b: "same" } },
        { store, keys: { a: " " } }]) {
        assert.throws(() => createCmsJsonRecordStore(config), TypeError);
    }
    const keys = { draft: "state/draft" };
    const records = createCmsJsonRecordStore({ store, keys });
    keys.draft = "state/changed";
    await assert.rejects(records.read("unknown"), TypeError);
    for (const version of [undefined, "", 1]) {
        await assert.rejects(records.writeIfVersion("draft", {}, version), TypeError);
    }
    assert.deepEqual(store.calls, []);
    assert.deepEqual(await records.writeIfVersion("draft", {}, null), { modified: true, etag: "v1" });
    assert.equal(store.calls[0].key, "state/draft");
});

test("malformed provider results fail and provider errors propagate unchanged", async () => {
    const readError = new Error("provider read failed");
    const writeError = new Error("provider write failed");
    const store = {
        async getWithMetadata() { throw readError; },
        async setJSON() { throw writeError; },
    };
    const records = createCmsJsonRecordStore({ store, keys: { draft: "state/draft" } });
    await assert.rejects(records.read("draft"), (error) => error === readError);
    await assert.rejects(records.writeIfVersion("draft", {}, null), (error) => error === writeError);
    store.getWithMetadata = async () => ({ data: {}, etag: "" });
    store.setJSON = async () => ({ modified: true });
    await assert.rejects(records.read("draft"), TypeError);
    await assert.rejects(records.writeIfVersion("draft", {}, null), TypeError);
    store.setJSON = async () => ({ modified: false });
    assert.deepEqual(await records.writeIfVersion("draft", {}, null), { modified: false });
});
