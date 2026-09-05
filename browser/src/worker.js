/**
 * The service worker — the session lives here so it survives the popup closing.
 *
 * An MV3 worker is still evicted after ~30s idle, and there is nothing to be
 * done about that: this is the surface that reconnects on demand rather than
 * the one that stays connected. `cli/session.mjs` handles the reconnect, and the
 * key is re-read from storage on every wake.
 */

import * as room from "../../cli/session.mjs";
import * as keys from "../../src/core/keys.js";
import * as guard from "../../src/clipboard/guard.js";
import * as clipboard from "./clipboard.js";

const ORIGIN = `ext-${Date.now().toString(36)}`;
let session = null;
let latest = null;

const load = async () => (await chrome.storage.local.get(["key", "locked"]));

async function connect() {
  const { key, locked } = await load();
  if (!key) throw new Error("no session yet — open the popup and start one");
  if (session?.key === key && room.isOpen?.()) return session;

  // A locked room needs a PIN that is deliberately never stored, so this surface
  // cannot resume one unattended. The popup asks; the worker does not.
  if (locked) throw new Error("this session has a PIN — open the popup to rejoin");

  session = await room.derive(key, null);
  await room.open({
    session, name: "Browser extension", timeoutMs: 15_000,
    onClip: (text) => {
      latest = guard.defuse(text);
      chrome.storage.session?.set({ latest, executable: guard.looksExecutable(latest) });
      chrome.action.setBadgeText({ text: "1" });
      chrome.action.setBadgeBackgroundColor({ color: "#4ec9b0" });
    },
  });
  return session;
}

async function sendClipboard() {
  await connect();
  const text = await clipboard.read();
  if (!text) return "Your clipboard is empty.";
  await room.send(session, text, ORIGIN);
  return `Sent ${text.length} characters.`;
}

async function pasteLatest() {
  const { latest: stored, executable } = (await chrome.storage.session?.get(["latest", "executable"])) ?? {};
  const text = stored ?? latest;
  if (!text) return "No clips have arrived yet.";
  // A clip that reads like a command is never written by a hotkey. A keystroke
  // is not a decision about a shell command someone else sent you.
  if (executable) return "That clip looks like a shell command — open the popup to confirm it.";
  await clipboard.write(text);
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
        await connect();
        respond({ ok: true, key, link: keys.shareLink(key, false) });
      } else if (msg.type === "join") {
        const parsed = keys.parseFragment(
          msg.key.includes("#") ? msg.key.slice(msg.key.indexOf("#") + 1) : msg.key);
        session = await room.derive(parsed.key, msg.pin || null);
        await chrome.storage.local.set({ key: parsed.key, locked: Boolean(msg.pin) });
        await room.open({ session, name: "Browser extension", timeoutMs: 15_000,
          onClip: (t) => { latest = guard.defuse(t); } });
        respond({ ok: true, key: parsed.key });
      } else if (msg.type === "send") { respond({ ok: true, message: await sendClipboard() }); }
      else if (msg.type === "paste") { respond({ ok: true, message: await pasteLatest() }); }
      else if (msg.type === "confirm-paste") {
        await clipboard.write((await chrome.storage.session.get("latest")).latest ?? "");
        respond({ ok: true, message: "On your clipboard." });
      } else if (msg.type === "state") {
        const { key, locked } = await load();
        const s = (await chrome.storage.session?.get(["latest", "executable"])) ?? {};
        respond({ ok: true, key, locked, link: key ? keys.shareLink(key, locked) : null, ...s });
      } else respond({ ok: false, message: "unknown request" });
    } catch (err) { respond({ ok: false, message: err.message }); }
  })();
  return true;                     // the response is async
});

// notifications permission is deliberately not requested for one toast; the
// badge and the popup are enough, and a permission is a thing a reviewer asks
// about and a user has to accept.
const notify = (message) => chrome.action.setTitle({ title: `RealtimeClipboard — ${message}` });
