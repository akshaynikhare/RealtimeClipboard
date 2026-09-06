/**
 * Every id in contributes.commands, registered here. The two lists are checked
 * against each other by tests/unit/static-check.mjs — a mismatch is a dead
 * Command Palette entry, which fails with no error anywhere.
 */

import * as keys from "../../../src/core/keys.js";
import * as state from "../../../src/core/state.js";
import * as history from "../../../src/core/history.js";
import * as capture from "../../../src/clipboard/capture.js";
import * as guard from "../../../src/clipboard/guard.js";
import { emit, EV } from "../../../src/core/bus.js";
import { SYNC_MODES, LOCK, POLL_OPTIONS, SITE } from "../../../src/core/config.js";

const PREFIX = "realtimeclipboard.";

export function register(vscode, ctx) {
  const { room, host, secrets, log, setContext } = ctx;
  const d = [];
  const add = (name, fn) => d.push(vscode.commands.registerCommand(PREFIX + name, guarded(vscode, fn)));

  add("newSession", async () => {
    const key = keys.generate(keys.nextLength());
    await start(vscode, ctx, key, null);
    const link = room.shareLink();
    const pick = await vscode.window.showInformationMessage(
      `Session ${key} is live.`, "Copy share link", "Show QR");
    if (pick === "Copy share link" && link) await host.writeQuietly(link);
    if (pick === "Show QR") await vscode.commands.executeCommand(`${PREFIX}showQr`);
  });

  add("joinSession", async () => {
    const raw = await vscode.window.showInputBox({
      title: "Join a RealtimeClipboard session",
      prompt: "The key from the other device, or a share link",
      validateInput: v => (!v || parseKey(v) ? null : "That is not a valid key"),
    });
    if (!raw) return;
    const { key, locked } = parseKey(raw);
    const pin = locked ? await askPin(vscode, "This link is locked. Enter its PIN.") : null;
    if (locked && !pin) return;
    await start(vscode, ctx, key, pin);
  });

  add("copyShareLink", async () => {
    const link = room.shareLink();
    if (!link) return vscode.window.showInformationMessage("No session yet.");
    await host.writeQuietly(link);
    vscode.window.setStatusBarMessage("$(clippy) Share link copied", 3000);
  });

  add("sendSelection", async () => {
    const ed = vscode.window.activeTextEditor;
    const text = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
    if (!text) return vscode.window.showInformationMessage("Nothing selected.");
    // Deliberately NOT via the clipboard: sharing a selection should not clobber
    // what the user already has copied.
    //
    // And announced rather than sent directly. TEXT_CAPTURED is the transmit
    // edge on this surface — main.mjs listens and sends — so calling room.send()
    // here as well put every shared selection on the wire twice. No history.add()
    // either: history subscribes to the same event, and a selection IS a sent
    // clip. Announcing it is what records it and what sends it.
    emit(EV.TEXT_CAPTURED, { text, how: "Sent selection" });
    vscode.window.setStatusBarMessage("$(clippy) Selection shared", 3000);
  });

  add("sendClipboard", async () => {
    const text = await vscode.env.clipboard.readText();
    if (!text) return vscode.window.showInformationMessage("Your clipboard is empty.");
    capture.capture(text, "Sent by hand");
  });

  add("pasteLatest", async () => {
    const clip = latest();
    if (!clip) return vscode.window.showInformationMessage("No clips yet.");
    await copyClip(vscode, clip);
  });

  add("insertLatest", async () => {
    const clip = latest();
    const ed = vscode.window.activeTextEditor;
    if (!clip) return vscode.window.showInformationMessage("No clips yet.");
    if (!ed) return vscode.window.showInformationMessage("No editor is open.");
    await ed.edit(b => b.replace(ed.selection, clip.text));
  });

  add("history", async () => {
    const all = history.all();
    if (!all.length) return vscode.window.showInformationMessage("No clips this session.");
    const pick = await vscode.window.showQuickPick(
      all.map(c => ({
        label: c.text.split("\n")[0].slice(0, 80) || "(blank line)",
        description: c.direction === "sent" ? "$(arrow-up) sent" : "$(arrow-down) received",
        detail: `${c.chars} characters · ${c.at.toLocaleTimeString?.() ?? ""}`.trim(),
        clip: c,
      })),
      { title: "This session's clips", placeHolder: "Kept in memory only — never written to disk" },
    );
    if (!pick) return;
    const what = await vscode.window.showQuickPick(
      ["Copy to clipboard", "Insert at cursor", "Open in a new editor"],
      { title: "Do what with it?" },
    );
    if (what === "Copy to clipboard") await copyClip(vscode, pick.clip);
    if (what === "Insert at cursor") {
      const ed = vscode.window.activeTextEditor;
      if (ed) await ed.edit(b => b.replace(ed.selection, pick.clip.text));
    }
    if (what === "Open in a new editor") {
      const doc = await vscode.workspace.openTextDocument({ content: pick.clip.text });
      await vscode.window.showTextDocument(doc);
    }
  });

  add("syncMode", async () => {
    const pick = await vscode.window.showQuickPick([
      { label: "live", description: "Your system clipboard is wired to the room, both ways" },
      { label: "manual", description: "The session syncs; your clipboard is never touched" },
      { label: "off", description: "Nothing leaves and nothing arrives" },
    ], { title: "Sync mode", placeHolder: state.get().settings.syncMode });
    if (!pick) return;
    // Written to VS Code settings, which are the source of truth on this
    // surface; the configuration listener pushes it into state.
    await vscode.workspace.getConfiguration("realtimeclipboard")
      .update("syncMode", pick.label, vscode.ConfigurationTarget.Global);
  });

  add("lockSession", async () => {
    if (!room.current()) return vscode.window.showInformationMessage("No session to lock.");
    const pin = await askPin(vscode, "Choose a PIN for this session");
    if (!pin) return;
    // Locking is a ROOM CHANGE, not a preference: the lock flag is part of the
    // room hash. Tell the room being abandoned before leaving it.
    await room.evict();
    await start(vscode, ctx, room.current().key, pin);
    vscode.window.showInformationMessage("Locked. Other devices must rejoin with the PIN.");
  });

  add("unlockSession", async () => {
    const s = room.current();
    if (!s?.locked) return vscode.window.showInformationMessage("This session has no PIN.");
    await room.evict();
    await start(vscode, ctx, s.key, null);
    vscode.window.showInformationMessage("PIN removed. The link alone now joins.");
  });

  add("leaveSession", async () => {
    room.close();
    await secrets.forget();
    state.setKey({ key: "", roomHash: "", aesKey: null });
    setContext(false, false);
    log("left the session");
  });

  add("showQr", async () => {
    const s = room.current();
    if (!s) return vscode.window.showInformationMessage("No session yet.");
    const url = keys.qrLink(s.key, s.locked);
    // The app draws it, not us. That is the whole point of SITE.QR_PARAM: the
    // modal there is accessible, already says what the code discloses, and
    // already knows a locked session's code carries the key and not the PIN.
    // A second renderer here would be a second thing to get those wrong in.
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  add("openInBrowser", async () => {
    const link = room.shareLink();
    if (!link) return vscode.window.showInformationMessage("No session yet.");
    await vscode.env.openExternal(vscode.Uri.parse(link));
  });

  add("menu", async () => {
    const connected = Boolean(room.current());
    const items = connected
      ? ["Copy share link", "Show QR", "Send selection", "History…", "Sync mode…",
         state.get().locked ? "Remove PIN" : "Lock with a PIN…", "Open in browser", "Leave session"]
      : ["New session", "Join session…"];
    const pick = await vscode.window.showQuickPick(items, {
      title: connected ? `Session ${state.get().key}` : "RealtimeClipboard",
    });
    const go = {
      "New session": "newSession", "Join session…": "joinSession",
      "Copy share link": "copyShareLink", "Show QR": "showQr", "Send selection": "sendSelection",
      "History…": "history", "Sync mode…": "syncMode", "Lock with a PIN…": "lockSession",
      "Remove PIN": "unlockSession", "Open in browser": "openInBrowser",
      "Leave session": "leaveSession",
    }[pick];
    if (go) await vscode.commands.executeCommand(PREFIX + go);
  });

  return () => d.forEach(x => x.dispose());
}

/* ---------------------------------------------------------------- helpers -- */

async function start(vscode, ctx, key, pin) {
  const { room, secrets, setContext, log } = ctx;
  const s = await room.open({ key, pin });
  setContext(true, s.locked);
  if (state.get().settings.rememberKey) await secrets.save(s.key, s.locked);
  // The room hash only. The key and the PIN are never logged — an extension's
  // log is a file the user can hand to anyone.
  log(`joined room ${s.roomHash.slice(0, 8)}… (${s.locked ? "locked" : "open"})`);
  emit(EV.TOAST, `Session ${s.key} is live`);
}

/**
 * Put a history entry on the clipboard, with the review a REMOTE one needs.
 *
 * putOnClipboard() deliberately applies none of it — its other caller is the
 * user restoring their own history, where mangling what they saved would be the
 * bug. history stores clips exactly as they arrived, so a received one still
 * carries its trailing newline, its invisibles, and whatever command it is; and
 * paste-latest writes without showing anything, on the surface whose integrated
 * terminal is one keystroke from the cursor.
 *
 * Reports what actually happened, too. Below the Live rung putOnClipboard() is
 * a no-op by design, and this said "on your clipboard" regardless.
 */
async function copyClip(vscode, clip) {
  const remote = clip.direction === "received";
  const text = remote ? guard.defuse(clip.text) : clip.text;

  if (remote) {
    const risk = guard.looksExecutable(text);
    if (risk) {
      const go = await vscode.window.showWarningMessage(
        `That clip looks like a command — ${risk}.`,
        { modal: true, detail: text.length > 500 ? `${text.slice(0, 500)}…` : text },
        "Copy it anyway",
      );
      if (go !== "Copy it anyway") return false;
    }
  }

  if (await capture.putOnClipboard(text)) {
    vscode.window.setStatusBarMessage("$(clippy) Copied to your clipboard", 3000);
    return true;
  }
  vscode.window.showInformationMessage(
    "Nothing was copied — the clipboard is only wired up on the Live sync mode.");
  return false;
}

const guarded = (vscode, fn) => async (...args) => {
  try { return await fn(...args); }
  catch (err) { vscode.window.showErrorMessage(`RealtimeClipboard: ${err.message}`); }
};

function parseKey(raw) {
  const v = String(raw).trim();
  const frag = v.includes("#") ? v.slice(v.indexOf("#") + 1) : v;
  const parsed = keys.parseFragment(frag);
  return parsed && keys.isValid(parsed.key) ? parsed : null;
}

const askPin = (vscode, prompt) => vscode.window.showInputBox({
  title: "Session PIN", prompt, password: true,
  validateInput: v => (!v || v.length >= LOCK.MIN_PIN ? null : `at least ${LOCK.MIN_PIN} characters`),
});

const latest = () =>
  history.all().find(c => c.direction === "received") ?? history.all()[0] ?? null;

export const SETTING_KEYS = Object.keys(POLL_OPTIONS);
export const APP_URL = SITE.APP_URL;
export const MODES = SYNC_MODES;
