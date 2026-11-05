import { createCmsApiClient, createCmsEditorHostRuntime } from
    "@hugovela/cms-host-netlify-github/client";

// Import this browser entry independently of the server composition module.
export function createNeutralSiteEditor({ fetchObject, hydrate, legalEnabled = false,
    wait, maxPublicationPolls } = {}) {
    const api = createCmsApiClient({ basePath: "/neutral/cms", fetchObject,
        legalEnabled });
    return { api, runtime: createCmsEditorHostRuntime({ api, hydrate, legalEnabled,
        ...(wait && { wait }), ...(maxPublicationPolls && { maxPublicationPolls }) }) };
}
