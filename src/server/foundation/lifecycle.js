import { isDeepStrictEqual } from "node:util";
import { CmsApiError } from "../http.js";
import { withCmsMutationLease } from "../coordination/mutation.js";
import { isCmsPublicationUnresolved } from "../publication/status.js";
import { isCmsPublicLegalVerifier } from "../legal/public-commit.js";
import { validateLegalBlocks } from "../legal/document.js";

const RECORD_NAMES = ["confirmedLive", "baseline", "publication", "draft"];

function conflict(message) {
    return new CmsApiError("CMS_STATE_CONFLICT", message, 409);
}

function sameDeploy(left, right) {
    return left?.id === right?.id && left?.commit_ref === right?.commit_ref &&
        left?.published_at === right?.published_at;
}

function requireDeploy(deploy) {
    if (typeof deploy?.id !== "string" || !deploy.id ||
        typeof deploy.commit_ref !== "string" || !deploy.commit_ref ||
        typeof deploy.published_at !== "string" || !deploy.published_at) {
        throw new CmsApiError("INITIAL_PUBLIC_DEPLOY_NOT_FOUND",
            "No ready PUBLIC production deployment was found for the configured branch.", 503);
    }
    return deploy;
}

export function createCmsFoundationService({ records, reader, netlify, github, bundle,
    leases, legalVerifier, now = () => new Date() } = {}) {
    if (typeof records?.read !== "function" || typeof records?.writeIfVersion !== "function" ||
        typeof reader?.readAtCommit !== "function" ||
        typeof netlify?.findLatestReadyProductionDeploy !== "function" ||
        typeof github?.readManagedAssetBlobIdentitiesAtCommit !== "function" ||
        typeof bundle?.content?.readPublic !== "function" ||
        typeof bundle.content.normalizePersisted !== "function" ||
        typeof bundle.content.validateCurrent !== "function" ||
        typeof bundle?.assets?.contentImagePaths !== "function" ||
        typeof bundle.assets.repositoryPathsForContent !== "function" ||
        typeof bundle.assets.inspectRecordReferences !== "function" ||
        typeof leases?.acquire !== "function" || typeof now !== "function") {
        throw new TypeError("Invalid CMS foundation configuration.");
    }
    if (bundle.legalAssetsEnabled && (!isCmsPublicLegalVerifier(legalVerifier) ||
        legalVerifier.capability.assetBundle !== bundle ||
        legalVerifier.github !== github)) {
        throw new TypeError("Legal-enabled CMS foundation requires package-owned legal verification.");
    }
    if (!bundle.legalAssetsEnabled && legalVerifier !== undefined) {
        throw new TypeError("Legal verification requires a legal-enabled host bundle.");
    }
    const legalEnabled = bundle.legalAssetsEnabled;
    const originalLegal = legalEnabled ? legalVerifier.capability.initialPairs() : null;

    async function readRecords() {
        const entries = await Promise.all(RECORD_NAMES.map((name) => records.read(name)));
        return Object.fromEntries(RECORD_NAMES.map((name, index) => [name, entries[index]]));
    }

    function ensureNoLegal(state) {
        if ([state.confirmedLive, state.baseline, state.draft]
            .some((record) => record?.data && Object.hasOwn(record.data, "legal"))) {
            throw new TypeError("Legal CMS records require package-owned legal verification.");
        }
    }

    function recordLegal(record) {
        const stored = record?.data?.legal;
        if (stored === undefined) return structuredClone(originalLegal);
        const pages = Object.keys(originalLegal);
        if (!stored || typeof stored !== "object" || Array.isArray(stored) ||
            Object.keys(stored).some((page) => !pages.includes(page))) {
            throw new CmsApiError("PUBLIC_LEGAL_PAIR_INVALID",
                "Stored legal state is invalid.", 502);
        }
        const legal = { ...structuredClone(originalLegal), ...stored };
        for (const page of pages) {
            const pair = legal[page];
            if (!pair || typeof pair !== "object" || Array.isArray(pair) ||
                !validateLegalBlocks(pair.document) ||
                !/^[0-9a-f]{64}$/.test(pair.document?.hash) ||
                typeof pair.document?.name !== "string" || !pair.document.name ||
                !/^[0-9a-f]{64}$/.test(pair.pdf?.hash) ||
                typeof pair.pdf?.name !== "string" || !pair.pdf.name) {
                throw new CmsApiError("PUBLIC_LEGAL_PAIR_INVALID",
                    "Stored legal state is invalid.", 502);
            }
        }
        return legal;
    }

    function validateLegalRecords(state) {
        for (const name of ["confirmedLive", "baseline", "draft"]) {
            if (state[name]) recordLegal(state[name]);
        }
    }

    function checkRecordLegal(state) {
        if (legalEnabled) validateLegalRecords(state);
        else ensureNoLegal(state);
    }

    function normalized(record, canonical) {
        return bundle.content.normalizePersisted(record.data.content, canonical);
    }

    function currentShape(raw, canonical) {
        try {
            return bundle.content.readPublic(raw, canonical).kind === "current" &&
                Boolean(bundle.content.validateCurrent(raw));
        } catch {
            return false;
        }
    }

    function cleanDraftNeedsUpdate(draft, live, canonical) {
        if (!draft || draft.data.hasUnpublishedChanges !== false) return false;
        if (legalEnabled) recordLegal(draft);
        if (draft.data.baseRevision !== live.data.revisionId ||
            !currentShape(draft.data.content, canonical)) return true;
        try {
            return !isDeepStrictEqual(normalized(draft, canonical), normalized(live, canonical)) ||
                (legalEnabled && (!Object.hasOwn(draft.data, "legal") ||
                    !isDeepStrictEqual(recordLegal(draft), recordLegal(live))));
        } catch {
            return true;
        }
    }

    function cleanDraftIdentitySafe(draft, live, canonical) {
        if (!draft || draft.data.hasUnpublishedChanges !== false) return true;
        if (draft.data.baseRevision !== live.data.revisionId ||
            !currentShape(draft.data.content, canonical)) return false;
        try {
            return isDeepStrictEqual(normalized(draft, canonical),
                normalized(live, canonical)) &&
                (!legalEnabled || isDeepStrictEqual(recordLegal(draft), recordLegal(live)));
        } catch { return false; }
    }

    async function writeAndRead(name, data, expectedEtag) {
        const result = await records.writeIfVersion(name, data, expectedEtag);
        const latest = await records.read(name);
        if (!latest) throw conflict(`${name} disappeared during reconciliation.`);
        if (result.modified && !isDeepStrictEqual(latest.data, data)) {
            throw conflict(`${name} changed immediately after reconciliation.`);
        }
        return { latest, modified: result.modified };
    }

    async function assetsMatch(live, readyContent, readyCommit) {
        const oldCommit = live.data.commit ?? live.data.revisionId;
        if (oldCommit !== live.data.revisionId) return false;
        try {
            if (bundle.assets.inspectRecordReferences(live.data).unresolvedAssets.length) return false;
            const paths = [...bundle.assets.repositoryPathsForContent(readyContent)]
                .filter((path) => !legalEnabled || !bundle.legalPdfPaths.includes(path));
            if (!paths.length) return true;
            const [oldIdentity, readyIdentity] = await Promise.all([
                github.readManagedAssetBlobIdentitiesAtCommit(paths, oldCommit,
                    { content: live.data.content }),
                github.readManagedAssetBlobIdentitiesAtCommit(paths, readyCommit,
                    { content: readyContent }),
            ]);
            return paths.every((path) => {
                const old = oldIdentity.get(path);
                const ready = readyIdentity.get(path);
                return old && ready && old.sha === ready.sha && old.size === ready.size;
            });
        } catch {
            return false;
        }
    }

    async function legalIdentityMatches(live, readyLegal, readyCommit) {
        if (!legalEnabled) return true;
        const oldCommit = live.data.commit ?? live.data.revisionId;
        if (oldCommit !== live.data.revisionId) return false;
        try {
            const oldLegal = await legalVerifier.readAtCommit(oldCommit);
            return isDeepStrictEqual(recordLegal(live), oldLegal) &&
                isDeepStrictEqual(oldLegal, readyLegal) &&
                oldCommit !== readyCommit;
        } catch { return false; }
    }

    async function reconcileCleanDraft(live, canonical, ensureActive) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const draft = await records.read("draft");
            if (!cleanDraftNeedsUpdate(draft, live, canonical)) return draft;
            const data = { ...draft.data, content: live.data.content,
                ...(legalEnabled ? { legal: recordLegal(live) } : {}),
                baseRevision: live.data.revisionId, hasUnpublishedChanges: false };
            await ensureActive();
            const { latest, modified } = await writeAndRead("draft", data, draft.etag);
            if (modified) return latest;
        }
        const latest = await records.read("draft");
        if (!cleanDraftNeedsUpdate(latest, live, canonical)) return latest;
        throw conflict("The clean draft changed while PUBLIC state was being reconciled.");
    }

    return Object.freeze({
        async ensure({ canonicalContent } = {}) {
            if (!canonicalContent || typeof canonicalContent !== "object" ||
                Array.isArray(canonicalContent)) throw new TypeError("Canonical content is required.");
            const initial = await readRecords();
            checkRecordLegal(initial);
            if (isCmsPublicationUnresolved(initial.publication?.data)) {
                if (!initial.confirmedLive || !initial.baseline) {
                    throw new CmsApiError("CMS_FOUNDATION_NOT_INITIALIZED",
                        "Initial PUBLIC CMS state has not been captured.", 503);
                }
                return { live: initial.confirmedLive, baseline: initial.baseline };
            }

            const deploy = requireDeploy(await netlify.findLatestReadyProductionDeploy());
            const publicContent = await reader.readAtCommit(deploy.commit_ref, canonicalContent);
            const publicLegal = legalEnabled
                ? await legalVerifier.readAtCommit(deploy.commit_ref) : null;
            const raw = publicContent.rawContent;
            // A parseable predecessor is a valid initial PUBLIC snapshot, never a
            // reason to rewrite an existing confirmed-live record.
            const readyCurrent = publicContent.kind === "current";
            if (readyCurrent) bundle.content.validateCurrent(raw);
            const paths = bundle.assets.contentImagePaths(raw);
            const liveNeedsContent = Boolean(initial.confirmedLive && readyCurrent &&
                (!currentShape(initial.confirmedLive.data.content, canonicalContent) ||
                !isDeepStrictEqual(normalized(initial.confirmedLive, canonicalContent), raw)));
            const identityDiffers = Boolean(initial.confirmedLive && readyCurrent &&
                (initial.confirmedLive.data.commit ?? initial.confirmedLive.data.revisionId) !==
                    deploy.commit_ref);
            const liveNeedsLegal = Boolean(legalEnabled && initial.confirmedLive &&
                readyCurrent && (!isDeepStrictEqual(recordLegal(initial.confirmedLive),
                    publicLegal) || (!identityDiffers &&
                    !Object.hasOwn(initial.confirmedLive.data, "legal"))));
            const identityProven = identityDiffers && !liveNeedsContent && !liveNeedsLegal &&
                await legalIdentityMatches(initial.confirmedLive, publicLegal,
                    deploy.commit_ref) &&
                await assetsMatch(initial.confirmedLive, raw, deploy.commit_ref);
            const draftNeedsUpdate = Boolean(initial.confirmedLive && readyCurrent &&
                cleanDraftNeedsUpdate(initial.draft, initial.confirmedLive, canonicalContent));
            if (legalEnabled && initial.confirmedLive && initial.baseline &&
                identityDiffers && !liveNeedsContent && !liveNeedsLegal && !identityProven) {
                return { live: initial.confirmedLive, baseline: initial.baseline };
            }
            if (initial.confirmedLive && initial.baseline && !liveNeedsContent &&
                !liveNeedsLegal &&
                !identityProven && !draftNeedsUpdate) {
                return { live: initial.confirmedLive, baseline: initial.baseline };
            }

            const identityOnlyAttempt = Boolean(initial.confirmedLive && initial.baseline &&
                identityProven && !liveNeedsContent && !liveNeedsLegal);
            let enteredLease = false;
            try {
                return await withCmsMutationLease(leases, async (ensureActive) => {
                enteredLease = true;
                let state = await readRecords();
                checkRecordLegal(state);
                if (initial.confirmedLive?.etag !== state.confirmedLive?.etag ||
                    initial.baseline?.etag !== state.baseline?.etag) {
                    return { live: state.confirmedLive, baseline: state.baseline };
                }
                if (isCmsPublicationUnresolved(state.publication?.data)) {
                    return { live: state.confirmedLive, baseline: state.baseline };
                }
                let latestDeploy;
                try { latestDeploy = requireDeploy(await netlify.findLatestReadyProductionDeploy()); }
                catch { return { live: state.confirmedLive, baseline: state.baseline }; }
                if (!sameDeploy(deploy, latestDeploy)) {
                    return { live: state.confirmedLive, baseline: state.baseline };
                }
                async function ensureReadyForWrite() {
                    let current;
                    try { current = requireDeploy(await netlify.findLatestReadyProductionDeploy()); }
                    catch { throw conflict("The READY PUBLIC deployment could not be rechecked."); }
                    if (!sameDeploy(deploy, current)) {
                        throw conflict("The READY PUBLIC deployment changed during reconciliation.");
                    }
                    await ensureActive();
                }

                let live = state.confirmedLive;
                if (!live) {
                    const data = { content: raw,
                        ...(legalEnabled ? { legal: publicLegal } : {}),
                        revisionId: deploy.commit_ref,
                        confirmedAt: deploy.published_at, commit: deploy.commit_ref,
                        deployId: deploy.id, assets: [...paths], initializedAt: now().toISOString() };
                    await ensureReadyForWrite();
                    const result = await writeAndRead("confirmedLive", data, null);
                    live = result.latest;
                    if (!result.modified && !isDeepStrictEqual(live.data, data)) {
                        throw conflict("Confirmed PUBLIC state changed during initial capture.");
                    }
                } else if (readyCurrent) {
                    const differs = !currentShape(live.data.content, canonicalContent) ||
                        !isDeepStrictEqual(normalized(live, canonicalContent), raw);
                    const legalDiffers = legalEnabled &&
                        (!isDeepStrictEqual(recordLegal(live), publicLegal) ||
                            (!identityDiffers && !Object.hasOwn(live.data, "legal")));
                    if (differs || legalDiffers) {
                        const data = { ...live.data, content: raw,
                            ...(legalEnabled ? { legal: publicLegal } : {}),
                            revisionId: deploy.commit_ref, confirmedAt: deploy.published_at,
                            commit: deploy.commit_ref, deployId: deploy.id, assets: [...paths] };
                        await ensureReadyForWrite();
                        const result = await writeAndRead("confirmedLive", data, live.etag);
                        live = result.latest;
                        if (!result.modified && !isDeepStrictEqual(live.data, data)) {
                            throw conflict("Confirmed PUBLIC state changed while it was being reconciled.");
                        }
                    } else if (identityProven && live.etag === initial.confirmedLive?.etag) {
                        const data = { ...live.data,
                            ...(legalEnabled ? { legal: publicLegal } : {}),
                            revisionId: deploy.commit_ref,
                            commit: deploy.commit_ref, deployId: deploy.id,
                            confirmedAt: deploy.published_at };
                        // An inconsistent clean draft blocks an identity-only move.
                        if (!cleanDraftIdentitySafe(state.draft, live, canonicalContent)) {
                            return { live, baseline: state.baseline };
                        }
                        await ensureReadyForWrite();
                        const result = await writeAndRead("confirmedLive", data, live.etag);
                        live = result.latest;
                        if (!result.modified && !isDeepStrictEqual(live.data, data)) {
                            throw conflict("Confirmed PUBLIC identity changed concurrently.");
                        }
                    }
                    await reconcileCleanDraft(live, canonicalContent, ensureReadyForWrite);
                }

                let baseline = state.baseline;
                if (!baseline) {
                    const data = { content: live.data.content,
                        ...(legalEnabled ? { legal: recordLegal(live) } : {}),
                        revisionId: "developer-baseline",
                        sourceCommit: live.data.commit ?? live.data.revisionId,
                        commit: live.data.commit ?? live.data.revisionId,
                        deployId: live.data.deployId ?? null,
                        confirmedAt: live.data.confirmedAt ?? null,
                        capturedAt: now().toISOString(),
                        assets: [...bundle.assets.contentImagePaths(live.data.content)] };
                    await ensureReadyForWrite();
                    baseline = (await writeAndRead("baseline", data, null)).latest;
                }
                return { live, baseline };
                });
            } catch (error) {
                if (error?.code !== "CMS_STATE_LOCKED" || !identityOnlyAttempt || enteredLease) {
                    throw error;
                }
                const latest = await readRecords();
                checkRecordLegal(latest);
                if (!latest.confirmedLive || !latest.baseline) throw error;
                return { live: latest.confirmedLive, baseline: latest.baseline };
            }
        },
    });
}
