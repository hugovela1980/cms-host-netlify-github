import { isDeepStrictEqual } from "node:util";
import { CmsApiError } from "../http.js";
import { withCmsMutationLease } from "../coordination/mutation.js";
import { isCmsHostPolicyBundle } from "../host-policies.js";
import { isCmsPublicLegalVerifier } from "../legal/public-commit.js";
import { isCmsPublicationUnresolved } from "../publication/status.js";

const COMMIT = /^[0-9a-f]{40}$/i;

function identity(record) {
    return record?.data?.commit ?? record?.data?.revisionId ?? null;
}

function issue(code, message) { return { code, message }; }

function changed() {
    return new CmsApiError("BASELINE_CHECKPOINT_CHANGED",
        "The verified PUBLIC checkpoint changed after preflight.", 409);
}

// Operator Git checks and explicit confirmation belong to the host. No HTTP
// handler or automatic foundation/publication path invokes promote().
export function createCmsDeveloperBaselineService({ records, netlify, reader,
    canonicalContent, bundle, missingRequiredContent, legalVerifier, leases,
    now = () => new Date() } = {}) {
    if (typeof records?.read !== "function" ||
        typeof records?.writeIfVersion !== "function" ||
        typeof netlify?.findLatestReadyProductionDeploy !== "function" ||
        typeof reader?.readAtCommit !== "function" ||
        typeof canonicalContent !== "function" ||
        !isCmsHostPolicyBundle(bundle) ||
        typeof missingRequiredContent !== "function" ||
        typeof bundle.assets?.contentImagePaths !== "function" ||
        typeof leases?.acquire !== "function" ||
        typeof leases?.renew !== "function" ||
        typeof leases?.release !== "function" || typeof now !== "function" ||
        (bundle.legalAssetsEnabled &&
            (!isCmsPublicLegalVerifier(legalVerifier) ||
                legalVerifier.capability.assetBundle !== bundle)) ||
        (!bundle.legalAssetsEnabled && legalVerifier !== undefined)) {
        throw new TypeError("Invalid CMS Developer-baseline configuration.");
    }

    async function read() {
        const baseline = await records.read("baseline");
        if (!baseline) {
            throw new CmsApiError("CMS_FOUNDATION_NOT_INITIALIZED",
                "The immutable Developer baseline has not been captured.", 503);
        }
        return baseline;
    }

    async function inspect() {
        const [live, baseline, publication, draft, revisions, deploy] = await Promise.all([
            records.read("confirmedLive"), records.read("baseline"),
            records.read("publication"), records.read("draft"),
            records.read("revisions"),
            netlify.findLatestReadyProductionDeploy(),
        ]);
        const liveCommit = identity(live);
        const baselineCommit = baseline?.data?.sourceCommit ?? identity(baseline);
        const deployCommit = deploy?.commit_ref ?? null;
        const issues = [];
        const status = publication?.data?.status ?? null;
        if (publication && (isCmsPublicationUnresolved(publication.data) ||
            !["confirmed", "failed"].includes(status))) {
            issues.push(issue("PUBLICATION_UNRESOLVED",
                `CMS publication state is unresolved (${status ?? "unknown"}).`));
        }
        if (!live) issues.push(issue("CONFIRMED_LIVE_MISSING",
            "Confirmed-live CMS state has not been initialized."));
        if (!baseline) issues.push(issue("DEVELOPER_BASELINE_MISSING",
            "Developer baseline state has not been initialized."));
        if (!deploy || !COMMIT.test(deployCommit ?? "") ||
            typeof deploy.id !== "string" || !deploy.id ||
            typeof deploy.published_at !== "string" || !deploy.published_at ||
            deploy.state !== "ready") {
            issues.push(issue("READY_DEPLOY_INVALID",
                "The authoritative READY PUBLIC deployment is invalid."));
        }
        if (live && deployCommit && liveCommit !== deployCommit) {
            issues.push(issue("CONFIRMED_LIVE_STALE",
                "Confirmed-live CMS state does not match the latest READY PUBLIC deployment."));
        }
        if (live && live.data?.commit !== undefined &&
            live.data.commit !== live.data.revisionId) {
            issues.push(issue("CONFIRMED_LIVE_STALE",
                "Confirmed-live commit and revision identities disagree."));
        }
        if (live && deploy &&
            (live.data?.deployId !== deploy.id ||
                live.data?.confirmedAt !== deploy.published_at)) {
            issues.push(issue("CONFIRMED_LIVE_DEPLOY_MISMATCH",
                "Confirmed-live CMS state does not match the exact READY deployment."));
        }
        if (draft && (draft.data?.baseRevision ?? null) !== liveCommit) {
            issues.push(issue("DRAFT_BASE_MISMATCH",
                "The saved CMS draft is not based on the confirmed-live commit."));
        }

        let content;
        if (live) {
            content = live.data?.content;
            let missing;
            try {
                missing = missingRequiredContent(content);
                if (!Array.isArray(missing) || missing.some((name) =>
                    typeof name !== "string" || !name.trim())) throw new TypeError();
                bundle.content.validateCurrent(content);
            } catch {
                missing = ["invalid content"];
            }
            if (missing.length) {
                issues.push(issue("CONFIRMED_LIVE_CONTENT_INCOMPLETE",
                    `Confirmed-live CMS state is missing registered content: ${missing.join(", ")}.`));
            } else {
                try {
                    const assets = [...bundle.assets.contentImagePaths(content)];
                    if (!Array.isArray(live.data.assets) ||
                        !isDeepStrictEqual([...live.data.assets].sort(), assets.sort())) {
                        issues.push(issue("CONFIRMED_LIVE_ASSETS_INVALID",
                            "Confirmed-live managed-asset references are inconsistent."));
                    }
                } catch {
                    issues.push(issue("CONFIRMED_LIVE_ASSETS_INVALID",
                        "Confirmed-live managed-asset references are invalid."));
                }
                if (COMMIT.test(deployCommit ?? "")) {
                    try {
                        const ready = await reader.readAtCommit(deployCommit,
                            await canonicalContent());
                        if (ready.kind !== "current" ||
                            !isDeepStrictEqual(ready.rawContent, content)) {
                            issues.push(issue("CONFIRMED_LIVE_CONTENT_MISMATCH",
                                "Confirmed-live content differs from the exact READY commit."));
                        }
                    } catch {
                        issues.push(issue("CONFIRMED_LIVE_CONTENT_MISMATCH",
                            "The exact READY content could not be verified."));
                    }
                }
            }
        }
        if (!bundle.legalAssetsEnabled) {
            if ([live, baseline, draft, publication, revisions]
                .some((record) => record?.data &&
                    (Object.hasOwn(record.data, "legal") ||
                        Object.hasOwn(record.data.draft ?? {}, "legal") ||
                        (Array.isArray(record.data.entries) &&
                            record.data.entries.some((entry) => entry &&
                                Object.hasOwn(entry, "legal")))))) {
                issues.push(issue("LEGAL_CAPABILITY_REQUIRED",
                    "Stored legal state requires a legal capability."));
            }
        } else if (live && COMMIT.test(deployCommit ?? "")) {
            try {
                const verified = await legalVerifier.readAtCommit(deployCommit);
                if (!Object.hasOwn(live.data, "legal") ||
                    !isDeepStrictEqual(live.data.legal, verified)) {
                    issues.push(issue("CONFIRMED_LIVE_LEGAL_INVALID",
                        "Confirmed-live legal state differs from the exact READY commit."));
                }
            } catch {
                issues.push(issue("CONFIRMED_LIVE_LEGAL_INVALID",
                    "The exact READY legal pair could not be verified."));
            }
        }
        return { live, baseline, publication, draft, revisions, deploy, liveCommit,
            deployCommit, baselineCommit,
            baselineStatus: baselineCommit && baselineCommit === deployCommit
                ? "CURRENT" : "OUTDATED", issues };
    }

    async function promote({ expectedLiveCommit, expectedBaselineVersion } = {}) {
        return withCmsMutationLease(leases, async (ensureActive) => {
            const checkpoint = await inspect();
            if (checkpoint.issues.length) {
                throw new CmsApiError("BASELINE_CHECKPOINT_UNSAFE",
                    "Developer baseline promotion is unsafe.", 409,
                    { issues: checkpoint.issues });
            }
            if (!COMMIT.test(expectedLiveCommit ?? "") ||
                checkpoint.deployCommit !== expectedLiveCommit ||
                checkpoint.baseline?.etag !== expectedBaselineVersion) throw changed();
            if (checkpoint.baselineStatus === "CURRENT") {
                throw new CmsApiError("BASELINE_ALREADY_CURRENT",
                    "The Developer baseline is already current.", 409);
            }
            const timestamp = now();
            if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
                throw new TypeError("Invalid CMS Developer-baseline time.");
            }
            const content = structuredClone(checkpoint.live.data.content);
            const data = { content,
                ...(bundle.legalAssetsEnabled ?
                    { legal: structuredClone(checkpoint.live.data.legal) } : {}),
                revisionId: "developer-baseline",
                sourceCommit: checkpoint.deployCommit,
                commit: checkpoint.deployCommit,
                deployId: checkpoint.deploy.id,
                confirmedAt: checkpoint.deploy.published_at,
                capturedAt: timestamp.toISOString(),
                assets: [...bundle.assets.contentImagePaths(content)],
            };
            await ensureActive();
            const [latestLive, latestBaseline, latestPublication, latestDraft,
                latestRevisions,
                latestDeploy] = await Promise.all([
                records.read("confirmedLive"), records.read("baseline"),
                records.read("publication"), records.read("draft"),
                records.read("revisions"),
                netlify.findLatestReadyProductionDeploy(),
            ]);
            if (latestLive?.etag !== checkpoint.live.etag ||
                latestBaseline?.etag !== checkpoint.baseline.etag ||
                latestPublication?.etag !== checkpoint.publication?.etag ||
                latestDraft?.etag !== checkpoint.draft?.etag ||
                latestRevisions?.etag !== checkpoint.revisions?.etag ||
                latestDeploy?.id !== checkpoint.deploy.id ||
                latestDeploy?.commit_ref !== checkpoint.deployCommit ||
                latestDeploy?.published_at !== checkpoint.deploy.published_at ||
                latestDeploy?.state !== "ready") throw changed();
            await ensureActive();
            const result = await records.writeIfVersion("baseline", data,
                checkpoint.baseline.etag);
            if (!result?.modified || typeof result.etag !== "string" || !result.etag) {
                throw changed();
            }
            return { data, etag: result.etag };
        });
    }
    return Object.freeze({ read, inspect, promote });
}
