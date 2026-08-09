/** Share-key generation and normalisation. */

import { KEY, LOCK, SITE } from "./config.js";
import { IS_WEB } from "./native.js";
import * as state from "./state.js";

// Modulo bias: 256 does not divide 30, costing ~0.03 bits over a 6-char key.
export function generate(length = KEY.LENGTH) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => KEY.ALPHABET[b % KEY.ALPHABET.length]).join("");
}

/**
 * Bits of entropy in a key of this length: 6 chars ≈ 29.4, 10 chars ≈ 49.1.
 *
 * PBKDF2 multiplies the cost of each guess but does not change the shape of the
 * problem. This exists so the UI can state the trade-off in numbers.
 */
export function entropyBits(length) {
  return Math.log2(KEY.ALPHABET.length) * length;
}

export const LENGTHS = { NORMAL: KEY.LENGTH, LONG: KEY.LONG_LENGTH };

// One implementation: the first-run key and the collision retry both used to
// emit six characters however the app was configured.
export const nextLength = () =>
  state.get().settings.longKeys ? LENGTHS.LONG : LENGTHS.NORMAL;

/**
 * Normalise before ANY use — hashing, comparison, display.
 *
 * The room name is a hash of the key, so "D75LV" and "d75lv" would drop two
 * users into different rooms while both believe they typed the same thing.
 */
export function normalise(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Deliberately more permissive than the generation alphabet.
 *
 * KEY.ALPHABET constrains what we PRODUCE. Validation must accept anything a
 * peer might legitimately hand us: a key from another build is still a valid
 * hash input, and rejecting an in-use key strands the user with no way to join.
 * "D75LV" contains an L, which the generator never emits, and still has to work.
 */
export function isValid(raw) {
  const k = normalise(raw);
  return k.length >= 4 && k.length <= 32;
}

/**
 * Bits of entropy in a PIN, from the character classes it actually uses.
 *
 * Deliberately pessimistic — it assumes an attacker who knows the alphabet you
 * drew from, so "123456" reports ~20 bits rather than a flattering ~39. A PIN is
 * guessed by someone who may already hold the link, where it is the entire
 * remaining secret.
 */
export function pinEntropyBits(pin) {
  const p = String(pin ?? "");
  if (!p) return 0;
  let alphabet = 0;
  if (/[a-z]/.test(p)) alphabet += 26;
  if (/[A-Z]/.test(p)) alphabet += 26;
  if (/[0-9]/.test(p)) alphabet += 10;
  if (/[^a-zA-Z0-9]/.test(p)) alphabet += 33;      // printable ASCII punctuation
  return Math.log2(alphabet) * p.length;
}

/**
 * A locked session's link carries a marker but never the PIN: `#!ABCDEF`.
 *
 * Parsing happens BEFORE normalise(), and that order is load-bearing:
 * normalise() strips everything outside [A-Z0-9], so running it first turns
 * "#!ABCDEF" into the valid, completely different key "ABCDEF". That is also how
 * an older build fails safely — it joins the empty unlocked room and learns
 * nothing.
 */
export const LOCK_SIGIL = LOCK.SIGIL;

export function parseFragment(raw) {
  const s = String(raw ?? "").trim();
  const locked = s.startsWith(LOCK.SIGIL);
  return { key: normalise(locked ? s.slice(LOCK.SIGIL.length) : s), locked };
}

/** The inverse of parseFragment, and tested as such. */
export function fragment(key, locked = false) {
  return (locked ? LOCK.SIGIL : "") + normalise(key);
}

/**
 * The fragment is never sent to a server. Read once at boot and then cleared —
 * see clearUrl(), which openSession() calls immediately afterwards.
 *
 * There is deliberately no inverse. A `toUrl()` existed and was what kept the
 * key in the address bar for the whole session; it is gone rather than merely
 * unused, so that "put the key back in the URL" is not one import away. A link
 * to share is built by shareLink() from state, which never touches `location`.
 */
export function fromUrl() {
  if (typeof location === "undefined") return { key: "", locked: false };
  return parseFragment(location.hash.slice(1));
}

/**
 * Drop the key out of the address bar without navigating.
 *
 * Called on every `openSession()`, so the key is in the URL only for the instant
 * between the page loading and boot reading it — not for the life of the
 * session, in every screenshot and screen share, and in reach of every script in
 * the document. It is also what `onEvicted()` uses to make a reload stop
 * rejoining a room this device was thrown out of.
 *
 * replaceState, not `location.hash = ""` — that leaves a bare "#" and pushes a
 * history entry, so Back would restore the dead key.
 *
 * Guarded because this directory has no DOM (see CLAUDE.md): `cli/` imports this
 * module, and a bare `history` here threw during boot the moment this stopped
 * being an eviction-only path. Silent no-op — there is no address bar to clear.
 */
export function clearUrl() {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  history.replaceState(null, "", location.pathname + location.search);
}

/**
 * A link for the OTHER device to open, which is why it is not always this one's
 * URL. Only a browser can hand out its own address — see SITE in config.js for
 * the hosts that cannot.
 */
export function shareLink(key, locked = false) {
  const here = IS_WEB && typeof location !== "undefined"
    ? location.origin + location.pathname
    : SITE.APP_URL;
  return `${here}#${fragment(key, locked)}`;
}
