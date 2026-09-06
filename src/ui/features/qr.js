/**
 * QR code for the current room — PRD FR-1.5.
 *
 * Listens "ui:qr" {text, note}; also exported as showQr(text, note).
 *
 * Hand-rolled because a CDN script tag would be a third party sitting on a page
 * whose entire pitch is "the key never leaves your machine". This is the useful
 * subset of ISO/IEC 18004: byte mode, error correction M, versions 1–10 — 213
 * bytes, against a share link of ~50. The layout arithmetic (format bits, zigzag
 * order, mask conditions) follows Project Nayuki's formulation.
 *
 * The symbol is always dark-on-white with a 4-module quiet zone in BOTH themes.
 * Inverting it for dark mode is the classic mistake: scanners look for a dark
 * 1:1:3:1:1 finder ratio against light.
 *
 * Encoding is pure and DOM-free (`encode`, `toSvg` are exported for tests).
 */

import { emit, on, EV } from "../../core/bus.js";
import { $, esc, on as bind, setHTML } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";

/* ════════════════════════════════════════════════════════════ spec tables ══ */

/** Level M, per version: [ecCodewordsPerBlock, g1Blocks, g1DataCw, g2Blocks, g2DataCw] */
const EC_M = {
  1:  [10, 1, 16, 0,  0],
  2:  [16, 1, 28, 0,  0],
  3:  [26, 1, 44, 0,  0],
  4:  [18, 2, 32, 0,  0],
  5:  [24, 2, 43, 0,  0],
  6:  [16, 4, 27, 0,  0],
  7:  [18, 4, 31, 0,  0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** Total codewords (data + EC) per version — a cross-check on EC_M. */
const TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };

/** Alignment-pattern centre coordinates per version (row == column list). */
const ALIGN_POS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const MAX_VERSION = 10;
const EC_FORMAT_BITS = 0b00;      // level M
const MODE_BYTE = 0b0100;

/** Data-mask conditions, ISO/IEC 18004 Table 10. (row, col) — dark where true. */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/* ═══════════════════════════════════════════════════════════════ GF(256) ══ */
/* Reed–Solomon arithmetic over GF(2^8), primitive polynomial x^8+x^4+x^3+x^2+1. */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** Generator polynomial for n EC codewords: ∏(x − α^i), i = 0…n−1. Highest degree first. */
function generatorPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];                        // × x
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);  // × α^i
    }
    g = next;
  }
  return g;                                   // length n+1, g[0] === 1
}

/** Remainder of data·x^n ÷ g(x) — the EC codewords. */
function rsRemainder(data, n) {
  const g = generatorPoly(n);
  const out = new Uint8Array(n);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[n - 1] = 0;
    for (let j = 0; j < n; j++) out[j] ^= gfMul(g[j + 1], factor);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════ encoding ══ */

/** Byte mode: 8-bit character count for versions 1–9, 16-bit for 10–26. */
const countBits = version => (version <= 9 ? 8 : 16);

const dataCodewords = version => {
  const [ec, g1n, g1d, g2n, g2d] = EC_M[version];
  return g1n * g1d + g2n * g2d;
};

function chooseVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (4 + countBits(v) + byteLength * 8 <= dataCodewords(v) * 8) return v;
  }
  return null;
}

function buildCodewords(bytes, version) {
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };

  push(MODE_BYTE, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  push(0, Math.min(4, capacity - bits.length));       // terminator
  while (bits.length % 8) bits.push(0);               // to a byte boundary
  for (let i = 0; bits.length < capacity; i++) push(i % 2 ? 0x11 : 0xec, 8);   // pad codewords

  const data = new Uint8Array(capacity / 8);
  for (let i = 0; i < bits.length; i++) data[i >>> 3] |= bits[i] << (7 - (i & 7));
  return data;
}

/** Split into blocks, add EC to each, then interleave as the spec requires. */
function interleave(data, version) {
  const [ecLen, g1n, g1d, g2n, g2d] = EC_M[version];
  const blocks = [];
  let at = 0;

  for (let i = 0; i < g1n + g2n; i++) {
    const len = i < g1n ? g1d : g2d;
    const slice = data.subarray(at, at + len);
    at += len;
    blocks.push({ data: slice, ec: rsRemainder(slice, ecLen) });
  }

  const out = [];
  const maxData = Math.max(g1d, g2d);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return Uint8Array.from(out);
}

/* ═══════════════════════════════════════════════════════════ symbol build ══ */

const getBit = (value, i) => ((value >>> i) & 1) === 1;

function blank(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

function drawFunctionPatterns(m, fn, version, size) {
  const set = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r][c] = dark;
    fn[r][c] = true;
  };

  // Timing patterns: row 6 and column 6, alternating, dark at even indices.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Finders + separators. dist = Chebyshev distance from the centre; the light
  // ring is dist 2 and the separator is dist 4, giving the 1:1:3:1:1 ratio.
  for (const [cr, cc] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        set(cr + dr, cc + dc, dist !== 2 && dist !== 4);
      }
    }
  }

  // Alignment patterns, skipping the three finder corners.
  const pos = ALIGN_POS[version];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner = (i === 0 && j === 0)
        || (i === 0 && j === pos.length - 1)
        || (i === pos.length - 1 && j === 0);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(pos[i] + dr, pos[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  drawVersionInfo(m, fn, version, size);
  drawFormatInfo(m, fn, size, 0);     // placeholder: reserves the modules
}

/**
 * Format information: 5 data bits (2 EC level + 3 mask) → BCH(15,5) with
 * generator 0x537, then XOR 0x5412 so an all-zero format is not all-light.
 * Written twice so the symbol survives damage to one corner.
 */
function drawFormatInfo(m, fn, size, mask) {
  const bits = formatBits(mask);
  const set = (r, c, dark) => { m[r][c] = dark; fn[r][c] = true; };

  for (let i = 0; i <= 5; i++) set(i, 8, getBit(bits, i));
  set(7, 8, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(8, 7, getBit(bits, 8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, getBit(bits, i));

  for (let i = 0; i < 8; i++) set(8, size - 1 - i, getBit(bits, i));
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, getBit(bits, i));

  set(size - 8, 8, true);            // the "dark module", always set
}

export function formatBits(mask) {
  const data = (EC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Version information, BCH(18,6) with generator 0x1F25. Versions 7+ only. */
function drawVersionInfo(m, fn, version, size) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;

  for (let i = 0; i < 18; i++) {
    const dark = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m[a][b] = dark; fn[a][b] = true;
    m[b][a] = dark; fn[b][a] = true;
  }
}

/** Zigzag placement: column pairs right to left, alternating up and down. */
function drawCodewords(m, fn, codewords, size) {
  let i = 0;
  const total = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                     // column 6 is the timing pattern
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!fn[r][c] && i < total) {
          m[r][c] = getBit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
        // Any remainder bits stay light, which is what the spec wants.
      }
    }
  }
}

function applyMask(m, fn, size, mask) {
  const cond = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fn[r][c] && cond(r, c)) m[r][c] = !m[r][c];
    }
  }
}

/* ─────────────────────────────────────────────────────── mask evaluation ── */

const FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function countFinderLike(line) {
  let n = 0;
  for (let i = 0; i + 11 <= line.length; i++) {
    let a = true, b = true;
    for (let j = 0; j < 11; j++) {
      if (line[i + j] !== FINDER_A[j]) a = false;
      if (line[i + j] !== FINDER_B[j]) b = false;
    }
    if (a) n++;
    if (b) n++;
  }
  return n;
}

/** ISO/IEC 18004 §8.8.2 penalty rules. Lower is better. */
function penalty(m, size) {
  let score = 0;

  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      const line = new Array(size);
      let runColour = -1, runLen = 0;
      for (let j = 0; j < size; j++) {
        const v = (axis === 0 ? m[i][j] : m[j][i]) ? 1 : 0;
        line[j] = v;
        if (v === runColour) {
          runLen++;
          if (runLen === 5) score += 3;            // N1
          else if (runLen > 5) score += 1;
        } else { runColour = v; runLen = 1; }
      }
      score += 40 * countFinderLike(line);         // N3
    }
  }

  for (let r = 0; r < size - 1; r++) {             // N2
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  let dark = 0;                                     // N4
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const total = size * size;
  score += 10 * Math.floor(Math.abs(dark * 20 - total * 10) / total);

  return score;
}

/* ═══════════════════════════════════════════════════════════════ public ══ */

/**
 * Encode `text` as a QR symbol. Byte mode (UTF-8), EC level M, smallest version
 * that fits, best of the eight data masks.
 *
 * @returns {{version:number, size:number, mask:number, modules:boolean[][]}}
 * @throws if the payload exceeds version 10 at level M (213 bytes).
 */
export function encode(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const version = chooseVersion(bytes.length);
  if (!version) {
    throw new RangeError(t("QR payload too long: {bytes} bytes, max {max}",
      { bytes: bytes.length, max: dataCodewords(MAX_VERSION) - 3 }));
  }

  const size = version * 4 + 17;
  const codewords = interleave(buildCodewords(bytes, version), version);

  const m = blank(size);
  const fn = blank(size);
  drawFunctionPatterns(m, fn, version, size);
  drawCodewords(m, fn, codewords, size);

  // Try all eight masks, keep the least-penalised. XOR is its own inverse, so
  // each trial is undone by re-applying it.
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, fn, size, mask);
    drawFormatInfo(m, fn, size, mask);
    const score = penalty(m, size);
    if (score < bestScore) { bestScore = score; best = mask; }
    applyMask(m, fn, size, mask);
  }
  applyMask(m, fn, size, best);
  drawFormatInfo(m, fn, size, best);

  return { version, size, mask: best, modules: m };
}

/**
 * Inline SVG for a symbol. Colours are class-driven so styles/qr.css owns them;
 * the quiet zone is 4 modules, as the spec requires — scanners need it.
 */
export function toSvg(qr, { quiet = 4, label = t("QR code") } = {}) {
  const dim = qr.size + quiet * 2;
  let path = "";
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg class="qrsvg" viewBox="0 0 ${dim} ${dim}" width="100%" height="100%"`
    + ` shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"`
    + ` xmlns="http://www.w3.org/2000/svg">`
    + `<rect class="qr-bg" width="${dim}" height="${dim}"/>`
    + `<path class="qr-fg" d="${path}"/></svg>`;
}

/** Sanity check on the spec tables above; called by the test suite. */
export const _tables = { EC_M, TOTAL_CODEWORDS, ALIGN_POS, MAX_VERSION, dataCodewords, generatorPoly, gfMul, GF_EXP, GF_LOG };

/* ═══════════════════════════════════════════════════════════════ the UI ══ */

let openModal = null;      // { el, restoreFocus, onKeydown, inerted }

export function init() {
  on("ui:qr", ({ text, note } = {}) => showQr(text, note));
}

/**
 * The app shell, which everything except the toast, the modals and the cursor
 * layer lives inside. Made inert while a dialog is open so that a screen
 * reader's virtual cursor cannot wander out of the dialog into the page
 * behind it — aria-modal alone is advisory, and support for it is uneven.
 */
const SHELL = ".vs";

function setShellInert(on) {
  const shell = document.querySelector(SHELL);
  if (!shell) return false;
  // Tested before assigning: `shell.inert = true` would create an own property
  // and make the feature test pass on an engine that does not implement it.
  const supported = "inert" in shell;
  if (on) {
    shell.inert = true;
    // inert is supported everywhere current, but if this is running somewhere
    // it is not, aria-hidden still gets the announcement half right. It is
    // never set on an ancestor of the focused element: the dialog is a sibling
    // of the shell, not a child of it.
    if (!supported) shell.setAttribute("aria-hidden", "true");
  } else {
    shell.inert = false;
    shell.removeAttribute("aria-hidden");
  }
  return true;
}

/** Open the QR modal for `text` (the share link). Safe to call repeatedly. */
/**
 * What the caller says the code discloses. Passed in rather than decided here:
 * a locked session's code carries the key and NOT the PIN, and this module has
 * no business knowing which kind of session it is drawing.
 */
const DEFAULT_NOTE = () => t("The link contains the key. Anyone who scans it can read what you copy.");

export function showQr(text, note = DEFAULT_NOTE()) {
  const payload = String(text ?? "");
  if (!payload) return emit(EV.TOAST, t("Nothing to encode"));

  close();

  let body;
  try {
    // The label is short on purpose. It used to be the whole share link, which
    // a screen reader then read out character by character before the same URL
    // appeared again, verbatim, in .qrlink immediately below.
    body = `<div class="qrframe">${toSvg(encode(payload), { label: t("QR code for this session's share link") })}</div>`;
  } catch (err) {
    // Too long for version 10 — say so rather than rendering a broken symbol.
    body = `<div class="qrfail">${esc(err.message)}</div>`;
  }

  // Deliberately NOT #mount-modals. ui/filesPanel.js owns that hook and drives
  // it with `host.innerHTML = …` on every 500 ms countdown tick, so a file
  // request arriving while this dialog is open would delete it out from under
  // the focus trap — leaving a document-level keydown listener attached to a
  // detached node and focus stranded on nothing. .qrmodal is position:fixed and
  // takes no layout from its parent, so body is an equivalent home.
  // See docs/ACCESSIBILITY.md for the filesPanel.js side of this.
  const host = document.body;
  if (!host) return console.error("[qr] no document.body to mount into");

  const el = document.createElement("div");
  el.className = "qrmodal";
  setHTML(el, `
    <div class="qrback" data-close></div>
    <div class="qrdlg" role="dialog" aria-modal="true" tabindex="-1"
         aria-labelledby="qrTitle" aria-describedby="qrNote">
      <div class="qrhead">
        <span id="qrTitle">${t("Scan to join this session")}</span>
        <span class="spacer"></span>
        <button class="ibtn" type="button" id="qrClose" title="${t("Close")}" aria-label="${t("Close")}" data-close>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="qrbody">
        ${body}
        <div class="qrlink" tabindex="0">${esc(payload)}</div>
        <div class="qrnote" id="qrNote">${esc(note)}</div>
      </div>
    </div>`);

  host.appendChild(el);

  const restoreFocus = document.activeElement;
  const onKeydown = e => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") trapTab(e, el);
  };

  openModal = { el, restoreFocus, onKeydown, inerted: setShellInert(true) };
  document.addEventListener("keydown", onKeydown, true);
  bind(el, "click", e => { if (e.target.closest("[data-close]")) close(); });

  // The dialog itself, not the close button. Focusing Close first announces
  // "Close, button" and nothing else — the title, the warning and the link are
  // all skipped, and the one thing offered is the way out. Landing on the
  // container reads the dialog's name and description first, and Tab then
  // reaches Close as the first stop.
  const dlg = el.querySelector(".qrdlg");
  (dlg ?? $("qrClose"))?.focus?.();
}

export function close() {
  if (!openModal) return;
  const { el, restoreFocus, onKeydown, inerted } = openModal;
  openModal = null;

  document.removeEventListener("keydown", onKeydown, true);
  if (inerted) setShellInert(false);
  el.remove();
  // Focus goes back where it came from — a dialog that drops focus to <body>
  // strands keyboard and screen-reader users at the top of the document.
  // Restored AFTER the shell is made interactive again: focus() on an inert
  // subtree is a no-op, and the failure is silent.
  if (restoreFocus && document.contains(restoreFocus)) restoreFocus.focus?.();
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside the dialog while it is open.
 *
 * Deliberately not filtering on offsetParent: it is null for position:fixed
 * elements, which is exactly what this dialog is, so that test would empty the
 * list in the very case it is meant to serve.
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
  // Without this branch the first Shift+Tab of every open escaped the trap,
  // because the browser looked for the previous focusable BEFORE the dialog
  // and found the app behind it.
  const at = items.indexOf(active);
  if (at === -1) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
