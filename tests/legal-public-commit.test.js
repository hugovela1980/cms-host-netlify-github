import assert from "node:assert/strict";
import test from "node:test";

import { createCmsLegalCapability, createCmsPublicLegalVerifier } from
    "../src/server/index.js";
import { legalHash, parseLegalDocx } from "../src/server/legal/document.js";
import { syntheticDocx, syntheticLegalConfig, syntheticPdf } from "./fixtures/legal.js";

const COMMIT = "c".repeat(40);

async function fixture(allowManifestlessOriginals = true) {
    const capability = await createCmsLegalCapability({ ...syntheticLegalConfig(),
        allowManifestlessOriginals });
    const files = new Map();
    const calls = [];
    const github = { async readFileAtCommit(path, commit, options) {
        calls.push({ path, commit, options });
        return files.get(path) ?? null;
    } };
    return { capability, files, calls,
        verifier: createCmsPublicLegalVerifier({ capability, github }) };
}

test("manifestless approved originals require explicit host permission", async () => {
    const allowed = await fixture(true);
    assert.deepEqual(await allowed.verifier.readAtCommit(COMMIT),
        allowed.capability.initialPairs());
    const strict = await fixture(false);
    await assert.rejects(strict.verifier.readAtCommit(COMMIT),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
    const originals = allowed.capability.initialPairs();
    allowed.files.set(allowed.capability.renderedPath, Buffer.from(JSON.stringify({
        privacy: { sourceTitle: originals.privacy.document.sourceTitle,
            blocks: originals.privacy.document.blocks },
    })));
    allowed.files.set(allowed.capability.requirePage("privacy").pdfPath,
        allowed.capability.originalBytes("privacy", "pdf"));
    assert.deepEqual(await allowed.verifier.readAtCommit(COMMIT), originals);
    allowed.files.delete(allowed.capability.requirePage("privacy").pdfPath);
    await assert.rejects(allowed.verifier.readAtCommit(COMMIT),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
});

test("exact manifest, rendered blocks, changed source, and PDF hashes prove PUBLIC pair", async () => {
    const f = await fixture();
    const source = syntheticDocx("Privacy Policy", "Published wording.");
    const pdfBytes = syntheticPdf("Privacy Policy Published wording.");
    const parsed = parseLegalDocx(source, { sourceTitles: ["Privacy Policy"] });
    const document = { ...parsed, hash: legalHash(source), name: "published.docx" };
    const pdf = { hash: legalHash(pdfBytes), name: "published.pdf" };
    const legal = { privacy: { document, pdf,
        verification: { status: "matches", explanation: "The document and PDF text match." },
        confirmation: null } };
    f.files.set(f.capability.manifestPath, Buffer.from(JSON.stringify(legal)));
    f.files.set(f.capability.renderedPath, Buffer.from(JSON.stringify({
        privacy: { sourceTitle: parsed.sourceTitle, blocks: parsed.blocks },
    })));
    f.files.set(f.capability.sourcePath("privacy", document), source);
    f.files.set(f.capability.requirePage("privacy").pdfPath, pdfBytes);
    assert.deepEqual(await f.verifier.readAtCommit(COMMIT), legal);
    assert.ok(f.calls.every(({ commit }) => commit === COMMIT));
    assert.deepEqual(new Set(f.calls.map(({ path }) => path)), new Set([
        f.capability.manifestPath, f.capability.renderedPath,
        f.capability.sourcePath("privacy", document),
        f.capability.requirePage("privacy").pdfPath,
    ]));
    f.files.set(f.capability.renderedPath, Buffer.from(JSON.stringify({
        privacy: { sourceTitle: "changed", blocks: parsed.blocks },
    })));
    await assert.rejects(f.verifier.readAtCommit(COMMIT),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
    f.files.set(f.capability.renderedPath, Buffer.from(JSON.stringify({
        privacy: { sourceTitle: parsed.sourceTitle, blocks: parsed.blocks },
    })));
    f.files.set(f.capability.sourcePath("privacy", document), Buffer.from("changed"));
    await assert.rejects(f.verifier.readAtCommit(COMMIT),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
});

test("wrong commit and unavailable exact files fail without a state write", async () => {
    const f = await fixture();
    await assert.rejects(f.verifier.readAtCommit("not-a-sha"),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
    f.files.set(f.capability.manifestPath, Buffer.from("{broken"));
    await assert.rejects(f.verifier.readAtCommit(COMMIT),
        { code: "PUBLIC_LEGAL_PAIR_INVALID" });
});
