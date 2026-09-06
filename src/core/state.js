/**
 * Single source of truth for session state.
 *
 * Deliberately not reactive: modules mutate through the setters here and the bus
 * announces the change. Nothing observes this object directly.
 */

import { emit, EV } from "./bus.js";
import { DEFAULT_SYNC_MODE, DEFAULT_THEME, SYNC_MODES, KEY, TEXT } from "./config.js";
import * as storage from "./storage.js";

const state = {
  key: null,
  roomHash: null,
  aesKey: null,
  locked: false,
  /**
   * A wrong PIN does not fail loudly — it derives a different, empty room, which
   * looks exactly like being first to arrive. `verified` means something here
   * actually decrypted, so we KNOW the PIN is right rather than assuming it.
   */
  verified: false,
  /**
   * Were we first into this room? `null` until the relay's `welcome` answers.
   * "Not yet known" must not be spelled `false`, or the lock button is refused
   * for a moment on connect and for the whole of an offline session.
   */
  founder: null,
  authToken: null,           // proves PIN knowledge to the relay; not a secret
  originId: crypto.randomUUID().slice(0, 8),   // this tab, for loop suppression
  peerId: null,              // assigned by the relay in `welcome.you`
  connection: "idle",        // idle | connecting | connected | reconnecting | offline
  instance: null,            // relay instance id — a change means split-brain (OI-3)
  /**
   * Frame types this relay understands, from `welcome.caps`. Empty on a relay
   * older than the field, which is the point: a client that guesses gets
   * UNKNOWN_TYPE back and cannot tell it from silence. See core/verify.js.
   */
  relayCaps: [],
  peers: 1,
  tier: "T1",                // clipboard capture tier, see clipboard/capture.js
  lastSent: "",              // dedupe guard (FR-2.7)
  suppressUntil: 0,          // loop-suppression deadline (FR-2.6)
  lastLocalCopyAt: 0,        // a local copy outranks an arriving clip — see recentLocalCopy()
  settings: {
    // Reading and writing the OS clipboard are both derived from this rung and
    // neither gets a switch of its own — see config.js SYNC_MODES.
    syncMode: DEFAULT_SYNC_MODE,
    autoaccept: false,
    thumbs: true,
    images: true,
    cursors: true,
    longKeys: KEY.DEFAULT_LONG,    // installed builds default to the longer key
    closeToTray: true,             // desktop only; the X button hides, Quit is in the tray
    poll: "1s",
    // Whether the share key may be written to localStorage so a relaunch offers
    // the room back (FR-1.7). Defaults on because that is the behaviour that
    // shipped and losing it silently would be a regression — but it is the one
    // setting that decides whether a secret touches disk, so it is a switch and
    // it is named plainly in the UI. See storage.js saveLastKey.
    rememberKey: true,
    // system | light | dark. "system" is not a third colour scheme, it is the
    // absence of a choice — see config.js THEMES and ui/features/theme.js.
    theme: DEFAULT_THEME,
    // "" is the absence of a choice, and means "follow the browser" — the same
    // shape as theme's "system". An explicit "en" is a real choice and beats a
    // browser that asks for Chinese. See core/i18n.js pick().
    language: "",
  },
};

export const get = () => state;

/**
 * Seed settings from storage. Runs first in boot(): resolveKey() asks how long
 * the next key should be, and used to be answered from the defaults.
 *
 * A key absent from the saved object keeps its default above, which is what lets
 * a setting be ADDED without turning it off for everyone who already saved.
 */
export function restore() {
  const saved = storage.loadSettings();
  if (saved) Object.assign(state.settings, saved);

  migrateReceiving(saved);
  watchSettings();

  /**
   * Anyone who toggled any switch before this shipped has an explicit
   * `longKeys: false` they never chose — persist() writes the whole object, so
   * the old default was recorded as a decision. Gated on a marker so a later
   * deliberate "off" stands. Only affects the NEXT key generated.
   */
  if (KEY.DEFAULT_LONG && !storage.read("longKeyDefault")) {
    state.settings.longKeys = true;
    storage.write("longKeyDefault", KEY.LONG_LENGTH);
    storage.saveSettings(state.settings);
  }
}

/**
 * Receiving used to be its own switch, defaulting on independently of the mode,
 * so Manual stopped this machine SENDING while arriving clips still landed on
 * its clipboard. Anyone who turned it off asked for one thing: nothing arriving
 * touches their clipboard. Only Manual honours that, so they move there rather
 * than being promoted to a rung that does what they opted out of.
 */
function migrateReceiving(saved) {
  if (!saved) return;
  if (!("autowrite" in saved) && !("autoread" in saved)) return;

  if (saved.autowrite === false && state.settings.syncMode === SYNC_MODES.LIVE) {
    state.settings.syncMode = SYNC_MODES.MANUAL;
  }
  delete state.settings.autowrite;
  delete state.settings.autoread;
  storage.saveSettings(state.settings);
}

/** Change a setting and remember it. The only path that persists one. */
export function saveSetting(name, value) {
  state.settings[name] = value;
  // Merged into what is on disk rather than written wholesale. Two tabs of one
  // session each hold their own copy of this object from boot, so a whole-object
  // write reverted every setting the OTHER tab had changed since — including the
  // sync rung, which silently put a device the user had taken offline back on
  // the wire at the next launch, and `rememberKey`, which decides whether the
  // share key touches disk at all.
  storage.saveSettings({ ...(storage.loadSettings() ?? {}), [name]: value });
  emit(EV.SETTINGS_CHANGED, { name, value });
}

let watching = false;

/**
 * Adopt what another tab saved, so two windows of one session do not disagree
 * about the rung. `external` marks these apart from this tab's own changes:
 * the control that owns a setting has already applied it locally by the time it
 * emits, and would double-apply on its own event.
 */
function watchSettings() {
  if (watching) return;
  watching = true;
  storage.onSettingsChanged(saved => {
    if (!saved) return;
    for (const [name, value] of Object.entries(saved)) {
      if (state.settings[name] === value) continue;
      state.settings[name] = value;
      emit(EV.SETTINGS_CHANGED, { name, value, external: true });
    }
  });
}

/**
 * `roomHash` and `aesKey` keep their old value when the property is ABSENT, not
 * when it is null. `??` could not tell those apart, so the one caller that says
 * `aesKey: null` to wipe a session — VS Code's leave — kept the key it was
 * clearing. Omission still means "leave it alone"; an explicit null now clears.
 */
export function setKey(next) {
  const { key, roomHash, aesKey, locked = false, authToken = null } = next;
  state.key = key;
  state.roomHash = "roomHash" in next ? roomHash : state.roomHash;
  state.aesKey = "aesKey" in next ? aesKey : state.aesKey;
  state.locked = locked;
  state.authToken = authToken;
  // A new key is a new room, so both of these are re-asked. Left standing, the
  // founder of one session would carry the right to lock into the next.
  state.verified = false;
  state.founder = null;
  // roomHash rides along because the ROOM is the privacy boundary, not the
  // share key: re-PINning keeps the key and changes the room, and a listener
  // scoping anything to the key alone would carry it across that change.
  emit(EV.KEY_CHANGED, { key, locked, roomHash: state.roomHash });
  emit(EV.LOCK_STATE, { locked, verified: false });
  emit(EV.FOUNDER, { founder: null });
}

/**
 * Wipe every credential this module holds. The teardown paths used to spell
 * this out field by field and each one forgot a different field — the shape of
 * "no session" belongs here, with the shape of a session.
 */
export function clearKey() {
  setKey({ key: "", roomHash: "", aesKey: null, locked: false, authToken: null });
}

/**
 * Fed from `welcome.existing`. Re-answered on every welcome, so a relay restart
 * — which empties every room (OI-13) — hands the title to whoever reconnects
 * first rather than to whoever held it before the room stopped existing.
 */
export function setFounder(first) {
  const next = first === null ? null : !!first;
  if (state.founder === next) return;
  state.founder = next;
  emit(EV.FOUNDER, { founder: next });
}

/**
 * May THIS device lock the session?
 *
 * Alone, anyone may. With company, only the device that opened the room, because
 * locking moves the session to a different room and evicts everybody else
 * (LOCK.EVICT) — a control that lets any arrival do that is a control for taking
 * a session over.
 *
 * A rule the UI keeps, not one the relay enforces: every device in the room
 * holds the key, so a modified client could send the goodbye itself. The honest
 * description is "the app will not help you", not "you cannot".
 */
export function canLock() {
  if (state.locked) return false;
  if (state.peers <= 1) return true;
  return state.founder === true;
}

/**
 * Set from the first thing that decrypts — the beacon replayed in `welcome`, or
 * any real frame. Only moves false -> true; setKey resets it, because a
 * different room is a different question.
 */
export function setVerified() {
  if (!state.locked || state.verified) return;
  state.verified = true;
  emit(EV.LOCK_STATE, { locked: true, verified: true });
}

export function setRelayCaps(caps) {
  state.relayCaps = Array.isArray(caps) ? caps : [];
}

export function setConnection(connection, detail = "") {
  state.connection = connection;
  emit(EV.CONN_STATE, { state: connection, detail });
}

/**
 * Diffed rather than counted, so arrivals can be announced: the key is a bearer
 * credential, and a device appearing is the one observable moment telling you
 * someone else has it. The first roster after connecting is not announced —
 * those devices were already there, and greeting them would cry wolf on reload.
 */
let roster = null;

export function setPeers(count, list = []) {
  state.peers = count;

  if (roster === null) {
    roster = new Map(list.map(p => [p.peerId, p.name]));
  } else {
    const now = new Map(list.map(p => [p.peerId, p.name]));
    for (const [id, name] of now) {
      if (!roster.has(id) && id !== state.peerId) emit(EV.PEER_JOINED, { name, id });
    }
    for (const [id, name] of roster) {
      if (!now.has(id)) emit(EV.PEER_LEFT, { name, id });
    }
    roster = now;
  }

  emit(EV.PEERS_CHANGED, { count, list });
}

/** Forget the roster so a reconnect does not report everyone as newly arrived. */
export function resetRoster() { roster = null; }

/**
 * A changed instance id means we may have landed on a different replica where
 * our peers do not exist. Loud, not silent — a quiet failure here looks exactly
 * like "the network is slow".
 */
export function setInstance(instance) {
  const previous = state.instance;
  state.instance = instance;
  if (previous && previous !== instance) {
    emit(EV.INSTANCE_CHANGED, { from: previous, to: instance });
  }
}

export function setTier(tier, note = "") {
  state.tier = tier;
  emit(EV.TIER_CHANGED, { tier, note });
}

export function setSetting(name, value) {
  state.settings[name] = value;
}

/** Mute local capture briefly after applying a remote clip (FR-2.6). */
export function suppress(ms) { state.suppressUntil = Date.now() + ms; }
export function isSuppressed() { return Date.now() < state.suppressUntil; }

/**
 * Precedence, not loop-suppression: for a few seconds after you copy something
 * here, that is what you are about to paste, and an arriving clip does not get
 * to take it away.
 */
export function markLocalCopy() { state.lastLocalCopyAt = Date.now(); }
export function recentLocalCopy() {
  return Date.now() - state.lastLocalCopyAt < TEXT.LOCAL_COPY_GRACE_MS;
}
