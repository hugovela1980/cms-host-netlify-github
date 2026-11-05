# Netlify/GitHub CMS host adapter (local checkpoint)

For a new site's storage, routes, authorization, browser wiring, and uncertain
publication procedure, see [HOST-SETUP.md](./HOST-SETUP.md).

## Neutral host composition

`createCmsHost(config)` is the async server entry point for a new host. Import it
from `@hugovela/cms-host-netlify-github/server`. It returns a frozen `handlers`
map containing the eight core JSON endpoints and two managed-image endpoints.
Legal JSON and preview endpoints appear only when `config.legal` is supplied.
The package does not register routes or authorize users. Each handler accepts
`{ request, context, actor }`; the host must authenticate the request and supply
a trusted, nonempty `{ id, email }` actor before invoking it.

The required configuration is:

- `storage: { name, getStore }`: a site-specific Blob store name and
  the host's injected `getStore({ name, consistency: "strong" })` factory. The
  returned store needs `getWithMetadata`, `getMetadata`, conditional `setJSON`,
  binary `set`, `delete`, and `list`. Legacy legal preview additionally needs
  `get`. The package fixes the six record keys inside the named store.
  Names may include underscores and Unicode, follow Netlify's 64 UTF-8 byte
  limit, and cannot contain `/` or `%2F`. The package also rejects empty names
  and surrounding whitespace to avoid ambiguous configuration.
- `pages`: ordered `{ contentKey, contentFile, allowMissing }` registrations for
  exact `content/*.yaml` files.
- `canonicalContent`: async or sync checkout content loader; `contentPolicy`,
  `managedImages`, `historyPolicy`, `applyContentChanges`, `deriveSections`,
  `validateNote`, `validateCleanupCandidates`, and `previewUrlForPath`: host-owned
  content, schema, history, validation, and image policy.
- One provider mode: `providers: { github, netlify }` for explicitly injected
  clients, or `environment` plus `fetchObject` for package GitHub/Netlify
  clients. The environment is read explicitly; credentials never enter browser
  configuration or the returned handler map.

Optional `summarizeChanges`, `now`, `createId`, `createOwner`, and `logger` support
site summaries and deterministic fixtures. A legal host additionally supplies
`legal: { pdfPaths, pages, manifestPath, renderedPath, sourceDirectory,
readOriginal, allowManifestlessOriginals, renderHtml }`. The package verifies
approved originals before returning handlers. Optional `previewBasePath` sets
the legal preview route prefix; `previewCompatibility: "legacy"` is an explicit
preview-only compatibility choice. A host without `legal` gets no legal handlers
or legal response state; construction rejects stored legal records.

`createCmsBlobStorage({ name, getStore })` exposes the same store, fixed key map,
and JSON record service for hosts composing lower-level package services. The
keys are `state/draft`, `state/developer-baseline`, `state/confirmed-live`,
`state/publication`, `state/revisions`, and `state/coordination`. Image and legal
staging retain their existing `images/staged/` and `legal/staged/` prefixes in
that same store. The factory does not import `@netlify/blobs`; the host injects
its transport and credentials. Named storage and the older `store` plus `keys`
configuration are mutually exclusive. The older form remains available only
for compatibility with this private `0.0.0` package; new hosts should use
`storage` so record keys cannot drift between sites.

See the package-owned `examples/neutral-site/composed-host.mjs` for a host-owned authorization
wrapper and `examples/neutral-site/composed-editor.mjs` for the separate browser
client/runtime entry. The credential-free composition test exercises Save,
Publish, exact READY confirmation, history, and Restore through package exports.
For an isolated consumer, pack the package and install it with its three runtime
dependencies (`fflate`, `pdfjs-dist`, `yaml`) available locally. A tarball import
check without dependency installation is not an offline install proof. This
workspace package remains private at version `0.0.0` and is not yet a release.

`npm run verify -w @hugovela/cms-host-netlify-github` now includes an isolated
offline consumer check. It packs this package and the three installed runtime
dependencies into tarballs, creates a fresh temporary project outside the
workspace with an empty npm cache, and installs those tarballs using
`npm install --offline --omit=optional --ignore-scripts`. The consumer imports
both public subpaths through the neutral host/editor examples and exercises the
synthetic no-legal and legal Save → Publish → exact READY → history → Restore
flows. The runner deletes its temporary project afterward. It requires the
three dependencies already installed locally; it does not fetch from a registry
or prove that the package can be installed without supplying those dependencies.

This private workspace package is not installed or activated in RightTrack. Its
public `./server` entry exports generic CMS HTTP and Netlify deployment helpers,
GitHub transport and explicit publication configuration,
publication-status helpers, `createCmsHostPolicyBundle`, and
`createCmsJsonRecordStore`, `createCmsDraftRecordService`, and
`createCmsDraftStateReader`, `createCmsDraftRevertService`,
`createCmsContentDraftSaveService`, `createCmsLegalCapability`,
`createCmsLegalService`, `createCmsLeaseManager`, and
`createCmsPublicationService`, and `createCmsRevisionService`. The browser-safe
`./client` entry exports `createCmsApiClient`, `CmsClientError`, and
`pollPublicationConfirmation`, plus `createCmsEditorHostRuntime`.

`createCmsEditorHostRuntime({ api?, hydrate, legalEnabled?, wait?,
maxPublicationPolls?, onReconciled?, onResumeFailure? })` owns browser-side draft version, saved-draft, legal,
and publication state. `start()` and `whenReady()` settle only after the first
authoritative draft load and the host's asynchronous `hydrate(initialDraft)`
callback finish. Save, Revert, Restore, legal confirmation, Publish, and reload
use the API client; Publish requires explicit confirmation and reloads the
authoritative draft afterward. An initially active publication resumes polling
after readiness. Host callbacks receive results and state for editor
reconciliation. The host retains DOM, authorization, schemas, legal
presentation, and editor initialization. RightTrack's current runtime does not
import the package.

`createCmsApiClient({ fetchObject?, basePath?, legalEnabled? })` preserves the
existing CMS request methods and error mapping. `basePath` defaults to
`/api/cms` and must be a root-relative pathname. Legal upload, reference,
draft-save, and confirmation methods exist only with `legalEnabled: true`.
The host supplies authentication and never sends a trusted actor in client
data. `pollPublicationConfirmation` accepts an API client and injected wait,
limit, and status callbacks; it has no editor or DOM dependency. RightTrack's
browser runtime continues using its own client until a separately reviewed
cutover.

`createCmsRevisionService({ records, bundle, historyPolicy, imageRecovery,
legalService?, legalRecovery?, leases, now? })` lists and views confirmed CMS
revisions with a separate Developer baseline. It keeps the reset-empty baseline
head, 20-row pages, head-conflict detection, and current identity from confirmed
live. The host supplies pure historical validation, missing-content restoration,
field descriptions, and changed-section callbacks; raw historical snapshots are
not rewritten. `restore` rejects the current revision and stale draft version,
rechecks revision and live records under the shared mutation lease, recovers
historical image and optional legal bytes from the exact source commit, then
writes only one conditional draft. Failed restores reverse only their own newly
staged assets with guarded rollback and report incomplete cleanup explicitly.

`createCmsPublicationService({ records, github, netlify, bundle, pages, images,
legalService?, cleanup, leases, summarizeChanges?, now?, createId? })` owns the
package's durable Publish lifecycle. The host supplies ordered exact YAML page
paths and a pure changed-section summary for fallback titles. `start` requires a
saved draft ETag and current live base, holds the shared publication lease,
verifies changed legal pairs when enabled, records `committing` before one atomic
Git attempt, and records `deploying` after the commit result. An ambiguous Git
result remains `committing` for marker recovery and never triggers a second
commit. `start` releases its lease after the durable handoff. `refresh` takes
its own lease before protected writes and returns the current status without
mutation while another request holds the lease. It recovers the commit marker,
checks only the exact PUBLIC deployment,
and finalizes a confirmed deploy with one revision, confirmed live, and the
original matching draft. Partial finalization can retry; a newer draft is
preserved. Candidate image cleanup is best effort after confirmation. No-legal
hosts produce no legal records. The package remains unused by RightTrack.

`createCmsRepositoryContentReader({ github, pages, content })` loads registered
page YAML files from an exact commit. Each page supplies `contentKey`,
`contentFile`, and an explicit `allowMissing` historical rule. It returns the
host policy's separate raw PUBLIC content and working view; unavailable or
invalid files retain `INITIAL_PUBLIC_CONTENT_UNAVAILABLE` or
`INITIAL_PUBLIC_CONTENT_INVALID` (502).

`createCmsFoundationService({ records, reader, netlify, github, bundle, leases,
legalVerifier?, now? })` uses logical `confirmedLive`, `baseline`, `publication`, and `draft`
record keys. `ensure({ canonicalContent })` captures initial confirmed-live and
Developer-baseline records with create-only writes, then reconciles current READY
content and clean drafts with ETag-matched writes under a mutation lease. It
rechecks exact READY deploy identity before each state write. A predecessor
snapshot remains raw; an existing Developer baseline never advances implicitly.
Equivalent READY identity advances only after exact referenced asset blob
identity matches at both commits. Unresolved publication and unpublished drafts
are preserved. A partial live/draft write can converge on the next `ensure`.
For a legal-enabled bundle, construction requires a package-created PUBLIC legal
verifier bound to the same bundle and GitHub provider. Capture stores the exact
verified legal pair in confirmed live and baseline. Current READY reconciliation
updates legal with content in confirmed live and clean drafts; identity-only
movement verifies old and new legal commit proofs before advancing. A no-legal
bundle still rejects existing legal records. The neutral example is
the first consumer; this service is not installed in RightTrack.

`createCmsDeveloperBaselineService({ records, netlify, reader,
canonicalContent, bundle, missingRequiredContent, legalVerifier?, leases, now? })`
provides explicit `read()`, `inspect()`, and `promote({ expectedLiveCommit,
expectedBaselineVersion })` operations for a host-owned operator workflow.
`inspect()` strongly reads CMS records and the latest READY production deploy,
requires complete raw confirmed-live content, and compares it with the exact
commit through the repository reader. A legal-enabled host supplies the
package-created PUBLIC legal verifier bound to the same bundle; promotion
requires the confirmed-live legal pair to match that exact commit. A no-legal
host rejects stored legal state. `promote()` repeats inspection under the shared
mutation lease, checks the expected commit and baseline ETag, rechecks record
and deploy identities, and conditionally replaces only the baseline snapshot.
Publish and foundation reconciliation never invoke it. The host still checks
its local Git state, presents the preflight result, obtains explicit operator
confirmation, and invokes `promote()`; this package provides no HTTP route or
CLI for baseline promotion.

`createCmsHostPolicyBundle({ contentPolicy, managedImages, legal? })` composes a
host's synchronous content policy and managed-image field registry. The required
`contentPolicy` methods are `classifyPublic`, `normalizePersisted`,
`validateCurrent`, and `historicalManagedAssetReferences`. `managedImages` contains
field registrations with `sectionPath`, `schemaId`, `fieldKey`,
`destinationDirectory`, and `publicPathPrefix`. Optional `legal` is
`{ pdfPaths: ["public/downloads/legal/Example_Privacy.pdf"] }`; omitting it
disables legal PDF asset identity. The returned `content` and `assets` objects
provide pure operations. See the package-owned `examples/neutral-site/consumer.mjs` for a second
site using only the public package export.

`createCmsLegalCapability({ assetBundle, pages, manifestPath, renderedPath,
sourceDirectory, readOriginal, allowManifestlessOriginals })` requires a
package-created legal-enabled asset
bundle with the same exact PDF paths. It loads only the host's declared approved DOCX/PDF originals and
proves their text matches before returning a legal capability. Each page supplies
an ID, label, exact original and PUBLIC PDF paths, accepted source titles, and
exact PDF footer strings that may be ignored. The host supplies paths and bytes;
the package parses, hashes, compares, and rejects missing or mismatched originals.
`createCmsLegalService({ capability, store, records, leases,
previewBasePath?, now? })` stages
DOCX/Markdown/text and PDF versions at `legal/staged/{page}/{kind}/{sha256}`
with a sidecar metadata record, reads exact hashes, composes a verified pair,
and writes legal-only drafts or exact-hash confirmations under the shared CMS
mutation lease. Matching text is ready; different text is blocked; an unreadable
PDF needs confirmation bound to both file hashes and the trusted editor. The
read-only `composeChanges` method supplies the future mixed content/legal Save
Draft seam. No-legal hosts omit this capability and create no legal state.
`previewBasePath` defaults to `/api/cms`; the service uses it for upload and
reference preview URLs. It must be a root-relative pathname.
`allowManifestlessOriginals` explicitly permits a historical PUBLIC commit
with no manifest to resolve to the approved original pair; otherwise the
read-only PUBLIC verifier fails closed.

`createCmsLegalCleanup({ capability, store, records, leases, now? })` protects
exact legal hashes from baseline, confirmed live, draft, retained revisions,
and unresolved publication before sweeping staged bytes and sidecars. Cleanup
uses the shared mutation lease, seven-day minimum age, 100-record scan and
50-attempt bounds, and strong metadata/ETag rechecks. A partial deletion is
reported and remains retryable. Legacy Restore sidecars without an upload time
are conservatively retained because their age cannot be proved. Prepared draft writes for a legal-enabled
asset bundle require the matching package legal service and prove newly added
references under their lease. `createCmsHistoricalLegalRecovery({ capability,
service, store, github, now? })` reads a trusted snapshot's exact commit and
path, verifies SHA-256 and parsed document identity, stages create-only, and
returns rollback only for newly created keys. `createCmsPublicLegalVerifier({
capability, github })` reads and verifies the exact PUBLIC manifest, rendered
blocks, source documents, and PDFs without writing CMS state. RightTrack's
authorization, route registration, and branded browser presentation remain
host responsibilities.

`createCmsManagedImageService({ store, assets, leases, previewUrlForPath,
maxBytes?, now?, createId? })` validates an exact registered field, filename,
JPEG/PNG/WebP signature, and byte limit before a create-only staged Blob write
under a mutation lease. The host supplies the trusted actor and preview URL
route. `readStaged(path)` uses a strong read and requires stored
`metadata.publicPath` to equal the requested path. `preview(path)` serves staged
bytes with private no-store/nosniff headers or redirects to the same public path
only when staging is normally absent. For an explicitly historical path outside
current registered prefixes, preview requires a trusted `contentSnapshot`.

`createCmsHistoricalImageRecovery({ store, github, assets })` recovers an image
referenced by a trusted revision or baseline snapshot from that snapshot's
exact 40-character commit SHA. It verifies snapshot ownership before the
GitHub read, stages without replacing existing bytes, and returns an ETag and
lease guarded rollback only for a blob it created. Existing staged metadata
must match the exact requested path and image type. The basename-based
`images/staged/` key remains compatible, but a same-basename record from a
different directory fails closed. The caller owns the outer Restore lease and
must pass its `ensureActive` callback. Package publication assembly and legal
recovery are available; host route registration remains separate work.

`createCmsManagedImageCleanup({ store, records, assets, leases, now? })` adds
reference-safe candidate cleanup and bounded abandoned-image GC. Candidate
cleanup receives the caller's active publication lease; GC acquires its own
`asset-cleanup` lease and skips when the coordination record is busy. Both
strong-read baseline, confirmed live, draft, retained revisions, and any
nonterminal publication. Missing required roots, malformed records, or
recorded-only paths with unresolved ownership block the entire deletion pass.
Protected public paths also protect their basename-based staged keys across
directories. Candidate cleanup has no age gate; opportunistic GC requires
valid exact upload metadata at least seven days old, examines at most 100
listed records, and attempts at most 50 deletions per sweep. List and strong
metadata ETags must agree. A strong metadata, ETag, and path recheck plus a
renewed lease precede every delete, including historical-recovery rollback.
Netlify Blobs does not offer conditional deletion, so this protects cooperating
CMS writers that share the lease; an out-of-band writer ignoring it can still
race between the final recheck and delete. No RightTrack runtime uses this
package, and deletion/GC has only been exercised against synthetic stores.

`createCmsJsonRecordStore({ store, keys })` accepts a host-supplied Blob-compatible
store and a map from logical names to exact keys. `read(name)` uses a strong JSON
read and returns the provider's `{ data, etag, metadata }` record or `null`.
`writeIfVersion(name, data, expectedEtag)` requires an explicit `null` for
create-only or a nonempty ETag for replace-if-match. It returns the provider's
`{ modified, etag? }` outcome; callers own domain-specific conflict errors.
The package neither creates a live store nor holds provider credentials. For
whole-host composition, use named `storage` as described above.

`readCmsPublicationConfig(environment)` requires an explicit host-supplied
server environment map and retains `PUBLICATION_NOT_CONFIGURED` (503) for missing
settings. `createGitHubPublicationClient(config, { fetchObject, assetIdentity })`
provides mockable atomic commit transport, exact historical file reads,
publication-marker lookup, and Git-tree blob identity. For identity reads,
`readManagedAssetBlobIdentitiesAtCommit(paths, commitSha, { content })` derives
the exact allowed repository paths from the supplied content snapshot and the
host's asset policy before making any request. Registered current or historical
images and configured legal PDFs can be checked; a developer-owned or merely
recorded path cannot gain CMS ownership. The caller remains responsible for
validating file paths before generic `readFileAtCommit` calls. The provider does
not start or finalize a CMS publication on its own.

`createCmsDraftRecordService({ records, content, leases, store, github, assets })`
uses the injected JSON
record store's `draft` key and the host's content operations. `read({
fallbackContent })` requires an explicit confirmed-live fallback and returns
the raw provider `record`, its `draftVersion`, `hasSavedDraft`, and a separate
`workingContent` view. Historical active drafts are normalized for that view;
absent or clean drafts use the fallback without rewriting the stored record.
`writePrepared({ record, expectedDraftVersion })` accepts a trusted, fully
assembled draft record, validates its current content, then writes it unchanged
with create-only or ETag-matched CAS. A stale or omitted version for an existing
draft and a lost CAS race return `DRAFT_CONFLICT` (409). The prepared write
acquires the shared mutation lease immediately before its conditional write;
a busy or lost lease returns `CMS_STATE_LOCKED` (423). The host still owns
change application, legal fields, metadata, authorization, and record assembly.
All package draft writers that can introduce image references share this lease
with image cleanup. Under the lease, a newly added managed-image reference must
have strong, exact-path staged metadata or an exact blob identity at the known
confirmed PUBLIC Git commit. Missing or ambiguous identity fails closed before
the draft write with `MANAGED_ASSET_IDENTITY_UNAVAILABLE` (502). The package
performs the proof using the injected store, GitHub client, and asset policy.

`createCmsDraftStateReader({ records, content, legalFromRecord? })` reads the
`draft`, `confirmedLive`, and `publication` records and projects the draft-state
response. `read({ confirmedFallbackContent })` requires an explicit checkout
fallback for historical confirmed-live content; an active historical draft then
uses the normalized confirmed-live view as its fallback. A missing confirmed-live
record returns `CMS_FOUNDATION_NOT_INITIALIZED` (503). The draft ETag remains the
`draftVersion`, and clean drafts retain their version and metadata while showing
confirmed-live content. Optional `legalFromRecord` supplies a host's legal
defaults and adds `legal` and `publishedLegal`; without it, those fields are
absent. This reader does not write records, reconcile deployments, or assemble
Save/Revert records.

`createCmsDraftRevertService({ records, content, leases, validateNote,
legalFromRecord?, now? })` restores a clean draft from confirmed-live content.
`revert({ request, actor, confirmedFallbackContent })` takes the already trusted
actor separately from request data, checks `expectedDraftVersion` before reading
confirmed live, and conditionally writes the established clean-draft record.
The host supplies note validation and an explicit checkout fallback. Optional
`legalFromRecord` supplies legal defaults from confirmed live; with no legal
capability, legal fields are omitted. Revert preserves the current note fallback,
cleanup candidates, base revision, ETag response, and `DRAFT_CONFLICT` (409) on
stale versions or a CAS race. Its conditional write takes the shared mutation
lease; it does not write Git or reconcile foundation state. Revert writes only
confirmed-live content, whose references already block cleanup. It rechecks the
confirmed-live ETag under that lease before writing, so an intervening
foundation change cannot turn a stale live path into a new draft reference.

`createCmsContentDraftSaveService({ records, content, leases, store, github,
assets, applyContentChanges,
deriveSections, validateNote, validateCleanupCandidates, legalFromRecord?,
now? })` saves content-only edits. `save({ request, actor,
confirmedFallbackContent })` checks the expected draft ETag, selects active raw
draft content or normalized confirmed-live content, and delegates editable-field
validation and section derivation to the host. The host callbacks must reject
non-content paths; legal file edits are outside this service. With optional
`legalFromRecord`, unchanged legal state is carried from the active draft or
confirmed live. Without it, legal fields are absent. The service merges cleanup
candidates, retains the established draft record/response and `DRAFT_CONFLICT`
(409) semantics. Its conditional draft write takes the shared mutation lease;
new image references receive the same under-lease identity proof as prepared
draft records. It never writes Git.

`createCmsLeaseManager({ records, recordName?, now?, createOwner? })` composes
one-shot acquisition and release over a `createCmsJsonRecordStore` with a
`coordination` key (or the supplied logical `recordName`). `acquire({ kind,
owner?, ttlMs? })` returns the lease and its ETag; an active lease or CAS race
returns `CMS_STATE_LOCKED` (423). `release(lease)` writes a released record only
when the lease ETag still matches, returning `false` for a stale lease. The
clock and owner generator may be injected for deterministic tests. Malformed
prior lease state fails closed. `renew(lease, { ttlMs? })` checks the current
record and expiry, then extends only the matching owner and ETag.

`withCmsMutationLease(leases, operation, { kind?, ttlMs?, renewEveryMs?, schedule? })`
acquires a mutation lease, serializes timer and explicit renewals, and settles
pending renewals before release. A final ETag-matched renewal prevents a missed
timer from turning an expired operation into success. The operation must await its `ensureActive()`
callback immediately before each protected mutation. A background renewal
failure prevents a successful result and leaves uncertain ownership untouched.
An injected scheduler supports deterministic tests; ordinary use has a timer.
`kind` defaults to `mutation`; abandoned-image GC uses `asset-cleanup`.

Run `npm run verify -w @hugovela/cms-host-netlify-github` from the repository
root for focused tests and the package boundary check. No credentials or remote
provider access are needed. The package exports core JSON, managed-image, and
optional legal JSON and preview trusted handlers, plus the editor host runtime.
`createCmsOptionalLegalPreviewHandlers({ bundle, legalService, renderHtml,
previewCompatibility? })`
requires a legal-enabled bundle and a host-owned HTML renderer; it returns no
handlers for a no-legal bundle. The package verifies original or staged files
and owns the PDF and HTML response headers. Hosts retain authorization,
branded HTML presentation, and route registration. Any live host wiring remains
separate work.
The default preview uses the legal service's strict ETag and metadata checks.
`previewCompatibility: "legacy"` is an explicit preview-only option for hosts
that must preserve the older preview route's unknown-page error, staged-file
error text, and matching-hash byte reads. It does not change the service's
strict reads used by draft, publication, or Restore.
