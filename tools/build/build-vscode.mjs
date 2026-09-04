#!/usr/bin/env node
/**
 * Assembles the VS Code extension package.
 *
 *   node tools/build/build-vscode.mjs [outdir]   default vscode/dist
 *   node tools/build/build-vscode.mjs --package  also run `npx vsce package`
 *
 * Separate from build.mjs by the same logic that keeps build-icons.py separate:
 * that script assembles a SITE, and the extension is not part of one. It also
 * keeps the extension entry out of build.mjs's "every <script src> is an entry
 * point" rule, which does not apply to something no HTML page loads.
 *
 * The package root is staged in a throwaway directory, so no .vscodeignore is
 * needed and vscode/ on disk is never written to — the same design as build.mjs
 * never writing back into src/.
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE = process.argv.includes("--package");
const OUT = resolve(ROOT, process.argv.slice(2).find(a => !a.startsWith("--")) ?? "vscode/dist");
const PKG_ROOT = join(OUT, "pkg");

const die = (msg) => { console.error(`::error::${msg}`); process.exit(1); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(PKG_ROOT, { recursive: true });

/* ------------------------------------------------------------- bundle ---- */

await build({
  entryPoints: [join(ROOT, "vscode/src/extension.js")],
  outfile: join(PKG_ROOT, "extension.js"),
  bundle: true,
  platform: "node",
  // CJS because the extension host require()s the entry. This is also why
  // splitting is false here where build.mjs marks it "NOT optional": splitting
  // is an ESM-only feature, and there is no payload budget to defend — a .vsix
  // is a local download, not a page load.
  format: "cjs",
  splitting: false,
  target: "node20",
  external: ["vscode"],
  minify: true,
  sourcemap: true,
  logLevel: "error",
});

/* ------------------------------------------------------------- manifest -- */

const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "vscode/package.json"), "utf8"));

if (manifest.version !== root.version) {
  die(`vscode/package.json is ${manifest.version}, package.json is ${root.version}`);
}

// On disk `main` points at the source tree so F5 needs no build. The shipped
// copy points at the bundle. Rewriting the source form to match would silently
// break the dev loop — see vscode/CLAUDE.md.
manifest.main = "./extension.js";
delete manifest.scripts;
delete manifest.devDependencies;
writeFileSync(join(PKG_ROOT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

for (const [from, to] of [
  ["LICENSE", "LICENSE"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["vscode/README.md", "README.md"],
  ["vscode/icon.png", "icon.png"],
]) copyFileSync(join(ROOT, from), join(PKG_ROOT, to));

/* -------------------------------------------------------------- asserts -- */

const bundle = readFileSync(join(PKG_ROOT, "extension.js"), "utf8");

// That the surface is declared AT ALL is checkable here; that it is declared
// EARLY ENOUGH is not. esbuild hoists every CJS module factory to the top of the
// bundle, so position in the file says nothing about execution order — the
// ordering seam is proven by running the bundle in tests/dom/extension.mjs,
// which is the only place it can be proven.
if (!bundle.includes("__REALTIMECLIPBOARD_SURFACE__")) {
  die("the bundle never declares __REALTIMECLIPBOARD_SURFACE__");
}

// A stray require of anything native would fail on a user's machine only.
const requires = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1])
  .filter(m => !m.startsWith(".") && m !== "vscode");
if (requires.length) die(`the bundle requires modules it cannot ship: ${[...new Set(requires)].join(", ")}`);

const kb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
console.log(`\n  extension bundle  ${kb} KB   (${manifest.name} ${manifest.version})`);
console.log(`  staged at         ${PKG_ROOT}\n`);

if (PACKAGE) {
  execFileSync("npx", ["--yes", "@vscode/vsce", "package", "--out", join(OUT, `${manifest.name}-${manifest.version}.vsix`)],
    { cwd: PKG_ROOT, stdio: "inherit" });
}
