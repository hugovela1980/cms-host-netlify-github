// Internal composition point. The site supplies compatibility and validation
// policy; the adapter retains a separate raw PUBLIC identity and working view.
function requireContentFallback(fallbackContent) {
    if (!fallbackContent || typeof fallbackContent !== "object" || Array.isArray(fallbackContent)) {
        throw new TypeError("A content fallback must be supplied by the caller.");
    }
    return fallbackContent;
}

export function createContentOperations(contentPolicy) {
    return Object.freeze({
        readPublic(rawContent, canonicalContentFromCheckout) {
            const canonical = requireContentFallback(canonicalContentFromCheckout);
            const classified = contentPolicy.classifyPublic(rawContent, canonical);
            return {
                kind: classified.kind,
                rawContent,
                workingContent: contentPolicy.normalizePersisted(rawContent, canonical),
            };
        },
        normalizePersisted(content, fallbackContent) {
            return contentPolicy.normalizePersisted(content, requireContentFallback(fallbackContent));
        },
        validateCurrent(content) {
            return contentPolicy.validateCurrent(content);
        },
        historicalManagedAssetReferences(content) {
            return contentPolicy.historicalManagedAssetReferences(content);
        },
    });
}
