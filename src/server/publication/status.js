export const UNRESOLVED_CMS_PUBLICATION_STATUSES = Object.freeze([
    "committing",
    "deploying",
    "uncertain",
]);

export function isCmsPublicationUnresolved(publication) {
    return UNRESOLVED_CMS_PUBLICATION_STATUSES.includes(publication?.status);
}

export function publicPublicationStatus(publication) {
    if (!publication) return null;
    return {
        id: publication.id ?? null,
        status: publication.status ?? "unknown",
        startedAt: publication.startedAt ?? null,
        updatedAt: publication.updatedAt ?? null,
        startedBy: publication.startedBy ?? null,
        title: publication.title ?? null,
        commitSha: publication.commitSha ?? null,
        confirmedAt: publication.confirmedAt ?? null,
        errorCode: publication.errorCode ?? null,
        deploy: publication.deploy ?? null,
    };
}
