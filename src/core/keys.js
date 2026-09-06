/** Share-key generation and normalisation. */

import { KEY, LOCK, SITE, RELAY_URL, RELAY_IS_CUSTOM, safeSearch } from "./config.js";
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
 * "D75LVX9QR" contains an L, which the generator never emits, and still works.
 *
 * Permissive about the ALPHABET, not about the LENGTH — see KEY.MIN_LENGTH.
 */
export function isValid(raw) {
  return rejectReason(raw) === null;
}

/**
 * WHY a key was refused, or null if it was not. `isValid()` answers the question
 * the code asks; this answers the one the user asks.
 *
 * The distinction matters at boot. A key that is merely absent means "generate
 * one" — the ordinary first visit. A key that is present and too short is a
 * request we are declining, and declining it silently is what let `#F5H4` open
 * a session with 19 bits behind it. See ui/shell/keyGate.js.
 */
export function rejectReason(raw) {
  const k = normalise(raw);
  if (!k.length) return "empty";
  if (k.length < KEY.MIN_LENGTH) return "short";
  if (k.length > KEY.MAX_LENGTH) return "long";
  return null;
}

/**
 * One sentence for a surface with no room for a card — the CLI's exit message
 * and the extension's error. `null` when the key is fine.
 *
 * Here rather than at each call site so the two of them cannot drift from each
 * other or from the floor: both said "is not a valid key" and left the reader
 * to guess which of length, characters or typo they had hit.
 */
export function rejectMessage(raw) {
  const reason = rejectReason(raw);
  if (!reason) return null;
  const n = normalise(raw).length;
  if (reason === "empty") return "it has no usable characters in it";
  if (reason === "long") return `it is ${n} characters; the most a key may be is ${KEY.MAX_LENGTH}`;
  return `it is ${n} character${n === 1 ? "" : "s"}; a key needs at least ${KEY.MIN_LENGTH}`;
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
  // The query is rewritten too, not just the fragment: `?org=` is a deployment
  // credential and it was left in the address bar for the life of the session —
  // in every screenshot, and readable by the ad tag, which reports the page URL
  // itself rather than taking pageLocation(). It has been read into storage by
  // the time this runs.
  history.replaceState(null, "", location.pathname + safeSearch());
}

/**
 * A link for the OTHER device to open, which is why it is not always this one's
 * URL. Only a browser can hand out its own address — see SITE in config.js for
 * the hosts that cannot.
 *
 * A custom relay travels WITH the link. Dropping it was silent and total: the
 * recipient resolved to the default relay, both ends reported "connected", and
 * nothing ever arrived — with no error at either end to say why. `?relay=` is
 * the mechanism docs/SELF-HOSTING.md tells operators to hand out, and this is
 * the one place a link is built, so it is the one place that can carry it.
 *
 * On a self-hosted app the link is complete: that build's CSP names its own
 * relay, so following it works. From a native host the base is the public app,
 * whose CSP names only the public relay — the parameter cannot make that
 * connection succeed, but it does turn a session that silently syncs nothing
 * into a connection that visibly refuses, which is the difference between a bug
 * report and a mystery.
 */
export function shareLink(key, locked = false) {
  const here = IS_WEB && typeof location !== "undefined"
    ? location.origin + location.pathname
    : SITE.APP_URL;
  const relay = RELAY_IS_CUSTOM ? `?relay=${encodeURIComponent(RELAY_URL)}` : "";
  return `${here}${relay}#${fragment(key, locked)}`;
}

/**
 * The share link, plus the flag that asks the app to open its QR immediately.
 *
 * Here rather than in the surface that wanted it, because there is exactly one
 * rule to get wrong and it is not obvious: the query goes BEFORE the fragment.
 * Everything after `#` is the key, so `#KEY?qr=1` is not a broken flag — it is a
 * broken key, and the symptom is a room nobody else can join rather than an
 * error anybody sees. One implementation, tested in tests/unit/sharelink.mjs.
 */
export function qrLink(key, locked = false) {
  const [base, fragment] = shareLink(key, locked).split("#");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${SITE.QR_PARAM}=1${fragment ? `#${fragment}` : ""}`;
}

/**
 * Did this visit ask for the code? The reader sits beside the writer so the two
 * cannot drift, and it is strict: `?qr=0` and `?qr=false` are not requests, and
 * a truthiness test on the string would have treated both as one.
 */
export const qrRequested = () =>
  typeof location !== "undefined"
  && new URLSearchParams(location.search).get(SITE.QR_PARAM) === "1";
