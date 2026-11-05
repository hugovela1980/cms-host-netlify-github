// The host supplies its API client and scheduler. This has no editor or DOM dependency.
export async function pollPublicationConfirmation({
    api,
    wait,
    maxPolls,
    onActiveChange = () => {},
    onStatus = () => {},
}) {
    for (let poll = 0; poll < maxPolls; poll += 1) {
        const publication = (await api.publicationStatus())?.publication;
        const status = publication?.status;
        const active = ["committing", "deploying"].includes(status);
        onStatus(status);
        onActiveChange(active);
        if (status === "confirmed") return publication;
        if (status === "failed") {
            const error = new Error("The PUBLIC deployment could not be confirmed. The saved draft was preserved.");
            error.code = publication.errorCode ?? "PUBLICATION_FAILED";
            throw error;
        }
        if (!active) {
            const error = new Error("The publication service returned an unexpected status.");
            error.code = "UNEXPECTED_PUBLICATION_STATUS";
            throw error;
        }
        if (poll + 1 < maxPolls) await wait(3_000);
    }
    const error = new Error("Publication confirmation polling reached its safety limit.");
    error.code = "PUBLICATION_POLL_LIMIT";
    throw error;
}
