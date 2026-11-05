import assert from "node:assert/strict";
import test from "node:test";

import { createAssetIdentityPolicy } from "../src/server/assets/identity-policy.js";

const hero = Object.freeze({
    sectionPath: "home.hero", schemaId: "home-hero", fieldKey: "image.src",
    destinationDirectory: "public/images/home", publicPathPrefix: "/images/home/",
});
const card = Object.freeze({ ...hero,
    sectionPath: "home.cards.item1", schemaId: "home-card-1" });
const article = Object.freeze({ ...card, schemaId: "home-article-1" });
const mainImage = "/images/home/cms-example.png";
const retiredImage = "/images/legacy/cms-historic.webp";

function policy(options = {}) {
    return createAssetIdentityPolicy({
        managedImages: [hero, card, article],
        historicalManagedAssetReferences(content) {
            return new Set(content?.retiredImage ? [content.retiredImage] : []);
        },
        ...options,
    });
}

test("field identity includes schema ID and image path must match its field registration", () => {
    const registry = policy();
    assert.deepEqual(registry.findField(card), card);
    assert.deepEqual(registry.findField(article), article);
    assert.equal(registry.findField({ ...card, schemaId: "unknown" }), null);
    assert.equal(registry.isFieldImagePath(hero, mainImage), true);
    assert.equal(registry.isFieldImagePath(hero, "/images/other/cms-example.png"), false);
    assert.equal(registry.isFieldImagePath(hero, "/images/home/developer-owned.png"), false);
    assert.equal(registry.isFieldImagePath(hero, "/images/home/../cms-example.png"), false);
    assert.equal(registry.isFieldImagePath({ ...hero, fieldKey: "other.src" }, mainImage), false);
    assert.throws(() => policy({ managedImages: [hero, hero] }), TypeError);
});

test("one content snapshot authorizes exact referenced repository paths and optional legal PDFs", () => {
    const content = { home: { hero: { image: { src: mainImage } } }, retiredImage };
    const withoutLegal = policy();
    assert.deepEqual([...withoutLegal.contentImagePaths(content)], [mainImage, retiredImage]);
    const allowed = withoutLegal.repositoryPathsForContent(content);
    assert.deepEqual([...allowed], ["public/images/home/cms-example.png", "public/images/legacy/cms-historic.webp"]);
    assert.deepEqual(withoutLegal.requireAllowedRepositoryPaths([...allowed], allowed), [...allowed]);
    for (const rejected of [
        "public/images/home/developer-owned.png",
        "public/images/other/cms-example.png",
        "public/images/home/../cms-example.png",
        "public/downloads/legal/Example_Privacy.pdf",
    ]) {
        assert.throws(() => withoutLegal.requireAllowedRepositoryPaths([rejected], allowed), {
            code: "MANAGED_ASSET_IDENTITY_UNAVAILABLE", status: 502,
        });
    }
    const withLegal = policy({ legalPdfPaths: ["public/downloads/legal/Example_Privacy.pdf"] });
    assert.equal(withLegal.repositoryPathsForContent(content).has("public/downloads/legal/Example_Privacy.pdf"), true);
    assert.throws(() => withLegal.requireAllowedRepositoryPaths(["public/downloads/legal/Example_Terms.pdf"],
        withLegal.repositoryPathsForContent(content)), { code: "MANAGED_ASSET_IDENTITY_UNAVAILABLE" });
});

test("recorded-only paths remain unresolved rather than gaining inferred CMS ownership", () => {
    const registry = policy();
    const content = { home: { hero: { image: { src: mainImage } } } };
    assert.deepEqual(registry.inspectRecordReferences({ content, assets: [mainImage] }), {
        imagePaths: new Set([mainImage]), unresolvedAssets: [],
    });
    assert.deepEqual(registry.inspectRecordReferences({ content, assets: ["/images/home/cms-recorded-only.png"] }), {
        imagePaths: new Set([mainImage]), unresolvedAssets: ["/images/home/cms-recorded-only.png"],
    });
});
