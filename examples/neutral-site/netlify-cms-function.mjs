// Keep this helper outside netlify/functions. Only the site's bound Function
// entry file belongs there; it supplies CMS configuration and authentication.
export const config = Object.freeze({ path: "/neutral/cms/*" });

export const ROUTES = Object.freeze({
    draft: "draft",
    "save-draft": "saveDraft",
    "revert-draft": "revertDraft",
    "upload-image": "uploadImage",
    "draft-image": "draftImage",
    publish: "publish",
    publication: "publication",
    revisions: "revisions",
    revision: "revision",
    "restore-revision": "restoreRevision",
    "upload-legal": "uploadLegal",
    "legal-reference": "legalReference",
    "save-legal-draft": "saveLegalDraft",
    "confirm-legal": "confirmLegal",
    "legal-preview": "legalPreview",
});

export function createNeutralCmsFunction(siteConfig, authenticate, createHandlers) {
    if (typeof authenticate !== "function" || typeof createHandlers !== "function") {
        throw new TypeError("Host authentication and handler composition are required.");
    }
    const handlersPromise = Promise.resolve(createHandlers(siteConfig, authenticate));
    return async (request, context) => {
        const pathname = new URL(request.url).pathname;
        const match = /^\/neutral\/cms\/([^/]+)$/.exec(pathname);
        const name = match && ROUTES[match[1]];
        if (!name) return new Response(null, { status: 404 });
        const handlers = await handlersPromise;
        const handler = handlers[name];
        return handler ? handler({ request, context }) :
            new Response(null, { status: 404 });
    };
}
