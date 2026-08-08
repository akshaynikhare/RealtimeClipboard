/**
 * PWA installability and service-worker lifecycle (PRD §3.4, FR-4.1 – FR-4.6).
 *
 * Self-contained by design: it creates its own DOM, links its own stylesheet and
 * manifest, and reaches the rest of the app only through the bus. Nothing else
 * has to change to switch it on — the boundary test in docs/ARCHITECTURE.md §4.
 *
 * Every path goes through core/paths.js. Computing them from `import.meta.url`
 * encoded how deep this file sits in the tree, so bundling moved the app root up
 * a level and pointed the service-worker scope at the wrong place — PRD OI-9,
 * silently, with no error.
 */

import { emit, EV } from "../../core/bus.js";
import { $, esc, setHTML, clear, scriptURL } from "../primitives/dom.js";
import { fromUrl, isValid, fragment } from "../../core/keys.js";
import { loadLastKey, read, write } from "../../core/storage.js";
import { APP_ROOT, atRoot, lazyStyleHref } from "../../core/paths.js";
import { IS_DESKTOP } from "../../core/native.js";

// These three URLs are the reason core/paths.js exists — see above.
const SW_URL = atRoot("sw.js");
const MANIFEST_URL = atRoot("manifest.webmanifest");
const CSS_URL = lazyStyleHref("install.css");

const DISMISSED = "installDismissed";
const DESKTOP_DISMISSED = "desktopDismissed";

let deferredPrompt = null;    // the stashed beforeinstallprompt event
let wantsReload = false;      // the user asked for the update, so reload on swap
let hadController = false;    // was a worker already driving this page at boot?
let started = false;          // init() is idempotent — listeners must not stack

/* ---------------- OI-10: the fragment the install drops ---------------- */

/**
 * A manifest `start_url` cannot carry "#D75LV", so an installed app always
 * launches at the bare scope with no room. FR-4.5: fall back to the last key.
 *
 * Runs at module evaluation rather than from init(), because main.js resolves
 * the key inside boot() and this has to be true first. With no stored key it
 * does nothing and main.js generates one, which is right for a first launch.
 *
 * The fragment written here lives for the length of boot and no longer:
 * openSession() calls keys.clearUrl() as soon as it has read it. resolveKey()
 * also consults loadLastKey() directly, so this is belt-and-braces for the
 * launch ordering rather than the only route — and with `rememberKey` off there
 * is nothing stored to restore, which is what that setting means.
 */
function restoreRoom() {
  if (isValid(fromUrl().key)) return null;        // the URL already names a room

  const last = loadLastKey();
  if (!last || !isValid(last.key)) return null;   // let main.js generate one

  // The lock marker is restored with the key. Dropping it would rebuild the
  // fragment as an UNLOCKED room of the same name — a real room that anyone
  // holding the link can read — so an installed app relaunching would silently
  // move the user out of their private session and into a public one.
  const hash = fragment(last.key, last.locked);
  try {
    // replaceState, not location.hash: no history entry to trap the back
    // button, and no hashchange event fired at a half-booted app.
    history.replaceState(null, "", `#${hash}`);
  } catch {
    location.hash = hash;                         // sandboxed contexts
  }
  return hash;
}

restoreRoom();

/* ---------------- head plumbing ---------------- */

function linkStylesheet() {
  // install.css sets --pwa-css:1, so if styles/main.css already @imports it
  // there is nothing to inject.
  if (document.querySelector("link[data-pwa-css]")) return;
  const marker = getComputedStyle(document.documentElement)
    .getPropertyValue("--pwa-css").trim();
  if (marker === "1") return;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_URL;
  link.dataset.pwaCss = "";
  document.head.appendChild(link);
}

function linkManifest() {
  if (document.querySelector('link[rel="manifest"]')) return;
  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = MANIFEST_URL;
  document.head.appendChild(link);
}

/* ---------------- banners ---------------- */

const ICON = {
  install: '<path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  update: '<path d="M21 12a9 9 0 11-2.6-6.4M21 3v6h-6"/>',
};

function mount() {
  return $("mount-banners") || document.body;
}

/**
 * Build a banner. `message` and `action` are the only interpolated values and
 * both go through esc() — this module never has attacker-controlled text today,
 * but the rule in docs/ARCHITECTURE.md §5 is unconditional.
 */
function banner({ id, kind, icon, message, action, onAction, onClose }) {
  const existing = $(id);
  if (existing) return existing;

  const el = document.createElement("div");
  el.id = id;
  el.className = `pwa ${kind}`;
  el.setAttribute("role", "status");
  setHTML(el, `<svg class="pwa-ico" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` +
    `<span class="pwa-msg">${esc(message)}</span>` +
    `<button class="btn" type="button" data-act>${esc(action)}</button>` +
    `<button class="ibtn pwa-x" type="button" aria-label="Dismiss">` +
    `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`);

  el.querySelector("[data-act]").addEventListener("click", onAction);
  el.querySelector(".pwa-x").addEventListener("click", () => {
    el.remove();
    onClose?.();
  });

  mount().appendChild(el);
  return el;
}

const drop = id => $(id)?.remove();

/* ---------------- the app offer, in the header (FR-4.4) ---------------- */

/**
 * Two offers, one row. These were two stacked banners above the editor, spending
 * two rows of the thing people came here to type in on saying "there is also an
 * app" — twice, in a tinted box that reads like a warning.
 *
 * They are one offer with two destinations, so they share a line, in --dim.
 *
 * It stays until it is answered. A timer was tried and taken out: the row is
 * quiet enough to sit in the header indefinitely, and one that clears itself is
 * one nobody is looking at when it goes — which makes it an offer never made
 * rather than one declined.
 *
 * `message` is only used when an offer is alone; with both live the row has no
 * space for either sentence and the buttons carry the meaning.
 */
const OFFERS = {
  desktop: {
    dismissed: DESKTOP_DISMISSED,
    action: "Desktop app",
    message: "There is a desktop app. It picks up what you copy without you switching here.",
    run: () => {
      write(DESKTOP_DISMISSED, true);        // they have seen it; do not re-ask
      window.open(atRoot("download/"), "_blank", "noopener");
    },
  },
  install: {
    dismissed: DISMISSED,
    action: "Install",
    message: "Install RealtimeClipboard for its own window, icon and offline shell.",
    run: () => promptInstall(),
  },
};

const BOTH = "RealtimeClipboard also runs as an app.";

const live = new Set();

function offer(key) {
  if (live.has(key) || read(OFFERS[key].dismissed, false)) return;
  live.add(key);
  renderOffers();
}

/** `forever` writes the dismissal; without it the offer returns on a later visit. */
function retire(keys, forever) {
  for (const key of keys) {
    live.delete(key);
    if (forever) write(OFFERS[key].dismissed, true);
  }
  renderOffers();
}

function renderOffers() {
  const host = $("mount-notice");
  if (!host) return;

  clear(host);
  if (!live.size) return;

  const keys = [...live];
  const el = document.createElement("div");
  el.className = "topnotice";
  el.setAttribute("role", "status");
  setHTML(el,
    `<svg class="topnotice-ico" viewBox="0 0 24 24" aria-hidden="true">${ICON.install}</svg>` +
    `<span class="topnotice-msg">${esc(keys.length > 1 ? BOTH : OFFERS[keys[0]].message)}</span>` +
    keys.map(key => `<button class="topnotice-act" type="button" data-offer="${esc(key)}">` +
      `${esc(OFFERS[key].action)}</button>`).join("") +
    `<button class="topnotice-x" type="button" aria-label="Dismiss this notice">` +
    `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`);

  for (const btn of el.querySelectorAll("[data-offer]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.offer;
      retire([key]);
      OFFERS[key].run();
    });
  }
  el.querySelector(".topnotice-x").addEventListener("click", () => retire(keys, true));

  host.appendChild(el);
}

/**
 * The standing link under the editor. The offer row above is one-shot — taken
 * or dismissed, it never returns — which left no route back to the download
 * page from inside the app. An anchor, not a button: it leaves the app, so
 * middle-click and "open in new tab" have to work.
 */
function mountGetApp() {
  const host = $("mount-getapp");
  if (!host || IS_DESKTOP) return;
  setHTML(host, `
    <a class="getapp" href="${esc(atRoot("download/"))}"
       target="_blank" rel="noopener noreferrer"
       title="Desktop app, mobile install and CLI">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICON.install}</svg>
      <span>Get the desktop &amp; mobile apps</span>
    </a>`);
}

/** Already running as an installed app? Then there is nothing to offer. */
function installed() {
  return ["standalone", "window-controls-overlay", "fullscreen", "minimal-ui"]
    .some(mode => window.matchMedia?.(`(display-mode: ${mode})`).matches)
    || navigator.standalone === true;      // iOS Safari's non-standard flag
}

function offerInstall() {
  if (installed()) return;
  offer("install");
}

async function promptInstall() {
  const evt = deferredPrompt;
  if (!evt) return;

  deferredPrompt = null;                   // a prompt event is single-use
  try {
    evt.prompt();
    const { outcome } = await evt.userChoice;
    if (outcome !== "accepted") emit(EV.TOAST, "Install dismissed");
  } catch (err) {
    console.warn("[pwa] install prompt failed", err);
    emit(EV.TOAST, "Install is not available here");
  }
}

/* ---------------- service worker (FR-4.2, FR-4.6) ---------------- */

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;

  hadController = !!navigator.serviceWorker.controller;

  let reg;
  try {
    // Relative script URL and relative scope: on Pages this registers
    // /RealtimeClipboard/sw.js scoped to /RealtimeClipboard/, and an absolute "/sw.js" would 404.
    reg = await navigator.serviceWorker.register(scriptURL(SW_URL), { scope: APP_ROOT.href });
  } catch (err) {
    // No offline shell, but the app still works. Not worth a toast.
    console.warn("[pwa] service worker registration failed", err);
    return;
  }

  // A worker parked in `waiting` from a previous visit is an update we never
  // finished applying.
  if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);

  reg.addEventListener("updatefound", () => {
    const incoming = reg.installing;
    if (!incoming) return;
    incoming.addEventListener("statechange", () => {
      // "installed" with a controller already present means this is a second
      // worker, i.e. an update. Without a controller it is the first install
      // and there is nothing to reload for.
      if (incoming.state === "installed" && navigator.serviceWorker.controller) {
        showUpdate(reg);
      }
    });
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (wantsReload) { wantsReload = false; location.reload(); return; }
    // A worker took over without us asking. Harmless on the first visit
    // (clients.claim), an update at any other time.
    if (hadController) showUpdate(reg);
  });
}

function showUpdate(reg) {
  if ($("pwaUpdate")) return;
  emit(EV.TOAST, "Update available · Reload");
  banner({
    id: "pwaUpdate",
    kind: "warn",
    icon: ICON.update,
    message: "A new version of RealtimeClipboard is ready.",
    action: "Reload",
    onAction: () => applyUpdate(reg),
  });
}

/**
 * Non-blocking by contract (FR-4.6): nothing reloads until this is clicked, so
 * an update can never eat what someone is typing into the editor.
 */
function applyUpdate(reg) {
  drop("pwaUpdate");
  wantsReload = true;
  const waiting = reg?.waiting;
  if (waiting) {
    waiting.postMessage({ type: "SKIP_WAITING" });
    // If the swap never lands (worker already active, or the message is lost)
    // reload anyway rather than leaving a dead button.
    setTimeout(() => { if (wantsReload) location.reload(); }, 1500);
  } else {
    location.reload();
  }
}

/* ---------------- init ---------------- */

export function init() {
  restoreRoom();
  linkStylesheet();
  linkManifest();
  mountGetApp();

  if (started) return;        // a second call must not double-register listeners
  started = true;

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();          // suppress Chrome's own mini-infobar
    deferredPrompt = event;
    offerInstall();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    retire(["install"]);
    write(DISMISSED, false);         // a later uninstall should offer it again
    emit(EV.TOAST, "RealtimeClipboard installed");
  });

  // Installing from Chrome's own address-bar affordance never fires our click
  // handler, so watch the display mode too.
  window.matchMedia?.("(display-mode: standalone)")
    .addEventListener?.("change", event => { if (event.matches) retire(["install"]); });

  offerDesktop();
  registerSW();
}

/**
 * Offer the desktop app, from inside the browser version.
 *
 * The best place in the entire product to say this, because of WHEN it is
 * being read. The person looking at this window has just switched to it to
 * make a copy arrive — that switch is the browser's one unavoidable limitation
 * (docs/CLIPBOARD-FLOW.md §5), and it is the exact thing the desktop app
 * removes. Anywhere else, this is an advert; here it is an answer.
 *
 * Three things it must never do:
 *   - appear inside the desktop app itself, which is what IS_DESKTOP rules out;
 *   - appear on a phone, where a native app could not watch the clipboard
 *     either and the claim would simply be false;
 *   - come back after it has been dismissed.
 */
function offerDesktop() {
  if (IS_DESKTOP) return;                              // already the real thing

  // Coarse on purpose: this only decides whether a sentence is true. A pointer
  // that can hover is a mouse, which is a desktop, which is a platform where
  // background capture is actually possible.
  const desktop = window.matchMedia?.("(hover: hover) and (pointer: fine)").matches
    && !/android|iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!desktop) return;

  offer("desktop");
}
