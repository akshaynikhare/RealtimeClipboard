/**
 * Bus events the user should see. The pending-clip path is the security-carrying
 * one: a clip that guard.js flagged reaches a modal with explicit actions, and
 * capture.confirmPending() is the ONLY thing that writes it. Regaining focus is
 * not consent, and there must be no second path — src/clipboard/CLAUDE.md.
 */

import { on, EV } from "../../../src/core/bus.js";
import * as capture from "../../../src/clipboard/capture.js";

export function init(vscode, { log }) {
  const offs = [];

  offs.push(on(EV.TOAST, msg => {
    if (typeof msg === "string" && msg) vscode.window.setStatusBarMessage(`$(clippy) ${msg}`, 4000);
  }));

  offs.push(on(EV.PENDING_CLIP, async ({ pending, text, risk, altered }) => {
    if (!pending || !risk) return;
    log("a clip arrived that reads like a command — held for confirmation");
    // Modal: the integrated terminal is one keystroke from the clipboard, and a
    // toast that scrolls past is not a decision.
    const choice = await vscode.window.showWarningMessage(
      "A clip arrived that looks like a shell command. Put it on your clipboard?",
      { modal: true, detail: preview(text) + (altered ? "\n\n(invisible characters were removed)" : "") },
      "Put on clipboard",
    );
    if (choice === "Put on clipboard") await capture.confirmPending();
    else capture.discardPending();
  }));

  offs.push(on(EV.KEY_COLLISION, () =>
    vscode.window.showWarningMessage("That key is already in use by another session.")));

  return () => offs.forEach(f => f());
}

const preview = (text) =>
  text.length > 400 ? `${text.slice(0, 400)}\n… (${text.length} characters)` : text;
