/**
 * The PIN prompt for locked sessions.
 *
 * `ask()` resolves to the PIN or to null if the user backed out; `notice()`
 * states a fact about the lock and offers one way forward. Everything done with
 * either answer happens in main.js — this module knows nothing about rooms, keys
 * or the relay, and imports nothing that does.
 *
 * A modal, where the file-request prompt next door deliberately is not: that one
 * is docked because an unanswered request from another device must not stop this
 * one being used, whereas here nothing is connected and there is nothing behind
 * it to use. The trap itself is ui/modal.js; this file is only the form.
 *
 * THE PIN NEVER TOUCHES MARKUP. Read from `input.value` at submit, cleared on
 * close, never interpolated, never in an attribute, never on the bus, never
 * logged.
 */

import { LOCK } from "../../core/config.js";
import { pinEntropyBits } from "../../core/keys.js";
import * as modal from "../primitives/modal.js";
import { esc, lazyStyle } from "../primitives/dom.js";

/* Loaded on first use rather than from main.css: the dialog is rare and its
   stylesheet is dead weight on every session that never locks. */
const ensureStyles = () => lazyStyle("lock.css");

const COPY = {
  create: {
    title: "Lock this session",
    intro: "Pick a PIN. It is never in the link and never leaves this device — "
         + "you have to pass it to your other devices yourself.",
    submit: "Lock session",
    confirm: true,
  },
  join: {
    title: "This session is locked",
    intro: "Enter the PIN for this session. The link alone will not open it.",
    submit: "Unlock",
    confirm: false,
  },
  rotate: {
    title: "Confirm the PIN for the new key",
    intro: "A new key means a new session, and the PIN is stretched together "
         + "with the key — so it has to be entered again. The same PIN is fine.",
    submit: "Rotate key",
    confirm: false,
  },
  retry: {
    title: "Enter the PIN again",
    intro: "Nobody else is in this session yet. If someone should be, the PIN "
         + "may not match theirs — a different PIN is a different session.",
    submit: "Unlock",
    confirm: false,
  },
};

/**
 * Ask for a PIN. Resolves to the string, or to null on cancel/Escape.
 *
 * `mode` is create | join | rotate | retry. `key` is shown so someone answering a
 * prompt
 * on a second device can see which session it is for — it is already in their
 * address bar, so this discloses nothing they do not have.
 *
 * `note` is a sentence the caller adds above the field, and it exists for one
 * case: locking a session that other devices are currently in throws them out
 * of it. That consequence belongs on the button that causes it, in the dialog
 * the user is looking at, with the number of devices in it — not in a toast
 * they read afterwards.
 */
export function ask({ mode = "join", key = "", note = "" } = {}) {
  const copy = COPY[mode] ?? COPY.join;
  ensureStyles();

  return new Promise(resolve => {
    const { el } = modal.show({
      className: "lockmodal",
      labelledBy: "lockTitle",
      onClose: resolve,
      html: `
        <h2 id="lockTitle">${esc(copy.title)}</h2>
        <p id="lockIntro">${esc(copy.intro)}</p>
        ${key ? `<p class="lockkey">Session <b>${esc(key)}</b></p>` : ""}
        ${note ? `<p class="lockwarn" role="note">${esc(note)}</p>` : ""}

        <label class="locklbl" for="lockPin">PIN</label>
        <input id="lockPin" class="lockinput" type="password" name="realtimeclipboard-pin"
               autocomplete="off" autocapitalize="none" autocorrect="off"
               spellcheck="false" enterkeyhint="go"
               aria-describedby="lockStrength">
        ${copy.confirm ? `
        <label class="locklbl" for="lockPin2">Repeat it</label>
        <input id="lockPin2" class="lockinput" type="password" name="realtimeclipboard-pin2"
               autocomplete="off" autocapitalize="none" autocorrect="off"
               spellcheck="false" enterkeyhint="go">` : ""}

        <div class="lockstrength" id="lockStrength" aria-live="polite"></div>
        <div class="lockerr" role="alert"></div>

        <div class="lockrow">
          <button class="btn ghost" type="button" data-modal-dismiss>Cancel</button>
          <button class="btn" type="button" data-ok>${esc(copy.submit)}</button>
        </div>

        <p class="locknote">Anyone with the link and the PIN can read this
        session. The PIN is not stored on this device beyond this browser tab.</p>`,
    });

    const pin      = el.querySelector("#lockPin");
    const pin2     = el.querySelector("#lockPin2");
    const strength = el.querySelector(".lockstrength");
    const error    = el.querySelector(".lockerr");

    const say = msg => { error.textContent = msg; };

    /**
     * The number, not an adjective.
     *
     * Mirrors how the key's own strength is stated in ui/sessionPanel.js. It
     * matters more here: against someone who already has the link, the key
     * contributes nothing and this is the whole secret, so "6 characters · ~20
     * bits" is the honest thing to show while a four-digit habit is being typed.
     */
    const rate = () => {
      const v = pin.value;
      if (!v) { strength.textContent = ""; return; }
      const bits = Math.round(pinEntropyBits(v));
      const weak = bits < 40;
      strength.classList.toggle("weak", weak);
      strength.textContent = `${v.length} character${v.length === 1 ? "" : "s"} · ~${bits} bits`
        + (weak ? " · short enough to guess offline if your link gets out" : "");
    };

    const submit = () => {
      const value = pin.value;
      if (value.trim().length < LOCK.MIN_PIN) {
        return say(`At least ${LOCK.MIN_PIN} characters.`);
      }
      if (copy.confirm && value !== pin2.value) {
        return say("The two PINs do not match.");
      }
      modal.close(value);
    };

    el.addEventListener("input", rate);
    el.addEventListener("click", e => {
      if (e.target.closest("[data-ok]")) submit();
    });
    // Enter submits from either field: this is a form in everything but the
    // element, and a <form> here would try to navigate.
    el.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    pin.focus();
  });
}

/**
 * Say something and offer a way forward. No field, no secret.
 *
 * The one caller is the device that has just been removed from a session
 * somebody else locked. It is a modal for the reason the PIN prompt is: by the
 * time this appears the connection is closed and there is no session behind the
 * dialog to go on using, so trapping focus describes the situation rather than
 * imposing anything on it.
 *
 * `body` is an array of paragraphs. Resolves to "action" if the primary button
 * was pressed, and to null for every other way out — dismiss, Escape, backdrop
 * — so a caller can treat "they read it and closed it" as its own answer.
 */
export function notice({ title = "", body = [], dismiss = "Close", action = null } = {}) {
  ensureStyles();

  return new Promise(resolve => {
    const { el } = modal.show({
      className: "lockmodal",
      labelledBy: "lockTitle",
      onClose: resolve,
      html: `
        <h2 id="lockTitle">${esc(title)}</h2>
        ${body.map(p => `<p>${esc(p)}</p>`).join("")}
        <div class="lockrow">
          <button class="btn ghost" type="button" data-modal-dismiss>${esc(dismiss)}</button>
          ${action ? `<button class="btn" type="button" data-ok>${esc(action)}</button>` : ""}
        </div>`,
    });

    el.addEventListener("click", e => {
      if (e.target.closest("[data-ok]")) modal.close("action");
    });
  });
}

export const isOpen = modal.isOpen;
