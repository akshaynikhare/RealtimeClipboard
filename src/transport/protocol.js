/**
 * Wire protocol — PRD §6. Frame shapes live here and nowhere else.
 *
 * Deliberately transport-agnostic: if the SSE+POST fallback is ever needed
 * (PRD §4.3 R3), these same envelopes travel unchanged.
 */

export const T = {
  HELLO:   "hello",
  CLIP:    "clip",
  STREAM:  "stream",
  PING:    "ping",
  PONG:    "pong",
  WELCOME: "welcome",
  PEERS:   "peers",
  ERROR:   "error",
  // M7 — WebRTC signalling, forwarded blindly by the relay
  RTC_OFFER:  "rtc-offer",
  RTC_ANSWER: "rtc-answer",
  RTC_ICE:    "rtc-ice",
  FILE_META:  "file-meta",
  FILE_REQ:   "file-req",
};

/**
 * `intent` is the collision guard (OI-2). A key we generated connects as
 * "create"; if the welcome reports peers already present, that key is taken and
 * we must regenerate rather than silently join a stranger's clipboard.
 * A key the user typed or followed a link to is always "join".
 */
export const hello = (intent, originId, name) => ({ t: T.HELLO, intent, originId, name });

export const clip = ({ payload, iv, originId }) => ({
  t: T.CLIP, payload, iv, originId, ts: Date.now(),
});

/**
 * Typing, for the far editor to render — a VIEW frame:
 *
 *   clip   — a discrete thing that settled. History, OS clipboard, dedupe, size
 *            cap. Retained by the relay and replayed to late joiners (FR-3.3).
 *   stream — what the text looks like right now. Renders and nothing else.
 *
 * Carries the WHOLE text rather than a diff, which is what lets live typing
 * exist without positions or operational transform, bounded by
 * TEXT.STREAM_MAX_BYTES. `name` rides along because nothing replays these, so a
 * device joining mid-sentence would otherwise render an unattributed caret.
 *
 * Everything but `t` and `originId` is sealed by main.js encryptFrame().
 */
export const stream = ({ text, caret, name, originId }) => ({
  t: T.STREAM, text, caret, name, originId,
});

export const ping = () => ({ t: T.PING });

export const fileMeta = ({ id, name, size, type, thumb, originId }) => ({
  t: T.FILE_META, id, name, size, type, thumb, originId,
});

export const fileReq = ({ id, to, originId }) => ({
  t: T.FILE_REQ, id, to, originId,
});

export function parse(raw) {
  try { return JSON.parse(raw); }
  catch { return { t: T.ERROR, code: "BAD_JSON" }; }
}

export const ERRORS = {
  TOO_LARGE:    "That clip is over the 32 KB limit",
  RATE_LIMITED: "Slow down — too many messages",
  ROOM_FULL:    "This session already has the maximum number of devices",
  BAD_JSON:     "The relay sent something unreadable",
  NO_STREAM:    "The connection expired — reconnecting",
  // Only shown after the transport gives up retrying — the usual cause is our
  // own just-closed connection still holding the name. See reclaimIdentity().
  PEER_ID_TAKEN: "Another device in this session is using the same id — files may not reach this one",
  // Unreachable from a correct client: a wrong PIN addresses a different room
  // entirely rather than being turned away from this one. It fires if room and
  // key derivation ever disagree, which is a bug, and this is how it surfaces
  // instead of a session that connects and then reads nothing.
  AUTH_FAILED:  "This session's PIN does not match the one already in use here",
  // A relay running with REALTIMECLIPBOARD_JOIN_TOKEN set. The token is per DEPLOYMENT,
  // never per session, and never travels in a share link — see ORG_TOKEN in
  // core/config.js for where it comes from.
  ORG_TOKEN_REQUIRED: "This relay needs an organisation token — open the app with ?org=… once",
  RELAY_BUSY:   "The relay is at capacity — try again in a moment",
  TOO_MANY_CONNECTIONS: "Too many connections from this network",
  NO_SUCH_PEER: "That device is no longer in this session",
  SESSION_EXPIRED: "This session reached the relay's time limit and was closed",
  FILES_DISABLED: "This relay has file transfers switched off",
};
