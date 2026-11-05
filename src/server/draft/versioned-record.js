import { CmsApiError } from "../http.js";
import { withCmsMutationLease } from "../coordination/mutation.js";
import { requireDraftImageProofConfiguration,
    verifyNewDraftImageReferences } from "./image-references.js";
import { isCmsLegalService } from "../legal/service.js";

function conflict() {
    throw new CmsApiError("DRAFT_CONFLICT", "The draft changed. Reload it before trying again.", 409);
}

export function requireExpectedDraftVersion(value, current) {
    const expected = value === null || value === undefined ? null : String(value);
    if (expected !== (current?.etag ?? null)) conflict();
    return expected;
}

export async function writeDraftIfVersion(records, record, expectedVersion, leases,
    imageProof, { expectedLiveVersion } = {}) {
    return withCmsMutationLease(leases, async (ensureActive) => {
        if (expectedLiveVersion !== undefined) {
            await ensureActive();
            const live = await records.read("confirmedLive");
            if (!live?.etag || live.etag !== expectedLiveVersion) {
                throw new CmsApiError("CMS_STATE_CONFLICT",
                    "Confirmed PUBLIC state changed before the draft write.", 409);
            }
        }
        if (imageProof) await verifyNewDraftImageReferences({ records, record,
            ...imageProof, ensureActive });
        if (imageProof?.legalService) {
            await ensureActive();
            const [current, live] = await Promise.all([records.read("draft"),
                records.read("confirmedLive")]);
            await imageProof.legalService.proveNewReferences({ record, current, live,
                github: imageProof.github, ensureActive });
        }
        await ensureActive();
        const result = await records.writeIfVersion("draft", record, expectedVersion);
        if (!result.modified || !result.etag) conflict();
        return result.etag;
    });
}

export function readDraftRecordView(record, fallbackContent, content) {
    if (!fallbackContent || typeof fallbackContent !== "object" ||
        Array.isArray(fallbackContent)) {
        throw new TypeError("A content fallback must be supplied by the caller.");
    }
    const hasSavedDraft = Boolean(record) && record.data.hasUnpublishedChanges !== false;
    return {
        record,
        draftVersion: record?.etag ?? null,
        hasSavedDraft,
        workingContent: hasSavedDraft
            ? content.normalizePersisted(record.data.content, fallbackContent)
            : fallbackContent,
    };
}

// This core accepts records assembled by a trusted host service. It owns only
// draft version checks and the persisted-content working view.
export function createCmsDraftRecordService({ records, content, leases,
    store, github, assets, legalService } = {}) {
    if (!records || typeof records.read !== "function" ||
        typeof records.writeIfVersion !== "function" || !content ||
        typeof content.normalizePersisted !== "function" ||
        typeof content.validateCurrent !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" ||
        !requireDraftImageProofConfiguration({ store, github, assets }) ||
        (assets?.legalAssetsEnabled && (!isCmsLegalService(legalService) ||
            legalService.capability.assetBundle.assets !== assets))) {
        throw new TypeError("Invalid CMS draft-record configuration.");
    }

    return Object.freeze({
        async read({ fallbackContent } = {}) {
            if (!fallbackContent || typeof fallbackContent !== "object" ||
                Array.isArray(fallbackContent)) {
                throw new TypeError("A content fallback must be supplied by the caller.");
            }
            const record = await records.read("draft");
            return readDraftRecordView(record, fallbackContent, content);
        },
        async writePrepared({ record, expectedDraftVersion } = {}) {
            if (!record || typeof record !== "object" || Array.isArray(record) ||
                !Object.hasOwn(record, "content")) {
                throw new TypeError("A prepared CMS draft record with content is required.");
            }
            const current = await records.read("draft");
            const expected = requireExpectedDraftVersion(expectedDraftVersion, current);
            content.validateCurrent(record.content);
            return { draftVersion: await writeDraftIfVersion(records, record, expected, leases,
                { store, github, assets, legalService }) };
        },
    });
}
