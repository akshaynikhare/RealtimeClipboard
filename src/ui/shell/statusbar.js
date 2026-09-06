/** VS Code style status bar. Reflects state; owns none of it. */

import { on, emit, EV } from "../../core/bus.js";
import { TRANSPORT } from "../../core/config.js";
import * as state from "../../core/state.js";
import * as menu from "../primitives/statusMenu.js";
import { $, esc } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";

/* Read through t() at call time, not built once at module load: the catalogue
   arrives before the UI initialises, but a function keeps that an ordering
   detail rather than a dependency. */
const LABEL = {
  idle:         () => t("Not connected"),
  connecting:   () => t("Connecting…"),
  connected:    () => t("Connected"),
  reconnecting: () => t("Reconnecting"),
  offline:      () => t("Offline"),
};
const DOT = {
  idle: "", connecting: "wait", connected: "on", reconnecting: "wait", offline: "off",
};

export function init() {
  on(EV.CONN_STATE, ({ state, detail }) => {
    const label = LABEL[state]?.() ?? state;
    $("sbConnText").textContent = detail ? `${label} · ${detail}` : label;
    $("sbConn").querySelector(".dot").className = `dot ${DOT[state] || ""}`;
  });

  initTransportPicker();

  on(EV.TIER_CHANGED, ({ tier, note }) => {
    $("sbTier").textContent = note ? `${tier} · ${note}` : tier;
  });

  // You can see everyone else's pointer; nothing was telling you they can see
  // yours. A presence feature that only shows you what you gain, and never
  // what you give up, is the asymmetry worth fixing before the toggle is.
  const showBroadcast = () => {
    const el = $("sbCursor");
    if (!el) return;
    const s = state.get();
    const others = Math.max(0, (s.peers ?? 1) - 1);
    const sharing = s.settings.cursors !== false && others > 0;
    el.hidden = !sharing;
    el.textContent = sharing
      ? (others === 1 ? t("Pointer visible to 1 device")
                      : t("Pointer visible to {n} devices", { n: others }))
      : "";
  };
  on(EV.PEERS_CHANGED, showBroadcast);
  on(EV.SETTINGS_CHANGED, showBroadcast);
  showBroadcast();

  on(EV.TRANSFER_PATH, ({ path }) => {
    $("sbP2P").textContent = path === "relay" ? t("Relay fallback") : t("P2P connected");
  });

  // The label must follow the actual path. Printing "P2P n%" for every tick
  // overwrote the RELAY label mid-transfer, which is exactly the silent
  // fallback FR-7.6 forbids — the user would have watched a relay transfer
  // labelled as direct.
  on(EV.FILE_PROGRESS, ({ percent, path }) => {
    const label = path === "relay" ? "Relay" : "P2P";
    $("sbP2P").textContent = percent >= 100
      ? t("{path} connected", { path: label })
      : `${label} ${percent}%`;
  });
}

/**
 * The status bar already said which transport carried the session; this makes
 * that label the control for it. Two real audiences: someone on a network that
 * only half-works, who needs to pin HTTP rather than watch the client
 * rediscover it every reconnect, and anyone testing the fallback without access
 * to a network that actually blocks WebSockets.
 *
 * The UI never touches the transport itself (docs/ARCHITECTURE.md §3) — it
 * emits, and main.js calls relay.setTransport().
 */

/* Names and hints are read at draw time so the menu is correct whichever
   language loaded, and so a catalogue arriving late cannot leave a stale label
   baked into a module-level array. */
const OPTIONS = [
  { value: "",              name: () => t("Automatic"),     hint: () => t("WebSocket, with HTTP as the fallback") },
  { value: TRANSPORT.WS,    name: () => t("WebSocket"),     hint: () => t("Fastest. Blocked on some corporate networks") },
  { value: TRANSPORT.SSE,   name: () => t("HTTP fallback"), hint: () => t("Server-sent events plus POST. Slower, gets through more") },
];

let picked = "";          // what the user chose; "" is automatic
let live = null;          // what is actually carrying frames right now

function initTransportPicker() {
  menu.attach("sbConn", {
    label: t("Connection transport"),
    render: drawMenu,
    onEvent: (e, close) => {
      const option = e.target.closest?.("[data-transport]");
      if (!option || e.type !== "click") return;
      // The empty string means automatic, so read the attribute rather than
      // trusting dataset to round-trip "" as anything but "".
      emit(EV.TRANSPORT_SELECT, { mode: option.getAttribute("data-transport") || null });
      close();
      $("sbConn")?.focus();
    },
  });

  on(EV.TRANSPORT, ({ mode, forced }) => {
    picked = forced ?? "";
    live = mode;
    menu.refresh();                              // only does anything if it is open
  });
}

function drawMenu() {
  return OPTIONS.map(o => {
    const chosen = o.value === picked;
    // "in use" is a different fact from "chosen": on Automatic the app picks,
    // and the user is entitled to see which one it landed on.
    const inUse = !chosen && !picked && o.value && o.value === live;
    return `<button class="smenuitem" type="button" role="menuitemradio"
               aria-checked="${chosen}" data-mi="${esc(o.value || "auto")}"
               data-transport="${esc(o.value)}">
      <span class="tick">${chosen ? "✓" : ""}</span>
      <span class="tx"><b>${esc(o.name())}</b><span>${esc(o.hint())}</span></span>
      ${inUse ? `<span class="tnow">${esc(t("in use"))}</span>` : ""}
    </button>`;
  }).join("");
}
