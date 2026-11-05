import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { createCmsApiClient, createCmsEditorHostRuntime } from
    "@hugovela/cms-host-netlify-github/client";
import { createCmsHostPolicyBundle, createCmsLegalCapability,
    createCmsPublicLegalVerifier, createCmsRepositoryContentReader,
    createCmsFoundationService, createCmsLegalService,
    createCmsLeaseManager, createCmsPublicationService,
    createCmsRevisionService } from
    "@hugovela/cms-host-netlify-github/server";

const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Privacy Policy</w:t></w:r></w:p>
<w:p><w:r><w:t>Initial wording.</w:t></w:r></w:p></w:body></w:document>`;
const docx = Buffer.from(zipSync({ "word/document.xml": new TextEncoder().encode(xml) }));
const stream = "BT /F1 12 Tf 50 700 Td (Privacy Policy Initial wording.) Tj ET";
const objects = ["<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`];
let pdfSource = "%PDF-1.4\n";
const offsets = [];
for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdfSource));
    pdfSource += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdfSource);
pdfSource += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdfSource += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
pdfSource += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
const pdf = Buffer.from(pdfSource);

const pdfPath = "public/downloads/legal/Example_Privacy.pdf";
const bundle = createCmsHostPolicyBundle({ contentPolicy: {
    classifyPublic(raw) { return { kind: "current", content: raw }; },
    normalizePersisted(raw) { return raw; }, validateCurrent(raw) { return raw; },
    historicalManagedAssetReferences() { return new Set(); },
}, managedImages: [], legal: { pdfPaths: [pdfPath] } });
const files = new Map([["docs/example/privacy.docx", docx],
    ["docs/example/privacy.pdf", pdf]]);
const capability = await createCmsLegalCapability({ assetBundle: bundle,
    allowManifestlessOriginals: true,
    pages: { privacy: { label: "Privacy Policy",
        originalDocumentPath: "docs/example/privacy.docx",
        originalPdfPath: "docs/example/privacy.pdf", pdfPath,
        sourceTitles: ["Privacy Policy"], ignoredPdfFooterTexts: [] } },
    manifestPath: "content/legal.json", renderedPath: "src/_data/legalDocuments.json",
    sourceDirectory: "content/legal-documents",
    readOriginal: async (path) => files.get(path) ?? null });
assert.equal(capability.initialPairs().privacy.verification.status, "matches");
const github = { async readFileAtCommit(path, commit, options) {
        assert.equal(commit, "a".repeat(40));
        if (path === "content/home.yaml") return Buffer.from("heading: Example site\n");
        assert.equal(options.allowMissing, true);
        return null;
    }, async readManagedAssetBlobIdentitiesAtCommit() {
        throw new Error("Initial capture requires no image identity lookup.");
    } };
const proof = createCmsPublicLegalVerifier({ capability, github });
assert.deepEqual(await proof.readAtCommit("a".repeat(40)), capability.initialPairs());
const state = new Map();
let sequence = 0;
const records = {
    async read(name) { return state.get(name) ?? null; },
    async writeIfVersion(name, data, expected) {
        const prior = state.get(name);
        if (expected === null ? Boolean(prior) : prior?.etag !== expected) {
            return { modified: false };
        }
        const etag = `example-${++sequence}`;
        state.set(name, { data: structuredClone(data), etag });
        return { modified: true, etag };
    },
};
const reader = createCmsRepositoryContentReader({ github,
    content: bundle.content, pages: [{ contentKey: "home",
        contentFile: "content/home.yaml", allowMissing: false }] });
const foundation = createCmsFoundationService({ records, reader, legalVerifier: proof,
    github, bundle, netlify: { async findLatestReadyProductionDeploy() {
        return { id: "example-ready", commit_ref: "a".repeat(40),
            published_at: "2026-11-04T12:00:00.000Z" };
    } }, leases: { async acquire() { return { owner: "example" }; },
        async renew(lease) { return lease; }, async release() { return true; } } });
const captured = await foundation.ensure({ canonicalContent: { home: {
    heading: "Example site" } } });
assert.deepEqual(captured.live.data.legal, capability.initialPairs());
assert.deepEqual(captured.baseline.data.legal, capability.initialPairs());
const now = () => new Date("2026-11-04T12:00:00.000Z");
const leases = createCmsLeaseManager({ records, now,
    createOwner: () => "example-publication" });
const legalService = createCmsLegalService({ capability, records, leases, now,
    store: { async set() {}, async setJSON() {}, async getWithMetadata() { return null; } } });
const draft = await records.writeIfVersion("draft", { content: { home: {
    heading: "Updated example" } }, legal: capability.initialPairs(),
baseRevision: "a".repeat(40), hasUnpublishedChanges: true }, null);
let committedFiles;
github.createCommit = async ({ files: next }) => {
    committedFiles = next;
    return { commitSha: "b".repeat(40), parentSha: "a".repeat(40),
        treeSha: "c".repeat(40) };
};
github.findPublicationCommit = async () => null;
const publication = createCmsPublicationService({ records, github, bundle,
    legalService, leases, now, createId: () => "example-publication",
    pages: [{ contentKey: "home", contentFile: "content/home.yaml" }],
    images: { async readStaged() { throw new Error("No image needed."); } },
    cleanup: { async cleanupCandidates() { return []; } },
    summarizeChanges: () => [{ label: "Home", page: "home",
        pageLabel: "Home" }],
    netlify: { async findExactProductionDeploy() { return { state: "confirmed",
        deploy: { id: "example-deploy", state: "ready",
            commit_ref: "b".repeat(40), published_at: "2026-11-04T12:02:00.000Z" } }; } },
});
assert.equal((await publication.start({ expectedDraftVersion: draft.etag,
    actor: { email: "editor@example.test" } })).status, "deploying");
assert.deepEqual(committedFiles.map(({ path }) => path), ["content/home.yaml"]);
assert.equal((await publication.refresh()).status, "confirmed");
assert.deepEqual((await records.read("confirmedLive")).data.legal,
    capability.initialPairs());
const history = createCmsRevisionService({ records, bundle,
    legalService, leases, now,
    legalRecovery: { async recover({ snapshot, page, kind }) {
        assert.equal(snapshot.sourceCommit, "a".repeat(40));
        assert.equal(snapshot.legal[page][kind].original, true);
    } },
    imageRecovery: { async recover() { throw new Error("No image expected."); } },
    historyPolicy: {
        validateHistorical(content) { assert.ok(content.home.heading); },
        restoreContent(content) { return structuredClone(content); },
        describeRevision(content, legal) { return {
            values: { "home.heading": content.home.heading,
                "legal.privacy.pdf": legal.privacy.pdf.name },
            fieldLabels: { "home.heading": "Home: Heading",
                "legal.privacy.pdf": "Privacy Policy: Downloadable PDF" },
        }; },
        changedSections() { return [{ sectionPath: "home" }]; },
    } });
assert.equal((await history.list()).head, "b".repeat(40));
assert.equal((await history.view("developer-baseline")).revision.legal.privacy
    .pdf.original, true);
const currentDraft = await records.read("draft");
const restored = await history.restore({ id: "developer-baseline",
    expectedDraftVersion: currentDraft.etag,
    actor: { email: "editor@example.test" } });
assert.equal(restored.draft.home.heading, "Example site");
assert.deepEqual((await records.read("draft")).data.legal,
    capability.initialPairs());
const browserRequests = [];
const browserApi = createCmsApiClient({ legalEnabled: true,
    fetchObject: async (path, options) => {
        browserRequests.push({ path, options });
        return new Response(JSON.stringify(path.endsWith("/draft")
            ? { draft: { home: { heading: "Example site" } },
                published: { home: { heading: "Example site" } },
                draftVersion: "legal-client-v1", hasSavedDraft: true,
                legal: capability.initialPairs(),
                publishedLegal: capability.initialPairs(),
                publicationStatus: { status: "idle" } }
            : path.endsWith("/confirm-legal")
                ? { draftVersion: "legal-client-v2",
                    legal: capability.initialPairs() }
                : { hash: "legal-example" }));
    } });
assert.equal((await browserApi.uploadLegal({ page: "privacy", kind: "pdf",
    file: new File([pdf], "privacy.pdf", { type: "application/pdf" }) })).hash,
"legal-example");
assert.equal(browserRequests[0].path, "/api/cms/upload-legal");
assert.equal(browserRequests[0].options.body.get("page"), "privacy");
assert.equal(browserRequests[0].options.headers["Content-Type"], undefined);
await browserApi.confirmLegal({ page: "privacy", expectedDraftVersion: "v1" });
assert.equal(browserRequests[1].path, "/api/cms/confirm-legal");
const browserRuntime = createCmsEditorHostRuntime({ api: browserApi,
    legalEnabled: true, hydrate(initialDraft) {
        assert.equal(initialDraft.draftVersion, "legal-client-v1");
    } });
await browserRuntime.start();
assert.equal(browserRuntime.state().legal.privacy.pdf.original, true);
await browserRuntime.confirmLegal({ page: "privacy", documentHash: "a",
    pdfHash: "b" });
assert.equal(browserRuntime.state().draftVersion, "legal-client-v2");
console.log("Neutral legal consumer passed.");
