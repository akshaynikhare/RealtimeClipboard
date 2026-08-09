/**
 * "How this works" — the installed app's own guide.
 *
 * Self-contained on purpose: the build excludes src/pages/ from the desktop
 * bundle, so the help pages are not merely unlinked but absent, and a link to
 * /help/install/ would 404 inside the app.
 *
 * A panel rather than a feature because it shows a QR code, and features are
 * peers that may not import each other. Rank 22 may reach down to qr.js and
 * render the symbol INLINE, which also sidesteps modal.js never stacking —
 * emitting "ui:qr" would open its dialog on top of this one, leaving two
 * capture-phase keydown handlers and an Escape that closes both.
 *
 * It opens itself once, on the first launch after installing. A changelog must
 * never interrupt a newcomer, but an app that has just started reading
 * everything you copy is the one case where saying so first is the courtesy.
 */

import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as keys from "../../core/keys.js";
import * as storage from "../../core/storage.js";
import * as device from "../../core/device.js";
import { IS_DESKTOP } from "../../core/native.js";
import { SYNC_MODES, LINKS, SITE } from "../../core/config.js";
import { esc, setHTML, lazyStyle } from "../primitives/dom.js";
import * as modal from "../primitives/modal.js";
import * as os from "../../clipboard/os.js";
import { encode, toSvg } from "../features/qr.js";

const SEEN = "guideSeen";

export function init() {
  if (!IS_DESKTOP) return;

  on("ui:guide", open);

  if (!storage.read(SEEN, false)) {
    storage.write(SEEN, true);
    open();
  }
}

export function open() {
  lazyStyle("desktop.css");

  let stop = () => {};

  const { el } = modal.show({
    className: "guide",
    labelledBy: "guideTitle",
    onClose: () => stop(),
    html: `
      <h2 class="guideh" id="guideTitle">How RealtimeClipboard works</h2>
      <div class="guidebody">
        ${sectionWatching()}
        <section class="guides" data-guide-link></section>
        ${sectionJoined()}
        ${sectionTray()}
        ${sectionClosing()}
        ${sectionPrivate()}
        ${sectionStuck()}
      </div>
      <div class="guiderow">
        <span class="guidefoot">Reopen this any time from the gear menu, or from the tray.</span>
        <button class="btn" type="button" data-modal-dismiss>Done</button>
      </div>`,
  });

  const host = el.querySelector("[data-guide-link]");
  let link = "";

  const render = () => {
    const { key, locked } = state.get();
    link = key ? keys.shareLink(key, locked) : "";
    setHTML(host, sectionLink(key, link));
  };

  render();
  stop = on(EV.KEY_CHANGED, render);

  // Delegated, because render() replaces the button — and the toast reads the
  // lock state at click time for the same reason the link is re-read: both
  // change under an open guide when the session is rotated or locked.
  el.addEventListener("click", async e => {
    if (!e.target.closest("[data-guide-copy]") || !link) return;
    if (await os.write(link)) {
      emit(EV.TOAST, state.get().locked
        ? "Link copied — the PIN is not in it. Send that separately"
        : "Link copied — it contains the key");
    }
  });
}

/* ------------------------------------------------------------------
   sections
------------------------------------------------------------------- */

function sectionWatching() {
  const live = state.get().settings.syncMode === SYNC_MODES.LIVE;
  return `
    <section class="guides">
      <h3>What is happening right now</h3>
      <p>This app is watching your clipboard. Everything you copy — in any
         program, whether or not this window is open — is encrypted
         <b>on this machine</b> and sent to the other devices in your session.
         The relay that carries it only ever sees a room name and ciphertext.</p>
      <p class="guidestate">Sharing is <b>${live ? "on" : "paused"}</b>${live
        ? ""
        : " — nothing leaves this machine until you paste it here"}.
         The <b>Off / App / Clipboard</b> switch at the top of the window
         changes how far sync reaches, and <b>Share what I copy</b> in the tray
         menu does the same thing.</p>
    </section>`;
}

/**
 * The section this whole file exists for, ordered easiest-first: the QR needs
 * no typing at all, the link needs none on the device that matters, and typing
 * the key is the fallback that always works.
 *
 * Re-rendered on every EV.KEY_CHANGED, because on a first launch there is no
 * key to render: boot() deliberately does not await openSession(), and opens
 * this guide while the key derivation is still running. All three ways to link
 * a device were wrong for as long as that took — the key box empty, and the QR
 * encoding a link with no key in it, which scans as "open a new session".
 */
function sectionLink(key, link) {
  if (!key) {
    return `
      <h3>Link another device</h3>
      <p>Opening the session — the QR code, the link and the key appear here in
         a moment.</p>`;
  }

  return `
      <h3>Link another device</h3>

      <div class="guidesteps">
        <div class="guidestep">
          <b>1 · Scan this</b>
          <div class="guideqr">${qrFor(link)}</div>
          <span>Point your phone's camera at it. It opens this session directly —
                nothing to type and nothing to install.</span>
        </div>

        <div class="guidestep">
          <b>2 · Or send yourself the link</b>
          <button class="btn ghost" type="button" data-guide-copy>Copy share link</button>
          <span>Paste it into a message to yourself and open it on the other
                device. Any browser will do.</span>
        </div>

        <div class="guidestep">
          <b>3 · Or type the key</b>
          <code class="guidekey">${esc(grouped(key))}</code>
          <span>Open <b>${esc(SITE.HOST)}</b> on the other device and type
                this in. Case and spaces do not matter.</span>
        </div>
      </div>

      <p class="guidewarn" role="note">Anyone holding this link or key can read
         what you copy while the session is open. It is not a password, and
         there is no "remove a device" — to cut everyone off, press
         <b>New key</b> in the header.</p>`;
}

function sectionJoined() {
  return `
    <section class="guides">
      <h3>Once they join</h3>
      <p>The status bar counts the devices and tells you when a new one arrives.
         That announcement is deliberate: the key is all anyone needs, so a
         device appearing is the only moment you can observe that somebody else
         has it.</p>
      <p>After that, copy on any device and it lands on all of them. Files stay
         on the machine holding them until someone asks for one.</p>
    </section>`;
}

/**
 * Per platform, because the tray genuinely differs. Linux delivers no click
 * events to a tray icon at all — libappindicator offers a menu and nothing
 * else — so telling a Linux user to click it would be telling them to do
 * something that cannot work.
 */
function sectionTray() {
  const platform = device.os();
  const behaviour =
    platform === "macOS"
      ? `<b>Click the icon in your menu bar</b> to open the menu. Everything is
         in there, starting with <b>Open RealtimeClipboard</b>.`
    : platform === "Linux"
      ? `<b>Right-click the tray icon</b> for the menu — that is the whole
         interaction on Linux, where a tray icon receives no clicks of its own.
         Some desktops, GNOME especially, need an extension before a tray icon
         appears at all; if you cannot see one, the window and the keyboard
         shortcut still work.`
      : `<b>Double-click the tray icon</b> to open the window, or
         <b>right-click</b> it for the menu. It lives near the clock — you may
         need to expand the hidden icons to see it.`;

  return `
    <section class="guides">
      <h3>The tray icon</h3>
      <p>${behaviour}</p>
      <p>The menu holds <b>Copy share link</b>, so you can bring in a device
         without opening the window at all.</p>
    </section>`;
}

function sectionClosing() {
  return `
    <section class="guides">
      <h3>Closing, and stopping it</h3>
      <p>The <b>X</b> button leaves the app running so it can keep watching —
         closing the window is not the same as quitting. To actually stop it,
         choose <b>Quit RealtimeClipboard</b> in the tray menu.</p>
      <p>If you would rather X meant quit, turn off <b>Keep running when I close
         the window</b> in Settings.</p>
      <p>Press <b>${esc(shortcut())}</b> from anywhere to show or hide the
         window.</p>
    </section>`;
}

function sectionPrivate() {
  const n = keys.nextLength();
  return `
    <section class="guides">
      <h3>Keeping it private</h3>
      <p><b>Lock session</b> adds a PIN that never travels in the link. It is a
         room change, not a setting: locking starts a new session and
         disconnects the devices already in this one, so link them again
         afterwards and pass the PIN separately.</p>
      <p>This app makes <b>${n}-character keys</b>
         (~${Math.round(keys.entropyBits(n))} bits). The website makes shorter
         ones, because a phone has to type them — an installed app links by QR
         or by a copied link, so it does not pay that cost.</p>
    </section>`;
}

function sectionStuck() {
  return `
    <section class="guides">
      <h3>If nothing arrives</h3>
      <ul class="guidelist">
        <li>Check both devices show the same key.</li>
        <li>Check the switch at the top is on <b>Clipboard</b>. On <b>App</b>
            this device never reads its own clipboard, so nothing you copy is
            shared until you paste it into the window — and on <b>Off</b>
            nothing is shared at all.</li>
        <li>On Linux under Wayland, GNOME provides no way for any application to
            watch the clipboard. Copying still works if you paste into this
            window.</li>
        <li>Still stuck? <a href="${esc(LINKS.NEW_ISSUE)}" target="_blank"
            rel="noopener">Report it</a>.</li>
      </ul>
    </section>`;
}

/* ------------------------------------------------------------------
   helpers
------------------------------------------------------------------- */

/**
 * Grouped in fives so a ten-character key can be read aloud and retyped
 * without losing your place. normalise() strips everything outside [A-Z0-9],
 * so the space is presentation and costs the reader nothing.
 */
const grouped = key =>
  String(key ?? "").length > 6 ? String(key).replace(/(.{5})(?=.)/g, "$1 ") : String(key ?? "");

/** The guide degrades to the other two methods rather than failing to open. */
function qrFor(link) {
  try {
    return toSvg(encode(link), { label: "QR code for this session" });
  } catch {
    return `<span class="guidenoqr">Use the link or the key below.</span>`;
  }
}

const shortcut = () => (device.os() === "macOS" ? "Cmd+Shift+V" : "Ctrl+Shift+V");
