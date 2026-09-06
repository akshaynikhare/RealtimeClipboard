/**
 * Session and settings, in the status bar.
 *
 * Four slide-up menus hanging off the status-bar items that already reported the
 * same things:
 *
 *   #sbPeers  "2 devices"  roster, split-brain warning, leave
 *   #sbMode   "App only"   the sync ladder, clipboard polling, images
 *   #sbP2P    "P2P idle"   the file settings
 *   #sbGear   (gear)       key strength and pointer sharing
 *
 * A sidebar pane before this, which on a phone was one tab of four — so every
 * setting, and the split-brain warning that means sync has silently stopped, sat
 * behind the editor until someone went looking. The status bar is on screen in
 * every view at every width.
 *
 * The menus render from state on every open, so there is nothing to initialise
 * at boot: no switch exists until the moment it is shown.
 */

import {
  POLL_OPTIONS, SYNC_MODES, THEMES, RELAY_URL, DEFAULT_RELAY_URL, RELAY_IS_CUSTOM,
} from "../../core/config.js";
import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as keys from "../../core/keys.js";
import * as storage from "../../core/storage.js";
import { IS_DESKTOP } from "../../core/native.js";
import * as os from "../../clipboard/os.js";
import * as capture from "../../clipboard/capture.js";
import * as menu from "../primitives/statusMenu.js";
import * as modal from "../primitives/modal.js";
// Two controls for one setting, so both go through the module that owns
// persistence and repainting rather than poking state behind each other's back.
import * as syncMode from "../features/syncMode.js";
import * as theme from "../features/theme.js";
import * as i18n from "../../core/i18n.js";
import { t } from "../../core/i18n.js";
import { $, esc, on as bind, lazyStyle } from "../primitives/dom.js";

/** Set by the relay when the room may have moved replica; shown in the roster. */
let splitBrain = null;

export function init() {
  bind("bNew",  "click", e => { e.stopPropagation(); newKey(); });
  bind("bLink", "click", e => { e.stopPropagation(); copyLink(); });
  bind("sbKey", "click", copyLink);
  bind("bQr",   "click", () => showQr());

  menu.attach("sbPeers", { label: t("Devices"),  render: devicesMenu, onEvent: onMenuEvent });
  menu.attach("sbMode",  { label: t("Sync"),     render: syncMenu,    onEvent: onMenuEvent });
  menu.attach("sbP2P",   { label: t("Files"),    render: filesMenu,   onEvent: onMenuEvent });
  menu.attach("sbGear",  { label: t("Settings"), render: gearMenu,    onEvent: onMenuEvent });

  on(EV.KEY_CHANGED, ({ key }) => renderKey(key));
  // `verified` can flip at any moment — the first frame that decrypts.
  on(EV.LOCK_STATE, () => { renderLock(); menu.refresh(); });
  // Whether this device may lock at all is answered by the relay's welcome, so
  // the Security group has to be able to change its mind after it was drawn.
  on(EV.FOUNDER, () => menu.refresh());
  on(EV.PEERS_CHANGED, ({ count, list }) => renderPeers(count, list));
  on(EV.SYNC_MODE, () => menu.refresh());
  on(EV.INSTANCE_CHANGED, ({ from, to }) => { splitBrain = { from, to }; menu.refresh(); });
  // The tray asks rather than being told the key, so the link is built here,
  // where the session already is.
  on("ui:copy-link", copyLink);

  renderPeers(1, []);
}

/* ------------------------------------------------------------------
   settings
------------------------------------------------------------------- */

/** One handler for all four menus: they are made of the same three controls. */
function onMenuEvent(e, close) {
  const s = state.get().settings;

  const sw = e.target.closest?.(".sw");
  if (sw && e.type === "click") {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(next));
    state.saveSetting(sw.dataset.k, next);

    // Acts on the key already saved: "remember this" that leaves the last one on
    // disk when you turn it off is a promise it is not keeping.
    if (sw.dataset.k === "rememberKey") {
      const { key, locked } = state.get();
      storage.saveLastKey(key, locked, next);
    }
    return menu.refresh();               // key strength and labels follow it
  }

  if (e.target.id === "poll" && e.type === "change") {
    state.saveSetting("poll", e.target.value);
    capture.startPolling();
    return;
  }

  if (e.type !== "click") return;
  const action = e.target.closest?.("[data-act]")?.dataset.act;
  if (!action) return;

  if (action === "mode") {
    syncMode.set(e.target.closest("[data-mode]").dataset.mode, true);
    return menu.refresh();
  }
  if (action === "leave")  { close(); return emit("session:leave"); }
  if (action === "lock")   { close(); return emit("session:lock"); }
  if (action === "unlock") { close(); return emit("session:unlock"); }
  if (action === "repin")  { close(); return emit("session:repin"); }
  if (action === "whatsnew") { close(); return emit("ui:whatsnew"); }
  if (action === "guide")    { close(); return emit("ui:guide"); }
  if (action === "language") {
    // A reload, for the same reason changing the relay reloads: every label in
    // the app was built once, at init, from the catalogue that was in hand.
    state.saveSetting("language", e.target.closest("[data-lang-set]").getAttribute("data-lang-set"));
    location.reload();
    return;
  }

  if (action === "theme") {
    state.saveSetting("theme", e.target.closest("[data-theme-set]").dataset.themeSet);
    return menu.refresh();               // the note under it names what is showing
  }
  if (action === "relay")       { close(); return changeRelay(); }
  if (action === "relay-reset") { close(); return changeRelay(true); }
}

/**
 * The note travels with the payload, so qr.js needs no opinion about sessions
 * and the caption cannot claim the code carries the PIN when it does not.
 */
export function showQr() {
  const { key, locked } = state.get();
  emit("ui:qr", {
    text: keys.shareLink(key, locked),
    note: locked
      ? t("The code carries the key, not the PIN. Whoever scans it still has to be told that separately.")
      : t("The link contains the key. Anyone who scans it can read what you copy."),
  });
}

/* ------------------------------------------------------------------
   menu contents
------------------------------------------------------------------- */

/** A switch row. `data-mi` is the focus anchor across a re-render. */
const swRow = (k, title, note) => `
  <div class="srow">
    <div class="l"><b>${esc(title)}</b><span>${esc(note)}</span></div>
    <button class="sw" role="switch" data-mi="${esc(k)}" data-k="${esc(k)}"
            aria-checked="${state.get().settings[k] ? "true" : "false"}"
            aria-label="${esc(title)}"></button>
  </div>`;

const group = title => `<div class="sgrp">${esc(title)}</div>`;

function devicesMenu() {
  const { peers, settings } = state.get();
  const list = rosterRows();

  return group(t("In this session · {n}", { n: peers }))
    + list
    + (splitBrain ? `
      <div class="swarn" role="alert">
        ${t("Relay instance changed ({from} → {to}). Rooms are per-process, so devices on different replicas cannot see each other. Pin replicas to 1.",
             { from: esc(splitBrain.from), to: esc(splitBrain.to) })}
      </div>` : "")
    // Copy link, Show QR and New key are in the header at every width, so
    // repeating them made the roster a second copy of a visible toolbar.
    // Leaving is the one action with no other home.
    + `<div class="sacts">
         <button class="btn ghost" type="button" data-act="leave" data-mi="leave">${t("Leave session")}</button>
       </div>`
    + (settings.cursors ? "" : `<div class="snote">${t("Pointer sharing is off.")}</div>`);
}

/* A function rather than a literal: an array built at module load would capture
   English before the catalogue arrives. */
const justMe = () => [{ name: t("This device (you)"), mode: "" }];

let roster = null;

function rosterRows() {
  return (roster ?? justMe()).map(p => `
    <div class="srow plain">
      <span class="dot on"></span>
      <div class="l"><b>${esc(p.name || t("An unnamed device"))}</b></div>
      ${p.mode === "p2p"   ? '<span class="pill p2p">P2P</span>'
      : p.mode === "relay" ? `<span class="pill relay">${t("RELAY")}</span>` : ""}
    </div>`).join("");
}

/**
 * The same ladder as the header switch, from the same array. There is no
 * "Receiving" switch: it defaulted on and independent of the mode, so a device
 * set to Manual stopped sending while arriving clips still landed on its system
 * clipboard. Both directions belong to the rung.
 */
function syncMenu() {
  const mode = state.get().settings.syncMode;
  const poll = state.get().settings.poll;

  return group(t("How far sync reaches"))
    + `<div class="sacts seg">
         ${syncMode.RUNGS.map(r => `
           <button class="btn ghost${r.mode === mode ? " on" : ""}" type="button"
                   data-act="mode" data-mode="${esc(r.mode)}" data-mi="${esc(r.mode)}"
                   aria-pressed="${r.mode === mode}">${esc(r.label)}</button>`).join("")}
       </div>
       <div class="snote">${esc(syncMode.noteFor(mode))}</div>`
    + group(t("Clipboard"))
    // Polling substitutes for a clipboard-change event, so it has nothing to do
    // below the rung that reads the clipboard.
    + (mode === SYNC_MODES.LIVE
      ? `<div class="srow">
           <div class="l"><b>${t("Check clipboard every")}</b><span>${t("Only while this window has focus")}</span></div>
           <select id="poll" data-mi="poll" aria-label="${t("Clipboard poll interval")}">
             ${Object.keys(POLL_OPTIONS).map(o =>
               `<option${o === poll ? " selected" : ""}>${esc(o)}</option>`).join("")}
           </select>
         </div>`
      : `<div class="snote">${t("This device is not reading its clipboard.")}</div>`)
    + swRow("images", t("Share copied images"), t("Screenshots you copy appear as previews on your other devices"))
    + (mode === SYNC_MODES.LIVE ? "" :
      `<div class="snote">${t("Below the Clipboard rung nothing is read automatically — but an image you paste or drop in here is still shared.")}</div>`);
}

function filesMenu() {
  return group(t("Files"))
    + swRow("autoaccept", t("Let peers fetch without asking"), t("Otherwise you approve each request"))
    + swRow("thumbs", t("Send previews"), t("Thumbnails travel automatically, before anyone asks"))
    + `<div class="snote">${t("Files move device to device. If that is blocked they go through the relay, encrypted, and the transfer says so.")}</div>`;
}

function gearMenu() {
  return group(t("Security"))
    + swRow("longKeys", t("Longer keys"), keyStrength())
    + swRow("rememberKey", t("Remember this session on this device"),
            t("Off: the key is kept only until this tab closes, and never written to disk"))
    + lockRows()
    + group(t("Presence"))
    + swRow("cursors", t("Show other cursors"), t("See where the other devices are pointing"))
    + (IS_DESKTOP ? desktopRows() : "")
    + group(t("Relay"))
    + relayRows()
    + group(t("Appearance"))
    + themeRows()
    + languageRows()
    + group(t("About"))
    + `<div class="sacts">
         <button class="btn ghost" type="button" data-act="whatsnew" data-mi="whatsnew">${t("What's new")}</button>
       </div>`;
}

/**
 * Only in the installed app, there being no tray to close to otherwise. On by
 * default, because closing to the tray is what an app whose job is to keep
 * watching should do — and a switch rather than a fact, because no way to make X
 * mean X is the most complained-about behaviour in tray applications.
 */
function desktopRows() {
  return group(t("Desktop"))
    + swRow("closeToTray", t("Keep running when I close the window"),
            t("Off: the X button quits, and your clipboard stops being watched"))
    + `<div class="sacts">
         <button class="btn ghost" type="button" data-act="guide" data-mi="guide">${t("How this works")}</button>
       </div>`;
}

/**
 * Here rather than in a config file: the point of a self-hostable relay is that
 * somebody other than the author can choose it, and a setting you have to
 * rebuild the app to change is not a setting.
 *
 * The host is shown rather than the full URL because the scheme is derived and
 * the path is fixed.
 */
function relayRows() {
  const host = RELAY_URL.replace(/^wss?:\/\//, "");
  return `<div class="srow plain">
      <div class="l"><b>${esc(host)}</b><span>${RELAY_IS_CUSTOM
        ? t("Self-hosted. Clipboard contents are encrypted before they are sent, whichever relay carries them.")
        : t("The default relay. It only ever sees a room hash and ciphertext.")}</span></div>
    </div>
    <div class="sacts">
      <button class="btn ghost" type="button" data-act="relay" data-mi="relay">${t("Change relay")}</button>
      ${RELAY_IS_CUSTOM
        ? `<button class="btn ghost" type="button" data-act="relay-reset" data-mi="relay-reset">${t("Use default")}</button>`
        : ""}
    </div>`;
}

/**
 * System, Light, Dark — the same segmented control the sync ladder uses.
 *
 * System is the default and comes first because it is the answer for almost
 * everyone: tokens.css reads `prefers-color-scheme` and needs no help. The other
 * two exist for the case the OS cannot express — chiefly the installed app,
 * where somebody wants it dark on a light desktop.
 *
 * The note says what is actually on screen rather than what was chosen, because
 * under System those are different sentences and only one of them is useful.
 */
function themeRows() {
  const choice = state.get().settings.theme;
  const OPTIONS = [
    [THEMES.SYSTEM, t("System")],
    [THEMES.LIGHT,  t("Light")],
    [THEMES.DARK,   t("Dark")],
  ];

  return `<div class="sacts seg">
      ${OPTIONS.map(([value, label]) => `
        <button class="btn ghost${value === choice ? " on" : ""}" type="button"
                data-act="theme" data-theme-set="${esc(value)}" data-mi="theme-${esc(value)}"
                aria-pressed="${value === choice}">${esc(label)}</button>`).join("")}
    </div>
    <div class="snote">${esc(choice === THEMES.SYSTEM
      ? (theme.resolved() === THEMES.LIGHT
          ? t("Following this device — light right now.")
          : t("Following this device — dark right now."))
      : t("Set here, whatever this device is set to."))}</div>`;
}

/**
 * Language, offered the way the theme is: "" is the absence of a choice, not a
 * fifth language.
 *
 * Only what a catalogue exists for is listed. The app falls back to English
 * string by string, so an untranslated label is not a broken one — but offering
 * a language the app has almost nothing for would promise more than it delivers.
 */
function languageRows() {
  const choice = state.get().settings.language;
  const NAMES = { zh: "中文", pt: "Português", es: "Español", ru: "Русский" };
  const OPTIONS = [["", t("Automatic")], ["en", "English"],
                   ...i18n.SUPPORTED.map(c => [c, NAMES[c]])];

  return `<div class="sacts seg">
      ${OPTIONS.map(([value, label]) => `
        <button class="btn ghost${value === choice ? " on" : ""}" type="button"
                data-act="language" data-lang-set="${esc(value)}" data-mi="lang-${esc(value || "auto")}"
                aria-pressed="${value === choice}">${esc(label)}</button>`).join("")}
    </div>
    <div class="snote">${esc(choice === ""
      ? t("Following this browser — {lang} right now.", { lang: i18n.lang() })
      : t("Set here, whatever this browser asks for."))}</div>`;
}

/**
 * Changing the relay reloads: RELAY_URL is resolved once at module evaluation,
 * with every socket, the room and the failover state built against the old one.
 *
 * This was a `prompt()`, on the reasoning that a dialog ending in a reload need
 * not beat the browser's own. That stopped being true when there was a desktop
 * surface — wry implements no `window.prompt`, so the button did nothing at all
 * in the installed app, silently, and the setting was unreachable there.
 * Nothing in this app may use a native dialog for that reason.
 */
function changeRelay(reset = false) {
  if (reset) {
    storage.saveRelayUrl(null);
    location.reload();
    return;
  }

  const current = RELAY_URL.replace(/^wss?:\/\//, "");
  const fallback = DEFAULT_RELAY_URL.replace(/^wss?:\/\//, "");

  lazyStyle("relay.css");

  const { el } = modal.show({
    className: "relaymodal",
    labelledBy: "relayTitle",
    html: `
      <h2 id="relayTitle">${t("Relay address")}</h2>
      <p>${t("The server that carries encrypted clips between your devices. It only ever sees a room hash and ciphertext.")}</p>
      <p>${t("Leave it blank to use the default, {host}.", { host: `<b>${esc(fallback)}</b>` })}</p>

      <label class="relay-lbl" for="relayUrl">${t("Address")}</label>
      <input id="relayUrl" class="relay-input" type="text" name="realtimeclipboard-relay"
             autocomplete="off" autocapitalize="none" autocorrect="off"
             spellcheck="false" enterkeyhint="go" value="${esc(current)}">

      <div class="relay-row">
        <button class="btn ghost" type="button" data-modal-dismiss>${t("Cancel")}</button>
        <button class="btn" type="button" data-ok>${t("Save and reload")}</button>
      </div>`,
  });

  const input = el.querySelector("#relayUrl");
  input?.focus();
  input?.select();

  const commit = () => {
    const trimmed = (input?.value ?? "").trim();
    if (!trimmed) { storage.saveRelayUrl(null); return void location.reload(); }

    // Bare hosts are what people paste, so assume the secure scheme rather than
    // rejecting them. saveRelayUrl returns null if it is not usable at all.
    const saved = storage.saveRelayUrl(
      /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`);
    if (!saved) return emit(EV.TOAST, t("That is not a usable relay address"));

    modal.close();
    location.reload();
  };

  el.addEventListener("click", e => { if (e.target.closest("[data-ok]")) commit(); });
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
}

/**
 * Buttons rather than a switch. A switch says "instant, local, reversible
 * preference", and this is none of those: the lock is part of the room's name,
 * so turning it on moves you to a different session and leaves every device in
 * the old one behind. The button label gets to say what actually happens.
 */
function lockRows() {
  const { locked, verified, peers } = state.get();

  if (!locked) {
    const allowed = state.canLock();
    const others = Math.max(0, peers - 1);

    return `<div class="srow plain">
        <div class="l"><b>${t("Lock this session")}</b><span>${t("Adds a PIN that is not in the link. Starts a new session — your other devices need the new link and the PIN.")}</span></div>
      </div>
      ${allowed ? `<div class="sacts">
        <button class="btn ghost" type="button" data-act="lock" data-mi="lock">${t("Lock session")}</button>
      </div>` : ""}
      ${allowed
        ? (others ? `<div class="snote">${others === 1
            ? t("The 1 other device here will be disconnected.")
            : t("The {n} other devices here will be disconnected.", { n: others })}</div>` : "")
        // Not a disabled button: the action will never become available here,
        // and a greyed control invites clicking it to find out why. The answer
        // fits in the space the button was taking up.
        : `<div class="snote">${t("Only the first device in a session can lock it. Ask whoever started this one.")}</div>`}`;
  }

  return `<div class="srow plain">
      <div class="l"><b>${verified ? t("Locked") : t("Locked · not yet confirmed")}</b><span>${
        verified
          ? t("Another device in this session has proved it has the same PIN.")
          : t("Nothing has been decrypted here yet, so the PIN is unconfirmed.")
      }</span></div>
    </div>
    <div class="sacts">
      <button class="btn ghost" type="button" data-act="repin" data-mi="repin">${t("Change PIN")}</button>
      <button class="btn ghost" type="button" data-act="unlock" data-mi="unlock">${t("Remove lock")}</button>
    </div>
    <div class="snote">${t("A locked session hides what you copy, not that you are here — the relay still sees a room with devices in it.")}</div>`;
}

/* ------------------------------------------------------------------
   the bits the status bar itself shows
------------------------------------------------------------------- */

function renderKey(key) {
  // Two places since the breadcrumb went: the key in the app header and the
  // status bar's copy-the-link affordance.
  ["key", "sbKeyText"].forEach(id => { const el = $(id); if (el) el.textContent = key; });
  renderLock();
}

/**
 * Three states, not two: "Private" and "Private · unconfirmed" are different
 * claims. A locked session where nothing has decrypted yet may be one whose
 * other devices have not arrived, or a mistyped PIN putting this device alone in
 * a room of its own — and a confident padlock there asserts the one property the
 * feature exists to provide, with no evidence for it.
 */
function renderLock() {
  const el = $("sbLock");
  if (!el) return;

  const { locked, verified } = state.get();
  el.hidden = !locked;
  if (!locked) return;

  el.classList.toggle("unconfirmed", !verified);
  el.textContent = verified ? t("Private") : t("Private · unconfirmed");
  el.title = verified
    ? t("Locked with a PIN, and another device here has proved it has the same one")
    : t("Locked with a PIN. Nothing has decrypted yet, so no other device has been confirmed");
}

function renderPeers(count, list) {
  roster = list.length ? list : justMe();
  const el = $("sbPeers");
  if (el) el.textContent = count === 1 ? t("1 device") : t("{n} devices", { n: count });
  menu.refresh();                        // a device joining while the roster is open
}

/** This module announces the intent; main.js owns the transport teardown. */
function newKey() {
  // Stays locked if it was. "New key" answers "someone has my link", and whoever
  // had the link never had the PIN — dropping the lock here would downgrade a
  // private session while the user was busy securing it.
  emit("session:rotate");
}

/**
 * Numbers, not adjectives: "more secure" is unfalsifiable, "~29 bits" versus
 * "~49 bits" lets someone decide. "Applies to the next key" matters too —
 * flipping this does not re-key the session you are in.
 */
function keyStrength() {
  const n = keys.nextLength();
  return t("{n} characters · ~{bits} bits · applies to the next key",
           { n, bits: Math.round(keys.entropyBits(n)) });
}

async function copyLink() {
  const { key, locked } = state.get();
  const link = keys.shareLink(key, locked);
  if (!await os.write(link)) return;
  // The only moment the app can say what is now on the clipboard. For a locked
  // session the important half is what is NOT in it.
  emit(EV.TOAST, locked
    ? t("Link copied — the PIN is not in it. Send that separately")
    : t("Link copied — it contains the key"));
}
