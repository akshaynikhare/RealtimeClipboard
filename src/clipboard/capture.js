/**
 * Capture tiers — the heart of the sending half. See docs/CLIPBOARD-FLOW.md.
 *
 *   T0  native clipboard watch  desktop app only — the OS tells us
 *   T1  paste event             always works, no permission
 *   T2  read on focus           needs clipboard-read
 *   T3  poll while focused      needs clipboard-read
 *   T4  background capture      IMPOSSIBLE for a web app, permanently
 *
 * There is no clipboard-change event on the web platform, so in a browser
 * "capture" means "look at the moments we are allowed to look".
 *
 * T0 is the exception and the entire reason the desktop app exists: inside the
 * Tauri shell a native listener reports every change whether or not this window
 * is focused. T4 stays impossible; T0 is not T4, because the code doing the
 * watching is not the web page.
 *
 * !! T0 makes the loop-suppression ordering in writeNow() far more dangerous.
 * T3 only polled while focused, so a mistake was bounded by the user looking at
 * the window; T0 sees every clipboard change on the machine, forever. See
 * clipboard/CLAUDE.md and docs/CLIPBOARD-FLOW.md §6. !!
 */

import { POLL_OPTIONS, TEXT, bindsClipboard, IMAGES } from "../core/config.js";
import { emit, EV } from "../core/bus.js";
import * as state from "../core/state.js";
import * as native from "../core/native.js";
import * as guard from "./guard.js";
import * as os from "./os.js";

let pollTimer = null;
let started = false;

/** No instanceof — jsdom's elements come from another realm. */
const editsText = (el) =>
  Boolean(el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable));

export function start() {
  if (started) return;
  started = true;

  // T1 — paste. The floor the product stands on, not an edge case, and the ONLY
  // path that still runs below the Clipboard rung: pasting here is the
  // deliberate act, and it is what lets images keep working on a rung that
  // never reads the clipboard by itself.
  document.addEventListener("paste", e => {
    const image = os.imageFromPaste(e);
    if (image) {
      e.preventDefault();               // don't also drop a filename into the editor
      captureImage(image, "Image pasted");
      return;
    }
    // A paste aimed at something editable is input to THAT control, not a
    // share. The editor commits it through its own idle/blur path — capturing
    // it here as well is what inserted every paste twice — and what goes into
    // the PIN field, or any other input, must never be broadcast at all.
    if (editsText(e.target)) return;
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (text) fromClipboard(text, "Captured by paste");
  });

  // T2 — focus and visibility. visibilitychange is the dominant path on Android,
  // where there is no window focus in the desktop sense.
  // Flush before reading: a queued incoming clip must land on the OS clipboard
  // before we look at it, or we would read the stale value and broadcast it back.
  window.addEventListener("focus", async () => { await flushPending(); tryRead(); });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    await flushPending();
    tryRead();
  });

  startNative();
  detectTier();
}

/**
 * T0 — the desktop shell's clipboard watcher.
 *
 * The native side owns the OS boundary and emits a `clipboard://text` event
 * with what it read. This adds no new path into the app: it lands in the same
 * capture() funnel as every other tier, so `main.js`, the editor, the history
 * and the transport are untouched. That is the boundary in
 * docs/ARCHITECTURE.md §3 doing its job — a whole new capture mechanism, on a
 * platform that did not exist before, and no UI file changes.
 *
 * Absent outside Tauri, so this is a no-op in a browser rather than a branch.
 */
function startNative() {
  if (!native.IS_DESKTOP) return;

  native.listen("clipboard://text", text => {
    // Mode is checked HERE as well as in the native side, deliberately. Off and
    // App both promise that nothing leaves this machine unless the user says
    // so, and that promise must not depend on a second process having got the
    // message. The cheap check is the one that is load-bearing.
    if (!bindsClipboard(state.get().settings.syncMode)) return;
    if (state.isSuppressed()) return;                // FR-2.6, and see the header
    if (typeof text === "string" && text) fromClipboard(text, "Copied anywhere");
  });

  state.setTier("T0", "watching the system clipboard");
}

export async function detectTier() {
  // The native watcher outranks anything the browser can offer, and unlike the
  // others it does not depend on a permission or on focus. Do not let the
  // browser's own detection downgrade the reported tier underneath it.
  if (native.IS_DESKTOP) return;
  if (!os.canRead()) return state.setTier("T1", "paste only");

  const apply = s => {
    emit(EV.PERMISSION, { state: s });
    if (s === "granted")      { state.setTier("T3", "auto-capture"); startPolling(); }
    else if (s === "prompt")  { state.setTier("T2", "click paste to allow"); }
    else if (s === "denied")  { state.setTier("T1", "paste only (blocked)"); }
    else                      { state.setTier("T2", "read on focus"); }
  };
  apply(await os.onPermissionChange(apply));
}

/**
 * Trigger Chrome's clipboard-read permission prompt. There is no API to request
 * it directly — the prompt only appears as a side effect of an actual read, so
 * this attempts one and lets detectTier() observe the result.
 */
export async function requestPermission() {
  await os.read();
  await detectTier();
}

/** T3 — only meaningful while the window is focused, and only on the top rung. */
export function startPolling() {
  clearInterval(pollTimer);
  if (!bindsClipboard(state.get().settings.syncMode)) return;
  const ms = POLL_OPTIONS[state.get().settings.poll] ?? 0;
  if (!ms) return;
  pollTimer = setInterval(() => {
    if (document.hasFocus()) tryRead({ deliberate: false });
  }, ms);
}

/**
 * Called when the mode changes so polling starts or stops immediately.
 *
 * Reading and writing the OS clipboard are both derived from the rung, and
 * neither has a switch of its own. They each used to: two controls governing
 * one behaviour is the kind of thing that produces a bug report saying the app
 * ignores its own setting. The Clipboard rung IS auto-read and auto-write.
 */
export function applyMode() {
  if (bindsClipboard(state.get().settings.syncMode)) startPolling();
  else {
    stopPolling();
    // A queued clip is a promised OS-clipboard write, and leaving the rung
    // withdraws the promise — flushing it later would touch a clipboard the
    // mode now says is off limits.
    discardPending();
  }
  emit(EV.SYNC_MODE, { mode: state.get().settings.syncMode });
}

export function stopPolling() { clearInterval(pollTimer); }

/**
 * `deliberate` says a gesture asked for this read — a focus, a paste, a
 * permission prompt. The poll tick is the one caller that passes false, and the
 * difference matters to the local-copy clock in fromClipboard().
 */
export async function tryRead({ deliberate = true } = {}) {
  const s = state.get();
  // Off and App: the OS clipboard is not watched at all. Nothing leaves this
  // machine unless the user pastes it in here.
  if (!bindsClipboard(s.settings.syncMode)) return;
  if (state.isSuppressed()) return;          // just applied a remote clip (FR-2.6)

  // An owed clip outranks reading. A queued unflagged clip past its hold is a
  // write the session has already accepted; reading now captures the value it
  // is about to replace and broadcasts THAT as the newest clip — so the tick
  // lands it instead of reading past it. A grace-held clip keeps capture
  // running (pausing would mute this machine's own copies for as long as the
  // hold lasts) and a flagged one may never be written at all; for both, the
  // lastSent dedupe keeps re-reading the same value harmless.
  if (pending !== null && !pendingRisk && !state.recentLocalCopy()) {
    return flushPending();
  }

  const text = await os.read();

  // Re-checked after the await: the read was permitted when it started, and a
  // rung the user dropped meanwhile promises this machine's clipboard is no
  // longer being watched. Clicking the mode control delivers focus first, so
  // the read in flight is a read started under the OLD rung.
  if (!bindsClipboard(state.get().settings.syncMode)) return;
  if (text) fromClipboard(text, "Captured on focus", { deliberate });

  // Images are checked on focus only, never on the poll tick: clipboard.read()
  // is markedly more expensive than readText() and would burn battery at 1 Hz
  // for a case that is rare per second and common per minute.
  if (s.settings.images) await tryReadImage();
}

let lastImageKey = "";

export async function tryReadImage() {
  const blob = await os.readImage();
  if (!blob) return;
  if (!bindsClipboard(state.get().settings.syncMode)) return;   // the rung dropped while we read
  // Size+type is a cheap stand-in for identity; hashing every screenshot on
  // every focus would cost more than it saves.
  const key = `${blob.type}:${blob.size}`;
  if (key === lastImageKey) return;
  lastImageKey = key;
  captureImage(blob, "Image captured");
}

/**
 * Images do not go through the text path. They are handed to the files layer
 * as a normal 5 MB-capped item, so a screenshot shares its thumbnail
 * immediately and the full image only moves when someone asks — see
 * docs/P2P-FILES.md. capture.js stays ignorant of files/: it announces.
 */
function captureImage(blob, how) {
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  emit(EV.IMAGE_CAPTURED, {
    blob,
    name: `${IMAGES.NAME_PREFIX}-${stamp}.${ext}`,
    how,
  });
}

/**
 * Text that came off THIS machine's clipboard, whichever tier found it.
 *
 * The mark is what gives a local copy precedence over an arriving clip for the
 * next few seconds (see apply()). Set before the dedupe, not after: copying the
 * same thing twice is still you reaching for it, even though there is nothing
 * new to send.
 *
 * That reasoning holds for a GESTURE and not for the poll tick, which re-reads
 * the same unchanged value every second. Marking there re-armed the window
 * before it could expire, so on the top rung an arriving clip queued forever
 * behind a copy the user made once — and the focus event that flushes the queue
 * never comes, because the window is already focused. A tick only counts as a
 * copy when what it found is genuinely new.
 */
function fromClipboard(text, how, { deliberate = true } = {}) {
  if (deliberate || (text ?? "").trim() !== state.get().lastSent.trim()) state.markLocalCopy();
  capture(text, how);
}

/**
 * Single funnel for every captured clip, whatever tier found it.
 *
 * The dedupe compares trimmed, matching the editor's commit(): the clipboard's
 * copy of a clip carries trailing whitespace the committed copy does not, and
 * comparing them raw sent every trailing-newline paste twice.
 */
export function capture(text, how) {
  const s = state.get();
  const t = (text ?? "").trim();
  if (!t || t === s.lastSent.trim()) return;   // FR-2.7 dedupe
  if (state.isSuppressed()) return;
  s.lastSent = text;
  emit(EV.TEXT_CAPTURED, { text, how });
}

/**
 * An incoming clip. Deferred for two reasons, queued into the same place so
 * there is one rule instead of two: writeText() requires focus, and a clip YOU
 * copied here seconds ago outranks one arriving now — without that, two devices
 * in use overwrite each other's clipboard and you reach for something you just
 * copied to find it replaced. Neither case drops the clip; it is held and
 * flushed by the same focus gesture the user already makes.
 */
export async function apply(raw) {
  if (!bindsClipboard(state.get().settings.syncMode)) return false;

  // Defused before anything else looks at it, so the queued copy, the write and
  // the banner preview are all the same string — the one that will be pasted.
  const text = guard.defuse(raw);
  if (!text) return false;

  // A clip that reads like a command waits for a click WHATEVER the focus state.
  // The risk is precisely that it lands without anyone deciding it should, and
  // focus is not a decision: it is what happens when you alt-tab back.
  const risk = guard.looksExecutable(text);

  if (risk || !document.hasFocus() || state.recentLocalCopy()) {
    pending = text;
    pendingRisk = risk;
    emit(EV.PENDING_CLIP, { pending: true, text, risk, altered: guard.wasAltered(raw) });
    if (!risk && document.hasFocus()) scheduleGraceFlush();
    return false;
  }
  return writeNow(text);
}

/**
 * A clip held only by the local-copy window has no gesture coming to release
 * it: the window is already focused, so the focus handler that flushes the
 * queue will never fire. Without this the banner's promise — "focus this window
 * and it lands automatically" — is false for the whole of the top rung.
 *
 * Not armed for a flagged clip. That one waits for a click, and a timer is not
 * one.
 */
let graceTimer = null;

function scheduleGraceFlush() {
  clearTimeout(graceTimer);
  const left = TEXT.LOCAL_COPY_GRACE_MS - (Date.now() - state.get().lastLocalCopyAt);
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (pending === null || pendingRisk) return;
    if (state.recentLocalCopy()) return scheduleGraceFlush();   // a fresher copy moved it
    if (!document.hasFocus()) return;                           // focus will flush it
    flushPending();
  }, Math.max(0, left) + 50);
}

/**
 * lastSent and the suppression window are set BEFORE writing, so our own poller
 * recognises the value it is about to see rather than bouncing it back to the
 * sender forever. Every path routes through here for that reason alone.
 *
 * A refused write takes the claim back: the clipboard still holds the OLD
 * value, and leaving the new one in lastSent makes the next read of that old
 * value look like a fresh copy — which then rebroadcasts stale content over
 * the very clip that failed to land.
 */
async function writeNow(text) {
  const s = state.get();
  const prev = s.lastSent;
  s.lastSent = text;
  state.suppress(TEXT.SUPPRESS_MS);
  const ok = await os.write(text);
  // Rolled back only if still ours: a write that succeeded while this one was
  // in flight has a truthful claim that must not be clobbered.
  if (!ok && s.lastSent === text) s.lastSent = prev;
  return ok;
}

/**
 * The user deliberately asking — restoring from history, or committing their
 * own typing. Not a clip from a peer, so it is not defused and bypasses the
 * local-copy grace window, which exists to stop a REMOTE clip taking away
 * something you just copied. Still gated on the rung.
 *
 * Also what makes a restore stick on the top rung: without it the poll tick a
 * second later reads the clipboard, finds whatever is actually there, and
 * broadcasts that instead, so the click appears to do nothing.
 *
 * Unfocused it queues rather than drops: a blur-commit is the alt-tab-away
 * flow, and by the time commit() runs the focus writeText() needs is already
 * gone. The next focus flushes it, the same gesture as every deferred write.
 */
export async function putOnClipboard(text) {
  if (!bindsClipboard(state.get().settings.syncMode)) return false;
  if (!text) return false;
  if (!document.hasFocus()) {
    pending = text;
    pendingRisk = null;                 // your own text needs no click
    emit(EV.PENDING_CLIP, { pending: true, text });
    return false;
  }
  state.markLocalCopy();
  return writeNow(text);
}

let pending = null;
let pendingRisk = null;

/**
 * Flush a clip that arrived while we were away, or while a local copy held it
 * off. Called by the focus and visibility handlers.
 *
 * A clip the guard flagged is deliberately NOT flushed here. Regaining focus is
 * not consent — it is what happens when you alt-tab back to the window, which is
 * exactly the moment a planted command would land without being read.
 */
export async function flushPending() {
  if (pending === null || pendingRisk) return;
  return writePending();
}

/** The user clicked the banner. The only path that writes a flagged clip. */
export async function confirmPending() {
  if (pending === null) return;
  return writePending();
}

/** The user declined it. Dropped, not deferred — offering twice is nagging. */
export function discardPending() {
  if (pending === null) return;
  clearTimeout(graceTimer);
  graceTimer = null;
  pending = null;
  pendingRisk = null;
  emit(EV.PENDING_CLIP, { pending: false });
}

async function writePending() {
  // Re-checked at the write, not only at the queue: the rung may have dropped
  // while the clip waited, and regaining focus is not permission to write to
  // a clipboard the current mode says is untouched.
  if (!bindsClipboard(state.get().settings.syncMode)) return discardPending();
  clearTimeout(graceTimer);
  graceTimer = null;
  const text = pending;
  const risk = pendingRisk;
  pending = null;
  pendingRisk = null;
  if (!await writeNow(text)) {
    // writeText() can refuse in the gap where the tab is visible but not yet
    // focused. The clip is still owed: requeue for the next gesture — the
    // banner stays up because nothing here said otherwise. Unless a newer clip
    // took the slot while this one was writing, in which case that clip is what
    // the banner is showing and this one has been superseded.
    if (pending === null) { pending = text; pendingRisk = risk; }
    return;
  }
  // Same reason the requeue above is conditional: retracting unconditionally
  // dismissed the banner belonging to a clip that arrived mid-write, and a
  // flagged clip whose banner is gone can never be confirmed or discarded,
  // because the banner is the only path to either.
  if (pending === null) emit(EV.PENDING_CLIP, { pending: false });
  emit(EV.TOAST, "Pending clip written to your clipboard");
}

export const hasPending = () => pending !== null;
