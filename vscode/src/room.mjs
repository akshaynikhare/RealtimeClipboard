/**
 * The session, for this surface.
 *
 * The derive/connect/decrypt half lives in cli/session.mjs, shared with the CLI
 * and the MCP server — three copies of "drop the beacon, decrypt, resolve when
 * welcomed" is three chances for two ends to disagree silently. What stays here
 * is what only this surface wants: state.setKey(), the bus events the UI listens
 * on, and the peer name.
 */

import * as keys from "../../src/core/keys.js";
import * as state from "../../src/core/state.js";
import * as relay from "../../src/transport/relay.js";
import { emit, EV } from "../../src/core/bus.js";
import { sharesSession } from "../../src/core/config.js";
import * as shared from "../../cli/session.mjs";

/** Sent in the clear and rebroadcast to the whole roster, so: no hostname, no
 *  username. `device.name()` would say "Browser · Unknown" — Node ships a
 *  synthetic navigator — which is worse than useless in a peer list. */
export const peerName = () => `VS Code · ${process.platform}`;

let session = null;
const originId = () => state.get().originId;

export const current = () => session;
export const isOpen = () => session !== null && relay.isOpen();

export const derive = shared.derive;

export async function open({ key, pin = null }) {
  close();
  const s = await shared.derive(key, pin);
  session = s;

  state.setKey({
    key: s.key, roomHash: s.roomHash, aesKey: s.aesKey,
    locked: s.locked, authToken: s.auth,
  });

  await shared.open({
    session: s,
    name: peerName(),
    // The shared layer has already shut the connection: the room was abandoned
    // by the device that owned it, and staying in it means syncing with nobody
    // while the status bar says otherwise.
    onEvicted: () => {
      session = null;
      state.clearKey();
      state.resetRoster();
      state.setConnection("idle", "removed — the session was locked");
      emit(EV.TOAST, "This session moved — the key or PIN was changed");
    },
    onClip: (text) => {
      // "Off: nothing arrives" holds here too, and the control frames never
      // reach this far — cli/session.mjs drops them before the callback.
      if (!sharesSession(state.get().settings.syncMode)) return;
      emit(EV.TEXT_RECEIVED, { text });
    },
  });
  return s;
}

export const send = (text) => shared.send(session, text, originId());

/** Announce the room being abandoned, so nobody is left connected to nothing. */
export async function evict() {
  if (session) await shared.evict(session, originId());
}

export function close() {
  if (!session) return;
  session = null;
  shared.close();
  state.resetRoster();
}

export const shareLink = () => (session ? keys.shareLink(session.key, session.locked) : null);
