/**
 * SSE + POST channel — the fallback for networks that will not pass WebSockets
 * (PRD §4.3 R3, §5.4). Server-Sent Events are an ordinary long-lived GET and
 * sends are an ordinary POST, so there is no Upgrade for a TLS-inspecting proxy
 * to refuse. Implements the transport/ws.js contract exactly.
 *
 * Two things SSE does not give for free:
 *
 *   1. It is one-directional. Upstream frames POST to /pub, coalesced (see
 *      flush) so a burst of ICE candidates or file chunks is one request.
 *      Self-hosting behind HTTP/1.1: a browser allows six connections per host
 *      and an event stream holds one open for the life of the tab, so half a
 *      dozen tabs can starve each other. HTTP/2 multiplexes and the limit goes.
 *
 *   2. It has no connection identity. The stream is the session, so the relay
 *      issues a `sid` on welcome and every POST names it — otherwise a POST
 *      cannot say which of eight peers it came from, since the relay can only
 *      trust the connection a frame arrived on, and here that is the stream.
 */

import { NET } from "../core/config.js";
import * as proto from "./protocol.js";

export const LABEL = "HTTP stream";

/**
 * The relay answered, but not on /sse — a build from before the fallback
 * existed. Worth telling apart from a blocked network: it looks identical from
 * here and the fix is the opposite. Also the likeliest way to meet this path,
 * by deploying the frontend ahead of the relay.
 */
export const NO_FALLBACK = "relay has no fallback endpoint";

export const available = () =>
  typeof EventSource !== "undefined" && typeof fetch === "function";

/** How long to wait before retrying a POST that failed to reach the relay. */
const RETRY_MS = 400;

/** A POST that never answers must not wedge the outbox behind it. */
const POST_TIMEOUT_MS = 15_000;

export function create({ url, roomHash, auth = null, org = null, onOpen, onFrame, onDown }) {
  const base = url.replace(/^ws/i, "http").replace(/\/+$/, "");

  let sid = null;          // issued by the relay on `welcome`; null until then
  let done = false;
  let outbox = [];         // serialised frames queued but not yet in flight
  let inflight = false;
  let retried = false;
  let retryTimer = null;

  const finish = (code, reason) => {
    if (done) return;
    done = true;
    clearTimeout(retryTimer);
    try { es.close(); } catch { /* already gone */ }
    onDown({ code, reason });
  };

  // `?a=` — a locked session's admission token, checked at join on both
  // transports so the fallback is not the lenient way in. `?org=` is the
  // deployment's join token, for a relay that runs with one; the fallback has
  // to carry it too, or turning the setting on would work over WebSockets and
  // silently refuse every device that failed over to HTTP.
  const query = new URLSearchParams();
  if (auth) query.set("a", auth);
  if (org) query.set("org", org);
  const qs = query.toString();
  const es = new EventSource(`${base}/sse/${roomHash}${qs ? `?${qs}` : ""}`);

  es.onmessage = e => {
    const msg = proto.parse(e.data);

    // "Open" means the welcome ARRIVED, not that the GET was accepted: a proxy
    // that buffers the response body accepts happily and delivers nothing, which
    // is indistinguishable from a working stream until you insist on seeing a
    // frame. relay.js gives every channel NET.PROBE_MS to reach this line.
    if (msg.t === proto.T.WELCOME && msg.sid && !sid) {
      sid = msg.sid;
      delete msg.sid;      // transport plumbing; the protocol layer never sees it
      onOpen();
    }

    onFrame(msg);
  };

  es.onerror = () => {
    // EventSource reconnects on its own, which must not happen: the relay would
    // accept the new stream as a brand-new peer with a new sid while we carry on
    // POSTing under the old one — a ghost in the roster and every send rejected.
    // Reconnection is relay.js's job, with its backoff and its rejoin.
    if (sid) return finish(4001, "stream dropped");

    // Nothing came back and EventSource will not say why — no status, no body,
    // and a 404 with no CORS header reads in the console as a cross-origin
    // block. So ask /health: if it answers, the route is what is missing.
    classify().then(reason => finish(4000, reason));
  };

  async function classify() {
    const guard = deadline(5000);
    try {
      const res = await fetch(`${base}/health`, { signal: guard.signal });
      return res.ok ? NO_FALLBACK : `relay error ${res.status}`;
    } catch {
      return "stream refused";
    } finally {
      guard.clear();
    }
  }

  /**
   * Bounded on both count and bytes so one flush cannot exceed what the relay
   * accepts in a body — a file transfer on the relay-chunk path (FR-7.6) can
   * queue hundreds of 32 KB frames in a moment.
   */
  function take() {
    const batch = [];
    let bytes = 0;
    while (outbox.length && batch.length < NET.POST_MAX_FRAMES) {
      const next = outbox[0];
      if (batch.length && bytes + next.length > NET.POST_MAX_BYTES) break;
      bytes += next.length;
      batch.push(outbox.shift());
    }
    return batch;
  }

  async function flush() {
    if (inflight || done || !sid || !outbox.length) return;
    inflight = true;
    const batch = take();

    let res = null;
    const guard = deadline();
    try {
      res = await fetch(`${base}/pub/${roomHash}?sid=${encodeURIComponent(sid)}`, {
        method: "POST",
        // text/plain keeps this a CORS "simple request". application/json would
        // preflight every send — an extra OPTIONS round trip per clip, on the
        // transport already chosen for being slower. The relay parses by shape.
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        // One frame per line. JSON.stringify escapes every literal newline, so
        // a frame can never contain one and the split is unambiguous.
        body: batch.join("\n"),
        signal: guard.signal,
      });
    } catch {
      // Did not reach the relay. Retry once — a clip the user copied is worth a
      // second attempt — then drop rather than build an unbounded queue of stale
      // frames. The stream reports the session dead; a failed POST does not.
      if (!retried) {
        retried = true;
        outbox = batch.concat(outbox);
        retryTimer = setTimeout(() => { inflight = false; flush(); }, RETRY_MS);
        return;
      }
      retried = false;
      inflight = false;
      console.warn(`[realtimeclipboard] dropped ${batch.length} frame(s): relay unreachable`);
      return flush();
    } finally {
      guard.clear();
    }

    retried = false;
    inflight = false;

    // The stream backing this sid is gone, so there is nowhere for the relay to
    // answer even if it accepted the frame. Reopening is the only fix.
    if (res.status === 404 || res.status === 410) {
      return finish(4404, "session expired");
    }
    // Anything else the relay dislikes it also says on the stream as an error
    // frame, which the UI already surfaces.
    if (!res.ok) console.warn(`[realtimeclipboard] relay rejected a send: HTTP ${res.status}`);

    if (outbox.length) flush();
  }

  return {
    label: LABEL,

    // Usable means the relay has answered and we know who we are. Before the
    // welcome there is no sid, so there is nowhere to send.
    isOpen: () => !done && sid !== null,

    send(obj) {
      if (done || !sid) return false;
      outbox.push(JSON.stringify(obj));
      flush();
      return true;
    },

    close() {
      done = true;
      clearTimeout(retryTimer);
      outbox = [];
      // Ending the stream is what tells the relay we left: it notices the
      // response body being cancelled and drops us from the roster.
      try { es.close(); } catch { /* already gone */ }
    },
  };
}

/**
 * Deliberately not AbortSignal.timeout(): that cannot be cancelled, so it fires
 * whether or not the fetch succeeded, and aborting a settled request still
 * records it as cancelled. Every POST then shows red in the network tab as
 * `net::ERR_ABORTED` seconds after returning 204 — a convincing way for working
 * code to look broken.
 */
function deadline(ms = POST_TIMEOUT_MS) {
  if (typeof AbortController === "undefined") return { signal: undefined, clear() {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}
