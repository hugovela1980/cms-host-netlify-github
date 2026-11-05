import { createCmsHostPolicyBundle } from "./host-policies.js";
import { readCmsPublicationConfig } from "./config/publication.js";
import { createGitHubPublicationClient } from "./providers/github.js";
import { createNetlifyDeploymentClient } from "./providers/netlify.js";
import { createCmsJsonRecordStore } from "./storage/json-records.js";
import { createCmsBlobStorage, validCmsBlobStore } from "./storage/blob-storage.js";
import { createCmsLeaseManager } from "./coordination/leases.js";
import { createCmsManagedImageService } from "./assets/staged-images.js";
import { createCmsManagedImageCleanup } from "./assets/cleanup.js";
import { createCmsHistoricalImageRecovery } from "./assets/historical-recovery.js";
import { createCmsLegalCapability } from "./legal/capability.js";
import { createCmsLegalService } from "./legal/service.js";
import { createCmsLegalCleanup } from "./legal/cleanup.js";
import { createCmsHistoricalLegalRecovery } from "./legal/recovery.js";
import { createCmsPublicLegalVerifier } from "./legal/public-commit.js";
import { createCmsRepositoryContentReader } from "./foundation/repository-content.js";
import { createCmsFoundationService } from "./foundation/lifecycle.js";
import { createCmsDraftStateReader } from "./draft/state-reader.js";
import { createCmsDraftRevertService } from "./draft/revert.js";
import { createCmsContentDraftSaveService } from "./draft/save-content.js";
import { createCmsPublicationService } from "./publication/lifecycle.js";
import { createCmsRevisionService } from "./revisions/service.js";
import { createCmsCoreJsonHandlers } from "./handlers/core-json.js";
import { createCmsManagedImageHandlers } from "./handlers/managed-images.js";
import { createCmsOptionalLegalJsonHandlers } from "./handlers/legal-json.js";
import { createCmsOptionalLegalPreviewHandlers } from "./handlers/legal-preview.js";

const RECORD_NAMES = ["draft", "confirmedLive", "baseline", "publication", "revisions", "coordination"];

function invalid() {
    throw new TypeError("Invalid CMS host configuration.");
}

function hasLegalRecord(name, data) {
    if (!data || typeof data !== "object") return false;
    if (Object.hasOwn(data, "legal")) return true;
    if (name === "publication" && data.draft && Object.hasOwn(data.draft, "legal")) return true;
    return name === "revisions" && Array.isArray(data.entries) &&
        data.entries.some((entry) => entry && Object.hasOwn(entry, "legal"));
}

// Host-owned authorization and route registration surround these trusted handlers.
export async function createCmsHost({ storage, store: legacyStore, keys: legacyKeys,
    pages, canonicalContent,
    contentPolicy, managedImages, historyPolicy, applyContentChanges,
    deriveSections, validateNote, validateCleanupCandidates, previewUrlForPath,
    summarizeChanges = () => [], legal, providers, environment, fetchObject,
    now = () => new Date(), createId, createOwner, logger = console } = {}) {
    if ((storage === undefined && (legacyStore === undefined || legacyKeys === undefined)) ||
        (storage !== undefined && (legacyStore !== undefined || legacyKeys !== undefined)) ||
        typeof canonicalContent !== "function" ||
        typeof applyContentChanges !== "function" || typeof deriveSections !== "function" ||
        typeof validateNote !== "function" || typeof validateCleanupCandidates !== "function" ||
        typeof previewUrlForPath !== "function" || typeof summarizeChanges !== "function" ||
        typeof now !== "function" || (createId !== undefined && typeof createId !== "function") ||
        (createOwner !== undefined && typeof createOwner !== "function") ||
        typeof logger?.error !== "function" ||
        (providers === undefined) === (environment === undefined) ||
        (providers !== undefined && fetchObject !== undefined) ||
        (environment !== undefined && typeof fetchObject !== "function") ||
        (fetchObject !== undefined && typeof fetchObject !== "function") ||
        (legal !== undefined && (!legal || typeof legal !== "object" ||
            Array.isArray(legal) || typeof legal.renderHtml !== "function"))) invalid();

    const blobStorage = storage === undefined ? null : createCmsBlobStorage(storage);
    const store = blobStorage?.store ?? legacyStore;
    const keys = blobStorage?.keys ?? legacyKeys;
    if (!validCmsBlobStore(store) || !keys ||
        RECORD_NAMES.some((name) => typeof keys[name] !== "string" || !keys[name]) ||
        (legal?.previewCompatibility === "legacy" && typeof store.get !== "function")) invalid();

    const bundle = createCmsHostPolicyBundle({ contentPolicy, managedImages,
        ...(legal === undefined ? {} : { legal: { pdfPaths: legal.pdfPaths } }) });
    const records = blobStorage?.records ?? createCmsJsonRecordStore({ store, keys });
    const leaseOptions = { records, now, ...(createOwner && { createOwner }) };
    const leases = createCmsLeaseManager(leaseOptions);
    if (legal === undefined) {
        const state = await Promise.all(RECORD_NAMES.map((name) => records.read(name)));
        if (state.some((record, index) => hasLegalRecord(RECORD_NAMES[index], record?.data))) {
            throw new TypeError("Legal CMS records require a legal capability.");
        }
    }

    let github;
    let netlify;
    if (providers !== undefined) {
        if (!providers || typeof providers !== "object" || Array.isArray(providers) ||
            typeof providers.github?.readFileAtCommit !== "function" ||
            typeof providers.github?.readManagedAssetBlobIdentitiesAtCommit !== "function" ||
            typeof providers.github?.createCommit !== "function" ||
            typeof providers.github?.findPublicationCommit !== "function" ||
            typeof providers.netlify?.findLatestReadyProductionDeploy !== "function" ||
            typeof providers.netlify?.findExactProductionDeploy !== "function") invalid();
        ({ github, netlify } = providers);
    } else {
        const config = readCmsPublicationConfig(environment);
        github = createGitHubPublicationClient(config, { assetIdentity: bundle.assets,
            ...(fetchObject && { fetchObject }) });
        netlify = createNetlifyDeploymentClient(config, { ...(fetchObject && { fetchObject }) });
    }

    const imageOptions = { store, assets: bundle.assets, leases, previewUrlForPath, now,
        ...(createId && { createId }) };
    const images = createCmsManagedImageService(imageOptions);
    const imageCleanup = createCmsManagedImageCleanup({ store, records,
        assets: bundle.assets, leases, now });
    const imageRecovery = createCmsHistoricalImageRecovery({ store, github,
        assets: bundle.assets });

    let legalService;
    let legalCleanup;
    let legalRecovery;
    let legalVerifier;
    let legalFromRecord;
    if (legal !== undefined) {
        const { renderHtml, previewCompatibility, previewBasePath, pdfPaths,
            ...capabilityConfig } = legal;
        if (previewCompatibility !== undefined && previewCompatibility !== "legacy") invalid();
        const capability = await createCmsLegalCapability({ ...capabilityConfig,
            assetBundle: bundle });
        legalService = createCmsLegalService({ capability, store, records, leases, now,
            ...(previewBasePath !== undefined && { previewBasePath }) });
        legalCleanup = createCmsLegalCleanup({ capability, store, records, leases, now });
        legalRecovery = createCmsHistoricalLegalRecovery({ capability,
            service: legalService, store, github, now });
        legalVerifier = createCmsPublicLegalVerifier({ capability, github });
        legalFromRecord = (record) => ({ ...capability.initialPairs(),
            ...(record?.legal ?? {}) });
    }

    const reader = createCmsRepositoryContentReader({ github, pages,
        content: bundle.content });
    const foundation = createCmsFoundationService({ records, reader, netlify,
        github, bundle, leases, now, ...(legalVerifier && { legalVerifier }) });
    const draftState = createCmsDraftStateReader({ records, content: bundle.content,
        ...(legalFromRecord && { legalFromRecord }) });
    const draftSave = createCmsContentDraftSaveService({ records,
        content: bundle.content, applyContentChanges, deriveSections, validateNote,
        validateCleanupCandidates, leases, store, github, assets: bundle.assets,
        now, ...(legalFromRecord && { legalFromRecord }) });
    const draftRevert = createCmsDraftRevertService({ records, content: bundle.content,
        validateNote, leases, now, ...(legalFromRecord && { legalFromRecord }) });
    const publication = createCmsPublicationService({ records, github, netlify,
        bundle, pages, images, cleanup: imageCleanup, leases, summarizeChanges, now,
        ...(createId && { createId }), ...(legalService && { legalService }) });
    const revisions = createCmsRevisionService({ records, bundle, historyPolicy,
        imageRecovery, leases, now, ...(legalService && { legalService }),
        ...(legalRecovery && { legalRecovery }) });

    const core = createCmsCoreJsonHandlers({ records, bundle, foundation,
        canonicalContent, draftState, draftSave, draftRevert, publication, revisions });
    const imageHandlers = createCmsManagedImageHandlers({ images,
        cleanup: imageCleanup, logger });
    const legalJson = createCmsOptionalLegalJsonHandlers({ bundle,
        ...(legalService && { legalService, cleanup: legalCleanup, foundation,
            canonicalContent, logger }) });
    const legalPreview = createCmsOptionalLegalPreviewHandlers({ bundle,
        ...(legalService && { legalService, renderHtml: legal.renderHtml,
            ...(legal.previewCompatibility && {
                previewCompatibility: legal.previewCompatibility }) }) });
    return Object.freeze({ handlers: Object.freeze({ ...core, ...imageHandlers,
        ...legalJson, ...legalPreview }) });
}
