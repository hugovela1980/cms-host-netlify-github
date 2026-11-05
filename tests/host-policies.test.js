import assert from "node:assert/strict";
import test from "node:test";

import { createCmsHostPolicyBundle } from "../src/server/index.js";

const field = { sectionPath: "home.hero", schemaId: "example-hero", fieldKey: "image.src",
    destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/" };
const image = "/images/home/cms-hero.png";
const retired = "/images/legacy/cms-old.png";
const legalPdf = "public/downloads/legal/Example_Privacy.pdf";
const policy = {
    classifyPublic(raw) { return { kind: raw.home?.hero ? "current" : "legacy", content: raw }; },
    normalizePersisted(raw, fallback) {
        const next = structuredClone(raw);
        next.home ??= {};
        next.home.hero ??= structuredClone(fallback.home.hero);
        return next;
    },
    validateCurrent(content) {
        if (!content.home?.hero?.heading) throw new TypeError("Missing heading.");
        return content;
    },
    historicalManagedAssetReferences(content) {
        return new Set(content.retiredImage ? [content.retiredImage] : []);
    },
};
const canonical = { home: { hero: { heading: "Example", image: { src: image } } } };

test("neutral host composes current and historical content with exact image identity", () => {
    const bundle = createCmsHostPolicyBundle({ contentPolicy: policy, managedImages: [field] });
    const raw = { home: {}, retiredImage: retired };
    const before = structuredClone(raw);
    const result = bundle.content.readPublic(raw, canonical);
    assert.equal(result.kind, "legacy");
    assert.strictEqual(result.rawContent, raw);
    assert.deepEqual(raw, before);
    assert.deepEqual(result.workingContent.home.hero, canonical.home.hero);
    assert.strictEqual(bundle.content.validateCurrent(result.workingContent), result.workingContent);
    assert.deepEqual(bundle.assets.contentImagePaths(raw), new Set([retired]));
    assert.equal(bundle.assets.isFieldImagePath(field, image), true);
    assert.equal(bundle.assets.isFieldImagePath(field, "/images/other/cms-hero.png"), false);
    assert.equal(bundle.assets.repositoryPathsForContent(canonical).has(`public${image}`), true);
    assert.equal(bundle.legalAssetsEnabled, false);
    assert.equal(Object.isFrozen(bundle), true);
});

test("legal PDF identity is optional and exact", () => {
    const withoutLegal = createCmsHostPolicyBundle({ contentPolicy: policy, managedImages: [field] });
    const withLegal = createCmsHostPolicyBundle({ contentPolicy: policy, managedImages: [field],
        legal: { pdfPaths: [legalPdf] } });
    const absent = withoutLegal.assets.repositoryPathsForContent(canonical);
    const configured = withLegal.assets.repositoryPathsForContent(canonical);
    assert.equal(absent.has(legalPdf), false);
    assert.equal(configured.has(legalPdf), true);
    assert.equal(configured.has("public/downloads/legal/Example_Terms.pdf"), false);
    assert.equal(withLegal.legalAssetsEnabled, true);
    assert.throws(() => withoutLegal.assets.requireAllowedRepositoryPaths([legalPdf], absent),
        { code: "MANAGED_ASSET_IDENTITY_UNAVAILABLE", status: 502 });
});

test("constructed operations retain validated callbacks after caller mutation", () => {
    const mutablePolicy = { ...policy };
    const bundle = createCmsHostPolicyBundle({ contentPolicy: mutablePolicy,
        managedImages: [field] });
    mutablePolicy.classifyPublic = null;
    mutablePolicy.historicalManagedAssetReferences = () => new Set();
    assert.equal(bundle.content.readPublic({ home: {} }, canonical).kind, "legacy");
    assert.deepEqual(bundle.assets.contentImagePaths({ retiredImage: retired }), new Set([retired]));
});

test("invalid host policy, duplicate fields, and malformed legal paths fail construction", () => {
    for (const bad of [undefined, null, {}, { ...policy, validateCurrent: null }]) {
        assert.throws(() => createCmsHostPolicyBundle({ contentPolicy: bad, managedImages: [field] }), TypeError);
    }
    assert.throws(() => createCmsHostPolicyBundle({ contentPolicy: policy }), TypeError);
    assert.throws(() => createCmsHostPolicyBundle({ contentPolicy: policy, managedImages: [field, field] }), TypeError);
    for (const legal of [{}, { pdfPaths: [] }, { pdfPaths: ["public/other.pdf"] }]) {
        assert.throws(() => createCmsHostPolicyBundle({ contentPolicy: policy,
            managedImages: [field], legal }), TypeError);
    }
});
