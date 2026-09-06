/**
 * Composition root. The only file that knows the whole module graph.
 *
 * Everything else talks through core/bus.js: a UI module that needs the network
 * emits an event and the wiring happens here. That boundary is what let the
 * transport stay swappable while the rest of the app was being built.
 */

import {
  TEXT, LOCK, textBytes, sharesSession, RELAY_URL, RELAY_IS_CUSTOM, ORG_TOKEN,
} from "./core/config.js";
import { emit, on, EV } from "./core/bus.js";
import * as state from "./core/state.js";
import * as keys from "./core/keys.js";
import * as storage from "./core/storage.js";
import * as cryptoBox from "./core/crypto.js";
import * as device from "./core/device.js";
import * as history from "./core/history.js";
import { encryptFrame, decryptFrame, setPlaintextFrames } from "./core/frames.js";
import { IS_DESKTOP } from "./core/native.js";

import * as relay from "./transport/relay.js";
import * as proto from "./transport/protocol.js";

import * as capture from "./clipboard/capture.js";

// No side effect at module evaluation: an installed PWA opens with no fragment
// (OI-10) and resolveKey() answers FR-4.5 from storage.loadLastKey() itself.
// This module used to forge a fragment here, which outranked the tab's own
// session and any explicit link — see install.js.
import * as install from "./ui/features/install.js";

import * as toast from "./ui/shell/toast.js";
import * as banners from "./ui/shell/banners.js";
import * as lockGate from "./ui/shell/lockGate.js";
import * as keyGate from "./ui/shell/keyGate.js";
import * as panes from "./ui/shell/panes.js";
import * as editor from "./ui/panels/editor.js";
import * as filesPanel from "./ui/panels/filesPanel.js";
import * as sessionPanel from "./ui/panels/sessionPanel.js";
import * as statusbar from "./ui/shell/statusbar.js";
import * as resizer from "./ui/shell/resizer.js";
import * as syncMode from "./ui/features/syncMode.js";
import * as appLinks from "./ui/features/appLinks.js";
import * as externalLinks from "./ui/features/externalLinks.js";
import * as lockButton from "./ui/features/lockButton.js";
import * as lockDialog from "./ui/features/lockDialog.js";
import * as whatsNew from "./ui/features/whatsNew.js";
import * as hints from "./ui/features/hints.js";
import * as cursors from "./ui/features/cursors.js";
import * as theme from "./ui/features/theme.js";
import * as ads from "./ui/features/ads.js";
import * as analytics from "./ui/features/analytics.js";
import * as mobileNav from "./ui/shell/mobileNav.js";
import * as edtoolsDock from "./ui/shell/edtoolsDock.js";

/* ---- session key ---- */

/**
 * A key from the URL, this tab, or disk means JOINING. A key we generate means
 * CREATING, which must be collision-checked (OI-2) or we could drop the user
 * straight into a stranger's clipboard.
 *
 * The order is the precedence: a link someone just followed outranks whatever
 * this tab was doing, which outranks what the browser remembers from last week.
 * The tab's own copy sits in the middle because it is what a reload reads —
 * openSession() clears the fragment as soon as it has been used, so by the
 * second boot of the same session the URL no longer names a room.
 */
function resolveKey() {
  const url = keys.fromUrl();
  if (keys.isValid(url.key)) return { ...url, intent: "join" };

  // A URL that NAMES a room and is refused does not fall through to the next
  // source. Falling through opened a fresh session under a key the user never
  // saw, so two people following the same bad link landed in two different
  // rooms and neither had any way to know. See ui/shell/keyGate.js.
  const refused = keys.rejectReason(url.key);
  if (refused && refused !== "empty") {
    return { key: url.key, locked: url.locked, intent: "rejected", reason: refused };
  }

  const tab = storage.loadSessionKey();
  if (tab && keys.isValid(tab.key)) return { ...tab, intent: "join" };

  const remembered = storage.loadLastKey();
  if (remembered && keys.isValid(remembered.key)) return { ...remembered, intent: "join" };

  return { key: keys.generate(keys.nextLength()), locked: false, intent: "create" };
}

/**
 * Open a session, locked or not. `pin` is used exactly once, here, to derive; it
 * is never stored, emitted, or passed on. A caller that has been through this in
 * the same tab can pass `prk` and skip the 600k iterations.
 *
 * `sessionGen` is why the derivation is checked twice. It is 250k PBKDF2
 * iterations (600k locked) and nothing stopped a second open from starting
 * during it — a double-click on "New key" is enough. Storage was written in call
 * order and the connection in COMPLETION order, which WebCrypto does not promise
 * to match, so the tab could end up talking to one room while disk remembered
 * another and the next reload landed somewhere nobody was.
 */
let sessionGen = 0;

async function openSession(key, intent, { locked = false, pin = null, prk = null } = {}) {
  const gen = ++sessionGen;
  // The key is remembered, then taken OUT of the address bar. It used to live in
  // the fragment for the whole session, which put it in every screenshot and
  // screen share of the app and in reach of every script in the document —
  // app.html is where clip content is decrypted, so that is the document where
  // it matters. shareLink() builds a link from state when one is asked for, so
  // sharing and the QR code are unaffected; storage is what a reload reads.
  storage.saveSessionKey(key, locked);
  storage.saveLastKey(key, locked, state.get().settings.rememberKey);
  keys.clearUrl();

  // A session is being opened, so the gate has nothing left to stand for.
  pendingLock = null;
  emit(EV.LOCK_REQUIRED, { required: false });

  // Two different waits, so say which. Locked sessions are four times the PBKDF2
  // work (OI-8) and the user is looking at a dialog they just dismissed.
  state.setConnection("connecting", locked ? "unlocking" : "deriving key");

  if (locked) {
    const derived = prk
      ? await cryptoBox.deriveLockedFromPrk(prk)
      : await cryptoBox.deriveLocked(key, pin);
    if (gen !== sessionGen) return;      // a newer session opened while we derived

    // Remembered against the room it unlocks, so a rotate invalidates it and a
    // refresh does not re-prompt. sessionStorage — it dies with the tab. Stored
    // rather than held in a module variable: it opens exactly one room, and the
    // only thing that ever needs it again is a reload of this same session.
    storage.saveLock(key, derived.prk);

    state.setKey({
      key,
      roomHash: derived.roomHash,
      aesKey: derived.aesKey,
      locked: true,
      authToken: derived.authToken,
    });
    announce(derived.roomHash, true);
    relay.connect({
      roomHash: derived.roomHash, intent, name: device.name(), auth: derived.authToken,
    });
    return;
  }

  // Awaited once per session and cached — never per message (OI-8). One call
  // rather than two: the room hash comes off the same PBKDF2 as the AES key, so
  // there is no longer a cheap way to compute it and nothing to run in parallel.
  const { aesKey, roomHash } = await cryptoBox.deriveOpen(key);
  if (gen !== sessionGen) return;        // a newer session opened while we derived

  storage.clearLock();
  state.setKey({ key, roomHash, aesKey });
  announce(roomHash, false);
  relay.connect({ roomHash, intent, name: device.name() });
}

/**
 * The one line about the session that reaches the console: the room hash, never
 * the key. The relay is told the hash anyway, so this discloses nothing new —
 * whereas the key used to be logged on every boot, into every screen recording
 * and support-ticket screenshot the app has appeared in.
 */
function announce(roomHash, locked) {
  console.info(`[realtimeclipboard] session · room=${roomHash} locked=${locked}`);
}

/**
 * Boot into a session, asking for the PIN first if the link says it is locked.
 *
 * Nothing connects until the PIN is in hand. A locked link whose prompt is
 * cancelled leaves the app idle with a way back in — it must NOT fall through to
 * the unlocked room of the same name, which is a real room, joinable by anyone
 * holding the link, and would hand the user a session that looks private.
 *
 * A refresh skips the prompt: this tab's stretched PIN is in sessionStorage
 * under the share key, so a reload is silent while a new tab is not.
 */
async function startSession(key, intent, locked) {
  if (!locked) return openSession(key, intent);

  const known = storage.loadLock(key);
  if (known) return openSession(key, intent, { locked: true, prk: known });

  const pin = await lockDialog.ask({ mode: intent === "create" ? "create" : "join", key });
  if (!pin) {
    // Backing out must not be a dead end: the key is parked for retryLock().
    pendingLock = { key, intent };
    // No LOCK_STATE on purpose — `state.locked` is false because no session was
    // opened, and a padlock on a session that does not exist is a lie.
    state.setConnection("idle", "locked — PIN required");
    // The app behind this is not usable, so it must not look it: the editor
    // accepted text and history marked it SENT, in a session that did not exist.
    emit(EV.LOCK_REQUIRED, { required: true });
    return;
  }
  return openSession(key, intent, { locked: true, pin });
}

/** The session we are standing outside of, if the prompt was cancelled. */
let pendingLock = null;

/** Ask for the PIN again, whether we are in the wrong room or in none at all. */
async function retryLock() {
  const inSession = !!state.get().key;
  const key = state.get().key ?? pendingLock?.key;
  const intent = inSession ? "join" : (pendingLock?.intent ?? "join");
  if (!key) return;

  // "retry" says nobody else is here and the PIN may not match theirs — true of
  // the doubt banner, false of the gate, where nothing was ever typed.
  const pin = await lockDialog.ask({ mode: inSession ? "retry" : "join", key });
  if (!pin) return;              // the gate, if it is up, stays up

  leaveRoom();
  await openSession(key, intent, { locked: true, pin });
}

/**
 * A wrong PIN does not announce itself — it derives a different, empty room,
 * indistinguishable from being first to arrive. So a locked room says one thing
 * about itself: a single clip whose plaintext is a sentinel. The relay retains
 * the last clip of a room and replays it to joiners, so a joiner that decrypts
 * it has PROVED it is in the right room before any peer is awake to answer.
 *
 * Not covered: a room whose last clip expired with the room. Then the session
 * stays "unverified" rather than guessing — see ui/shell/banners.js.
 */
async function sendBeacon() {
  const { aesKey, settings } = state.get();
  if (!aesKey || !relay.isOpen()) return;
  // Off means nothing leaves, and this is a clip in every sense that matters:
  // it goes out as one and it takes the room's single retained slot. The
  // exemption that used to be here argued the beacon is only proof of the room
  // — true, but it is proof planted for OTHER devices to find, so an Off device
  // is putting a frame on the wire for somebody else's benefit while its own UI
  // says nothing leaves. A locked room whose first arrival is Off simply has no
  // beacon until a sharing device gets there; the plant re-arms on its own.
  if (!sharesSession(settings.syncMode)) return;
  const gen = sessionGen;
  const { payload, iv } = await cryptoBox.encrypt(aesKey, LOCK.BEACON);
  // Re-read both: the relay keeps one clip per room, so a sentinel sealed for
  // the room being left would overwrite the NEXT room's retained clip with
  // something nobody there can decrypt.
  if (gen !== sessionGen) return;
  if (!sharesSession(state.get().settings.syncMode)) return;
  relay.send(proto.clip({ payload, iv, originId: state.get().originId }));
}

/**
 * Locking moves the session: the lock flag is part of the room hash, so the
 * locking device leaves for a new room and cannot take anyone with it. Before
 * this the others were simply abandoned — still connected, in sync with nobody,
 * with nothing on screen to say so. This sealed sentinel is the goodbye.
 */
async function sendEviction() {
  const { aesKey, originId, settings } = state.get();
  if (!aesKey || !relay.isOpen()) return false;
  // Gated like the beacon, and for the same reason. The cost is real and is
  // reported rather than hidden: an Off device that locks the session leaves
  // the others connected to a room nobody is in, with nothing on screen to say
  // so. The caller says it out loud instead of claiming they were told.
  if (!sharesSession(settings.syncMode)) return false;
  const gen = sessionGen;
  const { payload, iv } = await cryptoBox.encrypt(aesKey, LOCK.EVICT);
  if (gen !== sessionGen) return false;
  if (!sharesSession(state.get().settings.syncMode)) return false;
  relay.send(proto.clip({ payload, iv, originId }));
  // Awaited: the caller's next act is to close the socket this travels down.
  await new Promise(done => setTimeout(done, LOCK.EVICT_FLUSH_MS));
  return true;
}

/**
 * Disconnect first and explain second — the dialog is modal and the user may
 * leave it sitting there, meanwhile this device must not still be in a room it
 * was told to leave.
 *
 * Guarded because the goodbye is a retained clip: a reconnect replays it, and a
 * second notice would close the first (modal.js never stacks) as a cancel.
 */
let evicted = false;

async function onEvicted() {
  if (evicted) return;
  evicted = true;

  // The whole teardown, not a subset of it. Being removed from a session is an
  // involuntary leave, and it used to keep the generation and the key alive
  // across the modal below — so a clip decrypting as the eviction arrived could
  // land after the user had been told they were out. endSession() also forgets
  // the room everywhere resolveKey() looks, or a reload bounces straight back
  // off the retained goodbye into a loop announcing the same removal.
  endSession();
  state.setConnection("idle", "removed — the session was locked");

  const answer = await lockDialog.notice({
    title: "This session has been locked",
    body: [
      "The device that started this session added a PIN. Locking starts a new "
      + "session, so this one has been disconnected.",
      "To rejoin, you need the new link AND the PIN — the link alone will not "
      + "open it, and the PIN never travels with it.",
    ],
    dismiss: "Close",
    action: "Start a new session",
  });

  evicted = false;
  if (answer !== "action") return;

  const key = keys.generate(keys.nextLength());
  emit(EV.TOAST, "New session — share the link to bring a device in");
  await openSession(key, "create");
}

/* ---- inbound frames ---- */

async function onFrame(msg) {
  // The room this frame arrived in. Every branch below decrypts, and decryption
  // is asynchronous: a frame from a room we are leaving could otherwise land its
  // side effects — a clip in the editor, an eviction notice, a verified badge —
  // in the room we arrived at. Re-checked after each await rather than once,
  // because each await is a separate chance for the session to have moved.
  const gen = sessionGen;
  const { aesKey, originId } = state.get();

  switch (msg.t) {
    case proto.T.CLIP: {
      if (msg.originId === originId) return;          // our own echo, ignore
      if (!aesKey) return;
      try {
        const text = await cryptoBox.decrypt(aesKey, msg.payload, msg.iv);
        if (gen !== sessionGen) return;

        // Anything that decrypts proves this device holds the right PIN.
        // Latched before the sentinel check — the beacon's whole job is this.
        state.setVerified();

        // Neither sentinel is a clip anybody typed, and TEXT_RECEIVED goes on to
        // the editor, history, and the machine's actual clipboard.
        if (text === LOCK.EVICT) return onEvicted();
        if (text === LOCK.BEACON) return;

        // Gated HERE rather than at the top of onFrame: the two sentinels ride
        // this same frame type, and an Off device that stopped reading clips
        // would never hear that a session was locked out from under it. The rung
        // governs what reaches the user, not what the session knows.
        if (!sharesSession(state.get().settings.syncMode)) return;

        emit(EV.TEXT_RECEIVED, { text, from: msg.originId });
      } catch {
        // Should be unreachable: the room name is a hash of the key, so peers in
        // a room share it by construction.
        emit(EV.TOAST, "Could not decrypt a clip — key mismatch");
      }
      break;
    }

    case proto.T.STREAM: {
      if (msg.originId === originId) return;          // our own echo, ignore
      if (!aesKey) return;
      if (!sharesSession(state.get().settings.syncMode)) return;
      const frame = await openFrame(msg, gen);
      // A view update and nothing else: no history, no clipboard write, no
      // dedupe. The editor decides whether it is safe to render.
      if (frame && typeof frame.text === "string") {
        emit(EV.TEXT_STREAMED, {
          text: frame.text,
          caret: frame.caret,
          name: frame.name,
          from: msg.from || msg.originId,
        });
      }
      break;
    }

    default:
      // "Off: nothing arrives" covers presence and files as well. The two lock
      // sentinels are gated further up instead, inside the CLIP branch, because
      // an Off device must still hear that its session was locked out from under
      // it — nothing down here is in that category.
      if (!sharesSession(state.get().settings.syncMode)) return;

      // x/y/name are sealed by encryptFrame(), so the relay sees only `t` and
      // `originId` — it never learns where a mouse is.
      if (cursors.FRAMES.includes(msg.t)) return cursors.onSignal(await openFrame(msg, gen));

      // Driven off transfer.FRAMES, never a hand-written case list: an earlier
      // version enumerated six of eleven and silently dropped file-accept, which
      // carries the chunk plan, so every transfer stalled with no error.
      if (filesFrames.has(msg.t)) routeToFiles(await openFrame(msg, gen));
  }
}

let filesSignalHandler = null;
let filesFrames = new Set();

/**
 * Stop the files layer at a room boundary. Wired by wireFiles(); a no-op until
 * then, and after a failed import, because the files layer is optional and a
 * missing one must not break leaving a session.
 */
let filesTeardown = () => {};

/**
 * Open a signalling frame, and only let it count as proof of the PIN once the
 * session it arrived in is still the one we are in.
 *
 * setVerified() used to sit inside decryptFrame(), which returns BEFORE the
 * generation is re-checked — so a frame decrypted under a room being left could
 * mark the room just arrived at as verified, which is the padlock in the status
 * bar saying the PIN has been proved when nothing has proved it.
 */
async function openFrame(msg, gen) {
  const frame = await decryptFrame(msg);
  if (gen !== sessionGen) return null;
  if (frame && msg.payload && msg.iv) state.setVerified();
  return frame;
}

function routeToFiles(msg) {
  if (msg && filesSignalHandler) filesSignalHandler(msg);
}

/* ---- outbound ---- */

/**
 * A clip committed before the session finished opening. Boot starts the
 * connection un-awaited — deliberately, the session must not queue behind panel
 * rendering — so the editor accepts text while the key is still deriving and the
 * socket still opening. Dropping it there was silent AND permanent: history had
 * already recorded it as sent, and both retry paths (committing again, clicking
 * the history row) are swallowed by the `lastSent` dedupe that the first attempt
 * set. One slot, because a clip is a clipboard: the newest supersedes.
 */
let queuedClip = null;      // { text, gen } — see sessionGen

async function sendText(text) {
  const { settings } = state.get();
  if (!sharesSession(settings.syncMode)) return;    // Off: nothing leaves, ever

  // Bytes, not characters — the relay counts the encoded frame, so multibyte
  // text can sit inside MAX_CHARS and still be too large.
  //
  // The last gate before the wire, and it must be loud. The editor's own check
  // only covers text a human typed; this path is where an auto-captured
  // clipboard arrives, and a silent `return` was a clip that never synced.
  const bytes = textBytes(text);
  if (bytes > TEXT.MAX_BYTES) {
    return emit(EV.TOAST, `Too big to send — ${Math.ceil(bytes / 1024)} KB, `
      + `limit ${Math.floor(TEXT.MAX_BYTES / 1024)} KB`);
  }

  if (!state.get().aesKey || !relay.isOpen()) {
    queuedClip = { text, gen: sessionGen };
    return;
  }
  sendClip(text);
}

/** Sealed and sent in commit order — see sealedSender for why that is not free. */
const sendClip = (() => {
  let tail = Promise.resolve();
  return text => {
    // The room this clip was written for. Everything below is asynchronous —
    // the queue ahead of it, then the encryption — and a clip committed in one
    // room used to be sealed with the NEXT room's key and broadcast there.
    const gen = sessionGen;
    tail = tail.then(async () => {
      if (gen !== sessionGen) return;
      const { aesKey, originId } = state.get();
      if (!aesKey || !relay.isOpen()) { queuedClip = { text, gen }; return; }
      const { payload, iv } = await cryptoBox.encrypt(aesKey, text);
      // Both questions again, because encryption is long enough for either
      // answer to change: is this still the room, and is this device still
      // sharing? Dropping to Off during the seal used to send anyway.
      if (gen !== sessionGen) return;
      if (!sharesSession(state.get().settings.syncMode)) return;
      relay.send(proto.clip({ payload, iv, originId }));
    }).catch(err => console.error("[realtimeclipboard] could not send a clip", err));
  };
})();

/** The session came up. Anything committed while it was opening goes now. */
function flushQueuedClip() {
  if (queuedClip === null) return;
  const { text, gen } = queuedClip;
  queuedClip = null;
  // Not this room's clip. It was committed into a session that has since been
  // left, and "connected" here is the NEW room saying hello.
  if (gen !== sessionGen) return;
  // Re-read the rung: it can have dropped to Off while the session was opening,
  // and that promise outranks a clip queued under the old one.
  if (!sharesSession(state.get().settings.syncMode)) return;
  sendClip(text);
}

/**
 * Typing, for the far editor to render. Fire-and-forget: a dropped stream frame
 * costs one repaint and the next supersedes it. What must not be dropped is the
 * COMMIT, which travels the clip path above with its guarantees intact.
 *
 * The size gate sits here as well as in the editor because this is the last
 * point before the wire, and a rule enforced at one of two call sites is a rule
 * about to be enforced at neither.
 */
async function sendStream({ text, caret }) {
  const { aesKey, originId, settings } = state.get();
  if (!sharesSession(settings.syncMode)) return;
  if (!aesKey || !relay.isOpen()) return;
  if (textBytes(text) > TEXT.STREAM_MAX_BYTES) return;

  // Keystrokes are sealed asynchronously like everything else, so the room can
  // change between typing one and putting it on the wire.
  const gen = sessionGen;
  try {
    const sealed = await encryptFrame(
      proto.stream({ text, caret, name: device.name(), originId }));
    if (gen !== sessionGen) return;
    if (!sharesSession(state.get().settings.syncMode)) return;
    relay.send(sealed);
  } catch (err) {
    console.error("[realtimeclipboard] could not send a stream frame", err);
  }
}

/**
 * The injected sender every layer below the transport is handed — cursors,
 * transfer and registry all take the same shape.
 *
 * The contract is synchronous, so `false` means "not sent" and the check that
 * matters (are we connected at all?) happens up front; encryption is async, and
 * a failure after that point is reported by the relay's own error frame.
 */
const sealedSender = what => {
  // Sealed in issue order, not in whichever order WebCrypto finishes. Two
  // encryptions in flight complete by size and luck, and the pair that has no
  // pacing gap between them — a transfer's last chunk and the file-done that
  // follows it in the same synchronous run — inverted often enough that a fully
  // delivered file failed at 100% with "1 chunks missing".
  let tail = Promise.resolve();
  return frame => {
    // The rung governs everything that leaves, not only clips. File
    // announcements, requests, chunks, RTC negotiation and cursor frames all go
    // out through here and none of them asked — so a device set to Off, whose
    // own UI reads "Nothing leaves this device", still announced every file it
    // held (name, size and a legible thumbnail), still answered requests for the
    // bytes, and still drew its cursor in everyone else's editor.
    if (!sharesSession(state.get().settings.syncMode)) return false;
    if (!relay.isOpen()) return false;
    // Same reason as sendClip: encryption reads the key when it RUNS, so a
    // frame issued in one room could be sealed with the next room's key.
    const gen = sessionGen;
    // Re-read at every step, not once on the way in. A frame accepted while
    // this device was sharing must not leave after it stopped: the queue can
    // hold a file chunk for as long as the encryptions ahead of it take, which
    // is exactly the window someone dropping to Off is trying to close.
    const sharing = () => sharesSession(state.get().settings.syncMode);
    tail = tail
      .then(() => (gen === sessionGen && sharing() ? encryptFrame(frame) : null))
      .then(sealed => {
        if (sealed && gen === sessionGen && sharing()) relay.send(sealed);
      })
      .catch(err => console.error(`[realtimeclipboard] could not send ${what}`, err));
    return true;
  };
};

/**
 * Leave the room we are in. Every path that opens a different one goes through
 * here first — a rejoin, a rotation, a lock, an unlock, a re-PIN — because
 * forgetting any one of the three strands something: a live socket, the derived
 * key of a room we have left, or a roster that reports old peers as new.
 */
function leaveRoom() {
  // Anything still in flight belonged to the room being left: a decrypt that
  // has not resolved, a clip half-sealed, a derivation mid-PBKDF2. Invalidated
  // HERE rather than in each caller, because several of them then sit on a
  // modal — an eviction notice, a PIN prompt, a collision — and for the length
  // of that dialog the old generation still matched and the old key was still
  // live, so a decrypt that started before the room changed could finish
  // afterwards and put its clip in the editor and on the clipboard.
  sessionGen++;
  relay.close();
  cryptoBox.clearCache();
  state.clearKey();
  state.resetRoster();

  // A clip committed into the room being left is not a clip for the next one,
  // and neither is one still waiting for a click to reach the clipboard.
  queuedClip = null;
  capture.forgetSession();

  // Closing the relay says nothing to a WebRTC data channel — it is peer-direct
  // — so a transfer to a device this room change is EJECTING carried on
  // streaming. The peers that announced the remote tiles are gone with the room.
  filesTeardown();
}

/**
 * Leave, and leave nothing behind. Five separate strands make up "in a session"
 * and this used to cut one of them: the socket. The derived key, the remembered
 * room, the queued clip and a clipboard write still waiting for focus all
 * survived, so a reload rejoined and content from the abandoned room still
 * reached the clipboard.
 *
 * `sessionGen` first: a derivation may be mid-PBKDF2 right now, and openSession()
 * checks the generation after it to decide whether it is still wanted.
 */
function endSession() {
  leaveRoom();                    // invalidates the generation and clears the key
  pendingLock = null;
  storage.clearLock();
  storage.clearSessionKey();
  storage.forgetLastKey();
  keys.clearUrl();
  history.clear("session-left");
  filesTeardown({ full: true });
}

/* ---- wiring ---- */

/** Arrival order for clips, so a slow clipboard write cannot reorder the editor. */
let receivedSeq = 0;

function wire() {
  relay.setFrameHandler(onFrame);

  cursors.setSignalSender(sealedSender("a cursor frame"));

  // A commit that came FROM the editor does not go back into it: the committed
  // text is trimmed, and writing it back would move the caret of someone who is
  // very likely still typing. It goes to the author's OWN clipboard instead —
  // on the Clipboard rung the editor IS the clipboard, and without this a clip
  // typed here landed on every machine's clipboard except the one it was typed
  // on. Every other source already came OFF this machine's clipboard, so for
  // them the write would be a no-op at best and a capture loop at worst.
  on(EV.TEXT_CAPTURED, ({ text, source }) => {
    if (source !== "editor") editor.setText(text);
    else capture.putOnClipboard(text);
    sendText(text);
  });

  // Typing -> the far editors, and nowhere else. Deliberately not routed through
  // sendText(): that path is the commit, and keystrokes down it would fill
  // history and rewrite everyone's clipboard letter by letter.
  on(EV.TEXT_TYPED, frame => sendStream(frame));

  on(EV.CONN_STATE, ({ state: conn }) => { if (conn === "connected") flushQueuedClip(); });

  // Dropping to Off stops what is already moving, not merely what starts next.
  // A transfer in flight when the rung came down went on streaming, because the
  // gate above only refuses new frames.
  on(EV.SYNC_MODE, ({ mode }) => { if (!sharesSession(mode)) filesTeardown(); });

  /**
   * The clipboard write is the rung's business and capture.apply() owns it. The
   * EDITOR is different: overwriting it discards what the user was typing, with
   * no undo. So when there is unsent work the clip is OFFERED rather than
   * applied — the rule that lets two people type at once without a merge
   * algorithm: never merge, never destroy, always offer.
   */
  on(EV.TEXT_RECEIVED, async ({ text }) => {
    // capture.apply() may really write the OS clipboard, which takes long enough
    // that a clip arriving behind this one can finish first — it queues and
    // returns without touching the clipboard at all. Resuming then would put the
    // OLDER clip in the editor, on top of the newer one already shown.
    const gen = sessionGen;
    const seq = ++receivedSeq;
    const onClipboard = await capture.apply(text);
    if (seq !== receivedSeq) return;
    // And the same write is slow enough for a whole room change to finish
    // underneath it, which would land the old room's clip in the new editor.
    if (gen !== sessionGen) return;

    // A clip identical to what is on screen has nothing to destroy, so it
    // never warrants an offer — "replaces what you have typed" with itself.
    if (!editor.isDirty() || text === editor.getText()) {
      editor.setText(text);
      // A clean apply supersedes any offer still on screen — its "Show it"
      // would now roll the editor BACK to the older clip it was holding.
      emit(EV.CLIP_OFFERED, { text: null });
      // The core event of the product used to announce nothing at all, so a
      // screen-reader user had no way to know a clip had arrived.
      emit(EV.TOAST, `Clip received · ${text.length.toLocaleString()} characters`);
      return;
    }
    emit(EV.CLIP_OFFERED, { text, onClipboard });
  });

  on("clip:accept", ({ text }) => editor.setText(text));

  on(EV.KEY_COLLISION, async () => {
    const { locked } = state.get();
    leaveRoom();
    const key = keys.generate(keys.nextLength());

    if (!locked) {
      emit(EV.TOAST, "That key was taken — generated a new one");
      return openSession(key, "create");
    }

    // The stretched PIN is salted with the key that collided, so it names that
    // room and no other. Carrying it over re-derived the SAME room, collided
    // again, and looped. Re-deriving needs the PIN, which is never retained.
    emit(EV.TOAST, "That key was taken — confirm the PIN for the new one");
    const pin = await lockDialog.ask({
      mode: "rotate",
      key,
      note: "The key just generated was already in use, so this session has a new one.",
    });
    if (!pin) {
      pendingLock = { key, intent: "create" };
      state.setConnection("idle", "locked — PIN required");
      emit(EV.LOCK_REQUIRED, { required: true });
      return;
    }
    await openSession(key, "create", { locked: true, pin });
  });

  // A copied or pasted image becomes a normal file: the thumbnail is shared
  // immediately, the full image only moves when someone asks (docs/P2P-FILES.md).
  on(EV.IMAGE_CAPTURED, async ({ blob, name, how }) => {
    try {
      const registry = await import("./files/registry.js");
      const file = new File([blob], name, { type: blob.type });
      const { added, rejected } = await registry.add([file], {
        makeThumbs: state.get().settings.thumbs,
      });
      if (added) emit(EV.TOAST, `${how} · ${name}`);
      rejected.forEach(r => emit(EV.TOAST, `${r.name}: ${r.reason}`));
    } catch (err) {
      console.warn("[realtimeclipboard] could not add clipboard image", err);
      emit(EV.TOAST, "Could not read that image");
    }
  });

  /**
   * Restoring behaves like a local capture. Writing the clip to the OS clipboard
   * too is what makes it stick on the top rung: the poll tick used to read the
   * clipboard a second later, find whatever was actually there, and broadcast
   * that instead, so the click appeared to do nothing. Below that rung it is a
   * no-op — this used to force the session down to Manual, which was a far
   * larger act than clicking a history row asks for.
   */
  on("history:restore", ({ text }) => {
    editor.setText(text);
    capture.capture(text, "Restored from history");
    capture.putOnClipboard(text);
    emit(EV.TOAST, "Loaded into the editor");
  });

  on("session:rejoin", async ({ key, locked = false }) => {
    // Asked BEFORE leaving, so cancelling genuinely leaves the app where it was.
    // Leaving first meant the socket was already closed and the key already
    // gone by the time the prompt appeared, so backing out dropped the user into
    // no session at all rather than into the one they were in.
    let pin = null;
    if (locked) {
      pin = await lockDialog.ask({ mode: "join", key });
      if (!pin) return;
    }
    leaveRoom();
    await openSession(keys.normalise(key), "join", pin ? { locked: true, pin } : {});
  });

  /**
   * "Someone joined and it wasn't me" — leave and take a new key. A locked
   * session keeps its PIN: rotation answers "somebody has my link", and somebody
   * who only had the link never had the PIN. Changing the PIN is its own action.
   */
  on("session:rotate", async () => {
    const { locked } = state.get();
    const key = keys.generate(keys.nextLength());

    // A locked rotation is a fresh derivation, not a re-expansion. The stretched
    // PIN is PBKDF2(PIN, LOCK_SALT + key), so it names the room being LEFT:
    // reusing it kept the "rotated" session in that exact room — same room hash,
    // same AES key, same admission token — with every device holding the old
    // link still in it, while the new link plus the PIN derived a third room
    // that was empty. The PIN itself is never retained, so this has to ask.
    // Asked before leaving, so backing out changes nothing.
    let pin = null;
    if (locked) {
      pin = await lockDialog.ask({ mode: "rotate", key });
      if (!pin) return;
    }

    leaveRoom();
    emit(EV.TOAST, locked
      ? "New key — your other devices need the new link and the PIN"
      : "New key — the old session is abandoned");
    await openSession(key, "create", locked ? { locked: true, pin } : {});
  });

  /**
   * Locking and unlocking are room changes, not preferences. There is no such
   * thing as "this room, but locked", so we leave and open a different one —
   * which is also the honest behaviour: clips already in the old room stay as
   * readable as they were, and pretending a switch protected them would be a lie.
   */
  on("session:lock", async () => {
    // Checked here as well as on the button: the gear menu emits this same
    // event, and a rule enforced at one of two call sites is about to be
    // enforced at neither.
    if (state.get().locked) return emit(EV.TOAST, "This session is already locked");
    if (!state.canLock()) {
      return emit(EV.TOAST, "Only the first device in this session can lock it");
    }

    const others = Math.max(0, state.get().peers - 1);
    const pin = await lockDialog.ask({
      mode: "create",
      note: others
        ? `${others} other device${others === 1 ? " is" : "s are"} in this session. `
          + "Locking moves you to a new one, so they will be disconnected."
        : "",
    });
    if (!pin) return;

    // Said out loud to the room being left, before the socket carrying it goes.
    // It does not always get said: on the Off rung nothing leaves this device,
    // the goodbye included, and the toast reports which of the two happened.
    const saidGoodbye = others ? await sendEviction() : true;

    leaveRoom();
    const key = keys.generate(keys.nextLength());
    emit(EV.TOAST, !others
      ? "Locked — your other devices need the new link and the PIN"
      : saidGoodbye
        ? `Locked — ${others} device${others === 1 ? "" : "s"} disconnected. `
          + "They need the new link and the PIN"
        : `Locked — but this device is set to Off, so the other `
          + `${others === 1 ? "device was" : "devices were"} not told`);
    await openSession(key, "create", { locked: true, pin });
  });

  on("session:unlock", async () => {
    if (!state.get().locked) return;
    leaveRoom();
    const key = keys.generate(keys.nextLength());
    emit(EV.TOAST, "Unlocked — anyone with the new link can read this");
    await openSession(key, "create");
  });

  on("session:repin", async () => {
    if (!state.get().locked) return;
    // Read BEFORE leaving: leaveRoom() clears the key along with everything else
    // belonging to the room, and this is the one path that reuses it.
    const key = state.get().key;
    const pin = await lockDialog.ask({ mode: "create" });
    if (!pin || !key) return;
    leaveRoom();
    // Same key, new PIN — and therefore a different room. The link does not
    // change, which is the point: this is "the PIN got out", not "the link did".
    emit(EV.TOAST, "New PIN — devices using the old one are left behind");
    await openSession(key, "create", { locked: true, pin });
  });

  /**
   * The beacon is planted into any locked room with no retained clip.
   *
   * `hasLast` is the whole guard, and it is the one that matters: the beacon IS
   * a clip and the relay keeps one per room (FR-3.3), so planting into a room
   * that already has one would overwrite somebody's actual last clip with a
   * sentinel. It re-arms for free — after a redeploy or a 10-minute eviction,
   * whoever arrives next plants it again.
   *
   * It used to ALSO require an empty room, which guarded nothing `hasLast` did
   * not and left a hole that widened the moment the beacon started honouring
   * the sync rung: a device on Off arrives first and plants nothing, the next
   * device sees `existing > 0` and plants nothing either, and neither can ever
   * decrypt anything — so a correctly joined device with the right PIN sat
   * there being told its PIN might not match.
   *
   * The cost of dropping it is a narrow race: a peer can send a real clip
   * between our welcome and our beacon, and ours would take the retained slot.
   * That costs one future joiner their replay, and hands them the verification
   * this exists for instead.
   */
  on(EV.ROOM_STATE, ({ hasLast }) => {
    if (!state.get().locked || hasLast) return;
    sendBeacon();
  });

  /**
   * `existing` is the peer count taken the instant before we joined, so zero
   * means we were first. That is the whole basis for who may lock the session,
   * and it is the relay's answer rather than ours — a client cannot decide for
   * itself that it was first. Re-answered on every welcome, because a relay
   * restart drops every room (OI-13).
   */
  on(EV.ROOM_STATE, ({ existing }) => state.setFounder(existing === 0));

  on("session:relock", () => retryLock());

  on("ui:whatsnew", () => whatsNew.open());

  // On reconnect the roster is rebuilt from scratch, so known peers would each
  // be reported as a fresh arrival and fire the "a device joined" warning —
  // crying wolf on every deploy (OI-13).
  on(EV.CONN_STATE, ({ state: connState }) => {
    if (connState === "reconnecting" || connState === "offline") state.resetRoster();
  });

  // The status bar offers a transport; only this file may hand it to the
  // transport layer (docs/ARCHITECTURE.md §3).
  on(EV.TRANSPORT_SELECT, ({ mode }) => relay.setTransport(mode));

  on("session:leave", () => {
    endSession();
    state.setConnection("idle");
    emit(EV.TOAST, "Left the session");
  });
}

/* ---- files layer hookup ---- */

async function wireFiles() {
  try {
    const transfer = await import("./files/transfer.js");
    const registry = await import("./files/registry.js");
    filesFrames = new Set(transfer.FRAMES ?? []);
    filesSignalHandler = transfer.onSignal ?? null;
    setPlaintextFrames(transfer.PLAINTEXT_FRAMES);

    // `full` is the difference between changing rooms and leaving altogether:
    // a rotation keeps this user's own files, which are theirs to share into the
    // room they moved to, while leaving keeps nothing.
    filesTeardown = ({ full = false } = {}) => {
      try {
        transfer.cancelAll("the session changed");
        if (full) registry.clear({ announce: false, reason: "the session ended" });
        else registry.dropRemote();
      } catch (err) {
        console.warn("[realtimeclipboard] files teardown failed", err);
      }
    };

    // registry needs the wire too, to retract a file it has removed. It sits
    // under transfer.js and may not import it, so it takes the same sender.
    registry.setSignalSender?.(sealedSender("a file retraction"));

    // Announcing local files and re-announcing to new peers is transfer.js's own
    // business — it subscribes to the bus directly. Doing it from here is how
    // the outbound half went missing in the first place.
    transfer.setSignalSender(sealedSender("a signalling frame"));
  } catch (err) {
    console.warn("[realtimeclipboard] files transfer layer unavailable", err);
  }
}

/**
 * Optional features, loaded dynamically so a missing or failing one degrades to
 * "that panel is absent" rather than a blank page.
 */
/**
 * `?qr=1` — show the share code as soon as there is a session to show.
 *
 * It exists so a surface that cannot draw a QR can hand the job to the app: the
 * VS Code extension opens this URL rather than growing a renderer, and gets the
 * accessible modal, the right caption and the locked/unlocked distinction for
 * free. See keys.qrLink().
 *
 * WAITS for the session rather than testing for it once. startSession() is
 * deliberately not awaited in boot() — the session must not queue behind panel
 * rendering — so by the time this runs the key is often not set yet, and for a
 * LOCKED link it is guaranteed not to be: that path is sitting on a PIN prompt
 * waiting for a human. Checking once and returning meant the QR never opened in
 * exactly the case where scanning it is most useful.
 *
 * The parameter survives keys.clearUrl(), which strips the fragment and keeps
 * the search, so it is read after boot rather than snapshotted before it.
 */
function openQrIfAsked(wanted) {
  if (!keys.qrRequested()) return;
  if (state.get().key) return sessionPanel.showQr();
  // No key to wait for. Leaving a session emits KEY_CHANGED with an empty one,
  // which would otherwise match an empty `wanted` and draw a code for no room.
  if (!wanted) return;

  // Armed for ONE room — the one the link named — and it stays armed until that
  // room opens. Both halves matter, and they fail in opposite directions.
  //
  // Without the key check, backing out of the PIN prompt left this waiting and
  // the next session the user started by hand had ITS code put on screen
  // unasked. Unsubscribing before the check fixed that and broke the other way:
  // joining any other room first disarmed the listener, so coming back to the
  // requested one never showed the code and only a reload would.
  //
  // So: ignore rooms that are not the one asked for, and stop only once it
  // arrives. It can fire at most once, and only for the room named in the link.
  const off = on(EV.KEY_CHANGED, ({ key }) => {
    if (key !== wanted) return;
    off();
    sessionPanel.showQr();
  });
}

async function loadOptional() {
  // Thunks with LITERAL specifiers. `import(variable)` is opaque to a bundler:
  // it leaves the specifier alone and the deploy asks for a file the bundle does
  // not contain, so both panels fail — caught, warned and degraded exactly as
  // designed, which is precisely why nobody would notice.
  //
  // install.js is initialised in boot(); listing it here would register the
  // service worker twice.
  const features = [
    [() => import("./ui/panels/historyPanel.js"), "history"],
    [() => import("./ui/features/qr.js"),           "qr"],
    // Installed builds only. Gated here so a web visitor never fetches the
    // chunks; both also early-return on their own, because a guard that lives in
    // one place is a guard with one place to forget it.
    ...(IS_DESKTOP ? [
      [() => import("./ui/features/desktopPrefs.js"), "desktop preferences"],
      [() => import("./ui/panels/guidePanel.js"),     "guide"],
    ] : []),
  ];
  for (const [load, label] of features) {
    try {
      const mod = await load();
      await mod.init?.();
    } catch (err) {
      console.warn(`[realtimeclipboard] optional feature "${label}" not loaded:`, err.message);
    }
  }
}

/* ---- boot ---- */

/**
 * Not defensive padding: an unguarded `install.init()` threw here and the
 * exception escaped boot(), so openSession() never ran and the app silently
 * never connected — a broken service-worker helper presenting as "the clipboard
 * doesn't sync". Syncing is the product; nothing decorative may prevent it.
 */
function safeInit(label, fn) {
  try { fn(); }
  catch (err) { console.warn(`[realtimeclipboard] "${label}" failed to init:`, err.message); }
}

async function boot() {
  // First: resolveKey() below asks how long the next key should be, and that was
  // answered from the defaults before this ran here.
  state.restore();

  // A relay handed to us in `?relay=` is already resolved by config.js; this is
  // what makes it stick. Here rather than there so config.js stays free of
  // writes — it reads settings, it does not own them.
  if (RELAY_IS_CUSTOM && storage.loadRelayUrl() !== RELAY_URL) {
    storage.saveRelayUrl(RELAY_URL);
    console.info("[realtimeclipboard] relay set from the address bar:", RELAY_URL);
  }

  // Same deal for a deployment's join token: given once as `?org=`, kept so
  // every later visit is admitted. Never logged — it is the credential that
  // gets a device into the deployment at all.
  if (ORG_TOKEN && storage.loadOrgToken() !== ORG_TOKEN) {
    storage.saveOrgToken(ORG_TOKEN);
    console.info("[realtimeclipboard] organisation token set from the address bar");
  }

  // Straight after state.restore(), which is what read the choice off disk. A
  // device that overrode its OS sees one frame of the wrong palette for every
  // init() this waits behind. Under the default — System — it stamps nothing and
  // the first paint was already right.
  safeInit("theme", theme.init);

  // Core UI first: these own the surfaces that report connection state, so a
  // failure here is worth knowing about loudly rather than swallowing.
  toast.init();
  banners.init();
  statusbar.init();
  editor.init();

  wire();
  await wireFiles().catch(err =>
    console.warn("[realtimeclipboard] files layer unavailable:", err.message));

  // Before the session starts, because the first thing it may do is ask for a
  // PIN and be told no. safeInit anyway: a gate that fails to build must not
  // stop the session it is only there to describe.
  safeInit("lock gate", lockGate.init);
  safeInit("key gate", keyGate.init);

  // The record of what this session saw, and it must be subscribed BEFORE the
  // session can emit anything. It used to be initialised by historyPanel.js
  // inside loadOptional(), racing a connection that boot deliberately does not
  // await: the clip a room replays on join could land with no listener, and so
  // could the KEY_CHANGED that clears another room's clips out of the pane.
  // Idempotent, so historyPanel.js still calls it and still owns the rendering.
  safeInit("history", history.init);

  // Deliberately not awaited: the session is the product and must not queue
  // behind panel rendering, a service-worker registration, or a QR encoder.
  const { key, intent, locked, reason } = resolveKey();

  // A refused key opens nothing at all — no derivation, no connection. The rest
  // of boot still runs: the gate's way out is "session:rotate", wired in wire(),
  // and a half-built app behind the scrim is what the user gets back the moment
  // they take it.
  if (intent === "rejected") {
    keys.clearUrl();               // it is not a room; do not let a reload retry it
    emit(EV.KEY_REJECTED, { key, reason });
  } else {
    startSession(key, intent, locked).catch(err => {
      console.error("[realtimeclipboard] session failed to open", err);
      state.setConnection("offline", "could not start session");
      emit(EV.TOAST, "Could not start the session — check the console");
    });
  }

  // ---- everything below is decoration ---------------------------------
  safeInit("clipboard capture", () => capture.start());
  safeInit("files panel", filesPanel.init);
  safeInit("session panel", sessionPanel.init);
  safeInit("resizers", resizer.init);
  safeInit("sync mode", syncMode.init);
  safeInit("lock button", lockButton.init);
  safeInit("project links", appLinks.init);
  safeInit("external links", externalLinks.init);
  safeInit("what's new", () => { whatsNew.init(); });
  safeInit("hints", hints.init);
  safeInit("ad slot", ads.init);
  safeInit("analytics", analytics.init);
  safeInit("peer cursors", cursors.init);
  safeInit("install prompt", install.init);

  await loadOptional();
  safeInit("panes", panes.init);

  // After loadOptional(), because qr.js is one of the modules it fetches — and
  // after the session is up, because the code is built from state, not from the
  // fragment we have already cleared. Nothing is awaited on this: a QR is
  // decoration and must not be able to hold up the connection.
  safeInit("qr deep link", () => openQrIfAsked(key));

  // After loadOptional(), because the phone tab bar offers a Clips tab only if
  // the history pane actually mounted.
  safeInit("mobile nav", mobileNav.init);
  safeInit("editor toolbar dock", edtoolsDock.init);

  console.info(
    `[realtimeclipboard] booted · intent=${intent} locked=${!!locked} device=${device.name()}`
  );
}

document.addEventListener("DOMContentLoaded", boot);
