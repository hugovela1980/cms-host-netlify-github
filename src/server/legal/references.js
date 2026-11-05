import { isCmsLegalCapability } from "./capability.js";

const HASH = /^[0-9a-f]{64}$/;

// Conservative evidence for cleanup, not permission to publish a legal file.
export function inventoryDurableLegalReferences(roots, capability) {
    if (!isCmsLegalCapability(capability) || !roots || typeof roots !== "object" ||
        Array.isArray(roots)) throw new TypeError("Invalid durable legal inventory input.");
    const protectedKeys = new Set();
    const errors = [];
    const pages = Object.keys(capability.pages);
    const originals = capability.initialPairs();

    function inspect(root, record) {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
            errors.push({ root, reason: "record-unavailable" });
            return;
        }
        const legal = record.legal;
        if (legal !== undefined && (!legal || typeof legal !== "object" ||
            Array.isArray(legal) || Object.keys(legal).some((page) => !pages.includes(page)))) {
            errors.push({ root, reason: "legal-invalid" });
            return;
        }
        for (const page of pages) {
            const pair = legal?.[page] ?? originals[page];
            if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
                errors.push({ root, reason: "pair-invalid", page });
                continue;
            }
            for (const kind of ["document", "pdf"]) {
                const hash = pair[kind]?.hash;
                if (typeof hash !== "string" || !HASH.test(hash)) {
                    errors.push({ root, reason: "reference-invalid", page, kind });
                    continue;
                }
                protectedKeys.add(capability.stagedKey(page, kind, hash));
            }
        }
    }

    for (const root of ["baseline", "confirmedLive"]) {
        if (!roots[root]) errors.push({ root, reason: "required-root-missing" });
        else inspect(root, roots[root]);
    }
    if (roots.draft) inspect("draft", roots.draft);
    if (roots.revisions) {
        if (!Array.isArray(roots.revisions.entries)) {
            errors.push({ root: "revisions", reason: "entries-invalid" });
        } else roots.revisions.entries.forEach((record, index) =>
            inspect(`revisions[${index}]`, record));
    }
    if (roots.publication && !["confirmed", "failed"].includes(roots.publication.status)) {
        inspect("publication.draft", roots.publication.draft);
    }
    return { protectedKeys, errors };
}
