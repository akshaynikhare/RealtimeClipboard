/**
 * Direct transfers: do the bytes actually arrive?
 *
 * They did not. streamOverDataChannel() sent the fin marker and called sent()
 * in the same turn, and sent() reaches closeRtc() -> pc.close(), which destroys
 * the SCTP association along with everything still queued in it. dc.send() only
 * queues, and drain() only paused above the 256 KB high-water mark — so any
 * file below it, which is most pasted clipboard images, was discarded whole
 * while the sender toasted "Sent … over a direct connection".
 *
 * transfer.js has carried setPeerFactory/setIceTimeoutMs/setRequestTimeoutMs as
 * test seams since it was written, and no suite used any of them. Nothing
 * exercised the direct path end to end, which is why this shipped.
 *
 * The fake data channel below models the one property that matters: close()
 * drains what it holds, and the peer connection closing throws it away.
 *
 * Usage: node tests/unit/transfer.mjs
 */

import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = p => import(pathToFileURL(join(REPO, p)).href);

let pass = 0, fail = 0;
const ok = (name, good, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const registry = await load("src/files/registry.js");
const transfer = await load("src/files/transfer.js");
const state    = await load("src/core/state.js");
const bus      = await load("src/core/bus.js");

const ICE_MS = 300;                       // stall bound becomes ICE_MS * IDLE_GRACE
const SIZE = 100 * 1024;                  // a plausible pasted PNG, under SEND_HIGH_WATER

/**
 * Per-message time on the fake wire. It has to be slower than the send loop
 * fills the queue, which is what congestion control and RTT do on a real
 * association — otherwise the queue drains between the chunker's awaits and
 * the bug under test cannot happen at all.
 */
const WIRE_MS = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/* ------------------------------------------------------------------ *
 * A data channel that queues, like the real one
 * ------------------------------------------------------------------ */

class FakeChannel {
  constructor(label) {
    this.label = label;
    this.readyState = "connecting";
    this.binaryType = "";
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.far = null;
    this.queue = [];
    this.pump = null;
    this.closing = false;
    this.listeners = new Map();
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type, ev = { type }) {
    this[`on${type}`]?.(ev);
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  open() {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.dispatch("open");
  }

  /** Queues. Never delivers synchronously — that is the whole point. */
  send(data) {
    if (this.readyState !== "open") throw new Error("channel is not open");
    const bytes = typeof data === "string" ? data.length : data.byteLength;
    this.queue.push({ data, bytes });
    this.bufferedAmount += bytes;
    this.schedule();
  }

  schedule() {
    if (this.pump) return;
    this.pump = setTimeout(() => { this.pump = null; this.tick(); }, WIRE_MS);
  }

  tick() {
    if (this.queue.length) {
      const item = this.queue.shift();
      // bufferedamountlow fires on the DOWNWARD crossing only. A fix that sets
      // the threshold on an already-drained queue and then waits for an event
      // that can never come has to fail here.
      const above = this.bufferedAmount > this.bufferedAmountLowThreshold;
      this.bufferedAmount -= item.bytes;
      if (above && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatch("bufferedamountlow");
      }
      this.far?.deliver(item.data);
    }
    if (this.queue.length) this.schedule();
    else if (this.closing) this.finishClose();
  }

  deliver(data) {
    if (this.readyState === "closed") return;
    FakeChannel.tap?.(data);
    this.dispatch("message", { data });
  }

  /** An ordered stream reset: what is already queued still goes. */
  close() {
    if (this.readyState === "closed" || this.closing) return;
    this.closing = true;
    if (this.queue.length) this.schedule();
    else this.finishClose();
  }

  finishClose() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.closing = false;
    this.dispatch("close");
    setTimeout(() => this.far?.remoteClosed(), 0);
  }

  remoteClosed() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatch("close");
  }

  /** pc.close(): the transport dies and takes the queue with it. */
  discard() {
    clearTimeout(this.pump);
    this.pump = null;
    this.queue.length = 0;
    this.bufferedAmount = 0;
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.closing = false;
    this.dispatch("close");
  }
}

class FakePeer {
  constructor(announceOpenEvent) {
    this.announceOpenEvent = announceOpenEvent;
    this.sctp = { maxMessageSize: 65535 };
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.onicecandidate = this.ondatachannel = null;
    this.onconnectionstatechange = this.oniceconnectionstatechange = null;
    this.channels = [];
    this.localDescription = null;
  }

  createDataChannel(label) {
    const dc = new FakeChannel(label);
    this.channels.push(dc);
    return dc;
  }

  async createOffer() { return { type: "offer", sdp: "fake-offer" }; }
  async createAnswer() { return { type: "answer", sdp: "fake-answer" }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async addIceCandidate() { }

  async setRemoteDescription(d) {
    if (d?.type !== "offer") return;
    // We are the answering side. Link the pair, hand the channel over the way
    // an engine does, and only then let the offerer start writing to it.
    setTimeout(() => {
      const offerer = FakePeer.offerer;
      const theirs = offerer.channels[0];
      const mine = new FakeChannel(theirs.label);
      this.channels.push(mine);
      mine.far = theirs;
      theirs.far = mine;

      // A channel announced by the remote peer arrives already open; whether an
      // open event follows is engine-dependent, so both are exercised.
      mine.readyState = "open";
      this.ondatachannel?.({ channel: mine });
      if (this.announceOpenEvent) mine.dispatch("open");

      theirs.open();
    }, 0);
  }

  close() {
    this.connectionState = "closed";
    for (const dc of this.channels) dc.discard();
  }
}

/* ------------------------------------------------------------------ *
 * One transfer, both roles, in one module instance
 * ------------------------------------------------------------------ */

async function runTransfer(announceOpenEvent) {
  const ME = state.get().originId;
  const RX = `rx-${announceOpenEvent ? "open" : "silent"}`;
  let TX = null;

  // How much of the payload had actually left the queue when the sender claimed
  // success. Without an acknowledgement frame (the file-ok follow-up) this is
  // the strongest delivery signal this side has — and it is the one the bug
  // broke: the queue was discarded by pc.close() with the toast already out.
  let landed = 0, expected = 0;
  FakeChannel.tap = data => {
    if (typeof data !== "string") { landed++; return; }
    const msg = JSON.parse(data);
    if (msg.hdr) expected = msg.total;
  };

  const toasts = [];
  let sentSaw = null;
  const offToast = bus.on(bus.EV.TOAST, m => {
    const msg = String(m);
    if (msg.startsWith("Sent ") && sentSaw === null) sentSaw = landed;
    toasts.push(msg);
  });

  // The bridge. Direction is unambiguous from `to`, because the two roles
  // address different fake peers; the ids and originIds are rewritten so one
  // registry can hold both ends of the same file.
  //
  // `from` is stamped exactly as the relay stamps it — on the connection the
  // frame arrived on, overwriting whatever the sender put there. transfer.js
  // identifies peers by it and refuses a frame that carries none, so a bridge
  // that leaves it off is not standing in for a relay at all.
  transfer.setSignalSender(frame => {
    if (!frame.to) return true;                          // file-meta broadcast
    const fromSender = frame.to === "peerB";
    const relayed = {
      ...frame,
      id: fromSender ? RX : TX,
      originId: fromSender ? "peerA" : "peerB",
      from: fromSender ? "peerA" : "peerB",
      to: ME,
    };
    setTimeout(() => transfer.onSignal(relayed), 0);
    return true;
  });

  const src = new Uint8Array(SIZE);
  for (let i = 0, x = 7; i < src.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; src[i] = x & 0xff; }

  const before = new Set(registry.all().map(f => f.id));
  await registry.add([new File([src], "paste.png", { type: "image/png" })], { makeThumbs: false });
  TX = registry.all().find(f => !before.has(f.id)).id;

  registry.addRemote({ id: RX, name: "paste.png", size: SIZE,
                       type: "image/png", thumb: null, originId: "peerA" });

  let nth = 0;
  transfer.setPeerFactory(() => {
    const pc = new FakePeer(announceOpenEvent);
    if (nth++ === 0) FakePeer.offerer = pc;
    return pc;
  });

  state.setSetting("autoaccept", true);
  transfer.setIceTimeoutMs(ICE_MS);
  transfer.setRequestTimeoutMs(4_000);

  await transfer.request(RX);
  const done = await waitFor(() => {
    const f = registry.get(RX);
    return f?.state === registry.STATE.DONE || f?.state === registry.STATE.ERROR;
  }, 6_000);

  /**
   * The receiver reaching DONE is the fin marker landing. That is not the
   * sender finishing: it drains its queue, toasts and tears down over the turns
   * after, so unsubscribing here made every assertion about the sender a race
   * that lost roughly two runs in three.
   *
   * This cannot weaken the regression it guards. `sentSaw` snapshots `landed`
   * at the instant the toast fires, so waiting longer to *hear* the claim does
   * not change what had actually left the queue when it was made — a sender
   * that toasts over a discarded queue still records 0 of 4. A sender that
   * never toasts at all still fails, four seconds later.
   */
  await waitFor(() => sentSaw !== null && !transfer.isActive(TX) && !transfer.isActive(RX), 4_000);

  offToast();
  FakeChannel.tap = null;
  const got = registry.get(RX);
  return { done, got, toasts, sentSaw, expected, src, TX, RX };
}

async function check(announceOpenEvent) {
  const label = announceOpenEvent ? "open event follows ondatachannel" : "channel arrives already open";
  console.log(`\n  [${label}]`);

  const { done, got, toasts, sentSaw, expected, src, TX, RX } = await runTransfer(announceOpenEvent);

  ok("the transfer finished", done, got ? `state=${got.state} ${got.error ?? ""}` : "no entry");
  ok("the receiver ended up with a blob", Boolean(got?.blob),
     got?.blob ? "" : "THE REGRESSION: pc.close() discarded the send queue");

  if (got?.blob) {
    const out = new Uint8Array(await got.blob.arrayBuffer());
    let same = out.length === src.length;
    for (let i = 0; same && i < src.length; i++) same = out[i] === src[i];
    ok("every byte arrived intact", same, `${out.length} of ${src.length} bytes`);
  } else {
    ok("every byte arrived intact", false, "no blob to compare");
  }

  ok("it is marked done", got?.state === registry.STATE.DONE, String(got?.state));
  ok("progress reached 100", got?.progress === 100, String(got?.progress));
  ok("the path is labelled p2p", got?.path === "p2p",
     "a direct transfer reported as relay is a privacy claim the user did not get");

  const sentAt = toasts.findIndex(m => m.startsWith("Sent "));
  ok("the sender says it went directly",
     sentAt >= 0 && toasts[sentAt] === "Sent paste.png over a direct connection",
     toasts[sentAt] ?? "no Sent toast");
  ok("the receiver confirms a direct transfer",
     toasts.some(m => m === "paste.png received over a direct connection"),
     toasts.join(" | "));
  ok("'Sent' waits until the whole file has left the queue",
     expected > 0 && sentSaw === expected,
     `${sentSaw} of ${expected} chunks had gone — it used to fire on a queue pc.close() then discarded`);

  ok("both ends were torn down", !transfer.isActive(TX) && !transfer.isActive(RX),
     "flushing must not trade away the leak-free teardown");
}

console.log("\nDirect file transfer");

await check(false);
await check(true);

console.log(`\n${fail ? "FAIL" : "PASS"}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
