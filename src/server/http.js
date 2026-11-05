const JSON_HEADERS = Object.freeze({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
});

export class CmsApiError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message);
        this.name = "CmsApiError";
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export function cmsJsonResponse(body, { status = 200, headers = {} } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...JSON_HEADERS, ...headers },
    });
}

export function cmsErrorResponse(error) {
    const known = error instanceof CmsApiError;
    return cmsJsonResponse({
        code: known ? error.code : "CMS_SERVICE_ERROR",
        message: known ? error.message : "The CMS service could not complete the request.",
        ...(known && error.details ? { details: error.details } : {}),
    }, { status: known ? error.status : 500 });
}

export function requireMethod(request, method) {
    if (request.method !== method) {
        throw new CmsApiError("METHOD_NOT_ALLOWED", `Use ${method} for this endpoint.`, 405);
    }
}

export async function readJsonRequest(request, { maxBytes = 256_000 } = {}) {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        throw new CmsApiError("REQUEST_TOO_LARGE", "The CMS request is too large.", 413);
    }

    try {
        const value = JSON.parse(raw || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value;
    } catch {
        throw new CmsApiError("INVALID_JSON", "The CMS request must contain a JSON object.", 400);
    }
}

export function createCmsEndpoint(handler) {
    return async (parameters) => {
        try {
            return await handler(parameters);
        } catch (error) {
            return cmsErrorResponse(error);
        }
    };
}
