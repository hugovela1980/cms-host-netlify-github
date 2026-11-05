import { CmsApiError } from "../http.js";
import { requireExpectedDraftVersion, writeDraftIfVersion } from "./versioned-record.js";

// The host authorizes actor, validates the note, and supplies any legal defaults.
// Revert uses draft ETag CAS under the shared CMS mutation lease.
export function createCmsDraftRevertService({ records, content, validateNote,
    legalFromRecord, leases, now = () => new Date() } = {}) {
    if (!records || typeof records.read !== "function" ||
        typeof records.writeIfVersion !== "function" || !content ||
        typeof content.normalizePersisted !== "function" ||
        typeof content.validateCurrent !== "function" ||
        typeof validateNote !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" ||
        (legalFromRecord !== undefined && typeof legalFromRecord !== "function") ||
        typeof now !== "function") {
        throw new TypeError("Invalid CMS draft Revert configuration.");
    }

    return Object.freeze({
        async revert({ request, actor, confirmedFallbackContent } = {}) {
            if (!request || typeof request !== "object" || Array.isArray(request) ||
                !actor || typeof actor !== "object" ||
                typeof actor.email !== "string" || !actor.email ||
                !confirmedFallbackContent || typeof confirmedFallbackContent !== "object" ||
                Array.isArray(confirmedFallbackContent)) {
                throw new TypeError("Invalid CMS draft Revert input.");
            }
            const current = await records.read("draft");
            const expected = requireExpectedDraftVersion(request.expectedDraftVersion, current);
            const liveRecord = await records.read("confirmedLive");
            if (!liveRecord) {
                throw new CmsApiError("CMS_FOUNDATION_NOT_INITIALIZED",
                    "Initial PUBLIC CMS state has not been captured.", 503);
            }
            const live = {
                ...liveRecord.data,
                content: content.normalizePersisted(liveRecord.data.content, confirmedFallbackContent),
                version: liveRecord.etag ?? null,
            };
            const record = {
                content: live.content,
                ...(legalFromRecord ? { legal: legalFromRecord(live) } : {}),
                note: validateNote(request.note ?? current?.data?.note),
                updatedAt: now().toISOString(),
                updatedBy: actor.email,
                cleanupCandidates: current?.data?.cleanupCandidates ?? [],
                baseRevision: live.revisionId ?? null,
                sections: [],
                hasUnpublishedChanges: false,
            };
            content.validateCurrent(record.content);
            const draftVersion = await writeDraftIfVersion(records, record, expected, leases,
                undefined, { expectedLiveVersion: liveRecord.etag });
            return {
                draft: record.content,
                ...(legalFromRecord ? { legal: record.legal } : {}),
                draftVersion,
                hasSavedDraft: false,
                metadata: record,
            };
        },
    });
}
