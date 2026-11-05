import { CmsApiError } from "../http.js";
import { withCmsMutationLease } from "../coordination/mutation.js";
import { isCmsLegalCapability } from "./capability.js";
import { inventoryDurableLegalReferences } from "./references.js";

export const LEGAL_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGAL_MAX_SCAN_COUNT = 100;
export const LEGAL_MAX_DELETE_COUNT = 50;
const ROOTS = ["draft", "baseline", "confirmedLive", "publication", "revisions"];
const KEY = /^legal\/staged\/([a-z][a-z0-9-]*)\/(document|pdf)\/([0-9a-f]{64})(\/metadata)?$/;

function conflict() {
    throw new CmsApiError("CMS_STATE_CONFLICT", "Staged legal state changed during cleanup.", 409);
}
function incomplete() {
    throw new CmsApiError("LEGAL_REFERENCES_INCOMPLETE",
        "Legal file cleanup requires complete durable CMS state.", 503);
}
function validEtag(value) { return typeof value === "string" && value.length > 0; }

export function createCmsLegalCleanup({ capability, store, records, leases,
    now = () => new Date() } = {}) {
    if (!isCmsLegalCapability(capability) || typeof store?.list !== "function" ||
        typeof store?.getMetadata !== "function" ||
        typeof store?.getWithMetadata !== "function" ||
        typeof store?.delete !== "function" || typeof records?.read !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" || typeof now !== "function") {
        throw new TypeError("Invalid CMS legal cleanup configuration.");
    }

    async function inventory() {
        const entries = await Promise.all(ROOTS.map((name) => records.read(name)));
        const roots = Object.fromEntries(ROOTS.map((name, index) => {
            const entry = entries[index];
            if (entry !== null && (typeof entry !== "object" ||
                !entry.data || typeof entry.data !== "object" ||
                Array.isArray(entry.data))) incomplete();
            return [name, entry?.data ?? null];
        }));
        const result = inventoryDurableLegalReferences(roots, capability);
        if (result.errors.length) incomplete();
        return result.protectedKeys;
    }

    async function blobAt(key, match) {
        const item = await store.getMetadata(key, { consistency: "strong" });
        if (item === null) return null;
        if (!item || !validEtag(item.etag) ||
            item.metadata?.page !== match[1] || item.metadata?.kind !== match[2] ||
            item.metadata?.hash !== match[3] ||
            item.metadata?.contentType !== (match[2] === "pdf"
                ? "application/pdf" : "application/octet-stream") ||
            typeof item.metadata?.uploadedAt !== "string") conflict();
        return item;
    }

    async function sidecarAt(key, match) {
        const item = await store.getWithMetadata(`${key}/metadata`,
            { type: "json", consistency: "strong" });
        if (item === null) return null;
        const data = item?.data;
        const ext = data?.name?.split(".").at(-1).toLowerCase();
        if (!validEtag(item?.etag) || data?.page !== match[1] ||
            data?.kind !== match[2] || data?.hash !== match[3] ||
            typeof data?.name !== "string" ||
            (match[2] === "pdf" ? ext !== "pdf" :
                !["docx", "md", "txt"].includes(ext))) conflict();
        return item;
    }

    function oldEnough(uploadedAt, currentTime) {
        const time = Date.parse(uploadedAt ?? "");
        return Number.isFinite(time) && time <= currentTime &&
            currentTime - time >= LEGAL_MIN_AGE_MS;
    }

    async function sweep({ maxScanned = LEGAL_MAX_SCAN_COUNT,
        maxDeletions = LEGAL_MAX_DELETE_COUNT } = {}) {
        if (!Number.isSafeInteger(maxScanned) || maxScanned < 1 ||
            maxScanned > LEGAL_MAX_SCAN_COUNT ||
            !Number.isSafeInteger(maxDeletions) || maxDeletions < 1 ||
            maxDeletions > LEGAL_MAX_DELETE_COUNT) {
            throw new TypeError("Invalid legal cleanup bounds.");
        }
        const timestamp = now();
        if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
            throw new TypeError("Invalid legal cleanup time.");
        }
        let entered = false;
        try {
            return await withCmsMutationLease(leases, async (ensureActive) => {
                entered = true;
                await ensureActive();
                const protectedKeys = await inventory();
                const result = { scanned: 0, deletionAttempts: 0, deleted: [], failed: [] };
                const handledBytes = new Set();
                scan:
                for await (const page of store.list({ prefix: "legal/staged/", paginate: true })) {
                    if (!Array.isArray(page?.blobs)) conflict();
                    for (const listed of page.blobs) {
                        if (result.scanned >= maxScanned ||
                            result.deletionAttempts >= maxDeletions) break scan;
                        result.scanned += 1;
                        if (typeof listed?.key !== "string" || !validEtag(listed.etag) ||
                            !listed.key.startsWith("legal/staged/")) conflict();
                        const match = KEY.exec(listed.key);
                        if (!match || !Object.hasOwn(capability.pages, match[1])) continue;
                        const key = listed.key.replace(/\/metadata$/, "");
                        if (protectedKeys.has(key)) continue;
                        if (match[4]) {
                            if (handledBytes.has(key)) continue;
                            const sidecar = await sidecarAt(key, match);
                            if (!sidecar || sidecar.etag !== listed.etag) conflict();
                            if (!oldEnough(sidecar.data.uploadedAt, timestamp.getTime())) continue;
                            if (await blobAt(key, match)) continue;
                            await ensureActive();
                            const latest = await sidecarAt(key, match);
                            if (!latest || latest.etag !== sidecar.etag ||
                                await blobAt(key, match)) conflict();
                            await ensureActive();
                            result.deletionAttempts += 1;
                            try {
                                await store.delete(`${key}/metadata`);
                                result.deleted.push(`${key}/metadata`);
                            } catch (error) {
                                result.failed.push({ key: `${key}/metadata`, phase: "metadata", error });
                            }
                            continue;
                        }
                        handledBytes.add(key);
                        const blob = await blobAt(key, match);
                        if (!blob || blob.etag !== listed.etag) conflict();
                        if (!oldEnough(blob.metadata.uploadedAt, timestamp.getTime())) continue;
                        const sidecar = await sidecarAt(key, match);
                        if (sidecar && !oldEnough(sidecar.data.uploadedAt,
                            timestamp.getTime())) continue;
                        await ensureActive();
                        const currentBlob = await blobAt(key, match);
                        const currentSidecar = await sidecarAt(key, match);
                        if (!currentBlob || currentBlob.etag !== blob.etag ||
                            currentSidecar?.etag !== sidecar?.etag) conflict();
                        if (sidecar) {
                            await ensureActive();
                            const latestSidecar = await sidecarAt(key, match);
                            if (!latestSidecar || latestSidecar.etag !== sidecar.etag) conflict();
                            await ensureActive();
                            result.deletionAttempts += 1;
                            try { await store.delete(`${key}/metadata`); }
                            catch (error) {
                                result.failed.push({ key, phase: "metadata", error });
                                continue;
                            }
                        }
                        await ensureActive();
                        const finalBlob = await blobAt(key, match);
                        if (!finalBlob || finalBlob.etag !== blob.etag) conflict();
                        if (result.deletionAttempts >= maxDeletions) {
                            result.failed.push({ key, phase: "bytes", reason: "limit",
                                metadataDeleted: Boolean(sidecar) });
                            break scan;
                        }
                        await ensureActive();
                        result.deletionAttempts += 1;
                        try { await store.delete(key); }
                        catch (error) {
                            result.failed.push({ key, phase: "bytes", error,
                                metadataDeleted: Boolean(sidecar) });
                            continue;
                        }
                        result.deleted.push(key);
                    }
                }
                return result;
            }, { kind: "legal-cleanup" });
        } catch (error) {
            if (error?.code === "CMS_STATE_LOCKED" && !entered) {
                return { skipped: true, reason: "busy" };
            }
            throw error;
        }
    }

    return Object.freeze({ inventory, sweep });
}
