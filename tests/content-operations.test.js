import assert from "node:assert/strict";
import test from "node:test";

import { createContentOperations } from "../src/server/content/operations.js";
import { exampleSite } from "./fixtures/example-site.js";

test("a neutral site supplies content policy while raw PUBLIC identity stays separate", () => {
    const policy = {
        classifyPublic(raw, canonical) {
            if (!canonical?.home?.hero?.heading) throw new Error("Canonical home is required");
            return { kind: raw.home?.hero ? "current" : "missing-hero", content: raw };
        },
        normalizePersisted(content, fallback) {
            const next = structuredClone(content);
            next.home ??= {};
            next.home.hero ??= structuredClone(fallback.home.hero);
            return next;
        },
        validateCurrent(content) {
            if (!content.home?.hero?.heading) throw new Error("Hero heading is required");
            return content;
        },
        historicalManagedAssetReferences(content) {
            return new Set(content.retiredImage ? [content.retiredImage] : []);
        },
    };
    const operations = createContentOperations(policy);
    const canonical = { home: { hero: { heading: `${exampleSite.name} hero` } } };
    const raw = { home: {}, retiredImage: `${exampleSite.managedImagePrefix}historic.png` };
    const before = structuredClone(raw);
    const result = operations.readPublic(raw, canonical);

    assert.equal(result.kind, "missing-hero");
    assert.strictEqual(result.rawContent, raw);
    assert.deepEqual(result.workingContent.home.hero, canonical.home.hero);
    assert.notStrictEqual(result.workingContent, raw);
    assert.deepEqual(raw, before);
    assert.deepEqual([...operations.historicalManagedAssetReferences(raw)], [raw.retiredImage]);
    assert.strictEqual(operations.validateCurrent(result.workingContent), result.workingContent);
    assert.throws(() => operations.validateCurrent(raw), /Hero heading is required/);
    assert.equal(operations.normalizePersisted(raw, canonical).home.hero.heading, `${exampleSite.name} hero`);
    assert.throws(() => operations.normalizePersisted(raw), TypeError);
    assert.throws(() => operations.readPublic(raw), TypeError);
});
