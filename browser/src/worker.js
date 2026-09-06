/**
 * The service worker — the session lives here so it survives the popup closing.
 *
 * An MV3 worker is still evicted after ~30s idle, and there is nothing to be
 * done about that: this is the surface that reconnects on demand rather than
 * the one that stays connected. `cli/session.mjs` handles the reconnect, and the
 * key is re-read from storage on every wake.
 */

// FIRST, and it must stay first: core/native.js decides the surface at module
// scope, so this has to be evaluated before anything under src/ is.
import "./surface.js";

import * as room from "../../cli/session.mjs";
import * as keys from "../../src/core/keys.js";
import * as guard from "../../src/clipboard/guard.js";
import * as clipboard from "./clipboard.js";

const ORIGIN = `ext-${Date.now().toString(36)}`;
let session = null;

/**
 * The clip and the verdict on it are ONE value, and that is the fix for a real
 * bypass: they used to be two. The connect path persisted `executable` to
 * session storage while the popup-join path set only an in-memory `latest`, and
 * pasteLatest() read the text from either but the verdict from storage alone —
 * so a `curl … | sh` arriving after a popup join had no verdict, read as safe,
 * and the hotkey wrote it. A keystroke is not a decision about a shell command
 * somebody else sent you, so the two never travel apart again.
 */
let latest = null;                   // { text, executable } | null

const load = async () => (await chrome.storage.local.get(["key", "locked"]));

async function connect() {
  const { key, locked } = await load();
  if (!key) throw new Error("no session yet — open the popup and start one");
  if (session?.key === key && room.isOpen()) return session;

  // A locked room needs a PIN that is deliberately never stored, so this surface
  // cannot resume one unattended. The popup asks; the worker does not.
  if (locked) throw new Error("this session has a PIN — open the popup to rejoin");

  session = await room.derive(key, null);
  await openRoom(session);
  return session;
}

/** The ONE place a room is opened, so there is one onClip and one verdict. */
async function openRoom(s) {
  await room.open({
    session: s, name: "Browser extension", timeoutMs: 15_000,
    originId: ORIGIN, onClip: received,
  });
}

/**
 * Every clip carries an id, because the popup reviews one clip and confirms it
 * a moment later: without an id the confirmation wrote whatever had arrived by
 * the time of the click, so a command sent between the two was written under an
 * approval the user gave to something else entirely.
 *
 * Unique across a worker restart as well — MV3 evicts one after ~30s idle, and
 * a counter alone would start again at the same numbers.
 */
let clipSeq = 0;
const nextClipId = () => `${Date.now().toString(36)}-${(++clipSeq).toString(36)}`;

function received(text) {
  const clip = guard.defuse(text);
  latest = { id: nextClipId(), text: clip, executable: guard.looksExecutable(clip) };
  // Mirrored so a restarted worker still knows what it was holding. The three
  // are written together or not at all.
  chrome.storage.session?.set({
    latest: latest.text, executable: latest.executable, latestId: latest.id,
  });
  chrome.action.setBadgeText({ text: "1" });
  chrome.action.setBadgeBackgroundColor({ color: "#4ec9b0" });
}

/**
 * A clip belongs to the room it arrived in. Creating or joining a session left
 * it standing — in memory, in storage and on the badge — so paste-latest and
 * the popup went on offering the previous room's clip as the current one.
 */
function forgetLatest() {
  latest = null;
  chrome.storage.session?.remove(["latest", "executable", "latestId"]);
  chrome.action.setBadgeText({ text: "" });
}

/**
 * Memory first, storage only when this worker has none — and always as a PAIR.
 *
 * Both halves of that are bugs this function has already had. Reading the text
 * from one source and the verdict from the other was the guard bypass. Reading
 * STORAGE first was staleness: received() does not await the mirror write, so a
 * clip arriving while the previous one is still in storage would be handed back
 * as the older one. While this worker is alive its own memory is the newest
 * thing there is; storage exists for the restart after MV3 evicts it.
 */
async function currentClip() {
  if (latest) return latest;
  const st = (await chrome.storage.session?.get(["latest", "executable", "latestId"])) ?? {};
  return typeof st.latest === "string"
    ? { id: st.latestId ?? null, text: st.latest, executable: Boolean(st.executable) }
    : null;
}

async function sendClipboard() {
  await connect();
  const text = await clipboard.read();
  if (!text) return "Your clipboard is empty.";
  await room.send(session, text, ORIGIN);
  return `Sent ${text.length} characters.`;
}

async function pasteLatest() {
  const clip = await currentClip();
  if (!clip?.text) return "No clips have arrived yet.";
  // A clip that reads like a command is never written by a hotkey. A keystroke
  // is not a decision about a shell command someone else sent you.
  if (clip.executable) return "That clip looks like a shell command — open the popup to confirm it.";
  await clipboard.write(clip.text);
  chrome.action.setBadgeText({ text: "" });
  return "On your clipboard.";
}

chrome.commands?.onCommand.addListener(async (cmd) => {
  try {
    const msg = cmd === "send-clipboard" ? await sendClipboard()
      : cmd === "paste-latest" ? await pasteLatest() : null;
    if (msg) notify(msg);
  } catch (err) { notify(err.message); }
});

chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (msg?.target !== "worker") return false;
  (async () => {
    try {
      if (msg.type === "new") {
        const key = keys.generate(keys.nextLength());
        await chrome.storage.local.set({ key, locked: false });
        session = null;
        forgetLatest();
        await connect();
        respond({ ok: true, key, link: keys.shareLink(key, false) });
      } else if (msg.type === "join") {
        const parsed = keys.parseFragment(
          msg.key.includes("#") ? msg.key.slice(msg.key.indexOf("#") + 1) : msg.key);
        // A locked LINK with no PIN would derive the open room of the same key —
        // a real room, joinable by anyone holding the link. Refused rather than
        // silently joined; the popup asks for the PIN.
        if (parsed.locked && !msg.pin) throw new Error("that link is locked — enter its PIN");
        session = await room.derive(parsed.key, msg.pin || null);
        await chrome.storage.local.set({ key: parsed.key, locked: Boolean(msg.pin) });
        forgetLatest();
        await openRoom(session);
        respond({ ok: true, key: parsed.key });
      } else if (msg.type === "send") { respond({ ok: true, message: await sendClipboard() }); }
      else if (msg.type === "paste") { respond({ ok: true, message: await pasteLatest() }); }
      else if (msg.type === "confirm-paste") {
        // The only path that writes a flagged clip, and it exists because a
        // person clicked. Same rule as capture.confirmPending() everywhere else.
        const clip = await currentClip();
        if (!clip?.text) { respond({ ok: false, message: "Nothing to write." }); return; }
        // The approval is for the clip the popup DISPLAYED, not for whatever is
        // newest when the click lands. The web app keeps the two together by
        // re-rendering its banner on every replacement; there is no such live
        // view here, so the id is what ties the decision to its subject.
        if (!msg.clipId || clip.id !== msg.clipId) {
          respond({ ok: false, message: "A newer clip arrived — review it before writing." });
          return;
        }
        await clipboard.write(clip.text);
        chrome.action.setBadgeText({ text: "" });
        respond({ ok: true, message: "On your clipboard." });
      } else if (msg.type === "state") {
        const { key, locked } = await load();
        const clip = await currentClip();
        respond({ ok: true, key, locked, link: key ? keys.shareLink(key, locked) : null,
                  latest: clip?.text ?? null, executable: Boolean(clip?.executable),
                  clipId: clip?.id ?? null });
      } else respond({ ok: false, message: "unknown request" });
    } catch (err) { respond({ ok: false, message: err.message }); }
  })();
  return true;                     // the response is async
});

// notifications permission is deliberately not requested for one toast; the
// badge and the popup are enough, and a permission is a thing a reviewer asks
// about and a user has to accept.
const notify = (message) => chrome.action.setTitle({ title: `RealtimeClipboard — ${message}` });
