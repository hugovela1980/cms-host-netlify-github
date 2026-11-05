import assert from "node:assert/strict";
import test from "node:test";

import { CmsClientError, createCmsApiClient,
    pollPublicationConfirmation } from "../src/client/index.js";

test("default no-legal client exposes only common CMS methods", async () => {
    const requests = [];
    const client = createCmsApiClient({ fetchObject: async (path, options) => {
        requests.push({ path, options });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } });
    for (const name of ["uploadLegal", "resolveLegal", "saveLegalDraft",
        "confirmLegal"]) assert.equal(Object.hasOwn(client, name), false);
    assert.deepEqual(await client.loadDraft(), { ok: true });
    assert.equal(requests[0].path, "/api/cms/draft");
    assert.deepEqual(requests[0].options, { method: "GET",
        credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json" } });
});

test("custom root-relative base path prefixes every common and legal route", async () => {
    const paths = [];
    const client = createCmsApiClient({ basePath: "/editor/cms",
        legalEnabled: true, fetchObject: async (path) => {
            paths.push(path);
            return new Response("{}", { status: 200 });
        } });
    await client.loadDraft();
    await client.saveDraft({ expectedDraftVersion: "one" });
    await client.resolveLegal({ page: "privacy", kind: "pdf", hash: "a+b" });
    await client.listRevisions({ page: 2, head: "first", highlightedRevision: "a b" });
    await client.viewRevision("a/b?");
    assert.deepEqual(paths, ["/editor/cms/draft", "/editor/cms/save-draft",
        "/editor/cms/legal-reference?page=privacy&kind=pdf&hash=a%2Bb",
        "/editor/cms/revisions?page=2&head=first&highlightedRevision=a+b",
        "/editor/cms/revision?id=a%2Fb%3F"]);
    for (const basePath of ["/", "/.netlify/functions"]) {
        const client = createCmsApiClient({ basePath,
            fetchObject: async (path) => {
                assert.equal(path, basePath === "/" ? "/draft" :
                    "/.netlify/functions/draft");
                return new Response("{}");
            } });
        await client.loadDraft();
    }
});

test("base path and transport configuration reject unsafe values", () => {
    for (const basePath of ["", "api/cms", "//other/cms", "/api/cms/",
        "/api//cms",
        "/api/../cms", "/api/cms?x=1", "https://other.test/cms"]) {
        assert.throws(() => createCmsApiClient({ basePath }), TypeError);
    }
    assert.throws(() => createCmsApiClient({ fetchObject: null }), TypeError);
    assert.throws(() => createCmsApiClient({ legalEnabled: "yes" }), TypeError);
});

test("JSON and image upload errors preserve distinct client shapes", async () => {
    const badJson = createCmsApiClient({ fetchObject: async () =>
        new Response("not json", { status: 502 }) });
    await assert.rejects(badJson.loadDraft(), (error) =>
        error instanceof CmsClientError && error.code === "INVALID_RESPONSE" &&
        error.status === 502);
    await assert.rejects(badJson.uploadImage({ sectionPath: "home.hero",
        schemaId: "hero", fieldKey: "image.src",
        file: new File(["image"], "image.png") }), (error) =>
        error.code === "INVALID_RESPONSE" && error.message ===
        "The image service returned an unreadable response.");
    const legal = createCmsApiClient({ legalEnabled: true,
        fetchObject: async () => new Response("not json", { status: 502 }) });
    await assert.rejects(legal.uploadLegal({ page: "privacy", kind: "pdf",
        file: new File(["pdf"], "policy.pdf") }), SyntaxError);
});

test("poller confirms only explicit success and reports the established errors", async () => {
    const events = [];
    const statuses = ["committing", "deploying", "confirmed"];
    const result = await pollPublicationConfirmation({
        api: { async publicationStatus() {
            return { publication: { status: statuses.shift() } };
        } }, wait: async (ms) => { events.push(["wait", ms]); }, maxPolls: 3,
        onStatus: (status) => events.push(["status", status]),
        onActiveChange: (active) => events.push(["active", active]),
    });
    assert.equal(result.status, "confirmed");
    assert.deepEqual(events, [["status", "committing"], ["active", true],
        ["wait", 3000], ["status", "deploying"], ["active", true],
        ["wait", 3000], ["status", "confirmed"], ["active", false]]);
    await assert.rejects(pollPublicationConfirmation({
        api: { async publicationStatus() { return { publication: {
            status: "uncertain" } }; } }, wait: async () => {}, maxPolls: 1,
    }), { code: "UNEXPECTED_PUBLICATION_STATUS" });
});
