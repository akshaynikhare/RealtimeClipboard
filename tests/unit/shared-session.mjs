/**
 * cli/session.mjs — the half `cli/`, `mcp/`, `vscode/` and `browser/` share.
 *
 * What is asserted here is only the part of it that acts on its OWN initiative.
 * Everything else in that module runs because a caller asked: it sends when
 * told, closes when told, and hands text to a callback. The verification
 * responder is the exception — it answers a frame off the wire, with no caller
 * in the loop — and that makes it the one place where two rules the surfaces
 * rely on can be broken without anybody noticing:
 *
 *   1. VS Code has an Off rung and the other three do not. A responder that
 *      ignores it transmits from a device whose UI says nothing leaves, and
 *      does it in the background, where there is no operation to report.
 *
 *   2. Producing an answer takes two awaits, and both are long enough for the
 *      surface to have left the room, been evicted from it, or rejoined on
 *      another key. Sealed with the old key and sent into the new room, that
 *      answer is undecryptable noise attributed to this device.
 *
 * Driven through the real module against a fake WebSocket, so the frame really
 * does arrive from the transport and the answer really is what would go out on
 * it. Usage: node tests/unit/shared-session.mjs
 */

import { readFile } from "node:fs/promises";
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

const disk = new Map();
globalThis.localStorage = {
  getItem: k => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: k => disk.delete(k),
};

/* ---------------------------------------------------------- a fake socket */

let sockets = [];

class FakeSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    sockets.push(this);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }

  /** The relay's unprompted welcome — what ws.js waits for before reporting open. */
  welcome() { this.onmessage?.({ data: JSON.stringify({ t: "welcome", peers: 1, caps: ["verify"] }) }); }
  deliver(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }

  get verifies() { return this.sent.filter(f => f.t === "verify"); }
}
globalThis.WebSocket = FakeSocket;

const room = await load("cli/session.mjs");
const frames = await load("src/core/frames.js");
const proto = await load("src/transport/protocol.js");

const aesKey = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
);
const otherKey = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
);

const session = (key = aesKey, locked = true) =>
  ({ key: "D75LVX9QRS", roomHash: "rh", aesKey: key, auth: null, locked });

/** Connect, and hand back the socket the transport actually built. */
async function connect(opts = {}) {
  sockets = [];
  const opened = room.open({
    session: session(), originId: "cli-1", url: "ws://127.0.0.1:1", ...opts,
  });
  // ws.js promotes on the welcome, not on the upgrade.
  await Promise.resolve();
  sockets[0].welcome();
  await opened;
  return sockets[0];
}

const probeFrom = (key = aesKey) =>
  frames.sealWith(key, proto.verify({ probe: true, originId: "peer-9" }));

/**
 * One frame in, then wait out the responder's two awaits.
 *
 * Generously, and by the clock rather than by counting microtask turns:
 * crypto.subtle does its work off-thread, so a fixed number of `await
 * Promise.resolve()` is a race. Losing it makes a broken responder look silent,
 * which is the exact shape of every assertion here — the suite would report a
 * green "nothing was sent" for code that sends.
 */
async function settle(sock, frame) {
  sock.deliver(frame);
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 2));
}

/* -------------------------------------------------------- the happy path */
console.log("\nAnswering, when there is nothing stopping it\n");

let sock = await connect();
await settle(sock, await probeFrom());
ok("a probe is answered", sock.verifies.length === 1);
ok("...and the answer is not itself a probe",
   (await frames.openWith(aesKey, sock.verifies[0]))?.probe === false,
   "THE LOOP GUARD — an answer is never answered");
ok("...and is attributed to this surface", sock.verifies[0].originId === "cli-1");
room.close();

sock = await connect();
await settle(sock, await frames.sealWith(aesKey, proto.verify({ probe: false, originId: "peer-9" })));
ok("an answer draws no answer", sock.verifies.length === 0);
room.close();

sock = await connect({ session: session(aesKey, false) });
await settle(sock, await probeFrom());
ok("an unlocked session has nothing to prove", sock.verifies.length === 0);
room.close();

sock = await connect();
await settle(sock, await probeFrom(otherKey));
ok("a probe this key cannot open is not answered", sock.verifies.length === 0,
   "somebody in the room on another PIN");
room.close();

/* ------------------------------------------------------------- the rung */
console.log("\nOff means nothing leaves — VS Code has this rung\n");

sock = await connect({ sharing: () => false });
await settle(sock, await probeFrom());
ok("THE REGRESSION: an Off surface answers nothing",
   sock.verifies.length === 0,
   "it transmitted from a device whose UI said nothing leaves");

/* The responder is not the app: opening the frame teaches it nothing, so an Off
   surface should not even start.

   Counting the gates would not show it — a responder that decrypts first and
   thinks better of it afterwards consults the rung exactly as often. What
   distinguishes them is whether the decryption was ATTEMPTED, and openWith()
   says so out loud when it fails. So the probe is one this key cannot open: no
   warning means nothing tried to open it. */
room.close();
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));
sock = await connect({ sharing: () => false });
await settle(sock, await probeFrom(otherKey));
console.warn = realWarn;
ok("...and gives up before decrypting, not after", warnings.length === 0,
   warnings.join(" | ") || "nothing was handed to the cipher");
room.close();

/* The two windows. `sharing` is re-read at every step, so a predicate that
   changes its mind mid-flight is exactly a rung coming down mid-flight. */
const offAfter = n => { let seen = 0; return () => ++seen <= n; };

sock = await connect({ sharing: offAfter(1) });
await settle(sock, await probeFrom());
ok("going Off during the decryption stops it", sock.verifies.length === 0);
room.close();

sock = await connect({ sharing: offAfter(2) });
await settle(sock, await probeFrom());
ok("going Off during the encryption stops it too", sock.verifies.length === 0,
   "the last check is immediately before the send, not before the seal");
room.close();

/* ------------------------------------------------------ leaving mid-flight */
console.log("\nA response outliving its room\n");

/* Every guard below is checked by COUNTING the gates, not only by looking at
   the wire, and that is deliberate. Once the room is closed `relay.send()`
   refuses a null channel anyway, so "no frame went out" is true of a correct
   responder and of one with no generation at all. What separates them is how
   far the response got before it gave up. Gate 1 runs before the decryption,
   gate 2 after it, gate 3 after the seal — so a count of 2 means gate 2 stopped
   it and a count of 3 means gate 2 let it through. */
async function inflight(onGate) {
  sockets = [];
  const gates = [];
  const opened = room.open({
    session: session(), originId: "cli-1", url: "ws://127.0.0.1:1",
    sharing: () => { gates.push(1); onGate(gates.length); return true; },
  });
  await Promise.resolve();
  const first = sockets[0];
  first.welcome();
  await opened;
  await settle(first, await probeFrom());
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return { gates: gates.length, first, later: sockets[sockets.length - 1] };
}

const rejoin = () => room
  .open({ session: session(otherKey), originId: "cli-1", url: "ws://127.0.0.1:1" })
  .catch(() => { /* never welcomed; the connect bound is not what is under test */ });

let r = await inflight(n => { if (n === 2) room.close(); });
ok("closing during the response abandons it", r.first.verifies.length === 0);
ok("...at the gate after the decryption, not eventually",
   r.gates === 2, `${r.gates} gates — 3 means close() left the generation standing`);
room.close();

/* THE ONE THAT MATTERS, and the reason close() is not enough on its own:
   open() replaces the transport's channel whether or not close() was called
   first, so a stale answer is handed to the NEW room's socket. */
r = await inflight(n => { if (n === 2) rejoin(); });
ok("rejoining on another key abandons it too", r.gates === 2,
   "open() invalidates on its own — it does not rely on close() being called");
ok("...and nothing from the old room reaches the new one",
   r.later !== r.first && r.later.verifies.length === 0,
   "sealed with a key nobody in that room holds");
room.close();

/* The window gate 2 cannot see: the room changes DURING the seal. Queued as a
   microtask from gate 2, so it lands after that check and before gate 3 — which
   is the whole reason there is a third check rather than two. */
r = await inflight(n => { if (n === 2) queueMicrotask(rejoin); });
ok("a room that changes during the encryption is caught at the last gate",
   r.gates === 3, `${r.gates} gates — this one has to reach gate 3 to prove anything`);
ok("...and the answer still goes nowhere",
   r.first.verifies.length === 0
   && (r.later === r.first || r.later.verifies.length === 0),
   "the check immediately before the send is the only one left that can catch it");
room.close();

/* ------------------------------------------------- the surface that has a rung */
console.log("\nVS Code passes its rung down\n");

/* `sharing` defaults to "yes", which is right for the three surfaces with no Off
   rung and silently wrong for the one that has it. A default nobody overrides
   looks identical to a default that is correct. */
const VSCODE_ROOM = await readFile(join(REPO, "vscode/src/room.mjs"), "utf8");
ok("vscode/src/room.mjs hands the responder its Off rung",
   /sharing:\s*\(\)\s*=>\s*sharesSession\(state\.get\(\)\.settings\.syncMode\)/
     .test(VSCODE_ROOM),
   "without it the extension answers probes from a device set to Off");

/* --------------------------------------------------------------------- out */
console.log(`\nSHARED SESSION: ${pass}/${pass + fail}\n`);
process.exit(fail ? 1 : 0);
