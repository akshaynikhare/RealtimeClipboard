/**
 * Panel 1 — the main editor. Line-number gutter, Ln/Col, char counter.
 *
 * Line numbers matter more than they look: what people paste here is stack
 * traces and JSON, and line numbers are what make a shared error discussable.
 *
 * STREAM vs COMMIT, the split this file exists to keep:
 *
 *   stream  — EV.TEXT_TYPED, throttled, view only. No history, no clipboard
 *             write, no dedupe, no size check. Superseded by the next one.
 *   commit  — EV.TEXT_CAPTURED, on idle or blur. THE clip: history records it,
 *             peers write it to their clipboard, the size cap applies.
 *
 * Stream everything and history fills with `h`, `he`, `hel` while every other
 * device's clipboard is rewritten per keystroke. Commit everything and the far
 * editor does not move until you stop typing. The split is not an optimisation.
 *
 * There is no Send button. It was the only enforcement of TEXT.MAX_BYTES in the
 * app's own UI, so that check moved into commit() rather than leaving with it.
 */

import { TEXT, textBytes, SYNC_MODES, sharesSession } from "../../core/config.js";
import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as os from "../../clipboard/os.js";
import * as capture from "../../clipboard/capture.js";
import { paletteIndex } from "../features/cursors.js";
import { $, on as bind, esc, setHTML, clear } from "../primitives/dom.js";

let ta, gutter;

/**
 * The gutter is `display:none` below this width (styles/mobile.css): 56px of
 * line numbers is a sixth of a 360px screen. Rendering it anyway would build a
 * <div> per line — 1,200 of them for a 50,000-character paste — for something
 * nobody can see, on the device least able to afford it.
 *
 * Must match the breakpoint in styles/mobile.css.
 */
const narrow = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(max-width:900px)")
  : { matches: false };

export function init() {
  ta = $("editor");
  gutter = $("gutter");

  // Widening the window past the breakpoint has to refill a gutter that was
  // left empty, and there is no input event coming to do it.
  if (narrow.addEventListener) narrow.addEventListener("change", () => refresh());
  else narrow.addListener?.(() => refresh());

  ["input", "click", "keyup", "select"].forEach(e => bind(ta, e, refresh));
  bind(ta, "input", onInput);
  bind(ta, "scroll", () => { gutter.scrollTop = ta.scrollTop; });

  // Blur commits, so switching window always lands what you typed rather than
  // leaving it stranded behind an idle timer that a backgrounded tab may throttle.
  bind(ta, "blur", () => commit());

  // The one explicit commit, and deliberately keyboard-only: it costs no UI, a
  // novice never needs to find it, and someone who wants the far device to have
  // it NOW should not have to wait out an idle timer.
  bind(ta, "keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });

  bind("aCopy",   "click", async () => {
    if (await os.write(ta.value)) {
      // Copying here is a local copy like any other: it earns the grace window
      // that stops an arriving clip taking it straight back off the clipboard.
      state.markLocalCopy();
      emit(EV.TOAST, "Copied to clipboard");
    }
  });
  bind("aPaste",  "click", async () => {
    const text = await os.read();
    if (text) { setText(text); capture.capture(text, "Pasted from clipboard"); }
    else emit(EV.TOAST, "Clipboard unreadable — use Ctrl/Cmd+V instead");
  });
  bind("tabX",    "click", () => { setText("", { echo: true }); emit(EV.TOAST, "Cleared"); });

  // A clip arriving from a peer fills the editor; the OS write is handled by
  // clipboard/capture.apply, which owns the loop-suppression ordering.
  on(EV.TEXT_RECEIVED, ({ text }) => setText(text));

  on(EV.TEXT_STREAMED, onStreamed);

  // The clipboard buttons are the bridge you need only when the app is not
  // acting as one. On the Clipboard rung it already is, and they are noise.
  on(EV.SYNC_MODE, ({ mode }) => paintTools(mode));
  paintTools(state.get().settings.syncMode);

  peerSweep = setInterval(sweepPeers, PEER_SWEEP_MS);

  refresh();
}

/**
 * `echo` decides whether peers hear about it.
 *
 * Off by default, which is what every caller filling the editor from OUTSIDE
 * wants — a clip that arrived, a history row, a commit coming back through
 * main.js. Echoing those would bounce the text straight back at the device it
 * came from. Clear is the one caller that means it: emptying the editor is an
 * edit, and the far window should empty too.
 */
export function setText(value, { echo = false } = {}) {
  ta.value = value;
  lastAppliedText = value;
  clearTimeout(idleTimer);
  if (echo) scheduleStream();
  else streamed = value;
  refresh();
}

export const getText = () => ta.value;

/**
 * Has the user typed something we have not sent or received?
 *
 * The editor used to be overwritten unconditionally by every incoming clip, so
 * if the other machine copied something while you were mid-sentence here, your
 * text simply vanished — no undo, no warning. With a live session on the far
 * side, that is not a rare race; it is a matter of time.
 */
let lastAppliedText = "";
export const isDirty = () => ta.value.trim() !== "" && ta.value !== lastAppliedText;

/* ------------------------------------------------------------------
   sending: stream while typing, commit when it settles
------------------------------------------------------------------- */

let idleTimer = 0;
let streamTimer = 0;
let streamedAt = 0;
let streamed = "";
let warnedOversize = false;

const nowMs = () =>
  (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

function onInput() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(commit, TEXT.COMMIT_IDLE_MS);
  scheduleStream();
}

/**
 * The throttle, in the shape cursors.js uses: never more than one pending
 * flush, and a timer for the remainder of the interval when we are not yet due.
 * The timer is the part that matters — without it, the last keystroke before a
 * pause would go undelivered and the far editor would sit one character behind
 * until the commit caught it up.
 */
function scheduleStream() {
  if (streamTimer) return;
  const wait = TEXT.STREAM_THROTTLE_MS - (nowMs() - streamedAt);
  streamTimer = setTimeout(() => { streamTimer = 0; flushStream(); }, Math.max(0, wait));
}

function flushStream() {
  const text = ta.value;
  if (text === streamed) return;
  if (!sharesSession(state.get().settings.syncMode)) return;
  // Above the cap the whole-text frame stops being affordable, so streaming
  // simply stops and the text syncs on commit. Silent because it is invisible:
  // text this size is pasted, not typed, and a paste commits immediately.
  if (textBytes(text) > TEXT.STREAM_MAX_BYTES) return;

  streamed = text;
  streamedAt = nowMs();
  emit(EV.TEXT_TYPED, { text, caret: ta.selectionStart });
}

/**
 * The text settled — turn it into a clip.
 *
 * The size check lives here because this is the app's own last word before the
 * relay's. It warns once per oversize episode rather than on every idle tick,
 * which at 800 ms would be a toast every 800 ms for as long as the text stayed
 * too big.
 */
function commit() {
  clearTimeout(idleTimer);
  idleTimer = 0;

  // Deduped on lastSent, the same guard capture() uses (FR-2.7) — but NOT
  // through capture() itself, which also drops anything inside the suppression
  // window. That window is there to stop the poller echoing our own clipboard
  // writes; a person typing is not an echo, and swallowing their edit because a
  // clip landed 1.5 s ago would be a keystroke vanishing for no visible reason.
  // Trimmed on both sides, because capture() stores what the clipboard held and
  // this compares what the editor sends.
  const s = state.get();
  const value = ta.value.trim();
  if (!value || value === s.lastSent.trim()) return;

  // Characters for the message, bytes for the decision — see config.js TEXT.
  // A CJK or emoji-heavy clip is inside the character count and still over the
  // wire limit, and saying "over the 24,000 character limit" to someone who
  // typed 9,000 characters is worse than not checking at all.
  if (textBytes(value) > TEXT.MAX_BYTES) {
    if (!warnedOversize) {
      warnedOversize = true;
      emit(EV.TOAST, value.length > TEXT.MAX_CHARS
        ? `Over the ${TEXT.MAX_CHARS.toLocaleString()} character limit — not shared`
        : `Over the ${Math.floor(TEXT.MAX_BYTES / 1024)} KB limit — `
          + `${value.length.toLocaleString()} characters, but non-Latin text is several bytes each`);
    }
    return;
  }
  warnedOversize = false;

  lastAppliedText = ta.value;
  s.lastSent = value;
  // `source` so main.js does not turn round and setText() the trimmed value
  // back into the textarea the user is still typing in, which would move their
  // caret out from under them.
  emit(EV.TEXT_CAPTURED, { text: value, how: "Typed here", source: "editor" });
}

/* ------------------------------------------------------------------
   receiving: a peer's typing, and where their caret is

   Never merged and never allowed to overwrite. Two people typing at once
   cannot be made lossless without a CRDT, so this does not pretend: while you
   are typing, an incoming stream is DROPPED rather than queued — stale
   keystrokes are worth nothing — and the peer's commit is offered by main.js
   instead of applied. What stops the collision in practice is seeing it coming,
   which is what the coloured gutter line and the typing chip are for.
------------------------------------------------------------------- */

/** id -> {line, name, tint, at}. One entry per peer currently typing. */
const peers = new Map();
const PEER_SWEEP_MS = 1_000;
const PEER_QUIET_MS = 5_000;
let peerSweep = 0;

function onStreamed({ text, caret, name, from }) {
  if (!from || typeof text !== "string") return;

  peers.set(from, {
    line: lineOf(text, caret),
    name: String(name ?? "").slice(0, 40) || "Another device",
    tint: paletteIndex(from),
    at: nowMs(),
  });
  paintTyping();

  // Your own typing always wins locally. Anything else is this module quietly
  // deleting work nobody can get back.
  if (isDirty()) return renderGutter();

  ta.value = text;
  lastAppliedText = text;
  streamed = text;
  refresh();
}

function lineOf(text, caret) {
  if (!Number.isFinite(caret)) return 0;
  return text.slice(0, Math.max(0, caret)).split("\n").length;
}

function sweepPeers() {
  if (!peers.size) return;
  const now = nowMs();
  let dropped = false;
  for (const [id, p] of peers) {
    if (now - p.at > PEER_QUIET_MS) { peers.delete(id); dropped = true; }
  }
  if (dropped) { paintTyping(); renderGutter(); }
}

function paintTyping() {
  const el = $("edTyping");
  if (!el) return;

  const names = [...peers.values()];
  el.hidden = !names.length;
  if (!names.length) return clear(el);

  setHTML(el, names.map(p =>
    `<span class="edtyper c${p.tint}">${esc(p.name)} is typing</span>`).join(""));
}

/* ------------------------------------------------------------------
   render
------------------------------------------------------------------- */

function refresh() {
  renderGutter();
  renderCounts();
}

/**
 * The tool row is mode-dependent: Copy-all and Paste-from-clipboard are the
 * hand-operated bridge between this window and the system clipboard, so they
 * are worth having exactly when the app is not being that bridge itself.
 */
function paintTools(mode) {
  const bridging = mode !== SYNC_MODES.LIVE;
  ["aCopy", "aPaste"].forEach(id => { const el = $(id); if (el) el.hidden = !bridging; });
}

function renderGutter() {
  if (narrow.matches) {
    if (gutter.firstChild) gutter.replaceChildren();
    return;
  }
  const lines = Math.max(ta.value.split("\n").length, 1);
  if (gutter.childElementCount !== lines) {
    setHTML(gutter, Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join(""));
  }
  const current = ta.value.slice(0, ta.selectionStart).split("\n").length;

  // A peer's caret line, in the same colour as their pointer. Cheaper than a
  // real inline caret by an order of magnitude — a <textarea> has no
  // per-character DOM, so a true caret means a mirror div and font metrics —
  // and "someone else is on line 4, in blue" is the signal that actually stops
  // two people colliding.
  const tints = new Map([...peers.values()].map(p => [p.line, p.tint]));

  [...gutter.children].forEach((el, i) => {
    const classes = [];
    if (i === current - 1) classes.push("cur");
    const tint = tints.get(i + 1);
    if (tint !== undefined) classes.push("peer", `c${tint}`);
    el.className = classes.join(" ");
  });
  gutter.scrollTop = ta.scrollTop;
}

function renderCounts() {
  const n = ta.value.length;
  const chars = $("sbChars");
  chars.textContent = `${n.toLocaleString()} / ${TEXT.MAX_CHARS.toLocaleString()}`;
  // The counter reads in characters, but "over" has to mean "will not send",
  // so it is decided on bytes. Encoding runs per keystroke and is measured in
  // microseconds even at the cap; the cheap `n` test short-circuits the
  // all-ASCII case, which is nearly all of them.
  chars.classList.toggle("over", n > TEXT.MAX_CHARS || textBytes(ta.value) > TEXT.MAX_BYTES);

  const upto = ta.value.slice(0, ta.selectionStart).split("\n");
  $("sbLnCol").textContent = `Ln ${upto.length}, Col ${upto.at(-1).length + 1}`;
}
