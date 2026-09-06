/**
 * In-session clip history — PRD FR-2.9 (last 20 clips, one-click copy).
 *
 * PRIVACY INVARIANT: persists to **sessionStorage only, never localStorage**.
 * Clipboard content is passwords, tokens, 2FA codes and private URLs; it must
 * not survive the browser session, be readable by the next person to open the
 * laptop, or leak between rooms. The sessionStorage twin lives here rather than
 * in core/storage.js precisely so a future edit cannot quietly move clips onto
 * disk — that module is the localStorage one, for preferences.
 *
 * Node-testable on purpose: imports only core/bus.js, and every sessionStorage
 * call is wrapped, so it degrades to memory-only where the API is missing.
 */

import { on, emit, EV } from "./bus.js";

/**
 * PRD FR-2.9 caps history at 20. Belongs in core/config.js with the other
 * limits; it is here because importing config.js would cost node testability.
 */
export const MAX_CLIPS = 20;

/** Event names this module owns. Use the constants — a typo'd literal is a silent no-op. */
export const EVENTS = {
  /** {clips, reason} — the list changed (add / clear / hydrate). */
  CHANGED: "history:changed",
  /** {text} — a clip was picked from history and should be loaded into the editor. */
  RESTORE: "history:restore",
};

const STORE_KEY = "realtimeclipboard.history";

let clips = [];
let roomId = null;       // ROOM the current list belongs to; null until first KEY_CHANGED
let sealed = false;      // hydrated from storage, not yet confirmed to be this room
let started = false;
let seq = 0;

// Mirrors core/storage.js against sessionStorage. try/catch also swallows the
// ReferenceError under node, which is what makes this module testable.
function readStore() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw === null ? null : JSON.parse(raw);
  } catch { return null; }
}

function writeStore(value) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(value)); return true; }
  catch { return false; }   // quota, private mode, or no sessionStorage at all
}

function removeStore() {
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* nothing to do */ }
}

/**
 * A refused write keeps going in memory rather than dropping the clip: 20 clips
 * of 50k characters can push a megabyte, and losing persistence across a reload
 * is a smaller failure than losing the user's clipboard.
 */
function persist() {
  if (!clips.length && roomId === null) return removeStore();
  writeStore({ room: roomId, clips });
}

const nextId = () => `h${Date.now().toString(36)}${(++seq).toString(36)}`;

// Local, deliberately not core/keys.js — that pulls in config.js and its
// top-level `location` read, which breaks node testability.
const normKey = k => String(k ?? "").trim().toUpperCase();

function announce(reason) {
  emit(EVENTS.CHANGED, { clips: all(), reason });
}

/**
 * Newest first. Returns a shallow copy — callers must not mutate the list.
 *
 * Empty while `sealed`: clips restored from storage are not known to belong to
 * the session being opened until the first KEY_CHANGED says so, and a locked
 * link sitting on its PIN prompt has not opened one yet.
 */
export function all() {
  return sealed ? [] : clips.slice();
}

export function get(id) {
  return sealed ? null : clips.find(c => c.id === id) ?? null;
}

export const size = () => (sealed ? 0 : clips.length);

/**
 * Record a clip. Returns the new entry, or null if it was ignored — empty text,
 * or identical to the most recent entry. Consecutive dedupe matters more than it
 * looks: capture tiers can fire twice for one copy (paste event + poll), and a
 * peer echoing our own clip back arrives with the same text.
 */
export function add({ text, direction }) {
  const value = String(text ?? "");
  if (!value.trim()) return null;

  const dir = direction === "sent" ? "sent" : "received";
  if (clips.length && clips[0].text === value) return null;   // consecutive dedupe

  const entry = { id: nextId(), text: value, direction: dir, at: new Date(), chars: value.length };
  clips.unshift(entry);
  if (clips.length > MAX_CLIPS) clips.length = MAX_CLIPS;     // FR-2.9: last 20

  persist();
  announce("add");
  return entry;
}

/** Drop everything, in memory and in sessionStorage. */
export function clear(reason = "clear") {
  const had = clips.length;
  clips = [];
  sealed = false;
  removeStore();
  if (roomId !== null) persist();
  if (had) announce(reason);
  return had;
}

// The stored room is not known to be the current one yet — the first
// KEY_CHANGED decides whether to keep or discard this, and until it does the
// clips are `sealed`: in memory, out of every reader.
//
// Records written before history was room-scoped are keyed by share key, which
// cannot be mapped onto a room without the PIN. They are dropped rather than
// guessed at — the cost is one tab's history, once.
function hydrate() {
  const saved = readStore();
  if (!saved || !Array.isArray(saved.clips)) return;
  if (typeof saved.room !== "string" || !saved.room) return removeStore();

  roomId = saved.room;
  sealed = saved.clips.length > 0;
  clips = saved.clips
    .filter(c => c && typeof c.text === "string")
    .slice(0, MAX_CLIPS)
    .map(c => ({
      id: typeof c.id === "string" ? c.id : nextId(),
      text: c.text,
      direction: c.direction === "sent" ? "sent" : "received",
      at: new Date(c.at ?? Date.now()),          // JSON round-trips Date to a string
      chars: typeof c.chars === "number" ? c.chars : c.text.length,
    }));
}

/**
 * A new ROOM is new peers and a new privacy context. Scoped to the room rather
 * than the share key because they are not the same boundary: re-PINning a
 * session keeps the key and moves rooms, and key-scoped history followed the
 * user across that move — as did a wrong-PIN join, which lands in a different
 * room under the very same key.
 *
 * The first KEY_CHANGED after boot is not a change, though — main.js emits one
 * for the room we already had, and comparing against the room stored alongside
 * the clips is what tells the two apart. That comparison is also what unseals
 * hydrated clips: they are only this session's once it has identified itself.
 */
function onKeyChanged({ key, roomHash }) {
  // roomHash is the real identity; the key is the fallback for surfaces that
  // set state before a room is derived, and for node tests with neither.
  const next = roomHash || normKey(key);
  if (!next) return;

  if (roomId !== null && roomId !== next) {
    roomId = next;
    clear("key-changed");
    persist();
    return;
  }

  roomId = next;
  if (sealed) {
    sealed = false;
    if (clips.length) announce("hydrate");
  }
  persist();
}

/** Subscribe to the bus. Idempotent. */
export function init() {
  if (started) return;
  started = true;

  hydrate();

  on(EV.TEXT_CAPTURED, ({ text }) => add({ text, direction: "sent" }));
  on(EV.TEXT_RECEIVED, ({ text }) => add({ text, direction: "received" }));
  on(EV.KEY_CHANGED, onKeyChanged);

  // Nothing is announced here on purpose: hydrated clips stay sealed until a
  // KEY_CHANGED identifies the room they belong to. Announcing them at boot put
  // the previous session's clips in the pane behind an unanswered PIN prompt.
  if (!sealed && clips.length) announce("hydrate");
}
