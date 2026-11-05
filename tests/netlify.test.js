import assert from "node:assert/strict";
import test from "node:test";

import { createNetlifyDeploymentClient } from "../src/server/providers/netlify.js";

import { exampleSite } from "./fixtures/example-site.js";

const config = {
    netlifyPublicSiteId: exampleSite.publicSiteId,
    netlifyToken: "netlify-token",
    githubBranch: exampleSite.branch,
};

function clientFor(deploys) {
    const requests = [];
    return {
        requests,
        client: createNetlifyDeploymentClient(config, {
            async fetchObject(url, options) {
                requests.push({ url, options });
                return new Response(JSON.stringify(deploys), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            },
        }),
    };
}

test("findExactProductionDeploy confirms only the exact ready published production commit", async () => {
    const exact = {
        id: "exact",
        context: "production",
        branch: "main",
        commit_ref: "wanted-sha",
        state: "ready",
        published_at: "2026-09-30T12:00:00.000Z",
    };
    const { client, requests } = clientFor([
        { ...exact, id: "wrong-branch", branch: "preview" },
        { ...exact, id: "wrong-context", context: "deploy-preview" },
        { ...exact, id: "wrong-commit", commit_ref: "other-sha" },
        exact,
    ]);

    assert.deepEqual(await client.findExactProductionDeploy("wanted-sha"), {
        state: "confirmed",
        deploy: exact,
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/sites\/example-public-site\/deploys\?per_page=50$/);
    assert.equal(requests[0].options.headers.Authorization, "Bearer netlify-token");
});

test("findExactProductionDeploy maps exact pending, failed, and missing commits conservatively", async () => {
    for (const state of ["pending", "building", "enqueued", "processing"]) {
        const deploy = {
            id: state,
            context: "production",
            branch: "main",
            commit_ref: "wanted-sha",
            state,
        };
        assert.deepEqual(
            await clientFor([deploy]).client.findExactProductionDeploy("wanted-sha"),
            { state: "pending", deploy },
        );
    }
    for (const state of ["error", "failed", "canceled"]) {
        const deploy = {
            id: state,
            context: "production",
            branch: "main",
            commit_ref: "wanted-sha",
            state,
        };
        assert.deepEqual(
            await clientFor([deploy]).client.findExactProductionDeploy("wanted-sha"),
            { state: "failed", deploy },
        );
    }
    assert.deepEqual(
        await clientFor([{
            context: "production",
            branch: "main",
            commit_ref: "another-sha",
            state: "ready",
            published_at: "2026-09-30T12:00:00.000Z",
        }]).client.findExactProductionDeploy("wanted-sha"),
        { state: "pending", deploy: null },
    );
});

test("findLatestReadyProductionDeploy selects the newest valid deploy for the configured production branch", async () => {
    const latest = {
        id: "latest-valid",
        context: "production",
        branch: "main",
        commit_ref: "latest-sha",
        state: "ready",
        published_at: "2026-09-30T13:00:00.000Z",
    };
    const { client } = clientFor([
        { ...latest, id: "newer-wrong-branch", branch: "feature", published_at: "2026-10-01T13:00:00.000Z" },
        { ...latest, id: "newer-preview", context: "deploy-preview", published_at: "2026-10-01T12:00:00.000Z" },
        { ...latest, id: "newer-building", state: "building", published_at: "2026-10-01T11:00:00.000Z" },
        { ...latest, id: "missing-commit", commit_ref: "", published_at: "2026-10-01T10:00:00.000Z" },
        { ...latest, id: "older-valid", commit_ref: "older-sha", published_at: "2026-09-29T13:00:00.000Z" },
        latest,
    ]);

    assert.deepEqual(await client.findLatestReadyProductionDeploy(), latest);
});

test("Netlify lookup failures and malformed responses preserve provider error semantics", async () => {
    for (const response of [
        new Response("unavailable", { status: 503 }),
        new Response(JSON.stringify({ deploys: [] }), { status: 200 }),
    ]) {
        const client = createNetlifyDeploymentClient(config, { fetchObject: async () => response });
        await assert.rejects(client.findExactProductionDeploy("wanted-sha"), {
            code: "NETLIFY_DEPLOYMENT_LOOKUP_FAILED", status: 502,
        });
    }
    await assert.rejects(clientFor([]).client.findLatestReadyProductionDeploy(), {
        code: "INITIAL_PUBLIC_DEPLOY_NOT_FOUND", status: 503,
    });
});
