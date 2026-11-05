import { CmsApiError } from "../http.js";
import { requireStagedMetadata } from "./staged-images.js";

function changed() {
    throw new CmsApiError("CMS_STATE_CONFLICT",
        "The staged image changed before it could be removed.", 409);
}

// Netlify Blobs has no conditional delete. The shared CMS lease excludes all
// cooperating writers; the strong ETag/path check narrows the remaining gap.
export async function guardedDeleteStagedImage({ store, key, publicPath,
    expectedEtag, ensureActive }) {
    if (typeof store?.getMetadata !== "function" || typeof store?.delete !== "function" ||
        typeof key !== "string" || !key ||
        typeof publicPath !== "string" || !publicPath ||
        typeof expectedEtag !== "string" || !expectedEtag ||
        typeof ensureActive !== "function") {
        throw new TypeError("Invalid guarded staged-image deletion.");
    }
    await ensureActive();
    const current = await store.getMetadata(key, { consistency: "strong" });
    if (!current || typeof current !== "object" || Array.isArray(current) ||
        typeof current.etag !== "string" || !current.etag ||
        current.etag !== expectedEtag) changed();
    requireStagedMetadata(current.metadata, publicPath);
    await ensureActive();
    try {
        await store.delete(key);
        return { deleted: true };
    } catch (error) {
        return { deleted: false, error };
    }
}
