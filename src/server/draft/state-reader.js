import { CmsApiError } from "../http.js";
import { publicPublicationStatus } from "../publication/status.js";
import { readDraftRecordView } from "./versioned-record.js";

// Reads a draft response from independently versioned records. The caller
// supplies the checkout fallback and any site-owned legal defaults.
export function createCmsDraftStateReader({ records, content, legalFromRecord } = {}) {
    if (!records || typeof records.read !== "function" || !content ||
        typeof content.normalizePersisted !== "function" ||
        (legalFromRecord !== undefined && typeof legalFromRecord !== "function")) {
        throw new TypeError("Invalid CMS draft-state reader configuration.");
    }

    return Object.freeze({
        async read({ confirmedFallbackContent } = {}) {
            if (!confirmedFallbackContent || typeof confirmedFallbackContent !== "object" ||
                Array.isArray(confirmedFallbackContent)) {
                throw new TypeError("A confirmed-live content fallback must be supplied by the caller.");
            }
            const [draftRecord, liveRecord, publicationRecord] = await Promise.all([
                records.read("draft"),
                records.read("confirmedLive"),
                records.read("publication"),
            ]);
            if (!liveRecord) {
                throw new CmsApiError("CMS_FOUNDATION_NOT_INITIALIZED",
                    "Initial PUBLIC CMS state has not been captured.", 503);
            }
            const live = {
                ...liveRecord.data,
                content: content.normalizePersisted(liveRecord.data.content, confirmedFallbackContent),
                version: liveRecord.etag ?? null,
            };
            const draft = readDraftRecordView(draftRecord, live.content, content);
            return {
                draft: draft.workingContent,
                draftVersion: draft.draftVersion,
                hasSavedDraft: draft.hasSavedDraft,
                metadata: draftRecord ? {
                    note: draftRecord.data.note ?? "",
                    updatedAt: draftRecord.data.updatedAt ?? null,
                    updatedBy: draftRecord.data.updatedBy ?? null,
                } : null,
                published: live.content,
                ...(legalFromRecord ? {
                    legal: legalFromRecord(draft.hasSavedDraft ? draftRecord.data : live),
                    publishedLegal: legalFromRecord(live),
                } : {}),
                confirmedRevision: live.revisionId ?? null,
                publicationStatus: publicPublicationStatus(publicationRecord?.data),
            };
        },
    });
}
