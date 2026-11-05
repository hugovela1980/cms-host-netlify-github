import { CmsApiError } from "../http.js";
import { withCmsMutationLease } from "../coordination/mutation.js";
import { isCmsLegalService } from "../legal/service.js";

export const CMS_REVISION_PAGE_SIZE = 20;
export const CMS_BASELINE_REVISION_ID = "developer-baseline";

function conflict() {
    throw new CmsApiError("CMS_STATE_CONFLICT",
        "CMS history or confirmed PUBLIC state changed during Restore.", 409);
}

function requireBaseline(record) {
    if (!record?.data || typeof record.data !== "object" ||
        Array.isArray(record.data)) {
        throw new CmsApiError("CMS_FOUNDATION_NOT_INITIALIZED",
            "The immutable Developer baseline has not been captured.", 503);
    }
    return record;
}

function entriesFrom(record) {
    const entries = record?.data?.entries ?? (record ? null : []);
    if (!Array.isArray(entries) || entries.some((entry) =>
        !entry || typeof entry !== "object" ||
        typeof entry.id !== "string" || !entry.id)) conflict();
    return entries;
}

function representsLive(revision, live) {
    const commit = live?.commit ?? live?.revisionId;
    if (!commit) return false;
    if (revision.baseline === true || revision.id === CMS_BASELINE_REVISION_ID) {
        const source = revision.sourceCommit ?? revision.commit;
        return Boolean(source && source === commit);
    }
    return (revision.commit ?? revision.id) === commit;
}

function summary(revision, live) {
    return { id: revision.id, number: revision.number, title: revision.title,
        note: revision.note, date: revision.date,
        current: representsLive(revision, live) };
}

function baselineSummary(live, baseline) {
    const presentation = { id: CMS_BASELINE_REVISION_ID,
        title: "Developer baseline", note: "Original protected CMS baseline",
        date: baseline.confirmedAt ?? baseline.capturedAt ?? "", baseline: true };
    return { ...presentation, current: representsLive({ ...presentation,
        sourceCommit: baseline.sourceCommit ?? baseline.commit ?? null }, live) };
}

export function createCmsRevisionService({ records, bundle, historyPolicy,
    legalService, imageRecovery, legalRecovery, leases,
    now = () => new Date() } = {}) {
    if (typeof records?.read !== "function" ||
        typeof records?.writeIfVersion !== "function" ||
        typeof bundle?.content?.validateCurrent !== "function" ||
        typeof bundle?.assets?.contentImagePaths !== "function" ||
        typeof historyPolicy?.validateHistorical !== "function" ||
        typeof historyPolicy?.restoreContent !== "function" ||
        typeof historyPolicy?.describeRevision !== "function" ||
        typeof historyPolicy?.changedSections !== "function" ||
        typeof imageRecovery?.recover !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" || typeof now !== "function" ||
        (bundle.legalAssetsEnabled && (!isCmsLegalService(legalService) ||
            legalService.capability.assetBundle !== bundle ||
            typeof legalRecovery?.recover !== "function")) ||
        (!bundle.legalAssetsEnabled &&
            (legalService !== undefined || legalRecovery !== undefined))) {
        throw new TypeError("Invalid CMS revision configuration.");
    }
    const capability = legalService?.capability ?? null;

    function requireNoLegal(record) {
        if (!capability && record?.data && Object.hasOwn(record.data, "legal")) {
            conflict();
        }
    }

    function requireNoLegalHistory(record) {
        if (!capability && entriesFrom(record).some((entry) =>
            Object.hasOwn(entry, "legal"))) conflict();
    }

    function legalFrom(record) {
        if (!capability) {
            if (Object.hasOwn(record, "legal")) conflict();
            return null;
        }
        return legalService.legalFromRecord(record);
    }

    function snapshotFrom(id, source) {
        let entry;
        if (id === CMS_BASELINE_REVISION_ID) {
            const baseline = requireBaseline(source).data;
            entry = { ...baselineSummary(null, baseline), ...baseline,
                id: CMS_BASELINE_REVISION_ID, baseline: true };
        } else {
            entry = entriesFrom(source).find((candidate) => candidate.id === id);
            if (!entry) throw new CmsApiError("REVISION_NOT_FOUND",
                "The requested revision was not found.", 404);
        }
        const content = entry.content;
        historyPolicy.validateHistorical(structuredClone(content));
        const assets = [...bundle.assets.contentImagePaths(content)];
        const legal = legalFrom(entry);
        return { ...entry, content, ...(capability ? { legal } : {}), assets };
    }

    async function readSnapshot(id) {
        const sourceName = id === CMS_BASELINE_REVISION_ID ? "baseline" : "revisions";
        const source = await records.read(sourceName);
        if (sourceName === "baseline") requireNoLegal(source);
        else requireNoLegalHistory(source);
        return { sourceName, source, snapshot: snapshotFrom(id, source) };
    }

    function restoredContent(snapshot, live) {
        if (!live?.data?.content) conflict();
        const content = historyPolicy.restoreContent(structuredClone(snapshot.content),
            structuredClone(live.data.content));
        bundle.content.validateCurrent(content);
        return content;
    }

    async function list({ page = 1, head, highlightedRevision } = {}) {
        const [record, live, baselineRecord] = await Promise.all([
            records.read("revisions"), records.read("confirmedLive"),
            records.read("baseline"),
        ]);
        const baseline = requireBaseline(baselineRecord).data;
        const entries = entriesFrom(record);
        requireNoLegal(baselineRecord);
        requireNoLegal(live);
        requireNoLegalHistory(record);
        const currentHead = entries[0]?.id ?? CMS_BASELINE_REVISION_ID;
        if (head && head !== currentHead) {
            throw new CmsApiError("REVISION_HISTORY_CHANGED",
                "Revision history changed. Reload the first page.", 409);
        }
        const pageNumber = Number(page);
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
            throw new CmsApiError("INVALID_PAGE",
                "Revision page must be a positive integer.");
        }
        const start = (pageNumber - 1) * CMS_REVISION_PAGE_SIZE;
        const liveData = live?.data ?? null;
        const highlighted = highlightedRevision
            ? entries.find(({ id }) => id === highlightedRevision) : null;
        return { baseline: baselineSummary(liveData, baseline),
            revisions: entries.slice(start, start + CMS_REVISION_PAGE_SIZE)
                .map((entry) => summary(entry, liveData)),
            head: currentHead,
            nextPage: start + CMS_REVISION_PAGE_SIZE < entries.length
                ? pageNumber + 1 : null,
            ...(highlighted ? { highlighted: summary(highlighted, liveData) } : {}) };
    }

    async function view(id) {
        const [{ snapshot, sourceName }, draft, live] = await Promise.all([
            readSnapshot(id), records.read("draft"), records.read("confirmedLive"),
        ]);
        requireNoLegal(draft);
        requireNoLegal(live);
        if (!capability) {
            const otherName = sourceName === "baseline" ? "revisions" : "baseline";
            const other = await records.read(otherName);
            if (otherName === "baseline") requireNoLegal(other);
            else requireNoLegalHistory(other);
        }
        const content = restoredContent(snapshot, live);
        const legal = legalFrom(snapshot);
        const description = historyPolicy.describeRevision(content, legal);
        if (!description || typeof description !== "object" ||
            !description.values || typeof description.values !== "object" ||
            Array.isArray(description.values) ||
            !description.fieldLabels || typeof description.fieldLabels !== "object" ||
            Array.isArray(description.fieldLabels)) {
            throw new TypeError("Invalid CMS revision description.");
        }
        return { revision: { ...summary(snapshot, live?.data ?? null),
            baseline: snapshot.baseline === true,
            values: description.values, fieldLabels: description.fieldLabels,
            ...(capability ? { legal } : {}) }, draftVersion: draft?.etag ?? null };
    }

    async function restore({ id, expectedDraftVersion, actor } = {}) {
        if (typeof actor?.email !== "string" || !actor.email.trim()) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        const initial = await readSnapshot(id);
        const otherName = initial.sourceName === "baseline" ? "revisions" : "baseline";
        const [draft, live, other] = await Promise.all([
            records.read("draft"), records.read("confirmedLive"),
            ...(!capability ? [records.read(otherName)] : []),
        ]);
        requireNoLegal(draft);
        requireNoLegal(live);
        if (!capability) {
            if (otherName === "baseline") requireNoLegal(other);
            else requireNoLegalHistory(other);
        }
        if (representsLive(initial.snapshot, live?.data)) {
            throw new CmsApiError("REVISION_ALREADY_CURRENT",
                "This revision is already published.", 409);
        }
        const expected = expectedDraftVersion ?? null;
        if ((draft?.etag ?? null) !== expected) {
            throw new CmsApiError("DRAFT_CONFLICT",
                "The draft changed. Reload before restoring.", 409);
        }
        // The lease wrapper reports a lost lease after the operation returns.
        // Preserve an incomplete-rollback error when that loss also prevented
        // removal of files newly staged by this Restore.
        let cleanupFailure;
        try {
            return await withCmsMutationLease(leases, async (ensureActive) => {
            await ensureActive();
            const [sourceNow, draftNow, liveNow, otherNow] = await Promise.all([
                records.read(initial.sourceName), records.read("draft"),
                records.read("confirmedLive"),
                ...(!capability ? [records.read(otherName)] : []),
            ]);
            requireNoLegal(draftNow);
            requireNoLegal(liveNow);
            if (!capability) {
                if (otherName === "baseline") requireNoLegal(otherNow);
                else requireNoLegalHistory(otherNow);
                if ((otherNow?.etag ?? null) !== (other?.etag ?? null)) conflict();
            }
            if ((draftNow?.etag ?? null) !== expected ||
                (draftNow?.etag ?? null) !== (draft?.etag ?? null)) {
                throw new CmsApiError("DRAFT_CONFLICT",
                    "The draft changed. Reload before restoring.", 409);
            }
            if ((sourceNow?.etag ?? null) !== (initial.source?.etag ?? null) ||
                (liveNow?.etag ?? null) !== (live?.etag ?? null)) conflict();
            const snapshot = snapshotFrom(id, sourceNow);
            if (representsLive(snapshot, liveNow?.data)) {
                throw new CmsApiError("REVISION_ALREADY_CURRENT",
                    "This revision is already published.", 409);
            }
            const content = restoredContent(snapshot, liveNow);
            const legal = legalFrom(snapshot);
            const rollback = [];
            try {
                if (capability) {
                    for (const page of Object.keys(capability.pages)) {
                        for (const kind of ["document", "pdf"]) {
                            await ensureActive();
                            const undo = await legalRecovery.recover({ snapshot,
                                page, kind, ensureActive });
                            if (typeof undo === "function") rollback.push(undo);
                        }
                    }
                }
                for (const publicPath of bundle.assets.contentImagePaths(snapshot.content)) {
                    await ensureActive();
                    const undo = await imageRecovery.recover({ publicPath,
                        snapshot, ensureActive });
                    if (typeof undo === "function") rollback.push(undo);
                }
                const previousAssets = draftNow?.data?.content
                    ? bundle.assets.contentImagePaths(draftNow.data.content) : new Set();
                const restoredAssets = bundle.assets.contentImagePaths(content);
                const timestamp = now();
                if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
                    throw new TypeError("Invalid CMS Restore time.");
                }
                const record = { content, ...(capability ? { legal } : {}),
                    note: "", updatedAt: timestamp.toISOString(),
                    updatedBy: actor.email,
                    cleanupCandidates: [...new Set([
                        ...(draftNow?.data?.cleanupCandidates ?? []),
                        ...[...previousAssets].filter((path) => !restoredAssets.has(path)),
                    ])],
                    sections: historyPolicy.changedSections(content, liveNow.data.content),
                    baseRevision: liveNow.data.revisionId ?? CMS_BASELINE_REVISION_ID,
                    restoredFrom: id, hasUnpublishedChanges: true };
                await ensureActive();
                const result = await records.writeIfVersion("draft", record, expected);
                if (!result?.modified || typeof result.etag !== "string" || !result.etag) {
                    throw new CmsApiError("DRAFT_CONFLICT",
                        "The draft changed. Reload before restoring.", 409);
                }
                return { draft: record.content, draftVersion: result.etag };
            } catch (error) {
                const failures = [];
                for (const undo of rollback.reverse()) {
                    try { await ensureActive(); await undo(); }
                    catch (failure) { failures.push(failure); }
                }
                if (failures.length) {
                    cleanupFailure = new CmsApiError("RESTORE_CLEANUP_FAILED",
                        "Restore failed and some newly staged files could not be removed.",
                        502, { originalCode: error?.code ?? "RESTORE_FAILED",
                            count: failures.length });
                    throw cleanupFailure;
                }
                throw error;
            }
            });
        } catch (error) {
            if (cleanupFailure) throw cleanupFailure;
            throw error;
        }
    }

    return Object.freeze({ list, view, restore });
}
