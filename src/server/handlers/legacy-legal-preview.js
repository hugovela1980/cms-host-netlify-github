import { CmsApiError } from "../http.js";
import { legalHash, parseLegalDocx, parseLegalText } from "../legal/document.js";

const HASH = /^[0-9a-f]{64}$/;

// This reader is used only by an explicitly configured preview handler.
// Draft, publication, Restore, and legal-reference reads keep the strict service checks.
export function createCmsLegacyLegalPreviewReader({ legalService, store }) {
    if (typeof store?.get !== "function" ||
        typeof store?.getWithMetadata !== "function") {
        throw new TypeError("Legacy legal preview requires a readable store.");
    }
    const { capability } = legalService;
    const originals = legalService.initialPairs();

    function stagedKey(page, kind, hash) {
        if (!Object.hasOwn(capability.pages, page) ||
            !["document", "pdf"].includes(kind) || !HASH.test(hash)) {
            throw new CmsApiError("INVALID_LEGAL_REFERENCE",
                "Invalid legal file reference.", 422);
        }
        return `legal/staged/${page}/${kind}/${hash}`;
    }

    async function readFile(page, kind, hash) {
        const original = originals[page]?.[kind];
        if (original?.hash === hash) return capability.originalBytes(page, kind);
        const data = await store.get(stagedKey(page, kind, hash),
            { type: "arrayBuffer", consistency: "strong" });
        if (!data || legalHash(Buffer.from(data)) !== hash) {
            throw new CmsApiError("LEGAL_FILE_NOT_FOUND",
                "The staged legal file is unavailable or changed.", 404);
        }
        return Buffer.from(data);
    }

    async function readMetadata(page, kind, hash) {
        const record = await store.getWithMetadata(`${stagedKey(page, kind, hash)}/metadata`,
            { type: "json", consistency: "strong" });
        const metadata = record?.data;
        if (!metadata || metadata.page !== page || metadata.kind !== kind ||
            metadata.hash !== hash) {
            throw new CmsApiError("LEGAL_FILE_NOT_FOUND",
                "The staged legal file was not found.", 404);
        }
        return metadata;
    }

    async function entry(page, kind, hash) {
        const original = originals[page]?.[kind];
        if (original?.hash === hash) return structuredClone(original);
        const metadata = await readMetadata(page, kind, hash);
        const bytes = await readFile(page, kind, hash);
        const extension = metadata.name.split(".").at(-1).toLowerCase();
        const document = extension === "docx" ? parseLegalDocx(bytes,
            { sourceTitles: capability.requirePage(page).sourceTitles }) :
            parseLegalText(new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                extension);
        return { ...document, hash, name: metadata.name };
    }

    return Object.freeze({ readFile, entry });
}
