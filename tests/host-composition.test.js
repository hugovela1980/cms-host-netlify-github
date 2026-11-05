import assert from "node:assert/strict";
import test from "node:test";

import { syntheticLegalConfig } from "./fixtures/packed-legal.mjs";

const packedConsumer = process.env.CMS_PACKED_CONSUMER === "1";
const server = await import(packedConsumer ?
    "@hugovela/cms-host-netlify-github/server" : "../src/server/index.js");
const client = await import(packedConsumer ?
    "@hugovela/cms-host-netlify-github/client" : "../src/client/index.js");
const { createCmsHost, CMS_RECORD_KEYS } = server;
const { createCmsApiClient, createCmsEditorHostRuntime } = client;
const neutralHost = packedConsumer ?
    await import("../examples/neutral-site/composed-host.mjs") : null;
const neutralEditor = packedConsumer ?
    await import("../examples/neutral-site/composed-editor.mjs") : null;
const neutralFunction = await import("../examples/neutral-site/netlify-cms-function.mjs");

const initialSha = "a".repeat(40);
const publishedSha = "b".repeat(40);
const actor = Object.freeze({ id: "editor-1", email: "editor@example.test" });
const keys = CMS_RECORD_KEYS;
const canonical = { home: { heading: "Example site" } };

function fakeStore() {
    const entries = new Map();
    let version = 0;
    return {
        entries,
        async getWithMetadata(key, { type, consistency } = {}) {
            assert.equal(consistency, "strong");
            const entry = entries.get(key);
            if (!entry) return null;
            assert.equal(type, entry.type);
            return { ...entry, data: type === "json" ? structuredClone(entry.data) : entry.data };
        },
        async getMetadata(key) {
            const entry = entries.get(key);
            return entry ? { etag: entry.etag, metadata: entry.metadata } : null;
        },
        async setJSON(key, data, options = {}) {
            const old = entries.get(key);
            if ((options.onlyIfNew && old) ||
                (options.onlyIfMatch !== undefined && old?.etag !== options.onlyIfMatch)) {
                return { modified: false };
            }
            const etag = `v${++version}`;
            entries.set(key, { data: structuredClone(data), etag, metadata: {}, type: "json" });
            return { modified: true, etag };
        },
        async set(key, data, options = {}) {
            const etag = `v${++version}`;
            entries.set(key, { data, etag, metadata: options.metadata ?? {}, type: "arrayBuffer" });
            return { modified: true, etag };
        },
        async delete(key) { entries.delete(key); },
        async *list() { yield { blobs: [] }; },
    };
}

function fixture({ legal = false } = {}) {
    const store = fakeStore();
    const storeCalls = [];
    const files = new Map([[initialSha, new Map([["content/home.yaml",
        Buffer.from("heading: Example site\n")]])]]);
    let commitCount = 0;
    let commitPaths = [];
    let readySha = initialSha;
    let exactSha = null;
    const github = {
        async readFileAtCommit(path, sha, { allowMissing } = {}) {
            const file = files.get(sha)?.get(path);
            if (!file && !allowMissing) throw new Error(`Missing ${path} at ${sha}`);
            return file ?? null;
        },
        async readManagedAssetBlobIdentitiesAtCommit() { return new Map(); },
        async createCommit({ files: next }) {
            commitCount += 1;
            commitPaths = next.map(({ path }) => path);
            assert.equal(commitCount, 1);
            files.set(publishedSha, new Map(next.map(({ path, base64 }) =>
                [path, Buffer.from(base64, "base64")])));
            return { commitSha: publishedSha, parentSha: initialSha,
                treeSha: "c".repeat(40) };
        },
        async findPublicationCommit() { return null; },
    };
    const netlify = {
        async findLatestReadyProductionDeploy() {
            return { id: `ready-${readySha}`, commit_ref: readySha,
                published_at: "2026-11-04T12:00:00.000Z" };
        },
        async findExactProductionDeploy(sha) {
            return exactSha === sha ? { state: "confirmed", deploy: {
                id: "ready-published", state: "ready", commit_ref: exactSha,
                published_at: "2026-11-04T12:02:00.000Z" } } :
                { state: "pending" };
        },
    };
    const configuration = {
        storage: { name: "neutral-site-cms", getStore(options) {
            storeCalls.push(options);
            return store;
        } }, providers: { github, netlify },
        pages: [{ contentKey: "home", contentFile: "content/home.yaml",
            allowMissing: false }],
        canonicalContent: () => structuredClone(canonical),
        contentPolicy: {
            classifyPublic(raw) { return { kind: "current", content: raw }; },
            normalizePersisted(raw) { return structuredClone(raw); },
            validateCurrent(raw) {
                if (!raw?.home?.heading) throw new TypeError("Missing heading.");
                return raw;
            },
            historicalManagedAssetReferences() { return new Set(); },
        },
        managedImages: [],
        historyPolicy: {
            validateHistorical(content) { assert.ok(content.home.heading); },
            restoreContent(content) { return structuredClone(content); },
            describeRevision(content) { return { values: {
                "home.heading": content.home.heading }, fieldLabels: {
                "home.heading": "Home: Heading" } }; },
            changedSections() { return [{ sectionPath: "home" }]; },
        },
        applyContentChanges(source, changes) {
            const result = structuredClone(source);
            for (const change of changes) {
                if (change.path !== "home.heading") throw new TypeError("Unknown field.");
                result.home.heading = change.value;
            }
            return result;
        },
        deriveSections: () => [{ sectionPath: "home", schemaId: "home" }],
        validateNote: (value) => String(value ?? "").trim(),
        validateCleanupCandidates: (value) => value ?? [],
        previewUrlForPath: (path) => `/neutral/cms/draft-image?path=${encodeURIComponent(path)}`,
        summarizeChanges: () => [{ label: "Heading", page: "home", pageLabel: "Home" }],
        now: () => new Date("2026-11-04T12:00:00.000Z"),
        createId: () => "neutral-publication",
        createOwner: () => "neutral-operation",
    };
    if (legal) {
        const legalConfig = syntheticLegalConfig();
        configuration.legal = { ...legalConfig,
            renderHtml: () => "<main>Example legal document</main>" };
        const originalRead = github.readFileAtCommit;
        github.readFileAtCommit = async (path, sha, options) => {
            if (sha === initialSha && path !== "content/home.yaml") return null;
            return originalRead(path, sha, options);
        };
    }
    return { configuration, store, storeCalls, files,
        get commitCount() { return commitCount; },
        get commitPaths() { return commitPaths; },
        setExact(sha) { exactSha = sha; },
        setReady(sha) { readySha = sha; exactSha = sha; } };
}

function hostTransport(handlers) {
    const routes = { "save-draft": "saveDraft", "revert-draft": "revertDraft",
        "restore-revision": "restoreRevision" };
    return async (path, options = {}) => {
        const url = new URL(path, "https://neutral.example.test");
        const route = url.pathname.split("/").at(-1);
        const handler = handlers[routes[route] ?? route];
        assert.equal(typeof handler, "function");
        return handler({ request: new Request(url, { method: options.method ?? "GET",
            ...(options.body === undefined ? {} : { body: options.body,
                headers: options.headers }) }) });
    };
}

for (const legal of [false, true]) {
    test(`composed ${legal ? "legal" : "no-legal"} host runs browser Save, Publish, READY, history and Restore`, async () => {
        const fixtureState = fixture({ legal });
        const handlers = packedConsumer ?
            await neutralHost.createNeutralSiteHandlers(fixtureState.configuration,
                async () => ({ id: actor.id, email: actor.email, canEdit: true })) :
            Object.fromEntries(Object.entries((await createCmsHost(fixtureState.configuration))
                .handlers).map(([name, handler]) =>
                [name, async ({ request, context }) => {
                    const user = { id: actor.id, email: actor.email, canEdit: true };
                    if (!user.canEdit) return new Response(null, { status: 403 });
                    return handler({ request, context,
                        actor: { id: user.id, email: user.email } });
                }]));
        assert.equal(Object.hasOwn(handlers, "legalPreview"), legal);
        assert.deepEqual(fixtureState.storeCalls,
            [{ name: "neutral-site-cms", consistency: "strong" }]);
        assert.equal(Object.hasOwn(handlers, "uploadLegal"), legal);
        let api;
        let runtime;
        let hydrated = false;
        let wrongShaObserved = false;
        const runtimeOptions = { legalEnabled: legal,
            hydrate(initial) { hydrated = initial.draft.home.heading === "Example site"; },
            wait: async () => {
                assert.equal((await api.publicationStatus()).publication.status, "deploying");
                wrongShaObserved = true;
                fixtureState.setReady(publishedSha);
            }, maxPublicationPolls: 3 };
        const fetchObject = hostTransport(handlers);
        if (packedConsumer) {
            ({ api, runtime } = neutralEditor.createNeutralSiteEditor({
                ...runtimeOptions, fetchObject }));
        } else {
            api = createCmsApiClient({ basePath: "/neutral/cms",
                legalEnabled: legal, fetchObject });
            runtime = createCmsEditorHostRuntime({ ...runtimeOptions, api });
        }
        await runtime.start();
        assert.equal(hydrated, true);
        assert.equal(runtime.state().ready, true);
        await runtime.saveChanges({ changes: [{ path: "home.heading", value: "Edited site" }],
            saveData: { note: "Example change" } });
        const stale = await api.saveDraft({ expectedDraftVersion: "stale",
            changes: [], saveData: { note: "stale" } }).catch((error) => error);
        assert.equal(stale.status, 409);
        fixtureState.setExact("d".repeat(40));
        assert.equal((await runtime.publishChanges()).publication.status, "confirmed");
        assert.equal(wrongShaObserved, true);
        assert.equal(fixtureState.commitCount, 1);
        assert.ok(fixtureState.commitPaths.includes("content/home.yaml"));
        assert.equal(Object.hasOwn(fixtureState.store.entries.get(keys.confirmedLive).data,
            "legal"), legal);
        const history = await api.listRevisions({ page: 1 });
        assert.equal(history.head, publishedSha);
        const restored = await runtime.restoreRevision("developer-baseline",
            runtime.state().draftVersion);
        assert.equal(restored.draft.home.heading, "Example site");
        assert.equal(fixtureState.commitCount, 1);
        assert.equal(Object.hasOwn((await api.loadDraft()), "legal"), legal);
    });
}

test("composition rejects incomplete inputs and stored legal state without capability", async () => {
    const { configuration, store } = fixture();
    await assert.rejects(createCmsHost({ ...configuration, providers: undefined }), TypeError);
    await assert.rejects(createCmsHost({ ...configuration, providers: undefined,
        environment: {} }), TypeError);
    await assert.rejects(createCmsHost({ ...configuration, legal: { pdfPaths: [] } }), TypeError);
    const legalConfig = fixture({ legal: true }).configuration;
    await assert.rejects(createCmsHost({ ...legalConfig, legal: {
        ...legalConfig.legal, previewCompatibility: "legacy" } }), TypeError);
    await assert.rejects(createCmsHost({ ...legalConfig, legal: {
        ...legalConfig.legal, previewBasePath: "" } }), TypeError);
    await store.setJSON(keys.draft, { legal: {} }, { onlyIfNew: true });
    await assert.rejects(createCmsHost(configuration), /Legal CMS records require/);
});
test("explicit provider environment assembles without a network request or returning secrets", async () => {
    const { configuration } = fixture();
    let requests = 0;
    const environment = {
        GITHUB_REPOSITORY_TOKEN: "synthetic-github-token",
        GITHUB_REPOSITORY_OWNER: "example",
        GITHUB_REPOSITORY_NAME: "neutral-site",
        GITHUB_REPOSITORY_BRANCH: "main",
        NETLIFY_API_TOKEN: "synthetic-netlify-token",
        NETLIFY_PUBLIC_SITE_ID: "neutral-public-site",
    };
    const host = await createCmsHost({ ...configuration, providers: undefined,
        environment, fetchObject: async () => { requests += 1;
            throw new Error("Construction must not fetch."); } });
    assert.equal(requests, 0);
    assert.equal(typeof host.handlers.draft, "function");
    assert.equal(JSON.stringify(host).includes("synthetic-"), false);
});

test("private legacy store and key configuration remains compatible", async () => {
    const { configuration, store, storeCalls } = fixture();
    const legacy = { ...configuration, storage: undefined, store, keys };
    const host = await createCmsHost(legacy);
    assert.equal(typeof host.handlers.draft, "function");
    assert.deepEqual(storeCalls, []);
});

test("neutral dispatcher binds host authentication and omits legal routes", async () => {
    const { configuration } = fixture();
    const createHandlers = packedConsumer ? neutralHost.createNeutralSiteHandlers :
        async (config, authenticate) => {
            const { handlers } = await createCmsHost(config);
            return Object.fromEntries(Object.entries(handlers).map(([name, handler]) =>
                [name, async ({ request, context }) => {
                    const user = await authenticate(request);
                    if (!user?.canEdit || !user.id || !user.email) {
                        return new Response(null, { status: 403 });
                    }
                    return handler({ request, context,
                        actor: { id: user.id, email: user.email } });
                }]));
        };
    const denied = neutralFunction.createNeutralCmsFunction(configuration,
        async () => ({ canEdit: false }), createHandlers);
    assert.equal((await denied(new Request("https://neutral.example.test/neutral/cms/draft"),
        {})).status, 403);
    const allowed = neutralFunction.createNeutralCmsFunction(configuration,
        async () => ({ ...actor, canEdit: true }), createHandlers);
    assert.equal((await allowed(new Request("https://neutral.example.test/neutral/cms/draft"),
        {})).status, 200);
    assert.equal((await allowed(new Request("https://neutral.example.test/neutral/cms/upload-legal"),
        {})).status, 404);
});
