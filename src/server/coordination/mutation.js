import { CmsApiError } from "../http.js";

function defaultSchedule(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

function leaseLost() {
    return new CmsApiError("CMS_STATE_LOCKED",
        "The CMS change lock was lost. Reload and try again.", 423);
}

// Operations must await ensureActive() before each protected mutation. Timer
// renewal keeps idle work alive but cannot guard an uncooperative callback.
export async function withCmsMutationLease(leases, operation, {
    kind = "mutation",
    ttlMs = 60_000,
    renewEveryMs = Math.floor(ttlMs / 3),
    schedule = defaultSchedule,
} = {}) {
    if (!leases || typeof leases.acquire !== "function" ||
        typeof leases.renew !== "function" || typeof leases.release !== "function" ||
        typeof operation !== "function" || typeof schedule !== "function" ||
        typeof kind !== "string" || !kind.trim() ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 30 ||
        !Number.isSafeInteger(renewEveryMs) || renewEveryMs < 1 ||
        renewEveryMs >= ttlMs) {
        throw new TypeError("Invalid CMS mutation lease configuration.");
    }

    let lease = await leases.acquire({ kind, ttlMs });
    let lost = false;
    let failure;
    let pending = Promise.resolve();
    let closed = false;
    let cancel;

    function ensureActive() {
        if (closed) return Promise.reject(leaseLost());
        const attempt = pending.then(async () => {
            if (lost) throw failure;
            try {
                lease = await leases.renew(lease, { ttlMs });
            } catch (error) {
                lost = true;
                failure = error;
                throw error;
            }
        });
        pending = attempt.catch(() => {});
        return attempt;
    }

    let value;
    let operationFailed = false;
    let operationError;
    let cancelFailed = false;
    let cancelError;
    try {
        cancel = schedule(() => { void ensureActive().catch(() => {}); }, renewEveryMs);
        if (typeof cancel !== "function") {
            throw new TypeError("Invalid CMS lease scheduler.");
        }
        value = await operation(ensureActive);
    } catch (error) {
        operationFailed = true;
        operationError = error;
    }

    closed = true;
    try { cancel?.(); } catch (error) { cancelFailed = true; cancelError = error; }
    await pending;
    if (!lost && !operationFailed && !cancelFailed) {
        try {
            lease = await leases.renew(lease, { ttlMs });
        } catch (error) {
            lost = true;
            failure = error;
        }
    }
    if (!lost) {
        try {
            if (!await leases.release(lease)) {
                lost = true;
                failure = leaseLost();
            }
        } catch (error) {
            lost = true;
            failure = error;
        }
    }
    if (lost) throw failure;
    if (operationFailed) throw operationError;
    if (cancelFailed) throw cancelError;
    return value;
}
