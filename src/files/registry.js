/**
 * In-memory file list. No IndexedDB, no server, no persistence — closing the tab
 * is the cleanup routine. A local entry holds the Blob; a remote entry holds
 * metadata and a thumbnail until someone requests the bytes.
 *
 * Every entry carries the two facts the UI must show and never hide
 * (docs/ARCHITECTURE.md §5): `state`, so a dead transfer leaves a visible reason
 * rather than an abandoned progress bar, and `path`, set when it is decided
 * rather than at completion, so a relay transfer is labelled while still running.
 */

import { FILES } from "../core/config.js";
import { emit, EV } from "../core/bus.js";
import { stripInvisible } from "../core/text.js";
import * as state from "../core/state.js";
import * as thumbs from "./thumbs.js";

const items = [];

/** Lifecycle. `idle` covers both "just sitting here" and "sent successfully". */
export const STATE = {
  IDLE:       "idle",
  REQUESTING: "requesting",   // we asked; nothing has come back yet
  WAITING:    "waiting",      // a peer asked us; a human has to approve
  CONNECTING: "connecting",   // negotiating, ICE race in progress
  SENDING:    "sending",
  RECEIVING:  "receiving",
  DONE:       "done",
  ERROR:      "error",
  CANCELLED:  "cancelled",
};

const BUSY = new Set([STATE.REQUESTING, STATE.WAITING, STATE.CONNECTING, STATE.SENDING, STATE.RECEIVING]);

export const all = () => items;
export const get = id => items.find(f => f.id === id);
export const count = () => items.length;

/** Is a transfer under way for this file? The UI offers cancel when true. */
export const isBusy = id => BUSY.has(get(id)?.state);

/**
 * Two seams, because this module sits UNDER both the transport and the transfer
 * machinery and may import neither. `setSignalSender` takes the same
 * encrypt-and-send closure main.js hands transfer.js; `setCanceller` takes
 * transfer.cancel from ui/filesPanel.js, since importing transfer.js here would
 * be a cycle pointing the wrong way.
 *
 * Both default to "not wired", and every call site treats that as "do the local
 * half and carry on" — a missing collaborator must never block a removal.
 */

let sendSignal = null;
let canceller = null;

export function setSignalSender(fn) { sendSignal = typeof fn === "function" ? fn : null; }
export function setCanceller(fn) { canceller = typeof fn === "function" ? fn : null; }

/** Returns {added, rejected:[{name, reason}]} — the caller reports rejections. */
export async function add(fileList, { makeThumbs = true } = {}) {
  const rejected = [];
  let added = 0;

  for (const file of fileList) {
    if (items.length >= FILES.MAX_COUNT) {
      rejected.push({ name: file.name, reason: `session limit of ${FILES.MAX_COUNT} files reached` });
      continue;
    }
    if (file.size > FILES.MAX_BYTES) {
      rejected.push({ name: file.name, reason: `${thumbs.formatSize(file.size)} — over the 5 MB limit` });
      continue;
    }

    // The slot is taken BEFORE the thumbnail is awaited. Decoding an image is
    // tens of milliseconds, and a concurrent add — a second drop, or a peer's
    // file-meta — checked the cap during that gap and passed on the same stale
    // count, so the session cap FR-7.7 exists to bound was quietly overshot.
    const item = {
      id: crypto.randomUUID().slice(0, 8),
      name: file.name,
      size: file.size,
      type: file.type,
      blob: file,                                   // stays on this machine
      thumb: null,
      origin: "local",
      progress: 0,
      path: null,                                   // "p2p" | "relay" once transferred
      state: STATE.IDLE,
      error: null,
      url: null,                                    // live object URL, if save() made one
    };
    items.push(item);

    // Filled before the announcement, which carries it to the room.
    if (makeThumbs) item.thumb = await thumbs.make(file);

    added++;
    // Announced individually rather than via FILES_CHANGED: that event carries
    // the whole list and fires for progress ticks too, so a listener could not
    // tell "this one is new and needs sending" from "something moved".
    emit(EV.FILE_ADDED, { file: item });
  }

  if (added) emit(EV.FILES_CHANGED, items);
  return { added, rejected };
}

/**
 * A filename chosen by somebody else.
 *
 * It is rendered in the grid and, if the file is saved, becomes the `download`
 * attribute — the name the browser writes to disk and the user reads before
 * opening it. Browsers already refuse a path separator there, so this is not
 * about traversal; it is about the name being read as what it is:
 *
 *   - bidi and control characters, via stripInvisible(). `report[RLO]txt.exe`
 *     renders as `reportexe.txt` and runs as an executable.
 *   - path separators and `..`, because `download` is not the only consumer —
 *     the CLI and any future export path would take this string too, and a
 *     sanitiser that relies on its caller is one refactor from being wrong.
 *   - leading dots, which hide a file on every unix desktop.
 *   - length, because a 30 KB name is a rendering problem in the grid.
 *
 * Never empty: a nameless tile cannot be described, asked for, or reported.
 */
function safeName(raw) {
  const cleaned = stripInvisible(String(raw ?? ""))
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, FILES.MAX_NAME_CHARS);

  return cleaned || "unnamed";
}

/** A peer announced a file: metadata and thumbnail only, no bytes. */
export function addRemote({ id, name, size, type, thumb, originId }) {
  if (get(id)) return;
  items.push({ id, name: safeName(name), size, type, thumb, blob: null,
               origin: "remote", owner: originId, progress: 0, path: null,
               state: STATE.IDLE, error: null, url: null });
  emit(EV.FILES_CHANGED, items);
}

/**
 * `path` rides along in the payload so a listener can label the progress it is
 * showing. ui/statusbar.js currently hard-codes "P2P %" for every tick, which
 * mislabels a relay transfer while it runs; this makes that a one-line fix in
 * a file this change does not own.
 */
export function setProgress(id, percent) {
  const f = get(id);
  if (!f) return;
  f.progress = Math.max(0, Math.min(100, percent));
  emit(EV.FILE_PROGRESS, { id, percent: f.progress, path: f.path });
  emit(EV.FILES_CHANGED, items);
}

/**
 * Where this file is in its lifecycle. Moving out of ERROR clears the old
 * message so a retry does not show the previous failure under a live bar.
 */
export function setState(id, state, error = null) {
  const f = get(id);
  if (!f) return;
  f.state = state;
  f.error = state === STATE.ERROR ? error : null;
  emit(EV.FILES_CHANGED, items);
}

/**
 * Record the transport path as soon as it is known — not at completion.
 * A user watching a slow relay transfer should see RELAY the whole way through,
 * not a P2P badge that turns yellow at the end.
 */
export function setPath(id, path) {
  const f = get(id);
  if (!f || f.path === path) return;
  f.path = path;
  emit(EV.TRANSFER_PATH, { id, path });
  emit(EV.FILES_CHANGED, items);
}

/** Attach received bytes. `path` records whether it came direct or via relay. */
export function complete(id, blob, path) {
  const f = get(id);
  if (!f) return;
  f.blob = blob;
  f.progress = 100;
  f.path = path;
  f.state = STATE.DONE;
  f.error = null;
  emit(EV.TRANSFER_PATH, { id, path });
  emit(EV.FILES_CHANGED, items);
}

/**
 * A transfer failed. Loud by design: a file that silently stops arriving is
 * indistinguishable from a slow network, and the user can do nothing about
 * either unless we say which it was.
 */
export function fail(id, reason = "transfer failed") {
  const f = get(id);
  if (!f) return;
  f.state = STATE.ERROR;
  f.error = String(reason);
  f.progress = 0;
  emit(EV.FILE_PROGRESS, { id, percent: 0 });
  emit(EV.FILES_CHANGED, items);
  emit(EV.TOAST, `${f.name}: ${f.error}`);
}

/**
 * Abort bookkeeping. Does not itself stop a transfer — files/transfer.js owns
 * the sockets; this records the outcome. The UI calls transfer.cancel(), which
 * calls back in here.
 */
export function cancel(id) {
  const f = get(id);
  if (!f) return;
  f.error = null;

  if (f.blob) {
    // We still hold the bytes — a cancelled *send* damages nothing, so the tile
    // goes back to rest rather than wearing a failure it did not suffer.
    f.state = f.origin === "local" ? STATE.IDLE : STATE.DONE;
    f.progress = f.origin === "local" ? 0 : 100;
  } else {
    // A cancelled *download* must stay visibly incomplete, and must not claim
    // a transport path for a transfer that never landed.
    f.state = STATE.CANCELLED;
    f.progress = 0;
    f.path = null;
  }

  emit(EV.FILE_PROGRESS, { id, percent: f.progress, path: f.path });
  emit(EV.FILES_CHANGED, items);
}

/** Put a failed or cancelled entry back to a state a retry can start from. */
export function reset(id) {
  const f = get(id);
  if (!f) return;
  f.state = f.blob ? STATE.DONE : STATE.IDLE;
  f.error = null;
  f.progress = f.blob ? 100 : 0;
  emit(EV.FILES_CHANGED, items);
}

/**
 * Removal, in this order, none of it optional:
 *
 *   1. STOP ANY TRANSFER FIRST. Dropping the entry under a running send makes
 *      transfer.js discover mid-loop that the file went away and report an error
 *      to a peer that did nothing wrong; on the receive side it leaves the
 *      holder streaming into a tab that stopped listening.
 *   2. TELL THE ROOM, if it was ours, or every peer keeps a tile for a file that
 *      no longer exists and only finds out by clicking it.
 *   3. RELEASE THE BYTES. Splicing the array is not enough — an entry can still
 *      be held by a render pass or an object URL, and a Blob lives exactly as
 *      long as the last thing pointing at it.
 */

/**
 * ⚠️ NOT YET DELIVERABLE END TO END. The outbound half is here and tested, but
 * three things outside this module must land before a peer can act on it, and
 * until then nothing reaches the wire at all:
 *
 *   - backend/main.py: "file-gone" must join ROOM_WIDE, or the relay rejects it.
 *   - main.js: registry.setSignalSender(...) and a route into applyGone().
 *   - files/transfer.js: FRAMES is frozen at load and main.js routes strictly
 *     off it, so the type must be declared there to be routed.
 *
 * Until then removal is local-only: a peer requesting a file we no longer hold
 * gets file-error from onFileReq(), which is honest but late.
 */
export const FRAME_GONE = "file-gone";

/**
 * Drop a file from this session.
 *
 * `announce:false` is how an inbound retraction is applied — a peer telling us
 * its file is gone must not make us broadcast a retraction of our own, or two
 * devices bounce the same news around the room.
 */
export function remove(id, { announce = true, reason = "the file was removed" } = {}) {
  const f = get(id);
  if (!f) return false;

  abortTransfer(id, reason);          // before the entry goes — see the note above

  const i = items.indexOf(f);
  if (i >= 0) items.splice(i, 1);

  // While we still know whose it was. Someone else's file is only ever hidden
  // locally: we are not entitled to delete it from the device that holds it.
  if (announce && f.origin === "local") announceGone(f);

  release(f);
  emit(EV.FILES_CHANGED, items);
  return true;
}

/** Drop everything. Returns how many entries went, so the caller can say so. */
export function clear({ announce = true, reason = "the file list was cleared" } = {}) {
  const dropped = [...items];
  if (!dropped.length) return 0;

  // Cancelled first, and while the entries still exist, so transfer.js can name
  // the file in the message it sends the peer.
  for (const f of dropped) abortTransfer(f.id, reason);

  items.length = 0;
  for (const f of dropped) {
    if (announce && f.origin === "local") announceGone(f);
    release(f);
  }
  emit(EV.FILES_CHANGED, items);
  return dropped.length;
}

/** Tell the room a local file is gone, so its tile disappears there too. */
export function announceGone(file) {
  if (!file || file.origin !== "local") return false;
  // Only routing fields: main.js seals everything else, and there is nothing
  // here worth sealing — an id the room already saw in the file-meta it retracts.
  return signal({ t: FRAME_GONE, id: file.id });
}

/**
 * Apply an inbound retraction. Hostile by assumption, like every other frame:
 * membership of the session is the only thing authenticating it (P2P-FILES §6),
 * so a peer may retract what IT announced and nothing else. Without the owner
 * check, anyone holding the key could clear everybody's file list.
 */
export function applyGone(frame) {
  if (!frame || frame.t !== FRAME_GONE || frame.id == null) return false;
  const f = get(String(frame.id));
  if (!f) return false;
  if (f.origin !== "local") {
    // `from` is stamped by the relay on the socket the frame arrived on and is
    // the one field a client cannot lie about; `originId` is whatever the
    // sender typed. Prefer the former, and refuse outright if a file we know
    // the owner of comes with neither.
    const from = frame.from ?? frame.originId;
    if (f.owner && from !== f.owner) return false;
    return remove(f.id, { announce: false, reason: "the other device removed it" });
  }
  // Our own file. A peer does not get to delete it off this machine.
  console.warn("[registry] ignoring a file-gone for a local file", f.id);
  return false;
}

/* ---- the two halves of "actually gone" ---- */

/**
 * Release everything this entry holds on to. `items.splice()` only drops one
 * reference; a 5 MB Blob survives an object URL, and it survives whatever else
 * still points at the entry object (a render pass, a closure mid-await).
 * Nulling the fields makes the removal collectible now rather than eventually.
 */
function release(f) {
  if (!f) return;
  revokeUrl(f);
  f.blob = null;
  f.thumb = null;                     // a 160 px JPEG data URL is ~8 KB, x20
}

function revokeUrl(f) {
  if (!f?.url) return;
  try { URL.revokeObjectURL(f.url); } catch { /* not a browser, or already gone */ }
  f.url = null;
}

/** Stop a transfer for this file, if one is running and a canceller is wired. */
function abortTransfer(id, reason) {
  if (!canceller) return false;
  try { return canceller(id, reason) !== false; }
  catch (err) {
    // A cancel that throws must not strand the file in the list — the user
    // asked for it gone, and the worst case is a transfer that times out.
    console.error("[registry] canceller threw", err);
    return false;
  }
}

let warnedNoSender = false;

function signal(frame) {
  if (!sendSignal) {
    if (!warnedNoSender) {
      warnedNoSender = true;
      console.warn("[registry] no signal sender wired — removals stay local. " +
                   "main.js should call registry.setSignalSender(), and the relay " +
                   `must forward "${FRAME_GONE}"`);
    }
    return false;
  }
  frame.originId = state.get().originId;    // the receiver checks it owns the file
  try { return sendSignal(frame) !== false; }
  catch (err) {
    console.error("[registry] signal send threw", err);
    return false;
  }
}

/**
 * Trigger a browser download of a file we already hold.
 *
 * The object URL used to be revoked on the very next line, which races the
 * download: the URL can be dead before the browser has started fetching it,
 * and the failure mode is a save button that does nothing on some browsers and
 * not others. It is now kept on the entry and revoked either when the file is
 * removed — release() does it immediately, so a removed file cannot be held
 * alive by a URL nobody can reach — or on a timer, whichever comes first.
 */
const SAVE_URL_TTL_MS = 60_000;

export function save(id) {
  const f = get(id);
  if (!f?.blob) return false;

  revokeUrl(f);                                     // never leak a second one
  const url = f.url = URL.createObjectURL(f.blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  a.click();

  // The Blob is already held by the entry, so this URL costs no extra memory
  // while the file is in the session; the timer is what stops it outliving one.
  setTimeout(() => { if (f.url === url) revokeUrl(f); }, SAVE_URL_TTL_MS);
  return true;
}
