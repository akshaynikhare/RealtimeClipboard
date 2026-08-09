/**
 * The sync ladder, in the app header.
 *
 * This is the most consequential control in the app, which is why it sits in
 * the header rather than buried in settings. Three rungs, each adding exactly
 * one thing to the one below it:
 *
 *   Off       — nothing leaves and nothing arrives.
 *   App       — the session syncs in this window. The OS clipboard is neither
 *               read nor written.
 *   Clipboard — the OS clipboard is wired to the room, both ways.
 *
 * A ladder rather than two switches because that is what it is, and one control
 * with three positions is one thing to find instead of two.
 *
 * The labels name the DESTINATION rather than a manner of working. "Live vs
 * Manual" named neither end of that axis, and Manual was not manual on the
 * receiving side — receiving had a switch of its own, so a device set to Manual
 * stopped sending while arriving clips still landed on its system clipboard.
 *
 * It matters because the top rung means the passwords you copy for unrelated
 * reasons travel too, and arriving clips overwrite your real clipboard mid-task.
 */

import { SYNC_MODES } from "../../core/config.js";
import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as capture from "../../clipboard/capture.js";
import { $, esc, setHTML } from "../primitives/dom.js";

/**
 * Order IS the ladder, least connected first. Rendering, the arrow keys and the
 * status-bar menu all walk this array, so the visual order and the conceptual
 * one cannot drift apart.
 */
const OPTIONS = [
  { mode: SYNC_MODES.OFF, label: "Off",
    hint: "Nothing is shared from this device",
    note: "Nothing leaves this device, and nothing arrives" },
  { mode: SYNC_MODES.MANUAL, label: "App",
    hint: "Text syncs in this window only",
    note: "Text syncs in this window — your system clipboard is not touched" },
  { mode: SYNC_MODES.LIVE, label: "Clipboard",
    hint: "What you copy is shared, and what arrives is copied here",
    note: "What you copy is shared, and what arrives is copied here" },
];

/** The status bar says what the app is doing; this says how far it reaches. */
const BAR_LABEL = {
  [SYNC_MODES.OFF]: "Sync off",
  [SYNC_MODES.MANUAL]: "App only",
  [SYNC_MODES.LIVE]: "Clipboard sync",
};

export const RUNGS = OPTIONS;
export const noteFor = mode => OPTIONS.find(o => o.mode === mode)?.note ?? "";

export function init() {
  const host = $("mount-mode");
  if (!host) return;

  // These values are local constants, not user input — but escaping them
  // unconditionally keeps the repo-wide rule true with no exceptions to
  // remember, and costs nothing.
  setHTML(host, `
    <div class="modeswitch" role="radiogroup" aria-label="How far sync reaches on this device">
      ${OPTIONS.map(o => `
        <button class="modebtn" role="radio" data-mode="${esc(o.mode)}"
                aria-checked="false" title="${esc(o.hint)}">${esc(o.label)}</button>`).join("")}
    </div>`);

  host.addEventListener("click", e => {
    const btn = e.target.closest("[data-mode]");
    if (btn) set(btn.dataset.mode, true);
  });

  // Keyboard: a radiogroup that ignores arrows is not a radiogroup. It steps
  // rather than toggles now that there are three rungs, and it clamps rather
  // than wraps — on this control a wrap would take "off" straight to
  // "everything", which is the one transition that must be deliberate.
  host.addEventListener("keydown", e => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = OPTIONS.findIndex(o => o.mode === state.get().settings.syncMode);
    set(OPTIONS[Math.min(OPTIONS.length - 1, Math.max(0, at + step))].mode, true);
  });

  on(EV.SYNC_MODE, ({ mode }) => paint(mode));

  // Another tab of this session moved the rung. state.js has already adopted the
  // value; what is left is the half that lives here — starting or stopping the
  // clipboard binding, and repainting. Without it one window keeps reading and
  // broadcasting the clipboard after the user switched the session off in the
  // other, which is the promise the rung makes.
  on(EV.SETTINGS_CHANGED, ({ name, value, external }) => {
    if (!external || name !== "syncMode") return;
    capture.applyMode();
    paint(value);
  });
  // The tray's "Share what I copy" check item. It asks for a toggle rather than
  // setting the mode itself, so this stays the one place the mode changes — and
  // it toggles the CLIPBOARD binding specifically, which is what that item
  // claims to control. Anything below the top rung reads as "not sharing", so
  // turning it back on lands on Clipboard rather than on whichever rung the
  // device happened to be resting on.
  on("ui:sync-toggle", () => {
    const live = state.get().settings.syncMode === SYNC_MODES.LIVE;
    set(live ? SYNC_MODES.MANUAL : SYNC_MODES.LIVE, true);
  });

  paint(state.get().settings.syncMode);
}

/**
 * Change the rung. Exported because the header switch is not the only control:
 * the status-bar Sync menu offers the same three, and both go through the one
 * function that owns persistence and repainting rather than poking
 * state.settings.syncMode behind this module's back.
 *
 * Returns true only when the mode actually changed, so a caller can decide
 * whether the change is worth telling the user about.
 */
export function set(mode, announce) {
  if (!Object.values(SYNC_MODES).includes(mode)) return false;
  if (state.get().settings.syncMode === mode) return false;

  state.saveSetting("syncMode", mode);
  capture.applyMode();          // emits SYNC_MODE, which repaints
  paint(mode);

  if (announce) emit(EV.TOAST, noteFor(mode));
  return true;
}

function paint(mode) {
  document.querySelectorAll(".modebtn").forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("on", active);
    btn.setAttribute("aria-checked", String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  const bar = $("sbMode");
  if (bar) bar.textContent = BAR_LABEL[mode] ?? BAR_LABEL[SYNC_MODES.LIVE];
}
