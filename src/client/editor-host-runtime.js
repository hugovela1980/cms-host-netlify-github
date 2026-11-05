import { createCmsApiClient } from "./api.js";
import { pollPublicationConfirmation } from "./publication-poll.js";

const ACTIVE = new Set(["committing", "deploying"]);
const BLOCKED = new Set(["committing", "deploying", "uncertain"]);

function defaultWait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The host hydrates its editor and preview from the authoritative first draft.
// This module owns provider state but never touches the host's DOM or auth.
export function createCmsEditorHostRuntime({ legalEnabled = false,
    api = createCmsApiClient({ legalEnabled }), hydrate, wait = defaultWait,
    maxPublicationPolls = 301, onReconciled: onAuthoritativeReload,
    onResumeFailure } = {}) {
    if (typeof api?.loadDraft !== "function" ||
        typeof api?.saveDraft !== "function" ||
        typeof api?.revertDraft !== "function" ||
        typeof api?.restoreRevision !== "function" ||
        typeof api?.publishDraft !== "function" ||
        typeof api?.publicationStatus !== "function" ||
        (legalEnabled && typeof api?.confirmLegal !== "function") ||
        typeof hydrate !== "function" || typeof legalEnabled !== "boolean" ||
        typeof wait !== "function" ||
        (onAuthoritativeReload !== undefined &&
            typeof onAuthoritativeReload !== "function") ||
        (onResumeFailure !== undefined && typeof onResumeFailure !== "function") ||
        !Number.isSafeInteger(maxPublicationPolls) || maxPublicationPolls < 1) {
        throw new TypeError("Invalid CMS editor host runtime configuration.");
    }

    let started;
    let ready = false;
    let draftVersion = null;
    let legal = {};
    let publishedLegal = {};
    let hasSavedDraft = false;
    let publicationStatus = "idle";
    let publicationActive = false;
    let publicationBlocked = false;

    function state() {
        return { ready, draftVersion, legal: structuredClone(legal),
            publishedLegal: structuredClone(publishedLegal), hasSavedDraft,
            publicationStatus, publicationActive, publicationBlocked,
            canPublish: hasSavedDraft && !publicationBlocked &&
                Object.values(legal).every((pair) =>
                    pair.verification?.status !== "different") };
    }

    function setPublicationStatus(status) {
        publicationStatus = status;
        publicationActive = ACTIVE.has(status);
        publicationBlocked = BLOCKED.has(status);
    }

    function acceptDraft(result, { initial = false } = {}) {
        draftVersion = result.draftVersion ?? null;
        legal = legalEnabled ? result.legal ?? {} : {};
        publishedLegal = legalEnabled ? result.publishedLegal ?? {} : {};
        hasSavedDraft = result.hasSavedDraft === true;
        if (initial) setPublicationStatus(result.publicationStatus?.status ?? "idle");
    }

    function start() {
        if (started) return started;
        started = (async () => {
            const initial = await api.loadDraft();
            await hydrate(initial);
            acceptDraft(initial, { initial: true });
            ready = true;
            if (publicationActive) {
                queueMicrotask(() => { void resumeActivePublication(); });
            }
            return { initial, state: state() };
        })();
        return started;
    }

    async function requireReady() {
        await start();
    }

    async function reloadDraft({ onLoaded } = {}) {
        await requireReady();
        const result = await api.loadDraft();
        acceptDraft(result);
        if (onLoaded) await onLoaded(result, state());
        return result;
    }

    async function saveChanges(request, { onSaved } = {}) {
        await requireReady();
        const result = await api.saveDraft({ ...request,
            saveData: { note: request.saveData?.draftNote ?? "" },
            expectedDraftVersion: draftVersion });
        draftVersion = result.draftVersion;
        if (legalEnabled) legal = result.legal ?? legal;
        hasSavedDraft = true;
        if (onSaved) await onSaved(result, state());
        return result;
    }

    async function revertChanges({ onReverted } = {}) {
        await requireReady();
        const result = await api.revertDraft({ expectedDraftVersion: draftVersion });
        draftVersion = result.draftVersion;
        if (legalEnabled) legal = result.legal ?? publishedLegal;
        hasSavedDraft = result.hasSavedDraft === true;
        if (onReverted) await onReverted(result, state());
        return result;
    }

    async function restoreRevision(id, expectedDraftVersion,
        { onRestored } = {}) {
        await requireReady();
        const result = await api.restoreRevision(id, expectedDraftVersion);
        draftVersion = result.draftVersion;
        const refreshed = await api.loadDraft();
        if (legalEnabled) legal = refreshed.legal ?? {};
        hasSavedDraft = true;
        if (onRestored) await onRestored({ result, refreshed }, state());
        return result;
    }

    async function confirmLegal(request, { onConfirmed } = {}) {
        await requireReady();
        if (!legalEnabled) throw new TypeError("Legal files are not enabled.");
        const result = await api.confirmLegal({ ...request,
            expectedDraftVersion: draftVersion });
        draftVersion = result.draftVersion;
        legal = result.legal;
        if (onConfirmed) await onConfirmed(result, state());
        return result;
    }

    async function waitForConfirmedPublication() {
        return pollPublicationConfirmation({ api, wait,
            maxPolls: maxPublicationPolls,
            onActiveChange(value) { publicationActive = value; },
            onStatus(value) {
                publicationStatus = value;
                publicationBlocked = BLOCKED.has(value);
            } });
    }

    async function resumeActivePublication() {
        try {
            await waitForConfirmedPublication();
            publicationActive = false;
            const refreshed = await api.loadDraft();
            acceptDraft(refreshed);
            if (onAuthoritativeReload) await onAuthoritativeReload(refreshed, state());
        } catch (error) {
            if (onResumeFailure) {
                try { await onResumeFailure(error, state()); }
                catch { /* background resume has no caller to reject */ }
            }
        }
    }

    async function publishChanges({ reportProgress, onReconciled } = {}) {
        await requireReady();
        const report = typeof reportProgress === "function" ? reportProgress : () => false;
        publicationActive = true;
        publicationBlocked = true;
        try {
            report("creating-version");
            const startedPublication = await api.publishDraft(draftVersion);
            if (startedPublication?.publication?.status === "deploying") {
                report("updating-live");
            }
            report("confirming-live");
            const publication = await waitForConfirmedPublication();
            if (publication.status !== "confirmed") {
                const error = new Error("Publication was not explicitly confirmed.");
                error.code = "PUBLICATION_NOT_CONFIRMED";
                throw error;
            }
            publicationActive = false;
            publicationBlocked = false;
            const refreshed = await api.loadDraft();
            acceptDraft(refreshed);
            const reconcile = onReconciled ?? onAuthoritativeReload;
            if (reconcile) await reconcile(refreshed, state());
            return { publication, refreshed };
        } catch (error) {
            try {
                publicationStatus = (await api.publicationStatus())?.publication?.status;
                publicationActive = ACTIVE.has(publicationStatus);
                publicationBlocked = BLOCKED.has(publicationStatus);
            } catch {
                publicationActive = true;
                publicationBlocked = true;
            }
            throw error;
        }
    }

    return Object.freeze({ start, whenReady: start, state, reloadDraft,
        saveChanges, revertChanges, restoreRevision, confirmLegal,
        publishChanges });
}
