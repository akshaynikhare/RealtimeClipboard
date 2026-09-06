/**
 * Files layer: does adding a file actually tell anyone?
 *
 * This exists because it did not. transfer.js handled inbound `file-meta`
 * announcements from peers but never sent one, so a file added on this machine
 * was visible only on this machine — dropped files and clipboard images alike.
 *
 * Every other test passed while that was broken: the relay forwards file-meta
 * correctly (relay gate G12), the chunker round-trips, the UI renders. Nothing
 * checked the one line that connects them.
 *
 * Usage: node tests/unit/files.mjs
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
const { FILES } = await load("src/core/config.js");

/* Capture what the module tries to put on the wire. */
const sent = [];
transfer.setSignalSender(frame => { sent.push(frame); return true; });

console.log("\nFiles layer\n");

/* ---------- adding a local file announces it ---------- */
const file = new File([new Uint8Array(1024)], "screenshot.png", { type: "image/png" });
const { added, rejected } = await registry.add([file], { makeThumbs: false });

ok("file accepted", added === 1, rejected.map(r => r.reason).join(", "));

const meta = sent.find(f => f.t === "file-meta");
ok("adding a file sends file-meta", Boolean(meta),
   meta ? "" : "THE REGRESSION: nothing was announced to peers");

if (meta) {
  ok("announcement carries the name", meta.name === "screenshot.png", meta.name);
  ok("announcement carries the size", meta.size === 1024, String(meta.size));
  ok("announcement carries the type", meta.type === "image/png", meta.type);
  ok("announcement carries an id", Boolean(meta.id), meta.id);
  ok("announcement carries no bytes",
     !("blob" in meta) && JSON.stringify(meta).length < 2000,
     "only metadata may travel automatically");
  ok("announcement is a broadcast, not targeted", meta.to === undefined,
     "every device in the room should learn the file exists");
}

/* ---------- a late joiner gets told about what is already here ---------- */
sent.length = 0;
const reannounced = transfer.announceAll();
ok("announceAll re-announces held files", reannounced === 1, `${reannounced} sent`);
ok("re-announcement is also file-meta",
   sent.length === 1 && sent[0].t === "file-meta");

/* ---------- the thumbnail setting is honoured ---------- */
sent.length = 0;
state.setSetting("thumbs", false);
const entry = registry.all()[0];
entry.thumb = "data:image/jpeg;base64,AAAA";     // pretend one was generated
transfer.announce(entry);
ok("thumbs=off suppresses the preview", sent[0]?.thumb === null,
   "a 160px preview of a screenshot can be legible, and it travels unrequested (OI-15)");

state.setSetting("thumbs", true);
sent.length = 0;
transfer.announce(entry);
ok("thumbs=on includes the preview", typeof sent[0]?.thumb === "string");

/* ---------- remote files are never announced by us ---------- */
sent.length = 0;
registry.addRemote({ id: "remote1", name: "theirs.pdf", size: 10,
                     type: "application/pdf", thumb: null, originId: "peerX" });
const theirs = registry.get("remote1");
transfer.announce(theirs);
ok("we do not re-announce someone else's file", sent.length === 0,
   "otherwise two peers would echo each other's announcements forever");

/* ---------- the size cap still holds ---------- */
sent.length = 0;
const huge = new File([new Uint8Array(FILES.MAX_BYTES + 1)], "big.bin");
const res = await registry.add([huge], { makeThumbs: false });
ok("oversize file rejected", res.added === 0 && res.rejected.length === 1,
   res.rejected[0]?.reason ?? "");
ok("and nothing was announced for it", sent.length === 0);

/* ==================================================================== *
 * Removal
 *
 * The other half of the same hole: adding a file worked and removing one was
 * unreachable. registry.remove() and registry.clear() existed, were correct as
 * far as they went, and were called from nothing — so the list only ever grew,
 * up to twenty 5 MB Blobs pinned in a tab with no way to get any of it back.
 *
 * Both collaborators are injected here rather than mocked at module level,
 * because that is exactly how the app wires them: filesPanel hands the registry
 * transfer.cancel, and main.js hands it the same encrypt-and-send closure it
 * gives transfer.js.
 * ==================================================================== */

registry.setSignalSender(frame => { sent.push(frame); return true; });

/** Records what was cancelled, and whether the file was still listed at the
 *  time — transfer.cancel() reads the name back out of the registry to tell the
 *  user what stopped, so order is part of the contract, not an implementation
 *  detail. */
const cancelled = [];
registry.setCanceller((id, reason) => {
  cancelled.push({ id, reason, stillListed: Boolean(registry.get(id)) });
  return true;
});

/* ---------- removing a local file drops it, frees it, and tells the room ---------- */
sent.length = 0;
const localId = entry.id;
const bytes = entry.blob;                       // an outside reference, to prove one existed
const dropped = registry.remove(localId);

ok("remove() drops the file", dropped === true && registry.get(localId) === undefined);
ok("remove() releases the bytes",
   bytes?.size === 1024 && entry.blob === null && entry.thumb === null,
   "splicing the array is not enough — a Blob lives as long as the entry pointing at it");

const goneFrame = sent.find(f => f.t === registry.FRAME_GONE);
ok("removing our own file retracts it to the room", Boolean(goneFrame),
   goneFrame ? "" : "peers would keep a tile for a file that no longer exists");
ok("the retraction names the file and nothing else",
   goneFrame?.id === localId && !("blob" in (goneFrame ?? {})) && !("name" in (goneFrame ?? {})),
   "the room already saw the name in the file-meta this retracts");
ok("the retraction says which device it is from",
   goneFrame?.originId === state.get().originId,
   "the receiver only honours a retraction from the device that announced the file");

ok("removing an id that is not here is a no-op", registry.remove("nosuchid") === false);

/* ---------- removing someone else's file is local only ---------- */
sent.length = 0;
ok("removing a remote file drops it here", registry.remove("remote1") === true &&
   registry.get("remote1") === undefined);
ok("and retracts nothing to the room", sent.length === 0,
   "hiding a tile here must not look like deleting the file off the device that holds it");

/* ---------- removing mid-transfer cancels the transfer first ---------- */
cancelled.length = 0;
await registry.add([new File([new Uint8Array(2048)], "inflight.bin")], { makeThumbs: false });
const inflight = registry.all().find(f => f.name === "inflight.bin");
registry.setState(inflight.id, registry.STATE.SENDING);
registry.setProgress(inflight.id, 40);
ok("a file being sent is busy", registry.isBusy(inflight.id) === true);

registry.remove(inflight.id);
ok("removing mid-transfer cancels the transfer", cancelled.length === 1 &&
   cancelled[0].id === inflight.id,
   "otherwise the sender streams a file that is no longer in the list and the peer waits out an idle timeout");
ok("the cancel runs while the file is still listed", cancelled[0]?.stillListed === true,
   "transfer.cancel() names the file in the message it sends the peer");
ok("and the file goes anyway", registry.get(inflight.id) === undefined,
   "a cancel that fails must not strand the file — the user asked for it gone");
ok("and its half-sent bytes are released", inflight.blob === null);

/* ---------- clear() empties everything ---------- */
sent.length = 0;
cancelled.length = 0;
await registry.add([new File([new Uint8Array(64)], "a.txt"),
                    new File([new Uint8Array(64)], "b.txt")], { makeThumbs: false });
registry.addRemote({ id: "remote2", name: "theirs2.pdf", size: 10,
                     type: "application/pdf", thumb: null, originId: "peerX" });
registry.setState("remote2", registry.STATE.RECEIVING);

const held = [...registry.all()];
const wiped = registry.clear();

ok("clear() reports how many went", wiped === held.length, `${wiped} of ${held.length}`);
ok("clear() empties the list", registry.count() === 0 && registry.all().length === 0);
ok("clear() releases every blob it held", held.every(f => f.blob === null && f.thumb === null),
   "twenty files is up to 100 MB, which is the whole reason this control exists");
ok("clear() cancels a transfer that was running",
   cancelled.some(c => c.id === "remote2"),
   "a mid-transfer download must be stopped, not abandoned half-written");
ok("clear() retracts only our own files",
   sent.filter(f => f.t === registry.FRAME_GONE).length === 2,
   "two local files, one remote — the remote one is not ours to retract");

sent.length = 0;
ok("clear() on an empty list is a silent no-op",
   registry.clear() === 0 && sent.length === 0);

/* ---------- an inbound retraction is honoured only from the owner ----------
   File requests are authenticated by session membership alone (P2P-FILES §6),
   so an unchecked retraction would let anyone holding the key empty everyone
   else's file list. */
registry.addRemote({ id: "remote3", name: "theirs3.pdf", size: 10,
                     type: "application/pdf", thumb: null, originId: "peerX" });

ok("a peer cannot retract a file it did not announce",
   registry.applyGone({ t: registry.FRAME_GONE, id: "remote3", originId: "peerY" }) === false &&
   Boolean(registry.get("remote3")));
ok("a spoofed originId does not beat the relay's own stamp",
   registry.applyGone({ t: registry.FRAME_GONE, id: "remote3", from: "peerY", originId: "peerX" }) === false &&
   Boolean(registry.get("remote3")),
   "`from` is set by the relay on the socket the frame arrived on; originId is whatever the sender typed");
ok("the device that announced it can retract it",
   registry.applyGone({ t: registry.FRAME_GONE, id: "remote3", from: "peerX" }) === true &&
   registry.get("remote3") === undefined);
ok("a retraction for a file we never had changes nothing",
   registry.applyGone({ t: registry.FRAME_GONE, id: "remote3", from: "peerX" }) === false);

// There is no fallback to `originId` when the stamp is missing: accepting one
// would hand the check straight back to the client it exists to constrain.
// The relay stamps every file-gone it fans out, so this shape cannot arrive.
registry.addRemote({ id: "remote4", name: "theirs4.pdf", size: 10,
                     type: "application/pdf", thumb: null, originId: "peerX" });
ok("an unstamped retraction is refused even from the real owner",
   registry.applyGone({ t: registry.FRAME_GONE, id: "remote4", originId: "peerX" }) === false &&
   Boolean(registry.get("remote4")));
registry.applyGone({ t: registry.FRAME_GONE, id: "remote4", from: "peerX" });

await registry.add([new File([new Uint8Array(8)], "mine.txt")], { makeThumbs: false });
const stillMine = registry.all().find(f => f.name === "mine.txt");
ok("a peer cannot retract a file off this machine",
   registry.applyGone({ t: registry.FRAME_GONE, id: stillMine.id, originId: "peerX" }) === false &&
   Boolean(registry.get(stillMine.id)),
   "the console warning above is the point of this check");

/* ---------- session allowances ----------
   "Allow all from this device" is a standing grant to send files off the
   machine without asking again, so what it does NOT cover matters as much as
   what it does. */
console.log("\nSession allowances\n");

// storage.js degrades silently without web storage, which would make every
// assertion below pass for the wrong reason.
const store = new Map();
globalThis.sessionStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

state.setKey({ key: "ROOMA1", roomHash: "roomA" });

ok("a device nobody vouched for is not allowed", transfer.isPeerAllowed("peerZ") === false);
ok("allowing a device takes", transfer.allowPeer("peerZ") === true && transfer.isPeerAllowed("peerZ"));
ok("the allowance is stored against its room, in session storage",
   (store.get("realtimeclipboard.allow") || "").includes("roomA"), store.get("realtimeclipboard.allow"));
ok("allowing one device does not allow another", transfer.isPeerAllowed("peerY") === false);

// The security property: rotating the key is how a device is thrown out of a
// session, so an allowance must not survive it — in either direction.
state.setKey({ key: "ROOMB2", roomHash: "roomB" });
ok("rotating the key drops the allowance", transfer.isPeerAllowed("peerZ") === false,
   "a device ejected by a new key must not still be trusted");
transfer.allowPeer("peerB");
state.setKey({ key: "ROOMA1", roomHash: "roomA" });
ok("and going back to the old room does not resurrect it",
   transfer.isPeerAllowed("peerZ") === false && transfer.isPeerAllowed("peerB") === false);

ok("an allowance can be taken back",
   transfer.allowPeer("peerQ") && transfer.forgetPeer("peerQ") && !transfer.isPeerAllowed("peerQ"));

/* The default with no approver and no allowance is to deny — failing open here
   would hand every file to anyone holding the key. */
const ours = registry.all().find(f => f.name === "mine.txt");
transfer.setApprover(null);

/** onSignal is fire-and-forget by design, so wait for the frame it produces. */
async function waitFor(type, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = sent.find(f => f.t === type);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 20));
  }
  return null;
}

sent.length = 0;
transfer.onSignal({ t: "file-req", id: ours.id, from: "peerStranger" });
ok("an unknown device with no approver is denied", Boolean(await waitFor("file-deny")),
   sent.map(f => f.t).join(", ") || "nothing sent");

sent.length = 0;
transfer.allowPeer("peerFriend");
transfer.onSignal({ t: "file-req", id: ours.id, from: "peerFriend" });
const accepted = await waitFor("file-accept");
ok("an allowed device is served without an approver at all",
   Boolean(accepted) && !sent.some(f => f.t === "file-deny"),
   sent.map(f => f.t).join(", ") || "nothing sent");
transfer.cancel(ours.id, "test over");

/* A request identifies its sender by the relay's stamp and nothing else. Both
   of these used to be honoured: `originId` is chosen by the sender, so naming
   an allowed device was enough to inherit its grant. */
sent.length = 0;
transfer.onSignal({ t: "file-req", id: ours.id, originId: "peerFriend" });
await new Promise(r => setTimeout(r, 120));
ok("a request with no relay stamp is dropped", sent.length === 0,
   sent.map(f => f.t).join(", ") || "nothing sent");

sent.length = 0;
transfer.onSignal({ t: "file-req", id: ours.id, from: "peerStranger", originId: "peerFriend" });
const spoofed = await waitFor("file-deny", 600);
ok("a stranger cannot borrow an allowed device's grant by naming it",
   Boolean(spoofed) && !sent.some(f => f.t === "file-accept"),
   sent.map(f => f.t).join(", ") || "nothing sent");
transfer.cancel(ours.id, "test over");

/* A live transfer belongs to one peer. Every handler used to find it by file id
   alone, so any other member of the room could cancel it, answer its
   negotiation, or inject bytes into it. A request we are WAITING on is the
   transfer that stays live long enough to aim a frame at. */
transfer.setRequestTimeoutMs(30_000);
sent.length = 0;
registry.addRemote({ id: "remote9", name: "theirs9.bin", size: 4096,
                     type: "", thumb: null, originId: "peerOwner" });
await transfer.request("remote9");
const started = transfer.isActive("remote9");

transfer.onSignal({ t: "file-cancel", id: "remote9", from: "peerIntruder", reason: "mine now" });
await new Promise(r => setTimeout(r, 120));
const survived = transfer.isActive("remote9");

transfer.onSignal({ t: "file-cancel", id: "remote9", from: "peerOwner", reason: "changed my mind" });
await new Promise(r => setTimeout(r, 120));
ok("a third device cannot cancel someone else's transfer",
   started === true && survived === true,
   started ? (survived ? "" : "the intruder's cancel was honoured") : "the request never started");
ok("...but the peer it belongs to still can",
   transfer.isActive("remote9") === false);
transfer.setRequestTimeoutMs(transfer.requestTimeoutMs());

/* ---- peer-supplied filenames -------------------------------------------
 *
 * The name is chosen by whoever sent the file, rendered in the grid, and
 * becomes the `download` attribute — the string a user reads before deciding
 * whether to open what it names. Browsers already refuse a path separator
 * there, so this is not about traversal. It is about the name being read as
 * what it is.
 *
 * Escapes, never literals: a bidi override typed into this file would be
 * invisible in review, which is the whole property under test.
 */
const named = (id, name) => {
  registry.addRemote({ id, name, size: 10, type: "application/pdf",
                       thumb: null, originId: "peerX" });
  return registry.get(id).name;
};

ok("a bidi override cannot disguise the extension",
   named("n1", "report‮txt.exe") === "reporttxt.exe", named("n1"));

ok("control characters are stripped",
   named("n2", "in voice.pdf") === "invoice.pdf", named("n2"));

ok("path separators cannot survive, whatever consumes the name",
   !/[\\/]/.test(named("n3", "../../etc/passwd")), named("n3"));

ok("a leading dot cannot hide the file",
   !named("n4", "...hidden.txt").startsWith("."), named("n4"));

ok("an over-long name is bounded",
   named("n5", "a".repeat(500)).length <= FILES.MAX_NAME_CHARS,
   String(named("n5").length));

ok("a name that sanitises to nothing still has one",
   named("n6", " ‮  ") === "unnamed", named("n6"));

ok("an ordinary name is left exactly alone",
   named("n7", "Q3 report (final).pdf") === "Q3 report (final).pdf", named("n7"));

console.log("\n" + "=".repeat(58));
console.log(`FILES: ${pass}/${pass + fail} passed`);
console.log("=".repeat(58));
process.exit(fail ? 1 : 0);
