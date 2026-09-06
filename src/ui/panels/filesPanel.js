/**
 * Panel 2 — files and images. Thumbnails here, bytes over P2P.
 *
 * Two things this panel may not get wrong (docs/ARCHITECTURE.md §5): the
 * transport path is visible from the moment the fallback is chosen, not at the
 * end, because a relay transfer is a different privacy story; and a failed
 * transfer says why on the tile, since a bar that quietly disappears reads as a
 * slow network. A file not yet fetched reads GET, never P2P — claiming P2P
 * before any transfer is a promise the corporate network breaks.
 *
 * CANCEL vs REMOVE must never be confused. Cancel (×, top-left, only while a
 * transfer runs) stops the transfer and keeps the file. Remove (bin,
 * bottom-right, always) drops it and tells peers if it was ours; someone else's
 * file is only hidden, because deleting it off their machine is not ours to do.
 * Hence diagonally opposite, differently shaped, and remove confirms whenever it
 * would also kill a transfer.
 */

import { FILES } from "../../core/config.js";
import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as registry from "../../files/registry.js";
import * as transfer from "../../files/transfer.js";
import { iconFor, formatSize } from "../../files/thumbs.js";
import { canPreview, openPreview } from "../features/preview.js";
import { $, esc, on as bind, setHTML, clear } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";

const S = registry.STATE;

/** States that mean "something is happening and it can be cancelled". */
const BUSY = new Set([S.REQUESTING, S.WAITING, S.CONNECTING, S.SENDING, S.RECEIVING]);

export function init() {
  const drop = $("drop");

  bind(drop, "click", () => $("picker").click());
  bind("bAdd", "click", e => { e.stopPropagation(); $("picker").click(); });
  // Snapshot first: intake() awaits thumbnails mid-iteration and resetting the
  // input empties the live FileList under it — three files added only the first.
  bind("picker", "change", e => { intake([...e.target.files]); e.target.value = ""; });

  ["dragenter", "dragover"].forEach(ev =>
    bind(drop, ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev =>
    bind(drop, ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  bind(drop, "drop", e => intake(e.dataTransfer.files));

  bind("grid", "click", e => {
    // Both buttons live inside the tile, so both are checked before it.
    const gone = e.target.closest("[data-remove]");
    if (gone) {
      e.stopPropagation();
      removeFile(gone.dataset.remove);
      return;
    }

    const stop = e.target.closest("[data-cancel]");
    if (stop) {
      e.stopPropagation();
      transfer.cancel(stop.dataset.cancel);
      return;
    }

    const tile = e.target.closest(".tile");
    if (!tile) return;
    const file = registry.get(tile.dataset.id);
    if (!file) return;
    if (BUSY.has(file.state)) return;                 // already under way

    // Files we hold preview if the browser can show them, save otherwise;
    // remote ones are fetched on demand.
    if (file.blob) { if (!openPreview(file.id)) registry.save(file.id); }
    else transfer.request(file.id);
  });

  // transfer.js checks autoaccept; this is only the dialog.
  transfer.setApprover(ask);

  // registry.js may not import transfer.js — transfer.js imports IT — so this
  // module, holding both, hands it a way to stop a transfer before the file it
  // is streaming disappears. Without it, removing a file mid-transfer leaves the
  // sender looping over bytes no longer in the list and the peer waiting out an
  // idle timeout with no explanation.
  registry.setCanceller(transfer.cancel);

  mountClearAll();

  // What role="button" promises. Space is preventDefault'd or it scrolls.
  bind("grid", "keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tile = e.target.closest?.(".tile");
    if (!tile || e.target.closest("button")) return;
    e.preventDefault();
    tile.click();
  });

  on(EV.FILES_CHANGED, render);
  render();
}

async function intake(fileList) {
  const { rejected } = await registry.add(fileList, {
    makeThumbs: state.get().settings.thumbs,
  });
  // Report every rejection — a file silently vanishing is worse than a limit.
  rejected.forEach(r => emit(EV.TOAST, `${r.name}: ${r.reason}`));
}

/* ------------------------------------------------------------------ *
 * Removing
 * ------------------------------------------------------------------ */

/**
 * Confirms only when it would also kill a transfer: a bin should not need two
 * clicks for the ordinary case, but a 5 MB transfer someone is 80% through is
 * not ordinary and the tile does not always make it obvious it is running.
 *
 * Not called `drop`: init() binds `const drop = $("drop")`, and inside handlers
 * in that scope the element wins the name — silently, as "drop is not a
 * function" on the first click.
 */
async function removeFile(id) {
  const file = registry.get(id);
  if (!file) return;

  const busy = BUSY.has(file.state);
  if (busy && !await confirmAction({
    title: t("Remove a file that is still transferring?"),
    file: file.name,
    warning: file.origin === "local"
      ? t("A device is receiving this right now. Removing it cancels the transfer at both ends.")
      : t("This download is still running. Removing it cancels it and discards what has arrived."),
    confirm: t("Remove anyway"),
  })) return;

  const name = file.name;
  registry.remove(id);
  emit(EV.TOAST, busy ? t("Removed {name} — transfer cancelled", { name }) : t("Removed {name}", { name }));
}

/**
 * Always confirms: one click can discard a file another device is mid-way
 * through receiving, and there is no undo — the registry is memory, so recovery
 * means adding it from disk again, which the receiving peer cannot do at all.
 */
async function clearAll() {
  const items = registry.all();
  if (!items.length) return emit(EV.TOAST, t("There are no files to remove"));

  const busy = items.filter(f => BUSY.has(f.state)).length;
  const mine = items.filter(f => f.origin === "local").length;

  const ok = await confirmAction({
    title: items.length === 1 ? t("Remove all 1 file?") : t("Remove all {n} files?", { n: items.length }),
    file: null,
    warning: [
      busy ? (busy === 1 ? t("1 transfer is still running and will be cancelled.")
                         : t("{n} transfers are still running and will be cancelled.", { n: busy })) : "",
      mine ? (mine === 1 ? t("1 is yours — those devices will lose the tile too.")
                         : t("{n} are yours — those devices will lose the tile too.", { n: mine })) : "",
      t("Nothing is deleted from disk. This only empties the session."),
    ].filter(Boolean).join(" "),
    confirm: t("Remove all"),
  });
  if (!ok) return;

  const n = registry.clear();
  emit(EV.TOAST, n === 1 ? t("Removed 1 file") : t("Removed {n} files", { n }));
}

/**
 * Injected because the pane header lives in app.html. Guarded on its own id so a
 * second init() cannot produce two bins, and placed before "add" so the
 * destructive one is not nearest the edge where a mis-aimed click lands.
 */
function mountClearAll() {
  const head = $("paneFiles")?.querySelector(".paneh");
  if (!head || $("bClearFiles")) return;

  const btn = document.createElement("button");
  btn.className = "ibtn";
  btn.id = "bClearFiles";
  btn.type = "button";
  btn.title = t("Remove every file from this session");
  btn.setAttribute("aria-label", t("Remove every file from this session"));
  setHTML(btn, `<svg viewBox="0 0 24 24" aria-hidden="true">${BIN_PATH}</svg>`);

  // ui/panes.js already ignores header-button clicks, but this must not depend
  // on that: collapsing the pane would hide the confirmation it just opened.
  bind(btn, "click", e => { e.stopPropagation(); clearAll(); });
  head.insertBefore(btn, $("bAdd") ?? null);
}

/* ------------------------------------------------------------------ *
 * Tiles
 * ------------------------------------------------------------------ */

/**
 * Everything about a tile EXCEPT its progress number, and the omission is the
 * point: rebuilding on progress rebuilt the grid up to 101 times per transfer,
 * dropping keyboard focus, resetting the :hover that reveals the remove button,
 * and meaning `transition:width .2s` on .bar never once ran. A change here
 * rebuilds the grid; a change in progress alone routes to tickProgress().
 */
function shape(f) {
  // Unit separator, or "a" of size 12 and "a1" of size 2 collide and a rename
  // silently fails to redraw.
  return [f.id, f.state, f.origin, f.path, f.error, f.name, f.size, f.thumb ? 1 : 0]
    .join("\u001f");
}

/** null rather than "", so the first render draws an empty session too. */
let drawnGrid = null;

function render() {
  const items = registry.all();
  $("fileN").textContent = items.length;
  $("noFiles").style.display = items.length ? "none" : "block";

  // A "clear all" that clears nothing is a control that can only disappoint.
  const clearBtn = $("bClearFiles");
  if (clearBtn) clearBtn.hidden = items.length === 0;

  const signature = items.map(shape).join("\u001e");
  if (signature === drawnGrid) return tickProgress(items);
  drawnGrid = signature;

  // role/tabindex rather than a <button>: a tile CONTAINS buttons, and a button
  // inside a button is invalid and unpredictable in assistive tech.
  setHTML($("grid"), items.map(f => `
    <div class="tile${tileClass(f)}" data-id="${esc(f.id)}" title="${esc(tooltip(f))}"
         role="button" tabindex="0" aria-label="${esc(tooltip(f))}">
      <div class="thumb">${f.thumb
        ? `<img src="${esc(f.thumb)}" alt="">`
        : `<span>${iconFor(f.name)}</span>`}${removeButton(f)}</div>
      ${badge(f)}
      ${BUSY.has(f.state) ? cancelButton(f) : ""}
      <div class="meta">
        <div class="nm">${esc(f.name)}</div>
        ${f.state === S.ERROR
          ? `<div class="sz bad">${esc(f.error || t("transfer failed"))}</div>`
          : `<div class="sz">${esc(subtitle(f))}</div>`}
      </div>
      <div class="bar${f.path === "relay" ? " viarelay" : ""}"></div>
    </div>`).join(""));

  // Widths go through the CSSOM: a style="" attribute in markup is inline style
  // and the CSP refuses it — every bar rendered at 0 until the next tick.
  tickProgress(items);
}

/**
 * No element is created, replaced or removed, so focus, :hover and the .bar
 * transition survive. Deliberately narrow: everything else on a tile is fixed by
 * shape(), and skipping the other states is not cosmetic — an errored tile's
 * .sz holds f.error, which subtitle() would overwrite with the file size.
 */
function tickProgress(items) {
  const grid = $("grid");
  if (!grid) return;

  for (const f of items) {
    const tile = grid.querySelector(`.tile[data-id="${CSS.escape(f.id)}"]`);
    if (!tile) continue;

    const bar = tile.querySelector(".bar");
    if (bar) bar.style.width = `${f.progress}%`;

    if (f.state !== S.SENDING && f.state !== S.RECEIVING) continue;

    // textContent: no reason for a second HTML sink in this file.
    const badgeEl = tile.querySelector(".badge");
    if (badgeEl) badgeEl.textContent = `${f.progress}%`;

    const sz = tile.querySelector(".sz");
    if (sz) sz.textContent = subtitle(f);
  }
}

function tileClass(f) {
  if (f.state === S.ERROR) return " err";
  if (BUSY.has(f.state)) return " busy";
  return "";
}

function cancelButton(f) {
  return `<button class="tcancel" data-cancel="${esc(f.id)}"
    title="${esc(t("Cancel this transfer"))}"
    aria-label="${esc(t("Cancel transfer of {name}", { name: f.name }))}">×</button>`;
}

/** VS Code's own bin, matching the one in the history pane header. */
const BIN_PATH = `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/>`;

/**
 * Diagonally opposite cancel, clear of the badge, inside the picture so the name
 * keeps its full width on a 92 px tile. It says "remove", never "cancel" or
 * "delete": it leaves the disk alone and it is not the transfer control.
 */
function removeButton(f) {
  const busy = BUSY.has(f.state);
  const what = f.origin === "local"
    ? t("Remove from the session — peers lose the tile too")
    : t("Hide this file here — the device that holds it keeps it");
  return `<button class="tremove" type="button" data-remove="${esc(f.id)}"
    title="${esc(busy ? t("{what}. Cancels the transfer in progress.", { what }) : what)}"
    aria-label="${esc(t("Remove {name} from the session", { name: f.name }))}">
    <svg viewBox="0 0 24 24" aria-hidden="true">${BIN_PATH}</svg>
  </button>`;
}

/** Under the name: normally the size, but the live state while it is moving. */
function subtitle(f) {
  switch (f.state) {
    case S.REQUESTING: return t("requesting…");
    case S.WAITING:    return t("awaiting approval");
    case S.CONNECTING: return t("connecting…");
    case S.SENDING:    return t("sending {n}%", { n: f.progress });
    case S.RECEIVING:  return `${f.progress}%`;
    case S.CANCELLED:  return t("cancelled");
    default:           return formatSize(f.size);
  }
}

function tooltip(f) {
  const bits = [f.name, formatSize(f.size)];
  if (f.state === S.ERROR) {
    bits.push(t("failed: {error}", { error: f.error }));
  } else {
    if (f.path === "relay") bits.push(t("came via the relay, not directly"));
    else if (f.path === "p2p") bits.push(t("direct peer-to-peer transfer"));
    if (!f.blob) bits.push(t("click to request the file"));
    else bits.push(canPreview(f) ? t("click to preview") : t("click to save"));
  }
  return bits.join(" · ");
}

/**
 * The badge is the honest label of where this file is and how it got here.
 * Precedence: a failure beats a state, a state beats a path.
 */
function badge(f) {
  if (f.state === S.ERROR) return `<span class="badge err">${esc(t("ERR"))}</span>`;
  if (f.state === S.WAITING) return `<span class="badge busy">${esc(t("ASK"))}</span>`;
  if (f.state === S.REQUESTING || f.state === S.CONNECTING) {
    return `<span class="badge busy">…</span>`;
  }
  if (f.state === S.SENDING || f.state === S.RECEIVING) {
    return `<span class="badge busy">${f.progress}%</span>`;
  }
  if (f.origin === "local") return `<span class="badge local">${esc(t("HERE"))}</span>`;

  if (f.path === "relay") return `<span class="badge relay">${esc(t("RELAY"))}</span>`;
  if (f.path === "p2p") return `<span class="badge remote">P2P</span>`;
  return `<span class="badge want">${esc(t("GET"))}</span>`;   // not fetched — no path to claim yet
}

/* ------------------------------------------------------------------ *
 * Approval prompt
 *
 * Fires on the machine that HOLDS the file — the only point where a decision can
 * still prevent anything, the requesting side having consented by clicking.
 * Requests are authenticated only by session membership (P2P-FILES.md §6), so
 * this dialog is what stands between "someone has the key" and "someone has your
 * files".
 * ------------------------------------------------------------------ */

const prompts = new Map();      // token -> {req, resolve, expires}
let tick = null;
let nextToken = 0;

function ask(req) {
  return new Promise(resolve => {
    const token = `ask${nextToken++}`;
    // Never outlive the requester's deadline: approving into a peer that gave up
    // sends 5 MB nowhere.
    const expires = Date.now() + transfer.requestTimeoutMs();
    prompts.set(token, { req, resolve, expires });
    drawPrompts();
    if (!tick) tick = setInterval(sweep, 500);
  });
}

function settle(token, allowed, always = false) {
  const p = prompts.get(token);
  if (!p) return;
  prompts.delete(token);

  // Answered before the promise resolves, so requests already queued behind this
  // one from the same device are covered too.
  if (always && allowed && transfer.allowPeer(p.req.from)) {
    emit(EV.TOAST, t("{device} can now send and receive without asking, until this tab closes",
                     { device: p.req.from }));
    for (const [other, q] of [...prompts]) {
      if (q.req.from === p.req.from) settle(other, true);
    }
  }

  p.resolve(allowed);
  drawPrompts();
  if (!prompts.size && tick) { clearInterval(tick); tick = null; }
}

/** Expire prompts nobody answered, and keep the countdown honest. */
function sweep() {
  const now = Date.now();
  for (const [token, p] of [...prompts]) {
    if (p.expires <= now) {
      emit(EV.TOAST, t("Request for {name} expired — nobody answered", { name: p.req.name }));
      settle(token, false);
    }
  }
  // Only the numbers, never the markup. See drawPrompts().
  tickCountdowns();
}

/**
 * Split out because re-rendering the dialog on this 500 ms timer rebuilt every
 * button and re-focused "Send it": a keyboard user who had tabbed to Deny had
 * focus dragged onto the unsafe answer twice a second, on the one screen where a
 * decision actually stops data leaving the machine.
 */
function tickCountdowns() {
  const host = $("mount-modals");
  if (!host) return;
  for (const [token, { expires }] of prompts) {
    const cd = host.querySelector(`[data-token="${CSS.escape(token)}"] .cd`);
    if (cd) cd.textContent = `${Math.max(0, Math.ceil((expires - Date.now()) / 1000))}s`;
  }
}

/** Tokens currently on screen, so we only rebuild when the set really changes. */
let drawn = "";

function drawPrompts() {
  const host = $("mount-modals");
  if (!host) return;

  const signature = [...prompts.keys()].join("|");
  if (signature === drawn) return tickCountdowns();
  drawn = signature;

  if (!prompts.size) {
    clear(host);
    document.removeEventListener("keydown", onKey);
    return;
  }

  // Created once and kept: a live region entering the tree already populated is
  // announced inconsistently, the same reason banners.js fills its region a
  // frame late. Only the cards are replaced.
  let region = host.querySelector(".ask.req");
  if (!region) {
    clear(host);
    region = document.createElement("div");
    // Not aria-modal, and no focus grab. As a modal it froze the editor behind
    // it, so an incoming request made the app unusable until someone answered.
    // The safety does not come from being modal: it comes from nothing being
    // sent without a click and an unanswered prompt expiring into a denial.
    region.className = "ask req";
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", t("File requests"));
    region.setAttribute("aria-live", "polite");
    host.appendChild(region);
    host.onclick = onPromptClick;
    document.addEventListener("keydown", onKey);
  }

  // The device sentence is the one t() result not passed through esc(): the
  // <code> wrapper has to survive, so the escaping moves inside the placeholder
  // and only req.from — the peer-chosen half — is escaped.
  setHTML(region, [...prompts].map(([token, { req, expires }]) => `
      <div class="card" data-token="${esc(token)}">
        <div class="t">${esc(t("A device wants one of your files"))}</div>
        <div class="f">${esc(req.name)} <span class="s">${formatSize(req.size)}</span></div>
        <div class="w">
          ${t("Device {device} is in this session. Anyone holding the share key can ask for any file here.",
              { device: `<code>${esc(req.from)}</code>` })}
        </div>
        <div class="acts">
          <span class="cd">${Math.max(0, Math.ceil((expires - Date.now()) / 1000))}s</span>
          <button class="btn ghost" data-deny="${esc(token)}">${esc(t("Deny"))}</button>
          <button class="btn ghost" data-allowall="${esc(token)}"
                  title="${esc(t("Stop asking about this device until this tab closes"))}">${esc(t("Allow all"))}</button>
          <button class="btn" data-allow="${esc(token)}">${esc(t("Send it"))}</button>
        </div>
      </div>`).join(""));
}

function onPromptClick(e) {
  const allow = e.target.closest("[data-allow]");
  if (allow) return settle(allow.dataset.allow, true);
  const always = e.target.closest("[data-allowall]");
  if (always) return settle(always.dataset.allowall, true, true);
  const deny = e.target.closest("[data-deny]");
  if (deny) return settle(deny.dataset.deny, false);
}

/**
 * Escape denies, but only while the prompt has focus. Global was safe when the
 * prompt was modal; now that the app keeps working underneath, dismissing a QR
 * modal or hitting Escape out of habit must not answer a question nobody read.
 * Unanswered still ends in a denial, so narrowing this leaks nothing.
 */
function onKey(e) {
  if (e.key !== "Escape" || !prompts.size) return;
  const host = $("mount-modals");
  if (!host?.contains(document.activeElement)) return;
  e.preventDefault();
  settle([...prompts.keys()].pop(), false);
}

/* ------------------------------------------------------------------ *
 * Confirmation
 *
 * NOT mounted in #mount-modals: drawPrompts() rewrites that node whenever a
 * request arrives or expires, which would delete a confirmation mid-question —
 * and the two overlap, since a peer can ask for a file while its owner clears
 * the pane. window.confirm() blocks the event loop, so the transfer being asked
 * about would stall behind it.
 * ------------------------------------------------------------------ */

let pending = null;              // {el, resolve, onKey} — at most one at a time

function confirmAction({ title, file, warning, confirm }) {
  closeConfirm(false);           // never stack two questions

  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "ask confirm";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);

    // esc() on the title and button label too: the name is peer-chosen and the
    // title quotes counts derived from it.
    setHTML(el, `<div class="card">
      <div class="t">${esc(title)}</div>
      ${file ? `<div class="f">${esc(file)}</div>` : ""}
      <div class="w">${esc(warning)}</div>
      <div class="acts">
        <button class="btn ghost" type="button" data-no>${esc(t("Keep"))}</button>
        <button class="btn bad" type="button" data-yes>${esc(confirm)}</button>
      </div>
    </div>`);

    el.onclick = e => {
      if (e.target.closest("[data-yes]")) return closeConfirm(true);
      // A click on the backdrop is a click away from a destructive question.
      if (e.target.closest("[data-no]") || e.target === el) closeConfirm(false);
    };

    // Capture phase, so Escape stops here rather than also reaching the approval
    // dialog's own document-level handler.
    const onEsc = e => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(false);
    };
    document.addEventListener("keydown", onEsc, true);

    document.body.appendChild(el);
    pending = { el, resolve, onKey: onEsc };
    // The safe answer: Enter must not discard twenty files because it was
    // already on its way down.
    el.querySelector("[data-no]")?.focus?.();
  });
}

function closeConfirm(answer) {
  if (!pending) return;
  const { el, resolve, onKey: onEsc } = pending;
  pending = null;
  document.removeEventListener("keydown", onEsc, true);
  el.remove();
  resolve(answer);
}

export const maxBytes = FILES.MAX_BYTES;
