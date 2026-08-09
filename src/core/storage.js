/**
 * localStorage, wrapped so a disabled-storage browser degrades instead of
 * throwing. Clipboard *content* never comes near this — only preferences.
 */

import { NET, STORAGE_PREFIX, normaliseRelay } from "./config.js";

const PREFIX = STORAGE_PREFIX;

export function read(name, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function write(name, value) {
  try { localStorage.setItem(PREFIX + name, JSON.stringify(value)); return true; }
  catch { return false; }        // private mode, quota, or storage disabled
}

export function remove(name) {
  try { localStorage.removeItem(PREFIX + name); } catch { /* nothing to do */ }
}

export const loadSettings = () => read("settings", null);
export const saveSettings = s => write("settings", s);

/**
 * Another tab saved the settings. localStorage delivers this event only to the
 * tabs that did NOT write, which is exactly the set that needs to catch up.
 *
 * Guarded rather than assumed: this module is published in the npm package and
 * `cli/` imports it, where there are no other tabs and no event target.
 */
export function onSettingsChanged(cb) {
  if (typeof addEventListener !== "function") return;
  addEventListener("storage", e => {
    if (e.key !== PREFIX + "settings") return;
    try { cb(e.newValue === null ? null : JSON.parse(e.newValue)); }
    catch { /* another tab wrote something we cannot read */ }
  });
}

/**
 * The relay this device talks to, when it is not the one the build ships with.
 * config.js reads this key directly at module evaluation, because the URL has to
 * resolve before anything imports it; this pair is for changing it afterwards.
 *
 * Normalised on the way in as well as out — a malformed stored value would
 * otherwise be re-read as malformed on every launch, and the symptom (every
 * connection refused) looks nothing like its cause.
 */
export const loadRelayUrl = () => normaliseRelay(read("relayUrl", null));

export function saveRelayUrl(url) {
  const clean = normaliseRelay(url);
  if (!clean) { remove("relayUrl"); return null; }
  write("relayUrl", clean);
  return clean;
}

/**
 * The last room, so a relaunch can offer it back (FR-1.7, OI-10). Stores
 * `{key, locked}` and still reads the bare string it used to be, because an
 * upgrade must not strand somebody in "no room at all".
 *
 * The lock FLAG is remembered here. The PIN is not — see saveLock.
 */
export function loadLastKey() {
  const saved = read("lastKey", null);
  if (!saved) return null;
  return typeof saved === "string"
    ? { key: saved, locked: false }
    : { key: saved.key ?? null, locked: !!saved.locked };
}

/**
 * !! This is the share key in plain text, on disk, and it is the one store in
 * this file that holds a secret rather than a preference. Anything running in
 * the document reads it — including a third-party tag, which is why enabling
 * AdSense is gated on this being opt-in rather than automatic. See
 * docs/ARCHITECTURE.md §5. !!
 *
 * `remember` is the user's setting. False removes the record rather than merely
 * declining to write one: turning the switch off has to forget the key already
 * saved, or the setting only governs sessions you have not had yet.
 */
export function saveLastKey(key, locked = false, remember = true) {
  if (!remember) { remove("lastKey"); return false; }
  return write("lastKey", { key, locked });
}

export const forgetLastKey = () => remove("lastKey");

/**
 * The key for THIS tab, so a reload survives the fragment being cleared.
 *
 * The fragment used to be the memory: the key sat in `location.hash` for the
 * lifetime of the session and boot() read it back. That put it in the address
 * bar, in screen shares, in screenshots, and — the reason it moved — in reach of
 * every script in the document, which now includes tags this repository does not
 * write. main.js clears the fragment the moment it has been read, and this is
 * what makes a refresh still work.
 *
 * sessionStorage, not localStorage: a reload is the same session, a new tab is
 * not, and closing the tab should end it. Surviving a browser restart is what
 * `lastKey` above is for, and that one is the user's choice.
 */
export function loadSessionKey() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PREFIX + "sessionKey") || "null");
    return saved?.key ? { key: saved.key, locked: !!saved.locked } : null;
  } catch { return null; }
}

export function saveSessionKey(key, locked = false) {
  try {
    sessionStorage.setItem(PREFIX + "sessionKey", JSON.stringify({ key, locked }));
    return true;
  } catch { return false; }
}

export function clearSessionKey() {
  try { sessionStorage.removeItem(PREFIX + "sessionKey"); } catch { /* nothing to do */ }
}

/**
 * Which transport last worked (transport/relay.js). Remembered because probing
 * costs real seconds of "Connecting…" behind a proxy that blocks WebSockets.
 * Expired rather than permanent because it is a fact about the *network*: a
 * laptop leaving the office should return to the faster transport on its own.
 */
export function loadTransport() {
  const saved = read("transport", null);
  if (!saved?.mode || !saved.at) return null;
  return Date.now() - saved.at < NET.TRANSPORT_MEMORY_MS ? saved.mode : null;
}

export function saveTransport(mode) {
  if (!mode) return remove("transport");
  write("transport", { mode, at: Date.now() });
}

/**
 * A transport the user picked by hand, which outranks anything measured. Kept
 * apart from the remembered-working one because they answer different questions:
 * "what worked last time" is an observation and expires, "use HTTP" is an
 * instruction and does not. Merged, a successful auto-connect would quietly
 * overwrite a deliberate choice.
 */
export const loadTransportChoice = () => read("transportChoice", null);

export function saveTransportChoice(mode) {
  if (!mode) return remove("transportChoice");
  write("transportChoice", mode);
}

/**
 * Session-scoped file allowances.
 *
 * sessionStorage is the whole point: "allow everything from this device" is a
 * decision about the session you are in and has to die with the tab, or it is a
 * standing grant to whoever holds the share key. Scoped to a room as well —
 * rotating the key is how someone throws a device out, and it would be worth
 * nothing if the allowance came along.
 */
export function loadAllowances(room) {
  if (!room) return [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(PREFIX + "allow") || "null");
    return saved && saved.room === room && Array.isArray(saved.peers) ? saved.peers : [];
  } catch { return []; }
}

export function saveAllowances(room, peers) {
  try {
    if (!room || !peers?.length) sessionStorage.removeItem(PREFIX + "allow");
    else sessionStorage.setItem(PREFIX + "allow", JSON.stringify({ room, peers }));
    return true;
  } catch { return false; }
}

/**
 * The locked-session unlock, scoped to this tab.
 *
 * WHAT is the PBKDF2 output, never the PIN. It unlocks the same room, so this is
 * not a security win in itself — the point is that PINs are human-chosen and
 * reused, and the typed string should not sit in a browser store. Reading it
 * back skips 600k iterations, so a refresh is instant.
 *
 * WHERE is sessionStorage: a refresh is the same session and must not re-prompt,
 * but the tab closing ends it. localStorage would put the unlock on disk beside
 * the plaintext key, at which point the second secret has bought nothing.
 *
 * Matched on the KEY, not the room, and those are not interchangeable: a locked
 * room hash derives from the stretched PIN alone, so a record left by a previous
 * key would look self-consistent and silently reconnect this tab to a room the
 * current link does not name.
 */
export function loadLock(key) {
  if (!key) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(PREFIX + "lock") || "null");
    return saved && saved.key === key && saved.prk ? saved.prk : null;
  } catch { return null; }
}

export function saveLock(key, prk) {
  try {
    if (!key || !prk) sessionStorage.removeItem(PREFIX + "lock");
    else sessionStorage.setItem(PREFIX + "lock", JSON.stringify({ key, prk }));
    return true;
  } catch { return false; }
}

export const clearLock = () => saveLock(null, null);
