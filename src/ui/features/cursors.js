/**
 * Live peer cursors — a labelled pointer for every OTHER device in the session.
 *
 * PRIVACY. This is a continuous signal about what a person is physically doing,
 * a different class of data from "a clip arrived". Three properties make it
 * defensible and all three are load-bearing:
 *
 *   1. ENCRYPTED. Only `t` and `originId` are cleartext; x, y, name and state
 *      are sealed by main.js encryptFrame(). The relay learns that some socket
 *      is moving a mouse, not where.
 *   2. OFF-SWITCHABLE. `state.settings.cursors` gates both directions, and
 *      switching off tells peers we are gone rather than freezing a pointer.
 *   3. IT STOPS WHEN YOU ARE NOT THERE. Hidden tab, blurred window or pointer
 *      outside the viewport ends the stream. Sharing a pointer while you read
 *      email in another tab is surveillance, not presence.
 *
 * The wire arrives by injection, the transfer.js idiom. `.from` is stamped by
 * the relay and is the one field a peer cannot lie about, so it beats
 * `.originId`.
 *
 * RATE. pointermove fires 60-120 times a second and clipboard sync is the
 * product, so presence must never compete with it: 10/s, movement under
 * MIN_MOVE skipped, coalesced through rAF. Smoothing is the RECEIVER's job in
 * CSS, on the compositor, dropped under prefers-reduced-motion.
 */

import { on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as device from "../../core/device.js";
import { $, esc, setHTML, lazyStyle } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";

/** Frame types. "cursor" is ROOM_WIDE in the relay — broadcast, never targeted. */
export const FT = { CURSOR: "cursor" };

/** Exactly the frames main.js should route into onSignal(). */
export const FRAMES = Object.freeze(Object.values(FT));

/**
 * Two, not three. An "idle" state was dropped: silence already means idle, the
 * fade renders it, and a frame saying "nothing happened" buys no pixels.
 */
export const CURSOR_STATE = {
  MOVE: "move",   // {x, y, name} — here, and this is where
  GONE: "gone",   // no coordinates — stop drawing me, now
};

/* ------------------------------------------------------------------ *
 * Tunables — here rather than core/config.js because each is a property of this
 * feature's feel, not a product limit. A second consumer is the signal to promote.
 * ------------------------------------------------------------------ */

/** 10 sends/sec — half the relay's 20/s cursor budget. See the header. */
const SEND_INTERVAL_MS = 100;

/**
 * ~4 px across a 1920 px window. Below it nothing is sent, so hand tremor and a
 * mouse resting against a wheel cost nothing.
 */
const MIN_MOVE = 0.002;

/**
 * ~2 px of precision on a 1920 px window — past what anyone can see, and
 * rounding is free privacy: less is transmitted about where someone points.
 */
const COORD_DP = 3;

/** Silence handling. Fade first so a peer's disappearance is not a jump cut. */
let fadeAfterMs = 10_000;   // 10 s quiet -> fade out
let dropAfterMs = 12_000;   // then remove the element entirely
let sweepMs = 1_000;        // how often the two above are checked

/** Peer-chosen, so bounded before it reaches the DOM. Matches device.rename(). */
const NAME_CHARS = 40;

/** Token colours used as peer identities. See styles/cursors.css .c0-.c4. */
const PALETTE_SIZE = 5;

/* ------------------------------------------------------------------ *
 * Injected collaborator
 * ------------------------------------------------------------------ */

let sendSignal = null;
let warnedNoSender = false;

export function setSignalSender(fn) { sendSignal = typeof fn === "function" ? fn : null; }

function signal(frame) {
  if (!sendSignal) {
    // Once, not ten times a second: a mis-wire should be visible, not a flood.
    if (!warnedNoSender) {
      warnedNoSender = true;
      console.warn("[cursors] no signal sender wired — main.js must call setSignalSender()");
    }
    return false;
  }
  frame.originId = state.get().originId;
  try { return sendSignal(frame) !== false; }
  catch (err) {
    console.error("[cursors] signal send threw", err);
    return false;
  }
}

/** Test seam: "a peer went quiet" without a twelve-second wait. */
export function setSilenceMs({ fade, drop, sweep } = {}) {
  fadeAfterMs = Number.isFinite(fade) && fade > 0 ? fade : 10_000;
  dropAfterMs = Number.isFinite(drop) && drop > 0 ? drop : 12_000;
  sweepMs = Number.isFinite(sweep) && sweep > 0 ? sweep : 1_000;
  if (sweepTimer) { stopSweep(); ensureSweep(); }
}

/* ------------------------------------------------------------------ *
 * Gates
 * ------------------------------------------------------------------ */

/**
 * Undefined is ON. sessionPanel writes the flag only once someone touches the
 * toggle, so reading a missing value as "off" disables it for every install.
 */
const allowed = () => state.get().settings.cursors !== false;

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

let focused = true;
let pointerInside = false;

/** Everything that must be true before this device's pointer goes on the wire. */
const canSend = () => allowed() && !hidden() && focused && pointerInside;

/* ------------------------------------------------------------------ *
 * SEND SIDE
 * ------------------------------------------------------------------ */

let pending = null;        // newest normalised position, not yet sent
let lastSent = null;       // what peers last heard, for the MIN_MOVE test
let lastSentAt = 0;
let rafPending = false;
let flushTimer = 0;
let broadcasting = false;  // peers currently believe we have a live pointer

const nowMs = () =>
  (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/** rAF where it exists; a timer otherwise, so this module works headless. */
function raf(fn) {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn)
    : setTimeout(fn, 16);
}

const clamp01 = n => (n < 0 ? 0 : n > 1 ? 1 : n);
const round = n => Number(n.toFixed(COORD_DP));
const isCoord = n => typeof n === "number" && Number.isFinite(n);

function onPointerMove(ev) {
  // A touch drag renders as a cursor that teleports and vanishes, which reads as
  // a glitch rather than a person. Mouse, trackpad and pen only.
  if (ev.pointerType === "touch") return;

  pointerInside = true;
  if (!canSend()) return;

  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  pending = { x: clamp01(ev.clientX / w), y: clamp01(ev.clientY / h) };
  schedule();
}

/**
 * Never more than one pending flush: a rAF if due now, a timer for the rest of
 * the interval otherwise. Without the timer, a pointer stopping just after a
 * send leaves its final position undelivered and the cursor stranded.
 */
function schedule() {
  if (rafPending || flushTimer) return;

  const wait = SEND_INTERVAL_MS - (nowMs() - lastSentAt);
  if (wait > 0) {
    flushTimer = setTimeout(() => { flushTimer = 0; schedule(); }, wait);
    return;
  }

  rafPending = true;
  raf(() => { rafPending = false; flush(); });
}

function flush() {
  const p = pending;
  pending = null;
  if (!p || !canSend()) return;

  const x = round(p.x);
  const y = round(p.y);
  // The difference between a still mouse costing 10 frames a second and nothing.
  if (lastSent && Math.abs(x - lastSent.x) < MIN_MOVE && Math.abs(y - lastSent.y) < MIN_MOVE) return;

  lastSent = { x, y };
  lastSentAt = nowMs();
  broadcasting = true;
  ensureSweep();                       // so a setting flipped off is noticed
  signal({ t: FT.CURSOR, x, y, name: label(), state: CURSOR_STATE.MOVE });
}

/**
 * The explicit "gone" frame keeps a blurred window from leaving a frozen pointer
 * on everyone else's screen for ten seconds. One frame per blur, so it ignores
 * the throttle.
 */
function stopBroadcast() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  pending = null;
  lastSent = null;
  if (!broadcasting) return;
  broadcasting = false;
  signal({ t: FT.CURSOR, state: CURSOR_STATE.GONE });
}

/**
 * The name rides in every frame rather than being looked up in the roster: ~20
 * bytes inside an already-encrypted envelope buys a self-describing frame.
 * Nothing replays cursor frames, so a device joining mid-stream would otherwise
 * draw an unlabelled pointer until the next `peers` frame happened to arrive.
 */
function label() {
  try { return device.name(); }
  catch { return ""; }
}

/* ------------------------------------------------------------------ *
 * RECEIVE SIDE — the single entry point main.js calls
 * ------------------------------------------------------------------ */

export function onSignal(frame) {
  if (!frame || typeof frame !== "object") return;
  if (frame.t !== FT.CURSOR) return;
  if (!allowed()) return;                       // switched off: render nothing

  const me = state.get().originId;
  // Either field matching us is our own pointer coming back, and our own pointer
  // is the one thing we must never draw.
  if (frame.originId === me || frame.from === me) return;

  const id = frame.from || frame.originId;
  if (!id) return;

  if (frame.state === CURSOR_STATE.GONE) { removePeer(id); return; }

  // Strict, not coerced: `Number(null)` and `Number("")` are both 0, so a
  // half-built frame would pin a pointer to the top-left corner and read as a
  // bug in this module rather than a bad frame.
  if (!isCoord(frame.x) || !isCoord(frame.y)) return;

  upsert(id, clamp01(frame.x), clamp01(frame.y), frame.name);
}

/* ------------------------------------------------------------------ *
 * RENDER
 * ------------------------------------------------------------------ */

/** id -> { el, name, x, y, seenAt }. Every entry owns exactly one element. */
const peers = new Map();

/**
 * cursors.css is the primary mechanism. This is the half it cannot do: skipping
 * the one-frame `.live` deferral (nothing to defer past without a transition),
 * and setting transition-property on the element, because the sheet is injected
 * at init() and may not have applied yet — or at all. Only the PROPERTY, so the
 * opacity fade survives. The query is live, so the OS setting applies mid-session.
 */

const motionQuery = typeof matchMedia === "function"
  ? matchMedia("(prefers-reduced-motion: reduce)")
  : null;

export const reducedMotion = () => motionQuery?.matches === true;

function applyMotion(el) {
  el.style.transitionProperty = reducedMotion() ? "opacity" : "";
}

function onMotionChange() {
  for (const c of peers.values()) applyMotion(c.el);
}

/**
 * Static markup, nothing interpolated — the one peer-supplied value goes through
 * setName() and esc(). The tip sits at (1,1) in the viewBox and CSS nudges the
 * element -1px, so the visible point lands on the reported coordinate.
 */
const ARROW =
  '<svg class="hb-cursor-arrow" viewBox="0 0 14 22" aria-hidden="true">' +
  '<path d="M1 1L1 17L4.5 13.5L7 19L9.2 18L6.8 12.6L11.5 12.6Z"/></svg>';

/**
 * FNV-1a over the id into the token palette. Stable matters more than unique — a
 * cursor changing colour on reconnect reads as a different person. Five colours
 * against the relay's eight-peer cap will collide; the label is the identity, so
 * that is worth staying inside tokens.css for.
 *
 * Exported because the editor tints a peer's caret line with the same index. A
 * pointer in one hue and a caret in another reads as two people.
 */
export function paletteIndex(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % PALETTE_SIZE;
}

/**
 * On first use, not at init(): a solo session carries no empty overlay div.
 * aria-hidden — announcing where somebody else's mouse is would be pure noise.
 */
function layer() {
  const found = $("cursorLayer");
  if (found) return found;
  const el = document.createElement("div");
  el.id = "cursorLayer";
  el.className = "hb-cursors";
  el.setAttribute("aria-hidden", "true");
  (document.body || document.documentElement).appendChild(el);
  return el;
}

function upsert(id, x, y, name) {
  let c = peers.get(id);

  if (!c) {
    const el = document.createElement("div");
    el.className = `hb-cursor c${paletteIndex(id)}`;
    setHTML(el, `${ARROW}<span class="hb-cursor-name"></span>`);
    c = { el, name: null, x, y, seenAt: 0 };
    peers.set(id, c);
    place(c, x, y);                       // position BEFORE the transition exists
    applyMotion(el);
    layer().appendChild(el);
    // A frame later: enabled from the start, a new cursor slides in from the
    // top-left corner on its first update instead of simply being where it is.
    // Under reduced motion there is nothing to defer past, so waiting only
    // delays it appearing.
    if (reducedMotion()) el.classList.add("live");
    else raf(() => el.classList.add("live"));
    ensureSweep();
  }

  setName(c, name);
  place(c, x, y);
  c.seenAt = nowMs();
  c.el.classList.remove("quiet");
}

function place(c, x, y) {
  c.x = x;
  c.y = y;
  const px = Math.round(x * (window.innerWidth || 0));
  const py = Math.round(y * (window.innerHeight || 0));
  // translate3d, not left/top: transform stays on the compositor, so seven
  // cursors gliding at once never trigger layout.
  c.el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
}

/**
 * Attacker-controlled: anyone holding the session key can name their device
 * `<img src=x onerror=…>`, and this is the module's only peer-supplied value
 * reaching innerHTML. esc() is the invariant (docs/ARCHITECTURE.md §5); the
 * length cap stops a 10 KB "name" striping a label across the viewport.
 */
function setName(c, raw) {
  const clean = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_CHARS);
  const name = clean || t("Another device");
  if (name === c.name) return;
  c.name = name;
  const slot = c.el.querySelector(".hb-cursor-name");
  if (slot) setHTML(slot, esc(name));
}

function removePeer(id) {
  const c = peers.get(id);
  if (!c) return;
  peers.delete(id);
  c.el.remove();
}

function clearPeers() {
  for (const id of [...peers.keys()]) removePeer(id);
}

/* ------------------------------------------------------------------ *
 * Sweep — fade the quiet, drop the gone
 * ------------------------------------------------------------------ */

let sweepTimer = 0;

/** Runs only while there is something to watch, and stops itself when not. */
function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, sweepMs);
}

function stopSweep() {
  clearInterval(sweepTimer);
  sweepTimer = 0;
}

function sweep() {
  // state.js is not reactive, so this is where a toggle flipped in the settings
  // panel is noticed. Sending is already gated by canSend(); this tells peers to
  // stop drawing us and clears what we draw of them.
  if (!allowed()) {
    stopBroadcast();
    clearPeers();
    stopSweep();
    return;
  }

  const now = nowMs();
  for (const [id, c] of peers) {
    const quiet = now - c.seenAt;
    if (quiet > dropAfterMs) removePeer(id);
    else if (quiet > fadeAfterMs) c.el.classList.add("quiet");
  }

  if (!peers.size && !broadcasting) stopSweep();
}

/* ------------------------------------------------------------------ *
 * init
 * ------------------------------------------------------------------ */

let started = false;

export function init() {
  if (started) return;
  started = true;

  ensureStyles();

  focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;

  // Cursors already on screen follow "reduce motion" without a reload.
  motionQuery?.addEventListener?.("change", onMotionChange);

  window.addEventListener("pointermove", onPointerMove, { passive: true });

  // Every way of ceasing to be present ends in the same place: pointerleave is
  // the common one, blur covers alt-tab, visibilitychange a locked phone.
  const leave = () => { pointerInside = false; stopBroadcast(); };
  document.documentElement.addEventListener("pointerleave", leave);
  window.addEventListener("blur", () => { focused = false; leave(); });
  window.addEventListener("focus", () => { focused = true; });
  document.addEventListener("visibilitychange", () => { if (hidden()) leave(); });
  window.addEventListener("pagehide", leave);

  // Positions are normalised to the viewport: without this a resize leaves every
  // peer at its old pixel offset until the next frame.
  window.addEventListener("resize", () => {
    for (const c of peers.values()) place(c, c.x, c.y);
  });

  // The roster is authoritative, so a peer that left does not linger for the
  // full fade.
  on(EV.PEERS_CHANGED, ({ count, list }) => {
    if (!Array.isArray(list) || !list.length) {
      if (count <= 1) clearPeers();       // alone in the room
      return;
    }
    const present = new Set(list.map(p => p?.peerId).filter(Boolean));
    for (const id of [...peers.keys()]) if (!present.has(id)) removePeer(id);
  });

  // Losing the relay just stops the frames arriving. Ghost pointers frozen
  // mid-glide would read as "they are still there".
  on(EV.CONN_STATE, ({ state: conn }) => {
    if (conn === "offline" || conn === "reconnecting" || conn === "idle") {
      clearPeers();
      broadcasting = false;               // nothing to tell: the socket is gone
      lastSent = null;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Stylesheet
 * ------------------------------------------------------------------ */

/**
 * The --cursors-css marker is checked as well as the <link>, because either can
 * be true first: lazyStyle()'s injection, or main.css @importing it directly.
 */
function ensureStyles() {
  try {
    const marker = getComputedStyle(document.documentElement)
      .getPropertyValue("--cursors-css").trim();
    if (marker === "1") return;
  } catch { /* no computed style here — inject and move on */ }

  lazyStyle("cursors.css");
}
