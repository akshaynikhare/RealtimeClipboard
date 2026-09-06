/**
 * "Lock session", in the app header.
 *
 * The gear menu is the right home for "change the PIN" and "remove the lock",
 * which are things you go looking for. It is the wrong home for the first one:
 * adding a PIN is what someone reaches for the moment they paste something they
 * would rather not leave in a room whose key has been in a chat window, and at
 * that moment they are looking at the header.
 *
 * NOTHING OPENS BY ITSELF. An app that popped a security prompt on arrival would
 * train exactly one behaviour — dismissing it — and this is the prompt that must
 * not be trained away.
 *
 * Who may press it is state.canLock()'s decision, because main.js makes the same
 * call when the event arrives, and two copies of a rule are a future
 * disagreement. This file renders that answer and explains it.
 */

import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import { $, setHTML, on as bind } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";

/** A closed padlock, drawn on the same 24-grid as the header's other icons. */
const ICON = `<rect x="4" y="10.5" width="16" height="10.5" rx="2"/>`
           + `<path d="M8 10.5V7a4 4 0 018 0v3.5"/>`;

export function init() {
  const host = $("mount-lock");
  if (!host) return;

  setHTML(host, `
    <button class="lockbtn" id="bLock" type="button">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICON}</svg>
      <span class="lbl"></span>
    </button>`);

  // Not `disabled`. A disabled button fires no events in any browser, so it
  // shows no tooltip and cannot answer the only question the user has, which
  // is why it will not work — and it drops out of the tab ring, taking the
  // explanation with it for anyone not using a mouse. aria-disabled says the
  // same thing to assistive technology while leaving the control able to speak.
  bind("bLock", "click", e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.getAttribute("aria-disabled") === "true") {
      return emit(EV.TOAST, refusal());
    }
    emit("session:lock");
  });

  render();
  on(EV.LOCK_STATE, render);
  on(EV.KEY_CHANGED, render);
  on(EV.PEERS_CHANGED, render);
  on(EV.FOUNDER, render);
}

/**
 * Why the button is refusing, in the words of this device's situation.
 *
 * Two different refusals that would otherwise share one grey button: the
 * session is already locked, or somebody else started it. Reported through the
 * toast rather than the title alone so a touch user — who has no hover, and so
 * never sees a title attribute at all — gets the sentence too.
 */
function refusal() {
  if (state.get().locked) {
    return t("This session is already locked — change or remove the PIN in Settings");
  }
  return t("Only the first device in this session can lock it");
}

function render() {
  const btn = $("bLock");
  if (!btn) return;

  const { locked, peers } = state.get();
  const allowed = state.canLock();
  const others = Math.max(0, peers - 1);

  btn.classList.toggle("on", locked);
  btn.setAttribute("aria-disabled", String(!allowed));
  btn.querySelector(".lbl").textContent = locked ? t("Locked") : t("Lock session");

  // The label is the same three words whatever the state, so everything that
  // distinguishes one state from another has to live in the description.
  const title = locked
    ? t("Locked with a PIN. Change or remove it in Settings")
    : allowed
      ? others
        ? (others === 1
            ? t("Add a PIN. This starts a new session — the 1 other device here will be disconnected")
            : t("Add a PIN. This starts a new session — the {n} other devices here will be disconnected", { n: others }))
        : t("Add a PIN that is not in the link. This starts a new session")
      : refusal();

  btn.title = title;
  btn.setAttribute("aria-label", `${locked ? t("Session locked") : t("Lock this session")} — ${title}`);
}
