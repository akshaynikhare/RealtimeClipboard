/**
 * Every tunable constant. Nothing else in the app hard-codes a limit —
 * if you find a magic number elsewhere, it belongs here.
 */

import { IS_DESKTOP } from "./native.js";

// Guarded: imported by node tests where `location` does not exist, and a bare
// reference would throw at import time and take the whole graph down.
const IS_LOCAL = typeof location !== "undefined" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/**
 * Must be wss:// in production — a browser refuses ws:// from an https:// page
 * as mixed content. Localhost is exempt, which is why dev can stay ws://.
 * Self-hosters change this one line.
 */
export const DEFAULT_RELAY_URL = "wss://realtimeclipboard.fastapicloud.dev";
const LOCAL_RELAY_URL = "ws://127.0.0.1:8000";

/**
 * The storage prefix lives here rather than in core/storage.js so this module
 * can read a setting without importing storage.js — which imports this one, and
 * a cycle between "every constant" and "the thing that persists them" works
 * until someone moves a line to module scope.
 */
export const STORAGE_PREFIX = "realtimeclipboard.";
const RELAY_KEY = "relayUrl";

/**
 * `http(s)://` is accepted and converted, because that is what a person copies
 * out of a browser bar when IT gives them an address.
 */
export function normaliseRelay(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    const scheme = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" }[u.protocol];
    if (!scheme) return null;
    // Path, query and hash are meaningless here — the routes are fixed (/ws,
    // /sse, /pub, /health) and a trailing slash would produce "//ws/<room>".
    return `${scheme}//${u.host}`;
  } catch { return null; }
}

const stored = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + RELAY_KEY)); }
  catch { return null; }
};

/**
 * `?relay=` for builds that are deployed rather than visited: an MSI transform,
 * a config profile, a desktop shell launching the webview at its own relay. It
 * wins over the stored setting because the deployment is more current, and
 * main.js persists it so the switch survives the next launch.
 *
 * NOT an attack surface on the hosted site: the CSP pins `connect-src` to this
 * origin and the default relay, so a link carrying `?relay=` elsewhere cannot
 * open a connection. The CSP is the enforcement; this is only the plumbing.
 */
const fromQuery = () => {
  try { return new URLSearchParams(location.search).get("relay"); }
  catch { return null; }
};

export const RELAY_URL =
  normaliseRelay(fromQuery())
  ?? normaliseRelay(stored())
  ?? (IS_LOCAL ? LOCAL_RELAY_URL : DEFAULT_RELAY_URL);

/** True when the app is not talking to the relay it was built against. */
export const RELAY_IS_CUSTOM = RELAY_URL !== DEFAULT_RELAY_URL && RELAY_URL !== LOCAL_RELAY_URL;

/**
 * The same relay over plain HTTP, for the SSE+POST fallback and /stats. One
 * hostname, two ways in, so IT allowlists a single domain (PRD §5.4) and both
 * transports are covered. Derived so the two can never drift.
 */
export const RELAY_HTTP_URL = RELAY_URL.replace(/^ws/i, "http");

/**
 *   ws   — WebSocket. Lower latency, one connection, the default.
 *   sse  — Server-Sent Events down + fetch POST up (PRD §4.3 R3). Plain HTTP
 *          with no Upgrade, so it survives the TLS-inspecting proxies that eat
 *          WebSockets on corporate networks (§5.4).
 *
 * Both carry the identical envelopes from §6 — see transport/protocol.js.
 */
export const TRANSPORT = { WS: "ws", SSE: "sse" };

/**
 * Clip size, derived — not chosen.
 *
 * A clip is UTF-8 encoded, sealed with AES-GCM (16-byte tag), base64'd and put
 * in a JSON envelope, and the relay rejects any frame over MAX_FRAME_BYTES. So
 * the real limit is a BYTE budget and a character count only approximates it.
 *
 * MAX_CHARS was once 50,000 — 66 KB on the wire against a 32 KB frame — because
 * "max payload 32 KB" had been transcribed into a character count and never
 * recomputed. Every clip over ~24 KB was accepted, encrypted, sent, and dropped
 * by the relay, the rejection arriving long after the UI said it went.
 * tests/unit/clipsize.mjs proves the derivation.
 */
const RELAY_FRAME_BYTES  = 32 * 1024;   // backend/main.py MAX_FRAME_BYTES
const CLIP_ENVELOPE_BYTES = 512;        // {"t","originId","iv","payload"} + slack
const BASE64_EXPANSION    = 4 / 3;
const GCM_TAG_BYTES       = 16;

const CLIP_MAX_BYTES = Math.floor(
  (RELAY_FRAME_BYTES - CLIP_ENVELOPE_BYTES) / BASE64_EXPANSION - GCM_TAG_BYTES,
);

/**
 * Wire size of a string, exported beside the limit it is measured against so the
 * editor and the send path cannot disagree — `String.length` counts UTF-16
 * units, which is not what the relay counts.
 */
export const textBytes = (s) => new TextEncoder().encode(s).length;

export const TEXT = {
  // MAX_CHARS is what the counter shows, because users think in characters.
  // MAX_BYTES is the truth: 24,000 CJK characters are 72,000 bytes.
  MAX_BYTES: CLIP_MAX_BYTES,                          // the wire limit — authoritative
  MAX_CHARS: Math.floor(CLIP_MAX_BYTES / 1000) * 1000, // the friendly one, for the counter
  SUPPRESS_MS: 1500,          // loop-suppression window after applying a remote clip (FR-2.6)

  /**
   * Generous because the commit is invisible — the text is already on the far
   * screen via the stream, so this only decides when it becomes a clip. A
   * mid-sentence pause is 300-500 ms, and less would fragment one sentence into
   * six history entries.
   */
  COMMIT_IDLE_MS: 800,

  /** 10 sends/sec — half the relay's 20/s `stream` budget, as cursors.js does. */
  STREAM_THROTTLE_MS: 100,

  /**
   * Above this, typing is not streamed and the text syncs on commit only.
   *
   * A stream frame carries the WHOLE text, which is what lets this feature exist
   * without diffs or operational transform — a trade that only holds while the
   * text is small. The degradation is invisible because big text is pasted,
   * never typed.
   */
  STREAM_MAX_BYTES: 4096,

  /**
   * How long a local copy outranks an arriving clip. The moment that actually
   * hurts is "I copied something, went to paste it, and it was gone", so inside
   * this window the arriving clip is queued and offered instead of written.
   */
  LOCAL_COPY_GRACE_MS: 10_000,
};

/**
 * Pastejacking — see clipboard/guard.js for what is actually checked.
 *
 * The room is joinable by anyone holding the key, and an arriving clip is
 * written to the OS clipboard with no gesture from the person receiving it. So
 * a peer chooses what you paste into your next terminal.
 *
 * `ENABLED` governs only the heuristic that demands a click. Stripping the
 * trailing newline and the invisible characters is unconditional and has no
 * switch: it is not a policy, it is the difference between a clip that pastes
 * and a clip that runs.
 */
export const PASTE_GUARD = {
  ENABLED: true,

  /**
   * Past this, do not scan. The patterns are anchored per line, so a pasted
   * logfile is a lot of backtracking for a case that is not what this defends
   * against — nobody is tricked into pasting 200 KB into a shell.
   */
  MAX_SCAN_CHARS: 8_192,
};

export const FILES = {
  MAX_BYTES: 5 * 1024 * 1024, // 5 MB per file (FR-7.1)
  MAX_COUNT: 20,              // per session, memory only (FR-7.7)

  /**
   * A filename is chosen by whoever sent the file, so it is bounded like every
   * other piece of peer-supplied metadata. Long enough that no real name is
   * truncated; short enough that a hostile one is a tile, not a layout.
   * files/registry.js `safeName` applies it, along with the character rules.
   */
  MAX_NAME_CHARS: 120,
  THUMB_PX: 160,              // longest edge (FR-7.2)
  THUMB_QUALITY: 0.7,

  /**
   * For the P2P data channel, which carries raw binary. The relay fallback
   * cannot use this directly — base64 plus the tag and envelope inflate a 32 KB
   * chunk into a ~44 KB frame, past the relay's own 32 KB cap — so
   * RELAY_CHUNK_BYTES is DERIVED from this in files/chunker.js rather than being
   * a second hand-tuned number.
   */
  CHUNK_BYTES: 32 * 1024,

  /**
   * How long a file request lives before BOTH ends give up, on the same number,
   * so neither is left believing in a transfer the other abandoned. Approving
   * into a peer that gave up thirty seconds ago sends 5 MB nowhere.
   *
   * Its own constant rather than a multiple of the ICE timeout: that coupling
   * meant shortening the ICE race in a test also shortened how long a human had
   * to answer a dialog.
   */
  REQUEST_TIMEOUT_MS: 15_000,

  /**
   * How long a closed data channel gets to confirm the close.
   *
   * bufferedAmount reaching zero only means SCTP accepted the bytes, not that
   * the peer has them. The stream reset dc.close() sends is ordered behind the
   * queued data, so the close event is the nearest thing to a delivery signal.
   * Bounded, because a wedged association must not hold a transfer open.
   */
  CHANNEL_CLOSE_MS: 1_000,
};

export const KEY = {
  // Crockford-ish: no 0/O, no 1/I/L. Ambiguity here becomes a support ticket.
  ALPHABET: "23456789ABCDEFGHJKMNPQRSTVWXYZ",
  /**
   * Ten, not six. PRD D3 chose six for the phone keyboard and that argument was
   * sound about typing and wrong about arithmetic.
   *
   * The open room hash is derived through the same 250k PBKDF2 as the AES key
   * (crypto.js `deriveOpen`), so a guess costs a full derivation rather than one
   * SHA-256. But `SALT` is a single global constant, so the table an attacker
   * builds is built ONCE and then opens every unlocked session of that length,
   * for every user, for as long as the salt stands. That is the number that
   * matters, and at six characters it is ~12 minutes on 100 rented GPUs:
   *
   *     6 chars   7.3e8 keys       12 min on 100 GPUs      29.4 bits
   *    10 chars   5.9e14 keys      19 years on 100 GPUs    49.1 bits
   *    16 chars   5.3e23 keys      out of reach            78.5 bits
   *
   * Six is therefore not a preference, it is a defect, and no iteration count
   * fixes a keyspace. Typing cost is paid once per session and only when someone
   * declines the QR code and the copied link, both of which are in front of it.
   */
  LENGTH: 10,
  LONG_LENGTH: 16,            // "high security" option, PRD §7.3

  /**
   * An installed app links a device by QR or copied link, so it does not pay the
   * typing cost at all — and it is the surface running all day reading every
   * copy, which is the one that should take the longer option.
   */
  DEFAULT_LONG: IS_DESKTOP,
};

export const CRYPTO = {
  SALT: "realtimeclipboard-v1",
  ITERATIONS: 250_000,        // PBKDF2; derive once per session and cache (OI-8)
  ROOM_HASH_BYTES: 16,

  /**
   * One PBKDF2 run, two outputs — see crypto.js `deriveOpen`.
   *
   * The room hash used to be `SHA-256("realtimeclipboard:" + KEY)`: unsalted,
   * unstretched, and the one value the relay holds by construction. Anyone with
   * it could sweep the whole 6-character keyspace in 0.07s and read back the
   * key, which made the 250k iterations on the AES key worth exactly one
   * derivation to an attacker. Deriving both from the same PRK costs nothing —
   * that PBKDF2 was already being awaited before the connection opened.
   */
  OPEN_INFO: {
    AES:  "realtimeclipboard/aes",
    ROOM: "realtimeclipboard/room",
  },

  /**
   * The lock salt is a PREFIX, completed with the share key — random per
   * session, which is what a salt is for. The open-session salt above is one
   * global constant, so a single precomputed table covers every user on earth;
   * KEY.LENGTH is what has to make that table too large to build.
   *
   * 600k rather than 250k because the threat differs: a locked session's secret
   * is a PIN held by someone who may already have the link, so the PIN is the
   * whole defence and every doubling doubles their cost. Paid once per session.
   */
  LOCK_SALT: "realtimeclipboard-lock-v1:",
  LOCK_ITERATIONS: 600_000,

  /** One PBKDF2 run, three independent outputs — see crypto.js `deriveLocked`. */
  LOCK_INFO: {
    AES:  "realtimeclipboard-lock/aes",
    ROOM: "realtimeclipboard-lock/room",
    AUTH: "realtimeclipboard-lock/auth",
  },
};

/**
 * Locked sessions: the share key in the link, a PIN that never travels with it.
 *
 * The key is a bearer credential (PRD §7.1) and links get forwarded,
 * screenshotted and pasted into group chats. MIN_PIN is 6 and free-form rather
 * than 4-6 digits because against someone who already has the link the key
 * contributes nothing: a 4-digit PIN is ~13 bits, minutes of offline guessing.
 */
export const LOCK = {
  MIN_PIN: 6,

  /**
   * Fragment marker: `#!ABCDEF`. Leading rather than trailing — chat clients
   * that trim punctuation off a pasted URL trim the END of it.
   */
  SIGIL: "!",

  /**
   * Sent once on creating a locked room and replayed to every joiner, so a
   * joiner can tell "wrong PIN" from "first one here" by whether it decrypts.
   * Receivers drop it instead of rendering it.
   */
  BEACON: String.fromCharCode(0) + "realtimeclipboard-lock-v1",

  /**
   * Sent into the room being ABANDONED when a session is locked.
   *
   * Locking is a room change: the locking device leaves for a new room and
   * everyone else is left behind, connected, in sync with nobody, unable to tell
   * that from a quiet afternoon. This sentinel is the goodbye.
   *
   * A clip rather than a new frame type, like BEACON — it needs no relay change
   * and is sealed with the room key, so the relay forwards what it cannot read.
   * It overwrites the room's retained last clip deliberately, so a late joiner
   * to the dead room is told the session moved.
   */
  EVICT: String.fromCharCode(0) + "realtimeclipboard-lock-evict-v1",

  /**
   * How long the goodbye gets to leave before the socket is torn down. Not
   * paranoia about buffering: the SSE fallback batches upstream frames into a
   * POST and its close() drops whatever is queued, so closing in the same tick
   * would send the sentinel to nobody on exactly the network using the fallback.
   */
  EVICT_FLUSH_MS: 250,
};

export const NET = {
  HEARTBEAT_MS: 30_000,       // must beat proxy idle reaping (PRD 5.4, FR-3.6)
  BACKOFF_MIN_MS: 1_000,
  BACKOFF_MAX_MS: 30_000,
  ICE_TIMEOUT_MS: 5_000,      // then fall back to relay chunks (FR-7.6)

  /**
   * A blocked WebSocket frequently does NOT fail: an intercepting proxy accepts
   * the TCP connection, swallows the Upgrade, and leaves the socket hanging with
   * no open, no close and no error. Without this timer the app sits on
   * "Connecting…" forever and never tries the fallback.
   *
   * Generous enough to survive a scale-to-zero cold start (PRD R2).
   */
  PROBE_MS: 8_000,

  /**
   * Two, not one: a single failure is more often a cold start than a policy, and
   * switching on it would put users on the slower path for no reason.
   */
  SWITCH_AFTER: 2,

  /** Frames per upstream POST, and the byte budget for one (SSE path). */
  POST_MAX_FRAMES: 16,
  POST_MAX_BYTES: 256 * 1024,

  /** How long the remembered transport choice is trusted. */
  TRANSPORT_MEMORY_MS: 12 * 60 * 60 * 1000,
};

export const POLL_OPTIONS = { "Off": 0, "500ms": 500, "1s": 1000, "2s": 2000 };

/**
 * How far the sync reaches on THIS device. One ladder, three rungs, each adding
 * exactly one thing to the one below:
 *
 *   off    — nothing leaves and nothing arrives. The editor is private again.
 *   manual — the session syncs in the app window; the OS clipboard is neither
 *            read nor written.
 *   live   — the OS clipboard is wired to the room in both directions.
 *
 * The stored strings are a compatibility surface: "live" and "manual" are on
 * disk for every existing user, and relabelling the UI is free while renaming
 * these silently resets the one preference where being wrong matters most.
 * Change the labels in ui/features/syncMode.js instead — they read
 * Off / App / Clipboard, naming the destination rather than a manner of working.
 */
export const SYNC_MODES = {
  OFF: "off",
  MANUAL: "manual",
  LIVE: "live",
};
export const DEFAULT_SYNC_MODE = SYNC_MODES.LIVE;

/** Does this rung let the OS clipboard be read or written? */
export const bindsClipboard = (mode) => mode === SYNC_MODES.LIVE;

/** Does this rung put anything on the wire at all? */
export const sharesSession = (mode) => mode !== SYNC_MODES.OFF;

/**
 * The public address of the hosted app, for the one job `location` cannot do:
 * build a link for somebody else to open.
 *
 * The desktop shell serves this same tree from `http://tauri.localhost`
 * (`tauri://localhost` off Windows) and `cli/` has no `location` at all, so a
 * share link built from the current URL there names a host that resolves inside
 * that one process and nowhere else — the copied link and the QR code both
 * pointed at an address no other device could reach. keys.shareLink() falls back
 * to this; a browser still links to itself, so a localhost dev pair and a
 * self-hosted deploy keep pointing at themselves.
 *
 * `/app`, not `/app.html`: the extensionless path is what the deploy publishes
 * (the PRETTY rewrite in tools/build/build.mjs), and Pages 308s the `.html` form
 * onto it — carrying the fragment, but through a redirect nobody needs to take.
 */
const SITE_ORIGIN = "https://realtimeclipboard.com";

export const SITE = {
  ORIGIN: SITE_ORIGIN,
  HOST: SITE_ORIGIN.replace(/^https?:\/\//, ""),   // what the guide tells you to type
  APP_URL: `${SITE_ORIGIN}/app`,
};

/**
 * Derived from OWNER/NAME rather than written out four times, so a fork, rename
 * or moved account is one edit and the links cannot drift apart.
 *
 * Re-check the sponsors page if the account ever moves — a donate link that 404s
 * costs more goodwill than no donate link, and .github/FUNDING.yml is the same
 * destination and has to move with it.
 */
export const REPO = {
  OWNER: "akshaynikhare",
  NAME: "RealtimeClipboard",
};

const GITHUB = `https://github.com/${REPO.OWNER}/${REPO.NAME}`;

export const LINKS = {
  REPO:    GITHUB,
  ISSUES:  `${GITHUB}/issues`,
  /**
   * The chooser, not a blank issue: `/new/choose` picks between the forms in
   * .github/ISSUE_TEMPLATE/, which is where the "do not paste your share key"
   * warning lives — the single most valuable thing on the page for this product.
   */
  NEW_ISSUE: `${GITHUB}/issues/new/choose`,
  SPONSOR: `https://github.com/sponsors/${REPO.OWNER}`,
  /**
   * The full changelog for a reader who is NOT in this origin. The web app links
   * its own precached copy — offline, and the same file the build shipped — but
   * the desktop shell's copy sits on `tauri.localhost`, an address that means
   * nothing in the browser the link opens in. See ui/features/whatsNew.js.
   */
  CHANGELOG: `${GITHUB}/blob/main/CHANGELOG.md`,
};

export const IMAGES = {
  /** Clipboard image types we will read and share. */
  TYPES: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  /** Named so a received screenshot does not land as "blob" on disk. */
  NAME_PREFIX: "clipboard-image",
};

/**
 * The phone breakpoint. Every media query in `styles/` is matched to it by
 * hand, because CSS cannot read this file; what lives here is the copy the
 * JavaScript uses. Three modules each carried their own string of it, and a
 * module that disagrees with the stylesheet renders for a layout that is not
 * on screen.
 */
const NARROW_MAX = 900;

export const LAYOUT = {
  NARROW_MAX,
  NARROW_MQ: `(max-width:${NARROW_MAX}px)`,
};

/**
 * Google Analytics and AdSense.
 *
 * Empty by default and every consumer no-ops on empty, so a fork, a local
 * checkout and a self-hosted deploy load no third-party script at all. Filling
 * these in is the switch that turns tracking and ads on for a build.
 *
 * !! Analytics and AdSense both load everywhere, app.html included (the
 * no-ads-in-the-app rule was removed 2026-08-09). The ad tag reports the page
 * URL itself with no override, so the rule that survives is TIMING:
 * ui/features/ads.js must never load it while the share key is still in
 * `location.hash` — it waits for boot to strip the fragment (keys.clearUrl)
 * before the first ad request. gtag takes `page_location` from us, and
 * `pageLocation()` below keeps the fragment out of that too. !!
 *
 * Adding an origin means adding it to the CSP in _headers AND in every page's
 * meta tag — app.html's included — which tools/check/site-check.mjs asserts
 * agree.
 */
export const GOOGLE = {
  /** GA4 measurement ID, "G-XXXXXXXXXX". Admin → Data streams → your stream. */
  GA4_ID: "G-259V6H3K5M",
  /** AdSense publisher ID, "ca-pub-################". Account → Settings. */
  ADSENSE_CLIENT: "ca-pub-6053041142492498",
  /**
   * Per-unit slot IDs, the 10-digit number AdSense prints as `data-ad-slot`
   * when you create a unit. One per placement, and a unit renders nothing
   * until its own ID is filled in.
   */
  ADSENSE_SLOTS: {
    /** index.html, the 728×90 after "how it works". */
    LEADERBOARD: "7038244690",
    /** index.html, the 300×600 rail beside the FAQ. */
    RAIL: "8299355473",
    /**
     * app.html, the unit under the editor. Mounted by ui/features/ads.js
     * only once the share key has left the URL — see the note on GOOGLE.
     */
    APP: "6948680552",
  },
  /**
   * What that slot asks for, per layout.
   *
   * NARROW is requested as a FIXED unit rather than a responsive one, because
   * the slot sits `flex:none` under an editor that is `flex:1`: every pixel it
   * takes comes straight out of the textarea. `data-full-width-responsive`
   * answered a 390px phone with a ~300px creative and left no editor at all.
   * WIDE is the responsive unit's usual size and is only what the placeholder
   * claims — that column is drag-resizable, so it is not requested as a fixed
   * one.
   */
  ADSENSE_APP_UNIT: {
    NARROW: { W: 320, H: 50 },
    WIDE:   { W: 728, H: 90 },
  },
};

/** Nothing loads unless the ID that drives it is present. */
export const analyticsEnabled = () => Boolean(GOOGLE.GA4_ID);
export const adsEnabled = () => Boolean(GOOGLE.ADSENSE_CLIENT);

/**
 * Consent Mode v2 starts denied in these jurisdictions and stays denied until
 * the CMP says otherwise; everywhere else the tags behave normally. EEA, plus
 * the UK and Switzerland.
 */
export const CONSENT_REGIONS = [
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB",
  "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT", "NL", "NO",
  "PL", "PT", "RO", "SE", "SI", "SK",
];

/**
 * The page URL with the fragment removed, for `page_location`.
 *
 * !! app.html carries the share key in `location.hash`, and gtag's default
 * `page_location` is `location.href`. The unmodified tag would therefore send
 * the key to Google on the first page_view — the one thing this project
 * promises never leaves the browser. Every gtag config passes this instead. !!
 */
export const pageLocation = () =>
  typeof location === "undefined" ? "" : location.origin + location.pathname + location.search;

export const GOOGLE_SRC = {
  gtag: (id) => `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`,
  adsense: (client) =>
    `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`,
};
