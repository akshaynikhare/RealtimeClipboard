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
  POLL_OPTIONS, SYNC_MODES, RELAY_URL, DEFAULT_RELAY_URL, RELAY_IS_CUSTOM,
} from "../../core/config.js";
import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as keys from "../../core/keys.js";
import * as storage from "../../core/storage.js";
import { IS_DESKTOP } from "../../core/native.js";
import * as os from "../../clipboard/os.js";
import * as capture from "../../clipboard/capture.js";
import * as menu from "../primitives/statusMenu.js";
// Two controls for one setting, so both go through the module that owns
// persistence and repainting rather than poking state behind each other's back.
import * as syncMode from "../features/syncMode.js";
import { $, esc, on as bind } from "../primitives/dom.js";

/** Set by the relay when the room may have moved replica; shown in the roster. */
let splitBrain = null;

export function init() {
  bind("bNew",  "click", e => { e.stopPropagation(); newKey(); });
  bind("bLink", "click", e => { e.stopPropagation(); copyLink(); });
  bind("sbKey", "click", copyLink);
  bind("bQr",   "click", () => showQr());

  menu.attach("sbPeers", { label: "Devices", render: devicesMenu, onEvent: onMenuEvent });
  menu.attach("sbMode",  { label: "Sync",    render: syncMenu,    onEvent: onMenuEvent });
  menu.attach("sbP2P",   { label: "Files",   render: filesMenu,   onEvent: onMenuEvent });
  menu.attach("sbGear",  { label: "Settings", render: gearMenu,   onEvent: onMenuEvent });

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
  if (action === "relay")       { close(); return changeRelay(); }
  if (action === "relay-reset") { close(); return changeRelay(true); }
}

/**
 * The note travels with the payload, so qr.js needs no opinion about sessions
 * and the caption cannot claim the code carries the PIN when it does not.
 */
function showQr() {
  const { key, locked } = state.get();
  emit("ui:qr", {
    text: keys.shareLink(key, locked),
    note: locked
      ? "The code carries the key, not the PIN. Whoever scans it still has to be told that separately."
      : "The link contains the key. Anyone who scans it can read what you copy.",
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

  return group(`In this session · ${peers}`)
    + list
    + (splitBrain ? `
      <div class="swarn" role="alert">
        Relay instance changed (${esc(splitBrain.from)} → ${esc(splitBrain.to)}).
        Rooms are per-process, so devices on different replicas cannot see each
        other. Pin replicas to 1.
      </div>` : "")
    // Copy link, Show QR and New key are in the header at every width, so
    // repeating them made the roster a second copy of a visible toolbar.
    // Leaving is the one action with no other home.
    + `<div class="sacts">
         <button class="btn ghost" type="button" data-act="leave" data-mi="leave">Leave session</button>
       </div>`
    + (settings.cursors ? "" : `<div class="snote">Pointer sharing is off.</div>`);
}

let roster = [{ name: "This device (you)", mode: "" }];

function rosterRows() {
  return roster.map(p => `
    <div class="srow plain">
      <span class="dot on"></span>
      <div class="l"><b>${esc(p.name || "An unnamed device")}</b></div>
      ${p.mode === "p2p"   ? '<span class="pill p2p">P2P</span>'
      : p.mode === "relay" ? '<span class="pill relay">RELAY</span>' : ""}
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

  return group("How far sync reaches")
    + `<div class="sacts seg">
         ${syncMode.RUNGS.map(r => `
           <button class="btn ghost${r.mode === mode ? " on" : ""}" type="button"
                   data-act="mode" data-mode="${esc(r.mode)}" data-mi="${esc(r.mode)}"
                   aria-pressed="${r.mode === mode}">${esc(r.label)}</button>`).join("")}
       </div>
       <div class="snote">${esc(syncMode.noteFor(mode))}</div>`
    + group("Clipboard")
    // Polling substitutes for a clipboard-change event, so it has nothing to do
    // below the rung that reads the clipboard.
    + (mode === SYNC_MODES.LIVE
      ? `<div class="srow">
           <div class="l"><b>Check clipboard every</b><span>Only while this window has focus</span></div>
           <select id="poll" data-mi="poll" aria-label="Clipboard poll interval">
             ${Object.keys(POLL_OPTIONS).map(o =>
               `<option${o === poll ? " selected" : ""}>${esc(o)}</option>`).join("")}
           </select>
         </div>`
      : `<div class="snote">This device is not reading its clipboard.</div>`)
    + swRow("images", "Share copied images", "Screenshots you copy appear as previews on your other devices")
    + (mode === SYNC_MODES.LIVE ? "" :
      `<div class="snote">Below the Clipboard rung nothing is read automatically —
       but an image you paste or drop in here is still shared.</div>`);
}

function filesMenu() {
  return group("Files")
    + swRow("autoaccept", "Let peers fetch without asking", "Otherwise you approve each request")
    + swRow("thumbs", "Send previews", "Thumbnails travel automatically, before anyone asks")
    + `<div class="snote">Files move device to device. If that is blocked they go
        through the relay, encrypted, and the transfer says so.</div>`;
}

function gearMenu() {
  return group("Security")
    + swRow("longKeys", "Longer keys", keyStrength())
    + swRow("rememberKey", "Remember this session on this device",
            "Off: the key is kept only until this tab closes, and never written to disk")
    + lockRows()
    + group("Presence")
    + swRow("cursors", "Show other cursors", "See where the other devices are pointing")
    + (IS_DESKTOP ? desktopRows() : "")
    + group("Relay")
    + relayRows()
    + group("About")
    + `<div class="sacts">
         <button class="btn ghost" type="button" data-act="whatsnew" data-mi="whatsnew">What's new</button>
       </div>`;
}

/**
 * Only in the installed app, there being no tray to close to otherwise. On by
 * default, because closing to the tray is what an app whose job is to keep
 * watching should do — and a switch rather than a fact, because no way to make X
 * mean X is the most complained-about behaviour in tray applications.
 */
function desktopRows() {
  return group("Desktop")
    + swRow("closeToTray", "Keep running when I close the window",
            "Off: the X button quits, and your clipboard stops being watched")
    + `<div class="sacts">
         <button class="btn ghost" type="button" data-act="guide" data-mi="guide">How this works</button>
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
        ? "Self-hosted. Clipboard contents are encrypted before they are sent, "
          + "whichever relay carries them."
        : "The default relay. It only ever sees a room hash and ciphertext."}</span></div>
    </div>
    <div class="sacts">
      <button class="btn ghost" type="button" data-act="relay" data-mi="relay">Change relay</button>
      ${RELAY_IS_CUSTOM
        ? `<button class="btn ghost" type="button" data-act="relay-reset" data-mi="relay-reset">Use default</button>`
        : ""}
    </div>`;
}

/**
 * A prompt() deliberately: this cannot take effect in place, RELAY_URL being
 * resolved once at module evaluation with every socket, the room and the
 * failover state built against the old one. Reloading is the honest
 * implementation, and a modal that ends in one need not beat the browser's.
 */
function changeRelay(reset = false) {
  if (reset) {
    storage.saveRelayUrl(null);
    location.reload();
    return;
  }

  const raw = prompt(
    "Relay address\n\n"
    + "The server that carries encrypted clips between your devices. Leave blank "
    + "to use the default.\n\n"
    + `Default: ${DEFAULT_RELAY_URL.replace(/^wss?:\/\//, "")}`,
    RELAY_URL.replace(/^wss?:\/\//, ""),
  );
  if (raw === null) return;                       // cancelled

  const trimmed = raw.trim();
  if (!trimmed) { storage.saveRelayUrl(null); location.reload(); return; }

  // Bare hosts are what people paste, so assume the secure scheme rather than
  // rejecting them. saveRelayUrl returns null if it is not usable at all.
  const saved = storage.saveRelayUrl(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`);
  if (!saved) { emit(EV.TOAST, "That is not a usable relay address"); return; }
  location.reload();
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
        <div class="l"><b>Lock this session</b><span>Adds a PIN that is not in the
        link. Starts a new session — your other devices need the new link and the
        PIN.</span></div>
      </div>
      ${allowed ? `<div class="sacts">
        <button class="btn ghost" type="button" data-act="lock" data-mi="lock">Lock session</button>
      </div>` : ""}
      ${allowed
        ? (others ? `<div class="snote">The ${others} other device${
            others === 1 ? "" : "s"} here will be disconnected.</div>` : "")
        // Not a disabled button: the action will never become available here,
        // and a greyed control invites clicking it to find out why. The answer
        // fits in the space the button was taking up.
        : `<div class="snote">Only the first device in a session can lock it.
           Ask whoever started this one.</div>`}`;
  }

  return `<div class="srow plain">
      <div class="l"><b>Locked${verified ? "" : " · not yet confirmed"}</b><span>${
        verified
          ? "Another device in this session has proved it has the same PIN."
          : "Nothing has been decrypted here yet, so the PIN is unconfirmed."
      }</span></div>
    </div>
    <div class="sacts">
      <button class="btn ghost" type="button" data-act="repin" data-mi="repin">Change PIN</button>
      <button class="btn ghost" type="button" data-act="unlock" data-mi="unlock">Remove lock</button>
    </div>
    <div class="snote">A locked session hides what you copy, not that you are
    here — the relay still sees a room with devices in it.</div>`;
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
  el.textContent = verified ? "Private" : "Private · unconfirmed";
  el.title = verified
    ? "Locked with a PIN, and another device here has proved it has the same one"
    : "Locked with a PIN. Nothing has decrypted yet, so no other device has been confirmed";
}

function renderPeers(count, list) {
  roster = list.length ? list : [{ name: "This device (you)", mode: "" }];
  const el = $("sbPeers");
  if (el) el.textContent = `${count} device${count === 1 ? "" : "s"}`;
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
  return `${n} characters · ~${Math.round(keys.entropyBits(n))} bits · applies to the next key`;
}

async function copyLink() {
  const { key, locked } = state.get();
  const link = keys.shareLink(key, locked);
  if (!await os.write(link)) return;
  // The only moment the app can say what is now on the clipboard. For a locked
  // session the important half is what is NOT in it.
  emit(EV.TOAST, locked
    ? "Link copied — the PIN is not in it. Send that separately"
    : "Link copied — it contains the key");
}
