import { CmsApiError } from "../http.js";

const CMS_IMAGE_NAME = /^cms-[a-z0-9][a-z0-9-]*\.(?:jpe?g|png|webp)$/i;
const SAFE_IMAGE_PATH = /^\/images\/(?:[a-z0-9-]+\/)+cms-[a-z0-9][a-z0-9-]*\.(?:jpe?g|png|webp)$/i;

function fieldIdentity({ sectionPath, schemaId, fieldKey }) {
    return JSON.stringify([sectionPath, schemaId, fieldKey]);
}

function valueAtPath(content, path) {
    return path.split(".").reduce((value, key) => value?.[key], content);
}

function identityUnavailable() {
    throw new CmsApiError(
        "MANAGED_ASSET_IDENTITY_UNAVAILABLE",
        "Referenced managed-image identity could not be verified at the PUBLIC commit.",
        502,
    );
}

// Internal, unused until a separately reviewed host cutover.
export function createAssetIdentityPolicy({
    managedImages,
    historicalManagedAssetReferences = () => new Set(),
    legalPdfPaths = [],
}) {
    if (!Array.isArray(managedImages) || typeof historicalManagedAssetReferences !== "function" ||
        !Array.isArray(legalPdfPaths)) throw new TypeError("Invalid asset identity configuration.");

    const fields = new Map();
    for (const field of managedImages) {
        const { sectionPath, schemaId, fieldKey, destinationDirectory, publicPathPrefix } = field ?? {};
        if (![sectionPath, schemaId, fieldKey, destinationDirectory, publicPathPrefix]
            .every((value) => typeof value === "string" && value.length > 0) ||
            !/^\/images\/(?:[a-z0-9-]+\/)+$/i.test(publicPathPrefix) ||
            destinationDirectory !== `public${publicPathPrefix.slice(0, -1)}`) {
            throw new TypeError("Invalid managed-image registration.");
        }
        const identity = fieldIdentity(field);
        if (fields.has(identity)) throw new TypeError("Duplicate managed-image field identity.");
        fields.set(identity, Object.freeze({ ...field }));
    }

    const legal = new Set(legalPdfPaths);
    if (legal.size !== legalPdfPaths.length ||
        [...legal].some((path) => typeof path !== "string" ||
            !/^public\/downloads\/legal\/[a-z0-9_.-]+\.pdf$/i.test(path))) {
        throw new TypeError("Invalid legal PDF registration.");
    }

    function findField(identity) {
        return fields.get(fieldIdentity(identity)) ?? null;
    }

    function isFieldImagePath(identity, publicPath) {
        const field = findField(identity);
        return Boolean(field && typeof publicPath === "string" &&
            publicPath.startsWith(field.publicPathPrefix) &&
            CMS_IMAGE_NAME.test(publicPath.slice(field.publicPathPrefix.length)));
    }

    function isManagedImagePath(publicPath) {
        return typeof publicPath === "string" && [...fields.values()].some((field) =>
            publicPath.startsWith(field.publicPathPrefix) &&
            CMS_IMAGE_NAME.test(publicPath.slice(field.publicPathPrefix.length)));
    }

    function contentImagePaths(content) {
        const paths = new Set();
        for (const field of fields.values()) {
            const path = valueAtPath(content, `${field.sectionPath}.${field.fieldKey}`);
            if (isFieldImagePath(field, path)) paths.add(path);
        }
        const historical = historicalManagedAssetReferences(content);
        if (!(historical instanceof Set)) throw new TypeError("Historical asset references must be a Set.");
        for (const path of historical) {
            if (!SAFE_IMAGE_PATH.test(path)) throw new TypeError("Invalid historical asset reference.");
            paths.add(path);
        }
        return paths;
    }

    function inspectRecordReferences(record) {
        const imagePaths = record?.content ? contentImagePaths(record.content) : new Set();
        const unresolvedAssets = [];
        if (record?.assets !== undefined) {
            if (!Array.isArray(record.assets)) throw new TypeError("Invalid recorded asset references.");
            for (const path of record.assets) {
                if (!imagePaths.has(path)) unresolvedAssets.push(path);
            }
        }
        return { imagePaths, unresolvedAssets };
    }

    function repositoryPathsForContent(content) {
        return new Set([
            ...[...contentImagePaths(content)].map((path) => `public${path}`),
            ...legal,
        ]);
    }

    function requireAllowedRepositoryPaths(paths, allowedPaths) {
        if (!Array.isArray(paths) || !(allowedPaths instanceof Set) ||
            paths.some((path) => typeof path !== "string" || !allowedPaths.has(path))) {
            identityUnavailable();
        }
        return paths;
    }

    return Object.freeze({
        findField,
        isFieldImagePath,
        isManagedImagePath,
        contentImagePaths,
        inspectRecordReferences,
        repositoryPathsForContent,
        requireAllowedRepositoryPaths,
    });
}
