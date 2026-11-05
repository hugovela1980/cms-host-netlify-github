import { cmsJsonResponse, createCmsEndpoint, readJsonRequest, requireMethod } from "../http.js";
import { publicPublicationStatus } from "../publication/status.js";

const RECORD_NAMES = ["draft", "confirmedLive", "baseline", "publication", "revisions"];

// Authentication belongs to the host. Only its wrapper may supply actor.
export function createCmsCoreJsonHandlers({ records, bundle, foundation,
    canonicalContent, draftState, draftSave, draftRevert, publication,
    revisions } = {}) {
    if (typeof records?.read !== "function" ||
        typeof bundle?.legalAssetsEnabled !== "boolean" ||
        typeof foundation?.ensure !== "function" ||
        typeof canonicalContent !== "function" ||
        typeof draftState?.read !== "function" ||
        typeof draftSave?.save !== "function" ||
        typeof draftRevert?.revert !== "function" ||
        typeof publication?.start !== "function" ||
        typeof publication?.refresh !== "function" ||
        typeof revisions?.list !== "function" ||
        typeof revisions?.view !== "function" ||
        typeof revisions?.restore !== "function") {
        throw new TypeError("Invalid CMS core handler configuration.");
    }
    const legalEnabled = bundle.legalAssetsEnabled;

    function assertCompatibleResult(result, { draft = false, revision = false } = {}) {
        if (!legalEnabled && result && (Object.hasOwn(result, "legal") ||
            (draft && Object.hasOwn(result, "publishedLegal")) ||
            (revision && result.revision && Object.hasOwn(result.revision, "legal")))) {
            throw new TypeError("Legal CMS responses require a legal capability.");
        }
        return result;
    }

    async function assertCompatibleState() {
        if (legalEnabled) return;
        const stored = await Promise.all(RECORD_NAMES.map((name) => records.read(name)));
        const hasLegal = stored.some((record, index) => {
            if (record?.data && Object.hasOwn(record.data, "legal")) return true;
            if (RECORD_NAMES[index] === "publication" && record?.data?.draft &&
                Object.hasOwn(record.data.draft, "legal")) return true;
            return RECORD_NAMES[index] === "revisions" &&
                Array.isArray(record?.data?.entries) && record.data.entries.some(
                    (entry) => entry && Object.hasOwn(entry, "legal"));
        });
        if (hasLegal) {
            throw new TypeError("Legal CMS records require a legal capability.");
        }
    }

    async function ensureFoundation() {
        await assertCompatibleState();
        const content = await canonicalContent();
        await foundation.ensure({ canonicalContent: content });
        return content;
    }

    function trustedActor(actor) {
        if (typeof actor?.email !== "string" || !actor.email.trim() ||
            typeof actor?.id !== "string" || !actor.id.trim()) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        return actor;
    }

    const draft = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "GET");
        trustedActor(actor);
        const confirmedFallbackContent = await ensureFoundation();
        return cmsJsonResponse(assertCompatibleResult(
            await draftState.read({ confirmedFallbackContent }), { draft: true }));
    });

    const saveDraft = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "POST");
        const body = await readJsonRequest(request);
        const user = trustedActor(actor);
        const confirmedFallbackContent = await ensureFoundation();
        return cmsJsonResponse(assertCompatibleResult(await draftSave.save({
            request: body, actor: user, confirmedFallbackContent })));
    });

    const revertDraft = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "POST");
        const body = await readJsonRequest(request);
        const user = trustedActor(actor);
        const confirmedFallbackContent = await ensureFoundation();
        return cmsJsonResponse(assertCompatibleResult(await draftRevert.revert({
            request: body, actor: user, confirmedFallbackContent })));
    });

    const publish = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "POST");
        const body = await readJsonRequest(request);
        const user = trustedActor(actor);
        await ensureFoundation();
        const result = await publication.start({ expectedDraftVersion: body.expectedDraftVersion,
            actor: user });
        return cmsJsonResponse({ publication: publicPublicationStatus(result) }, { status: 202 });
    });

    const publicationStatus = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "GET");
        trustedActor(actor);
        await assertCompatibleState();
        return cmsJsonResponse({ publication: publicPublicationStatus(
            await publication.refresh()) });
    });

    const revisionList = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "GET");
        trustedActor(actor);
        await ensureFoundation();
        const parameters = new URL(request.url).searchParams;
        return cmsJsonResponse(await revisions.list({
            page: parameters.get("page") ?? 1,
            head: parameters.get("head") || undefined,
            highlightedRevision: parameters.get("highlightedRevision") || undefined,
        }));
    });

    const revision = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "GET");
        trustedActor(actor);
        const id = new URL(request.url).searchParams.get("id");
        await ensureFoundation();
        return cmsJsonResponse(assertCompatibleResult(await revisions.view(id),
            { revision: true }));
    });

    const restoreRevision = createCmsEndpoint(async ({ request, actor }) => {
        requireMethod(request, "POST");
        const body = await readJsonRequest(request);
        const user = trustedActor(actor);
        await ensureFoundation();
        return cmsJsonResponse(await revisions.restore({ id: body.id,
            expectedDraftVersion: body.expectedDraftVersion, actor: user }));
    });

    return Object.freeze({ draft, saveDraft, revertDraft, publish,
        publication: publicationStatus, revisions: revisionList, revision,
        restoreRevision });
}
