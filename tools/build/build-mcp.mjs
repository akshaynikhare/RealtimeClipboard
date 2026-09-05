#!/usr/bin/env node
/**
 * Assembles the MCP server package.
 *
 *   node tools/build/build-mcp.mjs [outdir]   default mcp/dist
 *
 * WHY THIS EXISTS AT ALL, when mcp/server.mjs runs perfectly well from a clone:
 * because it does not run from a TARBALL. Published, the server sits at
 * node_modules/realtimeclipboard-mcp/server.mjs, where `../cli/session.mjs`
 * resolves to node_modules/cli/session.mjs and `../package.json` to
 * node_modules/package.json — neither of which exists. The installed server
 * failed at module load, before it could answer a single request, and nothing
 * in the repo would have noticed because in the repo the paths are correct.
 *
 * Depending on `realtimeclipboard` and importing through it would fix the paths
 * and not the third problem: that package does not publish src/clipboard/, so
 * the guard an agent's safety depends on was not in any tarball.
 *
 * Bundling fixes all three, keeps ONE copy of the source, and leaves the
 * published package with no runtime dependency — the same property the rest of
 * this repository has, and the same shape as build-vscode.mjs.
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, process.argv.slice(2).find(a => !a.startsWith("--")) ?? "mcp/dist");
const PKG = join(OUT, "pkg");

const die = (m) => { console.error(`::error::${m}`); process.exit(1); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(PKG, { recursive: true });

const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "mcp/package.json"), "utf8"));
if (manifest.version !== root.version) {
  die(`mcp/package.json is ${manifest.version}, package.json is ${root.version}`);
}

await build({
  entryPoints: [join(ROOT, "mcp/server.mjs")],
  outfile: join(PKG, "server.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
  minify: false,                    // a server an agent runs should stay readable
  sourcemap: false,
  // The version is read from package.json at runtime in the repo, where the
  // relative path is right. In the bundle there is no parent to read, so it is
  // baked in — from the same source, so it still cannot drift.
  define: { "process.env.__RTC_VERSION__": JSON.stringify(root.version) },
  logLevel: "error",
});

// No dependencies, and no `files` needed: the staged directory IS the package.
const published = {
  ...manifest,
  bin: { "realtimeclipboard-mcp": "server.mjs" },
  main: "server.mjs",
  files: undefined,
  dependencies: undefined,
};
writeFileSync(join(PKG, "package.json"), `${JSON.stringify(published, null, 2)}\n`);

for (const [from, to] of [["mcp/README.md", "README.md"], ["mcp/server.json", "server.json"],
                          ["LICENSE", "LICENSE"]]) {
  copyFileSync(join(ROOT, from), join(PKG, to));
}

/* -------------------------------------------------------------- asserts -- */

const bundled = readFileSync(join(PKG, "server.mjs"), "utf8");

// An npm `bin` is executed directly, so it needs exactly one shebang and it
// needs it on line 1. esbuild carries the entry's own through, and adding a
// banner on top of it produced a second one on line 2 — which is a syntax error
// that only appears once the package is installed and run.
const shebangs = (bundled.match(/^#!.*$/gm) ?? []);
if (shebangs.length !== 1 || !bundled.startsWith("#!")) {
  die(`the bundle needs exactly one shebang, on line 1 — found ${shebangs.length}`);
}

// The failure this file exists to prevent, checked rather than assumed.
const escapes = [...bundled.matchAll(/from\s*["'](\.\.\/[^"']+)["']/g)].map(m => m[1]);
if (escapes.length) die(`the bundle still reaches outside itself: ${escapes.join(", ")}`);
if (/new URL\(["']\.\.\/package\.json/.test(bundled)) {
  die("the bundle still reads ../package.json, which is node_modules/package.json once installed");
}
if (!bundled.includes(root.version)) die("the version was not baked into the bundle");
// The guard is the whole safety story for this surface; a tree-shake that
// dropped it would be silent.
if (!/looksExecutable/.test(bundled)) die("guard.looksExecutable is missing from the bundle");

/* Static asserts caught none of the duplicate shebang, which was a syntax error
   that appeared only once the package was installed and run. So the last check
   is to actually run it: spawn the bundle and speak MCP at it. Roughly 300ms,
   and it is the difference between "the bytes look right" and "it starts". */
const smoke = spawnSync(process.execPath, [join(PKG, "server.mjs")], {
  input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
  encoding: "utf8", timeout: 20_000,
});
let answered = null;
try { answered = JSON.parse((smoke.stdout ?? "").split("\n")[0] ?? ""); } catch { /* below */ }
if (answered?.result?.serverInfo?.name !== "realtimeclipboard") {
  die(`the bundle does not start: ${(smoke.stderr || smoke.stdout || "no output").split("\n")[0]}`);
}
if (answered.result.serverInfo.version !== root.version) {
  die(`the running bundle reports ${answered.result.serverInfo.version}, expected ${root.version}`);
}

console.log(`\n  mcp bundle      ${(Buffer.byteLength(bundled) / 1024).toFixed(1)} KB   `
  + `(${published.name} ${published.version}, ${Object.keys(published.dependencies ?? {}).length} deps)`);
console.log(`  staged at       ${PKG}\n`);
