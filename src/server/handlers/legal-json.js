import { cmsJsonResponse, createCmsEndpoint, readJsonRequest, requireMethod } from "../http.js";
import { isCmsHostPolicyBundle } from "../host-policies.js";
import { isCmsLegalService } from "../legal/service.js";

export function createCmsOptionalLegalJsonHandlers({ bundle, legalService, cleanup,
    foundation, canonicalContent, logger = console } = {}) {
    if (!isCmsHostPolicyBundle(bundle)) {
        throw new TypeError("A validated CMS host policy bundle is required.");
    }
    if (!bundle.legalAssetsEnabled) {
        if (legalService !== undefined || cleanup !== undefined) {
            throw new TypeError("Legal services require a legal-enabled host.");
        }
        return Object.freeze({});
    }
    if (!isCmsLegalService(legalService) ||
        legalService.capability.assetBundle !== bundle ||
        typeof legalService.previewUrl !== "function" ||
        typeof cleanup?.sweep !== "function" ||
        typeof foundation?.ensure !== "function" ||
        typeof canonicalContent !== "function" ||
        typeof logger?.error !== "function") {
        throw new TypeError("Invalid CMS legal handler configuration.");
    }

    function trustedActor(actor) {
        if (typeof actor?.id !== "string" || !actor.id.trim() ||
            typeof actor?.email !== "string" || !actor.email.trim()) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        return actor;
    }

    const uploadLegal = createCmsEndpoint(async ({ request, context, actor }) => {
        requireMethod(request, "POST");
        const user = trustedActor(actor);
        const form = await request.formData();
        const result = await legalService.stage({ page: form.get("page"),
            kind: form.get("kind"), file: form.get("file") }, user);
        const cleanupPromise = cleanup.sweep().catch((error) => {
            logger.error("Unable to sweep abandoned legal files.", error);
        });
        if (typeof context?.waitUntil === "function") {
            context.waitUntil(cleanupPromise);
        }
        return cmsJsonResponse(result, { status: 201 });
    });

    const legalReference = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "GET");
        trustedActor(actor);
        const { searchParams } = new URL(request.url);
        const page = searchParams.get("page");
        const kind = searchParams.get("kind");
        const hash = searchParams.get("hash");
        const original = legalService.initialPairs()[page]?.[kind];
        const metadata = original?.hash === hash ? original :
            await legalService.readMetadata(page, kind, hash);
        await legalService.readFile(page, kind, hash);
        return cmsJsonResponse({ name: metadata.name,
            previewUrl: legalService.previewUrl(page, kind, hash) });
    });

    const saveLegalDraft = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "POST");
        const body = await readJsonRequest(request);
        const user = trustedActor(actor);
        await foundation.ensure({ canonicalContent: await canonicalContent() });
        return cmsJsonResponse(await legalService.saveDraft(body, user));
    });

    const confirmLegal = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "POST");
        const body = await readJsonRequest(request);
        const user = trustedActor(actor);
        return cmsJsonResponse(await legalService.confirmPair(body, user));
    });

    return Object.freeze({ uploadLegal, legalReference, saveLegalDraft, confirmLegal });
}
