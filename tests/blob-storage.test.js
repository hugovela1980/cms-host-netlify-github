import assert from "node:assert/strict";
import test from "node:test";
import { createCmsBlobStorage, CMS_RECORD_KEYS, createCmsHost } from
    "../src/server/index.js";

function fakeStore() {
    const entries = new Map();
    let version = 0;
    return { entries,
        async getWithMetadata(key, options) {
            assert.deepEqual(options, { type: "json", consistency: "strong" });
            return entries.get(key) ?? null;
        },
        async getMetadata() { return null; },
        async setJSON(key, data, options) {
            const current = entries.get(key);
            if ((options.onlyIfNew && current) ||
                (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) {
                return { modified: false };
            }
            const etag = `v${++version}`;
            entries.set(key, { data, etag, metadata: {} });
            return { modified: true, etag };
        },
        async set() { return { modified: true, etag: "binary" }; },
        async delete() {},
        async *list() {},
    };
}

test("named storage fixes all six record keys and isolates each named store", async () => {
    assert.deepEqual(CMS_RECORD_KEYS, {
        draft: "state/draft", baseline: "state/developer-baseline",
        confirmedLive: "state/confirmed-live", publication: "state/publication",
        revisions: "state/revisions", coordination: "state/coordination",
    });
    const stores = new Map([["site-a", fakeStore()], ["site-b", fakeStore()]]);
    const calls = [];
    const getStore = (options) => {
        calls.push(options);
        return stores.get(options.name);
    };
    const a = createCmsBlobStorage({ name: "site-a", getStore });
    const b = createCmsBlobStorage({ name: "site-b", getStore });
    assert.deepEqual(calls, [
        { name: "site-a", consistency: "strong" },
        { name: "site-b", consistency: "strong" },
    ]);
    for (const name of Object.keys(CMS_RECORD_KEYS)) {
        assert.deepEqual(await a.records.writeIfVersion(name, { site: "a", name }, null),
            { modified: true, etag: `v${Object.keys(CMS_RECORD_KEYS).indexOf(name) + 1}` });
        assert.deepEqual((await a.records.read(name)).data, { site: "a", name });
        assert.equal(await b.records.read(name), null);
        assert.equal(stores.get("site-a").entries.has(CMS_RECORD_KEYS[name]), true);
        assert.equal(stores.get("site-b").entries.has(CMS_RECORD_KEYS[name]), false);
    }
    await b.records.writeIfVersion("draft", { site: "b" }, null);
    assert.deepEqual((await a.records.read("draft")).data, { site: "a", name: "draft" });
});

test("malformed and ambiguous storage fails before any record write", async () => {
    const store = fakeStore();
    let getStoreCalls = 0;
    const getStore = () => { getStoreCalls += 1; return store; };
    for (const name of ["", " site", "site ", "site/other", "site%2Fother",
        "a".repeat(65), "é".repeat(33), 42]) {
        assert.throws(() => createCmsBlobStorage({ name, getStore }), TypeError);
    }
    assert.equal(getStoreCalls, 0);
    for (const name of ["site_other", "Site--Other", "site-é", "é".repeat(32)]) {
        const result = createCmsBlobStorage({ name, getStore });
        assert.equal(result.store, store);
    }
    assert.equal(getStoreCalls, 4);
    assert.throws(() => createCmsBlobStorage({ name: "site", getStore: null }), TypeError);
    assert.throws(() => createCmsBlobStorage({ name: "site", getStore,
        keys: { draft: "custom" } }), TypeError);
    assert.throws(() => createCmsBlobStorage({ name: "site", getStore,
        store }), TypeError);
    assert.throws(() => createCmsBlobStorage({ name: "site",
        getStore: () => ({}) }), TypeError);
    await assert.rejects(createCmsHost({ storage: { name: "site", getStore },
        store, keys: CMS_RECORD_KEYS }), TypeError);
    assert.equal(getStoreCalls, 4);
    assert.equal(store.entries.size, 0);
});
