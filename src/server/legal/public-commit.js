import { isDeepStrictEqual } from "node:util";
import { CmsApiError } from "../http.js";
import { isCmsLegalCapability } from "./capability.js";
import { legalHash, parseLegalDocx, parseLegalText,
    validateLegalBlocks } from "./document.js";

const COMMIT = /^[0-9a-f]{40}$/i;
const HASH = /^[0-9a-f]{64}$/;
const verifiedPublicLegalVerifiers = new WeakSet();

export function isCmsPublicLegalVerifier(value) {
    return Boolean(value && typeof value === "object" &&
        verifiedPublicLegalVerifiers.has(value));
}

function invalid(message = "The deployed legal document and PDF pair could not be verified.") {
    throw new CmsApiError("PUBLIC_LEGAL_PAIR_INVALID", message, 502);
}
function sameKeys(value, expected) {
    return value && typeof value === "object" && !Array.isArray(value) &&
        isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}
function renderedDocument(document) {
    return { sourceTitle: document.sourceTitle, blocks: document.blocks };
}

export function createCmsPublicLegalVerifier({ capability, github } = {}) {
    if (!isCmsLegalCapability(capability) ||
        typeof github?.readFileAtCommit !== "function") {
        throw new TypeError("Invalid PUBLIC legal verifier configuration.");
    }
    const pages = Object.keys(capability.pages);
    const originals = capability.initialPairs();

    async function read(path, commit, allowMissing = false) {
        const value = await github.readFileAtCommit(path, commit, { allowMissing });
        if (value === null && allowMissing) return null;
        if (!Buffer.isBuffer(value)) invalid();
        return value;
    }
    function json(bytes) {
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { invalid(); }
    }

    async function readAtCommit(commitSha) {
        if (!COMMIT.test(commitSha)) invalid();
        try {
            const manifest = await read(capability.manifestPath, commitSha, true);
            if (manifest === null) {
                if (!capability.allowManifestlessOriginals) invalid();
                const [renderedBytes, ...pdfs] = await Promise.all([
                    read(capability.renderedPath, commitSha, true),
                    ...pages.map((page) =>
                        read(capability.requirePage(page).pdfPath, commitSha, true)),
                ]);
                if (renderedBytes === null && pdfs.every((pdf) => pdf === null)) {
                    return capability.initialPairs();
                }
                if (!renderedBytes || pdfs.some((pdf) => !pdf)) invalid(
                    "The deployed initial legal files do not match the approved originals.");
                const rendered = json(renderedBytes);
                if (!sameKeys(rendered, pages)) invalid();
                for (const [index, page] of pages.entries()) {
                    if (!isDeepStrictEqual(rendered[page],
                        renderedDocument(originals[page].document)) ||
                        legalHash(pdfs[index]) !== originals[page].pdf.hash) {
                        invalid("The deployed initial legal files do not match the approved originals.");
                    }
                }
                return capability.initialPairs();
            }
            const legal = json(manifest);
            if (!sameKeys(legal, pages)) invalid();
            for (const page of pages) {
                const pair = legal[page];
                const document = pair?.document;
                const pdf = pair?.pdf;
                if (!validateLegalBlocks(document) || !HASH.test(document?.hash) ||
                    !HASH.test(pdf?.hash) || typeof pdf.name !== "string" ||
                    !pdf.name.toLowerCase().endsWith(".pdf")) invalid();
                const pdfBytes = await read(capability.requirePage(page).pdfPath, commitSha);
                if (legalHash(pdfBytes) !== pdf.hash) invalid();
                const original = originals[page].document;
                if (document.hash === original.hash) {
                    if (!isDeepStrictEqual(document, original)) invalid();
                } else {
                    const path = capability.sourcePath(page, document);
                    const source = await read(path, commitSha);
                    if (legalHash(source) !== document.hash) invalid();
                    const ext = document.name.split(".").at(-1).toLowerCase();
                    const parsed = ext === "docx"
                        ? parseLegalDocx(source, { sourceTitles:
                            capability.requirePage(page).sourceTitles })
                        : parseLegalText(new TextDecoder("utf-8", { fatal: true })
                            .decode(source), ext);
                    if (!isDeepStrictEqual(renderedDocument(parsed),
                        renderedDocument(document))) invalid();
                }
            }
            const rendered = json(await read(capability.renderedPath, commitSha));
            if (!sameKeys(rendered, pages)) invalid();
            for (const page of pages) {
                if (!isDeepStrictEqual(rendered[page],
                    renderedDocument(legal[page].document))) invalid();
            }
            return legal;
        } catch (error) {
            if (error?.code === "PUBLIC_LEGAL_PAIR_INVALID") throw error;
            invalid();
        }
    }
    const verifier = Object.freeze({ capability, github, readAtCommit });
    verifiedPublicLegalVerifiers.add(verifier);
    return verifier;
}
