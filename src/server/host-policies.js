import { createAssetIdentityPolicy } from "./assets/identity-policy.js";
import { createContentOperations } from "./content/operations.js";

const CONTENT_METHODS = [
    "normalizePersisted",
    "classifyPublic",
    "validateCurrent",
    "historicalManagedAssetReferences",
];
const hostBundles = new WeakSet();

export function isCmsHostPolicyBundle(value) {
    return Boolean(value && typeof value === "object" && hostBundles.has(value));
}

// Pure server-side composition for a host's own content and asset rules.
// Legal configuration here covers exact PDF asset identity only.
export function createCmsHostPolicyBundle({ contentPolicy, managedImages, legal } = {}) {
    if (!contentPolicy || typeof contentPolicy !== "object" || Array.isArray(contentPolicy) ||
        CONTENT_METHODS.some((name) => typeof contentPolicy[name] !== "function") ||
        !Array.isArray(managedImages)) {
        throw new TypeError("Invalid CMS host policy configuration.");
    }
    if (legal != null && (!legal || typeof legal !== "object" || Array.isArray(legal) ||
        !Array.isArray(legal.pdfPaths) || legal.pdfPaths.length === 0)) {
        throw new TypeError("Invalid optional legal PDF configuration.");
    }
    const stableContentPolicy = Object.freeze(Object.fromEntries(
        CONTENT_METHODS.map((name) => [name, contentPolicy[name]])));

    const bundle = Object.freeze({
        content: createContentOperations(stableContentPolicy),
        assets: Object.freeze({ ...createAssetIdentityPolicy({
            managedImages,
            historicalManagedAssetReferences: (content) =>
                stableContentPolicy.historicalManagedAssetReferences(content),
            legalPdfPaths: legal?.pdfPaths ?? [],
        }), legalAssetsEnabled: legal != null }),
        legalAssetsEnabled: legal != null,
        legalPdfPaths: Object.freeze([...(legal?.pdfPaths ?? [])]),
    });
    hostBundles.add(bundle);
    return bundle;
}
