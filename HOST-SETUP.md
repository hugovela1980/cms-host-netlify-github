# Standalone CMS host setup

This is a package-only integration guide for a new site. The workspace package is
private at `0.0.0`; it is not published, installed in RightTrack, or ready for a
production deployment. The offline packed-consumer test proves installation from
a local tarball with its runtime dependencies supplied locally. A consuming site
must make its own package distribution and deployment decisions.

## Runtime and storage

Use Node.js `>=22.13.0` and provide the package's runtime dependencies:
`fflate`, `pdfjs-dist`, and `yaml`. A Netlify host also supplies its own
`@netlify/blobs` installation; this package does not import or depend on it.
Choose one named Blob store per site and pass the host's `getStore` function:

```js
import { getStore } from "@netlify/blobs";

const storage = { name: "neutral-site-cms", getStore };
// Pass storage to createCmsHost({ storage, ...siteConfiguration }).
```

The package calls `getStore({ name, consistency: "strong" })`. Within that one
store it owns `state/draft`, `state/developer-baseline`,
`state/confirmed-live`, `state/publication`, `state/revisions`, and
`state/coordination`. Staged images and legal files retain `images/staged/` and
`legal/staged/` prefixes. The host must not configure arbitrary record keys in
the recommended `storage` mode. Store names accept provider-supported Unicode
and underscores, reject `/` and `%2F`, and are limited to 64 UTF-8 bytes; this
package additionally rejects empty names and surrounding whitespace.

## Server configuration and authorization

Import `createCmsHost` from `@hugovela/cms-host-netlify-github/server`. Supply
the site's page registrations, canonical content loader, content policy,
managed-image registrations, history policy, edit/validation callbacks, preview
URL builder, and `storage`. See the package README and
the package-owned `examples/neutral-site/composed-host.mjs`. Supply exactly one provider mode:
injected `{ github, netlify }` clients for synthetic tests, or an explicit
server-only `environment` and `fetchObject` for the package's provider clients.
The publication environment requires these six values:

| Variable | Meaning |
| --- | --- |
| `GITHUB_REPOSITORY_TOKEN` | Server-only token for the target repository |
| `GITHUB_REPOSITORY_OWNER` | Repository owner |
| `GITHUB_REPOSITORY_NAME` | Repository name |
| `GITHUB_REPOSITORY_BRANCH` | Publication branch |
| `NETLIFY_API_TOKEN` | Server-only deployment lookup token |
| `NETLIFY_PUBLIC_SITE_ID` | PUBLIC site ID used for exact deploy lookup |

The package reads these values only from the explicit environment object.
Missing values produce `PUBLICATION_NOT_CONFIGURED`. The GitHub client creates
blobs, a tree and commit, then updates the branch ref without force. GitHub's
[Update a reference documentation](https://docs.github.com/en/rest/git/refs#update-a-reference)
lists **Contents: write** for fine-grained tokens for that ref update. Confirm
the complete token permissions needed for the chosen repository and provider
deployment before use; this guide does not assert a broader permission recipe.

The site must authenticate every request before a package handler runs and
derive trusted `{ id, email }` from its own session. Never take the actor from
JSON, headers, or query parameters. The neutral wrapper takes a required
`authenticate(request)` callback and returns 403 for an unapproved user. The
host owns its login, roles, route registration, and any editor-only deployment
guard.

## Routes and browser

The package-owned `examples/neutral-site/netlify-cms-function.mjs` supplies a route table and
`config.path: "/neutral/cms/*"`. Netlify documents
[custom Function paths and URLPattern wildcards](https://docs.netlify.com/build/functions/configuration/#path-patterns).
Copy the dispatcher and `composed-host.mjs` into a host source directory outside
`netlify/functions` (for example `site/cms/`), so Netlify does not discover the
helpers as separate Functions. Adapt the base path if needed. Place only the
bound entry file in `netlify/functions/`; it imports the helpers and supplies
actual host configuration and authentication:

```js
// netlify/functions/neutral-cms.mjs
import { createNeutralCmsFunction, config } from "../../site/cms/netlify-cms-function.mjs";
import { createNeutralSiteHandlers } from "../../site/cms/composed-host.mjs";
import { siteCmsConfig, authenticateEditor } from "../../site/cms/site-cms.mjs";

export { config };
export default createNeutralCmsFunction(siteCmsConfig, authenticateEditor,
  createNeutralSiteHandlers);
```

`site-cms.mjs` above is a host-owned module, not part of this example. Its
`authenticateEditor` must check the real session and return a trusted user with
`canEdit`, `id`, and `email`. The dispatcher returns 404 for unknown paths and
for legal paths when the legal capability is absent. Package handlers enforce
request methods and validate payloads. The route table covers `draft`,
`save-draft`, `revert-draft`, `upload-image`, `draft-image`, `publish`,
`publication`, `revisions`, `revision`, `restore-revision`, and the optional
`upload-legal`, `legal-reference`, `save-legal-draft`, `confirm-legal`, and
`legal-preview` endpoints.

In browser code, import `createCmsApiClient` and
`createCmsEditorHostRuntime` from `@hugovela/cms-host-netlify-github/client`.
Use the same `basePath` as the Function route (`/neutral/cms` here), supply the
site's editor hydration callback, and await `runtime.start()` or
`runtime.whenReady()` before treating persisted draft state as ready. The
neutral `composed-editor.mjs` shows this wiring. Keep provider credentials and
server-only content policy out of the browser bundle.

For a legal-enabled site, supply the legal capability configuration described
in the README: exact approved originals, page IDs and paths, `readOriginal`,
and a host HTML renderer. Set `legalEnabled: true` in the browser and use a
`legal.previewBasePath` matching the Function base path for generated preview
URLs. Without `legal`, the package exposes no legal handlers or response state.

## Uncertain publication

If Publish returns `committing`, `deploying`, or `uncertain`, use the authenticated
`GET /neutral/cms/publication` route to refresh the durable publication status.
Keep the editor's draft and expected version intact. Inspect the recorded
publication ID and commit SHA, the configured branch, and the exact production
deploy for that SHA. The package confirms publication only when Netlify reports
that exact commit as a READY, published production deploy on the configured
branch. A Git commit or branch movement alone is not a deployed release.

Refresh can advance a stored `committing` or `deploying` publication. A stored
`uncertain` status is terminal to the package's refresh operation: repeated
refreshes return it unchanged. Stop new Publish attempts and investigate the
provider and durable record state with an authorized operator. Recovery from
that state requires a separately reviewed, authorized reconciliation decision;
do not blindly retry Publish, clear Blob records, advance the Developer
baseline, or infer success from a commit SHA.
Developer-baseline promotion is a separate explicit operator operation after
confirmed live state and its own preflight.
