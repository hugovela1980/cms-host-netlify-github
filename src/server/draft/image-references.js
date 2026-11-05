import { CmsApiError } from "../http.js";
import { requireStagedMetadata, stagedCmsImageKey } from "../assets/staged-images.js";

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const BLOB_SHA = /^[0-9a-f]{40}$/i;

function unavailable() {
    throw new CmsApiError("MANAGED_ASSET_IDENTITY_UNAVAILABLE",
        "A newly referenced managed image could not be verified.", 502);
}

export function requireDraftImageProofConfiguration({ store, github, assets } = {}) {
    return typeof store?.getMetadata === "function" &&
        typeof github?.readManagedAssetBlobIdentitiesAtCommit === "function" &&
        typeof assets?.contentImagePaths === "function" &&
        typeof assets?.isManagedImagePath === "function";
}

// Called inside the same lease as the conditional draft write. Existing durable
// references are protected by cleanup's inventory; additions need exact proof.
export async function verifyNewDraftImageReferences({ records, record, store, github,
    assets, ensureActive }) {
    const next = assets.contentImagePaths(record.content);
    if (!(next instanceof Set)) unavailable();
    const current = await records.read("draft");
    const existing = current?.data?.content
        ? assets.contentImagePaths(current.data.content) : new Set();
    if (!(existing instanceof Set)) unavailable();
    const additions = [...next].filter((path) => !existing.has(path));
    if (!additions.length) return;
    const live = await records.read("confirmedLive");
    if (!live?.data?.content) unavailable();
    const livePaths = assets.contentImagePaths(live.data.content);
    if (!(livePaths instanceof Set)) unavailable();
    const commit = live.data.commit ?? live.data.revisionId;
    for (const publicPath of additions) {
        if (!assets.isManagedImagePath(publicPath)) unavailable();
        if (livePaths.has(publicPath)) continue;
        let key;
        try { key = stagedCmsImageKey(publicPath); }
        catch { unavailable(); }
        await ensureActive();
        const staged = await store.getMetadata(key, { consistency: "strong" });
        if (staged !== null) {
            if (!staged || typeof staged.etag !== "string" || !staged.etag ||
                !staged.metadata || typeof staged.metadata !== "object" ||
                Array.isArray(staged.metadata)) unavailable();
            try { requireStagedMetadata(staged.metadata, publicPath); }
            catch { unavailable(); }
            continue;
        }
        if (!COMMIT_SHA.test(commit)) unavailable();
        await ensureActive();
        let identities;
        try {
            identities = await github.readManagedAssetBlobIdentitiesAtCommit(
                [`public${publicPath}`], commit, { content: record.content });
        } catch { unavailable(); }
        const identity = identities instanceof Map ? identities.get(`public${publicPath}`) : null;
        if (!identity || !BLOB_SHA.test(identity.sha) ||
            !Number.isSafeInteger(identity.size) || identity.size < 0) unavailable();
    }
}
