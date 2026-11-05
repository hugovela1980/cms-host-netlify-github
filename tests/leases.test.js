import assert from "node:assert/strict";
import test from "node:test";

import { createCmsJsonRecordStore, createCmsLeaseManager } from "../src/server/index.js";

const START = new Date("2026-11-04T12:00:00.000Z");

class FakeStore {
    entries = new Map();
    writes = [];
    sequence = 0;
    async getWithMetadata(key, options) {
        assert.deepEqual(options, { type: "json", consistency: "strong" });
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

function setup(store = new FakeStore(), clock = { value: START }) {
    const records = createCmsJsonRecordStore({ store,
        keys: { coordination: "host/state/coordination" } });
    return { store, clock, leases: createCmsLeaseManager({ records,
        now: () => new Date(clock.value), createOwner: () => "generated-owner" }) };
}

test("acquire, release, and reuse preserve exact lease fields and CAS options", async () => {
    const { store, leases } = setup();
    const lease = await leases.acquire({ kind: "mutation" });
    assert.deepEqual(lease, { owner: "generated-owner", kind: "mutation",
        acquiredAt: START.toISOString(), expiresAt: "2026-11-04T12:01:00.000Z", etag: "v1" });
    assert.deepEqual(store.writes[0].options, { onlyIfNew: true });
    assert.equal(await leases.release(lease), true);
    assert.deepEqual(store.writes[1], { key: "host/state/coordination",
        data: { owner: null, kind: null, releasedAt: START.toISOString(),
            expiresAt: START.toISOString() }, options: { onlyIfMatch: "v1" } });
    const next = await leases.acquire({ kind: "asset-cleanup", owner: "second" });
    assert.equal(next.etag, "v3");
    assert.deepEqual(store.writes[2].options, { onlyIfMatch: "v2" });
});

test("active publication and ordinary leases retain 423 lock semantics", async () => {
    for (const [kind, message] of [
        ["publication", "Publication is in progress."],
        ["mutation", "Another CMS change is in progress."],
    ]) {
        const { store, leases } = setup();
        await leases.acquire({ kind, owner: "first" });
        await assert.rejects(leases.acquire({ kind: "mutation", owner: "second" }),
            (error) => error.code === "CMS_STATE_LOCKED" && error.status === 423 &&
                error.message.startsWith(message));
        assert.equal(store.writes.length, 1);
    }
});

test("expired takeover succeeds and stale release cannot replace the new owner", async () => {
    const clock = { value: START };
    const { store, leases } = setup(new FakeStore(), clock);
    const old = await leases.acquire({ kind: "mutation", owner: "first", ttlMs: 1_000 });
    clock.value = new Date(START.getTime() + 1_000);
    const next = await leases.acquire({ kind: "publication", owner: "second" });
    assert.deepEqual(store.writes[1].options, { onlyIfMatch: old.etag });
    assert.equal(await leases.release(old), false);
    assert.equal(store.entries.get("host/state/coordination").data.owner, "second");
    assert.equal(await leases.release(next), true);
});

test("concurrent create or expired-record replacement conflict returns CMS_STATE_LOCKED", async () => {
    for (const seeded of [false, true]) {
        const { store, leases } = setup();
        if (seeded) store.entries.set("host/state/coordination", { etag: "v0", metadata: {},
            data: { owner: "expired", kind: "mutation",
                acquiredAt: "2026-11-04T11:58:00.000Z",
                expiresAt: "2026-11-04T11:59:00.000Z" } });
        const write = store.setJSON.bind(store);
        store.setJSON = async (...args) => {
            const [, , options] = args;
            if (options.onlyIfNew || options.onlyIfMatch) return { modified: false };
            return write(...args);
        };
        await assert.rejects(leases.acquire({ kind: "mutation" }),
            { code: "CMS_STATE_LOCKED", status: 423 });
    }
});

test("malformed prior state, invalid time, and invalid requests fail closed", async () => {
    const { store, leases } = setup();
    for (const data of [
        { owner: "writer", kind: "mutation", acquiredAt: START.toISOString(), expiresAt: "bad" },
        { owner: "writer", kind: "mutation", expiresAt: "2026-11-04T11:59:00.000Z" },
        { owner: null, kind: null, expiresAt: START.toISOString() },
    ]) {
        store.entries.set("host/state/coordination", { etag: "v0", metadata: {}, data });
        await assert.rejects(leases.acquire({ kind: "mutation" }), TypeError);
    }
    assert.equal(store.writes.length, 0);
    store.entries.delete("host/state/coordination");
    for (const request of [{}, { kind: "" }, { kind: "mutation", ttlMs: 0 },
        { kind: "mutation", owner: " " }]) {
        await assert.rejects(leases.acquire(request), TypeError);
    }
    await assert.rejects(leases.release({ etag: "" }), TypeError);
    const records = createCmsJsonRecordStore({ store,
        keys: { coordination: "host/state/coordination" } });
    const badClock = createCmsLeaseManager({ records, now: () => new Date("bad") });
    await assert.rejects(badClock.acquire({ kind: "mutation" }), TypeError);
    assert.throws(() => createCmsLeaseManager({ records: {} }), TypeError);
});

test("provider read and write errors propagate without changing ownership", async () => {
    const store = new FakeStore();
    const records = createCmsJsonRecordStore({ store,
        keys: { coordination: "host/state/coordination" } });
    const leases = createCmsLeaseManager({ records, now: () => START });
    const readError = new Error("read failed");
    store.getWithMetadata = async () => { throw readError; };
    await assert.rejects(leases.acquire({ kind: "mutation" }), (error) => error === readError);
    store.getWithMetadata = async () => null;
    const writeError = new Error("write failed");
    store.setJSON = async () => { throw writeError; };
    await assert.rejects(leases.acquire({ kind: "mutation" }), (error) => error === writeError);
    await assert.rejects(leases.release({ etag: "v1" }), (error) => error === writeError);
});
