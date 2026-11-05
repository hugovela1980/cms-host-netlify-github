function validEtag(value) {
    return typeof value === "string" && value.length > 0;
}

// The host supplies the store and its logical key map. Domain services decide
// which conflict code to return; this layer preserves provider CAS outcomes.
export function createCmsJsonRecordStore({ store, keys } = {}) {
    if (!store || typeof store.getWithMetadata !== "function" ||
        typeof store.setJSON !== "function" || !keys || typeof keys !== "object" ||
        Array.isArray(keys)) {
        throw new TypeError("Invalid CMS JSON record-store configuration.");
    }
    const entries = Object.entries(keys);
    if (entries.length === 0 || entries.some(([name, key]) =>
        !name || typeof key !== "string" || !key || key !== key.trim()) ||
        new Set(entries.map(([, key]) => key)).size !== entries.length) {
        throw new TypeError("Invalid CMS JSON record keys.");
    }
    const stableKeys = Object.freeze(Object.fromEntries(entries));

    function keyFor(name) {
        if (typeof name !== "string" || !Object.hasOwn(stableKeys, name)) {
            throw new TypeError("Unknown CMS JSON record name.");
        }
        return stableKeys[name];
    }

    return Object.freeze({
        async read(name) {
            const result = await store.getWithMetadata(keyFor(name), {
                type: "json", consistency: "strong",
            });
            if (result === null) return null;
            if (!result || typeof result !== "object" || !validEtag(result.etag) ||
                !Object.hasOwn(result, "data")) {
                throw new TypeError("Invalid CMS JSON record read result.");
            }
            return result;
        },
        async writeIfVersion(name, data, expectedEtag) {
            const key = keyFor(name);
            if (expectedEtag !== null && !validEtag(expectedEtag)) {
                throw new TypeError("An explicit null or nonempty expected ETag is required.");
            }
            const result = await store.setJSON(key, data, expectedEtag === null
                ? { onlyIfNew: true } : { onlyIfMatch: expectedEtag });
            if (!result || typeof result !== "object" || typeof result.modified !== "boolean" ||
                (result.modified && !validEtag(result.etag))) {
                throw new TypeError("Invalid CMS JSON record write result.");
            }
            return result;
        },
    });
}
