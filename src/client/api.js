export class CmsClientError extends Error {
    constructor(message, code = "CMS_REQUEST_FAILED", status = 0) {
        super(message);
        this.name = "CmsClientError";
        this.code = code;
        this.status = status;
    }
}

function requireBasePath(basePath) {
    if (typeof basePath !== "string" ||
        !/^\/(?!\/)[a-zA-Z0-9._~/-]*$/.test(basePath) ||
        (basePath !== "/" && basePath.endsWith("/")) ||
        (basePath === "/" ? [] : basePath.split("/").slice(1)).some((segment) =>
            !segment || segment === "." || segment === "..")) {
        throw new TypeError("The CMS API base path must be a root-relative pathname.");
    }
    return basePath;
}

async function cmsRequest(path, { method = "GET", body, fetchObject } = {}) {
    const response = await fetchObject(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new CmsClientError("The CMS service returned an unreadable response.",
            "INVALID_RESPONSE", response.status);
    }
    if (!response.ok) {
        throw new CmsClientError(
            typeof payload?.message === "string" ? payload.message : "The CMS request failed.",
            typeof payload?.code === "string" ? payload.code : "CMS_REQUEST_FAILED",
            response.status,
        );
    }
    return payload;
}

export function createCmsApiClient({ fetchObject = fetch,
    basePath = "/api/cms", legalEnabled = false } = {}) {
    const base = requireBasePath(basePath);
    if (typeof fetchObject !== "function" || typeof legalEnabled !== "boolean") {
        throw new TypeError("Invalid CMS API client configuration.");
    }
    const path = (suffix) => base === "/" ? `/${suffix}` : `${base}/${suffix}`;
    const client = {
        loadDraft() {
            return cmsRequest(path("draft"), { fetchObject });
        },
        saveDraft(body) {
            return cmsRequest(path("save-draft"), { method: "POST", body, fetchObject });
        },
        revertDraft(body) {
            return cmsRequest(path("revert-draft"), { method: "POST", body, fetchObject });
        },
        async uploadImage({ sectionPath, schemaId, fieldKey, file }) {
            const body = new FormData();
            body.set("sectionPath", sectionPath);
            body.set("schemaId", schemaId);
            body.set("fieldKey", fieldKey);
            body.set("file", file);
            const response = await fetchObject(path("upload-image"), {
                method: "POST", credentials: "same-origin", cache: "no-store",
                headers: { Accept: "application/json" }, body,
            });
            let payload;
            try {
                payload = await response.json();
            } catch {
                throw new CmsClientError("The image service returned an unreadable response.",
                    "INVALID_RESPONSE", response.status);
            }
            if (!response.ok) {
                throw new CmsClientError(payload?.message ?? "The image upload failed.",
                    payload?.code, response.status);
            }
            return payload;
        },
        publishDraft(expectedDraftVersion) {
            return cmsRequest(path("publish"), { method: "POST",
                body: { expectedDraftVersion }, fetchObject });
        },
        publicationStatus() {
            return cmsRequest(path("publication"), { fetchObject });
        },
        listRevisions({ page, head, highlightedRevision }) {
            const parameters = new URLSearchParams({ page: String(page) });
            if (head) parameters.set("head", head);
            if (highlightedRevision) parameters.set("highlightedRevision", highlightedRevision);
            return cmsRequest(`${path("revisions")}?${parameters}`, { fetchObject });
        },
        viewRevision(id) {
            return cmsRequest(`${path("revision")}?id=${encodeURIComponent(id)}`,
                { fetchObject });
        },
        restoreRevision(id, expectedDraftVersion) {
            return cmsRequest(path("restore-revision"), { method: "POST",
                body: { id, expectedDraftVersion }, fetchObject });
        },
    };
    if (legalEnabled) Object.assign(client, {
        async uploadLegal({ page, kind, file }) {
            const body = new FormData();
            body.set("page", page);
            body.set("kind", kind);
            body.set("file", file);
            const response = await fetchObject(path("upload-legal"), {
                method: "POST", credentials: "same-origin", cache: "no-store",
                headers: { Accept: "application/json" }, body,
            });
            const payload = await response.json();
            if (!response.ok) throw new CmsClientError(payload?.message ??
                "Legal upload failed.", payload?.code, response.status);
            return payload;
        },
        resolveLegal({ page, kind, hash }) {
            const parameters = new URLSearchParams({ page, kind, hash });
            return cmsRequest(`${path("legal-reference")}?${parameters}`,
                { fetchObject });
        },
        saveLegalDraft(body) {
            return cmsRequest(path("save-legal-draft"), { method: "POST", body,
                fetchObject });
        },
        confirmLegal(body) {
            return cmsRequest(path("confirm-legal"), { method: "POST", body,
                fetchObject });
        },
    });
    return client;
}
