import { CmsApiError } from "../http.js";
import { requireStagedMetadata, stagedCmsImageKey } from "./staged-images.js";
import { guardedDeleteStagedImage } from "./guarded-delete.js";

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function unavailable() {
    return new CmsApiError("REVISION_ASSET_UNAVAILABLE",
        "A historical CMS image could not be restored.", 502);
}

function contentTypeForPath(path) {
    if (/\.png$/i.test(path)) return "image/png";
    if (/\.webp$/i.test(path)) return "image/webp";
    return "image/jpeg";
}

async function readStagedMetadata(store, key) {
    const result = await store.getMetadata(key, { consistency: "strong" });
    if (result === null) return null;
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        typeof result.etag !== "string" || !result.etag ||
        !result.metadata || typeof result.metadata !== "object" ||
        Array.isArray(result.metadata)) {
        throw new CmsApiError("INVALID_STAGED_IMAGE", "The staged image metadata is invalid.", 500);
    }
    return result;
}

export function createCmsHistoricalImageRecovery({ store, github, assets } = {}) {
    if (typeof store?.getMetadata !== "function" || typeof store?.set !== "function" ||
        typeof store?.delete !== "function" ||
        typeof github?.readFileAtCommit !== "function" ||
        typeof assets?.contentImagePaths !== "function" ||
        typeof assets?.inspectRecordReferences !== "function" ||
        typeof assets?.repositoryPathsForContent !== "function" ||
        typeof assets?.requireAllowedRepositoryPaths !== "function") {
        throw new TypeError("Invalid CMS historical-image recovery configuration.");
    }

    return Object.freeze({
        async recover({ publicPath, snapshot, ensureActive } = {}) {
            if (!snapshot || typeof snapshot !== "object" ||
                !snapshot.content || typeof snapshot.content !== "object" ||
                typeof ensureActive !== "function") {
                throw new TypeError("A trusted historical snapshot and active lease are required.");
            }
            const commit = snapshot.commit ?? snapshot.sourceCommit ?? snapshot.revisionId;
            if (!COMMIT_SHA.test(commit)) throw unavailable();
            let key;
            try {
                key = stagedCmsImageKey(publicPath);
                if (assets.inspectRecordReferences(snapshot).unresolvedAssets.length ||
                    !assets.contentImagePaths(snapshot.content).has(publicPath)) {
                    throw unavailable();
                }
                assets.requireAllowedRepositoryPaths([`public${publicPath}`],
                    assets.repositoryPathsForContent(snapshot.content));
            } catch {
                throw unavailable();
            }
            const expectedType = contentTypeForPath(publicPath);
            const existing = await readStagedMetadata(store, key);
            if (existing) {
                const type = requireStagedMetadata(existing.metadata, publicPath);
                if (type !== expectedType) {
                    throw new CmsApiError("INVALID_STAGED_IMAGE",
                        "The staged image metadata is invalid.", 500);
                }
                return undefined;
            }

            let bytes;
            try { bytes = await github.readFileAtCommit(`public${publicPath}`, commit); }
            catch { throw unavailable(); }
            if (!Buffer.isBuffer(bytes)) throw unavailable();
            await ensureActive();
            const written = await store.set(key,
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
                    onlyIfNew: true,
                    metadata: { contentType: expectedType, publicPath,
                        restoredFrom: commit },
                });
            if (!written || typeof written.modified !== "boolean") throw unavailable();
            if (!written.modified) {
                const winner = await readStagedMetadata(store, key);
                if (!winner) throw unavailable();
                const type = requireStagedMetadata(winner.metadata, publicPath);
                if (type !== expectedType) {
                    throw new CmsApiError("INVALID_STAGED_IMAGE",
                        "The staged image metadata is invalid.", 500);
                }
                return undefined;
            }
            if (typeof written.etag !== "string" || !written.etag) throw unavailable();
            return async () => {
                const result = await guardedDeleteStagedImage({ store, key, publicPath,
                    expectedEtag: written.etag, ensureActive });
                if (!result.deleted) throw result.error;
            };
        },
    });
}
