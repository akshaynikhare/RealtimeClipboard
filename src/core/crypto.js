/**
 * End-to-end encryption. All of it. No libraries.
 *
 *   OPEN    prk      = PBKDF2(KEY, salt, 250k)
 *           aesKey   = HKDF(prk, "…/aes")
 *           roomHash = HKDF(prk, "…/room")   -> sent
 *
 *   LOCKED  prk       = PBKDF2(PIN, "realtimeclipboard-lock-v1:" + KEY, 600k)
 *           aesKey    = HKDF(prk, "…/aes")
 *           roomHash  = HKDF(prk, "…/room")   -> sent
 *           authToken = HKDF(prk, "…/auth")   -> sent, proves PIN knowledge
 *
 * The room hash requiring the PIN is the load-bearing part: it turns "you cannot
 * read it" into "you cannot find it". Someone holding the link but not the PIN
 * computes a different room hash and never appears in the real room at all — no
 * peer slot, no roster entry, no traffic metadata. Locked and unlocked rooms of
 * the same key are disjoint for the same reason. See PRD §7.3.
 */

import { CRYPTO } from "./config.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Derivation is expensive (OI-8), so cache per key for the session. */
let cached = { id: null, open: null };

/**
 * Bumped by clearCache(). A derivation that was already in flight when the user
 * left the room resolves afterwards, and storing its result would put the AES
 * key of a room they walked out of back into the cache the purge just emptied.
 */
let generation = 0;

/**
 * Both outputs of an open session, from one PBKDF2.
 *
 * Several hundred ms on a low-end Android, so call once per session and show an
 * "unlocking" state — never per message. It is not a new cost: the room hash was
 * always awaited alongside this derivation before the connection opened, so the
 * slower of the two already set the pace.
 *
 * Returning them together is deliberate. Two exported functions is what let the
 * room hash be computed by a route that never ran the PBKDF2, which is exactly
 * how it ended up being a bare SHA-256 of the key.
 */
export async function deriveOpen(key) {
  if (cached.id === `open:${key}` && cached.open) return cached.open;
  const gen = generation;

  const material = await crypto.subtle.importKey(
    "raw", enc.encode(key), "PBKDF2", false, ["deriveBits"]
  );
  const prk = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(CRYPTO.SALT),
      iterations: CRYPTO.ITERATIONS, hash: "SHA-256" },
    material,
    256
  );

  const open = await expand(prk, CRYPTO.OPEN_INFO);
  if (gen === generation) cached = { id: `open:${key}`, open };
  return open;
}

/* ---- locked sessions ---- */

/**
 * The exact opposite of what normalise() does to a key, and getting it backwards
 * is silent.
 *
 *   - NFC is mandatory. "é" as one code point and as "e" + combining accent are
 *     different byte strings deriving different rooms, and nothing reports it —
 *     the second device is simply alone, looking like a wrong PIN.
 *   - Trim the ends: a pasted trailing space is invisible on screen.
 *   - Keep case and the middle. A PIN is never read aloud and retyped, so
 *     uppercasing would throw away a bit per letter to buy nothing.
 */
export function normalisePin(raw) {
  return String(raw ?? "").normalize("NFC").trim();
}

/**
 * One PBKDF2, three outputs. PBKDF2 reruns its full iteration count per 32-byte
 * block, so asking it for 64 bytes would cost double; stretch once and expand
 * with HKDF, which is a couple of HMACs.
 *
 * The share key as salt stops ONE table covering every session — the open path,
 * with its single global salt, has exactly that weakness. It buys nothing
 * against the attacker this feature is for: someone holding the link can compute
 * the salt. Only PIN length and iteration count defend there, which is why the
 * dialog reports entropy in bits rather than calling a short PIN "secure".
 *
 * Returns `prk` as hex so a refresh can skip the 600k iterations.
 */
export async function deriveLocked(key, pin) {
  const prk = await stretch(key, normalisePin(pin));
  return { ...(await expand(prk, CRYPTO.LOCK_INFO)), prk: hex(new Uint8Array(prk)) };
}

/** Same outputs, from a remembered prk. No PBKDF2, so this is instant. */
export async function deriveLockedFromPrk(prkHex) {
  return { ...(await expand(unhex(prkHex), CRYPTO.LOCK_INFO)), prk: prkHex };
}

async function stretch(key, pin) {
  const material = await crypto.subtle.importKey(
    "raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(CRYPTO.LOCK_SALT + key),
      iterations: CRYPTO.LOCK_ITERATIONS, hash: "SHA-256" },
    material,
    256
  );
}

/**
 * Shared by both paths, which is the point: the open and locked sessions differ
 * only in what they stretch and under which domain-separation strings, never in
 * how the outputs are pulled off the PRK. `AUTH` is absent from OPEN_INFO — an
 * unlocked room has no PIN to prove knowledge of — and its absence is what makes
 * the token optional rather than a flag.
 */
async function expand(prk, labels) {
  const ikm = await crypto.subtle.importKey("raw", prk, "HKDF", false, ["deriveBits", "deriveKey"]);
  const info = i => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(i) });
  const bits = i => crypto.subtle.deriveBits(info(i), ikm, CRYPTO.ROOM_HASH_BYTES * 8);

  const [aesKey, room, auth] = await Promise.all([
    crypto.subtle.deriveKey(
      info(labels.AES), ikm,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    ),
    bits(labels.ROOM),
    labels.AUTH ? bits(labels.AUTH) : null,
  ]);

  return {
    aesKey,
    roomHash: hex(new Uint8Array(room)),
    ...(auth ? { authToken: hex(new Uint8Array(auth)) } : {}),
  };
}

// No locked-session cache on purpose: the path runs once per session, and the
// things that DO call it again — a corrected PIN, a rotated key — are exactly
// where the previous answer must not be reused. The stored prk covers refresh.

/** -> {payload, iv} both base64. A fresh IV per message is mandatory for GCM. */
export async function encrypt(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aesKey, enc.encode(plaintext)
  );
  return { payload: toB64(buf), iv: toB64(iv) };
}

export async function decrypt(aesKey, payloadB64, ivB64) {
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) }, aesKey, fromB64(payloadB64)
  );
  return dec.decode(buf);
}

// Called on leaving a session and on rotating the key. This had no callers for
// years, so the AES key of a room you walked out of stayed live until you opened
// another one.
export function clearCache() {
  generation++;
  cached = { id: null, open: null };
}

/* ---- hex helpers ---- */
function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

/* ---- base64 helpers (binary-safe) ---- */
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));   // chunked: avoids arg limit
  }
  return btoa(s);
}
function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
