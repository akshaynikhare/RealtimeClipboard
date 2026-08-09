/**
 * The editor streams and commits, and those are two different things.
 *
 * Typing is broadcast so the far editor updates live; a CLIP is made only when
 * the text settles. Everything expensive hangs off the commit — history, the
 * receiving machine's OS clipboard, the dedupe, the size cap — so if a
 * keystroke ever reaches the commit path, every device in the session gets a
 * history entry and a clipboard write per character.
 *
 * That failure is invisible in a browser: the text still syncs, and it syncs
 * *better*, because the far editor is more responsive. What breaks is somewhere
 * else entirely — a history pane filling with `h`, `he`, `hel`, and somebody
 * else's clipboard being rewritten sixty times while you type a sentence. So
 * the assertions below are about which channel fired, not about what the far
 * editor ends up showing.
 *
 * The other half is the collision rule. Two people typing at once cannot be
 * made lossless without a CRDT, so the editor does not pretend: your own typing
 * always wins locally, and a peer's stream is DROPPED rather than queued while
 * you are mid-sentence. A regression there deletes work with no undo.
 *
 * Usage: node tests/dom/editor.mjs
 */

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("\nSKIP: editor test needs jsdom  (npm i -D jsdom)\n");
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
  url: "https://realtimeclipboard.com/app.html#EDITTEST",
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

const { EV, on, emit } = await load("src/core/bus.js");
const { SYNC_MODES, TEXT } = await load("src/core/config.js");
const state = await load("src/core/state.js");
const editor = await load("src/ui/panels/editor.js");

const ta = window.document.getElementById("editor");
const gutter = window.document.getElementById("gutter");

/* Record both channels separately. Which one fired IS the assertion. */
const streams = [], commits = [];
on(EV.TEXT_TYPED, f => streams.push(f));
on(EV.TEXT_CAPTURED, f => commits.push(f));

const type = text => {
  ta.value = text;
  ta.selectionStart = text.length;
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const settle = ms => new Promise(r => setTimeout(r, ms));
const reset = () => { streams.length = 0; commits.length = 0; };

state.get().settings.syncMode = SYNC_MODES.LIVE;
editor.init();

/* ------------------------------------------------------------- streaming */
console.log("\nTyping streams, and only streams\n");

reset();
type("h");
await settle(TEXT.STREAM_THROTTLE_MS + 40);
ok("a keystroke goes out as a stream", streams.length === 1, JSON.stringify(streams[0]?.text));
ok("THE SPLIT: a keystroke is not a clip", commits.length === 0,
   "a commit per keystroke means a history entry and a clipboard write per keystroke");
ok("the stream carries the caret", streams[0]?.caret === 1);

reset();
for (const s of ["he", "hel", "hell", "hello"]) type(s);
await settle(TEXT.STREAM_THROTTLE_MS + 40);
ok("four keystrokes inside one window coalesce", streams.length === 1,
   `${streams.length} frame(s) for 4 keystrokes`);
ok("...and it is the LAST one that goes", streams[0]?.text === "hello",
   "an intermediate frame would render text the user has already moved past");
ok("...and still no clip", commits.length === 0);

/* -------------------------------------------------------------- committing */
console.log("\nIt becomes a clip when it settles\n");

reset();
type("hello world");
await settle(TEXT.COMMIT_IDLE_MS + 250);
ok("THE BOUNDARY: going quiet makes a clip", commits.length === 1, commits[0]?.text);
ok("...exactly one, not one per keystroke", commits.length === 1);
ok("...marked as the editor's own", commits[0]?.source === "editor",
   "or main.js would setText() the trimmed value back under the caret");

reset();
await settle(TEXT.COMMIT_IDLE_MS + 250);
ok("settling again re-sends nothing", commits.length === 0, "deduped on lastSent");

reset();
type("blurred text");
ta.dispatchEvent(new window.Event("blur", { bubbles: true }));
await settle(60);
ok("blur commits without waiting for the timer", commits.length === 1, commits[0]?.text,
   "a backgrounded tab may throttle the idle timer indefinitely");

/* ------------------------------------------------------------------- Off */
console.log("\nOff means nothing leaves\n");

state.get().settings.syncMode = SYNC_MODES.OFF;
reset();
type("secret on a work machine");
await settle(TEXT.STREAM_THROTTLE_MS + 40);
ok("THE PROMISE: no stream leaves an Off device", streams.length === 0);
state.get().settings.syncMode = SYNC_MODES.LIVE;

/* --------------------------------------------------------- the size bound */
console.log("\nBig text stops streaming rather than flooding the relay\n");

reset();
type("x".repeat(TEXT.STREAM_MAX_BYTES + 1));
await settle(TEXT.STREAM_THROTTLE_MS + 40);
ok("THE RELAY GUARD: over the cap, nothing streams", streams.length === 0,
   "a whole-text frame per keystroke at this size is ~200 KB/s from one typist");
await settle(TEXT.COMMIT_IDLE_MS + 250);
ok("...but it still commits, so the text does arrive", commits.length === 1,
   `${commits[0]?.text.length.toLocaleString()} chars`);

/* ------------------------------------------------------- the collision rule */
console.log("\nA peer's typing never eats yours\n");

const peerStream = (text, caret, from = "peer-1") =>
  emit(EV.TEXT_STREAMED, { text, caret, name: "Chrome · Windows", from });

editor.setText("");
reset();
peerStream("from the other laptop", 5);
ok("an idle editor takes the peer's text", ta.value === "from the other laptop");
ok("...and does not echo it back", streams.length === 0,
   "echoing a received stream is an infinite loop between two editors");

type("I am halfway through a sen");
peerStream("something completely different", 3);
ok("THE REGRESSION: a peer's stream is dropped while you type",
   ta.value === "I am halfway through a sen",
   "this is work with no undo behind it");

emit(EV.TEXT_RECEIVED, { text: "a whole committed clip" });
ok("a peer's COMMIT does not write the editor from here either",
   ta.value === "I am halfway through a sen",
   "apply-or-offer is main.js's decision; a listener here made it moot");

// isDirty() is false for an editor holding only a space, so the peer's stream
// IS applied here — and the idle timer armed by that space was still running.
// It then fired on the peer's half-typed line and committed it as a clip
// authored on this machine: into history everywhere, onto OS clipboards, and
// back at the person still typing it.
editor.setText("");
reset();
type(" ");
ok("a lone space arms a commit without making the editor dirty",
   !editor.isDirty(), "trim() is empty, so an arriving stream is allowed to land");

peerStream("they are still typing thi", 24);
ok("...so the peer's stream is applied", ta.value === "they are still typing thi");

await settle(TEXT.COMMIT_IDLE_MS + 250);
ok("THE CROSSOVER: the peer's stream is never committed as our clip",
   commits.length === 0,
   "a view channel reaching the commit path is history and clipboards on every device");

/* --------------------------------------------------------- the peer caret */
console.log("\nYou can see them coming\n");

const tinted = () => [...gutter.children].filter(el => el.classList.contains("peer"));
editor.setText("one\ntwo\nthree\nfour");
peerStream("one\ntwo\nthree\nfour", "one\ntwo\nthr".length, "peer-1");

ok("the peer's line is tinted in the gutter", tinted().length === 1,
   `line ${[...gutter.children].findIndex(el => el.classList.contains("peer")) + 1}`);
ok("...on the line their caret is actually on",
   gutter.children[2]?.classList.contains("peer"), "caret sits in line 3");
ok("...in a palette colour, not a hex",
   /\bc[0-4]\b/.test(tinted()[0]?.className ?? ""), tinted()[0]?.className);

const chip = window.document.getElementById("edTyping");
ok("and they are named", !chip.hidden && /Chrome · Windows is typing/.test(chip.textContent),
   chip.textContent);

peerStream("one\ntwo\nthree\nfour", 0, "peer-2");
ok("two peers get two colours",
   new Set([...gutter.querySelectorAll(".peer")].map(el => el.className)).size === 2);

console.log(`\n${"=".repeat(58)}`);
console.log(`EDITOR: ${pass}/${pass + fail} passed`);
console.log(`${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
