/**
 * One modal, so there cannot be three slightly different ones. The app had two
 * hand-rolled focus traps and was about to gain a third — each correct in its
 * own way, which is how the fourth ends up subtly wrong on Shift+Tab.
 *
 * A modal here means: the shell behind it is `inert`, so a screen reader's
 * virtual cursor cannot wander out (aria-modal alone is advisory); Tab cycles
 * inside; Escape and a backdrop click close it; focus returns to whatever opened
 * it; and a second one closes the first rather than stacking.
 *
 * It mounts to `document.body`, NOT `#mount-modals` — filesPanel.js rewrites
 * that node on a 500 ms tick and would delete a dialog out from under its own
 * focus trap, stranding a document-level keydown listener on a detached node.
 *
 * ui/qr.js predates this and still carries its own copy; it has bespoke sizing
 * and a test suite that exercises the encoder through it.
 */

import { esc, setHTML } from "./dom.js";

const SHELL = ".vs";
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let open = null;

/**
 *   className   goes on the outer element; the backdrop is `${className}-back`
 *   html        the dialog's inner markup — the ONLY field the caller is
 *               trusted with, and the only one it must escape itself
 *   label       accessible name, when the markup has no heading to point at
 *   labelledBy  id of the heading inside `html`, preferred over `label`
 *   onClose     called with the result when it closes, however it closes
 *
 * Everything except `html` is escaped here even though every call site passes a
 * module constant: an exception you have to remember is not a rule.
 *
 * Returns `{ el, close }`, so a caller can query its own fields out of `el`
 * without this module knowing what they are.
 */
export function show({ className = "modal", html = "", label = "", labelledBy = "", onClose }) {
  close();                        // never stack

  const name = esc(className);
  const el = document.createElement("div");
  el.className = className;
  setHTML(el, `<div class="${name}-back" data-modal-dismiss></div>`
    + `<div class="${name}-dlg" role="dialog" aria-modal="true" tabindex="-1"`
    + (labelledBy ? ` aria-labelledby="${esc(labelledBy)}"` : ` aria-label="${esc(label)}"`)
    + `>${html}</div>`);

  document.body.appendChild(el);

  const onKey = e => {
    if (e.key === "Escape") { e.preventDefault(); close(null); return; }
    if (e.key === "Tab") trapTab(e, el);
  };
  document.addEventListener("keydown", onKey, true);

  // `detail` is the click count, and a dismiss only ever honours the first.
  // This dialog is mounted synchronously inside the click that asked for it, and
  // its backdrop covers the whole viewport — including the control still under
  // the pointer. So the second click of a double-click on "Lock session", or on
  // any status-menu row, landed on the backdrop and dismissed the dialog the
  // first click had just opened: the button read as doing nothing at all.
  el.addEventListener("click", e => {
    if (e.detail > 1) return;
    if (e.target.closest("[data-modal-dismiss]")) close(null);
  });

  open = { el, onKey, onClose, restoreFocus: document.activeElement, release: shellInert() };

  // The dialog itself, so the first thing announced is its label rather than
  // whatever button happens to be first. A caller that wants an input focused
  // does it after show() returns.
  el.querySelector(`.${className}-dlg`)?.focus?.();

  return { el, close };
}

/**
 * Close, and settle.
 *
 * `onClose` always runs. A caller awaiting an answer from a dialog that got
 * replaced by another one would otherwise wait forever — and in this app that
 * caller is sometimes the code deciding whether to open a session at all.
 */
export function close(result = null) {
  if (!open) return;
  const { el, onKey, onClose, restoreFocus, release } = open;
  open = null;

  // Blank any field before the node is dropped. Removing an element does not
  // scrub the strings it held, and one of these dialogs collects a PIN.
  el.querySelectorAll("input").forEach(i => { i.value = ""; });

  document.removeEventListener("keydown", onKey, true);
  release();
  el.remove();
  if (restoreFocus && document.contains(restoreFocus)) restoreFocus.focus?.();

  onClose?.(result);
}

export const isOpen = () => open !== null;

let inertDepth = 0;

/**
 * Take the app shell out of the tab order and off the screen reader's map, and
 * hand back the release.
 *
 * Refcounted, because two things now want it at once: ui/shell/lockGate.js
 * holds the shell inert for as long as a locked link has no PIN, and the PIN
 * dialog opens on top of that gate. Un-inerting on the dialog's close — which
 * is what a plain boolean did — handed the app back while the gate was still
 * standing in front of it, so Tab walked into an editor nobody could see.
 *
 * Calling the release twice is a no-op, so a caller may be careless with it.
 */
export function shellInert() {
  const shell = document.querySelector(SHELL);
  if (!shell) return () => {};

  if (inertDepth++ === 0) apply(shell, true);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--inertDepth === 0) apply(shell, false);
  };
}

function apply(shell, on) {
  // Tested before assigning: `shell.inert = true` would create an own property
  // and make the feature test pass on an engine that does not implement it.
  const supported = "inert" in shell;
  shell.inert = on;
  if (!on) shell.removeAttribute("aria-hidden");
  else if (!supported) shell.setAttribute("aria-hidden", "true");
}

/**
 * Keep Tab inside the dialog.
 *
 * Deliberately not filtering on offsetParent: it is null for position:fixed
 * elements, which is exactly what these dialogs are, so that test would empty
 * the list in the very case it is meant to serve.
 */
function trapTab(e, el) {
  const items = [...el.querySelectorAll(FOCUSABLE)]
    .filter(n => !n.hasAttribute("disabled") && !n.hidden && n.tabIndex !== -1);
  if (!items.length) { e.preventDefault(); return; }

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  // Anything not in the ring gets pushed to an end of it. That covers focus
  // outside the dialog, and it covers the dialog container itself — which is
  // where focus starts, is tabindex="-1", and therefore is not a ring member.
  // Without this branch the first Shift+Tab of every open escapes the trap,
  // because the browser looks for the previous focusable BEFORE the dialog and
  // finds the app behind it.
  const at = items.indexOf(active);
  if (at === -1) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
