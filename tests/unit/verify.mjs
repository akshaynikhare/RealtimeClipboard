/**
 * Lock verification — core/verify.js.
 *
 * Every rule here was a bug at some point, and each one fails silently in a
 * different direction, which is why this suite exists at all:
 *
 *   1. The proof used to be a CLIP, and the relay retains one clip per room and
 *      replays it to the next joiner (FR-3.3). So proving the PIN either
 *      overwrote the last thing the user copied, or — once the plant learned to
 *      honour the sync rung — never happened, leaving devices that had joined
 *      correctly being warned their PIN might be wrong. Those two failures are
 *      the SAME bug: the proof and the user's data were competing for one slot.
 *      What is asserted below is that the frame is not a clip and carries
 *      nothing but the flag.
 *
 *   2. Off has to mean Off in both directions. A device that answers a probe
 *      while set to Off is transmitting for somebody else's benefit, which is
 *      the one thing that rung promises it will not do.
 *
 *   3. Coming off Off has to push, not wait. The peer that probed while this
 *      device was silent has no reason to ask again — its trigger was an
 *      arrival, and nobody else is going to arrive.
 *
 *   4. An answer must never be answerable, or two unverified devices trade
 *      proof until the relay's rate limiter stops them.
 *
 *   5. A seal is an await, so the room can change inside it. A frame sealed for
 *      the room being left is undecryptable noise in the room being joined.
 *
 * Behavioural, not source-reading: everything is driven through the real module
 * with fakes for the four injected seams. Mutate core/verify.js and this goes
 * red.
 *
 * Usage: node tests/unit/verify.mjs
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

const disk = new Map();
globalThis.localStorage = {
  getItem: k => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: k => disk.delete(k),
};

const { LOCK, SYNC_MODES } = await load("src/core/config.js");
const state = await load("src/core/state.js");
const proto = await load("src/transport/protocol.js");
const frames = await load("src/core/frames.js");
const { createVerifier } = await load("src/core/verify.js");

/* A real AES-GCM key, so the wire-shape assertions are about real ciphertext
   rather than a stub that agrees with them. Generated rather than derived —
   deriveLocked() is 600k PBKDF2 rounds and proves nothing this file is about. */
const aesKey = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
);

/* ---------------------------------------------------------------- harness */

let sent = [];
let gen = 1;

/** A room that can answer a probe: locked, sharing, in company, relay current. */
function room({
  locked = true, mode = SYNC_MODES.LIVE, peers = 2, caps = ["verify"],
  key = aesKey, verified = false,
} = {}) {
  sent = [];
  gen = 1;
  state.setKey({ key: "D75LVX9QRS", roomHash: "rh", aesKey: key, locked });
  state.setRelayCaps(caps);
  state.setPeers(peers, []);
  state.get().settings.syncMode = mode;
  if (verified) state.setVerified();
}

/** The real seal, so `probe` has to actually survive a round trip. */
const realSeal = f => frames.sealWith(aesKey, f);

function verifier({ seal = realSeal, now = () => 1_000_000 } = {}) {
  return createVerifier({
    build: proto.verify,
    seal,
    send: f => { sent.push(f); return true; },
    gen: () => gen,
    now,
  });
}

/* ------------------------------------------------------- what goes on the wire */
console.log("\nThe frame\n");

room();
let v = verifier();
await v.request();

ok("a probe is sent when a locked session is unverified and in company",
   sent.length === 1);

ok("THE POINT: it is not a clip, so it cannot take the room's retained slot",
   sent[0]?.t === proto.T.VERIFY && sent[0].t !== proto.T.CLIP,
   `t=${sent[0]?.t} — FR-3.3 retains clips only`);

ok("it is sealed", !!sent[0]?.payload && !!sent[0]?.iv);

ok("`probe` is inside the envelope, not beside it",
   sent[0] && !("probe" in sent[0]),
   "the relay cannot tell a question from an answer");

const opened = await frames.openWith(aesKey, sent[0]);
ok("and round-trips as a probe", opened?.probe === true);

ok("it carries nothing but the flag and its routing",
   Object.keys(opened).sort().join(",") === "originId,probe,t",
   Object.keys(opened).sort().join(","));

/* --------------------------------------------------------------- when to ask */
console.log("\nAsking\n");

room({ verified: true });
v = verifier();
await v.request();
ok("no probe once the session is already verified", sent.length === 0);

room({ peers: 1 });
v = verifier();
await v.request();
ok("no probe while alone — nobody is there to answer", sent.length === 0);

room({ locked: false });
v = verifier();
await v.request();
ok("no probe in an unlocked session — there is nothing to prove", sent.length === 0);

room();
let clock = 0;
v = verifier({ now: () => clock });
await v.request();
clock += LOCK.VERIFY_MIN_INTERVAL_MS - 1;
await v.request();
ok("a second probe inside the interval is dropped", sent.length === 1);
clock += 2;
await v.request();
ok("and allowed once the interval passes", sent.length === 2);

/* ------------------------------------------------------------------- Off */
console.log("\nOff means Off\n");

room({ mode: SYNC_MODES.OFF });
v = verifier();
await v.request();
ok("an Off device sends no probe", sent.length === 0);

room({ mode: SYNC_MODES.OFF });
v = verifier();
await v.answer({ t: proto.T.VERIFY, probe: true, originId: "someone-else" });
ok("an Off device does not answer one either", sent.length === 0,
   "answering is a frame put on the wire for somebody else");

room({ mode: SYNC_MODES.OFF });
v = verifier();
await v.announce();
ok("and announces nothing", sent.length === 0);

/* The regression that made this a two-way trigger: a refused attempt used to
   consume the throttle window, so the retry that Off -> sharing fires — the one
   moment the device most needs to be heard — was swallowed by the attempt it
   had just been forbidden to make. */
room({ mode: SYNC_MODES.OFF });
clock = 0;
v = verifier({ now: () => clock });
await v.request();
clock += 1;
state.get().settings.syncMode = SYNC_MODES.LIVE;
await v.request();
ok("THE RETRY: enabling sharing is not throttled by the attempt Off refused",
   sent.length === 1);

room({ mode: SYNC_MODES.OFF });
v = verifier();
state.get().settings.syncMode = SYNC_MODES.MANUAL;
await v.announce();
ok("Manual counts as sharing, so it answers unprompted on the way up",
   sent.length === 1 && (await frames.openWith(aesKey, sent[0])).probe === false);

/* --------------------------------------------------------------- answering */
console.log("\nAnswering\n");

room();
v = verifier();
await v.answer({ t: proto.T.VERIFY, probe: true, originId: "someone-else" });
ok("a probe is answered", sent.length === 1);
ok("and the answer is not itself a probe",
   (await frames.openWith(aesKey, sent[0])).probe === false,
   "THE LOOP GUARD");

room();
v = verifier();
await v.answer({ t: proto.T.VERIFY, probe: false, originId: "someone-else" });
ok("an answer is never answered", sent.length === 0);

room();
v = verifier();
await v.answer({ t: proto.T.VERIFY, probe: true, originId: state.get().originId });
ok("our own probe coming back is ignored", sent.length === 0);

room({ verified: true });
v = verifier();
await v.answer({ t: proto.T.VERIFY, probe: true, originId: "someone-else" });
ok("a verified device still answers — the proof is for the asker", sent.length === 1);

room({ peers: 1 });
v = verifier();
await v.announce();
ok("nothing is announced into an empty room", sent.length === 0);

/* ------------------------------------------------- mixed versions, explicitly */
console.log("\nAn older relay\n");

room({ caps: [] });
v = verifier();
await v.request();
await v.answer({ t: proto.T.VERIFY, probe: true, originId: "someone-else" });
await v.announce();
ok("a relay that does not advertise `verify` is never sent one",
   sent.length === 0, "it would come back UNKNOWN_TYPE and read as silence");

ok("and there is NO fallback to the retained-clip beacon",
   sent.every(f => f.t !== proto.T.CLIP),
   "spending the replay slot is the behaviour being removed, not a degraded mode");

room({ caps: ["verify", "something-else"] });
v = verifier();
await v.request();
ok("an unknown capability alongside it changes nothing", sent.length === 1);

/* ------------------------------------------------ the room changing mid-seal */
console.log("\nLeaving, mid-flight\n");

/* The seal is the only await, so it is the only window. Each of these releases
   it after the session has moved underneath. */
function slowSeal(during) {
  return async (frame) => {
    await during();
    return realSeal(frame);
  };
}

room();
v = verifier({ seal: slowSeal(async () => { gen++; }) });
await v.request();
ok("a frame sealed for the room we left is dropped", sent.length === 0);

room();
let pending = null;
v = verifier({ seal: slowSeal(async () => { pending.cancel(); }) });
pending = v;
await v.request();
ok("cancel() during the seal drops it", sent.length === 0);

room();
v = verifier({ seal: slowSeal(async () => {
  state.get().settings.syncMode = SYNC_MODES.OFF;
}) });
await v.request();
ok("going Off during the seal drops it", sent.length === 0,
   "the rung is re-read immediately before the send, not only before the seal");

room();
v = verifier({ seal: slowSeal(async () => { state.clearKey(); }) });
await v.answer({ t: proto.T.VERIFY, probe: true, originId: "someone-else" });
ok("an answer sealed as the session ended is dropped too", sent.length === 0);

room();
clock = 0;
v = verifier({ now: () => clock });
await v.request();
v.cancel();
await v.request();
ok("cancel() clears the throttle, so the next room can ask at once",
   sent.length === 2);

/* --------------------------------------------------------------------- out */
console.log(`\nVERIFY: ${pass}/${pass + fail}\n`);
process.exit(fail ? 1 : 0);
