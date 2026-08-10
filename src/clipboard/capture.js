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
 * "capture" means "look at the moments we are allowed to look". T0 is the
 * exception and the reason the desktop app exists: a native listener inside the
 * Tauri shell reports every change, focused or not. That is not T4 — the code
 * doing the watching is not the web page.
 *
 * !! T0 makes the loop-suppression ordering in writeNow() far more dangerous.
 * T3 polled only while focused, so a mistake was bounded by the user looking at
 * the window; T0 sees every clipboard change on the machine, forever. !!
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

  // T1 — the only path that still runs below the Clipboard rung: pasting is the
  // deliberate act, and it keeps images working on a rung that never reads the
  // clipboard by itself.
  document.addEventListener("paste", e => {
    const image = os.imageFromPaste(e);
    if (image) {
      e.preventDefault();               // don't also drop a filename into the editor
      captureImage(image, "Image pasted");
      return;
    }
    if (editsText(e.target)) return;      // that control's input, not a share
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (text) fromClipboard(text, "Captured by paste");
  });

  // T2. visibilitychange is the dominant path on Android, which has no window
  // focus in the desktop sense. Flush before reading, or we read the stale value
  // the queued clip is about to replace and broadcast that back.
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
 * T0 — the desktop shell's clipboard watcher. The native side owns the OS
 * boundary and emits `clipboard://text`, which lands in the same capture()
 * funnel as every other tier: a whole new capture mechanism, no UI file changed.
 */
function startNative() {
  if (!native.IS_DESKTOP) return;

  native.listen("clipboard://text", text => {
    // Checked here as well as natively: "nothing leaves this machine" must not
    // depend on a second process having got the message.
    if (!bindsClipboard(state.get().settings.syncMode)) return;
    if (state.isSuppressed()) return;                // FR-2.6, and see the header
    if (typeof text === "string" && text) fromClipboard(text, "Copied anywhere");
  });

  state.setTier("T0", "watching the system clipboard");
}

export async function detectTier() {
  // The native watcher depends on no permission and no focus, so the browser's
  // own detection must not downgrade the reported tier underneath it.
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
 * There is no API to request clipboard-read directly — the prompt appears only
 * as a side effect of a read, so this attempts one and reads the result back.
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

/** Called when the mode changes so polling starts or stops immediately. */
export function applyMode() {
  if (bindsClipboard(state.get().settings.syncMode)) startPolling();
  else {
    stopPolling();
    // A queued clip is a promised write, and leaving the rung withdraws the
    // promise — flushing it later touches a clipboard now declared off limits.
    discardPending();
  }
  emit(EV.SYNC_MODE, { mode: state.get().settings.syncMode });
}

export function stopPolling() { clearInterval(pollTimer); }

/**
 * `deliberate` says a gesture asked for this read. The poll tick is the one
 * caller passing false, and the difference matters to the local-copy clock in
 * fromClipboard().
 */
export async function tryRead({ deliberate = true } = {}) {
  const s = state.get();
  if (!bindsClipboard(s.settings.syncMode)) return;
  if (state.isSuppressed()) return;          // just applied a remote clip (FR-2.6)

  // An owed clip outranks reading: a queued unflagged clip past its hold is a
  // write already accepted, and reading now captures the value it is about to
  // replace and broadcasts THAT as the newest clip. Grace-held and flagged clips
  // let capture keep running — pausing would mute this machine's own copies —
  // and the lastSent dedupe makes re-reading the same value harmless.
  if (pending !== null && !pendingRisk && !state.recentLocalCopy()) {
    return flushPending();
  }

  const text = await os.read();

  // Re-checked after the await: clicking the mode control delivers focus first,
  // so a read in flight is one started under the OLD rung.
  if (!bindsClipboard(state.get().settings.syncMode)) return;
  if (text) fromClipboard(text, "Captured on focus", { deliberate });

  // Focus only, never the poll tick: clipboard.read() is markedly more expensive
  // than readText() and would burn battery at 1 Hz for a case that is rare per
  // second and common per minute.
  if (s.settings.images) await tryReadImage();
}

let lastImageKey = "";

export async function tryReadImage() {
  const blob = await os.readImage();
  if (!blob) return;
  if (!bindsClipboard(state.get().settings.syncMode)) return;   // the rung dropped while we read
  // Cheap stand-in for identity; hashing every screenshot on every focus would
  // cost more than it saves.
  const key = `${blob.type}:${blob.size}`;
  if (key === lastImageKey) return;
  lastImageKey = key;
  captureImage(blob, "Image captured");
}

/**
 * Handed to the files layer as a normal 5 MB-capped item, so a screenshot shares
 * its thumbnail immediately and the bytes move only when asked for. This module
 * stays ignorant of files/: it announces.
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
 * Text off THIS machine's clipboard. The mark gives a local copy precedence over
 * an arriving clip for a few seconds, and is set before the dedupe: copying the
 * same thing twice is still you reaching for it.
 *
 * That holds for a gesture and not for the poll tick, which re-reads the same
 * value every second. Marking there re-armed the window before it could expire,
 * so an arriving clip queued forever behind one copy — and the focus event that
 * would flush it never comes, the window already being focused.
 */
function fromClipboard(text, how, { deliberate = true } = {}) {
  if (deliberate || (text ?? "").trim() !== state.get().lastSent.trim()) state.markLocalCopy();
  capture(text, how);
}

/**
 * The one funnel every tier ends in. The dedupe compares trimmed, matching the
 * editor's commit(): the clipboard's copy carries trailing whitespace the
 * committed copy does not, and comparing raw sent every such paste twice.
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
 * An incoming clip. Deferred for two reasons, queued in one place so there is
 * one rule: writeText() requires focus, and a clip YOU copied seconds ago
 * outranks one arriving now — without that, two devices in use overwrite each
 * other's clipboard. Neither case drops the clip.
 */
export async function apply(raw) {
  if (!bindsClipboard(state.get().settings.syncMode)) return false;

  // Defused first, so the queued copy, the write and the banner preview are all
  // the same string — the one that will be pasted.
  const text = guard.defuse(raw);
  if (!text) return false;

  // A clip that reads like a command waits for a click WHATEVER the focus state:
  // focus is not a decision, it is what happens when you alt-tab back.
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
 * A clip held only by the local-copy window has no gesture coming to release it:
 * the window is already focused, so the focus handler never fires and the
 * banner's "focus this window and it lands" is false for the whole top rung.
 * Never armed for a flagged clip — that waits for a click, and a timer is not one.
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
 * lastSent and the suppression window are set BEFORE the write, so our own
 * poller recognises the value rather than bouncing it back forever. Every path
 * routes through here for that alone.
 *
 * A refused write takes the claim back: the clipboard still holds the OLD value,
 * and leaving the new one in lastSent makes the next read look like a fresh copy
 * and rebroadcasts stale content over the clip that failed to land.
 */
async function writeNow(text) {
  const s = state.get();
  const prev = s.lastSent;
  s.lastSent = text;
  state.suppress(TEXT.SUPPRESS_MS);
  const ok = await os.write(text);
  // Only if still ours: a write that succeeded meanwhile has a truthful claim.
  if (!ok && s.lastSent === text) s.lastSent = prev;
  return ok;
}

/**
 * The user deliberately asking — restoring from history, or committing their own
 * typing. Not from a peer, so not defused, and it bypasses the local-copy grace
 * window, which exists against REMOTE writes.
 *
 * It is also what makes a restore stick on the top rung: without it the poll
 * tick a second later reads whatever is actually there and broadcasts that, so
 * the click appears to do nothing.
 */
export async function putOnClipboard(text) {
  if (!bindsClipboard(state.get().settings.syncMode)) return false;
  if (!text) return false;
  // A blur-commit runs after alt-tab has taken the focus writeText() needs, so
  // it queues rather than drops. The next focus flushes it.
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
 * A clip the guard flagged is deliberately NOT flushed here: regaining focus is
 * not consent, and it is exactly the moment a planted command would land
 * unread.
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
  // Re-checked at the write: the rung may have dropped while the clip waited,
  // and focus is not permission to touch a clipboard the mode says is untouched.
  if (!bindsClipboard(state.get().settings.syncMode)) return discardPending();
  clearTimeout(graceTimer);
  graceTimer = null;
  const text = pending;
  const risk = pendingRisk;
  pending = null;
  pendingRisk = null;
  if (!await writeNow(text)) {
    // writeText() can refuse in the gap where the tab is visible but not yet
    // focused, and the clip is still owed. Unless a newer clip took the slot
    // mid-write, in which case that one is what the banner shows.
    if (pending === null) { pending = text; pendingRisk = risk; }
    return;
  }
  // Conditional for the same reason: retracting unconditionally dismissed the
  // banner of a clip that arrived mid-write, and a flagged clip whose banner is
  // gone can never be confirmed or discarded.
  if (pending === null) emit(EV.PENDING_CLIP, { pending: false });
  emit(EV.TOAST, "Pending clip written to your clipboard");
}

export const hasPending = () => pending !== null;
