import assert from "node:assert/strict";
import test from "node:test";

import { createAssetIdentityPolicy } from "../src/server/assets/identity-policy.js";
import { inventoryDurableAssetReferences } from "../src/server/assets/durable-references.js";

const field = { sectionPath: "home.hero", schemaId: "hero", fieldKey: "image.src",
    destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/" };
const path = "/images/home/cms-current.png";
const retired = "/images/legacy/cms-retired.png";
const recordedOnly = "/images/home/cms-recorded-only.png";
const policy = createAssetIdentityPolicy({ managedImages: [field],
    historicalManagedAssetReferences: (content) => new Set(content?.retired ? [content.retired] : []) });
const content = (image = path) => ({ home: { hero: { image: { src: image } } } });

test("all durable roots retain referenced paths without granting recorded-only identity", () => {
    const historical = { ...content(), retired };
    const inventory = inventoryDurableAssetReferences({
        baseline: { content: historical, assets: [retired] },
        confirmedLive: { content: content(), assets: [path] },
        draft: { content: content(), assets: [recordedOnly] },
        revisions: { entries: [{ content: historical, assets: [retired] }] },
        publication: { status: "uncertain", draft: { content: content(), assets: [path] },
            assets: [path, recordedOnly] },
    }, policy);
    assert.deepEqual(inventory.protectedPaths, new Set([path, retired, recordedOnly]));
    assert.deepEqual(inventory.identifiedPaths, new Set([path, retired]));
    assert.deepEqual(inventory.unresolvedAssets, [
        { root: "draft", path: recordedOnly },
        { root: "publication.assets", path: recordedOnly },
    ]);
    assert.deepEqual(inventory.errors, []);
});

test("terminal publications are excluded; active and uncertain publications are retained", () => {
    const roots = { baseline: { content: content() }, confirmedLive: { content: content() } };
    for (const status of ["committing", "deploying", "uncertain", "unknown"]) {
        const inventory = inventoryDurableAssetReferences({ ...roots,
            publication: { status, draft: { content: content(), assets: [recordedOnly] } } }, policy);
        assert.equal(inventory.protectedPaths.has(recordedOnly), true, status);
        assert.deepEqual(inventory.unresolvedAssets, [{ root: "publication.draft", path: recordedOnly }]);
    }
    for (const status of ["failed", "confirmed"]) {
        const inventory = inventoryDurableAssetReferences({ ...roots,
            publication: { status, draft: { content: content(), assets: [recordedOnly] } } }, policy);
        assert.equal(inventory.protectedPaths.has(recordedOnly), false, status);
    }
});

test("missing and malformed roots are explicit, while readable recorded paths remain protected", () => {
    const inventory = inventoryDurableAssetReferences({
        baseline: { content: content(), assets: [recordedOnly, null] },
        revisions: { entries: "invalid" },
        publication: { status: "uncertain", assets: [recordedOnly] },
    }, policy);
    assert.equal(inventory.protectedPaths.has(recordedOnly), true);
    assert.deepEqual(inventory.errors, [
        { root: "baseline", reason: "asset-path-invalid" },
        { root: "confirmedLive", reason: "required-root-missing" },
        { root: "revisions", reason: "entries-invalid" },
        { root: "publication.draft", reason: "content-unavailable" },
        { root: "publication.assets", reason: "content-unavailable" },
    ]);
    assert.deepEqual(inventory.unresolvedAssets, [
        { root: "baseline", path: recordedOnly },
        { root: "publication.assets", path: recordedOnly },
    ]);
    assert.throws(() => inventoryDurableAssetReferences(null, policy), TypeError);
});
