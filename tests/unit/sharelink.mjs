/**
 * The share link is a link SOMEBODY ELSE opens.
 *
 * It was built from `location.origin + location.pathname` on every surface, and
 * two of the three serve the app from a host that exists only inside their own
 * process: the desktop shell answers at `http://tauri.localhost` (Windows) or
 * `tauri://localhost`, and `cli/` has no `location` at all. So the installed
 * app's Copy link, its QR code and the tray's "Copy share link" all handed out
 * `http://tauri.localhost/app.html#KEY` — a URL that resolves on exactly one
 * machine, and therefore an app nobody could join. Nothing in the web build
 * could show it, because on the web the same expression is correct.
 *
 * `core/native.js` resolves SURFACE at MODULE EVALUATION, so each surface is a
 * process of its own. The parent is the CLI case by construction — node has no
 * `document` and no `location`.
 *
 * Usage: node tests/unit/sharelink.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = p => import(pathToFileURL(join(REPO, p)).href);

const KEY = "D75LVX9QRS";        // ten characters, throwaway — never a real key
const MODE = process.argv[2] ?? "";

let pass = 0, fail = 0;
const ok = (name, good, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/* Set BEFORE the first import that reaches core/, or the surface is already
   decided. A `document` is what tells native.js this is not node. */
if (MODE === "--as-desktop") {
  globalThis.__TAURI_INTERNALS__ = {};
  globalThis.document = {};
  globalThis.location = { origin: "http://tauri.localhost", pathname: "/app.html" };
} else if (MODE === "--as-web") {
  globalThis.document = {};
  globalThis.location = { origin: "https://realtimeclipboard.com", pathname: "/app" };
}

const keys = await load("src/core/keys.js");
const { SITE } = await load("src/core/config.js");

/* ------------------------------------------------------- the desktop shell */
if (MODE === "--as-desktop") {
  console.log("\nThe desktop shell\n");
  const link = keys.shareLink(KEY);

  ok("THE FIX: the link names a host another device can reach",
     link === `${SITE.APP_URL}#${KEY}`, link);
  ok("...not the webview's own origin", !/tauri/i.test(link),
     "http://tauri.localhost resolves on one machine and nowhere else");
  ok("a locked session keeps its sigil",
     keys.shareLink(KEY, true) === `${SITE.APP_URL}#!${KEY}`,
     "the marker travels; the PIN never does");

  process.exit(fail ? 1 : 0);
}

/* -------------------------------------------------------------- a browser */
if (MODE === "--as-web") {
  console.log("\nA browser\n");

  ok("the hosted app links to itself",
     keys.shareLink(KEY) === `https://realtimeclipboard.com/app#${KEY}`);

  // Read at call time, not import time — two windows on 127.0.0.1:8080 is the
  // dev loop this repo is organised around, and a self-hoster's deploy is the
  // same case.
  globalThis.location = { origin: "http://127.0.0.1:8080", pathname: "/app.html" };
  ok("a dev pair and a self-hosted deploy point at themselves",
     keys.shareLink(KEY) === `http://127.0.0.1:8080/app.html#${KEY}`,
     "hard-coding the public site here would break the no-build dev loop");

  process.exit(fail ? 1 : 0);
}

/* ------------------------------------------------------------------- CLI */
console.log("\nShare link\n\nThe CLI\n");

ok("no `location` and it does not throw", typeof keys.shareLink(KEY) === "string");
ok("...it hands out the public app", keys.shareLink(KEY) === `${SITE.APP_URL}#${KEY}`,
   keys.shareLink(KEY));
ok("the published path is the one the deploy serves", !SITE.APP_URL.includes(".html"),
   `${SITE.APP_URL} — /app.html only 308s onto it`);

/* --------------------------------------------------- the other two surfaces */
const SELF = fileURLToPath(import.meta.url);
for (const [name, flag] of [["desktop", "--as-desktop"], ["web", "--as-web"]]) {
  let good = true;
  try { execFileSync(process.execPath, [SELF, flag], { stdio: "inherit" }); }
  catch { good = false; }
  console.log("");
  ok(`the ${name} surface agrees`, good, "checked in its own process");
}

console.log("\n" + "=".repeat(58));
console.log(`SHARELINK: ${pass}/${pass + fail} passed`);
console.log("=".repeat(58) + "\n");
process.exit(fail ? 1 : 0);
