import assert from "node:assert/strict";
import test from "node:test";

import { createCmsEditorHostRuntime } from "../src/client/index.js";

function initial(overrides = {}) {
    return { draft: { home: { heading: "Draft" } },
        published: { home: { heading: "Live" } },
        draftVersion: "draft-1", hasSavedDraft: true,
        publicationStatus: { status: "idle" }, ...overrides };
}

function api(overrides = {}) {
    return { async loadDraft() { return initial(); },
        async saveDraft() { return { draftVersion: "draft-2" }; },
        async revertDraft() { return { draft: initial().published,
            draftVersion: "draft-3", hasSavedDraft: false }; },
        async restoreRevision() { return { draft: initial().draft,
            draftVersion: "draft-4" }; },
        async publishDraft() { return { publication: { status: "deploying" } }; },
        async publicationStatus() { return { publication: { status: "confirmed" } }; },
        ...overrides };
}

test("readiness waits for authoritative load and host hydration", async () => {
    let release;
    const hydration = new Promise((resolve) => { release = resolve; });
    const events = [];
    const runtime = createCmsEditorHostRuntime({ api: api({
        async loadDraft() { events.push("load"); return initial(); },
    }), async hydrate(result) {
        events.push(`hydrate:${result.draftVersion}`);
        await hydration;
        events.push("hydrated");
    } });
    let settled = false;
    const starting = runtime.start().then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(runtime.state().ready, false);
    assert.deepEqual(events, ["load", "hydrate:draft-1"]);
    release();
    await starting;
    assert.equal(runtime.state().ready, true);
    assert.equal(runtime.state().draftVersion, "draft-1");
    assert.deepEqual(events, ["load", "hydrate:draft-1", "hydrated"]);
    assert.strictEqual(runtime.whenReady(), runtime.start());
});

test("load or hydration failure rejects readiness without reporting ready", async () => {
    const loadError = new Error("load failed");
    const failedLoad = createCmsEditorHostRuntime({ api: api({
        async loadDraft() { throw loadError; },
    }), hydrate() { assert.fail("Hydration must not run"); } });
    await assert.rejects(failedLoad.start(), (error) => error === loadError);
    assert.equal(failedLoad.state().ready, false);
    const hydrateError = new Error("hydrate failed");
    const failedHydration = createCmsEditorHostRuntime({ api: api(),
        async hydrate() { throw hydrateError; } });
    await assert.rejects(failedHydration.start(),
        (error) => error === hydrateError);
    await assert.rejects(failedHydration.whenReady(),
        (error) => error === hydrateError);
    assert.equal(failedHydration.state().ready, false);
});

test("an initially active publication resumes after readiness and reloads on confirmation", async () => {
    const events = [];
    let loads = 0;
    let complete;
    const reconciled = new Promise((resolve) => { complete = resolve; });
    const runtime = createCmsEditorHostRuntime({ api: api({
        async loadDraft() {
            loads += 1;
            events.push(`load:${loads}`);
            return initial({ draftVersion: loads === 1 ? "draft-1" : "draft-2",
                hasSavedDraft: loads === 1,
                publicationStatus: { status: "deploying" } });
        },
        async publicationStatus() {
            events.push("status:confirmed");
            return { publication: { status: "confirmed" } };
        },
    }), hydrate() { events.push("hydrate"); },
    onReconciled(refreshed, state) {
        events.push(`reconciled:${refreshed.draftVersion}`);
        assert.equal(state.ready, true);
        complete();
    } });
    const started = await runtime.start();
    assert.equal(started.state.ready, true);
    await reconciled;
    assert.deepEqual(events, ["load:1", "hydrate", "status:confirmed",
        "load:2", "reconciled:draft-2"]);
    assert.equal(runtime.state().publicationBlocked, false);
    assert.equal(runtime.state().draftVersion, "draft-2");
});

test("background resume reports uncertainty without claiming confirmation", async () => {
    let complete;
    const failed = new Promise((resolve) => { complete = resolve; });
    const runtime = createCmsEditorHostRuntime({ api: api({
        async loadDraft() { return initial({ publicationStatus: {
            status: "deploying" } }); },
        async publicationStatus() { return { publication: {
            status: "uncertain" } }; },
    }), hydrate() {}, onResumeFailure(error, state) {
        assert.equal(error.code, "UNEXPECTED_PUBLICATION_STATUS");
        assert.equal(state.publicationBlocked, true);
        complete();
    } });
    await runtime.start();
    await failed;
    assert.equal(runtime.state().publicationActive, false);
    assert.equal(runtime.state().publicationBlocked, true);
});

test("Save, Revert, Restore and reload retain authoritative draft versions", async () => {
    const events = [];
    let loads = 0;
    const runtime = createCmsEditorHostRuntime({ hydrate() {}, api: api({
        async loadDraft() { loads += 1; return initial({
            draftVersion: loads === 1 ? "draft-1" : "draft-4",
        }); },
        async saveDraft(request) {
            events.push(["save", request]);
            return { draftVersion: "draft-2" };
        },
        async revertDraft(request) {
            events.push(["revert", request]);
            return { draft: initial().published, draftVersion: "draft-3",
                hasSavedDraft: false };
        },
        async restoreRevision(id, version) {
            events.push(["restore", id, version]);
            return { draft: initial().draft, draftVersion: "draft-4" };
        },
    }) });
    await runtime.start();
    await runtime.saveChanges({ changes: [{ path: "home.heading", value: "Edit" }],
        saveData: { draftNote: "Note" } });
    assert.deepEqual(events[0][1].saveData, { note: "Note" });
    assert.equal(events[0][1].expectedDraftVersion, "draft-1");
    assert.equal(runtime.state().draftVersion, "draft-2");
    await runtime.revertChanges();
    assert.deepEqual(events[1], ["revert", { expectedDraftVersion: "draft-2" }]);
    assert.equal(runtime.state().hasSavedDraft, false);
    await runtime.restoreRevision("older", "draft-3", {
        onRestored({ refreshed }, state) {
            assert.equal(refreshed.draftVersion, "draft-4");
            assert.equal(state.hasSavedDraft, true);
        },
    });
    assert.deepEqual(events[2], ["restore", "older", "draft-3"]);
    assert.equal(runtime.state().draftVersion, "draft-4");
    await runtime.reloadDraft();
    assert.equal(runtime.state().draftVersion, "draft-4");
});

test("stale Save and Publish preserve the local draft version and original error", async () => {
    const stale = Object.assign(new Error("The draft changed."), {
        code: "DRAFT_CONFLICT", status: 409 });
    const runtime = createCmsEditorHostRuntime({ hydrate() {}, api: api({
        async saveDraft() { throw stale; },
        async publishDraft() { throw stale; },
        async publicationStatus() { return { publication: { status: "idle" } }; },
    }) });
    await runtime.start();
    await assert.rejects(runtime.saveChanges({ changes: [] }),
        (error) => error === stale);
    assert.equal(runtime.state().draftVersion, "draft-1");
    await assert.rejects(runtime.publishChanges(), (error) => error === stale);
    assert.equal(runtime.state().draftVersion, "draft-1");
    assert.equal(runtime.state().publicationBlocked, false);
});

test("publication reports stages and reloads only after explicit confirmation", async () => {
    const events = [];
    let loads = 0;
    let statusCalls = 0;
    const runtime = createCmsEditorHostRuntime({ hydrate() {},
        wait: async () => {}, maxPublicationPolls: 3, api: api({
            async loadDraft() { loads += 1; events.push("load"); return initial({
                draftVersion: loads === 1 ? "draft-1" : "draft-confirmed",
                hasSavedDraft: loads === 1,
            }); },
            async publishDraft(version) {
                events.push(`publish:${version}`);
                return { publication: { status: "deploying" } };
            },
            async publicationStatus() {
                const status = statusCalls++ ? "confirmed" : "deploying";
                events.push(`status:${status}`);
                return { publication: { status } };
            },
        }) });
    await runtime.start();
    const result = await runtime.publishChanges({
        reportProgress(stage) { events.push(`progress:${stage}`); },
        onReconciled(refreshed, state) {
            events.push(`reconciled:${refreshed.draftVersion}`);
            assert.equal(state.canPublish, false);
        },
    });
    assert.equal(result.publication.status, "confirmed");
    assert.deepEqual(events, ["load", "progress:creating-version",
        "publish:draft-1", "progress:updating-live",
        "progress:confirming-live", "status:deploying", "status:confirmed",
        "load", "reconciled:draft-confirmed"]);
    assert.equal(runtime.state().publicationBlocked, false);
});

test("failed or uncertain Publish stays conservative after status recheck", async () => {
    for (const status of ["failed", "uncertain"]) {
        const runtime = createCmsEditorHostRuntime({ hydrate() {},
            wait: async () => {}, maxPublicationPolls: 1, api: api({
                async publicationStatus() { return { publication: { status,
                    errorCode: "PUBLIC_DEPLOYMENT_FAILED" } }; },
            }) });
        await runtime.start();
        await assert.rejects(runtime.publishChanges());
        assert.equal(runtime.state().publicationBlocked,
            status === "uncertain");
    }
    const runtime = createCmsEditorHostRuntime({ hydrate() {}, api: api({
        async publishDraft() { throw new Error("start unavailable"); },
        async publicationStatus() { throw new Error("status unavailable"); },
    }) });
    await runtime.start();
    await assert.rejects(runtime.publishChanges(), /start unavailable/);
    assert.equal(runtime.state().publicationActive, true);
    assert.equal(runtime.state().publicationBlocked, true);
});

test("optional legal state gates publishing and confirmation updates its version", async () => {
    const pair = { verification: { status: "different" } };
    const runtime = createCmsEditorHostRuntime({ legalEnabled: true,
        hydrate() {}, api: api({
            async loadDraft() { return initial({ legal: { privacy: pair },
                publishedLegal: { privacy: pair } }); },
            async confirmLegal(request) {
                assert.equal(request.expectedDraftVersion, "draft-1");
                return { draftVersion: "draft-2", legal: { privacy: {
                    verification: { status: "matches" } } } };
            },
        }) });
    await runtime.start();
    assert.equal(runtime.state().canPublish, false);
    await runtime.confirmLegal({ page: "privacy", documentHash: "a",
        pdfHash: "b" });
    assert.equal(runtime.state().draftVersion, "draft-2");
    assert.equal(runtime.state().canPublish, true);
    const noLegal = createCmsEditorHostRuntime({ hydrate() {}, api: api() });
    await noLegal.start();
    await assert.rejects(noLegal.confirmLegal({ page: "privacy" }), TypeError);
    assert.deepEqual(noLegal.state().legal, {});
});

test("default API construction follows the runtime's legal capability", () => {
    assert.doesNotThrow(() => createCmsEditorHostRuntime({
        legalEnabled: true, hydrate() {},
    }));
    assert.doesNotThrow(() => createCmsEditorHostRuntime({
        legalEnabled: false, hydrate() {},
    }));
});
