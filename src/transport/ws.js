/**
 * WebSocket channel — the default way to reach the relay.
 *
 * A channel moves frames and nothing else — hello, heartbeats, backoff and
 * transport choice all live in relay.js, once, for both channels.
 *
 *   create({ url, roomHash, onOpen, onFrame, onDown }) -> { send, close, isOpen }
 *
 *   onOpen()          the channel is usable; frames may be sent
 *   onFrame(msg)      one parsed inbound frame
 *   onDown({code, reason})
 *                     finished and will not recover. Fired at most once, and
 *                     never after close() — a deliberate close is not an event.
 */

import * as proto from "./protocol.js";

export const LABEL = "WebSocket";

export const available = () => typeof WebSocket !== "undefined";

export function create({ url, roomHash, auth = null, org = null, onOpen, onFrame, onDown }) {
  let done = false;

  const finish = (code, reason) => {
    if (done) return;
    done = true;
    onDown({ code, reason });
  };

  let sock;
  try {
    // `?a=` is a locked session's admission token. Not a secret in the sense
    // the PIN is — it is HKDF output the relay compares against the room's
    // first arrival — but it is still session material, so it rides in the
    // query rather than the path for the same reason `sid` does on the SSE
    // path: paths are what proxies and access logs like to keep.
    // `?org=` is the deployment's join token, where one is configured. Built
    // with the admission token rather than appended to it, because a relay that
    // requires an org refuses the join outright and the two are independent.
    const query = new URLSearchParams();
    if (auth) query.set("a", auth);
    if (org) query.set("org", org);
    const qs = query.toString();
    sock = new WebSocket(`${url.replace(/\/+$/, "")}/ws/${roomHash}${qs ? `?${qs}` : ""}`);
  } catch (err) {
    // Constructing the socket throws synchronously on a malformed URL, and on
    // a Content-Security-Policy that forbids the scheme — which is one of the
    // ways a managed browser blocks WebSockets outright. Report it as a normal
    // channel failure so the caller can fall back rather than crash on boot.
    Promise.resolve().then(() => finish(0, err.message || "could not open"));
    return { label: LABEL, send: () => false, close: () => { done = true; }, isOpen: () => false };
  }

  // The upgrade is deliberately NOT the open signal. It completes before the
  // relay has looked at the room at all, so a refused admission — a full room,
  // a wrong token, a busy relay, too many connections from one address — lands
  // on a socket that opened perfectly, and a caller promoted on the upgrade
  // reported a session it had just been turned away from. sse.js has always
  // waited for the welcome; this now agrees with it.
  //
  // Safe because the relay sends `welcome` unprompted the moment it accepts a
  // peer, before any `hello` — see backend/main.py _join().
  let welcomed = false;
  sock.onopen = () => {};
  sock.onmessage = e => {
    const msg = proto.parse(e.data);
    if (!welcomed && msg.t === proto.T.WELCOME) {
      welcomed = true;
      onOpen();
    }
    onFrame(msg);
  };

  // onerror carries no useful detail in any browser, and a close event always
  // follows it — so the close is the single place failure is reported from.
  sock.onerror = () => {};
  sock.onclose = ev => finish(ev.code, ev.reason);

  return {
    label: LABEL,
    isOpen: () => sock.readyState === WebSocket.OPEN,

    send(obj) {
      if (sock.readyState !== WebSocket.OPEN) return false;
      sock.send(JSON.stringify(obj));
      return true;
    },

    close(code = 1000) {
      done = true;
      try { sock.close(code); } catch { /* already gone */ }
    },
  };
}
