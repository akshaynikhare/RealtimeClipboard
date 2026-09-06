/**
 * File transfer — WebRTC first, relay chunks when WebRTC cannot connect.
 *
 * The wire arrives by injection, not import — see files/CLAUDE.md. main.js wires
 * it at boot:
 *
 *   setSignalSender(frame => boolean)   seals all but the routing fields and
 *       returns false only if it could not send. Anything else counts as sent.
 *   onSignal(frame)   every inbound frame whose `.t` is in FRAMES, decrypted.
 *       Frames for somebody else are dropped here too, so a broadcasting relay
 *       is safe.
 *   setApprover(async meta => boolean)   with none installed a request is DENIED.
 *   setPeerFactory(config => RTCPeerConnection)   test seam: a fake that never
 *       opens makes the ICE timeout fire without a browser or a 5s wait.
 *
 * Route ALL of FRAMES. Without file-accept the receiver never learns the chunk
 * plan; without file-done a zero-byte file hangs.
 *
 * WHY NO TURN SERVER: it would fix corporate connectivity by relaying the bytes,
 * discarding the property that motivated P2P and costing bandwidth. Falling back
 * to our own relay is viable only because the cap is 5 MB (docs/P2P-FILES.md §4,
 * PRD OI-14). Which path was used is recorded and shown — a relay transfer is a
 * different privacy story.
 */

import { FILES, NET } from "../core/config.js";
import { emit, on, EV } from "../core/bus.js";
import * as state from "../core/state.js";
import * as storage from "../core/storage.js";
import * as registry from "./registry.js";
import * as chunker from "./chunker.js";
import { T } from "../transport/protocol.js";

export const PATH = { P2P: "p2p", RELAY: "relay" };

/** Frame types. The first four already exist in transport/protocol.js. */
export const FT = {
  RTC_OFFER:   T.RTC_OFFER,      // {id, to, sdp}
  RTC_ANSWER:  T.RTC_ANSWER,     // {id, to, sdp}
  RTC_ICE:     T.RTC_ICE,        // {id, to, candidate}
  FILE_META:   T.FILE_META,      // {id, name, size, type, thumb}   broadcast, no `to`
  FILE_REQ:    T.FILE_REQ,       // {id, to}                 receiver -> holder
  FILE_ACCEPT: "file-accept",    // {id, to, name, size, type, digest, chunkBytes, total}
  FILE_DENY:   "file-deny",      // {id, to, reason}
  FILE_CHUNK:  "file-chunk",     // {id, to, seq, total, crc, b64}   relay fallback
  FILE_DONE:   "file-done",      // {id, to, digest}                 relay fallback
  FILE_CANCEL: "file-cancel",    // {id, to, reason}         either direction
  FILE_ERROR:  "file-error",     // {id, to, reason}
  // The receiver has the whole file and the digest matched. Without it "Sent"
  // meant "handed to a socket", which is a different claim from "arrived".
  FILE_OK:     "file-ok",        // {id, to, digest}         receiver -> holder
  // Broadcast like file-meta because it undoes one: without it a stale tile sits
  // on every peer offering something that can no longer be fetched.
  FILE_GONE:   "file-gone",      // {id}                     broadcast, no `to`
};

/** Exactly the frames main.js should route into onSignal(). */
export const FRAMES = Object.freeze(Object.values(FT));

/**
 * The frames that carry nothing but routing, and so travel unsealed.
 *
 * encryptFrame() seals whatever is left once the routing fields are taken out,
 * and for these two there is nothing left to seal. main.js needs them named to
 * tell them apart from a frame that SHOULD have arrived with an envelope and
 * did not — which is what a relay injecting its own traffic looks like.
 */
export const PLAINTEXT_FRAMES = Object.freeze([FT.FILE_REQ, FT.FILE_GONE]);

/**
 * STUN only, deliberately — it sees only that some IP asked for its own
 * reflexive address. An endpoint rather than a limit, which is why it is not in
 * config.js; it arguably should be, alongside RELAY_URL.
 */
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

/** 4-byte seq + 4-byte CRC in front of every binary data-channel chunk. */
const CHUNK_HEADER_BYTES = 8;

/**
 * Chunks allowed in the SCTP send queue before pausing. A queue depth, not a
 * product limit — the resume mark is set per wait, in untilBuffered().
 */
const SEND_QUEUE_CHUNKS = 8;
const SEND_HIGH_WATER = FILES.CHUNK_BYTES * SEND_QUEUE_CHUNKS;

/**
 * PRD §6 caps a connection at 10 messages/sec; eight leaves room for heartbeats
 * and clips, and stops one 5 MB file monopolising a shared free-tier relay.
 */
const RELAY_FRAMES_PER_SEC = 8;
const RELAY_FRAME_GAP_MS = Math.ceil(1000 / RELAY_FRAMES_PER_SEC);

/**
 * How long a transfer that HAS started may go quiet, in ICE timeouts. Bytes
 * stopping is a different failure from never starting, and it scales with the
 * network rather than with a human — so this one stays tied to the ICE timeout.
 */
const IDLE_GRACE = 4;

const stallMs = () => iceTimeout * IDLE_GRACE;

/* ------------------------------------------------------------------ *
 * Injected collaborators
 * ------------------------------------------------------------------ */

let sendSignal = null;
let approver = null;
let peerFactory = null;                  // null => the platform's RTCPeerConnection
let iceTimeout = NET.ICE_TIMEOUT_MS;

export function setSignalSender(fn) { sendSignal = typeof fn === "function" ? fn : null; }
export function setApprover(fn) { approver = typeof fn === "function" ? fn : null; }
export function setPeerFactory(fn) { peerFactory = typeof fn === "function" ? fn : null; }

/**
 * Throws rather than returning null when WebRTC is missing, so every caller
 * falls into the same try/catch that leads to the relay — no separate
 * "is WebRTC supported" branch to get out of sync.
 */
function newPeerConnection(config) {
  if (peerFactory) return peerFactory(config);
  if (typeof RTCPeerConnection === "undefined") throw new Error("this browser has no WebRTC");
  return new RTCPeerConnection(config);
}

/** Exposed so the UI can show the ICE deadline honestly rather than a spinner. */
export const iceTimeoutMs = NET.ICE_TIMEOUT_MS;
export const currentIceTimeoutMs = () => iceTimeout;

/**
 * One number for both ends: a prompt that outlives the request approves a
 * transfer whose other end went home, and a request that outlives the prompt
 * spins against a decision already made. Its own value rather than a multiple of
 * the ICE timeout, which tied a human reading a dialog to a network constant.
 */
let requestTimeout = FILES.REQUEST_TIMEOUT_MS;

export const requestTimeoutMs = () => requestTimeout;

/** Shorten the ICE race. Tests use it; a "slow network" setting could too. */
export function setIceTimeoutMs(ms) {
  iceTimeout = Number.isFinite(ms) && ms > 0 ? ms : NET.ICE_TIMEOUT_MS;
}

/** Shorten the answer deadline. Tests use it. */
export function setRequestTimeoutMs(ms) {
  requestTimeout = Number.isFinite(ms) && ms > 0 ? ms : FILES.REQUEST_TIMEOUT_MS;
}

/* ------------------------------------------------------------------ *
 * Live transfers
 * ------------------------------------------------------------------ */

/** id -> transfer. Every entry owns timers and maybe an RTCPeerConnection, so
 *  every exit route goes through finish(), which deletes from here. */
const live = new Map();

export const active = () => [...live.values()].map(t => ({
  id: t.id, role: t.role, peer: t.peer, path: t.path, percent: t.percent,
}));

export const isActive = id => live.has(id);

function makeTransfer(id, role, peer) {
  const t = {
    id, role, peer, receipt: null, confirmed: false,
    path: null, percent: 0, done: false, queued: false,
    pc: null, dc: null, rx: null, meta: null,
    pendingIce: [], remoteReady: false,
    iceTimer: null, deadline: null, idleTimer: null,
  };
  live.set(id, t);
  return t;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Clicking the tile is the consent, so this side never prompts; the holder
 * prompts before its bytes leave the machine.
 */
export async function request(id) {
  const file = registry.get(id);
  if (!file || file.origin !== "remote") return false;
  if (file.blob) return false;                     // already have the bytes
  if (live.has(id)) return false;                  // already in flight
  if (!file.owner) return fail(id, "we do not know which device holds this file");
  if (!sendSignal) return fail(id, "not connected to the relay");

  const t = makeTransfer(id, "recv", file.owner);
  registry.setState(id, registry.STATE.REQUESTING);
  registry.setProgress(id, 0);
  emit(EV.TOAST, `Requesting ${file.name}…`);

  if (!signal({ t: FT.FILE_REQ, id, to: t.peer })) {
    finish(t);
    return fail(id, "could not reach the relay");
  }

  // The same deadline counts down on the holder's prompt, so both ends give up
  // together.
  t.deadline = setTimeout(() => {
    // Tell the holder, as cancel() does. The clocks start a network hop apart
    // and its prompt is swept every 500 ms, so an approval can be in flight when
    // this fires — the holder would stream the whole file to a transfer that no
    // longer exists here, and report "Sent".
    signal({ t: FT.FILE_CANCEL, id, to: t.peer, reason: "the request timed out" });
    finish(t);
    fail(id, "no answer — the other device did not respond in time");
  }, requestTimeout);

  return true;
}

/** Abort in either direction, tell the peer, and leave nothing behind. */
export function cancel(id, reason = "cancelled") {
  const t = live.get(id);
  if (!t) return false;
  const name = registry.get(id)?.name ?? "transfer";
  signal({ t: FT.FILE_CANCEL, id, to: t.peer, reason });
  finish(t);
  registry.cancel(id);
  emit(EV.TOAST, `Cancelled ${name}`);
  return true;
}

/** Cancel everything — for "leave session". */
export function cancelAll(reason = "session ended") {
  for (const id of [...live.keys()]) cancel(id, reason);
}

/* ------------------------------------------------------------------ *
 * Inbound signalling — the single entry point main.js calls
 * ------------------------------------------------------------------ */

export function onSignal(frame) {
  if (!frame || typeof frame !== "object") return;
  const me = state.get().originId;
  if (frame.originId === me) return;                     // our own echo
  if (frame.to && frame.to !== me) return;               // somebody else's

  const handler = INBOUND[frame.t];
  if (!handler) return;

  // The relay stamps `from` on every frame it forwards or fans out, overwriting
  // whatever the sender put there — it is the one field a client cannot choose.
  // Everything below identifies a peer by it. The client-supplied `originId`
  // used to stand in, so any member of the room could name another device as the
  // requester and inherit a standing grant that device had been given.
  const sender = typeof frame.from === "string" && frame.from ? frame.from : null;
  if (!sender) {
    console.warn("[transfer] dropped a frame with no relay-stamped sender", frame.t);
    return;
  }
  if (sender === me) return;                             // our own echo, stamped

  // A frame about a transfer already under way has to come from the peer that
  // transfer belongs to. Every handler found its transfer by file id alone, so
  // any other member could cancel it, answer its negotiation, replace its chunk
  // plan, or inject bytes into it.
  const known = live.get(frame.id);
  if (known && known.peer && known.peer !== sender) {
    console.warn(`[transfer] ${frame.t} for ${frame.id} came from the wrong peer`);
    return;
  }

  // Handlers are async and onSignal is not, so a rejection must surface as a
  // failed transfer rather than an unhandled one. But not every rejection is a
  // failure: handlers are not serialised, so a WebRTC step suspended across an
  // await can resume after the thing it raced has settled — the relay took over,
  // or the user cancelled. Failing on those tore down transfers that were
  // delivering bytes, the sender reporting "Sent" while the receiver showed
  // "PeerConnection is closed".
  Promise.resolve()
    .then(() => handler(frame, sender))
    .catch(err => {
      const t = live.get(frame.id);
      if (!t) return;                                // already cancelled or finished
      if (RTC_FRAMES.has(frame.t) && t.path === PATH.RELAY) {
        console.info(`[transfer] ${t.id}: ${frame.t} abandoned for the relay — ${describe(err)}`);
        return;
      }
      console.error(`[transfer] ${frame.t} failed`, err);
      finish(t);
      fail(frame.id, describe(err));
    });
}

/** Negotiation frames, whose failure is survivable once the relay has the file. */
const RTC_FRAMES = new Set([FT.RTC_OFFER, FT.RTC_ANSWER, FT.RTC_ICE]);

const INBOUND = {
  [FT.FILE_META]:   onFileMeta,
  // registry checks the relay-stamped `from`, not the client-supplied originId,
  // so a spoofed id cannot delete someone else's tile.
  [FT.FILE_GONE]:   f => registry.applyGone(f),
  [FT.FILE_REQ]:    onFileReq,
  [FT.FILE_ACCEPT]: onFileAccept,
  [FT.FILE_DENY]:   f => { closeAndFail(f.id, f.reason || "the other device declined"); },
  [FT.FILE_ERROR]:  f => { closeAndFail(f.id, f.reason || "the transfer failed"); },
  [FT.FILE_CANCEL]: onFileCancel,
  [FT.FILE_OK]:     onFileOk,
  [FT.RTC_OFFER]:   onRtcOffer,
  [FT.RTC_ANSWER]:  onRtcAnswer,
  [FT.RTC_ICE]:     onRtcIce,
  [FT.FILE_CHUNK]:  onFileChunk,
  [FT.FILE_DONE]:   onFileDone,
};

/* ------------------------------------------------------------------ *
 * SEND SIDE — a peer wants a file we hold
 * ------------------------------------------------------------------ */

/**
 * A tile with a thumbnail, no bytes. Every field is chosen by whoever holds the
 * session key, so nothing is trusted: the size is what a later transfer is
 * checked against, and a thumbnail must be an image data URL or nothing.
 */
function onFileMeta(frame, sender) {
  const size = Number(frame.size);
  if (!frame.id || !Number.isInteger(size) || size < 0 || size > FILES.MAX_BYTES) {
    console.warn("[transfer] ignoring a file announcement with an implausible size", frame.id);
    return;
  }
  if (registry.count() >= FILES.MAX_COUNT) return;      // FR-7.7, memory only

  const thumb = typeof frame.thumb === "string" && frame.thumb.startsWith("data:image/")
    ? frame.thumb
    : null;                                             // anything else is not a preview

  // The owner is the relay's answer to "who sent this", not the sender's own
  // claim: it is what a later file-gone is checked against, and what a request
  // for the bytes is addressed to.
  registry.addRemote({
    id: String(frame.id), name: String(frame.name ?? "file"), size,
    type: String(frame.type ?? ""), thumb, originId: sender,
  });
}

async function onFileReq(frame, sender) {
  const { id } = frame;
  const peer = sender;
  const file = registry.get(id);

  if (!file?.blob) {
    return signal({ t: FT.FILE_ERROR, id, to: peer, reason: "that file is no longer available" });
  }
  if (live.has(id)) {
    // A repeat from the SAME peer is the SSE transport's at-least-once retry,
    // not a second asker. Answering "already being sent" fails the very transfer
    // the duplicate belongs to, and it then ignores the bytes we send.
    if (live.get(id).peer === peer) return;
    return signal({ t: FT.FILE_ERROR, id, to: peer, reason: "that file is already being sent" });
  }

  const t = makeTransfer(id, "send", peer);
  registry.setState(id, registry.STATE.WAITING);

  if (!(await allowed(file, peer))) {
    finish(t);
    registry.setState(id, registry.STATE.IDLE);
    signal({ t: FT.FILE_DENY, id, to: peer, reason: "the other device declined the request" });
    emit(EV.TOAST, `Declined the request for ${file.name}`);
    return;
  }
  if (t.done) return;                              // cancelled while we prompted

  registry.setState(id, registry.STATE.CONNECTING);
  t.file = file;
  t.digest = await chunker.digest(file.blob);
  if (t.done) return;

  // The relay plan travels now so the fallback needs no second negotiation. The
  // P2P plan rides the data channel, because its chunk size is known only once
  // SCTP reports its maximum message size.
  const relayPlan = chunker.plan(file.blob, chunker.RELAY_CHUNK_BYTES);
  signal({
    t: FT.FILE_ACCEPT, id, to: peer,
    name: file.name, size: file.size, type: file.type || "",
    digest: t.digest, chunkBytes: relayPlan.chunkBytes, total: relayPlan.total,
  });

  startIceRace(t);
}

/**
 * FR-7.6. A peer connection and a timer against it; whichever fires first wins.
 * If constructing the connection throws, the fallback runs immediately rather
 * than waiting out a race that cannot be won.
 */
function startIceRace(t) {
  let pc;
  try {
    pc = newPeerConnection({ iceServers: ICE_SERVERS });
  } catch (err) {
    return toRelay(t, describe(err));
  }
  t.pc = pc;

  pc.onicecandidate = ev => {
    if (ev.candidate) signal({ t: FT.RTC_ICE, id: t.id, to: t.peer, candidate: ev.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (t.path) return;
    if (pc.connectionState === "failed") toRelay(t, "the direct connection failed");
  };
  pc.oniceconnectionstatechange = () => {
    if (!t.path && pc.iceConnectionState === "failed") toRelay(t, "ICE failed");
  };

  let dc;
  try {
    dc = pc.createDataChannel(`hopfile-${t.id}`, { ordered: true });
  } catch (err) {
    return toRelay(t, describe(err));
  }
  t.dc = dc;
  dc.binaryType = "arraybuffer";

  dc.onopen = () => {
    if (t.path) return;                            // the timer already won
    clearTimeout(t.iceTimer);
    t.iceTimer = null;
    setPath(t, PATH.P2P);
    streamOverDataChannel(t).catch(err => abort(t, describe(err)));
  };
  dc.onerror = () => { if (!t.path) toRelay(t, "the data channel errored"); };
  dc.onclose = () => {
    // Once everything is queued the receiver may simply have finished first.
    if (t.path === PATH.P2P && !t.done && !t.queued) abort(t, "the direct connection dropped");
  };

  // THE RACE. Corporate networks block the UDP this needs, so assume it loses.
  t.iceTimer = setTimeout(() => {
    t.iceTimer = null;
    if (t.path) return;
    toRelay(t, `no direct connection after ${iceTimeout >= 1000 ? `${Math.round(iceTimeout / 1000)}s` : `${iceTimeout}ms`}`);
  }, iceTimeout);

  (async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signal({ t: FT.RTC_OFFER, id: t.id, to: t.peer, sdp: pc.localDescription });
    } catch (err) {
      if (!t.path) toRelay(t, describe(err));
    }
  })();
}

/** WebRTC lost. Drop it completely — no half-open connection left behind. */
function toRelay(t, why) {
  if (t.done || t.path) return;
  closeRtc(t);
  setPath(t, PATH.RELAY);
  console.info(`[transfer] ${t.id}: falling back to the relay — ${why}`);
  emit(EV.TOAST, `Direct connection unavailable — sending ${t.file?.name ?? "file"} via the relay`);
  streamOverRelay(t).catch(err => abort(t, describe(err)));
}

/* ---- streaming: direct ---- */

async function streamOverDataChannel(t) {
  const { dc, file } = t;
  const chunkBytes = dataChannelChunkBytes(t.pc);
  const p = chunker.plan(file.blob, chunkBytes);

  registry.setState(t.id, registry.STATE.SENDING);
  dc.send(JSON.stringify({
    hdr: 1, id: t.id, name: file.name, type: file.type || "",
    size: p.size, chunkBytes: p.chunkBytes, total: p.total, digest: t.digest,
  }));

  const header = new DataView(new ArrayBuffer(CHUNK_HEADER_BYTES));
  for await (const c of chunker.chunks(file.blob, chunkBytes)) {
    if (t.done || !registry.get(t.id)) return abort(t, "the file went away mid-transfer");
    if (dc.readyState !== "open") return abort(t, "the direct connection closed");

    if (!await drain(t)) return abort(t, "the direct connection stopped accepting data");
    if (t.done) return;

    header.setUint32(0, c.seq);
    header.setUint32(4, c.crc);
    const framed = new Uint8Array(CHUNK_HEADER_BYTES + c.bytes.length);
    framed.set(new Uint8Array(header.buffer), 0);
    framed.set(c.bytes, CHUNK_HEADER_BYTES);
    dc.send(framed.buffer);

    progress(t, ((c.seq + 1) / p.total) * 100);
  }

  // Past here a close is the peer hanging up, not a failure: the receiver
  // completes on the last chunk rather than the fin marker, so it may already
  // hold the file. A genuine failure arrives as file-error on the relay.
  t.queued = true;

  if (dc.readyState === "open") {
    dc.send(JSON.stringify({ fin: 1, id: t.id, digest: t.digest }));

    // dc.send() only queues, and pc.close() destroys the association with
    // whatever is still in it. Under the high-water mark drain() never paused,
    // so that is frequently the whole file — reported as "Sent" on the way out.
    if (!await flush(t) && dc.readyState === "open") {
      return abort(t, "the direct connection stalled before the file finished");
    }
    await closeGracefully(t);
  }

  if (t.done) return;
  const confirmed = await awaitReceipt(t);
  if (t.done) return;                              // cancelled or failed meanwhile
  sent(t, confirmed);
}

/**
 * Wait for the send queue to fall to `low`, having decided to wait at `gate`.
 * Resolves false if the channel died or never got there; the caller decides
 * whether that is fatal.
 *
 * The threshold is per wait because bufferedamountlow fires on the downward
 * crossing and the two waits want different marks: mid-stream resumes at one
 * chunk so the pipe never idles, while the final flush can accept only zero —
 * whatever is left when pc.close() runs is thrown away.
 */
function untilBuffered(dc, { gate, low }) {
  if (!dc || dc.readyState !== "open") return Promise.resolve(false);
  if (dc.bufferedAmount <= gate) return Promise.resolve(true);

  dc.bufferedAmountLowThreshold = low;
  return new Promise(resolve => {
    let timer = null;
    const release = () => {
      clearTimeout(timer);
      dc.removeEventListener("bufferedamountlow", release);
      dc.removeEventListener("close", release);
      dc.removeEventListener("error", release);
      resolve(dc.readyState === "open" && dc.bufferedAmount <= low);
    };
    timer = setTimeout(release, stallMs());
    dc.addEventListener("bufferedamountlow", release);
    dc.addEventListener("close", release);        // never wait on a dead channel
    dc.addEventListener("error", release);
  });
}

/**
 * Without this a 5 MB file is handed to SCTP as fast as the loop reads it, and
 * the buffer either balloons or the browser tears the channel down.
 */
const drain = t => untilBuffered(t.dc, { gate: SEND_HIGH_WATER, low: FILES.CHUNK_BYTES });

/** Everything we queued has left. Only now is it safe to close the transport. */
const flush = t => untilBuffered(t.dc, { gate: 0, low: 0 });

/**
 * Give the stream reset a chance to land before the peer connection goes. A
 * close we asked for is not a drop, so the handlers that would report it as one
 * come off first.
 */
function closeGracefully(t) {
  const dc = t.dc;
  if (!dc || dc.readyState !== "open") return Promise.resolve();
  dc.onclose = dc.onerror = null;
  return new Promise(resolve => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      dc.removeEventListener("close", done);
      resolve();
    };
    timer = setTimeout(done, FILES.CHANNEL_CLOSE_MS);
    dc.addEventListener("close", done);
    try { dc.close(); } catch { done(); }
  });
}

/** 32 KB unless the SCTP association says it will not carry that much. */
function dataChannelChunkBytes(pc) {
  const max = pc?.sctp?.maxMessageSize;
  if (!Number.isFinite(max) || max <= 0) return chunker.P2P_CHUNK_BYTES;
  const room = max - CHUNK_HEADER_BYTES;
  return room > 0 ? Math.min(chunker.P2P_CHUNK_BYTES, room) : chunker.P2P_CHUNK_BYTES;
}

/* ---- streaming: relay fallback ---- */

async function streamOverRelay(t) {
  const { file } = t;
  const chunkBytes = chunker.RELAY_CHUNK_BYTES;
  const p = chunker.plan(file.blob, chunkBytes);

  registry.setState(t.id, registry.STATE.SENDING);

  for await (const c of chunker.chunks(file.blob, chunkBytes)) {
    if (t.done || !registry.get(t.id)) return abort(t, "the file went away mid-transfer");

    const put = signal({
      t: FT.FILE_CHUNK, id: t.id, to: t.peer,
      seq: c.seq, total: p.total, crc: c.crc, b64: chunker.toB64(c.bytes),
    });
    if (!put) return abort(t, "lost the relay connection");

    progress(t, ((c.seq + 1) / p.total) * 100);
    if (c.seq + 1 < p.total) await sleep(RELAY_FRAME_GAP_MS);
  }

  signal({ t: FT.FILE_DONE, id: t.id, to: t.peer, digest: t.digest, total: p.total });
  const confirmed = await awaitReceipt(t);
  if (t.done) return;                              // cancelled or failed meanwhile
  sent(t, confirmed);
}

/**
 * Our side of a successful send. The file stays local; the bar goes away.
 *
 * `confirmed` is the receiver's own word for it. Unconfirmed is not a failure —
 * the bytes did leave — but it is not the same statement, and saying the
 * stronger one for both is how a file that failed its checksum at the far end
 * was reported here as sent.
 */
function sent(t, confirmed = false) {
  const name = registry.get(t.id)?.name ?? "file";
  const via = t.path === PATH.P2P ? "a direct connection" : "the relay";
  finish(t);
  registry.setState(t.id, registry.STATE.IDLE);
  registry.setProgress(t.id, 0);
  emit(EV.TOAST, confirmed
    ? `Sent ${name} over ${via}`
    : `Sent ${name} over ${via} — the other device did not confirm it`);
}

/**
 * Wait for the receiver's file-ok. Resolves false on the deadline, and on any
 * teardown — finish() releases the waiter, so a cancel or a file-error while we
 * are waiting reports what happened rather than hanging on the timeout.
 */
function awaitReceipt(t) {
  // The ack can beat the waiter: on the direct path the sender is still closing
  // the data channel when the receiver finishes verifying, so the frame lands
  // before there is anything registered to catch it. Recorded on arrival, and
  // read here first.
  if (t.confirmed) return Promise.resolve(true);
  return new Promise(resolve => {
    const settle = (ok) => {
      if (!t.receipt) return;
      t.receipt = null;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), FILES.RECEIPT_MS);
    t.receipt = settle;
  });
}

/** The receiver has it, whole and verified. */
function onFileOk(frame) {
  const t = live.get(frame.id);
  if (!t || t.role !== "send") return;
  t.confirmed = true;
  t.receipt?.(true);
}

/* ------------------------------------------------------------------ *
 * RECEIVE SIDE
 * ------------------------------------------------------------------ */

function onFileAccept(frame) {
  const t = live.get(frame.id);
  if (!t || t.role !== "recv") return;
  clearTimeout(t.deadline);
  t.deadline = null;
  // The relay plan. If WebRTC wins, the data channel header replaces it.
  t.meta = checkedMeta(t, frame);
  registry.setState(frame.id, registry.STATE.CONNECTING);
  armIdle(t);
}

/**
 * Never allocate on a peer's say-so. The Reassembler preallocates `size` bytes
 * the moment a header arrives, and a header is just a frame from whoever holds
 * the session key: unchecked, "size: 8e9" is a one-frame denial of service, and
 * a size disagreeing with what was announced means this is not the file whose
 * thumbnail was clicked.
 */
function checkedMeta(t, m) {
  const size = Number(m.size);
  const chunkBytes = Number(m.chunkBytes);
  const total = Number(m.total);

  if (!Number.isInteger(size) || size < 0 || size > FILES.MAX_BYTES) {
    throw new Error(`refused: the sender declared ${size} bytes, over the ${FILES.MAX_BYTES} limit`);
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw new Error("refused: bad chunk size");
  if (!Number.isInteger(total) || total !== chunker.chunkCount(size, chunkBytes)) {
    throw new Error("refused: the sender's chunk plan does not add up");
  }

  const announced = registry.get(t.id);
  if (announced && Number.isInteger(announced.size) && announced.size !== size) {
    throw new Error("refused: this is not the file that was announced");
  }

  return { id: t.id, size, chunkBytes, total, type: m.type || "", digest: m.digest };
}

async function onRtcOffer(frame) {
  const t = live.get(frame.id);
  if (!t || t.role !== "recv") return;
  if (t.pc || t.path === PATH.RELAY) return;       // already connected or past it

  let pc;
  try {
    pc = newPeerConnection({ iceServers: ICE_SERVERS });
  } catch (err) {
    // Stay silent: the holder's own ICE race times out and its relay chunks
    // arrive on the channel already open.
    console.info(`[transfer] ${t.id}: no WebRTC here (${describe(err)}), waiting for relay chunks`);
    return;
  }
  t.pc = pc;

  pc.onicecandidate = ev => {
    if (ev.candidate) signal({ t: FT.RTC_ICE, id: t.id, to: t.peer, candidate: ev.candidate });
  };
  pc.ondatachannel = ev => {
    const dc = ev.channel;
    t.dc = dc;
    dc.binaryType = "arraybuffer";
    const opened = () => {
      if (t.path === PATH.RELAY) return;
      clearTimeout(t.iceTimer);
      t.iceTimer = null;
      setPath(t, PATH.P2P);
      registry.setState(t.id, registry.STATE.RECEIVING);
    };
    dc.onopen = opened;
    // An announced channel arrives already open and engines differ on whether an
    // open event follows. Without this the path is never marked and the timer
    // below tears down a live transfer.
    if (dc.readyState === "open") opened();
    dc.onmessage = msg => {
      try { onChannelMessage(t, msg.data); }
      catch (err) { abort(t, describe(err)); }
    };
    dc.onclose = () => { if (t.path === PATH.P2P && !t.done) abort(t, "the direct connection dropped"); };
    dc.onerror = () => { if (t.path === PATH.P2P && !t.done) abort(t, "the direct connection errored"); };
  };

  // The relay fallback can land during any of the awaits below: onFileChunk
  // closes this pc and starts a working relay receive. `t.pc !== pc` is how the
  // continuation learns the connection was abandoned — without it the next call
  // rejects on a closed pc and takes the live transfer down with it.
  const stale = () => t.done || t.pc !== pc;

  await pc.setRemoteDescription(frame.sdp);
  if (stale()) return;
  t.remoteReady = true;
  await flushIce(t);
  if (stale()) return;

  const answer = await pc.createAnswer();
  if (stale()) return;
  await pc.setLocalDescription(answer);
  if (stale()) return;
  signal({ t: FT.RTC_ANSWER, id: t.id, to: t.peer, sdp: pc.localDescription });

  // Our own copy of the race. If nothing opens we drop the peer connection so it
  // cannot leak, but do NOT fail: the holder's relay chunks are about to arrive
  // on a channel that is already open.
  clearTimeout(t.iceTimer);
  t.iceTimer = setTimeout(() => {
    t.iceTimer = null;
    if (t.path || t.rx || t.dc?.readyState === "open") return;
    console.info(`[transfer] ${t.id}: no direct connection, expecting relay chunks`);
    closeRtc(t);
  }, iceTimeout);
}

async function onRtcAnswer(frame) {
  const t = live.get(frame.id);
  if (!t || t.role !== "send" || !t.pc) return;
  // A second answer is the SSE transport's at-least-once retry. Applying it
  // rejects — the connection is "stable" by then — and that rejection used to
  // kill the transfer mid-stream.
  if (t.remoteReady) return;

  const pc = t.pc;
  await pc.setRemoteDescription(frame.sdp);
  // The ICE race can expire during that await. Marking remoteReady afterwards
  // would undo closeRtc()'s reset and queue candidates onto a dead connection.
  if (t.done || t.pc !== pc) return;
  t.remoteReady = true;
  await flushIce(t);
}

async function onRtcIce(frame) {
  const t = live.get(frame.id);
  if (!t || !frame.candidate) return;
  // Candidates routinely beat the description they belong to.
  if (!t.pc || !t.remoteReady) { t.pendingIce.push(frame.candidate); return; }
  try { await t.pc.addIceCandidate(frame.candidate); }
  catch (err) { console.warn(`[transfer] ${t.id}: rejected ICE candidate`, err); }
}

async function flushIce(t) {
  const queued = t.pendingIce.splice(0);
  for (const candidate of queued) {
    try { await t.pc?.addIceCandidate(candidate); }
    catch (err) { console.warn(`[transfer] ${t.id}: rejected queued ICE candidate`, err); }
  }
}

/** Data-channel traffic: a JSON header, binary chunks, a JSON terminator. */
function onChannelMessage(t, data) {
  if (typeof data === "string") {
    const msg = JSON.parse(data);
    if (msg.hdr) {
      t.meta = checkedMeta(t, msg);              // same guard as the relay path
      t.rx = new chunker.Reassembler(t.meta);
      registry.setState(t.id, registry.STATE.RECEIVING);
      armIdle(t);
      if (t.rx.complete) complete(t);            // zero-byte file: nothing follows
      return;
    }
    if (msg.fin) { if (!t.done) complete(t); }
    return;
  }

  const bytes = chunker.asBytes(data);
  if (bytes.length < CHUNK_HEADER_BYTES) throw new Error("truncated chunk");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seq = view.getUint32(0);
  const crc = view.getUint32(4);
  takeChunk(t, seq, bytes.subarray(CHUNK_HEADER_BYTES), crc);
}

/** Relay fallback data. Its arrival IS the announcement that P2P lost. */
function onFileChunk(frame) {
  const t = live.get(frame.id);
  if (!t || t.role !== "recv") return;
  if (t.path !== PATH.RELAY) {
    closeRtc(t);                                   // the holder gave up; so do we
    setPath(t, PATH.RELAY);
    registry.setState(t.id, registry.STATE.RECEIVING);
  }
  takeChunk(t, frame.seq, chunker.fromB64(frame.b64), frame.crc);
}

function onFileDone(frame) {
  const t = live.get(frame.id);
  if (!t || t.role !== "recv" || t.done) return;
  // A zero-byte file produces no chunks, so nothing built the reassembler yet.
  // With total === 0 it is complete on construction.
  if (!t.rx && t.meta) t.rx = new chunker.Reassembler(t.meta);
  if (t.rx?.complete) complete(t);
  else if (t.rx) abort(t, `transfer ended with ${t.rx.missing().length} chunks missing`);
  else abort(t, "transfer ended before any data arrived");
}

function takeChunk(t, seq, bytes, crc) {
  if (t.done) return;
  if (!t.rx) {
    if (!t.meta) throw new Error("data arrived before the file header");
    t.rx = new chunker.Reassembler(t.meta);
  }
  const r = t.rx.accept({ seq, bytes, crc });
  progress(t, r.percent);
  armIdle(t);
  if (r.complete) complete(t);
}

async function complete(t) {
  if (t.done) return;
  const rx = t.rx;
  const path = t.path ?? PATH.RELAY;
  const name = registry.get(t.id)?.name ?? "file";

  t.done = true;                                   // stop further chunks racing in
  let blob;
  try {
    blob = await rx.finish();                      // verifies the whole-file digest
  } catch (err) {
    // Told to the sender, not just to us. A failed digest was entirely local, so
    // the holder went on reporting a file it had "Sent" that nobody could open.
    signal({ t: FT.FILE_ERROR, id: t.id, to: t.peer, reason: describe(err) });
    finish(t);
    return fail(t.id, describe(err));
  }

  // Before finish(), which is what forgets the peer this is addressed to.
  signal({ t: FT.FILE_OK, id: t.id, to: t.peer, digest: t.meta?.digest ?? null });
  finish(t);
  registry.complete(t.id, blob, path);
  emit(EV.TOAST, path === PATH.RELAY
    ? `${name} received via the relay — not a direct transfer`
    : `${name} received over a direct connection`);
}

/* ------------------------------------------------------------------ *
 * Cancel, failure, cleanup
 * ------------------------------------------------------------------ */

function onFileCancel(frame) {
  const t = live.get(frame.id);
  if (!t) return;
  finish(t);
  registry.cancel(frame.id);
  emit(EV.TOAST, `The other device cancelled ${registry.get(frame.id)?.name ?? "the transfer"}`);
}

/** Our end broke. Tell the peer, tell the user, leave nothing running. */
function abort(t, reason) {
  if (t.done) return;
  signal({ t: FT.FILE_ERROR, id: t.id, to: t.peer, reason });
  finish(t);
  fail(t.id, reason);
}

function closeAndFail(id, reason) {
  const t = live.get(id);
  if (t) finish(t);
  fail(id, reason);
}

function fail(id, reason) {
  registry.fail(id, reason);
  return false;
}

/** Close the peer connection but keep the transfer alive for the fallback. */
function closeRtc(t) {
  clearTimeout(t.iceTimer);
  t.iceTimer = null;
  if (t.dc) {
    t.dc.onopen = t.dc.onmessage = t.dc.onclose = t.dc.onerror = null;
    try { t.dc.close(); } catch { /* already gone */ }
    t.dc = null;
  }
  if (t.pc) {
    t.pc.onicecandidate = t.pc.ondatachannel = null;
    t.pc.onconnectionstatechange = t.pc.oniceconnectionstatechange = null;
    try { t.pc.close(); } catch { /* already gone */ }
    t.pc = null;
  }
  t.pendingIce.length = 0;
  t.remoteReady = false;
}

/** The one exit route. Every path out of a transfer ends here. */
function finish(t) {
  t.done = true;
  // Release anything waiting on a receipt, or a cancelled send sits out the
  // full deadline before it reports.
  t.receipt?.(false);
  clearTimeout(t.deadline); t.deadline = null;
  clearTimeout(t.idleTimer); t.idleTimer = null;
  closeRtc(t);
  if (t.rx && !t.rx.complete) t.rx.abort();        // release up to 5 MB
  t.rx = null;
  t.file = null;
  live.delete(t.id);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Only metadata and the thumbnail travel — the bytes stay put until someone asks
 * (docs/P2P-FILES.md §1).
 */
export function announce(file) {
  if (!file || file.origin !== "local") return false;
  return signal({
    t: FT.FILE_META,
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    // A 160px preview of a screenshot can be perfectly legible, and it travels
    // without being requested (PRD OI-15).
    thumb: state.get().settings.thumbs ? file.thumb : null,
  });
}

export function announceAll() {
  let sent = 0;
  for (const file of registry.all()) {
    if (file.origin === "local" && announce(file)) sent++;
  }
  return sent;
}

// Subscribed here, not wired in main.js: a module that knows how to announce
// should not depend on a distant file remembering to ask it. The outbound half
// was the composition root's job and simply never got written, while the inbound
// half existed and made everything look complete.
on(EV.FILE_ADDED, ({ file }) => announce(file));

// A device that joins later missed every earlier announcement: the relay
// replays the last clip, not the file list. Re-announce when the room grows.
let knownPeers = 1;
on(EV.PEERS_CHANGED, ({ count }) => {
  if (count > knownPeers) announceAll();
  knownPeers = count;
});

// Rotating the key is how a device is ejected. An allowance surviving it would
// let the ejected device keep pulling files.
on(EV.KEY_CHANGED, () => syncAllowances());

function signal(frame) {
  if (!sendSignal) {
    console.warn("[transfer] no signal sender wired — main.js must call setSignalSender()");
    return false;
  }
  frame.originId = state.get().originId;
  try { return sendSignal(frame) !== false; }
  catch (err) {
    console.error("[transfer] signal send threw", err);
    return false;
  }
}

/**
 * "Stop asking me about this device" — a standing grant to send files off the
 * machine, so it is bounded four ways: per device (`autoaccept` in Settings is
 * the global version), per room (dropped when the key changes, so rotating it
 * ejects), per tab (sessionStorage), and for as long as that device stays in the
 * room.
 *
 * The last bound is the load-bearing one. A peer id is a name a client asks for
 * and the relay hands out first-come — so once the allowed device disconnects,
 * the next client to claim its id inherited the grant and could pull any
 * announced file with no prompt at all. A grant follows a device that is here,
 * not a string that outlives it.
 *
 * And never silent — an allowed request still says out loud that it was sent.
 */

let allowances = new Set();
let allowRoom = null;

/** Called when the session key changes — a different room, a clean slate. */
function syncAllowances() {
  const room = state.get().roomHash;
  if (room === allowRoom) return;
  allowRoom = room;
  allowances = new Set(storage.loadAllowances(room));
}

/** Trust this peer for the rest of this session, in this room, in this tab. */
export function allowPeer(peer) {
  const id = _short(peer);
  if (!id) return false;
  syncAllowances();
  allowances.add(id);
  storage.saveAllowances(allowRoom, [...allowances]);
  return true;
}

export function forgetPeer(peer) {
  syncAllowances();
  const gone = allowances.delete(_short(peer));
  storage.saveAllowances(allowRoom, [...allowances]);
  return gone;
}

export function allowedPeers() {
  syncAllowances();
  return [...allowances];
}

// The grant dies with the connection it was given to. See the note above.
on(EV.PEER_LEFT, ({ id }) => { if (id) forgetPeer(id); });

export function isPeerAllowed(peer) {
  syncAllowances();
  return allowances.has(_short(peer));
}

const _short = v => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * With no approver installed we deny: failing open here means anyone holding the
 * session key silently pulls any file (docs/P2P-FILES.md §6).
 */
async function allowed(file, peer) {
  if (state.get().settings.autoaccept) return true;

  if (isPeerAllowed(peer)) {
    // The user allowed this device, not this file, and a transfer nobody is told
    // about is indistinguishable from a leak.
    emit(EV.TOAST, `Sent ${file.name} — ${peer} is allowed for this session`);
    return true;
  }

  if (!approver) {
    console.warn("[transfer] no approver wired — denying. ui/filesPanel.js should call setApprover()");
    return false;
  }
  try {
    return !!(await approver({
      id: file.id, name: file.name, size: file.size, type: file.type, from: peer,
    }));
  } catch (err) {
    console.error("[transfer] approver threw — denying", err);
    return false;
  }
}

function setPath(t, path) {
  t.path = path;
  registry.setPath(t.id, path);                    // emits EV.TRANSFER_PATH
}

function progress(t, percent) {
  const next = Math.max(0, Math.min(100, Math.round(percent)));
  if (next === t.percent) return;
  t.percent = next;
  registry.setProgress(t.id, next);
}

/** Nothing at all for a while means the peer vanished mid-transfer. */
function armIdle(t) {
  clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => {
    if (t.done) return;
    abort(t, "the transfer stalled — the other device stopped responding");
  }, stallMs());
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const describe = err => (err?.message || String(err || "unknown error"));
