import { cmsJsonResponse, createCmsEndpoint, requireMethod } from "../http.js";

export function createCmsManagedImageHandlers({ images, cleanup, logger = console } = {}) {
    if (typeof images?.stage !== "function" || typeof images?.preview !== "function" ||
        typeof cleanup?.sweep !== "function" || typeof logger?.error !== "function") {
        throw new TypeError("Invalid CMS managed-image handler configuration.");
    }

    function trustedActor(actor) {
        if (typeof actor?.id !== "string" || !actor.id.trim() ||
            typeof actor?.email !== "string" || !actor.email.trim()) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        return actor;
    }

    const uploadImage = createCmsEndpoint(async ({ request, context, actor }) => {
        requireMethod(request, "POST");
        const user = trustedActor(actor);
        const form = await request.formData();
        const result = await images.stage({
            sectionPath: form.get("sectionPath"),
            schemaId: form.get("schemaId"),
            fieldKey: form.get("fieldKey"),
            file: form.get("file"),
        }, user);

        const cleanupPromise = Promise.resolve().then(() => cleanup.sweep({
            onDeleteError(error, publicPath) {
                logger.error("Unable to delete abandoned CMS image.", {
                    publicPath, error,
                });
            },
        })).catch((error) => {
            logger.error("Unable to sweep abandoned CMS images.", error);
        });
        if (typeof context?.waitUntil === "function") {
            try {
                context.waitUntil(cleanupPromise);
            } catch (error) {
                logger.error("Unable to schedule abandoned CMS image cleanup.", error);
            }
        }
        return cmsJsonResponse(result, { status: 201 });
    });

    const draftImage = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "GET");
        trustedActor(actor);
        const path = new URL(request.url).searchParams.get("path");
        return images.preview(path);
    });

    return Object.freeze({ uploadImage, draftImage });
}
