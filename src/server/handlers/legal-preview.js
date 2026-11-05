import { createCmsEndpoint, requireMethod } from "../http.js";
import { isCmsHostPolicyBundle } from "../host-policies.js";
import { isCmsLegalService } from "../legal/service.js";

export function createCmsOptionalLegalPreviewHandlers({ bundle, legalService,
    renderHtml, previewCompatibility } = {}) {
    if (!isCmsHostPolicyBundle(bundle)) {
        throw new TypeError("A validated CMS host policy bundle is required.");
    }
    if (!bundle.legalAssetsEnabled) {
        if (legalService !== undefined || renderHtml !== undefined ||
            previewCompatibility !== undefined) {
            throw new TypeError("Legal preview requires a legal-enabled host.");
        }
        return Object.freeze({});
    }
    if (!isCmsLegalService(legalService) ||
        legalService.capability.assetBundle !== bundle ||
        typeof renderHtml !== "function") {
        throw new TypeError("Invalid CMS legal preview configuration.");
    }
    if (previewCompatibility !== undefined &&
        previewCompatibility !== "legacy") {
        throw new TypeError("Invalid CMS legal preview compatibility configuration.");
    }
    const reader = previewCompatibility
        ? legalService.createLegacyPreviewReader() : legalService;

    const legalPreview = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "GET");
        if (typeof actor?.id !== "string" || !actor.id.trim() ||
            typeof actor?.email !== "string" || !actor.email.trim()) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        const { searchParams } = new URL(request.url);
        const page = searchParams.get("page");
        const kind = searchParams.get("kind");
        const hash = searchParams.get("hash");
        if (kind === "pdf") {
            const bytes = await reader.readFile(page, kind, hash);
            return new Response(bytes, { headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": "inline",
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
            } });
        }
        const original = previewCompatibility === "legacy"
            ? legalService.initialPairs()[page]?.document : null;
        const document = original?.hash === hash ? original :
            await reader.entry(page, kind, hash);
        const html = await renderHtml(document, page);
        if (typeof html !== "string" || !html) {
            throw new TypeError("The legal preview renderer must return HTML.");
        }
        return new Response(html, { headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        } });
    });

    return Object.freeze({ legalPreview });
}
