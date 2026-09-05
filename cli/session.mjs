/**
 * A room, as a promise-shaped API — for the surfaces that have a caller waiting.
 *
 * relay.js announces state on the bus because in a browser the connection
 * outlives any one call. `cli/`, `mcp/` and `vscode/` all have something waiting
 * instead, and all three had adapted the bus back into a promise separately.
 * This is that adapter, once, because three copies of "derive, connect, decrypt,
 * drop the beacon" is three chances for two ends to disagree silently.
 *
 * Deliberately below the app: it touches no state, emits no bus events and knows
 * nothing about history, editors or clipboards. It hands decrypted text to a
 * callback and stops. What each surface does next is that surface's business.
 *
 * WHY IT LIVES IN cli/ AND NOT src/transport/, which is where it looks like it
 * belongs: `src/` is the web app, and every .js under it is app shell — the
 * precache check in tests/unit/static-check.mjs treats the directory itself as
 * the list. A module no page ever loads would have to be precached anyway, or
 * carved out with an exception. `cli/` is already the npm publish boundary and
 * already the headless half of this codebase, so it is the honest home; `mcp/`
 * and `vscode/` import it from here.
 */

import * as keys from "../src/core/keys.js";
import * as cryptoBox from "../src/core/crypto.js";
import { LOCK, TEXT, textBytes, NET } from "../src/core/config.js";
import { on, EV } from "../src/core/bus.js";
import * as relay from "../src/transport/relay.js";
import * as proto from "../src/transport/protocol.js";

/**
 * Everything needed to talk in a room, derived exactly as the browser derives
 * it — same salt, same iteration count, same HKDF info strings, because it is
 * the same function.
 *
 * Throws rather than exiting: a library that calls process.exit() cannot be
 * used by anything that wants to handle the failure.
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
 * Connect, and resolve once the relay has welcomed us.
 *
 * The connect bound is separate from any read timeout a caller keeps: "the relay
 * never answered" and "nothing was ever sent to this room" are different
 * failures, and a script handed one when it expected the other has been told a
 * lie about its own network.
 *
 *   onClip(text, frame)   decrypted, beacon already dropped
 *   onUndecryptable()     someone in the room on another secret — not an error
 */
export function open({ session, name, url, onClip, onUndecryptable, onState, timeoutMs = 0 }) {
  return new Promise((resolve, reject) => {
    let off = null;
    const timer = setTimeout(() => {
      off?.();                       // or the subscription outlives every failed open
      reject(new Error("the relay did not answer"));
    }, Math.max(timeoutMs || 0, NET.PROBE_MS * 2.5));

    off = on(EV.CONN_STATE, ({ state, detail }) => {
      onState?.(state, detail);
      if (state !== "connected") return;
      clearTimeout(timer);
      off();
      resolve(session);
    });

    relay.setFrameHandler(async (msg) => {
      if (msg.t !== proto.T.CLIP || !msg.payload) return;
      let text;
      try {
        text = await cryptoBox.decrypt(session.aesKey, msg.payload, msg.iv);
      } catch {
        // Undecryptable means a different secret, not a corrupt relay: someone
        // in the room on another PIN, or a stale frame from a rotated key.
        onUndecryptable?.();
        return;
      }
      // A control frame wearing a clip's clothes — it is what lets a joiner tell
      // "wrong PIN" from "first one here". Compared against the constant, never
      // "looks like a control character", which would also swallow a legitimate
      // clip that happened to start with NUL.
      if (text === LOCK.BEACON) return;
      onClip?.(text, msg);
    });

    relay.connect({
      roomHash: session.roomHash,
      intent: "join",
      name,
      auth: session.auth,
      ...(url ? { url } : {}),
    });
  });
}

/** Bytes, not characters: the frame cap is what the relay actually enforces. */
export async function send(session, text, originId) {
  if (!text) throw new Error("there is nothing to send");
  if (textBytes(text) > TEXT.MAX_BYTES) {
    throw new Error(`that is ${textBytes(text)} bytes; the limit is ${TEXT.MAX_BYTES}`);
  }
  const { payload, iv } = await cryptoBox.encrypt(session.aesKey, text);
  return relay.send(proto.clip({ payload, iv, originId }));
}

/** Announce a room being abandoned, so nobody is left connected to nothing. */
export async function evict(session, originId) {
  try {
    const { payload, iv } = await cryptoBox.encrypt(session.aesKey, LOCK.EVICT);
    relay.send(proto.clip({ payload, iv, originId }));
  } catch { /* leaving anyway */ }
}

/** Is the room actually usable right now? Callers that reconnect on demand ask
 *  this before tearing a live connection down and building it again. */
export const isOpen = () => relay.isOpen();

export function close() {
  relay.setFrameHandler(() => {});
  relay.close();
}
