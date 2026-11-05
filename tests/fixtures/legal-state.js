import { createCmsJsonRecordStore, createCmsLeaseManager,
    createCmsLegalCapability, createCmsLegalService } from "../../src/server/index.js";
import { syntheticLegalConfig } from "./legal.js";

export const LEGAL_NOW = new Date("2026-11-04T12:00:00.000Z");
export const LEGAL_OLD = "2026-10-20T12:00:00.000Z";

export async function createLegalState({ now = () => LEGAL_NOW } = {}) {
    const entries = new Map();
    let sequence = 0;
    let failDelete = null;
    const store = {
        async getWithMetadata(key) { return structuredClone(entries.get(key) ?? null); },
        async getMetadata(key) {
            const item = entries.get(key);
            return item ? { etag: item.etag, metadata: structuredClone(item.metadata) } : null;
        },
        async set(key, data, options) { return this.write(key, data, options); },
        async setJSON(key, data, options) { return this.write(key, data, options); },
        async write(key, data, options = {}) {
            const previous = entries.get(key);
            if (options.onlyIfNew && previous) return { modified: false };
            if (options.onlyIfMatch !== undefined && previous?.etag !== options.onlyIfMatch) {
                return { modified: false };
            }
            const etag = `etag-${++sequence}`;
            entries.set(key, { data: structuredClone(data), etag,
                metadata: structuredClone(options.metadata ?? {}) });
            return { modified: true, etag };
        },
        async delete(key) {
            if (failDelete?.key === key) throw failDelete.error;
            entries.delete(key);
        },
        async *list({ prefix }) {
            yield { blobs: [...entries].filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({ key, etag: value.etag })) };
        },
    };
    const records = createCmsJsonRecordStore({ store, keys: {
        draft: "state/draft", baseline: "state/baseline",
        confirmedLive: "state/confirmed-live", publication: "state/publication",
        revisions: "state/revisions", coordination: "state/coordination",
    } });
    const leases = createCmsLeaseManager({ records, now,
        createOwner: () => "legal-state-operation" });
    const capability = await createCmsLegalCapability(syntheticLegalConfig());
    const service = createCmsLegalService({ capability, store, records, leases, now });
    const original = service.initialPairs();
    await records.writeIfVersion("baseline", { content: { home: {} }, legal: original }, null);
    await records.writeIfVersion("confirmedLive", { content: { home: {} }, legal: original,
        commit: "a".repeat(40), revisionId: "a".repeat(40) }, null);
    await records.writeIfVersion("revisions", { entries: [] }, null);
    return { entries, store, records, leases, capability, service,
        failDelete(key, error = new Error("delete failed")) {
            failDelete = key ? { key, error } : null;
        } };
}
