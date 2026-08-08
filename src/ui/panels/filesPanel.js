/**
 * Panel 2 — files and images. Thumbnails here, bytes over P2P.
 *
 * Two things this panel may not get wrong (docs/ARCHITECTURE.md §5): the
 * transport path is always visible, from the moment the fallback is chosen
 * rather than at the end, because a relay transfer is a different privacy story
 * and the choice cannot be made after the fact; and a failed transfer says why
 * on the tile, since a bar that quietly disappears looks like a slow network.
 *
 * A remote file we have not fetched reads GET, not P2P — the old code claimed
 * P2P before any transfer happened, a promise the corporate network breaks.
 *
 * CANCEL vs REMOVE, which must never be confused. Cancel (×, top-left, only
 * while a transfer runs) stops the transfer and keeps the file. Remove (bin,
 * bottom-right, always) drops it and frees the bytes, telling peers if it was
 * ours — someone else's file is only hidden here, because deleting it off their
 * machine is not ours to do. Hence diagonally opposite, differently shaped, and
 * remove confirms whenever it would also kill a transfer.
 */

import { FILES } from "../../core/config.js";
import { emit, on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";
import * as registry from "../../files/registry.js";
import * as transfer from "../../files/transfer.js";
import { iconFor, formatSize } from "../../files/thumbs.js";
import { canPreview, openPreview } from "../features/preview.js";
import { $, esc, on as bind, setHTML, clear } from "../primitives/dom.js";

const S = registry.STATE;

/** States that mean "something is happening and it can be cancelled". */
const BUSY = new Set([S.REQUESTING, S.WAITING, S.CONNECTING, S.SENDING, S.RECEIVING]);

export function init() {
  const drop = $("drop");

  bind(drop, "click", () => $("picker").click());
  bind("bAdd", "click", e => { e.stopPropagation(); $("picker").click(); });
  // Snapshot before clearing: intake() awaits thumbnails mid-iteration, and
  // resetting the input empties the live FileList under it — picking three
  // files used to add only the first.
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

  // A peer asking for one of our files needs a human, unless autoaccept is on.
  // transfer.js checks the setting; this is only the dialog.
  transfer.setApprover(ask);

  // registry.js may not import files/transfer.js — transfer.js imports IT, and
  // the cycle would point the wrong way — so this module, which already holds
  // both, hands it the one thing it needs: a way to stop a transfer before the
  // file it is streaming disappears. Without this, removing a file mid-transfer
  // leaves the sender looping over bytes that are no longer in the list and the
  // peer waiting out an idle timeout with no explanation.
  registry.setCanceller(transfer.cancel);

  mountClearAll();

  // Enter and Space activate a tile, matching what role="button" promises.
  // Space is preventDefault'd or it scrolls the pane instead.
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
 * Drop one file. Confirms only when it would also kill a transfer: a click on a
 * bin should not need a second click for the ordinary case, but a 5 MB transfer
 * someone is 80% through is not an ordinary case, and the tile does not
 * necessarily make it obvious that it is running.
 *
 * Not called `drop`. init() binds `const drop = $("drop")` for the drop zone,
 * and inside the handlers that live in that scope the element wins the name —
 * silently, at runtime, as "drop is not a function" on the first click.
 */
async function removeFile(id) {
  const file = registry.get(id);
  if (!file) return;

  const busy = BUSY.has(file.state);
  if (busy && !await confirmAction({
    title: "Remove a file that is still transferring?",
    file: file.name,
    warning: file.origin === "local"
      ? "A device is receiving this right now. Removing it cancels the transfer at both ends."
      : "This download is still running. Removing it cancels it and discards what has arrived.",
    confirm: "Remove anyway",
  })) return;

  const name = file.name;
  registry.remove(id);
  emit(EV.TOAST, busy ? `Removed ${name} — transfer cancelled` : `Removed ${name}`);
}

/**
 * Drop everything. Always confirms: one click here can discard a 5 MB file
 * another device is mid-way through receiving, and there is no undo — the
 * registry is memory, so a removed file is only recoverable by adding it again
 * from disk, which the peer that was receiving it cannot do at all.
 */
async function clearAll() {
  const items = registry.all();
  if (!items.length) return emit(EV.TOAST, "There are no files to remove");

  const busy = items.filter(f => BUSY.has(f.state)).length;
  const mine = items.filter(f => f.origin === "local").length;

  const ok = await confirmAction({
    title: `Remove all ${items.length} file${items.length === 1 ? "" : "s"}?`,
    file: null,
    warning: [
      busy ? `${busy} ${busy === 1 ? "transfer is" : "transfers are"} still running and will be cancelled.` : "",
      mine ? `${mine} ${mine === 1 ? "is yours" : "are yours"} — those devices will lose the tile too.` : "",
      "Nothing is deleted from disk. This only empties the session.",
    ].filter(Boolean).join(" "),
    confirm: "Remove all",
  });
  if (!ok) return;

  const n = registry.clear();
  emit(EV.TOAST, `Removed ${n} file${n === 1 ? "" : "s"}`);
}

/**
 * The pane header is in app.html, which this change does not own, so the
 * control is injected. Guarded on its own id so a second init() cannot produce
 * two bins, and inserted before "add" so the destructive one is not the button
 * nearest the edge where a mis-aimed click lands.
 */
function mountClearAll() {
  const head = $("paneFiles")?.querySelector(".paneh");
  if (!head || $("bClearFiles")) return;

  const btn = document.createElement("button");
  btn.className = "ibtn";
  btn.id = "bClearFiles";
  btn.type = "button";
  btn.title = "Remove every file from this session";
  btn.setAttribute("aria-label", "Remove every file from this session");
  setHTML(btn, `<svg viewBox="0 0 24 24" aria-hidden="true">${BIN_PATH}</svg>`);

  // ui/panes.js already ignores clicks on a button inside a pane header, but
  // this must not depend on that staying true: collapsing the pane as a side
  // effect of asking to clear it would hide the confirmation.
  bind(btn, "click", e => { e.stopPropagation(); clearAll(); });
  head.insertBefore(btn, $("bAdd") ?? null);
}

/* ------------------------------------------------------------------ *
 * Tiles
 * ------------------------------------------------------------------ */

/**
 * Everything about a tile EXCEPT its progress number, and the omission is the
 * point: a 5 MB file moves in 32 KB chunks, so rebuilding on progress rebuilt
 * the grid up to 101 times per transfer. Destroying the tile being watched drops
 * keyboard focus mid-transfer, resets the :hover that reveals the remove button,
 * and means `transition:width .2s` on .bar has never once run.
 *
 * A change here means the markup really differs and the grid is rebuilt; a
 * change in progress alone routes to tickProgress().
 */
function shape(f) {
  // Unit separator rather than "": "a" of size 12 and "a1" of size 2 must not
  // collide, or a rename would silently fail to redraw.
  return [f.id, f.state, f.origin, f.path, f.error, f.name, f.size, f.thumb ? 1 : 0]
    .join("\u001f");
}

/**
 * Grid structure currently on screen. null rather than "", so the first render
 * draws even when the session opens with no files. Named for the grid because
 * drawPrompts() keeps a `drawn` of its own, for precisely this reason.
 */
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

  // role/tabindex rather than a <button>: a tile CONTAINS buttons (cancel,
  // remove), and a button inside a button is invalid and unpredictable in
  // assistive tech. Enter/Space are handled below, which a div does not get free.
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
          ? `<div class="sz bad">${esc(f.error || "transfer failed")}</div>`
          : `<div class="sz">${esc(subtitle(f))}</div>`}
      </div>
      <div class="bar${f.path === "relay" ? " viarelay" : ""}"></div>
    </div>`).join(""));

  // Widths go through the CSSOM: a style="" attribute in markup is inline style
  // and the CSP refuses it — every bar rendered at 0 until the next tick.
  tickProgress(items);
}

/**
 * The progress-only path: no element is created, replaced or removed, so focus,
 * :hover and the .bar transition all survive.
 *
 * Deliberately narrow. Only .bar's width, and the badge and subtitle of a tile
 * that is actively moving bytes, quote f.progress — everything else on a tile
 * is fixed by shape(), so writing it here would at best be a no-op. Skipping
 * every other state is not cosmetic either: an errored tile's .sz holds
 * f.error, and subtitle() would overwrite that message with the file size.
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

    // textContent, not setHTML: these are numbers we just formatted, so there
    // is no reason for a second HTML sink to exist in this file.
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
    title="Cancel this transfer" aria-label="Cancel transfer of ${esc(f.name)}">×</button>`;
}

/** VS Code's own bin, matching the one in the history pane header. */
const BIN_PATH = `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/>`;

/**
 * Bottom-right of the thumbnail: diagonally opposite cancel, clear of the
 * badge, and inside the picture rather than the caption so the file name keeps
 * its full width on a 92 px tile. Wording says "remove", never "cancel" or
 * "delete" — it leaves the disk alone and it is not the transfer control.
 */
function removeButton(f) {
  const busy = BUSY.has(f.state);
  const what = f.origin === "local"
    ? "Remove from the session — peers lose the tile too"
    : "Hide this file here — the device that holds it keeps it";
  return `<button class="tremove" type="button" data-remove="${esc(f.id)}"
    title="${esc(busy ? `${what}. Cancels the transfer in progress.` : what)}"
    aria-label="Remove ${esc(f.name)} from the session">
    <svg viewBox="0 0 24 24" aria-hidden="true">${BIN_PATH}</svg>
  </button>`;
}

/** Under the name: normally the size, but the live state while it is moving. */
function subtitle(f) {
  switch (f.state) {
    case S.REQUESTING: return "requesting…";
    case S.WAITING:    return "awaiting approval";
    case S.CONNECTING: return "connecting…";
    case S.SENDING:    return `sending ${f.progress}%`;
    case S.RECEIVING:  return `${f.progress}%`;
    case S.CANCELLED:  return "cancelled";
    default:           return formatSize(f.size);
  }
}

function tooltip(f) {
  const bits = [f.name, formatSize(f.size)];
  if (f.state === S.ERROR) {
    bits.push(`failed: ${f.error}`);
  } else {
    if (f.path === "relay") bits.push("came via the relay, not directly");
    else if (f.path === "p2p") bits.push("direct peer-to-peer transfer");
    if (!f.blob) bits.push("click to request the file");
    else bits.push(canPreview(f) ? "click to preview" : "click to save");
  }
  return bits.join(" · ");
}

/**
 * The badge is the honest label of where this file is and how it got here.
 * Precedence: a failure beats a state, a state beats a path.
 */
function badge(f) {
  if (f.state === S.ERROR) return `<span class="badge err">ERR</span>`;
  if (f.state === S.WAITING) return `<span class="badge busy">ASK</span>`;
  if (f.state === S.REQUESTING || f.state === S.CONNECTING) {
    return `<span class="badge busy">…</span>`;
  }
  if (f.state === S.SENDING || f.state === S.RECEIVING) {
    return `<span class="badge busy">${f.progress}%</span>`;
  }
  if (f.origin === "local") return `<span class="badge local">HERE</span>`;

  // The transport path is never hidden: relay-fallback is a different privacy
  // story from a direct transfer, and the user should see which they got.
  if (f.path === "relay") return `<span class="badge relay">RELAY</span>`;
  if (f.path === "p2p") return `<span class="badge remote">P2P</span>`;
  return `<span class="badge want">GET</span>`;      // not fetched — no path to claim yet
}

/* ------------------------------------------------------------------ *
 * Approval prompt
 *
 * Fires on the machine that HOLDS the file: a peer has asked for bytes and,
 * with autoaccept off, a human decides before they leave the disk. That is the
 * only point in the flow where a decision can still prevent anything — the
 * requesting side already consented by clicking the tile.
 *
 * File requests are authenticated only by session membership (P2P-FILES.md §6),
 * so this dialog is the one thing standing between "someone has the key" and
 * "someone has your files".
 * ------------------------------------------------------------------ */

const prompts = new Map();      // token -> {req, resolve, expires}
let tick = null;
let nextToken = 0;

function ask(req) {
  return new Promise(resolve => {
    const token = `ask${nextToken++}`;
    // Never outlive the requester's own deadline: approving into a peer that
    // has already given up would send 5 MB nowhere.
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

  // "Allow all" is answered before the promise resolves, so any request already
  // queued behind this one from the same device is covered by it too.
  if (always && allowed && transfer.allowPeer(p.req.from)) {
    emit(EV.TOAST, `${p.req.from} can now send and receive without asking, until this tab closes`);
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
      emit(EV.TOAST, `Request for ${p.req.name} expired — nobody answered`);
      settle(token, false);
    }
  }
  // Only the numbers, never the markup. See drawPrompts().
  tickCountdowns();
}

/**
 * Update just the countdown text.
 *
 * Split out because the whole dialog used to be re-rendered on this 500 ms
 * timer, which destroyed and rebuilt every button and then re-focused "Send
 * it". A keyboard user who had tabbed to Deny had focus dragged onto the
 * unsafe answer twice a second — on the one screen in this app where a
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

  // The region is created once and kept. Rebuilding it with the cards already
  // inside would put a live region into the tree pre-populated, which screen
  // readers announce inconsistently — the same reason banners.js fills its
  // region a frame late. Only the cards are ever replaced.
  let region = host.querySelector(".ask.req");
  if (!region) {
    clear(host);
    region = document.createElement("div");
    // Not aria-modal, and no focus grab. This used to be a modal covering the
    // screen, on the reasoning that it is the last point at which anything can
    // stop bytes leaving the disk — true, but it also froze the editor behind
    // it, so an incoming request stopped the app being usable for as long as
    // nobody answered. The safety property does not actually come from being
    // modal: it comes from nothing being sent without a click, and from an
    // unanswered prompt expiring into a denial. Both survive here.
    region.className = "ask req";
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", "File requests");
    region.setAttribute("aria-live", "polite");
    host.appendChild(region);
    host.onclick = onPromptClick;
    document.addEventListener("keydown", onKey);
  }

  setHTML(region, [...prompts].map(([token, { req, expires }]) => `
      <div class="card" data-token="${esc(token)}">
        <div class="t">A device wants one of your files</div>
        <div class="f">${esc(req.name)} <span class="s">${formatSize(req.size)}</span></div>
        <div class="w">
          Device <code>${esc(req.from)}</code> is in this session. Anyone holding
          the share key can ask for any file here.
        </div>
        <div class="acts">
          <span class="cd">${Math.max(0, Math.ceil((expires - Date.now()) / 1000))}s</span>
          <button class="btn ghost" data-deny="${esc(token)}">Deny</button>
          <button class="btn ghost" data-allowall="${esc(token)}"
                  title="Stop asking about this device until this tab closes">Allow all</button>
          <button class="btn" data-allow="${esc(token)}">Send it</button>
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
 * Escape denies — but only while the prompt has focus.
 *
 * It used to be global, which was safe when the prompt was modal and there was
 * nothing else to be doing. Now that the app keeps working underneath it,
 * Escape belongs to whatever the user is actually in: pressing it to dismiss a
 * QR modal, or out of habit while typing, should not quietly answer a question
 * they have not read. Unanswered still ends in a denial — the countdown does
 * that — so nothing leaks by making this narrower.
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
 * Deliberately NOT mounted in #mount-modals: drawPrompts() owns that node's
 * innerHTML outright and rewrites it whenever a request arrives or expires,
 * which would delete a confirmation mid-question — and the two can genuinely
 * overlap, since a peer can ask for a file while its owner is clearing the pane.
 *
 * window.confirm() would have been one line, but it blocks the event loop, so
 * the transfer this dialog is asking about would stall behind it, and it cannot
 * be styled, escaped or read by the same tests as the rest of the pane.
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

    // esc() on the title and the button label as well as the file name: the
    // name is chosen by a peer, and the title quotes counts derived from it.
    setHTML(el, `<div class="card">
      <div class="t">${esc(title)}</div>
      ${file ? `<div class="f">${esc(file)}</div>` : ""}
      <div class="w">${esc(warning)}</div>
      <div class="acts">
        <button class="btn ghost" type="button" data-no>Keep</button>
        <button class="btn bad" type="button" data-yes>${esc(confirm)}</button>
      </div>
    </div>`);

    el.onclick = e => {
      if (e.target.closest("[data-yes]")) return closeConfirm(true);
      // A click on the backdrop is a click away from a destructive question.
      if (e.target.closest("[data-no]") || e.target === el) closeConfirm(false);
    };

    // Capture phase, so Escape settles this and stops there rather than also
    // reaching the approval dialog's own document-level Escape handler.
    const onEsc = e => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(false);
    };
    document.addEventListener("keydown", onEsc, true);

    document.body.appendChild(el);
    pending = { el, resolve, onKey: onEsc };
    // Focus the safe answer, not the destructive one: Enter should not be able
    // to discard twenty files because it was already on its way down.
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
