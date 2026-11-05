import { CmsApiError } from "../http.js";
import { createHash } from "node:crypto";

function encodePath(value) {
    return String(value).split("/").map(encodeURIComponent).join("/");
}

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/i;

function invalidHistoricalFile() {
    throw new CmsApiError("REVISION_ASSET_UNAVAILABLE", "A historical CMS image could not be restored.", 502);
}

function decodeHistoricalBlob(file, expectedSha, expectedSize) {
    if (!GIT_OBJECT_ID.test(file?.sha) || file.sha.toLowerCase() !== expectedSha.toLowerCase() ||
        file.encoding !== "base64" || typeof file.content !== "string") invalidHistoricalFile();
    const encoded = file.content.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalidHistoricalFile();
    const bytes = Buffer.from(encoded, "base64");
    const objectId = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== expectedSize || objectId !== expectedSha.toLowerCase()) {
        invalidHistoricalFile();
    }
    return bytes;
}

function assetIdentityUnavailable() {
    throw new CmsApiError(
        "MANAGED_ASSET_IDENTITY_UNAVAILABLE",
        "Referenced managed-image identity could not be verified at the PUBLIC commit.",
        502,
    );
}

export function createGitHubPublicationClient(config, { fetchObject = fetch, assetIdentity } = {}) {
    if (!config || ["githubOwner", "githubRepository", "githubBranch", "githubToken"]
        .some((name) => typeof config[name] !== "string" || !config[name].trim()) ||
        typeof fetchObject !== "function" || !assetIdentity ||
        typeof assetIdentity.repositoryPathsForContent !== "function" ||
        typeof assetIdentity.requireAllowedRepositoryPaths !== "function") {
        throw new TypeError("Invalid CMS GitHub provider configuration.");
    }
    const stableConfig = Object.freeze({
        githubOwner: config.githubOwner,
        githubRepository: config.githubRepository,
        githubBranch: config.githubBranch,
        githubToken: config.githubToken,
    });
    const stableAssetIdentity = Object.freeze({
        repositoryPathsForContent: assetIdentity.repositoryPathsForContent,
        requireAllowedRepositoryPaths: assetIdentity.requireAllowedRepositoryPaths,
    });
    const repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(stableConfig.githubOwner)}/${encodeURIComponent(stableConfig.githubRepository)}`;
    async function request(path, options = {}) {
        const response = await fetchObject(`${repositoryUrl}${path}`, {
            ...options,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${stableConfig.githubToken}`,
                "X-GitHub-Api-Version": "2026-03-10",
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...options.headers,
            },
        });
        let body = null;
        try { body = await response.json(); } catch { /* handled below */ }
        if (!response.ok) {
            throw new CmsApiError("GITHUB_PUBLICATION_FAILED", "GitHub rejected the CMS publication.", 502, {
                status: response.status,
            });
        }
        return body;
    }

    return {
        async createCommit({ files, message }) {
            const branch = encodePath(stableConfig.githubBranch);
            const reference = await request(`/git/ref/heads/${branch}`);
            const parentSha = reference.object.sha;
            const parentCommit = await request(`/git/commits/${parentSha}`);
            const treeEntries = [];
            for (const file of files) {
                const blob = await request("/git/blobs", {
                    method: "POST",
                    body: JSON.stringify({ content: file.base64, encoding: "base64" }),
                });
                treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
            }
            const tree = await request("/git/trees", {
                method: "POST",
                body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeEntries }),
            });
            const commit = await request("/git/commits", {
                method: "POST",
                body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
            });
            await request(`/git/refs/heads/${branch}`, {
                method: "PATCH",
                body: JSON.stringify({ sha: commit.sha, force: false }),
            });
            return { commitSha: commit.sha, parentSha, treeSha: tree.sha };
        },
        async readFileAtCommit(path, commitSha, { allowMissing = false } = {}) {
            let file;
            try {
                file = await request(`/contents/${encodePath(path)}?ref=${encodeURIComponent(commitSha)}`);
            } catch (error) {
                if (allowMissing && error?.code === "GITHUB_PUBLICATION_FAILED" && error.details?.status === 404) {
                    return null;
                }
                throw error;
            }
            if (file?.type !== "file" || file.path !== path ||
                !GIT_OBJECT_ID.test(file.sha) ||
                !Number.isSafeInteger(file.size) || file.size < 0) invalidHistoricalFile();
            if (file.encoding === "base64") {
                return decodeHistoricalBlob(file, file.sha, file.size);
            }
            if (file.encoding !== "none" || file.content !== "") invalidHistoricalFile();
            const blob = await request(`/git/blobs/${encodeURIComponent(file.sha)}`);
            return decodeHistoricalBlob(blob, file.sha, file.size);
        },
        async readManagedAssetBlobIdentitiesAtCommit(paths, commitSha, { content } = {}) {
            if (!GIT_OBJECT_ID.test(commitSha) || !content ||
                typeof content !== "object" || Array.isArray(content)) {
                assetIdentityUnavailable();
            }
            try {
                const allowedPaths = stableAssetIdentity.repositoryPathsForContent(content);
                stableAssetIdentity.requireAllowedRepositoryPaths(paths, allowedPaths);
            } catch {
                assetIdentityUnavailable();
            }
            const commit = await request(`/git/commits/${encodeURIComponent(commitSha)}`);
            if (commit?.sha?.toLowerCase() !== commitSha.toLowerCase() ||
                !GIT_OBJECT_ID.test(commit?.tree?.sha)) {
                assetIdentityUnavailable();
            }
            const tree = await request(`/git/trees/${commit.tree.sha}?recursive=1`);
            if (tree?.sha?.toLowerCase() !== commit.tree.sha.toLowerCase() ||
                tree.truncated !== false || !Array.isArray(tree.tree)) {
                assetIdentityUnavailable();
            }
            const identities = new Map();
            for (const path of paths) {
                const entries = tree.tree.filter((entry) => entry?.path === path);
                if (entries.length !== 1 || entries[0].type !== "blob" ||
                    entries[0].mode !== "100644" || !GIT_OBJECT_ID.test(entries[0].sha) ||
                    !Number.isSafeInteger(entries[0].size) || entries[0].size < 0) {
                    assetIdentityUnavailable();
                }
                identities.set(path, {
                    sha: entries[0].sha.toLowerCase(),
                    size: entries[0].size,
                });
            }
            return identities;
        },
        async findPublicationCommit(publicationId) {
            const commits = await request(`/commits?sha=${encodeURIComponent(stableConfig.githubBranch)}&per_page=100`);
            const marker = `[cms-publication:${publicationId}]`;
            const match = Array.isArray(commits)
                ? commits.find((commit) => String(commit?.commit?.message ?? "").includes(marker))
                : null;
            if (!match) return null;
            return {
                commitSha: match.sha,
                parentSha: match.parents?.[0]?.sha ?? null,
                treeSha: match.commit?.tree?.sha ?? null,
            };
        },
    };
}
