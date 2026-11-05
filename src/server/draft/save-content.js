import { CmsApiError } from "../http.js";
import { requireExpectedDraftVersion, writeDraftIfVersion } from "./versioned-record.js";
import { requireDraftImageProofConfiguration } from "./image-references.js";

// Content-only Save Draft. The host validates editable fields, changed sections,
// cleanup candidates, notes, and any optional legal defaults.
export function createCmsContentDraftSaveService({ records, content, applyContentChanges,
    deriveSections, validateNote, validateCleanupCandidates, legalFromRecord,
    leases, store, github, assets, now = () => new Date() } = {}) {
    if (!records || typeof records.read !== "function" ||
        typeof records.writeIfVersion !== "function" || !content ||
        typeof content.normalizePersisted !== "function" ||
        typeof content.validateCurrent !== "function" ||
        typeof applyContentChanges !== "function" ||
        typeof deriveSections !== "function" ||
        typeof validateNote !== "function" ||
        typeof validateCleanupCandidates !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" ||
        !requireDraftImageProofConfiguration({ store, github, assets }) ||
        (legalFromRecord !== undefined && typeof legalFromRecord !== "function") ||
        typeof now !== "function") {
        throw new TypeError("Invalid CMS content draft Save configuration.");
    }

    return Object.freeze({
        async save({ request, actor, confirmedFallbackContent } = {}) {
            if (!request || typeof request !== "object" || Array.isArray(request) ||
                !actor || typeof actor !== "object" ||
                typeof actor.email !== "string" || !actor.email ||
                !confirmedFallbackContent || typeof confirmedFallbackContent !== "object" ||
                Array.isArray(confirmedFallbackContent)) {
                throw new TypeError("Invalid CMS content draft Save input.");
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
            const hasUnpublishedDraft = Boolean(current) &&
                current.data.hasUnpublishedChanges !== false;
            const source = hasUnpublishedDraft ? current.data.content : live.content;
            if (!Array.isArray(request.changes) || request.changes.length === 0) {
                throw new CmsApiError("NO_CHANGES", "At least one CMS change is required.");
            }
            const nextContent = applyContentChanges(source, request.changes, live.content);
            content.validateCurrent(nextContent);
            const legal = legalFromRecord
                ? legalFromRecord(hasUnpublishedDraft ? current.data : live) : undefined;
            const note = validateNote(request.saveData?.note ?? current?.data?.note);
            const cleanupCandidates = validateCleanupCandidates(request.cleanupCandidates);
            const sections = deriveSections(request.changes);
            if (!Array.isArray(cleanupCandidates) || !Array.isArray(sections)) {
                throw new TypeError("Invalid CMS content draft Save policy result.");
            }
            const record = {
                content: nextContent,
                ...(legalFromRecord ? { legal } : {}),
                note,
                updatedAt: now().toISOString(),
                updatedBy: actor.email,
                cleanupCandidates: [...new Set([
                    ...(current?.data?.cleanupCandidates ?? []),
                    ...cleanupCandidates,
                ])],
                sections,
                baseRevision: hasUnpublishedDraft
                    ? current.data.baseRevision ?? null : live.revisionId ?? null,
                hasUnpublishedChanges: true,
            };
            const draftVersion = await writeDraftIfVersion(records, record, expected, leases,
                { store, github, assets });
            return {
                draft: nextContent,
                ...(legalFromRecord ? { legal } : {}),
                draftVersion,
                hasSavedDraft: true,
                metadata: record,
            };
        },
    });
}
