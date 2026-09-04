/**
 * The status bar item. Subscribes to EV.* and nothing else — the same boundary
 * that let the SSE failover ship without a UI file changing applies here.
 */

import { on, EV } from "../../../src/core/bus.js";
import * as state from "../../../src/core/state.js";
import { SYNC_MODES } from "../../../src/core/config.js";

const DOT = { idle: "", connecting: "~", connected: "", reconnecting: "~", offline: "!" };

export function init(vscode, { command }) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = command;
  const offs = [];

  function render() {
    const s = state.get();
    if (!s.key) {
      item.text = "$(clippy) Clipboard";
      item.tooltip = "RealtimeClipboard — no session. Click to start one.";
      item.backgroundColor = undefined;
      item.show();
      return;
    }

    const peers = s.peers > 1 ? ` · ${s.peers}` : "";
    const lock = s.locked ? " $(lock)" : "";
    const icon = s.connection === "connected" ? "$(clippy)" : "$(sync~spin)";
    const mode = s.settings.syncMode === SYNC_MODES.LIVE ? "" : ` · ${s.settings.syncMode}`;

    // The key itself is shown: it is on this machine's screen either way, and a
    // status bar that will not say which room you are in is not much use.
    item.text = `${icon} ${s.key}${lock}${mode}${peers}`;
    item.tooltip = [
      `RealtimeClipboard — ${s.connection}`,
      `${s.peers} device${s.peers === 1 ? "" : "s"} in the room`,
      `sync: ${s.settings.syncMode} · capture: ${s.tier}`,
      s.locked ? "locked with a PIN" : "unlocked — the link is enough to join",
    ].join("\n");
    item.backgroundColor = s.connection === "offline"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    item.show();
  }

  for (const ev of [EV.CONN_STATE, EV.PEERS_CHANGED, EV.KEY_CHANGED, EV.SYNC_MODE,
                    EV.LOCK_STATE, EV.TIER_CHANGED, EV.SETTINGS_CHANGED]) {
    offs.push(on(ev, render));
  }
  render();

  return () => { offs.forEach(f => f()); item.dispose(); };
}
