import { isDeepStrictEqual } from "node:util";
import { CmsApiError } from "../http.js";
import { isCmsLegalCapability } from "./capability.js";
import { extractPdfText, legalHash, parseLegalDocx, parseLegalText } from "./document.js";
import { inventoryDurableLegalReferences } from "./references.js";
import { isCmsLegalService } from "./service.js";

const COMMIT = /^[0-9a-f]{40}$/i;

function unavailable() {
    throw new CmsApiError("REVISION_ASSET_UNAVAILABLE",
        "A historical legal file could not be restored.", 502);
}
function changed() {
    throw new CmsApiError("CMS_STATE_CONFLICT",
        "Restored staged legal state changed before rollback.", 409);
}

export function createCmsHistoricalLegalRecovery({ capability, service, store, github,
    now = () => new Date() } = {}) {
    if (!isCmsLegalCapability(capability) || !isCmsLegalService(service) ||
        service.capability !== capability ||
        typeof store?.getWithMetadata !== "function" ||
        typeof store?.getMetadata !== "function" ||
        typeof store?.set !== "function" || typeof store?.setJSON !== "function" ||
        typeof store?.delete !== "function" ||
        typeof github?.readFileAtCommit !== "function" || typeof now !== "function") {
        throw new TypeError("Invalid historical legal recovery configuration.");
    }

    async function rollbackOne(key, expectedEtag, identity, ensureActive) {
        await ensureActive();
        const current = await store.getWithMetadata(key,
            { type: identity.type, consistency: "strong" });
        if (!current || current.etag !== expectedEtag ||
            (identity.type === "json" ?
                current.data?.page !== identity.page ||
                current.data?.kind !== identity.kind ||
                current.data?.hash !== identity.hash :
                current.metadata?.page !== identity.page ||
                current.metadata?.kind !== identity.kind ||
                current.metadata?.hash !== identity.hash)) changed();
        await ensureActive();
        await store.delete(key);
    }

    async function recover({ snapshot, page, kind, ensureActive } = {}) {
        if (!snapshot || typeof snapshot !== "object" ||
            typeof ensureActive !== "function") {
            throw new TypeError("A trusted historical snapshot and lease are required.");
        }
        const inventory = inventoryDurableLegalReferences({
            baseline: { legal: service.initialPairs() }, confirmedLive: snapshot,
        }, capability);
        if (inventory.errors.length) unavailable();
        const descriptor = capability.requirePage(page);
        if (!["document", "pdf"].includes(kind)) unavailable();
        const entry = service.legalFromRecord(snapshot)[page]?.[kind];
        const original = service.initialPairs()[page][kind];
        if (!entry || typeof entry.name !== "string" || !entry.name ||
            (entry.original && entry.hash !== original.hash)) unavailable();
        if (entry.hash === original.hash) {
            if (entry.name !== original.name ||
                (kind === "document" && !isDeepStrictEqual({
                    sourceTitle: entry.sourceTitle, blocks: entry.blocks },
                { sourceTitle: original.sourceTitle, blocks: original.blocks }))) unavailable();
            return undefined;
        }
        const commit = snapshot.commit ?? snapshot.sourceCommit ?? snapshot.revisionId ?? snapshot.id;
        if (!COMMIT.test(commit)) unavailable();
        const key = capability.stagedKey(page, kind, entry.hash);
        const sidecarKey = `${key}/metadata`;
        async function verifyExisting() {
            const metadata = await service.readMetadata(page, kind, entry.hash);
            const verified = await service.entry(page, kind, entry.hash);
            const bytes = await service.readFile(page, kind, entry.hash);
            if (metadata.name !== entry.name || verified.name !== entry.name ||
                (kind === "document" && !isDeepStrictEqual({
                    sourceTitle: verified.sourceTitle, blocks: verified.blocks },
                { sourceTitle: entry.sourceTitle, blocks: entry.blocks }))) unavailable();
            if (kind === "pdf") await extractPdfText(bytes,
                { ignoredFooterTexts: descriptor.ignoredPdfFooterTexts });
        }
        const prior = await store.getWithMetadata(key,
            { type: "arrayBuffer", consistency: "strong" });
        if (prior !== null) {
            try { await verifyExisting(); } catch { unavailable(); }
            return undefined;
        }
        if (await store.getWithMetadata(sidecarKey,
            { type: "json", consistency: "strong" }) !== null) unavailable();
        let path;
        try { path = kind === "pdf" ? descriptor.pdfPath : capability.sourcePath(page, entry); }
        catch { unavailable(); }
        let bytes;
        try { bytes = await github.readFileAtCommit(path, commit); }
        catch { unavailable(); }
        if (!Buffer.isBuffer(bytes) || legalHash(bytes) !== entry.hash) unavailable();
        let verifiedTextAvailable = false;
        if (kind === "document") {
            const ext = entry.name.split(".").at(-1).toLowerCase();
            let parsed;
            try {
                parsed = ext === "docx"
                    ? parseLegalDocx(bytes, { sourceTitles: descriptor.sourceTitles })
                    : parseLegalText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), ext);
            } catch { unavailable(); }
            if (!isDeepStrictEqual({ sourceTitle: parsed.sourceTitle, blocks: parsed.blocks },
                { sourceTitle: entry.sourceTitle, blocks: entry.blocks })) unavailable();
        } else {
            try { verifiedTextAvailable = Boolean(await extractPdfText(bytes,
                { ignoredFooterTexts: descriptor.ignoredPdfFooterTexts })); }
            catch { unavailable(); }
        }
        const timestamp = now();
        if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) unavailable();
        const uploadedAt = timestamp.toISOString();
        const identity = { page, kind, hash: entry.hash };
        await ensureActive();
        const staged = await store.set(key,
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
                onlyIfNew: true, metadata: { ...identity, uploadedAt,
                    contentType: kind === "pdf" ? "application/pdf" : "application/octet-stream" },
            });
        if (!staged?.modified) {
            try { await verifyExisting(); } catch { unavailable(); }
            return undefined;
        }
        if (typeof staged.etag !== "string" || !staged.etag) unavailable();
        let metadataEtag;
        try {
            await ensureActive();
            const sidecar = await store.setJSON(sidecarKey, { ...identity, name: entry.name,
                uploadedAt, restoredFrom: commit,
                ...(kind === "pdf" ? { verifiedTextAvailable } : {}) },
            { onlyIfNew: true });
            if (!sidecar?.modified || typeof sidecar.etag !== "string" || !sidecar.etag) {
                unavailable();
            }
            metadataEtag = sidecar.etag;
            await service.readMetadata(page, kind, entry.hash);
            await service.readFile(page, kind, entry.hash);
        } catch (error) {
            const failures = [];
            if (metadataEtag) {
                try { await rollbackOne(sidecarKey, metadataEtag,
                    { ...identity, type: "json" }, ensureActive); }
                catch (failure) { failures.push(failure); }
            }
            try { await rollbackOne(key, staged.etag, { ...identity,
                type: "arrayBuffer" }, ensureActive); }
            catch (failure) { failures.push(failure); }
            if (failures.length) {
                throw new CmsApiError("RESTORE_CLEANUP_FAILED",
                    "Restore failed and a newly staged legal file could not be removed.",
                    502, { originalCode: error?.code ?? "RESTORE_FAILED",
                        count: failures.length });
            }
            throw error;
        }
        return async () => {
            if (metadataEtag) await rollbackOne(sidecarKey, metadataEtag,
                { ...identity, type: "json" }, ensureActive);
            await rollbackOne(key, staged.etag,
                { ...identity, type: "arrayBuffer" }, ensureActive);
        };
    }

    return Object.freeze({ recover });
}
