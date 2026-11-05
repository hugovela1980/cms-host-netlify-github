import assert from "node:assert/strict";
import test from "node:test";

import { config, ROUTES, createNeutralCmsFunction } from
    "../examples/neutral-site/netlify-cms-function.mjs";

test("neutral Netlify route map covers client and optional preview suffixes", () => {
    assert.deepEqual(config, { path: "/neutral/cms/*" });
    assert.deepEqual(ROUTES, {
        draft: "draft", "save-draft": "saveDraft",
        "revert-draft": "revertDraft", "upload-image": "uploadImage",
        "draft-image": "draftImage", publish: "publish",
        publication: "publication", revisions: "revisions",
        revision: "revision", "restore-revision": "restoreRevision",
        "upload-legal": "uploadLegal", "legal-reference": "legalReference",
        "save-legal-draft": "saveLegalDraft", "confirm-legal": "confirmLegal",
        "legal-preview": "legalPreview",
    });
    assert.throws(() => createNeutralCmsFunction({}, null, () => ({})), TypeError);
    assert.throws(() => createNeutralCmsFunction({}, () => null, null), TypeError);
});

test("dispatcher maps every suffix and keeps optional routes absent", async () => {
    const siteConfig = {};
    const authenticate = async () => ({ id: "editor", email: "editor@example.test" });
    const calls = [];
    const createHandlers = (configArg, authArg) => {
        assert.equal(configArg, siteConfig);
        assert.equal(authArg, authenticate);
        return Object.fromEntries(Object.values(ROUTES)
            .filter((name) => !name.toLowerCase().includes("legal"))
            .map((name) => [name, async ({ request, context }) => {
                calls.push({ name, request, context });
                return new Response(name);
            }]));
    };
    const dispatch = createNeutralCmsFunction(siteConfig, authenticate, createHandlers);
    const context = {};
    for (const [suffix, handler] of Object.entries(ROUTES)) {
        const request = new Request(`https://neutral.example.test/neutral/cms/${suffix}?probe=1`);
        const response = await dispatch(request, context);
        if (handler.toLowerCase().includes("legal")) {
            assert.equal(response.status, 404, suffix);
        } else {
            assert.equal(await response.text(), handler, suffix);
            assert.deepEqual(calls.at(-1), { name: handler, request, context });
        }
    }
    for (const path of ["/neutral/cms/unknown", "/neutral/cms/draft/extra",
        "/api/cms/draft"]) {
        assert.equal((await dispatch(new Request(`https://neutral.example.test${path}`),
            context)).status, 404);
    }
});
