import { createCmsJsonRecordStore } from "./json-records.js";

// These keys are shared by every host; the named Blob store isolates sites.
export const CMS_RECORD_KEYS = Object.freeze({
    draft: "state/draft",
    baseline: "state/developer-baseline",
    confirmedLive: "state/confirmed-live",
    publication: "state/publication",
    revisions: "state/revisions",
    coordination: "state/coordination",
});

export function validCmsBlobStore(store) {
    return !!store && ["getWithMetadata", "getMetadata", "setJSON", "set",
        "delete", "list"].every((method) => typeof store[method] === "function");
}

// The host injects Netlify's getStore transport (or a synthetic equivalent).
// Keeping this synchronous makes malformed configuration fail at composition.
export function createCmsBlobStorage(config = {}) {
    if (!config || typeof config !== "object" || Array.isArray(config) ||
        Object.keys(config).some((key) => key !== "name" && key !== "getStore")) {
        throw new TypeError("Invalid CMS Blob storage configuration.");
    }
    const { name, getStore } = config;
    if (typeof name !== "string" || !name || name !== name.trim() ||
        name.includes("/") || name.includes("%2F") ||
        new TextEncoder().encode(name).length > 64 ||
        typeof getStore !== "function") {
        throw new TypeError("Invalid CMS Blob storage configuration.");
    }
    const store = getStore({ name, consistency: "strong" });
    if (!validCmsBlobStore(store)) {
        throw new TypeError("Invalid CMS Blob store.");
    }
    return Object.freeze({ store, keys: CMS_RECORD_KEYS,
        records: createCmsJsonRecordStore({ store, keys: CMS_RECORD_KEYS }) });
}
