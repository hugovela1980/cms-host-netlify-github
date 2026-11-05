import { randomUUID } from "node:crypto";
import { CmsApiError } from "../http.js";
import { withCmsMutationLease } from "../coordination/mutation.js";

const MIME_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
const SAFE_IMAGE_PATH = /^\/images\/(?:[a-z0-9-]+\/)+cms-[a-z0-9][a-z0-9-]*\.(?:jpe?g|png|webp)$/i;
const SIGNATURES = Object.freeze({
    "image/jpeg": { extension: "jpg", matches: (bytes) =>
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    "image/png": { extension: "png", matches: (bytes) =>
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
            .every((value, index) => bytes[index] === value) },
    "image/webp": { extension: "webp", matches: (bytes) =>
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" },
});

class NormalStagedMiss extends CmsApiError {
    constructor() {
        super("IMAGE_NOT_FOUND", "The staged image was not found.", 404);
    }
}

export function stagedCmsImageKey(publicPath) {
    if (!SAFE_IMAGE_PATH.test(publicPath)) {
        throw new CmsApiError("INVALID_IMAGE_PATH", "The image path is not CMS-managed.");
    }
    return `images/staged/${publicPath.split("/").at(-1)}`;
}

function requireStagedMetadata(metadata, publicPath) {
    if (metadata?.publicPath !== publicPath || !MIME_TYPES.includes(metadata?.contentType)) {
        throw new CmsApiError("INVALID_STAGED_IMAGE", "The staged image metadata is invalid.", 500);
    }
    return metadata.contentType;
}

export function createCmsManagedImageService({ store, assets, leases,
    maxBytes = 4 * 1024 * 1024,
    previewUrlForPath,
    now = () => new Date(), createId = randomUUID } = {}) {
    if (typeof store?.set !== "function" || typeof store?.getWithMetadata !== "function" ||
        typeof assets?.findField !== "function" ||
        typeof assets?.isFieldImagePath !== "function" ||
        typeof assets?.isManagedImagePath !== "function" ||
        typeof assets?.contentImagePaths !== "function" ||
        typeof leases?.acquire !== "function" ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
        typeof previewUrlForPath !== "function" ||
        typeof now !== "function" || typeof createId !== "function") {
        throw new TypeError("Invalid CMS managed-image configuration.");
    }

    function requirePreviewPath(publicPath, contentSnapshot) {
        if (assets.isManagedImagePath(publicPath)) return publicPath;
        if (contentSnapshot && assets.contentImagePaths(contentSnapshot).has(publicPath)) {
            stagedCmsImageKey(publicPath);
            return publicPath;
        }
        throw new CmsApiError("INVALID_IMAGE_PATH", "The image path is not CMS-managed.");
    }

    async function readStaged(publicPath, { contentSnapshot } = {}) {
        requirePreviewPath(publicPath, contentSnapshot);
        const result = await store.getWithMetadata(stagedCmsImageKey(publicPath), {
            type: "arrayBuffer", consistency: "strong",
        });
        if (result === null) {
            throw new NormalStagedMiss();
        }
        const contentType = requireStagedMetadata(result?.metadata, publicPath);
        if (!(result?.data instanceof ArrayBuffer)) {
            throw new CmsApiError("INVALID_STAGED_IMAGE", "The staged image bytes are invalid.", 500);
        }
        return { data: result.data, contentType };
    }

    return Object.freeze({
        async stage(upload, actor) {
            const field = upload && typeof upload === "object" ? assets.findField(upload) : null;
            if (!field) {
                throw new CmsApiError("IMAGE_FIELD_NOT_ALLOWED",
                    "This CMS field does not accept managed image uploads.", 403);
            }
            const file = upload?.file;
            if (!(file instanceof Blob) || typeof file.name !== "string") {
                throw new CmsApiError("IMAGE_REQUIRED", "Choose an image to upload.");
            }
            if (!file.name || file.name.length > 180 || file.name.includes("/") ||
                file.name.includes("\\") || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(file.name)) {
                throw new CmsApiError("INVALID_IMAGE_FILENAME", "The uploaded image filename is not safe.");
            }
            if (!MIME_TYPES.includes(file.type)) {
                throw new CmsApiError("INVALID_IMAGE_TYPE", "Choose a JPEG, PNG, or WebP image.", 415);
            }
            if (file.size === 0 || file.size > maxBytes) {
                throw new CmsApiError("INVALID_IMAGE_SIZE",
                    `Images must be no larger than ${maxBytes} bytes.`, 413);
            }
            if (typeof actor?.email !== "string" || !actor.email.trim()) {
                throw new TypeError("A trusted CMS actor is required.");
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            const signature = SIGNATURES[file.type];
            if (bytes.length !== file.size || !signature.matches(bytes)) {
                throw new CmsApiError("IMAGE_SIGNATURE_MISMATCH",
                    "The image contents do not match its declared type.", 415);
            }
            const timestamp = now();
            const id = createId().replaceAll("-", "").slice(0, 16);
            if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime()) ||
                !/^[0-9a-f]{16}$/i.test(id)) {
                throw new TypeError("Invalid managed-image ID or timestamp.");
            }
            const src = `${field.publicPathPrefix}cms-${timestamp.getTime().toString(36)}-${id}.${signature.extension}`;
            if (!assets.isFieldImagePath(field, src)) {
                throw new CmsApiError("INVALID_IMAGE_PATH", "The image path is not CMS-managed.");
            }
            const previewUrl = previewUrlForPath(src);
            if (typeof previewUrl !== "string" || !previewUrl) {
                throw new TypeError("Invalid managed-image preview URL.");
            }
            return withCmsMutationLease(leases, async (ensureActive) => {
                await ensureActive();
                const result = await store.set(stagedCmsImageKey(src), bytes.buffer, {
                    onlyIfNew: true,
                    metadata: { contentType: file.type, publicPath: src,
                        uploadedAt: timestamp.toISOString(), uploadedBy: actor.email },
                });
                if (result?.modified !== true) {
                    throw new CmsApiError("IMAGE_COLLISION",
                        "A unique image path could not be allocated. Try the upload again.", 409);
                }
                return { src, previewUrl };
            });
        },
        readStaged,
        async preview(publicPath, options) {
            requirePreviewPath(publicPath, options?.contentSnapshot);
            try {
                const image = await readStaged(publicPath, options);
                return new Response(image.data, { status: 200, headers: {
                    "Cache-Control": "private, no-store",
                    "Content-Type": image.contentType,
                    "Content-Length": String(image.data.byteLength),
                    "X-Content-Type-Options": "nosniff",
                } });
            } catch (error) {
                if (!(error instanceof NormalStagedMiss)) throw error;
                return new Response(null, { status: 307, headers: {
                    "Cache-Control": "private, no-store",
                    Location: publicPath,
                    "X-Content-Type-Options": "nosniff",
                } });
            }
        },
    });
}

export { requireStagedMetadata };
