import { createCmsHost } from "@hugovela/cms-host-netlify-github/server";

// Pass config.storage as { name: "neutral-site-cms", getStore } using the
// host's Blob transport. A neutral host owns session checks and route
// registration; applications use their own trusted authentication system.
export async function createNeutralSiteHandlers(config, authenticate) {
    if (typeof authenticate !== "function") throw new TypeError("Authentication is required.");
    const { handlers } = await createCmsHost(config);
    return Object.freeze(Object.fromEntries(Object.entries(handlers).map(([name, handler]) =>
        [name, async ({ request, context }) => {
            const user = await authenticate(request);
            if (!user?.canEdit || !user.id || !user.email) {
                return new Response(null, { status: 403 });
            }
            return handler({ request, context,
                actor: { id: user.id, email: user.email } });
        }])));
}
