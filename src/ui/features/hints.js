/**
 * Getting-started hints, drawn over the empty editor.
 *
 * A textarea `placeholder` cannot carry four lines of formatted guidance and
 * cannot fade on a timer, so this is an overlay instead. Two rules keep it
 * from becoming clutter:
 *
 *   - it exists only while the editor is empty
 *   - it fades on its own, and instantly on the first keystroke
 *
 * Guidance that will not leave is guidance you resent by the third visit.
 */

import { on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import { $, esc, setHTML } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";

const FADE_AFTER_MS = 14000;

/* A function, not a stored array: it captures the four sentences at whatever
   moment it is called, so calling it from init() rather than at module load
   is what keeps a late-loading catalogue from being missed. */
const HINTS = () => [
  t("Copy anything on this machine — it reaches your other devices automatically."),
  t("Or paste here with Ctrl/Cmd+V to share it deliberately."),
  t("Drop a file or image on the right. Only the preview is sent until someone asks for it."),
  t("Share the key above to connect another device. Anyone holding it can read this session."),
];

let node = null;
let timer = null;

export function init() {
  const host = $("mount-hints");
  const editor = $("editor");
  if (!host || !editor) return;

  setHTML(host, `
    <div class="hints" id="hintBox">
      <ol>
        ${HINTS().map(h => `<li>${esc(h)}</li>`).join("")}
      </ol>
    </div>`);
  node = $("hintBox");

  // Any input hides them at once — someone typing has stopped reading.
  editor.addEventListener("input", () => (editor.value ? hide() : show()));
  editor.addEventListener("keydown", hide, { once: true });

  // Content arriving from a peer means the app has visibly worked; the
  // explanation has served its purpose.
  on(EV.TEXT_RECEIVED, hide);

  // The key is only known after the session opens, so the last line is worth
  // re-rendering once it is.
  on(EV.KEY_CHANGED, () => {
    if (!node) return;
    const last = node.querySelector("li:last-child");
    if (last) {
      last.textContent = t("Share the key {key} to connect another device. Anyone holding it can read this session.",
        { key: state.get().key || "" });
    }
  });

  show();
}

function show() {
  if (!node) return;
  node.classList.remove("gone");
  clearTimeout(timer);
  timer = setTimeout(fade, FADE_AFTER_MS);
}

function fade() {
  node?.classList.add("gone");
}

function hide() {
  clearTimeout(timer);
  fade();
}
