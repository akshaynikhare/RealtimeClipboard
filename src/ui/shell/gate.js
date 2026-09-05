/**
 * The app, greyed out and unusable, while there is no session to use it with.
 *
 * Two things can stop one opening — a locked link with no PIN, and a key we
 * refused — and both have the same failure to avoid: a working-looking app in
 * front of somebody in no session at all, where the editor accepts text, history
 * marks it SENT and none of it goes anywhere. So the shell goes inert behind a
 * scrim and the only things on screen are the ways out.
 *
 * Not a modal. `ui/primitives/modal.js` closes on Escape and on a backdrop
 * click, which here would hand back exactly the dead app this exists to hide.
 * A gate is dropped by its owner or not at all.
 *
 * One at a time, deliberately: raising a second replaces the first rather than
 * stacking scrims, and the caller that raised it is the caller that drops it.
 */

import { esc, setHTML, lazyStyle } from "../primitives/dom.js";
import { shellInert } from "../primitives/modal.js";

let el = null;
let release = null;

/**
 *   icon     inner SVG markup for a 24-grid glyph, or ""
 *   title    the heading
 *   body     one paragraph, plain text
 *   subject  optional: the value being talked about, shown back in mono
 *   actions  [{ label, ghost, onClick }] — the first is focused
 *   note     optional trailing markup; the ONLY field a caller must escape
 */
export function raise({ icon = "", title, body, subject = "", actions = [], note = "" }) {
  drop();
  lazyStyle("gate.css");

  el = document.createElement("div");
  el.className = "gate";
  // `alert`, not `dialog`: it arrives without being asked for, and everything it
  // interrupts has already stopped working.
  el.setAttribute("role", "alert");
  setHTML(el, `
    <div class="gate-card">
      ${icon ? `<svg class="gate-ico" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` : ""}
      <h2>${esc(title)}</h2>
      <p>${esc(body)}</p>
      ${subject ? `<p class="gate-key">${esc(subject)}</p>` : ""}
      <div class="gate-row">
        ${actions.map((a, i) => `<button class="btn${a.ghost ? " ghost" : ""}" type="button"`
          + ` data-gate="${i}">${esc(a.label)}</button>`).join("")}
      </div>
      ${note ? `<p class="gate-note">${note}</p>` : ""}
    </div>`);

  for (const [i, action] of actions.entries())
    el.querySelector(`[data-gate="${i}"]`)?.addEventListener("click", action.onClick);

  document.body.appendChild(el);
  release = shellInert();

  // The action, not the card. Whoever is looking at this wants one of these
  // buttons, and both are one key away from here.
  el.querySelector("[data-gate]")?.focus();
}

export function drop() {
  release?.();
  release = null;
  el?.remove();
  el = null;
}

export const isUp = () => el !== null;
