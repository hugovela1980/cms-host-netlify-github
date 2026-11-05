import YAML from "yaml";
import { createHash } from "node:crypto";
import { CmsApiError } from "../http.js";

function invalid(message = "Publication files could not be verified.") {
    throw new CmsApiError("PUBLICATION_FILES_INVALID", message, 502);
}

function encoded(path, bytes) {
    if (typeof path !== "string" || !path || !Buffer.isBuffer(bytes)) invalid();
    return { path, base64: bytes.toString("base64") };
}

export function createCmsPublicationFileAssembler({ pages, bundle, images, github,
    legalService } = {}) {
    if (!Array.isArray(pages) || !pages.length ||
        pages.some((page) => typeof page?.contentKey !== "string" ||
            !page.contentKey || typeof page.contentFile !== "string" ||
            !/^content\/[a-z0-9/-]+\.ya?ml$/i.test(page.contentFile)) ||
        new Set(pages.map((page) => page.contentKey)).size !== pages.length ||
        new Set(pages.map((page) => page.contentFile)).size !== pages.length ||
        typeof bundle?.assets?.contentImagePaths !== "function" ||
        typeof images?.readStaged !== "function" ||
        (bundle.legalAssetsEnabled && (!legalService ||
            legalService.capability?.assetBundle !== bundle)) ||
        (!bundle.legalAssetsEnabled && legalService !== undefined)) {
        throw new TypeError("Invalid CMS publication file assembly configuration.");
    }
    const stablePages = pages.map(({ contentKey, contentFile }) =>
        Object.freeze({ contentKey, contentFile }));

    return Object.freeze({
        async build({ content, confirmedLive, legal, ensureActive } = {}) {
            if (!content || typeof content !== "object" || Array.isArray(content) ||
                !confirmedLive || typeof confirmedLive !== "object" ||
                typeof ensureActive !== "function") {
                throw new TypeError("A publication snapshot, live state, and lease are required.");
            }
            const files = [];
            const used = new Set();
            function add(path, bytes) {
                if (used.has(path)) invalid("Publication files contain a duplicate path.");
                used.add(path);
                files.push(encoded(path, bytes));
            }
            for (const page of stablePages) {
                if (!Object.hasOwn(content, page.contentKey)) invalid(
                    `Publication content is missing ${page.contentKey}.`);
                add(page.contentFile, Buffer.from(YAML.stringify(content[page.contentKey]), "utf8"));
            }
            const liveImages = bundle.assets.contentImagePaths(confirmedLive.content);
            for (const publicPath of bundle.assets.contentImagePaths(content)) {
                if (liveImages.has(publicPath)) continue;
                await ensureActive();
                let bytes;
                try {
                    const staged = await images.readStaged(publicPath,
                        { contentSnapshot: content });
                    if (!(staged?.data instanceof ArrayBuffer)) invalid();
                    bytes = Buffer.from(staged.data);
                } catch (error) {
                    if (error?.code !== "IMAGE_NOT_FOUND" ||
                        typeof github?.readFileAtCommit !== "function" ||
                        typeof github?.readManagedAssetBlobIdentitiesAtCommit !== "function") {
                        throw error;
                    }
                    const commit = confirmedLive.commit ?? confirmedLive.revisionId;
                    if (!/^[0-9a-f]{40}$/i.test(commit) ||
                        commit !== confirmedLive.revisionId) invalid();
                    const path = `public${publicPath}`;
                    await ensureActive();
                    try {
                        const [file, identities] = await Promise.all([
                            github.readFileAtCommit(path, commit),
                            github.readManagedAssetBlobIdentitiesAtCommit([path], commit,
                                { content }),
                        ]);
                        const identity = identities?.get(path);
                        const sha = Buffer.isBuffer(file)
                            ? createHash("sha1").update(`blob ${file.length}\0`)
                                .update(file).digest("hex") : null;
                        if (!sha || identity?.sha !== sha || identity.size !== file.length) {
                            invalid();
                        }
                        bytes = file;
                    } catch { invalid(); }
                }
                add(`public${publicPath}`, bytes);
            }
            if (bundle.legalAssetsEnabled) {
                const capability = legalService.capability;
                const current = legalService.legalFromRecord(confirmedLive);
                const originals = legalService.initialPairs();
                for (const page of Object.keys(capability.pages)) {
                    if (legal?.[page]?.document?.original &&
                        legal[page].document.hash !== originals[page].document.hash) {
                        invalid("A legal source marked original does not match the original document.");
                    }
                }
                const changed = Object.keys(capability.pages).some((page) =>
                    legal?.[page]?.document?.hash !== current[page]?.document?.hash ||
                    legal?.[page]?.pdf?.hash !== current[page]?.pdf?.hash);
                if (changed) {
                    const rendered = Object.fromEntries(Object.keys(capability.pages)
                        .map((page) => [page, { sourceTitle: legal[page].document.sourceTitle,
                            blocks: legal[page].document.blocks }]));
                    add(capability.renderedPath,
                        Buffer.from(`${JSON.stringify(rendered, null, 2)}\n`, "utf8"));
                    add(capability.manifestPath,
                        Buffer.from(`${JSON.stringify(legal, null, 2)}\n`, "utf8"));
                    for (const page of Object.keys(capability.pages)) {
                        if (legal[page].document.hash !== current[page].document.hash &&
                            !legal[page].document.original) {
                            await ensureActive();
                            add(capability.sourcePath(page, legal[page].document),
                                await legalService.readFile(page, "document",
                                    legal[page].document.hash));
                        }
                        if (legal[page].pdf.hash !== current[page].pdf.hash) {
                            await ensureActive();
                            add(capability.requirePage(page).pdfPath,
                                await legalService.readFile(page, "pdf", legal[page].pdf.hash));
                        }
                    }
                }
            }
            return files;
        },
    });
}
