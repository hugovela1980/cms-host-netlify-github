import assert from "node:assert/strict";
import test from "node:test";

import { readCmsPublicationConfig } from "../src/server/index.js";

const environment = {
    GITHUB_REPOSITORY_TOKEN: " fake-github-token ",
    GITHUB_REPOSITORY_OWNER: " example-owner ",
    GITHUB_REPOSITORY_NAME: " example-site ",
    GITHUB_REPOSITORY_BRANCH: " main ",
    NETLIFY_API_TOKEN: " fake-netlify-token ",
    NETLIFY_PUBLIC_SITE_ID: " example-public ",
};

test("explicit environment maps to a frozen provider configuration", () => {
    const config = readCmsPublicationConfig(environment);
    assert.deepEqual(config, {
        githubToken: "fake-github-token", githubOwner: "example-owner",
        githubRepository: "example-site", githubBranch: "main",
        netlifyToken: "fake-netlify-token", netlifyPublicSiteId: "example-public",
    });
    assert.equal(Object.isFrozen(config), true);
    assert.equal(environment.GITHUB_REPOSITORY_TOKEN, " fake-github-token ");
});

test("missing settings retain the established error without revealing secrets", () => {
    assert.throws(() => readCmsPublicationConfig({
        ...environment, GITHUB_REPOSITORY_TOKEN: " ", NETLIFY_PUBLIC_SITE_ID: null,
    }), (error) => {
        assert.equal(error.code, "PUBLICATION_NOT_CONFIGURED");
        assert.equal(error.status, 503);
        assert.equal(error.message, "CMS publication is not configured on this editor deployment.");
        assert.deepEqual(error.details, { missing: [
            "GITHUB_REPOSITORY_TOKEN", "NETLIFY_PUBLIC_SITE_ID",
        ] });
        assert.equal(JSON.stringify(error).includes("fake-netlify-token"), false);
        return true;
    });
    assert.throws(() => readCmsPublicationConfig(), TypeError);
});
