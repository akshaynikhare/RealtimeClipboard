/**
 * Composition root. The only file that knows the whole module graph.
 *
 * Everything else talks through core/bus.js: a UI module that needs the network
 * emits an event and the wiring happens here. That boundary is what let the
 * transport stay swappable while the rest of the app was being built.
 */

import {
  TEXT, LOCK, textBytes, sharesSession, RELAY_URL, RELAY_IS_CUSTOM,
} from "./core/config.js";
import { emit, on, EV } from "./core/bus.js";
import * as state from "./core/state.js";
import * as keys from "./core/keys.js";
import * as storage from "./core/storage.js";
import * as cryptoBox from "./core/crypto.js";
import * as device from "./core/device.js";
import { IS_DESKTOP } from "./core/native.js";

import * as relay from "./transport/relay.js";
import * as proto from "./transport/protocol.js";

import * as capture from "./clipboard/capture.js";

// Imported for its side effect as well as init(): install.js restores the room
// key into the fragment at module-evaluation time, which must happen before
// resolveKey() runs — an installed PWA opens with no fragment, because a
// manifest start_url cannot carry one (OI-10).
import * as install from "./ui/features/install.js";

import * as toast from "./ui/shell/toast.js";
import * as banners from "./ui/shell/banners.js";
import * as lockGate from "./ui/shell/lockGate.js";
import * as panes from "./ui/shell/panes.js";
import * as editor from "./ui/panels/editor.js";
import * as filesPanel from "./ui/panels/filesPanel.js";
import * as sessionPanel from "./ui/panels/sessionPanel.js";
import * as statusbar from "./ui/shell/statusbar.js";
import * as resizer from "./ui/shell/resizer.js";
import * as syncMode from "./ui/features/syncMode.js";
import * as appLinks from "./ui/features/appLinks.js";
import * as lockButton from "./ui/features/lockButton.js";
import * as lockDialog from "./ui/features/lockDialog.js";
import * as whatsNew from "./ui/features/whatsNew.js";
import * as hints from "./ui/features/hints.js";
import * as cursors from "./ui/features/cursors.js";
import * as ads from "./ui/features/ads.js";
import * as analytics from "./ui/features/analytics.js";
import * as mobileNav from "./ui/shell/mobileNav.js";

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

  const tab = storage.loadSessionKey();
  if (tab && keys.isValid(tab.key)) return { ...tab, intent: "join" };

  const remembered = storage.loadLastKey();
  if (remembered && keys.isValid(remembered.key)) return { ...remembered, intent: "join" };

  return { key: keys.generate(keys.nextLength()), locked: false, intent: "create" };
}

/**
 * The current session's stretched PIN, so a rotate or a collision can re-derive
 * without asking the user to prove themselves again. Module scope rather than
 * state.js: `state.get()` hands out the whole mutable object and anything could
 * log it wholesale, and this is the one value that must never reach a console.
 * It is the PBKDF2 output — the typed PIN is not retained anywhere.
 */
let lockPrk = null;

/**
 * Open a session, locked or not. `pin` is used exactly once, here, to derive; it
 * is never stored, emitted, or passed on. A caller that has been through this in
 * the same tab can pass `prk` and skip the 600k iterations.
 */
async function openSession(key, intent, { locked = false, pin = null, prk = null } = {}) {
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

    // Remembered against the room it unlocks, so a rotate invalidates it and a
    // refresh does not re-prompt. sessionStorage — it dies with the tab.
    lockPrk = derived.prk;
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

  lockPrk = null;
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
  const { aesKey } = state.get();
  if (!aesKey || !relay.isOpen()) return;
  const { payload, iv } = await cryptoBox.encrypt(aesKey, LOCK.BEACON);
  relay.send(proto.clip({ payload, iv, originId: state.get().originId }));
}

/**
 * Locking moves the session: the lock flag is part of the room hash, so the
 * locking device leaves for a new room and cannot take anyone with it. Before
 * this the others were simply abandoned — still connected, in sync with nobody,
 * with nothing on screen to say so. This sealed sentinel is the goodbye.
 */
async function sendEviction() {
  const { aesKey, originId } = state.get();
  if (!aesKey || !relay.isOpen()) return;
  const { payload, iv } = await cryptoBox.encrypt(aesKey, LOCK.EVICT);
  relay.send(proto.clip({ payload, iv, originId }));
  // Awaited: the caller's next act is to close the socket this travels down.
  await new Promise(done => setTimeout(done, LOCK.EVICT_FLUSH_MS));
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

  leaveRoom();
  lockPrk = null;
  storage.clearLock();
  // Forget the room everywhere resolveKey() looks, or a reload bounces straight
  // back off the retained goodbye into a loop that keeps announcing the same
  // removal. Three places now, and missing one is indistinguishable from missing
  // all three.
  storage.forgetLastKey();
  storage.clearSessionKey();
  keys.clearUrl();
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
  const { aesKey, originId } = state.get();

  switch (msg.t) {
    case proto.T.CLIP: {
      if (msg.originId === originId) return;          // our own echo, ignore
      if (!aesKey) return;
      try {
        const text = await cryptoBox.decrypt(aesKey, msg.payload, msg.iv);

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
      const frame = await decryptFrame(msg);
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
      // x/y/name are sealed by encryptFrame(), so the relay sees only `t` and
      // `originId` — it never learns where a mouse is.
      if (cursors.FRAMES.includes(msg.t)) return cursors.onSignal(await decryptFrame(msg));

      // Driven off transfer.FRAMES, never a hand-written case list: an earlier
      // version enumerated six of eleven and silently dropped file-accept, which
      // carries the chunk plan, so every transfer stalled with no error.
      if (filesFrames.has(msg.t)) routeToFiles(await decryptFrame(msg));
  }
}

let filesSignalHandler = null;
let filesFrames = new Set();

function routeToFiles(msg) {
  if (msg && filesSignalHandler) filesSignalHandler(msg);
}

/**
 * The relay is a blind pipe (docs/P2P-FILES.md §4). Signalling in the clear
 * would hand it every SDP, every ICE candidate — including peer IPs — and, on
 * the fallback path, every byte of every file. Routing fields stay readable
 * because the relay must deliver the frame; everything else is sealed with the
 * session key.
 */
const ROUTING_FIELDS = new Set(["t", "to", "from", "originId", "id", "seq", "total", "crc"]);

async function encryptFrame(frame) {
  const { aesKey } = state.get();
  if (!aesKey) return frame;

  const routing = {}, secret = {};
  for (const [k, v] of Object.entries(frame)) {
    (ROUTING_FIELDS.has(k) ? routing : secret)[k] = v;
  }
  if (!Object.keys(secret).length) return frame;

  const { payload, iv } = await cryptoBox.encrypt(aesKey, JSON.stringify(secret));
  return { ...routing, payload, iv };
}

async function decryptFrame(frame) {
  const { aesKey } = state.get();
  if (!aesKey || !frame.payload || !frame.iv) return frame;
  try {
    const secret = JSON.parse(await cryptoBox.decrypt(aesKey, frame.payload, frame.iv));
    state.setVerified();          // a sealed frame opened: the PIN is right
    const { payload, iv, ...routing } = frame;
    return { ...routing, ...secret };
  } catch {
    // Should be unreachable — drop rather than hand files a half-frame.
    console.warn("[realtimeclipboard] undecryptable signalling frame", frame.t);
    return null;
  }
}

/* ---- outbound ---- */

async function sendText(text) {
  const { aesKey, originId, settings } = state.get();
  if (!sharesSession(settings.syncMode)) return;    // Off: nothing leaves, ever
  if (!aesKey || !relay.isOpen()) return;

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

  const { payload, iv } = await cryptoBox.encrypt(aesKey, text);
  relay.send(proto.clip({ payload, iv, originId }));
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

  try {
    relay.send(await encryptFrame(
      proto.stream({ text, caret, name: device.name(), originId })));
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
const sealedSender = what => frame => {
  if (!relay.isOpen()) return false;
  encryptFrame(frame)
    .then(sealed => relay.send(sealed))
    .catch(err => console.error(`[realtimeclipboard] could not send ${what}`, err));
  return true;
};

/**
 * Leave the room we are in. Every path that opens a different one goes through
 * here first — a rejoin, a rotation, a lock, an unlock, a re-PIN — because
 * forgetting any one of the three strands something: a live socket, the derived
 * key of a room we have left, or a roster that reports old peers as new.
 */
function leaveRoom() {
  relay.close();
  cryptoBox.clearCache();
  state.resetRoster();
}

/* ---- wiring ---- */

function wire() {
  relay.setFrameHandler(onFrame);

  cursors.setSignalSender(sealedSender("a cursor frame"));

  // A commit that came FROM the editor does not go back into it: the committed
  // text is trimmed, and writing it back would move the caret of someone who is
  // very likely still typing.
  on(EV.TEXT_CAPTURED, ({ text, source }) => {
    if (source !== "editor") editor.setText(text);
    sendText(text);
  });

  // Typing -> the far editors, and nowhere else. Deliberately not routed through
  // sendText(): that path is the commit, and keystrokes down it would fill
  // history and rewrite everyone's clipboard letter by letter.
  on(EV.TEXT_TYPED, frame => sendStream(frame));

  /**
   * The clipboard write is the rung's business and capture.apply() owns it. The
   * EDITOR is different: overwriting it discards what the user was typing, with
   * no undo. So when there is unsent work the clip is OFFERED rather than
   * applied — the rule that lets two people type at once without a merge
   * algorithm: never merge, never destroy, always offer.
   */
  on(EV.TEXT_RECEIVED, async ({ text }) => {
    const onClipboard = await capture.apply(text);

    if (!editor.isDirty()) {
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
    relay.close();
    cryptoBox.clearCache();
    const key = keys.generate(keys.nextLength());
    emit(EV.TOAST, "That key was taken — generated a new one");
    // The PIN survives a regenerated key: the collision is with the key, and
    // re-asking would look like the PIN just typed had been rejected.
    const { locked } = state.get();
    await openSession(key, "create", { locked, prk: locked ? lockPrk : null });
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
    leaveRoom();

    // Cancelling leaves the app where it was rather than dropping the user into
    // some other room.
    if (locked) {
      const pin = await lockDialog.ask({ mode: "join", key });
      if (!pin) return;
      return openSession(keys.normalise(key), "join", { locked: true, pin });
    }
    await openSession(keys.normalise(key), "join");
  });

  /**
   * "Someone joined and it wasn't me" — leave and take a new key. A locked
   * session keeps its PIN: rotation answers "somebody has my link", and somebody
   * who only had the link never had the PIN. Changing the PIN is its own action.
   */
  on("session:rotate", async () => {
    leaveRoom();
    const { locked } = state.get();
    const key = keys.generate(keys.nextLength());
    emit(EV.TOAST, locked
      ? "New key — the PIN is unchanged"
      : "New key — the old session is abandoned");
    await openSession(key, "create", { locked, prk: locked ? lockPrk : null });
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
    if (others) await sendEviction();

    leaveRoom();
    const key = keys.generate(keys.nextLength());
    emit(EV.TOAST, others
      ? `Locked — ${others} device${others === 1 ? "" : "s"} disconnected. `
        + "They need the new link and the PIN"
      : "Locked — your other devices need the new link and the PIN");
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
    const pin = await lockDialog.ask({ mode: "create" });
    if (!pin) return;
    leaveRoom();
    // Same key, new PIN — and therefore a different room. The link does not
    // change, which is the point: this is "the PIN got out", not "the link did".
    emit(EV.TOAST, "New PIN — devices using the old one are left behind");
    await openSession(state.get().key, "create", { locked: true, pin });
  });

  /**
   * The beacon is planted only into a room that is empty AND has no retained
   * clip. That is correctness, not caution: the beacon IS a clip and the relay
   * keeps one per room (FR-3.3), so sending it into a room that already has one
   * would overwrite somebody's actual last clip with a sentinel. It re-arms for
   * free — after a redeploy or a 10-minute eviction, whoever arrives first
   * plants it again.
   */
  on(EV.ROOM_STATE, ({ existing, hasLast }) => {
    if (!state.get().locked || existing > 0 || hasLast) return;
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
    relay.close();
    // Leaving has to actually leave. The derived key used to outlive the room it
    // belonged to, and a locked session's unlock would have sat in
    // sessionStorage for the next person to sit down at this tab.
    cryptoBox.clearCache();
    lockPrk = null;
    storage.clearLock();
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

  // Deliberately not awaited: the session is the product and must not queue
  // behind panel rendering, a service-worker registration, or a QR encoder.
  const { key, intent, locked } = resolveKey();
  startSession(key, intent, locked).catch(err => {
    console.error("[realtimeclipboard] session failed to open", err);
    state.setConnection("offline", "could not start session");
    emit(EV.TOAST, "Could not start the session — check the console");
  });

  // ---- everything below is decoration ---------------------------------
  safeInit("clipboard capture", () => capture.start());
  safeInit("files panel", filesPanel.init);
  safeInit("session panel", sessionPanel.init);
  safeInit("resizers", resizer.init);
  safeInit("sync mode", syncMode.init);
  safeInit("lock button", lockButton.init);
  safeInit("project links", appLinks.init);
  safeInit("what's new", () => { whatsNew.init(); });
  safeInit("hints", hints.init);
  safeInit("ad slot", ads.init);
  safeInit("analytics", analytics.init);
  safeInit("peer cursors", cursors.init);
  safeInit("install prompt", install.init);

  await loadOptional();
  safeInit("panes", panes.init);

  // After loadOptional(), because the phone tab bar offers a Clips tab only if
  // the history pane actually mounted.
  safeInit("mobile nav", mobileNav.init);

  console.info(
    `[realtimeclipboard] booted · intent=${intent} locked=${!!locked} device=${device.name()}`
  );
}

document.addEventListener("DOMContentLoaded", boot);
