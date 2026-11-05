import { CmsApiError } from "../http.js";
import { isDeepStrictEqual } from "node:util";
import { withCmsMutationLease } from "../coordination/mutation.js";
import { isCmsLegalCapability } from "./capability.js";
import { createCmsLegacyLegalPreviewReader } from "../handlers/legacy-legal-preview.js";
import { compareLegalText, extractPdfText, LEGAL_MAX_BYTES, legalHash,
    parseLegalDocx, parseLegalText, validateLegalBlocks } from "./document.js";

function conflict(message) {
    throw new CmsApiError("DRAFT_CONFLICT", message, 409);
}
function missing() {
    throw new CmsApiError("LEGAL_FILE_NOT_FOUND", "The staged legal file was not found.", 404);
}
function extension(name) { return name.split(".").at(-1).toLowerCase(); }
const legalServices = new WeakSet();

export function isCmsLegalService(value) {
    return Boolean(value && typeof value === "object" && legalServices.has(value));
}

export function createCmsLegalService({ capability, store, records, leases,
    previewBasePath = "/api/cms", now = () => new Date() } = {}) {
    if (!isCmsLegalCapability(capability) || typeof capability?.requirePage !== "function" ||
        typeof capability?.stagedKey !== "function" ||
        typeof capability?.initialPairs !== "function" ||
        typeof store?.set !== "function" || typeof store?.setJSON !== "function" ||
        typeof store?.getWithMetadata !== "function" ||
        typeof records?.read !== "function" ||
        typeof records?.writeIfVersion !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" || typeof now !== "function" ||
        typeof previewBasePath !== "string" ||
        !/^\/(?!\/)[a-zA-Z0-9._~/-]*$/.test(previewBasePath) ||
        (previewBasePath !== "/" && previewBasePath.endsWith("/")) ||
        (previewBasePath === "/" ? [] : previewBasePath.split("/").slice(1))
            .some((segment) => !segment || segment === "." || segment === "..")) {
        throw new TypeError("Invalid CMS legal service configuration.");
    }
    const initial = capability.initialPairs();
    const pages = Object.keys(initial);
    const legalFromRecord = (record) => ({ ...capability.initialPairs(),
        ...(record?.legal ?? {}) });

    function previewUrl(page, kind, hash) {
        capability.stagedKey(page, kind, hash);
        const root = previewBasePath === "/" ? "" : previewBasePath;
        return `${root}/legal-preview?page=${page}&kind=${kind}&hash=${hash}`;
    }

    async function readMetadata(page, kind, hash) {
        const key = capability.stagedKey(page, kind, hash);
        const record = await store.getWithMetadata(`${key}/metadata`,
            { type: "json", consistency: "strong" });
        const metadata = record?.data;
        const ext = extension(metadata?.name ?? "");
        if (typeof record?.etag !== "string" || !record.etag ||
            !metadata || metadata.page !== page || metadata.kind !== kind ||
            metadata.hash !== hash || typeof metadata.name !== "string" ||
            !metadata.name || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,179}$/.test(metadata.name) ||
            (kind === "pdf" ? ext !== "pdf" : !["docx", "md", "txt"].includes(ext))) missing();
        return metadata;
    }

    async function readFile(page, kind, hash) {
        const original = initial[page]?.[kind];
        if (original?.hash === hash) return capability.originalBytes(page, kind);
        const key = capability.stagedKey(page, kind, hash);
        const stored = await store.getWithMetadata(key,
            { type: "arrayBuffer", consistency: "strong" });
        const expectedType = kind === "pdf" ? "application/pdf" : "application/octet-stream";
        if (!(stored?.data instanceof ArrayBuffer) ||
            typeof stored.etag !== "string" || !stored.etag ||
            stored.metadata?.page !== page || stored.metadata?.kind !== kind ||
            stored.metadata?.hash !== hash ||
            stored.metadata?.contentType !== expectedType ||
            legalHash(Buffer.from(stored.data)) !== hash) missing();
        return Buffer.from(stored.data);
    }

    async function entry(page, kind, hash) {
        const original = initial[page]?.[kind];
        if (original?.hash === hash) return structuredClone(original);
        const metadata = await readMetadata(page, kind, hash);
        const bytes = await readFile(page, kind, hash);
        if (kind === "pdf") return { hash, name: metadata.name };
        const ext = extension(metadata.name);
        if (!["docx", "md", "txt"].includes(ext)) missing();
        const descriptor = capability.requirePage(page);
        const document = ext === "docx"
            ? parseLegalDocx(bytes, { sourceTitles: descriptor.sourceTitles })
            : parseLegalText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), ext);
        return { ...document, hash, name: metadata.name };
    }

    async function composePair(page, documentHash, pdfHash) {
        const descriptor = capability.requirePage(page);
        const [document, pdf] = await Promise.all([
            entry(page, "document", documentHash), entry(page, "pdf", pdfHash),
        ]);
        if (!validateLegalBlocks(document)) {
            throw new CmsApiError("INVALID_LEGAL_DOCUMENT", "The legal document is invalid.", 422);
        }
        const pdfText = await extractPdfText(await readFile(page, "pdf", pdfHash),
            { ignoredFooterTexts: descriptor.ignoredPdfFooterTexts });
        return { document, pdf, verification: compareLegalText(document, pdfText),
            confirmation: null };
    }

    async function stage({ page, kind, file }, actor) {
        const descriptor = capability.requirePage(page);
        if (!["document", "pdf"].includes(kind)) {
            throw new CmsApiError("INVALID_LEGAL_REFERENCE", "Invalid legal file reference.", 422);
        }
        if (!(file instanceof Blob) || typeof file.name !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,179}$/.test(file.name)) {
            throw new CmsApiError("INVALID_LEGAL_FILE", "Choose a file with a safe name.", 422);
        }
        const ext = extension(file.name);
        if (kind === "pdf" ? ext !== "pdf" : !["docx", "md", "txt"].includes(ext)) {
            throw new CmsApiError("INVALID_LEGAL_FILE", kind === "pdf" ? "Choose a PDF."
                : "Choose a DOCX, Markdown, or plain text document.", 415);
        }
        if (!file.size || file.size > LEGAL_MAX_BYTES) {
            throw new CmsApiError("INVALID_LEGAL_FILE_SIZE", "Legal files must be 8 MB or smaller.", 413);
        }
        if (typeof actor?.email !== "string" || !actor.email) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength !== file.size) {
            throw new CmsApiError("INVALID_LEGAL_FILE", "The uploaded legal file changed.", 422);
        }
        const hash = legalHash(bytes);
        if (kind === "document") {
            const document = ext === "docx"
                ? parseLegalDocx(bytes, { sourceTitles: descriptor.sourceTitles })
                : parseLegalText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), ext);
            if (!validateLegalBlocks(document)) {
                throw new CmsApiError("INVALID_LEGAL_DOCUMENT", "The document has unsupported content.", 422);
            }
        } else await extractPdfText(bytes,
            { ignoredFooterTexts: descriptor.ignoredPdfFooterTexts });
        const key = capability.stagedKey(page, kind, hash);
        return withCmsMutationLease(leases, async (ensureActive) => {
            const timestamp = now().toISOString();
            const metadata = { page, kind, hash, name: file.name,
                uploadedAt: timestamp, uploadedBy: actor.email };
            await ensureActive();
            const written = await store.set(key, bytes.buffer, { onlyIfNew: true,
                metadata: { page, kind, hash, uploadedAt: timestamp,
                    contentType: kind === "pdf" ? "application/pdf" : "application/octet-stream" } });
            if (written?.modified) {
                await ensureActive();
                const sidecar = await store.setJSON(`${key}/metadata`, metadata,
                    { onlyIfNew: true });
                if (!sidecar?.modified) {
                    const existing = await readMetadata(page, kind, hash);
                    if (kind === "document" && extension(existing.name) !== ext) {
                        throw new CmsApiError("LEGAL_VERSION_FORMAT_CONFLICT",
                            "These bytes were already uploaded in a different document format.", 409);
                    }
                    metadata.name = existing.name;
                }
            } else {
                let existing;
                try { existing = await readMetadata(page, kind, hash); }
                catch (error) {
                    if (error?.code !== "LEGAL_FILE_NOT_FOUND") throw error;
                    await ensureActive();
                    const repaired = await store.setJSON(`${key}/metadata`, metadata,
                        { onlyIfNew: true });
                    existing = repaired?.modified ? metadata : await readMetadata(page, kind, hash);
                }
                await readFile(page, kind, hash);
                if (kind === "document" && extension(existing.name) !== ext) {
                    throw new CmsApiError("LEGAL_VERSION_FORMAT_CONFLICT",
                        "These bytes were already uploaded in a different document format.", 409);
                }
                metadata.name = existing.name;
            }
            return { page, kind, hash, name: metadata.name, versionId: hash,
                previewUrl: previewUrl(page, kind, hash) };
        });
    }

    function requirePublicationReady(legal, confirmedLegal) {
        for (const page of pages) {
            const pair = legal?.[page] ?? initial[page];
            const live = confirmedLegal?.[page] ?? initial[page];
            if (pair?.document?.hash === live.document.hash &&
                pair?.pdf?.hash === live.pdf.hash) continue;
            if (!pair?.document?.hash || !pair?.pdf?.hash ||
                !validateLegalBlocks(pair.document)) {
                throw new CmsApiError("LEGAL_PAIR_INCOMPLETE",
                    "The legal document and PDF must both be present.", 422);
            }
            if (pair.verification?.status === "different") {
                throw new CmsApiError("LEGAL_CONTENT_DIFFERENT",
                    `${capability.requirePage(page).label}: ${pair.verification.explanation}`, 422);
            }
            if (pair.verification?.status === "could-not-verify" && (
                pair.confirmation?.documentHash !== pair.document.hash ||
                pair.confirmation?.pdfHash !== pair.pdf.hash ||
                !pair.confirmation?.editor || !pair.confirmation?.at)) {
                throw new CmsApiError("LEGAL_CONFIRMATION_REQUIRED",
                    "Review both exact legal file versions before publishing.", 409);
            }
        }
    }

    async function verifyPublication(legal, confirmedLegal) {
        for (const page of pages) {
            const pair = legal?.[page] ?? initial[page];
            const live = confirmedLegal?.[page] ?? initial[page];
            if (pair.document.hash === live.document.hash && pair.pdf.hash === live.pdf.hash) continue;
            const verified = await composePair(page, pair.document.hash, pair.pdf.hash);
            if (verified.verification.status !== pair.verification?.status ||
                JSON.stringify({ sourceTitle: verified.document.sourceTitle,
                    blocks: verified.document.blocks }) !==
                JSON.stringify({ sourceTitle: pair.document.sourceTitle,
                    blocks: pair.document.blocks })) {
                throw new CmsApiError("LEGAL_VERIFICATION_CHANGED",
                    "Legal file verification changed. Reload and review the pair.", 409);
            }
        }
        requirePublicationReady(legal, confirmedLegal);
    }

    async function saveDraft({ page, documentHash, pdfHash,
        expectedDraftVersion }, actor) {
        capability.requirePage(page);
        if (typeof actor?.email !== "string" || !actor.email) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        return withCmsMutationLease(leases, async (ensureActive) => {
            const [draft, live] = await Promise.all([records.read("draft"),
                records.read("confirmedLive")]);
            if (!live) throw new CmsApiError("CMS_FOUNDATION_NOT_INITIALIZED",
                "Initial PUBLIC CMS state is unavailable.", 503);
            if ((draft?.etag ?? null) !== (expectedDraftVersion ?? null)) {
                conflict("The draft changed. Reload before saving legal files.");
            }
            const pair = await composePair(page, documentHash, pdfHash);
            const hasDraft = Boolean(draft) && draft.data.hasUnpublishedChanges !== false;
            const legal = { ...legalFromRecord(hasDraft ? draft.data : live.data),
                [page]: pair };
            const record = { ...(draft?.data ?? {}),
                content: hasDraft ? draft.data.content : live.data.content,
                legal, updatedAt: now().toISOString(), updatedBy: actor.email,
                baseRevision: hasDraft ? draft.data.baseRevision : live.data.revisionId,
                hasUnpublishedChanges: true };
            await ensureActive();
            const result = await records.writeIfVersion("draft", record, draft?.etag ?? null);
            if (!result.modified || !result.etag) {
                conflict("The draft changed. Reload before saving legal files.");
            }
            return { legal, draftVersion: result.etag, hasSavedDraft: true };
        });
    }

    async function confirmPair({ page, expectedDraftVersion, documentHash,
        pdfHash }, actor) {
        capability.requirePage(page);
        if (typeof actor?.email !== "string" || !actor.email) {
            throw new TypeError("A trusted CMS actor is required.");
        }
        return withCmsMutationLease(leases, async (ensureActive) => {
            const draft = await records.read("draft");
            if (!draft || draft.etag !== expectedDraftVersion) {
                conflict("The draft changed. Review the current files again.");
            }
            const pair = draft.data.legal?.[page];
            if (!pair || pair.document.hash !== documentHash || pair.pdf.hash !== pdfHash ||
                pair.verification?.status !== "could-not-verify") {
                throw new CmsApiError("LEGAL_CONFIRMATION_INVALID",
                    "Only the exact inconclusive pair can be confirmed.", 409);
            }
            const verified = await composePair(page, documentHash, pdfHash);
            if (verified.verification.status !== "could-not-verify") {
                throw new CmsApiError("LEGAL_VERIFICATION_CHANGED",
                    "Legal file verification changed. Reload and review the pair.", 409);
            }
            const confirmation = { documentHash, pdfHash, editor: actor.email,
                at: now().toISOString() };
            const legal = { ...draft.data.legal, [page]: { ...pair, confirmation } };
            await ensureActive();
            const result = await records.writeIfVersion("draft", { ...draft.data, legal },
                draft.etag);
            if (!result.modified || !result.etag) {
                conflict("The draft changed. Review the current files again.");
            }
            return { legal, draftVersion: result.etag, confirmation };
        });
    }

    async function composeChanges(legal, changes) {
        if (!Array.isArray(changes)) throw new TypeError("Legal changes must be an array.");
        const next = { ...legalFromRecord({ legal }) };
        const seen = new Set();
        for (const change of changes) {
            const match = /^legal\.([a-z][a-z0-9-]*)\.(document|pdf)$/.exec(change?.path);
            if (!match || seen.has(change.path)) {
                throw new CmsApiError("UNKNOWN_FIELD", "A legal file field was repeated or unknown.", 422);
            }
            capability.requirePage(match[1]);
            seen.add(change.path);
        }
        for (const page of pages) {
            const documentHash = changes.find(({ path }) => path === `legal.${page}.document`)?.value;
            const pdfHash = changes.find(({ path }) => path === `legal.${page}.pdf`)?.value;
            if (documentHash === undefined && pdfHash === undefined) continue;
            next[page] = await composePair(page,
                documentHash ?? next[page].document.hash,
                pdfHash ?? next[page].pdf.hash);
        }
        return next;
    }

    async function proveNewReferences({ record, current, live, github, ensureActive }) {
        if (!record || !live || typeof github?.readFileAtCommit !== "function" ||
            typeof ensureActive !== "function") throw new TypeError("Invalid legal reference proof.");
        const next = legalFromRecord(record);
        const previous = legalFromRecord(current?.data);
        const confirmed = legalFromRecord(live.data);
        for (const page of pages) {
            for (const kind of ["document", "pdf"]) {
                const item = next[page]?.[kind];
                const hash = item?.hash;
                capability.stagedKey(page, kind, hash);
                if (hash === previous[page][kind].hash ||
                    hash === confirmed[page][kind].hash ||
                    hash === initial[page][kind].hash) continue;
                await ensureActive();
                const key = capability.stagedKey(page, kind, hash);
                const staged = await store.getWithMetadata(key,
                    { type: "arrayBuffer", consistency: "strong" });
                let bytes;
                if (staged !== null) {
                    const verified = await entry(page, kind, hash);
                    if (verified.name !== item.name ||
                        (kind === "document" && !isDeepStrictEqual({
                            sourceTitle: verified.sourceTitle, blocks: verified.blocks },
                        { sourceTitle: item.sourceTitle, blocks: item.blocks }))) {
                        throw new CmsApiError("LEGAL_VERIFICATION_CHANGED",
                            "Legal file verification changed. Reload and review the pair.", 409);
                    }
                    bytes = await readFile(page, kind, hash);
                } else {
                    const sidecar = await store.getWithMetadata(`${key}/metadata`,
                        { type: "json", consistency: "strong" });
                    if (sidecar !== null) {
                        throw new CmsApiError("LEGAL_FILE_NOT_FOUND",
                            "The staged legal file is unavailable or changed.", 404);
                    }
                    const commit = live.data.commit ?? live.data.revisionId;
                    if (!/^[0-9a-f]{40}$/i.test(commit)) {
                        throw new CmsApiError("LEGAL_FILE_NOT_FOUND",
                            "The staged legal file is unavailable or changed.", 404);
                    }
                    const path = kind === "pdf" ? capability.requirePage(page).pdfPath
                        : capability.sourcePath(page, item);
                    await ensureActive();
                    try { bytes = await github.readFileAtCommit(path, commit); }
                    catch { throw new CmsApiError("LEGAL_FILE_NOT_FOUND",
                        "The staged legal file is unavailable or changed.", 404); }
                    if (!Buffer.isBuffer(bytes) || legalHash(bytes) !== hash) {
                        throw new CmsApiError("LEGAL_FILE_NOT_FOUND",
                            "The staged legal file is unavailable or changed.", 404);
                    }
                    if (kind === "document") {
                        const ext = extension(item.name);
                        const descriptor = capability.requirePage(page);
                        const parsed = ext === "docx"
                            ? parseLegalDocx(bytes, { sourceTitles: descriptor.sourceTitles })
                            : parseLegalText(new TextDecoder("utf-8", { fatal: true })
                                .decode(bytes), ext);
                        if (!isDeepStrictEqual({ sourceTitle: parsed.sourceTitle,
                            blocks: parsed.blocks }, { sourceTitle: item.sourceTitle,
                            blocks: item.blocks })) {
                            throw new CmsApiError("LEGAL_VERIFICATION_CHANGED",
                                "Legal file verification changed. Reload and review the pair.", 409);
                        }
                    }
                }
                if (kind === "pdf") {
                    await extractPdfText(bytes, { ignoredFooterTexts:
                        capability.requirePage(page).ignoredPdfFooterTexts });
                }
            }
        }
    }

    const service = Object.freeze({ capability, initialPairs: capability.initialPairs,
        legalFromRecord,
        createLegacyPreviewReader: () => createCmsLegacyLegalPreviewReader({
            legalService: service, store }),
        stage, readMetadata, readFile, previewUrl, entry, composePair, composeChanges,
        requirePublicationReady, verifyPublication, saveDraft, confirmPair,
        proveNewReferences });
    legalServices.add(service);
    return service;
}
