import { CmsApiError } from "../http.js";
import { withCmsMutationLease } from "../coordination/mutation.js";
import { inventoryDurableAssetReferences } from "./durable-references.js";
import { guardedDeleteStagedImage } from "./guarded-delete.js";
import { requireStagedMetadata, stagedCmsImageKey } from "./staged-images.js";

export const STAGED_IMAGE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const STAGED_IMAGE_MAX_SCAN_COUNT = 100;
export const STAGED_IMAGE_MAX_DELETE_COUNT = 50;
const ROOTS = ["draft", "baseline", "confirmedLive", "publication", "revisions"];

function incomplete() {
    throw new CmsApiError("CMS_ASSET_REFERENCES_INCOMPLETE",
        "CMS asset cleanup could not verify durable image references.", 503);
}

function changed() {
    throw new CmsApiError("CMS_STATE_CONFLICT",
        "Staged image state changed during cleanup.", 409);
}

function validEtag(value) {
    return typeof value === "string" && value.length > 0;
}

export function createCmsManagedImageCleanup({ store, records, assets, leases,
    now = () => new Date() } = {}) {
    if (typeof store?.getMetadata !== "function" || typeof store?.delete !== "function" ||
        typeof store?.list !== "function" || typeof records?.read !== "function" ||
        typeof assets?.contentImagePaths !== "function" ||
        typeof assets?.isManagedImagePath !== "function" ||
        typeof leases?.acquire !== "function" || typeof now !== "function") {
        throw new TypeError("Invalid CMS managed-image cleanup configuration.");
    }

    async function inventory() {
        const entries = await Promise.all(ROOTS.map((name) => records.read(name)));
        const roots = Object.fromEntries(ROOTS.map((name, index) =>
            [name, entries[index]?.data ?? null]));
        const result = inventoryDurableAssetReferences(roots, assets);
        if (result.errors.length || result.unresolvedAssets.length) incomplete();
        const protectedKeys = new Set([...result.protectedPaths].map(stagedCmsImageKey));
        return { ...result, protectedKeys };
    }

    async function strongMetadata(key) {
        const value = await store.getMetadata(key, { consistency: "strong" });
        if (value === null) return null;
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            !validEtag(value.etag) || !value.metadata ||
            typeof value.metadata !== "object" || Array.isArray(value.metadata)) {
            changed();
        }
        return value;
    }

    async function cleanupCandidates(candidates, { ensureActive } = {}) {
        if (!Array.isArray(candidates) || typeof ensureActive !== "function") {
            throw new TypeError("Candidates and the active publication lease are required.");
        }
        if (!candidates.length) return [];
        await ensureActive();
        const { protectedPaths, protectedKeys } = await inventory();
        const deleted = [];
        for (const publicPath of new Set(candidates)) {
            if (!assets.isManagedImagePath(publicPath) || protectedPaths.has(publicPath)) continue;
            const key = stagedCmsImageKey(publicPath);
            if (protectedKeys.has(key)) continue;
            await ensureActive();
            const stored = await strongMetadata(key);
            if (!stored) continue;
            requireStagedMetadata(stored.metadata, publicPath);
            const result = await guardedDeleteStagedImage({ store, key, publicPath,
                expectedEtag: stored.etag, ensureActive });
            if (!result.deleted) throw result.error;
            deleted.push(publicPath);
        }
        return deleted;
    }

    async function sweep({ maxScanned = STAGED_IMAGE_MAX_SCAN_COUNT,
        maxDeletions = STAGED_IMAGE_MAX_DELETE_COUNT,
        onDeleteError = () => {} } = {}) {
        if (!Number.isSafeInteger(maxScanned) || maxScanned < 1 ||
            maxScanned > STAGED_IMAGE_MAX_SCAN_COUNT ||
            !Number.isSafeInteger(maxDeletions) || maxDeletions < 1 ||
            maxDeletions > STAGED_IMAGE_MAX_DELETE_COUNT ||
            typeof onDeleteError !== "function") {
            throw new TypeError("Invalid staged-image sweep bounds.");
        }
        const current = now();
        if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
            throw new TypeError("Invalid staged-image sweep time.");
        }
        let entered = false;
        try {
            return await withCmsMutationLease(leases, async (ensureActive) => {
                entered = true;
                await ensureActive();
                const { protectedPaths, protectedKeys } = await inventory();
                const result = { scanned: 0, deletionAttempts: 0, deleted: [], failed: [] };
                scanPages:
                for await (const page of store.list({ prefix: "images/staged/", paginate: true })) {
                    if (!page || !Array.isArray(page.blobs)) changed();
                    for (const blob of page.blobs) {
                        if (result.scanned >= maxScanned) break scanPages;
                        result.scanned += 1;
                        if (!blob || typeof blob.key !== "string" ||
                            !blob.key.startsWith("images/staged/") || !validEtag(blob.etag)) {
                            changed();
                        }
                        let stored;
                        try { stored = await strongMetadata(blob.key); }
                        catch (error) {
                            if (error?.code === "CMS_STATE_CONFLICT") throw error;
                            continue;
                        }
                        if (!stored || stored.etag !== blob.etag) changed();
                        const metadata = stored.metadata;
                        const publicPath = metadata.publicPath;
                        if (!assets.isManagedImagePath(publicPath)) continue;
                        if (stagedCmsImageKey(publicPath) !== blob.key) continue;
                        try { requireStagedMetadata(metadata, publicPath); }
                        catch { continue; }
                        if (typeof metadata.uploadedBy !== "string" ||
                            !metadata.uploadedBy.trim() ||
                            typeof metadata.uploadedAt !== "string") continue;
                        const uploadedTime = Date.parse(metadata.uploadedAt);
                        if (!Number.isFinite(uploadedTime) || uploadedTime > current.getTime() ||
                            current.getTime() - uploadedTime < STAGED_IMAGE_MIN_AGE_MS ||
                            protectedPaths.has(publicPath) ||
                            protectedKeys.has(blob.key)) continue;
                        if (result.deletionAttempts >= maxDeletions) break scanPages;
                        result.deletionAttempts += 1;
                        const outcome = await guardedDeleteStagedImage({ store,
                            key: blob.key, publicPath, expectedEtag: stored.etag,
                            ensureActive });
                        if (outcome.deleted) result.deleted.push(publicPath);
                        else {
                            result.failed.push(publicPath);
                            onDeleteError(outcome.error, publicPath);
                        }
                    }
                }
                return result;
            }, { kind: "asset-cleanup" });
        } catch (error) {
            if (error?.code === "CMS_STATE_LOCKED" && !entered) {
                return { skipped: true, reason: "busy" };
            }
            throw error;
        }
    }

    return Object.freeze({ cleanupCandidates, sweep });
}
