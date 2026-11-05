import { CmsApiError } from "../http.js";
import { isCmsHostPolicyBundle } from "../host-policies.js";
import { compareLegalText, extractPdfText, legalHash, parseLegalDocx,
    validateLegalBlocks } from "./document.js";

const ID = /^[a-z][a-z0-9-]*$/;
const REPOSITORY_PATH = /^[a-z0-9][a-z0-9_./-]*$/i;
const HASH = /^[0-9a-f]{64}$/;
const verifiedCapabilities = new WeakSet();

export function isCmsLegalCapability(value) {
    return Boolean(value && typeof value === "object" && verifiedCapabilities.has(value));
}

function validPath(value) {
    return typeof value === "string" && REPOSITORY_PATH.test(value) &&
        !value.split("/").some((part) => !part || part === "." || part === "..");
}

function unavailable() {
    throw new CmsApiError("LEGAL_ORIGINAL_UNAVAILABLE",
        "An approved original legal pair could not be verified.", 502);
}

export async function createCmsLegalCapability({ pages, manifestPath, renderedPath,
    sourceDirectory, readOriginal, assetBundle,
    allowManifestlessOriginals } = {}) {
    if (!pages || typeof pages !== "object" || Array.isArray(pages) ||
        !Object.keys(pages).length || manifestPath === renderedPath ||
        !manifestPath?.endsWith(".json") || !renderedPath?.endsWith(".json") ||
        [manifestPath, renderedPath].some((path) =>
            path === sourceDirectory || path.startsWith(`${sourceDirectory}/`) ||
            sourceDirectory?.startsWith(`${path}/`)) ||
        ![manifestPath, renderedPath, sourceDirectory]
            .every(validPath) || typeof readOriginal !== "function" ||
        typeof allowManifestlessOriginals !== "boolean" ||
        !isCmsHostPolicyBundle(assetBundle) || !assetBundle.legalAssetsEnabled) {
        throw new TypeError("Invalid optional CMS legal configuration.");
    }
    const pdfPaths = Object.values(pages).map((page) => page?.pdfPath);
    if (new Set(pdfPaths).size !== pdfPaths.length ||
        pdfPaths.length !== assetBundle.legalPdfPaths.length ||
        pdfPaths.some((path) => !assetBundle.legalPdfPaths.includes(path))) {
        throw new TypeError("Legal PDF paths must match the legal-enabled asset bundle.");
    }
    const originals = {};
    const bytes = new Map();
    const descriptors = {};
    const usedPaths = new Set([manifestPath, renderedPath]);
    for (const [page, descriptor] of Object.entries(pages)) {
        if (!ID.test(page) || !descriptor || typeof descriptor !== "object" ||
            typeof descriptor.label !== "string" || !descriptor.label.trim() ||
            !validPath(descriptor.originalDocumentPath) ||
            !descriptor.originalDocumentPath.endsWith(".docx") ||
            !validPath(descriptor.originalPdfPath) ||
            !descriptor.originalPdfPath.endsWith(".pdf") ||
            !validPath(descriptor.pdfPath) || !descriptor.pdfPath.endsWith(".pdf") ||
            !Array.isArray(descriptor.sourceTitles) ||
            descriptor.sourceTitles.some((title) => typeof title !== "string" || !title.trim()) ||
            !Array.isArray(descriptor.ignoredPdfFooterTexts) ||
            descriptor.ignoredPdfFooterTexts.some((text) => typeof text !== "string" || !text.trim()) ||
            new Set([descriptor.originalDocumentPath, descriptor.originalPdfPath,
                descriptor.pdfPath]).size !== 3 ||
            [descriptor.originalDocumentPath, descriptor.originalPdfPath, descriptor.pdfPath]
                .some((path) => usedPaths.has(path))) {
            throw new TypeError("Invalid optional CMS legal page.");
        }
        for (const path of [descriptor.originalDocumentPath,
            descriptor.originalPdfPath, descriptor.pdfPath]) usedPaths.add(path);
        let documentBytes;
        let pdfBytes;
        try {
            [documentBytes, pdfBytes] = await Promise.all([
                readOriginal(descriptor.originalDocumentPath),
                readOriginal(descriptor.originalPdfPath),
            ]);
            if (!Buffer.isBuffer(documentBytes) || !Buffer.isBuffer(pdfBytes) ||
                !documentBytes.length || !pdfBytes.length) unavailable();
            const document = parseLegalDocx(documentBytes,
                { sourceTitles: descriptor.sourceTitles });
            if (!validateLegalBlocks(document)) unavailable();
            const pdfText = await extractPdfText(pdfBytes,
                { ignoredFooterTexts: descriptor.ignoredPdfFooterTexts });
            if (compareLegalText(document, pdfText).status !== "matches") unavailable();
            const documentHash = legalHash(documentBytes);
            const pdfHash = legalHash(pdfBytes);
            if (!HASH.test(documentHash) || !HASH.test(pdfHash)) unavailable();
            originals[page] = { document: { ...document, hash: documentHash,
                name: descriptor.originalDocumentPath.split("/").at(-1), original: true },
            pdf: { hash: pdfHash, name: descriptor.originalPdfPath.split("/").at(-1),
                original: true },
            verification: { status: "matches", explanation: "Approved initial document and PDF." } };
            bytes.set(`${page}:document`, Buffer.from(documentBytes));
            bytes.set(`${page}:pdf`, Buffer.from(pdfBytes));
        } catch { unavailable(); }
        descriptors[page] = Object.freeze({ ...descriptor,
            sourceTitles: Object.freeze([...descriptor.sourceTitles]),
            ignoredPdfFooterTexts: Object.freeze([...descriptor.ignoredPdfFooterTexts]) });
    }

    function requirePage(page) {
        if (!Object.hasOwn(descriptors, page)) {
            throw new CmsApiError("LEGAL_PAGE_NOT_ALLOWED", "Unknown legal page.", 403);
        }
        return descriptors[page];
    }
    function stagedKey(page, kind, hash) {
        requirePage(page);
        if (!["document", "pdf"].includes(kind) || !HASH.test(hash)) {
            throw new CmsApiError("INVALID_LEGAL_REFERENCE", "Invalid legal file reference.", 422);
        }
        return `legal/staged/${page}/${kind}/${hash}`;
    }
    function sourcePath(page, document) {
        requirePage(page);
        const extension = document?.name?.split(".").at(-1).toLowerCase();
        if (!["docx", "md", "txt"].includes(extension) || !HASH.test(document?.hash)) {
            throw new CmsApiError("INVALID_LEGAL_REFERENCE", "Invalid legal document reference.", 422);
        }
        return `${sourceDirectory}/${page}-${document.hash}.${extension}`;
    }
    const capability = Object.freeze({ pages: Object.freeze(descriptors), manifestPath,
        renderedPath, sourceDirectory, requirePage, stagedKey, sourcePath,
        assetBundle, allowManifestlessOriginals,
        initialPairs: () => structuredClone(originals),
        originalBytes: (page, kind) => { requirePage(page); return Buffer.from(bytes.get(`${page}:${kind}`)); } });
    verifiedCapabilities.add(capability);
    return capability;
}
