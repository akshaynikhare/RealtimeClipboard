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
import { sealWith, openWith } from "../src/core/frames.js";

/**
 * Which room this module is currently in. Bumped by open() and close(), and
 * therefore by eviction, which goes through close().
 *
 * It exists for the one thing here that outlives the frame it started from: a
 * verification answer takes two awaits to produce, and both of them are long
 * enough for the surface to have left the room, rejoined on another key, or
 * been evicted from it. Sealed with the old key and sent into the new room,
 * that answer is undecryptable noise attributed to this device.
 */
let epoch = 0;

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
    // Length, not truthiness. A one-character PIN passed this and derived a real
    // locked room that the web PIN dialog then refused to join, because it
    // enforces the floor on every mode — so these clients could create sessions
    // no browser could open, with a secret worth a couple of bits.
    const clean = cryptoBox.normalisePin(pin);
    if (clean.length < LOCK.MIN_PIN) {
      throw new Error(`a PIN needs at least ${LOCK.MIN_PIN} characters`);
    }
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
 *   onClip(text, frame)   decrypted, control frames already dropped
 *   onEvicted()           the room was abandoned; the connection is ALREADY shut
 *   onUndecryptable()     someone in the room on another secret — not an error
 *
 * `originId` is this surface's own id — the same one it passes to send(). It is
 * wanted here because a locked room's verification is answered from inside this
 * handler, with no caller to ask.
 *
 * `sharing` is that answer's rung gate. Defaulted to "yes" rather than made
 * required, and the default is correct rather than convenient: the CLI, the MCP
 * server and the browser extension have no Off rung to consult — every one of
 * their sessions exists because somebody asked for it. VS Code does have one,
 * and passes it. See vscode/src/room.mjs.
 */
export function open({
  session, name, url, originId, sharing = () => true,
  onClip, onEvicted, onUndecryptable, onState, timeoutMs = 0,
}) {
  // A rejoin is a different room, even on the same key — re-PINning keeps the
  // key and moves the room. Anything still in flight for the last one is now
  // answering a question nobody asked.
  const mine = ++epoch;

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
      if (msg.t === proto.T.VERIFY) {
        return answerVerify({ session, msg, originId, sharing, mine });
      }
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

      // The other control frame, and it was not filtered — it reached callers as
      // clip text, so the sentinel was printed to stdout by the CLI, recorded as
      // a clip for the model by the MCP server, and put on the extension's badge.
      // Every one of them then stayed connected to a room the owner had left.
      //
      // Closed here rather than left to each surface: "stop talking to a room
      // nobody is in" is not a per-client decision, and three of the four
      // clients did not know they had to make it.
      if (text === LOCK.EVICT) {
        close();
        onEvicted?.();
        return;
      }

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

/**
 * Prove a locked room to whoever asked.
 *
 * These four surfaces are frequently the ONLY other device in a room — a phone
 * on the web app plus a terminal, plus nothing else — and a locked session
 * cannot confirm its PIN without a peer that answers. Silent here, and the
 * browser at the other end sits on "the PIN may not match theirs" for the whole
 * session while the CLI it is talking to reads every clip perfectly.
 *
 * `probe !== true` is the loop guard, and it is the same one the app uses: an
 * answer is never answered.
 *
 * Both gates are re-read at every step rather than once at the top, because
 * there are two awaits here and each is a window: the rung can come down and
 * the room can change inside either.
 *
 * The rung is checked BEFORE the decryption, which is where this deliberately
 * differs from the app (src/main.js, case proto.T.VERIFY). There, opening the
 * frame is what sets `verified`, so an Off device is entitled to do it — the
 * rung governs what reaches the user, not what the session knows. Here nothing
 * is learned from opening it: the only thing this function produces is a frame
 * on the wire, so a surface that has said nothing leaves has no reason to start
 * decrypting.
 */
async function answerVerify({ session, msg, originId, sharing, mine }) {
  if (!session.locked || !sharing() || mine !== epoch) return;

  const frame = await openWith(session.aesKey, msg);
  if (!sharing() || mine !== epoch) return;
  if (!frame || frame.probe !== true) return;

  const answer = await sealWith(session.aesKey, proto.verify({ probe: false, originId }));
  if (!sharing() || mine !== epoch) return;
  relay.send(answer);
}

/** Bytes, not characters: the frame cap is what the relay actually enforces. */
export async function send(session, text, originId) {
  if (!text) throw new Error("there is nothing to send");
  if (textBytes(text) > TEXT.MAX_BYTES) {
    throw new Error(`that is ${textBytes(text)} bytes; the limit is ${TEXT.MAX_BYTES}`);
  }
  const { payload, iv } = await cryptoBox.encrypt(session.aesKey, text);
  // The relay's boolean means "handed to an open socket", and every caller
  // ignored it: the CLI exited 0 having sent nothing, the MCP server told the
  // model the clip was delivered, and the extension said "Sent N characters."
  // — all while disconnected. A throw is the one result none of them can drop
  // by accident, and each already reports a thrown error.
  if (!relay.send(proto.clip({ payload, iv, originId }))) {
    throw new Error("not connected to the relay — nothing was sent");
  }
  return true;
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
  // Before the socket, not after: a response mid-seal must be abandoned even
  // though relay.send() would refuse it anyway, because the next open() may
  // have handed the transport a new room by the time that seal resolves.
  epoch++;
  relay.setFrameHandler(() => {});
  relay.close();
}
