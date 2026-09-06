/**
 * In-memory file list. No IndexedDB, no server, no persistence — closing the tab
 * is the cleanup routine. A local entry holds the Blob; a remote entry holds
 * metadata and a thumbnail until someone requests the bytes.
 *
 * Every entry carries the two facts the UI may never hide
 * (docs/ARCHITECTURE.md §5): `state`, so a dead transfer leaves a reason rather
 * than an abandoned bar, and `path`, set when decided rather than at completion,
 * so a relay transfer is labelled while it runs.
 */

import { FILES } from "../core/config.js";
import { emit, EV } from "../core/bus.js";
import { stripInvisible } from "../core/text.js";
import * as state from "../core/state.js";
import * as thumbs from "./thumbs.js";
import { t } from "../core/i18n.js";

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
 * machinery and may import neither — importing transfer.js here would be a cycle
 * pointing the wrong way. Both default to "not wired", and every call site
 * treats that as "do the local half and carry on": a missing collaborator must
 * never block a removal.
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
      rejected.push({ name: file.name, reason: t("session limit of {max} files reached", { max: FILES.MAX_COUNT }) });
      continue;
    }
    if (file.size > FILES.MAX_BYTES) {
      rejected.push({ name: file.name, reason: t("{size} — over the 5 MB limit", { size: thumbs.formatSize(file.size) }) });
      continue;
    }

    // The slot is taken BEFORE the thumbnail is awaited: decoding takes tens of
    // milliseconds, and a concurrent add checked the cap during that gap against
    // the same stale count, overshooting the cap FR-7.7 exists to bound.
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
    // Individually, not via FILES_CHANGED: that carries the whole list and fires
    // for progress ticks, so a listener cannot tell "new" from "something moved".
    emit(EV.FILE_ADDED, { file: item });
  }

  if (added) emit(EV.FILES_CHANGED, items);
  return { added, rejected };
}

/**
 * A filename chosen by somebody else, rendered in the grid and used as the
 * `download` attribute. Browsers already refuse a path separator there, so this
 * is not about traversal but about the name reading as what it is:
 *
 *   - bidi and control characters: `report[RLO]txt.exe` renders as
 *     `reportexe.txt` and runs as an executable.
 *   - path separators and `..`, because `download` is not the only consumer and
 *     a sanitiser relying on its caller is one refactor from being wrong.
 *   - leading dots, which hide a file on every unix desktop.
 *   - length, because a 30 KB name is a rendering problem.
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

  return cleaned || t("unnamed");
}

/** A peer announced a file: metadata and thumbnail only, no bytes. */
export function addRemote({ id, name, size, type, thumb, originId }) {
  if (get(id)) return;
  items.push({ id, name: safeName(name), size, type, thumb, blob: null,
               origin: "remote", owner: originId, progress: 0, path: null,
               state: STATE.IDLE, error: null, url: null });
  emit(EV.FILES_CHANGED, items);
}

/** `path` rides along so a listener can label the progress it is showing. */
export function setProgress(id, percent) {
  const f = get(id);
  if (!f) return;
  f.progress = Math.max(0, Math.min(100, percent));
  emit(EV.FILE_PROGRESS, { id, percent: f.progress, path: f.path });
  emit(EV.FILES_CHANGED, items);
}

/**
 * Moving out of ERROR clears the message, so a retry does not show the previous
 * failure under a live bar.
 */
export function setState(id, state, error = null) {
  const f = get(id);
  if (!f) return;
  f.state = state;
  f.error = state === STATE.ERROR ? error : null;
  emit(EV.FILES_CHANGED, items);
}

/**
 * As soon as it is known, not at completion: someone watching a slow relay
 * transfer sees RELAY throughout, not a P2P badge that turns at the end.
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
export function fail(id, reason = t("transfer failed")) {
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
 * Bookkeeping only — transfer.js owns the sockets. The UI calls transfer.cancel(),
 * which calls back in here.
 */
export function cancel(id) {
  const f = get(id);
  if (!f) return;
  f.error = null;

  if (f.blob) {
    // The bytes are still here, so a cancelled send damages nothing and the tile
    // must not wear a failure it did not suffer.
    f.state = f.origin === "local" ? STATE.IDLE : STATE.DONE;
    f.progress = f.origin === "local" ? 0 : 100;
  } else {
    // A cancelled download stays visibly incomplete and claims no transport path
    // for a transfer that never landed.
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
 * Removal happens in this order, none of it optional:
 *
 *   1. STOP ANY TRANSFER FIRST, or transfer.js discovers mid-loop that the file
 *      went away and errors at a peer that did nothing wrong — and on the
 *      receive side leaves the holder streaming into a tab that stopped
 *      listening.
 *   2. TELL THE ROOM if it was ours, or every peer keeps a tile for a file that
 *      no longer exists and finds out by clicking it.
 *   3. RELEASE THE BYTES. Splicing the array is not enough: an entry can still be
 *      held by a render pass or an object URL, and a Blob lives as long as the
 *      last thing pointing at it.
 */
export const FRAME_GONE = "file-gone";

/**
 * `announce:false` is how an inbound retraction is applied: rebroadcasting one
 * would have two devices bouncing the same news around the room.
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

/**
 * Drop every file a PEER announced, keeping this device's own.
 *
 * A room change abandons the peers that announced them: the tiles name files
 * nobody in the new room can serve, and their ids were minted in a room this
 * device has left. Local files stay — they are this user's, and the room they
 * moved into is still theirs to share them into. Nothing is announced: the
 * peers that would hear it are the ones we just stopped talking to.
 */
export function dropRemote(reason = "the session changed") {
  const dropped = items.filter(f => f.origin === "remote");
  if (!dropped.length) return 0;

  // Cancelled while the entries still exist, so transfer.js can name the file.
  for (const f of dropped) abortTransfer(f.id, reason);

  for (const f of dropped) {
    const at = items.indexOf(f);
    if (at !== -1) items.splice(at, 1);
    release(f);
  }
  emit(EV.FILES_CHANGED, items);
  return dropped.length;
}

/** Tell the room a local file is gone, so its tile disappears there too. */
export function announceGone(file) {
  if (!file || file.origin !== "local") return false;
  // Nothing here is worth sealing: an id the room already saw in the file-meta
  // this retracts.
  return signal({ t: FRAME_GONE, id: file.id });
}

/**
 * Hostile by assumption: session membership is the only thing authenticating a
 * frame (P2P-FILES §6), so a peer may retract what IT announced and nothing
 * else. Without the owner check, anyone with the key clears everybody's list.
 */
export function applyGone(frame) {
  if (!frame || frame.t !== FRAME_GONE || frame.id == null) return false;
  const f = get(String(frame.id));
  if (!f) return false;
  if (f.origin !== "local") {
    // `from` is stamped by the relay and is the one field a client cannot lie
    // about. There is deliberately no fallback to `originId`: that is whatever
    // the sender typed, so accepting it when `from` is absent would hand the
    // check straight back to the client it exists to constrain.
    if (!frame.from || (f.owner && frame.from !== f.owner)) return false;
    return remove(f.id, { announce: false, reason: "the other device removed it" });
  }
  // Our own file. A peer does not get to delete it off this machine.
  console.warn("[registry] ignoring a file-gone for a local file", f.id);
  return false;
}

/* ---- the two halves of "actually gone" ---- */

/**
 * `items.splice()` drops one reference; a 5 MB Blob survives an object URL and
 * whatever else points at the entry (a render pass, a closure mid-await).
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
    // A cancel that throws must not strand the file: the user asked for it gone,
    // and the worst case is a transfer that times out.
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
 * Revoking the object URL on the next line races the download — the URL can die
 * before the browser starts fetching it, and it fails as a save button that does
 * nothing on some browsers and not others. Kept on the entry instead, revoked by
 * release() or by this timer, whichever comes first.
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
