import { CmsApiError } from "../http.js";

export function createNetlifyDeploymentClient(config, { fetchObject = fetch } = {}) {
    async function listProductionDeploys() {
        const response = await fetchObject(
            `https://api.netlify.com/api/v1/sites/${encodeURIComponent(config.netlifyPublicSiteId)}/deploys?per_page=50`,
            { headers: { Authorization: `Bearer ${config.netlifyToken}`, Accept: "application/json" } },
        );
        if (!response.ok) {
            throw new CmsApiError("NETLIFY_DEPLOYMENT_LOOKUP_FAILED", "The PUBLIC deployment status could not be checked.", 502);
        }
        const deploys = await response.json();
        if (!Array.isArray(deploys)) {
            throw new CmsApiError("NETLIFY_DEPLOYMENT_LOOKUP_FAILED", "The PUBLIC deployment response was invalid.", 502);
        }
        return deploys.filter((item) =>
            item.context === "production" &&
            item.branch === config.githubBranch);
    }

    return {
        async findExactProductionDeploy(commitSha) {
            const deploys = await listProductionDeploys();
            const deploy = deploys.find((item) =>
                item.commit_ref === commitSha);
            if (!deploy) return { state: "pending", deploy: null };
            if (deploy.state === "ready" && deploy.published_at) {
                return { state: "confirmed", deploy };
            }
            if (["error", "failed", "canceled"].includes(deploy.state)) {
                return { state: "failed", deploy };
            }
            return { state: "pending", deploy };
        },
        async findLatestReadyProductionDeploy() {
            const deploy = (await listProductionDeploys())
                .filter((item) =>
                    item.state === "ready" &&
                    item.published_at &&
                    typeof item.commit_ref === "string" &&
                    item.commit_ref !== "")
                .sort((left, right) =>
                    new Date(right.published_at).getTime() - new Date(left.published_at).getTime())[0];
            if (!deploy) {
                throw new CmsApiError(
                    "INITIAL_PUBLIC_DEPLOY_NOT_FOUND",
                    "No ready PUBLIC production deployment was found for the configured branch.",
                    503,
                );
            }
            return deploy;
        },
    };
}
