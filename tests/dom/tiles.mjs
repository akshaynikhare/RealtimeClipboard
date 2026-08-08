/**
 * The files grid must not rebuild itself on a progress tick.
 *
 * registry.setProgress() emits FILES_CHANGED alongside FILE_PROGRESS, and
 * filesPanel.render() was subscribed straight to FILES_CHANGED — so a 5 MB
 * transfer, chunked at 32 KB and deduped to whole percents, replaced the
 * innerHTML of #grid up to 101 times. Every tile in the pane was destroyed and
 * recreated each time, including the one the user was watching.
 *
 * Nothing caught it. The markup was correct after every rebuild, so every
 * assertion about what the grid CONTAINS still passed. What broke was what the
 * grid KEPT: keyboard focus on a tile, the :hover that reveals the remove
 * button, and `transition:width .2s` on .bar — a fresh element has no previous
 * width to animate from, so the progress bar had never once animated.
 *
 * This test therefore asserts on node IDENTITY, not on markup: the same tile
 * element object must survive a progress change, and must not survive a change
 * that genuinely alters the markup.
 *
 * Usage: node tests/dom/tiles.mjs
 */

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // Matches tests/live/boot.mjs: jsdom is a devDependency, and the app itself ships
  // with no npm install at all. Skip rather than fail so this runs anywhere.
  console.log("\nSKIP: tiles test needs jsdom  (npm i -D jsdom)\n");
  process.exit(0);
}

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = p => import(pathToFileURL(join(REPO, p)).href);

let pass = 0, fail = 0;
const ok = (name, good, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/* ---------- a DOM, with no network anywhere near it ---------- */

const dom = new JSDOM(readFileSync(join(REPO, "app.html"), "utf8"), {
  url: "https://realtimeclipboard.com/app.html#TILETEST",
  pretendToBeVisual: true,
});
const { window } = dom;

// navigator is getter-only in Node 24, so globals need defineProperty.
const put = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

global.window = window;
global.document = window.document;
global.location = window.location;
put("navigator", window.navigator);
global.localStorage = window.localStorage;
global.sessionStorage = window.sessionStorage;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.CustomEvent = window.CustomEvent;
put("crypto", globalThis.crypto);
// tickProgress() builds an attribute selector with it, as tickCountdowns() does.
global.CSS = window.CSS?.escape ? window.CSS : { escape: s => String(s).replace(/["\\]/g, "\\$&") };

const registry   = await load("src/files/registry.js");
const filesPanel = await load("src/ui/panels/filesPanel.js");
const modal      = await load("src/ui/primitives/modal.js");
const S = registry.STATE;

console.log("\nFiles grid — progress must not rebuild\n");

filesPanel.init();

const grid = document.getElementById("grid");
const tileOf = id => grid.querySelector(`.tile[data-id="${id}"]`);

/* ---------- two files, so a rebuild is visible ---------- */

await registry.add(
  [new File([new Uint8Array(2048)], "trace.log", { type: "text/plain" }),
   new File([new Uint8Array(4096)], "shot.png",  { type: "image/png" })],
  { makeThumbs: false });

const items = registry.all();
ok("two files are in the registry", items.length === 2, String(items.length));

const [a, b] = items;
ok("both tiles rendered", Boolean(tileOf(a.id) && tileOf(b.id)),
   `${grid.querySelectorAll(".tile").length} tiles`);

/* ---------- a state change SHOULD rebuild ---------- */

const beforeState = tileOf(a.id);
registry.setState(a.id, S.SENDING);
ok("a state change rebuilds the tile", tileOf(a.id) !== beforeState,
   "markup genuinely differs, so the grid is redrawn");

/* ---------- a progress change MUST NOT ---------- */

const tileA = tileOf(a.id);
const tileB = tileOf(b.id);
tileA.focus();
ok("a tile can hold focus", document.activeElement === tileA,
   'role="button" tabindex="0"');

registry.setProgress(a.id, 10);
registry.setProgress(a.id, 40);
registry.setProgress(a.id, 41);

ok("THE REGRESSION: the moving tile survives its own progress",
   tileOf(a.id) === tileA,
   tileOf(a.id) === tileA ? "same element object" : "tile was destroyed and rebuilt");
ok("...and so does every other tile in the pane", tileOf(b.id) === tileB);
ok("...and focus is still on it", document.activeElement === tileA,
   document.activeElement === tileA ? "" : "focus was dropped mid-transfer");

/* ---------- ...while still actually showing the progress ---------- */

ok("the bar width tracks progress", tileA.querySelector(".bar").style.width === "41%",
   tileA.querySelector(".bar").style.width);
ok("the badge tracks progress", tileA.querySelector(".badge").textContent === "41%",
   tileA.querySelector(".badge").textContent);
ok("the subtitle tracks progress", tileA.querySelector(".sz").textContent === "sending 41%",
   tileA.querySelector(".sz").textContent);

/* ---------- an error message is not overwritten by a tick ---------- */

registry.fail(b.id, "the peer went away");
const errTile = tileOf(b.id);
ok("a failed tile shows why", errTile.querySelector(".sz").textContent === "the peer went away",
   errTile.querySelector(".sz").textContent);

registry.setProgress(a.id, 42);
ok("a tick on another file leaves that message alone",
   tileOf(b.id).querySelector(".sz").textContent === "the peer went away",
   tileOf(b.id).querySelector(".sz").textContent);

/* ---------- removal still redraws ---------- */

registry.remove(a.id, { announce: false });
ok("removing a file drops its tile", tileOf(a.id) === null,
   `${grid.querySelectorAll(".tile").length} tiles left`);

/* ---------- click: images and PDFs preview, the rest saves ---------- */

await registry.add(
  [new File([new Uint8Array(64)], "pic.png",    { type: "image/png" }),
   new File([new Uint8Array(64)], "report.pdf", { type: "application/pdf" }),
   new File([new Uint8Array(64)], "notes.txt",  { type: "text/plain" })],
  { makeThumbs: false });

const [pic, pdf, txt] = registry.all().slice(-3);
const click = el =>
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const escape = () =>
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));

click(tileOf(pic.id));
const overlay = document.querySelector(".preview");
ok("clicking an image opens the preview", Boolean(overlay?.querySelector(".preview-img")),
   "not a download");
ok("...with a download button in it", Boolean(overlay?.querySelector("[data-save]")));
ok("...and the click alone saved nothing", !pic.url);

click(overlay.querySelector("[data-save]"));
ok("the preview's download button saves the file", Boolean(pic.url));

escape();
ok("Escape closes the preview", document.querySelector(".preview") === null);

click(tileOf(pdf.id));
ok("clicking a PDF frames the browser's own viewer",
   Boolean(document.querySelector(".preview .preview-doc")));
modal.close();

click(tileOf(txt.id));
ok("any other type downloads directly",
   Boolean(txt.url) && !document.querySelector(".preview"),
   "no overlay for a .txt");

console.log(`\n${"=".repeat(58)}`);
console.log(`TILES: ${pass}/${pass + fail} passed`);
console.log(`${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
