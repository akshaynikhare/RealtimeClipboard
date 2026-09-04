/**
 * The composition root — the src/main.js analogue, and the only file here that
 * crosses its own layers. The order below mirrors boot() and each step is where
 * it is for a reason.
 */

import { on, EV } from "../../src/core/bus.js";
import * as state from "../../src/core/state.js";
import * as history from "../../src/core/history.js";
import * as native from "../../src/core/native.js";
import * as capture from "../../src/clipboard/capture.js";
import { RELAY_URL } from "../../src/core/config.js";

import * as room from "./room.mjs";
import * as hostFactory from "./host.mjs";
import * as secretsFactory from "./secrets.mjs";
import * as settingsBridge from "./settings.mjs";
import * as status from "./ui/status.mjs";
import * as notify from "./ui/notify.mjs";
import * as commands from "./ui/commands.mjs";

const MENU = "realtimeclipboard.menu";

export async function run(context, vscode) {
  const channel = vscode.window.createOutputChannel("RealtimeClipboard");
  const log = (msg) => channel.appendLine(`[${new Date().toISOString()}] ${msg}`);

  // The extension host got WebSocket with Node 22. engines.vscode should keep us
  // above that, but a clear message beats a stack trace if it ever does not —
  // the same guard cli/realtimeclipboard.mjs has.
  if (typeof WebSocket === "undefined") {
    vscode.window.showErrorMessage(
      "RealtimeClipboard needs a newer VS Code — this one's extension host has no WebSocket.");
    return () => channel.dispose();
  }

  state.restore();                                   // reads the shimmed localStorage

  const host = hostFactory.create(vscode, {});
  const secrets = secretsFactory.create(context);
  native.setHost(host);                              // T0 becomes available from here

  const setContext = (connected, locked) => {
    vscode.commands.executeCommand("setContext", "realtimeclipboard.connected", connected);
    vscode.commands.executeCommand("setContext", "realtimeclipboard.locked", locked);
  };
  setContext(false, false);

  const settings = settingsBridge.init(vscode, { host, secrets });
  await settings.apply({ first: true });

  history.init();                                    // before anything can emit a clip

  // The two edges that make this a clipboard rather than a status bar. UI never
  // touches the transport and the clipboard never learns the network exists;
  // this file is the only place that knows both, exactly as src/main.js is.
  const offCaptured = on(EV.TEXT_CAPTURED, ({ text }) => {
    room.send(text).catch(err => log(`send failed: ${err.message}`));
  });

  const offReceived = on(EV.TEXT_RECEIVED, async ({ text }) => {
    // capture.apply() owns the rung check, guard.defuse(), the executable-clip
    // hold and writeNow()'s ordering. Nothing here may shortcut to os.write().
    await capture.apply(text);
  });

  const disposers = [
    offCaptured,
    offReceived,
    status.init(vscode, { command: MENU }),
    notify.init(vscode, { log }),
    commands.register(vscode, { room, host, secrets, log, setContext }),
    settings.dispose,
    () => host.dispose(),
    () => channel.dispose(),
  ];

  // T0 through the registered host. The DOM tiers self-skip — there is no
  // document here — so this is the poll and the whole funnel behind it.
  capture.start();

  log(`ready · surface=${native.SURFACE} · relay=${RELAY_URL} · tier=${state.get().tier}`);

  // Deliberately not awaited: the session is the product and must not queue
  // behind anything, and a stale remembered key must not fail activation.
  resume(vscode, { room, secrets, setContext, log }).catch(err => log(`resume failed: ${err.message}`));

  return () => {
    room.close();
    disposers.forEach(d => { try { d(); } catch { /* going away anyway */ } });
  };
}

/**
 * A remembered session reopens itself. A locked one cannot — the PIN is never
 * stored, on any surface — so it asks, and a locked link opens NO connection
 * until it has one.
 */
async function resume(vscode, { room, secrets, setContext, log }) {
  if (!state.get().settings.rememberKey) return;
  const saved = await secrets.load();
  if (!saved?.key) return;

  let pin = null;
  if (saved.locked) {
    pin = await vscode.window.showInputBox({
      title: "RealtimeClipboard", prompt: `Enter the PIN for session ${saved.key}`, password: true,
    });
    if (!pin) return log("locked session not resumed — no PIN given");
  }

  const s = await room.open({ key: saved.key, pin });
  setContext(true, s.locked);
  log(`resumed room ${s.roomHash.slice(0, 8)}…`);
}
