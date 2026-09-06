/**
 * The relay connection: protocol, liveness, and which transport carries it.
 *
 * Everything above sees one interface — connect / send / close / isOpen /
 * setFrameHandler — and never learns how the bytes leave the machine. Designed
 * against the risk that the deployed relay would not pass WebSocket upgrades; it
 * turned out to be needed for the *client's* network instead, where a
 * TLS-inspecting proxy may refuse the Upgrade or accept and then swallow it.
 *
 *   1. Try WebSocket. Give it NET.PROBE_MS to become usable.
 *   2. Two consecutive attempts that never become usable is a policy, not a
 *      flaky moment — switch to SSE+POST and say so out loud.
 *   3. If that is blocked too, keep alternating: a network refusing both is a
 *      different problem, and the user is told that rather than watching
 *      "Reconnecting" forever.
 *
 * The choice is remembered, so someone behind that proxy pays the probe once.
 */

import { RELAY_URL, ORG_TOKEN, NET, TRANSPORT } from "../core/config.js";
import { emit, EV } from "../core/bus.js";
import * as state from "../core/state.js";
import * as storage from "../core/storage.js";
import * as proto from "./protocol.js";
import * as wsChannel from "./ws.js";
import * as sseChannel from "./sse.js";

const CHANNELS = {
  [TRANSPORT.WS]:  wsChannel,
  [TRANSPORT.SSE]: sseChannel,
};
const OTHER = {
  [TRANSPORT.WS]:  TRANSPORT.SSE,
  [TRANSPORT.SSE]: TRANSPORT.WS,
};

/** What the status bar appends. The default transport needs no announcement. */
const NOTE = {
  [TRANSPORT.WS]:  "",
  [TRANSPORT.SSE]: "HTTP fallback",
};

/** Non-transport frames are handed up; the caller decrypts. */
let onFrame = () => {};
export const setFrameHandler = fn => { onFrame = fn; };

let channel = null;
let session = null;              // {roomHash, intent, url, name}
let wantOpen = false;
let opened = false;              // has the CURRENT attempt become usable?
let mode = TRANSPORT.WS;
let announced = null;            // last transport reported on the bus
let stuck = false;               // both transports have failed; cleared by any success
let unsupported = false;         // the relay is reachable but predates the fallback
let forced = null;               // a transport the user pinned by hand; null = auto
let failures = { [TRANSPORT.WS]: 0, [TRANSPORT.SSE]: 0 };
let backoff = NET.BACKOFF_MIN_MS;
let heartbeat = null;
let probe = null;
let pingSentAt = 0;
let pongTimer = null;

/**
 * The relay's last refusal, if there was one. _join() sends an error frame and
 * then closes the socket, so the code lands just before the close — which is
 * what tells a permanent refusal (a wrong token, a full room) from a transient
 * one worth retrying. Without it every refusal was retried forever, quietly.
 */
let refusal = null;

const TERMINAL = new Set(["AUTH_FAILED", "ROOM_FULL", "ORG_TOKEN_REQUIRED"]);

/**
 * Which attempt is the current one. Rejoin, rotate and collision recovery all
 * close and reopen while a reconnect timer from the old attempt may still be
 * pending — without a generation to compare, that timer wakes, sees `wantOpen`,
 * and opens a second connection alongside the live one: the user is in the room
 * twice and sees their own clips echoed back. Every callback and timer below
 * captures this and does nothing if it has moved on.
 */
let epoch = 0;

/** Which transport is live right now. For the UI and for debugging. */
export const transport = () => mode;

/**
 * `auth` is a locked session's admission token — HKDF output, not the PIN and
 * not the key, so the relay can check that two peers agree without being able to
 * reverse it into either. A relay that predates it ignores the parameter.
 */
export function connect({
  roomHash, intent = "join", url = RELAY_URL, name = "", auth = null, org = ORG_TOKEN,
}) {
  channel?.close(1000);            // a second connect() replaces, never stacks
  session = { roomHash, intent, url, name, auth, org };
  wantOpen = true;
  forced = storage.loadTransportChoice();
  failures = { [TRANSPORT.WS]: 0, [TRANSPORT.SSE]: 0 };
  backoff = NET.BACKOFF_MIN_MS;
  mode = preferred();
  start();
}

export function send(obj) {
  return channel?.send(obj) ?? false;
}

export function close() {
  wantOpen = false;
  epoch++;                         // anything still pending belongs to a dead session
  stopTimers();
  channel?.close(1000);
  channel = null;
}

export const isOpen = () => channel?.isOpen() === true;

/* ---- transport selection ---- */

/**
 * A hand-picked transport wins outright and never expires — it is an
 * instruction, not a measurement. Failing that, a remembered choice: re-probing
 * costs NET.PROBE_MS of "Connecting…" on every load and the answer is the same
 * every time. storage.js expires that memory, so moving network re-probes.
 */
function preferred() {
  if (forced && CHANNELS[forced]?.available()) return forced;
  const remembered = storage.loadTransport();
  if (remembered && CHANNELS[remembered]?.available()) return remembered;
  return wsChannel.available() ? TRANSPORT.WS : TRANSPORT.SSE;
}

/**
 * Pin the transport, or hand it back to the app. Exists because "it works but it
 * is on the slow one" and "it should be on the slow one and is not" both need an
 * answer a user can act on — and because reproducing a blocked network to test
 * the fallback otherwise means finding a blocked network. `null` means auto.
 */
export function setTransport(choice) {
  const next = choice === TRANSPORT.WS || choice === TRANSPORT.SSE ? choice : null;
  if (next === forced) return;

  forced = next;
  storage.saveTransportChoice(forced);
  announced = null;                // the lock changed; the UI needs to hear it

  if (!wantOpen || !session) return announce();

  // Reconnect now rather than at the next drop: the point of choosing is to see
  // the choice take effect.
  channel?.close(1000);
  channel = null;
  stopTimers();
  epoch++;
  stuck = false;
  failures = { [TRANSPORT.WS]: 0, [TRANSPORT.SSE]: 0 };
  backoff = NET.BACKOFF_MIN_MS;
  mode = preferred();
  announce();
  start();
}

export const transportChoice = () => forced;

function switchTransport() {
  // A forced transport does not fail over: silently moving someone off it is
  // exactly what the switch was added to override.
  if (forced) return;

  const next = OTHER[mode];
  if (!CHANNELS[next].available()) return;

  mode = next;
  failures[next] = 0;
  backoff = NET.BACKOFF_MIN_MS;    // the switch is a fresh start, not a retry

  // Loud, never silent — the same rule the file layer follows on P2P fallback
  // (FR-7.6). The user is entitled to know which pipe their clipboard goes down.
  emit(EV.TOAST, next === TRANSPORT.SSE
    ? "WebSocket blocked — switched to the HTTP fallback"
    : "Retrying the WebSocket connection");
}

/** Neither transport is getting through: that is a network problem, not lag. */
function blocked() {
  return failures[TRANSPORT.WS] >= NET.SWITCH_AFTER
      && failures[TRANSPORT.SSE] >= NET.SWITCH_AFTER;
}

function announce() {
  const key = `${stuck ? `blocked:${unsupported}` : mode}:${forced}`;
  if (key === announced) return;   // don't re-raise a banner on every reconnect
  announced = key;
  emit(EV.TRANSPORT, {
    mode: stuck ? null : mode,
    label: CHANNELS[mode].LABEL,
    blocked: stuck,
    // `mode` is what carries frames now; this is what the user asked for. On
    // auto they are not the same question.
    forced,
    // "the relay is old" and "the network is blocking us" present identically
    // and have opposite fixes.
    unsupported,
  });
}

/* ---- one attempt ---- */

function start() {
  stopTimers();
  opened = false;
  state.setConnection("connecting", detail());

  const gen = ++epoch;
  const current = fn => (...args) => { if (gen === epoch) fn(...args); };

  channel = CHANNELS[mode].create({
    url: session.url,
    roomHash: session.roomHash,
    auth: session.auth,
    org: session.org,
    onOpen: current(up),
    onFrame: current(handle),
    onDown: current(down),
  });

  // A blocked transport hangs rather than fails, so there is no error to react
  // to — only this timer notices. See transport/CLAUDE.md; do not replace it
  // with an error handler.
  probe = setTimeout(() => {
    if (opened || gen !== epoch) return;
    channel?.close(4000);          // deliberate: the channel will not call down()
    channel = null;
    down({ code: 4000, reason: "no response" });
  }, NET.PROBE_MS);
}

function up() {
  clearTimeout(probe);
  probe = null;

  opened = true;
  stuck = false;
  unsupported = false;
  refusal = null;
  idRetries = 0;
  backoff = NET.BACKOFF_MIN_MS;
  failures[mode] = 0;

  // Only an automatic success is evidence. A forced transport working proves
  // someone clicked it, not what the network allows — recording it would mean
  // pinning HTTP once left "Automatic" choosing HTTP for the next twelve hours.
  if (!forced) storage.saveTransport(mode);

  state.setConnection("connected", detail());
  announce();

  send(proto.hello(session.intent, state.get().originId, session.name));

  heartbeat = setInterval(() => {
    pingSentAt = performance.now();
    // A ping nobody answers is how a silently dead socket presents: readyState
    // stays OPEN, nothing errors, and the session reads "connected" for as long
    // as the tab is left open. The deadline is what turns that into a reconnect.
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      channel?.close(4001);          // deliberate: it will not call down() itself
      channel = null;
      down({ code: 4001, reason: "no answer to a heartbeat" });
    }, NET.PONG_DEADLINE_MS);
    send(proto.ping());
  }, NET.HEARTBEAT_MS);
}

function down({ code, reason }) {
  stopTimers();
  channel = null;
  if (mode === TRANSPORT.SSE) unsupported = reason === sseChannel.NO_FALLBACK;

  if (!wantOpen) return state.setConnection("idle");

  // A refusal the relay will give again to the same credentials. Retrying it
  // every second forever told the user "reconnecting…" about a room they are
  // not going to be admitted to, and never said why.
  if (!opened && refusal && TERMINAL.has(refusal)) {
    wantOpen = false;
    const why = proto.ERRORS[refusal] || `refused: ${refusal}`;
    refusal = null;
    announce();
    return state.setConnection("offline", why);
  }

  if (opened) {
    // Always rejoin: a reconnect is never a "create", or a transient drop would
    // look like a key collision and needlessly rotate the user's key.
    session = { ...session, intent: "join" };
  } else {
    failures[mode] += 1;
  }

  // 1012 = "service restart". Every push to main redeploys the relay and closes
  // every live socket with this code (OI-13) — a planned, short outage rather
  // than a fault, so come back promptly instead of waiting out a doubled delay.
  if (code === 1012) backoff = NET.BACKOFF_MIN_MS;

  // Read before switching: switchTransport() zeroes the incoming transport's
  // counter, so asking afterwards always says "not blocked".
  if (!opened && failures[mode] >= NET.SWITCH_AFTER) {
    if (blocked()) {
      stuck = true;
      storage.saveTransport(null);   // neither works; don't pin the next load to one
    }
    switchTransport();
  }

  // Jitter keeps a restart from producing a synchronised reconnect stampede.
  const wait = Math.round(backoff * (0.8 + Math.random() * 0.4));
  backoff = Math.min(backoff * 2, NET.BACKOFF_MAX_MS);

  announce();

  if (stuck) {
    state.setConnection("offline", "relay unreachable");
  } else {
    state.setConnection("reconnecting",
      code === 1012 ? "relay restarting" : detail(`${(wait / 1000).toFixed(1)}s`));
  }

  const gen = epoch;
  setTimeout(() => { if (wantOpen && gen === epoch) start(); }, wait);
}

function stopTimers() {
  clearInterval(heartbeat);
  clearTimeout(probe);
  clearTimeout(pongTimer);
  heartbeat = probe = pongTimer = null;
}

/**
 * Status-bar text. "locked" is not decoration: a pinned transport does not fail
 * over, so a user who pinned WebSocket on a network that blocks it would
 * otherwise watch an endless reconnect with no hint that they are the reason.
 */
const detail = (extra = "") =>
  [extra, NOTE[mode], forced ? "locked" : ""].filter(Boolean).join(" · ");

/* ---- protocol ---- */

let idRetries = 0;

/**
 * Our own id is still held — by the connection we just closed. A rejoin or
 * rotation reconnects within milliseconds, and the relay only drops a peer once
 * it notices the old transport is gone. Reconnect faster and we meet our own
 * ghost: the relay keeps us under a provisional id while the files layer goes on
 * addressing frames to our originId, so transfers to this device quietly stop
 * resolving. Ask again once the ghost has been reaped.
 */
function reclaimIdentity() {
  if (idRetries >= 3) return emit(EV.TOAST, proto.ERRORS.PEER_ID_TAKEN);
  const gen = epoch;
  const attempt = ++idRetries;
  setTimeout(() => {
    if (!isOpen() || gen !== epoch) return;
    send(proto.hello("join", state.get().originId, session.name));
  }, 600 * attempt);
}

function handle(msg) {
  switch (msg.t) {
    case proto.T.WELCOME:
      state.setInstance(msg.instance);
      // Before the replay and before ROOM_STATE: lock verification is decided
      // on this list, and a listener that ran first would read an empty one and
      // conclude the relay is too old to ask.
      state.setRelayCaps(msg.caps);
      if (msg.you) state.get().peerId = msg.you;
      state.setPeers(msg.peers ?? 1, msg.list ?? []);
      // `existing > 0` on a create means the generated key is taken (OI-2).
      if (session.intent === "create" && msg.existing > 0) {
        emit(EV.KEY_COLLISION, { existing: msg.existing });
        return;
      }
      // A room's last clip is replayed to late joiners, so a device arriving
      // mid-session is immediately in sync (FR-3.3).
      if (msg.last) onFrame(msg.last);

      // `existing` is the peer count the instant before we joined, which only
      // the relay can answer. Emitted after the replay so a listener cannot
      // race the last clip.
      //
      // `hasLast` used to ride along, for a locked session to decide whether to
      // plant its proof-of-PIN into the room's retained clip slot. Nothing asks
      // any more: the proof is its own frame and does not compete for the slot.
      emit(EV.ROOM_STATE, { existing: msg.existing ?? 0 });
      break;

    case proto.T.PEERS:
      state.setPeers(msg.count, msg.list ?? []);
      break;

    case proto.T.PONG:
      clearTimeout(pongTimer);
      pongTimer = null;
      emit(EV.CONN_STATE, {
        state: "connected",
        detail: detail(`${Math.round(performance.now() - pingSentAt)} ms`),
      });
      break;

    case proto.T.ERROR:
      if (msg.code === "PEER_ID_TAKEN") return reclaimIdentity();
      // Remembered for the close that follows a refused join, so down() can
      // tell "come back later" from "you are not getting in".
      if (!opened) refusal = msg.code;
      emit(EV.TOAST, proto.ERRORS[msg.code] || `Relay error: ${msg.code}`);
      break;

    default:
      onFrame(msg);
  }
}
