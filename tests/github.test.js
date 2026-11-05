import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createGitHubPublicationClient } from "../src/server/index.js";
import { createAssetIdentityPolicy } from "../src/server/assets/identity-policy.js";

const config = { githubOwner: "example-owner", githubRepository: "example-site",
    githubBranch: "main/release", githubToken: "fake-token" };
const field = { sectionPath: "home.hero", schemaId: "example-hero",
    fieldKey: "image.src", destinationDirectory: "public/images/home",
    publicPathPrefix: "/images/home/" };
const imagePath = "public/images/home/cms-hero.png";
const legalPath = "public/downloads/legal/Example_Privacy.pdf";
const content = { home: { hero: { image: { src: "/images/home/cms-hero.png" } } } };
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobId = "c".repeat(40);

function assets(legal = false) {
    return createAssetIdentityPolicy({ managedImages: [field],
        legalPdfPaths: legal ? [legalPath] : [] });
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status });
}

function client(fetchObject, legal = false) {
    return createGitHubPublicationClient(config, { fetchObject, assetIdentity: assets(legal) });
}

function gitBlobSha(bytes) {
    return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

test("commit transport builds one atomic commit from all supplied files", async () => {
    const calls = [];
    const bodies = [{ object: { sha: "parent" } }, { tree: { sha: "old-tree" } },
        { sha: "blob-content" }, { sha: "blob-image" }, { sha: "new-tree" },
        { sha: "new-commit" }, {}];
    const provider = client(async (url, options = {}) => {
        calls.push({ url, options });
        return json(bodies.shift());
    });
    const files = [{ path: "content/home.yaml", base64: "aG9tZQ==" },
        { path: imagePath, base64: "aW1hZ2U=" }];
    assert.deepEqual(await provider.createCommit({ files,
        message: "[cms-publication:example-7] Example update" }), {
        commitSha: "new-commit", parentSha: "parent", treeSha: "new-tree",
    });
    assert.deepEqual(calls.map(({ url, options }) => [new URL(url).pathname,
        options.method ?? "GET"]), [
        ["/repos/example-owner/example-site/git/ref/heads/main/release", "GET"],
        ["/repos/example-owner/example-site/git/commits/parent", "GET"],
        ["/repos/example-owner/example-site/git/blobs", "POST"],
        ["/repos/example-owner/example-site/git/blobs", "POST"],
        ["/repos/example-owner/example-site/git/trees", "POST"],
        ["/repos/example-owner/example-site/git/commits", "POST"],
        ["/repos/example-owner/example-site/git/refs/heads/main/release", "PATCH"],
    ]);
    assert.deepEqual(JSON.parse(calls[4].options.body), { base_tree: "old-tree", tree: [
        { path: files[0].path, mode: "100644", type: "blob", sha: "blob-content" },
        { path: files[1].path, mode: "100644", type: "blob", sha: "blob-image" },
    ] });
    assert.deepEqual(JSON.parse(calls[6].options.body), { sha: "new-commit", force: false });
    assert.ok(calls.every(({ options }) => options.headers.Authorization === "Bearer fake-token"));
});

test("inline and large historical files verify exact Git blob bytes", async () => {
    const path = "content/home.yaml";
    const small = Buffer.from("heading: Example\n");
    const smallSha = gitBlobSha(small);
    const inline = client(async () => json({ type: "file", path, sha: smallSha,
        size: small.length, content: small.toString("base64"), encoding: "base64" }));
    assert.deepEqual(await inline.readFileAtCommit(path, commitSha), small);

    const large = Buffer.alloc(1_100_000, 0x61);
    const largeSha = gitBlobSha(large);
    const urls = [];
    const provider = client(async (url) => {
        urls.push(new URL(url).pathname);
        return json(url.includes("/contents/")
            ? { type: "file", path, sha: largeSha, size: large.length,
                content: "", encoding: "none" }
            : { sha: largeSha, content: large.toString("base64"), encoding: "base64" });
    });
    assert.deepEqual(await provider.readFileAtCommit(path, commitSha), large);
    assert.deepEqual(urls, [
        `/repos/example-owner/example-site/contents/${path}`,
        `/repos/example-owner/example-site/git/blobs/${largeSha}`,
    ]);
});

test("corrupt historical bytes and non-404 optional errors fail closed", async () => {
    const path = "content/home.yaml";
    const bytes = Buffer.from("valid");
    const sha = gitBlobSha(bytes);
    for (const encoded of ["!bad", Buffer.from("wrong").toString("base64")]) {
        const provider = client(async () => json({ type: "file", path, sha,
            size: bytes.length, content: encoded, encoding: "base64" }));
        await assert.rejects(provider.readFileAtCommit(path, commitSha),
            (error) => error.code === "REVISION_ASSET_UNAVAILABLE" && error.status === 502);
    }
    const missing = client(async () => json({ message: "missing" }, 404));
    assert.equal(await missing.readFileAtCommit(path, commitSha, { allowMissing: true }), null);
    const unavailable = client(async () => json({ message: "unavailable" }, 503));
    await assert.rejects(unavailable.readFileAtCommit(path, commitSha, { allowMissing: true }),
        (error) => error.code === "GITHUB_PUBLICATION_FAILED" &&
            error.details.status === 503);
});

test("publication recovery requires the complete marker", async () => {
    const provider = client(async () => json([
        { sha: "near", commit: { message: "[cms-publication:example-70] Other" } },
        { sha: "match", commit: { message: "[cms-publication:example-7] Example update",
            tree: { sha: "tree" } }, parents: [{ sha: "parent" }] },
    ]));
    assert.deepEqual(await provider.findPublicationCommit("example-7"), {
        commitSha: "match", parentSha: "parent", treeSha: "tree",
    });
    assert.equal(await provider.findPublicationCommit("example-8"), null);
});

test("snapshot-authorized image and configured PDF use complete tree identity", async () => {
    const urls = [];
    const provider = client(async (url) => {
        urls.push(url);
        return json(url.includes("/git/commits/")
            ? { sha: commitSha, tree: { sha: treeSha } }
            : { sha: treeSha, truncated: false, tree: [
                { path: imagePath, type: "blob", mode: "100644", sha: blobId, size: 42 },
                { path: legalPath, type: "blob", mode: "100644", sha: blobId, size: 101 },
            ] });
    }, true);
    assert.deepEqual(await provider.readManagedAssetBlobIdentitiesAtCommit(
        [imagePath, legalPath], commitSha, { content }), new Map([
        [imagePath, { sha: blobId, size: 42 }],
        [legalPath, { sha: blobId, size: 101 }],
    ]));
    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => !url.includes("/contents/")));
});

test("unreferenced static/image and unconfigured legal paths reject before fetch", async () => {
    let requests = 0;
    const provider = client(async () => { requests += 1; throw new Error("unexpected fetch"); });
    for (const path of ["public/images/home/developer-owned.png",
        "public/images/home/cms-unreferenced.png", legalPath]) {
        await assert.rejects(provider.readManagedAssetBlobIdentitiesAtCommit(
            [path], commitSha, { content }),
        (error) => error.code === "MANAGED_ASSET_IDENTITY_UNAVAILABLE" && error.status === 502);
    }
    await assert.rejects(provider.readManagedAssetBlobIdentitiesAtCommit(
        [imagePath], commitSha),
    (error) => error.code === "MANAGED_ASSET_IDENTITY_UNAVAILABLE");
    assert.equal(requests, 0);
});

test("truncated, duplicate, malformed or mismatched Git trees fail identity proof", async () => {
    const entry = { path: imagePath, type: "blob", mode: "100644", sha: blobId, size: 42 };
    for (const tree of [
        { sha: treeSha, truncated: true, tree: [entry] },
        { sha: treeSha, truncated: false, tree: [] },
        { sha: treeSha, truncated: false, tree: [entry, entry] },
        { sha: treeSha, truncated: false, tree: [{ ...entry, mode: "120000" }] },
        { sha: treeSha, truncated: false, tree: [{ ...entry, size: undefined }] },
        { sha: "d".repeat(40), truncated: false, tree: [entry] },
    ]) {
        const provider = client(async (url) => json(url.includes("/git/commits/")
            ? { sha: commitSha, tree: { sha: treeSha } } : tree));
        await assert.rejects(provider.readManagedAssetBlobIdentitiesAtCommit(
            [imagePath], commitSha, { content }),
        (error) => error.code === "MANAGED_ASSET_IDENTITY_UNAVAILABLE");
    }
});

test("provider failures mask tokens and invalid factories fail before requests", async () => {
    const provider = client(async () => json({ message: "fake-token" }, 403));
    await assert.rejects(provider.createCommit({ files: [], message: "Example" }), (error) => {
        assert.equal(error.code, "GITHUB_PUBLICATION_FAILED");
        assert.equal(error.status, 502);
        assert.deepEqual(error.details, { status: 403 });
        assert.equal(JSON.stringify(error).includes("fake-token"), false);
        return true;
    });
    assert.throws(() => createGitHubPublicationClient(config), TypeError);
    assert.throws(() => createGitHubPublicationClient({ ...config, githubToken: "" }, {
        fetchObject: async () => json({}), assetIdentity: assets(),
    }), TypeError);
});

test("constructed provider retains validated config and policy after caller mutation", async () => {
    const mutableConfig = { ...config };
    const mutableIdentity = {
        repositoryPathsForContent: assets().repositoryPathsForContent,
        requireAllowedRepositoryPaths: assets().requireAllowedRepositoryPaths,
    };
    const calls = [];
    const provider = createGitHubPublicationClient(mutableConfig, {
        assetIdentity: mutableIdentity,
        async fetchObject(url, options = {}) {
            calls.push({ url, options });
            return json(url.includes("/commits?") ? [] : { message: "denied" },
                url.includes("/commits?") ? 200 : 403);
        },
    });
    let requests = 0;
    const identityProvider = createGitHubPublicationClient(config, {
        assetIdentity: mutableIdentity,
        async fetchObject() { requests += 1; throw new Error("unexpected fetch"); },
    });
    mutableConfig.githubOwner = "changed-owner";
    mutableConfig.githubRepository = "changed-repository";
    mutableConfig.githubBranch = "changed-branch";
    mutableConfig.githubToken = "changed-token";
    mutableIdentity.repositoryPathsForContent = () => new Set(["unsafe"]);
    mutableIdentity.requireAllowedRepositoryPaths = () => [];
    await assert.rejects(provider.createCommit({ files: [], message: "Example" }),
        (error) => error.code === "GITHUB_PUBLICATION_FAILED");
    assert.equal(await provider.findPublicationCommit("missing"), null);
    assert.ok(calls.every(({ url, options }) =>
        url.includes("/repos/example-owner/example-site/") &&
        options.headers.Authorization === "Bearer fake-token"));
    assert.ok(calls[1].url.includes("sha=main%2Frelease"));
    await assert.rejects(identityProvider.readManagedAssetBlobIdentitiesAtCommit(
        ["public/images/home/developer-owned.png"], commitSha, { content }),
    (error) => error.code === "MANAGED_ASSET_IDENTITY_UNAVAILABLE");
    assert.equal(requests, 0);
});
