import { CmsApiError } from "../http.js";

const REQUIRED_PUBLICATION_ENVIRONMENT = Object.freeze([
    "GITHUB_REPOSITORY_TOKEN",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_REPOSITORY_NAME",
    "GITHUB_REPOSITORY_BRANCH",
    "NETLIFY_API_TOKEN",
    "NETLIFY_PUBLIC_SITE_ID",
]);

// The host passes its server environment explicitly; no secrets are read here.
export function readCmsPublicationConfig(environment) {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
        throw new TypeError("An explicit CMS publication environment is required.");
    }
    const missing = REQUIRED_PUBLICATION_ENVIRONMENT.filter((key) =>
        typeof environment[key] !== "string" || environment[key].trim() === "");
    if (missing.length) {
        throw new CmsApiError(
            "PUBLICATION_NOT_CONFIGURED",
            "CMS publication is not configured on this editor deployment.",
            503,
            { missing },
        );
    }
    return Object.freeze({
        githubToken: environment.GITHUB_REPOSITORY_TOKEN.trim(),
        githubOwner: environment.GITHUB_REPOSITORY_OWNER.trim(),
        githubRepository: environment.GITHUB_REPOSITORY_NAME.trim(),
        githubBranch: environment.GITHUB_REPOSITORY_BRANCH.trim(),
        netlifyToken: environment.NETLIFY_API_TOKEN.trim(),
        netlifyPublicSiteId: environment.NETLIFY_PUBLIC_SITE_ID.trim(),
    });
}
