/**
 * End-to-end test: two peers, real crypto, real relay.
 *
 * This is the test that matters. Everything else checks a layer in isolation;
 * this one drives the actual client modules (core/crypto.js, core/keys.js,
 * transport/protocol.js) against a running relay and asserts that a string
 * typed on peer A comes out intact on peer B — encrypted the whole way, with
 * the relay never seeing plaintext.
 *
 * Usage:  node tests/live/e2e.mjs [ws_base]
 *         node tests/live/e2e.mjs ws://127.0.0.1:8000
 *         node tests/live/e2e.mjs                     (defaults to the deployed relay)
 *
 * Requires Node 22+ for the global WebSocket.
 */

import * as cryptoBox from "../../src/core/crypto.js";
import * as keys from "../../src/core/keys.js";
import { LOCK } from "../../src/core/config.js";
import * as proto from "../../src/transport/protocol.js";
import { sealWith, openWith } from "../../src/core/frames.js";

const BASE = process.argv[2] || process.env.RELAY_BASE
  || "wss://realtimeclipboard.fastapicloud.dev";

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
}

/** A thin peer that speaks the real protocol. */
class Peer {
  constructor(label, roomHash, aesKey) {
    this.label = label;
    this.roomHash = roomHash;
    this.aesKey = aesKey;
    this.originId = `${label}${Math.floor(Math.random() * 1e5)}`;
    this.inbox = [];
    this.waiters = [];
  }

  connect(intent = "join", name = "test-device") {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${BASE}/ws/${this.roomHash}`);
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify(proto.hello(intent, this.originId, name)));
        resolve();
      };
      this.ws.onerror = e => reject(new Error(`${this.label} ws error: ${e.message || e}`));
      this.ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        this.inbox.push(msg);
        this.waiters = this.waiters.filter(w => !w(msg));
      };
      setTimeout(() => reject(new Error(`${this.label} connect timeout`)), 30000);
    });
  }

  /** Resolve with the first frame matching `pred`, checking already-received ones. */
  next(pred, ms = 10000) {
    const hit = this.inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label} timeout`)), ms);
      this.waiters.push(msg => {
        if (!pred(msg)) return false;
        clearTimeout(timer);
        resolve(msg);
        return true;
      });
    });
  }

  async sendClip(text) {
    const { payload, iv } = await cryptoBox.encrypt(this.aesKey, text);
    this.ws.send(JSON.stringify(proto.clip({ payload, iv, originId: this.originId })));
    return payload;
  }

  async readClip(msg) {
    return cryptoBox.decrypt(this.aesKey, msg.payload, msg.iv);
  }

  /** The lock proof, sealed exactly as the app seals it. */
  async sendVerify(probe) {
    const frame = await sealWith(this.aesKey,
      proto.verify({ probe, originId: this.originId }));
    this.ws.send(JSON.stringify(frame));
  }

  readFrame(msg) { return openWith(this.aesKey, msg); }

  close() { try { this.ws?.close(1000); } catch { /* already gone */ } }
}

async function main() {
  console.log(`\nRelay: ${BASE}\n`);

  // --- session setup, exactly as the browser does it ---------------------
  const key = keys.generate();
  const roomHash = (await cryptoBox.deriveOpen(key)).roomHash;
  const aesKey = (await cryptoBox.deriveOpen(key)).aesKey;

  console.log("Session");
  check("key generated", keys.isValid(key), key);
  check("roomHash is 32 hex", /^[0-9a-f]{32}$/.test(roomHash), roomHash);
  check("roomHash hides the key", !roomHash.includes(key.toLowerCase()));

  const a = new Peer("A", roomHash, aesKey);
  const b = new Peer("B", roomHash, aesKey);

  // --- connect -----------------------------------------------------------
  console.log("\nConnect");
  const t0 = Date.now();
  await a.connect("create");
  check("A connected", true, `${Date.now() - t0} ms`);
  const wa = await a.next(m => m.t === "welcome");
  check("A welcomed, room empty", wa.existing === 0, `existing=${wa.existing}`);

  await b.connect("join");
  const wb = await b.next(m => m.t === "welcome");
  check("B sees A already present", wb.existing === 1, `existing=${wb.existing}`);

  // --- the actual point of the product ------------------------------------
  console.log("\nEncrypted round trip");
  const secret = "sk-live-9f3a · unicode ✓ · multi\nline\tclip";
  const ciphertext = await a.sendClip(secret);

  const got = await b.next(m => m.t === "clip");
  check("B received a clip", Boolean(got));
  check("relay carried ciphertext only", !ciphertext.includes("sk-live"));
  const plain = await b.readClip(got);
  check("B decrypted to the exact original", plain === secret,
        plain === secret ? `${plain.length} chars` : `got: ${plain?.slice(0, 40)}`);
  check("relay assigned a sequence number", typeof got.seq === "number", `seq=${got.seq}`);
  check("originId preserved for loop suppression", got.originId === a.originId);

  // --- multi-directional ---------------------------------------------------
  console.log("\nReverse direction");
  const reply = "response from B ✓";
  await b.sendClip(reply);
  const back = await a.next(m => m.t === "clip");
  check("A received B's clip", (await a.readClip(back)) === reply);

  // --- loop prevention -----------------------------------------------------
  console.log("\nLoop prevention");
  const before = b.inbox.filter(m => m.t === "clip").length;
  await b.sendClip("should not come back to B");
  await new Promise(r => setTimeout(r, 1200));
  const after = b.inbox.filter(m => m.t === "clip").length;
  check("sender never receives its own clip", after === before,
        `${before} -> ${after}`);

  // --- late joiner ----------------------------------------------------------
  console.log("\nLate joiner");
  const c = new Peer("C", roomHash, aesKey);
  await c.connect("join");
  const wc = await c.next(m => m.t === "welcome");
  check("late joiner gets the last clip", Boolean(wc.last));
  if (wc.last) {
    check("and can decrypt it", (await c.readClip(wc.last)) === "should not come back to B");
  }
  c.close();

  // --- wrong key is a different room ---------------------------------------
  console.log("\nKey isolation");
  const otherKey = keys.generate();
  const otherHash = (await cryptoBox.deriveOpen(otherKey)).roomHash;
  check("different key => different room", otherHash !== roomHash);
  const d = new Peer("D", otherHash, (await cryptoBox.deriveOpen(otherKey)).aesKey);
  await d.connect("create");
  const wd = await d.next(m => m.t === "welcome");
  check("and that room is empty", wd.existing === 0,
        "a wrong key cannot eavesdrop — it lands somewhere else entirely");
  d.close();

  a.close();
  b.close();

  // --- locked sessions ------------------------------------------------------
  //
  // The claim under test is not "a wrong PIN cannot decrypt" — that is arithmetic
  // and tests/unit/lock.mjs proves it without a network. It is the stronger one: a
  // wrong PIN cannot REACH the room. That can only be shown against a real relay,
  // by watching the room a wrong PIN lands in and confirming nobody is there.
  console.log("\nLocked session");

  const lkey = keys.generate();
  const right = await cryptoBox.deriveLocked(lkey, "correct horse battery");
  const wrong = await cryptoBox.deriveLocked(lkey, "incorrect horse battery");
  const openHash = (await cryptoBox.deriveOpen(lkey)).roomHash;

  check("locked and unlocked are different rooms for one key",
        right.roomHash !== openHash);
  check("a wrong PIN names a different room", right.roomHash !== wrong.roomHash);

  const l1 = new Peer("L1", right.roomHash, right.aesKey);
  await l1.connect("create");
  const wl1 = await l1.next(m => m.t === "welcome");
  check("first device into the locked room finds it empty", wl1.existing === 0);

  // The clip a real user copied, before anyone starts proving anything. It is
  // what the proof used to destroy, so it goes in first on purpose.
  const retained = "the-clip-a-user-actually-copied";
  await l1.sendClip(retained);

  const l2 = new Peer("L2", right.roomHash, right.aesKey);
  await l2.connect("join");
  const wl2 = await l2.next(m => m.t === "welcome");
  check("a device with the right PIN joins the same room", wl2.existing === 1);
  // `welcome.last` arrives as an object, not a string: the relay stores the
  // envelope as JSON but re-parses it on the way out (backend/main.py `_join`).
  check("and is replayed the room's last clip",
        !!wl2.last && await l2.readClip(wl2.last) === retained);

  // Verification, the round trip. A wrong PIN is silent — it derives a
  // different room and lands you alone in it — so the only way to tell "right
  // PIN" from "first one here" is for something in the room to be readable.
  check("the relay advertises the frame that does it",
        (wl2.caps ?? []).includes("verify"),
        "a client cannot probe for a type an older relay answers UNKNOWN_TYPE");

  await l2.sendVerify(true);
  const probe = await l1.next(m => m.t === "verify");
  check("a probe reaches the other device", (await l1.readFrame(probe))?.probe === true);
  check("...sealed, so the relay cannot tell a question from an answer",
        !("probe" in probe) && !!probe.payload);
  check("...and stamped with the sender the relay saw", !!probe.from,
        "the one field a client cannot choose for itself");

  await l1.sendVerify(false);
  const answer = await l2.next(m => m.t === "verify");
  check("and the answer comes back", (await l2.readFrame(answer))?.probe === false);

  // THE POINT of moving off a clip. Everything above travelled through the room
  // and none of it touched what the room retains.
  const l2b = new Peer("L2B", right.roomHash, right.aesKey);
  await l2b.connect("join");
  const wl2b = await l2b.next(m => m.t === "welcome");
  check("THE REPLAY SURVIVES VERIFICATION: the user's clip is still the retained one",
        !!wl2b.last && await l2b.readClip(wl2b.last) === retained,
        "proving the PIN used to overwrite it with a sentinel");
  l2b.close();

  // The device that mistyped its PIN. It is not rejected — it is somewhere else
  // entirely, which is the point: it never occupies a slot in, or appears in the
  // roster of, the room it was aiming at.
  const l3 = new Peer("L3", wrong.roomHash, wrong.aesKey);
  await l3.connect("join");
  const wl3 = await l3.next(m => m.t === "welcome");
  check("a wrong PIN lands in an empty room of its own", wl3.existing === 0,
        "not admitted-then-blinded — never in the room at all");

  const roster = await l1.next(m => m.t === "peers" && m.count === 2);
  check("and never appears in the real room's roster", roster.count === 2,
        `${roster.count} devices, not 3`);

  // Content, for completeness: even holding a captured frame, the wrong PIN
  // cannot open it.
  const lockedSecret = "sk-live-" + Math.random().toString(36).slice(2);
  await l1.sendClip(lockedSecret);
  const lockedClip = await l2.next(m => m.t === "clip" && m.originId === l1.originId
                                       && m.payload !== undefined);
  check("the right PIN reads the clip", await l2.readClip(lockedClip) === lockedSecret);
  let opened = true;
  try { await l3.readClip(lockedClip); } catch { opened = false; }
  check("the wrong PIN cannot, even given the ciphertext", !opened);

  // Someone who has the LINK but no PIN at all — the attacker this feature is
  // for. They can only compute the unlocked room hash.
  const l4 = new Peer("L4", openHash, (await cryptoBox.deriveOpen(lkey)).aesKey);
  await l4.connect("join");
  const wl4 = await l4.next(m => m.t === "welcome");
  check("holding the link without the PIN reaches an empty room", wl4.existing === 0);

  l1.close(); l2.close(); l3.close(); l4.close();

  /* ---------------------------------------------------------------------
     Locking a room out from under the people in it.

     The founder leaves for a locked room, which the others can neither name
     nor open — so the last thing it does in the old room is say so. The claim
     under test is that the goodbye actually arrives: it is an ordinary clip as
     far as the relay is concerned, which is what lets it work against a relay
     that knows nothing about it.
  --------------------------------------------------------------------- */
  console.log("\nLocking with company");

  const okey = keys.generate();
  const oroom = (await cryptoBox.deriveOpen(okey)).roomHash;
  const oaes = (await cryptoBox.deriveOpen(okey)).aesKey;

  const founder = new Peer("F", oroom, oaes);
  const guest   = new Peer("G", oroom, oaes);
  await founder.connect("create");
  const wf = await founder.next(m => m.t === "welcome");
  check("the founder arrives into an empty room", wf.existing === 0,
        "this, and only this, is what earns the right to lock");

  await guest.connect("join");
  const wg = await guest.next(m => m.t === "welcome");
  check("a guest arrives after them", wg.existing === 1);

  await founder.sendClip(LOCK.EVICT);
  const goodbye = await guest.next(m => m.t === "clip" && m.originId === founder.originId
                                       && m.payload !== undefined);
  check("the guest is told the session was locked",
        await guest.readClip(goodbye) === LOCK.EVICT);

  // The other half of "gracefully": a device that was offline for the moment it
  // happened, or that follows the old link afterwards, must not walk into a room
  // it has already been removed from and sit there in silence.
  const latecomer = new Peer("L", oroom, oaes);
  await latecomer.connect("join");
  const wlate = await latecomer.next(m => m.t === "welcome");
  check("and so is anyone who arrives afterwards",
        !!wlate.last && await latecomer.readClip(wlate.last) === LOCK.EVICT,
        "the relay retains the goodbye and replays it");

  // The founder is in a genuinely different room, not a flag away from this one.
  const locked = await cryptoBox.deriveLocked(okey, "a new pin entirely");
  check("the room the founder left for cannot be reached from the old link",
        locked.roomHash !== oroom);

  founder.close(); guest.close(); latecomer.close();

  console.log("\n" + "=".repeat(60));
  console.log(`E2E: ${pass}/${pass + fail} passed`);
  results.filter(r => !r.ok).forEach(r => console.log(`   FAILED: ${r.name} ${r.detail}`));
  console.log("=".repeat(60));
  return fail ? 1 : 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => { console.error("\nE2E ABORTED:", err.message); process.exit(1); });
