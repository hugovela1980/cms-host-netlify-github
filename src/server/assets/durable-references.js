// Pure inventory for review before a separately approved runtime cutover.
// protectedPaths is conservative cleanup evidence, never a GitHub allowlist.
export function inventoryDurableAssetReferences(records, policy) {
    if (!records || typeof records !== "object" || Array.isArray(records) ||
        typeof policy?.contentImagePaths !== "function") {
        throw new TypeError("Invalid durable asset inventory input.");
    }

    const protectedPaths = new Set();
    const identifiedPaths = new Set();
    const unresolvedAssets = [];
    const errors = [];

    function inspect(root, record, content = record?.content, assets = record?.assets) {
        let imagePaths = new Set();
        if (!content || typeof content !== "object" || Array.isArray(content)) {
            errors.push({ root, reason: "content-unavailable" });
        } else {
            try {
                imagePaths = policy.contentImagePaths(content);
                if (!(imagePaths instanceof Set)) throw new TypeError();
                for (const path of imagePaths) {
                    identifiedPaths.add(path);
                    protectedPaths.add(path);
                }
            } catch {
                errors.push({ root, reason: "content-unclassifiable" });
            }
        }
        if (assets === undefined) return;
        if (!Array.isArray(assets)) {
            errors.push({ root, reason: "assets-invalid" });
            return;
        }
        for (const path of assets) {
            if (typeof path !== "string" || path.length === 0) {
                errors.push({ root, reason: "asset-path-invalid" });
                continue;
            }
            protectedPaths.add(path);
            if (!imagePaths.has(path)) unresolvedAssets.push({ root, path });
        }
    }

    for (const root of ["baseline", "confirmedLive"]) {
        if (!records[root]) errors.push({ root, reason: "required-root-missing" });
        else inspect(root, records[root]);
    }
    if (records.draft) inspect("draft", records.draft);
    if (records.revisions) {
        if (!Array.isArray(records.revisions.entries)) {
            errors.push({ root: "revisions", reason: "entries-invalid" });
        } else {
            records.revisions.entries.forEach((record, index) =>
                inspect(`revisions[${index}]`, record));
        }
    }
    if (records.publication && !["confirmed", "failed"].includes(records.publication.status)) {
        const publication = records.publication;
        inspect("publication.draft", publication.draft);
        inspect("publication.assets", publication, publication.draft?.content, publication.assets);
    }

    return { protectedPaths, identifiedPaths, unresolvedAssets, errors };
}
