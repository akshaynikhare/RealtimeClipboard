/**
 * Every tunable constant. A magic number anywhere else is a bug.
 */

import { IS_INSTALLED, IS_DESKTOP } from "./native.js";

// Guarded: node tests import this and have no `location`; a bare reference
// throws at import time and takes the whole graph down.
const IS_LOCAL = typeof location !== "undefined" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/**
 * Must be wss:// in production — a browser refuses ws:// from https:// as mixed
 * content. Localhost is exempt. Self-hosters change this one line.
 */
export const DEFAULT_RELAY_URL = "wss://realtimeclipboard.fastapicloud.dev";
const LOCAL_RELAY_URL = "ws://127.0.0.1:8000";

/**
 * Here rather than in core/storage.js so this module can read a setting without
 * importing storage.js, which imports this one. The cycle works until someone
 * moves a line to module scope.
 */
export const STORAGE_PREFIX = "realtimeclipboard.";
const RELAY_KEY = "relayUrl";

/** `http(s)://` is converted, because that is what IT hands someone to paste. */
export function normaliseRelay(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    const scheme = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" }[u.protocol];
    if (!scheme) return null;
    // The routes are fixed (/ws, /sse, /pub, /health) and a trailing slash would
    // produce "//ws/<room>".
    return `${scheme}//${u.host}`;
  } catch { return null; }
}

const stored = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + RELAY_KEY)); }
  catch { return null; }
};

/**
 * For builds that are deployed rather than visited — an MSI transform, a config
 * profile, a desktop shell. Beats the stored setting because the deployment is
 * more current; main.js persists it so it survives the next launch.
 *
 * Not an attack surface on the hosted site: the CSP pins `connect-src` to this
 * origin and the default relay, so `?relay=` elsewhere cannot connect.
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
 * The organisation token for a relay that runs with REALTIMECLIPBOARD_JOIN_TOKEN set.
 *
 * Such a relay refuses every join that does not present `?org=`, and no client
 * had any way to send one — so turning the setting on, which SELF-HOSTING.md
 * tells operators to do to stop their relay being open to anyone who learns the
 * hostname, bricked every shipped client instead of restricting it.
 *
 * Deliberately NOT in the share link: a link is pasted into chats and read off
 * screens, and this is the credential that admits a device to the deployment.
 * It is configured once per device — `?org=` on first load, which is persisted,
 * or REALTIMECLIPBOARD_ORG for the CLI and MCP server.
 */
const ORG_KEY = "orgToken";

/** The query parameter that carries it. Named once — safeSearch() strips it. */
export const ORG_PARAM = "org";
const storedOrg = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + ORG_KEY)); }
  catch { return null; }
};
const orgFromQuery = () => {
  try { return new URLSearchParams(location.search).get(ORG_PARAM); }
  catch { return null; }
};
const orgFromEnv = () => {
  try { return globalThis.process?.env?.REALTIMECLIPBOARD_ORG || null; }
  catch { return null; }
};
const cleanOrg = v => (typeof v === "string" && v.trim() ? v.trim() : null);

export const ORG_TOKEN = cleanOrg(orgFromQuery()) ?? cleanOrg(orgFromEnv()) ?? cleanOrg(storedOrg());
export const ORG_STORAGE_KEY = ORG_KEY;

/**
 * The same relay over plain HTTP, for the SSE+POST fallback and /stats. One
 * hostname so IT allowlists one domain (PRD §5.4); derived so the two cannot drift.
 */
export const RELAY_HTTP_URL = RELAY_URL.replace(/^ws/i, "http");

/**
 *   ws   — lower latency, one connection, the default.
 *   sse  — SSE down + fetch POST up (PRD §4.3 R3). No Upgrade, so it survives the
 *          TLS-inspecting proxies that eat WebSockets on corporate networks (§5.4).
 *
 * Both carry the identical envelopes — see transport/protocol.js.
 */
export const TRANSPORT = { WS: "ws", SSE: "sse" };

/**
 * Clip size, derived — not chosen. A clip is UTF-8, AES-GCM sealed, base64'd and
 * JSON-wrapped, and the relay drops any frame over MAX_FRAME_BYTES, so the real
 * limit is a byte budget that a character count only approximates.
 *
 * MAX_CHARS was once 50,000 — 66 KB against a 32 KB frame — because "32 KB" had
 * been transcribed as a character count. Every clip over ~24 KB was encrypted,
 * sent and dropped, the rejection arriving long after the UI said it went.
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
 * Exported beside the limit it is measured against so the editor and the send
 * path cannot disagree — `String.length` counts UTF-16 units, not wire bytes.
 */
export const textBytes = (s) => new TextEncoder().encode(s).length;

export const TEXT = {
  MAX_BYTES: CLIP_MAX_BYTES,                          // the wire limit — authoritative
  MAX_CHARS: Math.floor(CLIP_MAX_BYTES / 1000) * 1000, // shown in the counter; 24,000 CJK chars are 72,000 bytes
  SUPPRESS_MS: 1500,          // loop-suppression window after applying a remote clip (FR-2.6)

  /**
   * Generous because the text is already on the far screen via the stream — this
   * only decides when it becomes a clip. A mid-sentence pause is 300-500 ms, and
   * less would fragment one sentence into six history entries.
   */
  COMMIT_IDLE_MS: 800,

  /** 10 sends/sec — half the relay's 20/s `stream` budget, as cursors.js does. */
  STREAM_THROTTLE_MS: 100,

  /**
   * Above this, typing syncs on commit only. A stream frame carries the WHOLE
   * text, which is what lets this exist without diffs or OT — a trade that holds
   * only while the text is small. Invisible, because big text is pasted.
   */
  STREAM_MAX_BYTES: 4096,

  /**
   * How long a local copy outranks an arriving clip. "I copied something, went to
   * paste it, and it was gone" is the moment that hurts, so inside this window
   * the arriving clip is queued and offered instead of written.
   */
  LOCAL_COPY_GRACE_MS: 10_000,
};

/**
 * Pastejacking — clipboard/guard.js does the checking. The room is joinable by
 * anyone holding the key and an arriving clip reaches the OS clipboard with no
 * gesture, so a peer chooses what you paste into your next terminal.
 *
 * ENABLED governs only the heuristic that demands a click. Stripping the trailing
 * newline and the invisible characters is unconditional: not a policy, the
 * difference between a clip that pastes and a clip that runs.
 */
export const PASTE_GUARD = {
  ENABLED: true,

  /**
   * The longest LINE the scanner will look at. Every pattern is anchored to the
   * start of a line and none spans one, so the scan runs per line and this
   * bounds the work any single regex does.
   *
   * A line past it is treated as risky rather than safe. This was once a cap on
   * the whole clip, above which nothing was scanned at all — and it sat below
   * the clip size limit, so padding a command past it turned the guard off.
   */
  MAX_SCAN_CHARS: 8_192,
};

export const FILES = {
  MAX_BYTES: 5 * 1024 * 1024, // 5 MB per file (FR-7.1)
  MAX_COUNT: 20,              // per session, memory only (FR-7.7)

  /**
   * Peer-supplied, so bounded like every other piece of peer metadata. Long
   * enough that no real name truncates, short enough that a hostile one is a
   * tile rather than a layout. files/registry.js `safeName` applies it.
   */
  MAX_NAME_CHARS: 120,
  THUMB_PX: 160,              // longest edge (FR-7.2)
  THUMB_QUALITY: 0.7,

  /**
   * For the P2P data channel, which carries raw binary. The relay fallback
   * cannot reuse it — base64 plus tag and envelope inflate 32 KB into ~44 KB,
   * past the relay's own cap — so files/chunker.js derives RELAY_CHUNK_BYTES
   * from this rather than hand-tuning a second number.
   */
  CHUNK_BYTES: 32 * 1024,

  /**
   * How long a file request lives before BOTH ends give up, on the same number,
   * so neither believes in a transfer the other abandoned. Its own constant
   * rather than a multiple of the ICE timeout: that coupling meant shortening
   * the ICE race in a test also shortened how long a human had to answer.
   */
  REQUEST_TIMEOUT_MS: 15_000,

  /**
   * bufferedAmount hitting zero means SCTP accepted the bytes, not that the peer
   * has them. dc.close()'s stream reset is ordered behind the queued data, so the
   * close event is the nearest thing to a delivery signal. Bounded, because a
   * wedged association must not hold a transfer open.
   */
  CHANNEL_CLOSE_MS: 1_000,

  /**
   * How long a sender waits for the receiver to confirm it has the file, whole
   * and verified, before reporting what it actually knows.
   *
   * "Sent" used to mean "the last frame was handed to a socket". A digest
   * failure at the far end was reported to nobody, so the holder's tile said
   * the transfer had worked while the other device showed an error. Bounded,
   * because a receiver that vanishes must not leave a progress bar up forever.
   */
  RECEIPT_MS: 10_000,
};

export const KEY = {
  // Crockford-ish: no 0/O, no 1/I/L. Ambiguity here becomes a support ticket.
  ALPHABET: "23456789ABCDEFGHJKMNPQRSTVWXYZ",
  /**
   * Ten, not the six PRD D3 chose — that argument was sound about phone typing
   * and wrong about arithmetic. The open room hash goes through the same 250k
   * PBKDF2 as the AES key, but `SALT` is one global constant, so the table an
   * attacker builds is built ONCE and opens every unlocked session of that
   * length, for everyone, for as long as the salt stands:
   *
   *     6 chars   7.3e8 keys    12 min on 100 GPUs     29.4 bits
   *    10 chars   5.9e14 keys   19 years on 100 GPUs   49.1 bits
   *    16 chars   5.3e23 keys   out of reach           78.5 bits
   *
   * So six is a defect, not a preference, and no iteration count fixes a
   * keyspace. Typing is paid once per session, and only by someone who declined
   * both the QR code and the copied link.
   */
  LENGTH: 10,
  LONG_LENGTH: 16,            // "high security" option, PRD §7.3

  /**
   * The floor for a key we will HASH, as opposed to one we produce.
   *
   * Validation is deliberately more permissive than generation — a key from an
   * older build has to keep working, and no build ever emitted fewer than six.
   * But it used to accept four, which is ~19.6 bits: the whole keyspace is
   * 810,000 rooms, and the relay will happily route any of them. Someone typing
   * `#F5H4` into the address bar got a session that a laptop can enumerate,
   * with nothing on screen saying so.
   *
   * Six is the floor rather than ten because six is what earlier builds handed
   * out, and stranding those links is a worse failure than a weak room the
   * holder chose. New keys are still KEY.LENGTH.
   */
  MIN_LENGTH: 6,
  MAX_LENGTH: 32,

  /**
   * An installed app links by QR or link and never pays the typing cost — and it
   * is the surface reading every copy all day, so it takes the longer option.
   */
  DEFAULT_LONG: IS_INSTALLED,
};

export const CRYPTO = {
  SALT: "realtimeclipboard-v1",
  ITERATIONS: 250_000,        // PBKDF2; derive once per session and cache (OI-8)
  ROOM_HASH_BYTES: 16,

  /**
   * One PBKDF2 run, two outputs — see crypto.js `deriveOpen`.
   *
   * The room hash used to be unsalted, unstretched SHA-256, and it is the one
   * value the relay holds by construction: anyone with it could sweep the whole
   * 6-character keyspace in 0.07s and read back the key, making the 250k
   * iterations worth one derivation to an attacker. Sharing the PRK costs
   * nothing — that PBKDF2 was already awaited before the connection opened.
   */
  OPEN_INFO: {
    AES:  "realtimeclipboard/aes",
    ROOM: "realtimeclipboard/room",
  },

  /**
   * A PREFIX, completed with the share key — so it is random per session, which
   * is what a salt is for. The open-session salt above is one global constant,
   * and KEY.LENGTH is what keeps its precomputed table too large to build.
   *
   * 600k rather than 250k because the threat differs: a locked session's secret
   * is a PIN held by someone who may already have the link, so the PIN is the
   * whole defence and every doubling doubles their cost.
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
 * MIN_PIN is 6 and free-form rather than 4-6 digits because against someone who
 * already has the link — and links get forwarded, screenshotted and pasted into
 * group chats — the key contributes nothing. A 4-digit PIN is ~13 bits.
 */
export const LOCK = {
  MIN_PIN: 6,

  /**
   * Fragment marker: `#!ABCDEF`. Leading rather than trailing — chat clients that
   * trim punctuation off a pasted URL trim the END of it.
   */
  SIGIL: "!",

  /**
   * Sent on creating a locked room and replayed to joiners, so a joiner can tell
   * "wrong PIN" from "first one here" by whether it decrypts. Receivers drop it.
   */
  BEACON: String.fromCharCode(0) + "realtimeclipboard-lock-v1",

  /**
   * The goodbye sent into the room being ABANDONED. Locking is a room change: the
   * locking device leaves and everyone else is left connected, in sync with
   * nobody, unable to tell that from a quiet afternoon.
   *
   * A clip rather than a new frame type, like BEACON — no relay change, and
   * sealed with the room key. It overwrites the room's retained last clip
   * deliberately, so a late joiner is told the session moved.
   */
  EVICT: String.fromCharCode(0) + "realtimeclipboard-lock-evict-v1",

  /**
   * How long the goodbye gets to leave. Not buffering paranoia: the SSE fallback
   * batches upstream frames into a POST and close() drops the queue, so closing
   * in the same tick would send the sentinel to nobody on exactly the network
   * that needs the fallback.
   */
  EVICT_FLUSH_MS: 250,
};

export const NET = {
  HEARTBEAT_MS: 30_000,       // must beat proxy idle reaping (PRD 5.4, FR-3.6)

  /**
   * How long a ping may go unanswered before the connection is treated as dead.
   *
   * A socket can sit at readyState OPEN with nothing at the other end: no
   * error, no close, and the session reads "connected" for as long as the tab
   * is left open. The ping had no deadline at all, so nothing ever noticed.
   * Generous against a slow phone network, short enough that a dead session
   * reconnects rather than sits.
   */
  PONG_DEADLINE_MS: 10_000,
  BACKOFF_MIN_MS: 1_000,
  BACKOFF_MAX_MS: 30_000,
  ICE_TIMEOUT_MS: 5_000,      // then fall back to relay chunks (FR-7.6)

  /**
   * A blocked WebSocket frequently does not fail: the proxy accepts the TCP
   * connection, swallows the Upgrade, and leaves the socket hanging with no open,
   * no close and no error. Without this the app sits on "Connecting…" forever and
   * never tries the fallback. Generous enough for a cold start (PRD R2).
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
 * How far the sync reaches on THIS device. One ladder, each rung adding exactly
 * one thing to the one below:
 *
 *   off    — nothing leaves and nothing arrives.
 *   manual — the session syncs in the app window; the OS clipboard is untouched.
 *   live   — the OS clipboard is wired to the room in both directions.
 *
 * The stored strings are a compatibility surface: they are on disk for every
 * existing user, so renaming them silently resets the one preference where being
 * wrong matters most. Relabel in ui/features/syncMode.js instead.
 */
export const SYNC_MODES = {
  OFF: "off",
  MANUAL: "manual",
  LIVE: "live",
};
export const DEFAULT_SYNC_MODE = SYNC_MODES.LIVE;

/**
 * Appearance. `SYSTEM` means "do not decide" — no attribute is stamped and
 * styles/tokens.css answers `prefers-color-scheme` on its own, which is also
 * what renders before any of this JavaScript has run.
 *
 * The stored strings are a compatibility surface like SYNC_MODES: relabel the
 * UI, never the values.
 */
export const THEMES = {
  SYSTEM: "system",
  LIGHT: "light",
  DARK: "dark",
};
export const DEFAULT_THEME = THEMES.SYSTEM;

/** Does this rung let the OS clipboard be read or written? */
export const bindsClipboard = (mode) => mode === SYNC_MODES.LIVE;

/** Does this rung put anything on the wire at all? */
export const sharesSession = (mode) => mode !== SYNC_MODES.OFF;

/**
 * The public address of the hosted app, for the one job `location` cannot do:
 * build a link for somebody else to open.
 *
 * The desktop shell serves this tree from `http://tauri.localhost` and `cli/`
 * has no `location` at all, so a share link built from the current URL there
 * names a host that resolves in one process and nowhere else — the copied link
 * and the QR code both pointed somewhere no other device could reach.
 * keys.shareLink() falls back to this; a browser still links to itself, so a
 * localhost dev pair and a self-hosted deploy keep pointing at themselves.
 *
 * `/app`, not `/app.html`: the extensionless path is what the deploy publishes,
 * and Pages 308s the `.html` form onto it through a redirect nobody needs.
 */
const SITE_ORIGIN = "https://realtimeclipboard.com";

export const SITE = {
  ORIGIN: SITE_ORIGIN,
  HOST: SITE_ORIGIN.replace(/^https?:\/\//, ""),   // what the guide tells you to type
  APP_URL: `${SITE_ORIGIN}/app`,
  /** The published contact address — src/pages/contact/ and the AdSense
      publisher identity name it, so a change here is a change there too. */
  EMAIL: "info@realtimeclipboard.com",

  /**
   * `?qr=1` opens the share code as soon as the session is up.
   *
   * A QUERY parameter and not part of the fragment, deliberately: the fragment
   * is the key, its grammar is a compatibility surface every existing share
   * link depends on, and "show a QR" is a request about this visit rather than
   * a property of the session. It rides beside ?relay= for the same reason.
   *
   * It exists so a surface with no way to draw one — the VS Code extension, the
   * CLI — can hand the job to the app instead of growing its own renderer.
   */
  QR_PARAM: "qr",
};

/**
 * Derived rather than written out four times, so a fork or rename is one edit.
 * If the account moves, .github/FUNDING.yml is the same destination and has to
 * move with it — a donate link that 404s costs more than no donate link.
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
   * .github/ISSUE_TEMPLATE/, where the "do not paste your share key" warning is.
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
 * The phone breakpoint. CSS cannot read this file, so every media query in
 * `styles/` is matched to it by hand and this is the copy the JavaScript uses.
 * Three modules each carried their own string of it, and a module that
 * disagrees with the stylesheet renders for a layout that is not on screen.
 */
const NARROW_MAX = 900;

export const LAYOUT = {
  NARROW_MAX,
  NARROW_MQ: `(max-width:${NARROW_MAX}px)`,
};

/**
 * Google Analytics and AdSense. Empty by default and every consumer no-ops on
 * empty, so a fork or self-hosted deploy loads no third-party script at all.
 *
 * !! Both load everywhere, app.html included (the no-ads-in-the-app rule was
 * removed 2026-08-09). The ad tag reports the page URL itself with no override,
 * so what survives is TIMING: ui/features/ads.js must never load it while the
 * share key is still in `location.hash`, and waits for keys.clearUrl(). gtag
 * takes `page_location` from `pageLocation()` below, which strips it too — and
 * strips `?org=` with it, a credential rather than a room name. !!
 *
 * Adding an origin means adding it to the CSP in _headers AND every page's meta
 * tag — app.html's included — which tools/check/site-check.mjs asserts agree.
 */
export const GOOGLE = {
  /** GA4 measurement ID, "G-XXXXXXXXXX". Admin → Data streams → your stream. */
  GA4_ID: "G-259V6H3K5M",
  /** AdSense publisher ID, "ca-pub-################". Account → Settings. */
  ADSENSE_CLIENT: "ca-pub-6053041142492498",
  /**
   * `data-ad-slot` per placement. A unit renders nothing until its ID is filled.
   */
  ADSENSE_SLOTS: {
    /** index.html, the 728×90 after "how it works". */
    LEADERBOARD: "7038244690",
    /** index.html, the 300×600 rail beside the FAQ. */
    RAIL: "8299355473",
    /** app.html, under the editor — mounted only once the key has left the URL. */
    APP: "6948680552",
  },
};

/**
 * The app's ad slot, independent of who fills it.
 *
 * Deliberately not under GOOGLE: the slot is reserved and collapsed by
 * ui/features/ads.js, which dispatches between networks and must not know
 * about any of them. That separation is what lets tests/unit/static-check.mjs
 * assert AdSense identifiers appear in one module only.
 */
export const AD = {
  /**
   * What the slot asks for, per layout.
   *
   * NARROW is requested as a FIXED unit rather than a responsive one, because
   * the slot sits `flex:none` under an editor that is `flex:1`: every pixel it
   * takes comes straight out of the textarea. `data-full-width-responsive`
   * answered a 390px phone with a ~300px creative and left no editor at all.
   * WIDE is the responsive unit's usual size and is only what the placeholder
   * claims — that column is drag-resizable, so it is not requested as a fixed
   * one.
   */
  UNIT: {
    NARROW: { W: 320, H: 50 },
    WIDE:   { W: 728, H: 90 },
  },
  /**
   * How long the slot holds its reserved height before giving it back.
   *
   * An ad that never arrives — blocked, offline, or unfilled — used to leave an
   * empty box above the status bar for the life of the session. Long enough
   * that a slow fill is not thrown away, short enough that nobody stares at a
   * hole.
   */
  SETTLE_MS: 4000,
  /**
   * How long a unit that reported "filled" gets to actually paint, and the
   * height below which we conclude it did not.
   *
   * "filled" is the auction's answer, not the page's: an account still in
   * review reports filled and renders nothing, which held the reserved 90px
   * open for the whole session. The smallest unit requested here is 320x50, so
   * anything under a couple of dozen pixels rendered nothing.
   */
  RENDER_GRACE_MS: 1200,
  MIN_RENDERED_PX: 24,
};

/** Nothing loads unless the ID that drives it is present. */
export const analyticsEnabled = () => Boolean(GOOGLE.GA4_ID);
export const adsEnabled = () => Boolean(GOOGLE.ADSENSE_CLIENT);

/**
 * Consent Mode v2 starts denied here and stays denied until the CMP says
 * otherwise; elsewhere the tags behave normally. EEA, plus UK and Switzerland.
 */
export const CONSENT_REGIONS = [
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB",
  "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT", "NL", "NO",
  "PL", "PT", "RO", "SE", "SI", "SK",
];

/**
 * !! app.html carries the share key in `location.hash`, and gtag's default
 * `page_location` is `location.href` — the unmodified tag would send the key to
 * Google on the first page_view. Every gtag config passes this instead. !!
 */
/**
 * `location.search` with the deployment credential taken out.
 *
 * `?org=` admits a device to a self-hosted relay, and it rides in the query
 * because a browser cannot set a header on a WebSocket or an EventSource. That
 * put it in `location.search` — which is exactly what gtag's `page_location`
 * sends, and what AdSense reads off the page for itself. A deployment that
 * turned the token on was handing it to Google on the first page_view.
 *
 * Fails CLOSED: anything unparseable yields no query at all rather than the
 * original string, because the string is the thing under suspicion.
 */
export function safeSearch(search) {
  const raw = search ?? (typeof location === "undefined" ? "" : location.search);
  if (!raw) return "";
  try {
    const q = new URLSearchParams(raw);
    if (!q.has(ORG_PARAM)) return raw;
    q.delete(ORG_PARAM);
    const rest = q.toString();
    return rest ? `?${rest}` : "";
  } catch {
    return "";
  }
}

export const pageLocation = () => {
  if (typeof location === "undefined") return "";
  /* The desktop webview answers at `tauri.localhost` on Windows and
     `tauri://localhost` elsewhere — two hostnames for one surface, neither of
     them ours, both landing in the same property as the real /app. SITE is the
     public address, and `/app` rather than `/app.html` because that is what the
     web publishes; the desktop build skips the pretty-URL rewrite, so its
     on-disk name is not the name a report should show. Which surface a hit came
     from is `rtc_surface`, not the hostname. */
  if (IS_DESKTOP) return `${SITE.ORIGIN}/app`;
  return location.origin + location.pathname + safeSearch();
};

export const GOOGLE_SRC = {
  gtag: (id) => `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`,
  adsense: (client) =>
    `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`,
};
