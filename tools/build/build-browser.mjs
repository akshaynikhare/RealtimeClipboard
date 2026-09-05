#!/usr/bin/env node
/**
 * Assembles the browser extension.
 *
 *   node tools/build/build-browser.mjs [outdir]   default browser/dist
 *   node tools/build/build-browser.mjs --zip      also produce the upload zip
 *
 * A browser extension may not import outside its own directory, so unlike the
 * VS Code extension — whose host is Node and can read src/ off disk — this one
 * has no no-build dev loop. Load `browser/dist/pkg/` as an unpacked extension.
 *
 * Separate from build.mjs for the same reason build-vscode.mjs is: that script
 * assembles a SITE, and this is not part of one.
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ZIP = process.argv.includes("--zip");
const OUT = resolve(ROOT, process.argv.slice(2).find(a => !a.startsWith("--")) ?? "browser/dist");
const PKG = join(OUT, "pkg");

const die = (m) => { console.error(`::error::${m}`); process.exit(1); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(PKG, "src"), { recursive: true });

// ESM: an MV3 service worker is declared "type": "module", and the popup is a
// module script. No splitting — two independent entry points that must each be
// a single file, because a chunk is another thing the manifest would have to
// name and a reviewer would have to read.
await build({
  entryPoints: [join(ROOT, "browser/src/worker.js"), join(ROOT, "browser/src/popup.js"),
                join(ROOT, "browser/src/offscreen.js")],
  outdir: join(PKG, "src"),
  bundle: true, format: "esm", splitting: false, platform: "browser",
  target: "chrome114", minify: true, sourcemap: true, logLevel: "error",
});

for (const f of ["src/popup.html", "src/popup.css", "src/offscreen.html", "manifest.json"]) {
  cpSync(join(ROOT, "browser", f), join(PKG, f));
}
copyFileSync(join(ROOT, "browser/icon.png"), join(PKG, "icon.png"));

/* -------------------------------------------------------------- asserts -- */

const manifest = JSON.parse(readFileSync(join(PKG, "manifest.json"), "utf8"));
const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (manifest.version !== root.version) {
  die(`browser/manifest.json is ${manifest.version}, package.json is ${root.version}`);
}

/* The store rejects a permission the code never uses, and a reviewer asks about
   one they cannot see a reason for. Both are cheaper to catch here.

   Note the shape: every permission must be in this table, and an unlisted one is
   a failure rather than a skip. The first version only checked the four it
   already knew about, so adding a fifth — the actual thing that goes wrong —
   passed silently. A permission you have to justify to this file is a permission
   you have thought about. */
const USES = {
  storage: /chrome\.storage/,
  clipboardRead: /execCommand\(["']paste/,
  clipboardWrite: /execCommand\(["']copy/,
  offscreen: /chrome\.offscreen/,
};
const code = ["worker", "popup", "offscreen"]
  .map(n => readFileSync(join(PKG, `src/${n}.js`), "utf8")).join("\n");
for (const p of manifest.permissions) {
  if (!(p in USES)) {
    die(`manifest asks for "${p}", which tools/build/build-browser.mjs does not know about. `
      + `Add it to USES with the pattern that proves it is used, or drop it.`);
  }
  if (!USES[p].test(code)) die(`manifest asks for "${p}" and nothing in the bundle uses it`);
}

// The CSP names the relay; config.js is the one place that decides it.
const relay = readFileSync(join(ROOT, "src/core/config.js"), "utf8")
  .match(/DEFAULT_RELAY_URL\s*=\s*"([^"]+)"/)?.[1];
if (relay && !manifest.content_security_policy.extension_pages.includes(relay.replace(/^wss/, "wss"))) {
  die(`the manifest CSP does not name ${relay} — connect-src and config.js must agree`);
}

const bytes = ["worker", "popup", "offscreen"]
  .reduce((n, f) => n + readFileSync(join(PKG, `src/${f}.js`)).length, 0);
console.log(`\n  browser bundle  ${(bytes / 1024).toFixed(1)} KB   (${manifest.name} ${manifest.version})`);
console.log(`  staged at       ${PKG}\n`);

if (ZIP) {
  const zip = join(OUT, `realtimeclipboard-browser-${manifest.version}.zip`);
  execFileSync("zip", ["-qr", zip, "."], { cwd: PKG });
  console.log(`  packaged        ${zip}\n`);
}
