import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CmsApiError } from "../http.js";
import { isCmsLegalService } from "../legal/service.js";
import { isCmsPublicationUnresolved } from "./status.js";
import { createCmsPublicationFileAssembler } from "./files.js";

export const PUBLICATION_TIMEOUT_MS = 15 * 60 * 1000;
const PUBLICATION_LEASE_MS = PUBLICATION_TIMEOUT_MS + 60_000;
const SHA = /^[0-9a-f]{40}$/i;

function stateConflict() {
    throw new CmsApiError("CMS_STATE_CONFLICT",
        "CMS publication state changed unexpectedly.", 409);
}

function requireTime(now) {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError("Invalid CMS publication time.");
    }
    return value;
}

function titleFor(draft, live, legal, liveLegal, summarizeChanges, capability) {
    const note = String(draft.note ?? "").trim();
    if (note) return note;
    const sections = summarizeChanges(draft.content, live.content);
    if (!Array.isArray(sections) || sections.some((section) =>
        typeof section?.label !== "string" || !section.label ||
        typeof section?.page !== "string" || !section.page ||
        typeof section?.pageLabel !== "string" || !section.pageLabel)) {
        throw new TypeError("Invalid publication change summary.");
    }
    const changes = [...sections];
    if (capability) {
        for (const [page, config] of Object.entries(capability.pages)) {
            if (legal[page].document.hash !== liveLegal[page].document.hash ||
                legal[page].pdf.hash !== liveLegal[page].pdf.hash) {
                changes.push({ label: `${config.label} documents`, page,
                    pageLabel: config.label });
            }
        }
    }
    if (changes.length === 1) return `Update ${changes[0].label}`;
    if (changes.length > 1 && new Set(changes.map(({ page }) => page)).size === 1) {
        return `Update ${changes[0].pageLabel}`;
    }
    return "Update Website";
}

export function createCmsPublicationService({ records, github, netlify, bundle,
    pages, images, legalService, cleanup, leases,
    summarizeChanges = () => [], now = () => new Date(),
    createId = randomUUID } = {}) {
    if (typeof records?.read !== "function" ||
        typeof records?.writeIfVersion !== "function" ||
        typeof github?.createCommit !== "function" ||
        typeof github?.findPublicationCommit !== "function" ||
        typeof netlify?.findExactProductionDeploy !== "function" ||
        typeof bundle?.content?.normalizePersisted !== "function" ||
        typeof bundle.content.validateCurrent !== "function" ||
        typeof bundle.assets?.contentImagePaths !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" ||
        typeof cleanup?.cleanupCandidates !== "function" ||
        typeof summarizeChanges !== "function" || typeof now !== "function" ||
        typeof createId !== "function" ||
        (bundle.legalAssetsEnabled && (!isCmsLegalService(legalService) ||
            legalService.capability.assetBundle !== bundle)) ||
        (!bundle.legalAssetsEnabled && legalService !== undefined)) {
        throw new TypeError("Invalid CMS publication configuration.");
    }
    const assembler = createCmsPublicationFileAssembler({ pages, bundle, images, github,
        legalService });
    const capability = legalService?.capability ?? null;

    async function write(name, data, current) {
        const result = await records.writeIfVersion(name, data, current?.etag ?? null);
        if (!result?.modified || typeof result.etag !== "string" || !result.etag) {
            stateConflict();
        }
        return { data, etag: result.etag };
    }

    function legalFrom(record) {
        if (!capability) {
            if (record && Object.hasOwn(record, "legal")) {
                throw new TypeError("A no-legal host cannot publish legal records.");
            }
            return null;
        }
        return legalService.legalFromRecord(record);
    }

    function publicationTimedOut(publication) {
        const start = Date.parse(publication.startedAt ?? "");
        if (!Number.isFinite(start)) stateConflict();
        return requireTime(now).getTime() - start > PUBLICATION_TIMEOUT_MS;
    }

    async function start({ expectedDraftVersion, actor } = {}) {
        if (typeof actor?.email !== "string" || !actor.email.trim()) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        const publicationId = createId();
        if (typeof publicationId !== "string" || !publicationId.trim()) {
            throw new TypeError("Invalid CMS publication ID.");
        }
        let lease = await leases.acquire({ kind: "publication", owner: publicationId,
            ttlMs: PUBLICATION_LEASE_MS });
        let publication;
        let commitAttempted = false;
        async function ensureActive() {
            lease = await leases.renew(lease, { ttlMs: PUBLICATION_LEASE_MS });
            if (publication) {
                publication = await write("publication", { ...publication.data, lease },
                    publication);
            }
        }
        try {
            const [draft, liveRecord, previous] = await Promise.all([
                records.read("draft"), records.read("confirmedLive"),
                records.read("publication"),
            ]);
            if (isCmsPublicationUnresolved(previous?.data)) {
                throw new CmsApiError("PUBLICATION_ALREADY_ACTIVE",
                    "A prior publication is still unresolved. Check its status before publishing again.", 409);
            }
            if (!draft || !expectedDraftVersion || draft.etag !== expectedDraftVersion) {
                throw new CmsApiError("DRAFT_CONFLICT",
                    "The saved draft changed. Reload it before publishing.", 409);
            }
            if (draft.data?.hasUnpublishedChanges === false) {
                throw new CmsApiError("NO_UNPUBLISHED_DRAFT",
                    "There is no unpublished saved draft to publish.", 409);
            }
            if (!liveRecord?.data || typeof liveRecord.data !== "object") {
                throw new CmsApiError("CMS_FOUNDATION_NOT_INITIALIZED",
                    "Initial PUBLIC CMS state is unavailable.", 503);
            }
            const live = liveRecord.data;
            if ((draft.data.baseRevision ?? null) !== (live.revisionId ?? null)) {
                throw new CmsApiError("DRAFT_BASE_STALE",
                    "The live website changed after this draft was created. Revert to the currently published version before publishing.",
                    409, { draftBaseRevision: draft.data.baseRevision ?? null,
                        confirmedRevision: live.revisionId ?? null });
            }
            const content = bundle.content.normalizePersisted(draft.data.content,
                live.content);
            bundle.content.validateCurrent(content);
            const liveLegal = legalFrom(live);
            const legal = legalFrom(draft.data);
            if (capability) await legalService.verifyPublication(legal, liveLegal);
            const compatibleDraft = { ...draft.data, content,
                ...(capability ? { legal } : {}) };
            const title = titleFor(compatibleDraft, live, legal, liveLegal,
                summarizeChanges, capability);
            const startedAt = requireTime(now).toISOString();
            await ensureActive();
            publication = await write("publication", { id: publicationId,
                status: "committing", startedAt, updatedAt: startedAt,
                startedBy: actor.email, draftVersion: draft.etag,
                draft: compatibleDraft, title, lease }, previous);
            const files = await assembler.build({ content, confirmedLive: live,
                legal, ensureActive });
            await ensureActive();
            commitAttempted = true;
            const git = await github.createCommit({ files,
                message: `[cms-publication:${publicationId}] CMS: ${title}` });
            if (![git?.commitSha, git?.parentSha, git?.treeSha]
                .every((value) => SHA.test(value))) stateConflict();
            await ensureActive();
            publication = await write("publication", { ...publication.data,
                status: "deploying", updatedAt: requireTime(now).toISOString(),
                commitSha: git.commitSha, parentSha: git.parentSha,
                treeSha: git.treeSha }, publication);
            try { await leases.release(lease); } catch { /* lease expires if release fails */ }
            return publication.data;
        } catch (error) {
            if (publication && commitAttempted) {
                try { await leases.release(lease); } catch { /* lease expires */ }
                throw new CmsApiError("PUBLICATION_COMMIT_UNCERTAIN",
                    "The repository operation may have completed. Publication status must recover it before another publish.",
                    503, { publicationId: publication.data.id });
            }
            if (publication) {
                try {
                    publication = await write("publication", { ...publication.data,
                        status: "failed", updatedAt: requireTime(now).toISOString(),
                        errorCode: error?.code ?? "PUBLICATION_FAILED" }, publication);
                } catch { /* preserve the original error */ }
            }
            try { await leases.release(lease); } catch { /* preserve the original error */ }
            throw error;
        }
    }

    async function refresh() {
        let publication = await records.read("publication");
        if (!publication) return { status: "idle" };
        if (["confirmed", "failed", "uncertain"].includes(publication.data?.status)) {
            return publication.data;
        }
        if (!["committing", "deploying"].includes(publication.data?.status) ||
            typeof publication.data.id !== "string" || !publication.data.id) {
            stateConflict();
        }
        let lease;
        try {
            lease = await leases.acquire({ kind: "publication",
                owner: publication.data.id, ttlMs: PUBLICATION_LEASE_MS });
        } catch (error) {
            if (error?.code !== "CMS_STATE_LOCKED") throw error;
            return publication.data;
        }
        try {
        publication = await write("publication", { ...publication.data, lease },
            publication);
        async function ensureActive() {
            lease = await leases.renew(lease, { ttlMs: PUBLICATION_LEASE_MS });
            publication = await write("publication", { ...publication.data, lease },
                publication);
        }
        async function finish(status, extra = {}) {
            await ensureActive();
            publication = await write("publication", { ...publication.data,
                status, updatedAt: requireTime(now).toISOString(), ...extra },
            publication);
            return publication.data;
        }
        if (publication.data.status === "committing") {
            const recovered = await github.findPublicationCommit(publication.data.id);
            if (recovered) {
                if (![recovered.commitSha, recovered.parentSha, recovered.treeSha]
                    .every((value) => SHA.test(value))) stateConflict();
                await ensureActive();
                publication = await write("publication", { ...publication.data,
                    status: "deploying", updatedAt: requireTime(now).toISOString(),
                    commitSha: recovered.commitSha,
                    parentSha: recovered.parentSha,
                    treeSha: recovered.treeSha,
                    recoveredAt: requireTime(now).toISOString() }, publication);
            } else if (publicationTimedOut(publication.data)) {
                return await finish("uncertain", {
                    errorCode: "PUBLICATION_COMMIT_RECOVERY_TIMEOUT" });
            } else return publication.data;
        }
        if (publication.data.status !== "deploying" ||
            !SHA.test(publication.data.commitSha)) stateConflict();
        const result = await netlify.findExactProductionDeploy(publication.data.commitSha);
        if (result?.deploy && result.deploy.commit_ref !== publication.data.commitSha) {
            stateConflict();
        }
        if (result?.state === "confirmed") {
            const deploy = result.deploy;
            if (deploy?.commit_ref !== publication.data.commitSha ||
                deploy?.state !== "ready" ||
                typeof deploy?.id !== "string" || !deploy.id ||
                typeof deploy?.published_at !== "string" || !deploy.published_at) {
                stateConflict();
            }
            const snapshot = publication.data.draft;
            if (!snapshot || typeof snapshot !== "object" ||
                (!capability && Object.hasOwn(snapshot, "legal"))) stateConflict();
            await ensureActive();
            const live = await records.read("confirmedLive");
            if (!live?.data || (live.data.revisionId !== publication.data.commitSha &&
                live.data.revisionId !== snapshot.baseRevision) ||
                (live.data.revisionId === publication.data.commitSha &&
                    (!isDeepStrictEqual(live.data.content, snapshot.content) ||
                        (capability && !isDeepStrictEqual(
                            legalService.legalFromRecord(live.data), snapshot.legal))))) {
                stateConflict();
            }
            await ensureActive();
            let revisions = await records.read("revisions");
            if (revisions && (!Array.isArray(revisions.data?.entries) ||
                (revisions.data.nextNumber !== undefined &&
                    (!Number.isSafeInteger(revisions.data.nextNumber) ||
                        revisions.data.nextNumber < 1)))) stateConflict();
            if (!revisions?.data.entries.some((entry) =>
                entry.id === publication.data.commitSha)) {
                const number = revisions?.data.nextNumber ?? 1;
                const revision = { id: publication.data.commitSha, number,
                    title: publication.data.title, note: snapshot.note ?? "",
                    date: deploy.published_at, commit: publication.data.commitSha,
                    deploy: { id: deploy.id, url: deploy.ssl_url ?? deploy.url ?? null,
                        siteId: deploy.site_id ?? null,
                        publishedAt: deploy.published_at },
                    content: snapshot.content,
                    ...(capability ? { legal: snapshot.legal } : {}),
                    assets: [...bundle.assets.contentImagePaths(snapshot.content)] };
                await ensureActive();
                revisions = await write("revisions", {
                    nextNumber: number + 1,
                    entries: [revision, ...(revisions?.data.entries ?? [])],
                }, revisions);
            }
            if (live?.data?.revisionId !== publication.data.commitSha) {
                await ensureActive();
                await write("confirmedLive", { content: snapshot.content,
                    ...(capability ? { legal: snapshot.legal } : {}),
                    revisionId: publication.data.commitSha,
                    confirmedAt: deploy.published_at,
                    commit: publication.data.commitSha, deployId: deploy.id,
                    assets: [...bundle.assets.contentImagePaths(snapshot.content)] }, live);
            }
            await ensureActive();
            const draft = await records.read("draft");
            if (draft?.etag === publication.data.draftVersion) {
                await ensureActive();
                try {
                    await write("draft", { ...draft.data, content: snapshot.content,
                        ...(capability ? { legal: snapshot.legal } : {}),
                        baseRevision: publication.data.commitSha,
                        hasUnpublishedChanges: false,
                        publishedAt: deploy.published_at,
                        publishedRevision: publication.data.commitSha }, draft);
                } catch (error) {
                    if (error?.code !== "CMS_STATE_CONFLICT") throw error;
                    throw new CmsApiError("DRAFT_CONFLICT",
                        "The draft changed while publication was finishing.", 409);
                }
            }
            const confirmed = await finish("confirmed", {
                confirmedAt: deploy.published_at,
                deploy: { id: deploy.id, url: deploy.ssl_url ?? deploy.url ?? null,
                    siteId: deploy.site_id ?? null },
            });
            try {
                await cleanup.cleanupCandidates(snapshot.cleanupCandidates ?? [], {
                    ensureActive: async () => {
                        lease = await leases.renew(lease,
                            { ttlMs: PUBLICATION_LEASE_MS });
                    },
                });
            } catch { /* confirmed PUBLIC state must remain confirmed */ }
            return confirmed;
        }
        if (result?.state === "failed") {
            if (!result.deploy || !["error", "failed", "canceled"]
                .includes(result.deploy.state)) stateConflict();
            return await finish("failed", { errorCode: "PUBLIC_DEPLOYMENT_FAILED",
                deploy: { id: result.deploy?.id, state: result.deploy?.state } });
        }
        if (result?.state !== "pending") stateConflict();
        if (publicationTimedOut(publication.data)) {
            return await finish("failed", { errorCode: "DEPLOYMENT_CONFIRMATION_TIMEOUT" });
        }
        return publication.data;
        } finally {
            try { await leases.release(lease); } catch { /* lease expires */ }
        }
    }

    return Object.freeze({ start, refresh });
}
