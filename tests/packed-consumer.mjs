import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the packed consumer through npm run verify.");

function runNpm(args, cwd, extraEnvironment = {}) {
    const result = spawnSync(process.execPath, [npmCli, ...args], {
        cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, ...extraEnvironment, NODE_PATH: "" },
    });
    if (result.error || result.status !== 0) {
        throw new Error(`npm ${args[0]} failed in ${cwd}:\n${result.stderr}\n${result.stdout}`,
            { cause: result.error });
    }
    return result.stdout;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "cms-packed-consumer-"));
const packs = join(temporaryRoot, "packs");
const consumer = join(temporaryRoot, "consumer");
try {
    await mkdir(packs);
    await mkdir(consumer);
    const tarballs = [];
    for (const source of [packageRoot, ...["fflate", "pdfjs-dist", "yaml"]
        .map((name) => dirname(require.resolve(`${name}/package.json`)))]) {
        const packed = JSON.parse(runNpm(["pack", ".", "--offline", "--ignore-scripts", "--json",
            "--workspaces=false", "--pack-destination", packs], source));
        assert.equal(packed.length, 1);
        tarballs.push(join(packs, packed[0].filename));
    }

    await writeFile(join(consumer, "package.json"), JSON.stringify({
        name: "neutral-packed-cms-consumer", private: true, type: "module",
    }));
    const cache = join(temporaryRoot, "empty-npm-cache");
    runNpm(["install", "--offline", "--ignore-scripts", "--omit=optional",
        "--no-audit", "--no-fund", "--package-lock=false", "--workspaces=false",
        "--cache", cache, ...tarballs], consumer);

    const installed = await realpath(join(consumer, "node_modules", "@hugovela",
        "cms-host-netlify-github"));
    assert.ok(installed.startsWith(resolve(consumer, "node_modules") + "\\") ||
        installed.startsWith(resolve(consumer, "node_modules") + "/"));
    assert.notEqual(installed, await realpath(packageRoot));
    const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(installedManifest.exports).sort(), ["./client", "./server"]);
    assert.match(await readFile(join(installed, "HOST-SETUP.md"), "utf8"),
        /# Standalone CMS host setup/);

    const testRoot = join(consumer, "package-test");
    const testDirectory = join(testRoot, "tests");
    const exampleDirectory = join(testRoot, "examples", "neutral-site");
    await mkdir(testDirectory, { recursive: true });
    await mkdir(exampleDirectory, { recursive: true });
    await copyFile(join(packageRoot, "tests", "host-composition.test.js"),
        join(testDirectory, "host-composition.test.js"));
    await mkdir(join(testDirectory, "fixtures"));
    await copyFile(join(packageRoot, "tests", "fixtures", "packed-legal.mjs"),
        join(testDirectory, "fixtures", "packed-legal.mjs"));
    for (const name of ["composed-host.mjs", "composed-editor.mjs",
        "netlify-cms-function.mjs"]) {
        await copyFile(join(installed, "examples", "neutral-site", name),
            join(exampleDirectory, name));
    }
    const result = spawnSync(process.execPath,
        ["--test", join(testDirectory, "host-composition.test.js")], {
            cwd: consumer, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, CMS_PACKED_CONSUMER: "1", NODE_PATH: "" },
        });
    if (result.error || result.status !== 0) {
        throw new Error(`Packed consumer failed:\n${result.stderr}\n${result.stdout}`,
            { cause: result.error });
    }
    process.stdout.write(`Offline packed consumer passed from ${basename(consumer)}.\n`);
    process.stdout.write(result.stdout);
} finally {
    if (dirname(temporaryRoot) !== tmpdir() ||
        !basename(temporaryRoot).startsWith("cms-packed-consumer-")) {
        throw new Error("Refusing to remove an unexpected temporary directory.");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
}
