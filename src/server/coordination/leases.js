import { randomUUID } from "node:crypto";

import { CmsApiError } from "../http.js";

function validDate(value) {
    return value instanceof Date && Number.isFinite(value.getTime());
}

function validOwner(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function validStoredTime(value) {
    if (typeof value !== "string") return false;
    const date = new Date(value);
    return validDate(date) && date.toISOString() === value;
}

function locked(message) {
    throw new CmsApiError("CMS_STATE_LOCKED", message, 423);
}

// A caller must renew before protected mutations in a long operation.
export function createCmsLeaseManager({
    records,
    recordName = "coordination",
    now = () => new Date(),
    createOwner = randomUUID,
} = {}) {
    if (!records || typeof records.read !== "function" ||
        typeof records.writeIfVersion !== "function" ||
        typeof recordName !== "string" || !recordName.trim() ||
        typeof now !== "function" || typeof createOwner !== "function") {
        throw new TypeError("Invalid CMS lease configuration.");
    }

    return Object.freeze({
        async acquire({ kind, owner = createOwner(), ttlMs = 60_000 } = {}) {
            if (typeof kind !== "string" || !kind.trim() || !validOwner(owner) ||
                !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
                throw new TypeError("Invalid CMS lease request.");
            }
            const current = await records.read(recordName);
            const nowValue = now();
            if (!validDate(nowValue) || !Number.isFinite(nowValue.getTime() + ttlMs) ||
                !validDate(new Date(nowValue.getTime() + ttlMs))) {
                throw new TypeError("Invalid CMS lease time.");
            }
            if (current) {
                const prior = current.data;
                if (!prior || typeof prior !== "object" || Array.isArray(prior) ||
                    (prior.owner !== null && !validOwner(prior.owner)) ||
                    !validStoredTime(prior.expiresAt) ||
                    (prior.owner === null &&
                        (prior.kind !== null || !validStoredTime(prior.releasedAt))) ||
                    (prior.owner !== null &&
                        (typeof prior.kind !== "string" || !prior.kind.trim() ||
                            !validStoredTime(prior.acquiredAt)))) {
                    throw new TypeError("Invalid prior CMS lease record.");
                }
                if (prior.owner && Date.parse(prior.expiresAt) > nowValue.getTime()) {
                    locked(prior.kind === "publication"
                        ? "Publication is in progress. Draft and image changes are temporarily locked."
                        : "Another CMS change is in progress. Try again shortly.");
                }
            }
            const data = {
                owner,
                kind,
                acquiredAt: nowValue.toISOString(),
                expiresAt: new Date(nowValue.getTime() + ttlMs).toISOString(),
            };
            const result = await records.writeIfVersion(recordName, data,
                current ? current.etag : null);
            if (!result?.modified) locked("Another CMS operation started first. Try again.");
            if (typeof result.etag !== "string" || !result.etag) {
                throw new TypeError("Invalid CMS lease write result.");
            }
            return { ...data, etag: result.etag };
        },
        async release(lease) {
            if (!lease || typeof lease.etag !== "string" || !lease.etag) {
                throw new TypeError("Invalid CMS lease release.");
            }
            const nowValue = now();
            if (!validDate(nowValue)) throw new TypeError("Invalid CMS lease time.");
            const result = await records.writeIfVersion(recordName, {
                owner: null,
                kind: null,
                releasedAt: nowValue.toISOString(),
                expiresAt: nowValue.toISOString(),
            }, lease.etag);
            if (!result || typeof result.modified !== "boolean") {
                throw new TypeError("Invalid CMS lease write result.");
            }
            return result.modified;
        },
        async renew(lease, { ttlMs = 60_000 } = {}) {
            if (!lease || !validOwner(lease.owner) ||
                typeof lease.kind !== "string" || !lease.kind.trim() ||
                !validStoredTime(lease.acquiredAt) || !validStoredTime(lease.expiresAt) ||
                typeof lease.etag !== "string" || !lease.etag ||
                !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
                throw new TypeError("Invalid CMS lease renewal.");
            }
            const current = await records.read(recordName);
            if (!current || current.etag !== lease.etag ||
                current.data?.owner !== lease.owner || current.data?.kind !== lease.kind ||
                current.data?.acquiredAt !== lease.acquiredAt ||
                current.data?.expiresAt !== lease.expiresAt) {
                locked("Another CMS change took the lock. Reload and try again.");
            }
            const nowValue = now();
            if (!validDate(nowValue)) throw new TypeError("Invalid CMS lease time.");
            if (nowValue.getTime() >= Date.parse(lease.expiresAt)) {
                locked("The CMS change lock expired. Reload and try again.");
            }
            const expiry = new Date(nowValue.getTime() + ttlMs);
            if (!validDate(expiry)) throw new TypeError("Invalid CMS lease time.");
            const updated = {
                owner: lease.owner,
                kind: lease.kind,
                acquiredAt: lease.acquiredAt,
                expiresAt: expiry.toISOString(),
            };
            const result = await records.writeIfVersion(recordName, updated, lease.etag);
            if (!result?.modified) {
                locked("Another CMS change took the lock. Reload and try again.");
            }
            if (typeof result.etag !== "string" || !result.etag) {
                throw new TypeError("Invalid CMS lease write result.");
            }
            return { ...updated, etag: result.etag };
        },
    });
}
