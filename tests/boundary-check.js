import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const prohibited = /righttrack|netlify\/identity|@netlify\/identity|(?:\.\.\/){3,}|(?:^|["'])\/?(?:src\/js|netlify\/functions)\//i;

async function check(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await check(path);
        else if (item.name.endsWith(".js")) {
            const source = await readFile(path, "utf8");
            assert.doesNotMatch(source, prohibited, `Host reference in ${path}`);
        }
    }
}

await check(root);

const clientRoot = fileURLToPath(new URL("../src/client/", import.meta.url));
async function checkBrowserOnly(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await checkBrowserOnly(path);
        else if (item.name.endsWith(".js")) {
            const source = await readFile(path, "utf8");
            assert.doesNotMatch(source,
                /(?:from\s*["'](?:node:|\.\.\/server)|\b(?:document|window|process)\s*\.|\b(?:NETLIFY_|GITHUB_))/,
                `Server, DOM, or credential dependency in ${path}`);
        }
    }
}
await checkBrowserOnly(clientRoot);
