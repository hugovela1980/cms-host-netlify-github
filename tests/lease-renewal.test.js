import assert from "node:assert/strict";
import test from "node:test";

import { createCmsJsonRecordStore, createCmsLeaseManager,
    withCmsMutationLease } from "../src/server/index.js";

const START = new Date("2026-11-04T12:00:00.000Z");
const KEY = "example/coordination";

class FakeStore {
    entries = new Map();
    writes = [];
    sequence = 0;
    async getWithMetadata(key) {
        return this.entries.has(key) ? structuredClone(this.entries.get(key)) : null;
    }
    async setJSON(key, data, options) {
        this.writes.push({ key, data: structuredClone(data), options });
        const current = this.entries.get(key);
        if (options.onlyIfNew && current) return { modified: false };
        if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
            return { modified: false };
        }
        const etag = `v${++this.sequence}`;
        this.entries.set(key, { data: structuredClone(data), etag, metadata: {} });
        return { modified: true, etag };
    }
}

function setup() {
    const store = new FakeStore();
    const clock = { value: START };
    const records = createCmsJsonRecordStore({ store, keys: { coordination: KEY } });
    const leases = createCmsLeaseManager({ records,
        now: () => new Date(clock.value), createOwner: () => "owner-one" });
    return { store, clock, leases };
}

test("renew retains identity, advances expiry, and uses the current ETag", async () => {
    const { store, clock, leases } = setup();
    const first = await leases.acquire({ kind: "mutation", ttlMs: 90 });
    clock.value = new Date(START.getTime() + 20);
    const renewed = await leases.renew(first, { ttlMs: 90 });
    assert.deepEqual(renewed, { ...first,
        expiresAt: "2026-11-04T12:00:00.110Z", etag: "v2" });
    assert.deepEqual(store.writes[1].options, { onlyIfMatch: "v1" });
    assert.equal(store.entries.get(KEY).data.owner, "owner-one");
    assert.equal(await leases.release(first), false);
    assert.equal(await leases.release(renewed), true);
});

test("expiry, changed owner, and CAS race fail renewal without overwriting state", async () => {
    const { store, clock, leases } = setup();
    const first = await leases.acquire({ kind: "mutation", ttlMs: 90 });
    clock.value = new Date(START.getTime() + 90);
    await assert.rejects(leases.renew(first, { ttlMs: 90 }),
        { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(store.writes.length, 1);

    clock.value = START;
    const current = store.entries.get(KEY);
    store.entries.set(KEY, { ...current, data: { ...current.data, owner: "other" } });
    await assert.rejects(leases.renew(first), { code: "CMS_STATE_LOCKED", status: 423 });
    store.entries.set(KEY, current);
    const write = store.setJSON.bind(store);
    store.setJSON = async (key, data, options) => options.onlyIfMatch
        ? { modified: false } : write(key, data, options);
    await assert.rejects(leases.renew(first), { code: "CMS_STATE_LOCKED", status: 423 });
});

test("serialized timer and explicit renewals keep a long operation active", async () => {
    const { store, clock, leases } = setup();
    let tick;
    let cancelled = false;
    const result = await withCmsMutationLease(leases, async (ensureActive) => {
        clock.value = new Date(START.getTime() + 20);
        tick();
        await Promise.all([ensureActive(), ensureActive()]);
        clock.value = new Date(START.getTime() + 100);
        await ensureActive();
        assert.equal(store.entries.get(KEY).data.owner, "owner-one");
        return "complete";
    }, { ttlMs: 90, renewEveryMs: 20, schedule(callback, interval) {
        assert.equal(interval, 20);
        tick = callback;
        return () => { cancelled = true; };
    } });
    assert.equal(result, "complete");
    assert.equal(cancelled, true);
    assert.deepEqual(store.writes.map(({ options }) => options), [
        { onlyIfNew: true }, { onlyIfMatch: "v1" }, { onlyIfMatch: "v2" },
        { onlyIfMatch: "v3" }, { onlyIfMatch: "v4" }, { onlyIfMatch: "v5" },
        { onlyIfMatch: "v6" },
    ]);
    assert.equal(store.entries.get(KEY).data.owner, null);
});

test("background provider failure cannot return success or release uncertain ownership", async () => {
    const { store, leases } = setup();
    const providerError = new Error("provider unavailable");
    const write = store.setJSON.bind(store);
    store.setJSON = async (key, data, options) => {
        if (options.onlyIfMatch) throw providerError;
        return write(key, data, options);
    };
    let tick;
    await assert.rejects(withCmsMutationLease(leases, async () => {
        tick();
        return "would have succeeded";
    }, { ttlMs: 90, renewEveryMs: 20,
        schedule(callback) { tick = callback; return () => {}; } }),
    (error) => error === providerError);
    assert.equal(store.entries.get(KEY).data.owner, "owner-one");
    assert.equal(store.writes.length, 1);
});

test("a missed timer cannot let an expired operation report success", async () => {
    const { store, clock, leases } = setup();
    await assert.rejects(withCmsMutationLease(leases, async () => {
        clock.value = new Date(START.getTime() + 90);
        return "would have succeeded";
    }, { ttlMs: 90, renewEveryMs: 20, schedule: () => () => {} }),
    { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(store.entries.get(KEY).data.owner, "owner-one");
    assert.equal(store.writes.length, 1);
});

test("a provider rejection without an Error value still prevents success", async () => {
    let released = false;
    let tick;
    const leases = {
        async acquire() { return { etag: "v1" }; },
        async renew() { throw undefined; },
        async release() { released = true; return true; },
    };
    await assert.rejects(withCmsMutationLease(leases, async () => {
        tick();
        return "would have succeeded";
    }, { ttlMs: 90, renewEveryMs: 20,
        schedule(callback) { tick = callback; return () => {}; } }),
    (error) => error === undefined);
    assert.equal(released, false);
});

test("operation and scheduler errors release a known lease; stale final release fails", async () => {
    const operationError = new Error("operation failed");
    const first = setup();
    await assert.rejects(withCmsMutationLease(first.leases, async (ensureActive) => {
        await ensureActive();
        throw operationError;
    }, { ttlMs: 90, renewEveryMs: 20, schedule: () => () => {} }),
    (error) => error === operationError);
    assert.equal(first.store.entries.get(KEY).data.owner, null);

    const second = setup();
    await assert.rejects(withCmsMutationLease(second.leases, async () => {},
        { ttlMs: 90, renewEveryMs: 20, schedule: () => { throw operationError; } }),
    (error) => error === operationError);
    assert.equal(second.store.entries.get(KEY).data.owner, null);

    const third = setup();
    await assert.rejects(withCmsMutationLease(third.leases, async () => {
        const current = third.store.entries.get(KEY);
        third.store.entries.set(KEY, { data: { ...current.data, owner: "other" },
            etag: "replacement", metadata: {} });
    }, { ttlMs: 90, renewEveryMs: 20, schedule: () => () => {} }),
    { code: "CMS_STATE_LOCKED", status: 423 });
    assert.equal(third.store.entries.get(KEY).data.owner, "other");
});

test("invalid renewal and wrapper options fail before provider writes", async () => {
    const { store, leases } = setup();
    await assert.rejects(leases.renew({}), TypeError);
    await assert.rejects(withCmsMutationLease(leases, async () => {},
        { ttlMs: 29 }), TypeError);
    await assert.rejects(withCmsMutationLease(leases, async () => {},
        { ttlMs: 90, renewEveryMs: 90 }), TypeError);
    assert.equal(store.writes.length, 0);
});
