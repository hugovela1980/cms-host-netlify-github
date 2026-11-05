import YAML from "yaml";
import { CmsApiError } from "../http.js";

export function createCmsRepositoryContentReader({ github, pages, content } = {}) {
    if (typeof github?.readFileAtCommit !== "function" || !Array.isArray(pages) ||
        pages.length === 0 || typeof content?.readPublic !== "function") {
        throw new TypeError("Invalid CMS repository content configuration.");
    }
    const seen = new Set();
    const stablePages = pages.map((page) => {
        if (typeof page?.contentKey !== "string" || !page.contentKey ||
            typeof page.contentFile !== "string" ||
            !/^content\/[a-z0-9/-]+\.ya?ml$/i.test(page.contentFile) ||
            typeof page.allowMissing !== "boolean" || seen.has(page.contentKey)) {
            throw new TypeError("Invalid CMS repository page registration.");
        }
        seen.add(page.contentKey);
        return Object.freeze({ contentKey: page.contentKey,
            contentFile: page.contentFile, allowMissing: page.allowMissing });
    });
    return Object.freeze({
        async readAtCommit(commitSha, canonicalContent) {
            if (typeof commitSha !== "string" || !commitSha) {
                throw new TypeError("A PUBLIC commit is required.");
            }
            const raw = {};
            for (const page of stablePages) {
                let file;
                try {
                    file = await github.readFileAtCommit(page.contentFile, commitSha,
                        { allowMissing: page.allowMissing });
                } catch {
                    throw new CmsApiError("INITIAL_PUBLIC_CONTENT_UNAVAILABLE",
                        `The PUBLIC content file "${page.contentFile}" could not be read from commit "${commitSha}".`, 502);
                }
                if (file === null && page.allowMissing) continue;
                if (!Buffer.isBuffer(file)) {
                    throw new CmsApiError("INITIAL_PUBLIC_CONTENT_UNAVAILABLE",
                        `The PUBLIC content file "${page.contentFile}" could not be read from commit "${commitSha}".`, 502);
                }
                try {
                    raw[page.contentKey] = YAML.parse(file.toString("utf8"));
                } catch {
                    throw new CmsApiError("INITIAL_PUBLIC_CONTENT_INVALID",
                        `The PUBLIC content file "${page.contentFile}" could not be parsed.`, 502);
                }
            }
            return content.readPublic(raw, canonicalContent);
        },
    });
}
