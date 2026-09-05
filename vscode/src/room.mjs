/**
 * Everything needed to talk in a room, derived exactly as the browser derives it
 * — same salt, same iteration count, same HKDF info strings, because it is the
 * same function. Nothing here may reimplement a protocol detail.
 */

import * as keys from "../../src/core/keys.js";
import * as cryptoBox from "../../src/core/crypto.js";
import * as relay from "../../src/transport/relay.js";
import * as proto from "../../src/transport/protocol.js";
import * as state from "../../src/core/state.js";
import { on, emit, EV } from "../../src/core/bus.js";
import { LOCK, TEXT, textBytes, NET } from "../../src/core/config.js";

/** Sent in the clear and rebroadcast to the whole roster, so: no hostname, no
 *  username. `device.name()` would say "Browser · Unknown" — Node ships a
 *  synthetic navigator — which is worse than useless in a peer list. */
export const peerName = () => `VS Code · ${process.platform}`;

let session = null;

export const current = () => session;
export const isOpen = () => session !== null && relay.isOpen();

/**
 * A wrong PIN does not announce itself: it derives a different, empty room that
 * is just as real and just as joinable. The beacon is what lets a joiner tell
 * "wrong PIN" from "first one here".
 */
export async function derive(rawKey, pin) {
  const key = keys.normalise(rawKey);
  const refused = keys.rejectMessage(key);
  if (refused) throw new Error(`"${rawKey}" cannot be used — ${refused}`);

  if (pin) {
    const clean = cryptoBox.normalisePin(pin);
    if (!clean) throw new Error(`a PIN needs at least ${LOCK.MIN_PIN} characters`);
    const d = await cryptoBox.deriveLocked(key, clean);
    return { key, roomHash: d.roomHash, aesKey: d.aesKey, auth: d.authToken, locked: true };
  }
  const d = await cryptoBox.deriveOpen(key);
  return { key, roomHash: d.roomHash, aesKey: d.aesKey, auth: null, locked: false };
}

/**
 * relay.js announces state on the bus rather than returning a promise, because a
 * connection outlives any one call. There is a command waiting here, so the bus
 * event is adapted back into a promise — with a bound, since a session that
 * hangs forever is worse than one that fails.
 */
export function open({ key, pin = null }) {
  return derive(key, pin).then(s => new Promise((resolve, reject) => {
    close();
    session = s;

    state.setKey({
      key: s.key, roomHash: s.roomHash, aesKey: s.aesKey,
      locked: s.locked, authToken: s.auth,
    });

    let off = null;
    const timer = setTimeout(() => {
      off?.();                      // or the subscription outlives every failed open
      reject(new Error("the relay did not answer"));
    }, NET.PROBE_MS * 4);
    off = on(EV.CONN_STATE, ({ state: st }) => {
      if (st !== "connected") return;
      clearTimeout(timer);
      off();
      resolve(s);
    });

    relay.setFrameHandler(onFrame);
    relay.connect({
      roomHash: s.roomHash,
      intent: "join",
      name: peerName(),
      auth: s.auth,
    });
  }));
}

async function onFrame(msg) {
  if (!session) return;
  if (msg.t !== proto.T.CLIP || !msg.payload) return;
  try {
    const text = await cryptoBox.decrypt(session.aesKey, msg.payload, msg.iv);
    // Control frames wearing a clip's clothes. Compared against the constants,
    // never "looks like a control character" — that would swallow a legitimate
    // clip which happened to start with NUL.
    if (text === LOCK.BEACON) return;
    if (text === LOCK.EVICT) {
      emit(EV.TOAST, "This session moved — the key or PIN was changed");
      return;
    }
    emit(EV.TEXT_RECEIVED, { text, from: msg.name || "a peer" });
  } catch {
    // Undecryptable means a different secret, not a corrupt relay: someone in
    // the room on another PIN, or a stale frame from a rotated key.
  }
}

export async function send(text) {
  if (!session || !text) return false;
  if (textBytes(text) > TEXT.MAX_BYTES) {
    throw new Error(`that clip is over the ${Math.floor(TEXT.MAX_BYTES / 1024)} KB limit`);
  }
  const { payload, iv } = await cryptoBox.encrypt(session.aesKey, text);
  return relay.send(proto.clip({ payload, iv, originId: state.get().originId }));
}

/** Announce the room being abandoned, so nobody is left connected to nothing. */
export async function evict() {
  if (!session) return;
  try {
    const { payload, iv } = await cryptoBox.encrypt(session.aesKey, LOCK.EVICT);
    relay.send(proto.clip({ payload, iv, originId: state.get().originId }));
  } catch { /* leaving anyway */ }
}

export function close() {
  if (!session) return;
  session = null;
  relay.setFrameHandler(() => {});
  relay.close();
  state.resetRoster();
}

export const shareLink = () => (session ? keys.shareLink(session.key, session.locked) : null);
