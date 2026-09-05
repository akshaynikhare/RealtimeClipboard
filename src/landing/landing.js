/**
 * RealtimeClipboard — landing page behaviour.
 *
 * Three jobs, none of which may block first paint:
 *
 *   1. Put a real, freshly generated key in the hero the moment the page loads,
 *      and keep the primary button pointed at whatever key is on screen.
 *   2. Run the dotted path: a pill that travels from the machine that copied to
 *      the machine that pastes, labelled with what actually happens at each step.
 *   3. Load the globe only when the section it lives in comes near the viewport.
 *
 * Key generation is IMPORTED from the app rather than reimplemented. The
 * alphabet and length are product decisions (PRD FR-1.2, D3) and a second copy
 * of them here is a copy that can drift — a landing page quietly handing out
 * keys from the wrong alphabet is the kind of bug nobody notices for months.
 */

import { generate, parseFragment, fragment, isValid, LENGTHS } from "../core/keys.js";

const byId = id => document.getElementById(id);
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * One unguarded throw during start-up takes out everything after it, and the
 * only symptom is a feature quietly not working. Here that would be a missing
 * SVG API stopping the key generator — the one thing on this page that must run.
 */
function start(name, fn) {
  try { fn(); } catch (err) { console.warn(`[landing] ${name} not started:`, err); }
}

/* ================================================================= the key */

start("key", function key() {
  const input = byId("key");
  const form  = byId("keyForm");
  const regen = byId("regen");
  const status = byId("keyStatus");
  const buttons = [byId("start"), byId("start2")].filter(Boolean);
  if (!input || !form) return;

  /**
   * The buttons are plain anchors and stay plain anchors: their href tracks the
   * field, so middle-click, ⌘-click, "copy link address" and a browser with
   * JavaScript disabled all behave. Only the Enter key needs intercepting.
   */
  /**
   * Someone pasting a whole locked link — ".../app.html#!D75LV" — must arrive at
   * a locked session. normalise() strips the "!" along with the rest of the URL
   * furniture, which would have sent them to the UNLOCKED room of the same name:
   * a real room, readable by anyone holding that link, reached by clicking a
   * link that promised the opposite. So the marker is read before anything is
   * stripped, and carried through to the href.
   */
  const parse = raw => parseFragment(String(raw).split("#").pop());

  const sync = () => {
    const { key: k, locked } = parse(input.value);
    const href = k ? "./app.html#" + fragment(k, locked) : "./app.html";
    for (const b of buttons) b.href = href;
  };

  const fresh = (announce) => {
    // Explicitly the short key, not keys.nextLength(): this page is the web by
    // definition, its visitor is about to type this into another device, and
    // there are no settings here for a length preference to have come from.
    const k = generate(LENGTHS.NORMAL);
    input.value = k;
    sync();
    // The value of an <input> changing is silent to a screen reader, and the
    // key is the one thing on this page you are meant to read out.
    if (announce && status) status.textContent = "New key: " + k.split("").join(" ");
  };

  input.addEventListener("input", sync);
  // Normalise on the way out rather than on every keystroke: rewriting the
  // value mid-word drops the caret to the end on every browser.
  input.addEventListener("change", () => {
    const { key: k, locked } = parse(input.value);
    input.value = k ? fragment(k, locked) : "";
    sync();
  });
  input.addEventListener("focus", () => input.select());

  regen?.addEventListener("click", () => { fresh(true); input.focus(); });

  form.addEventListener("submit", e => {
    e.preventDefault();
    const { key: k, locked } = parse(input.value);
    // The floor lives in keys.isValid(), not in a number here — this had its
    // own copy of it and went on admitting four-character keys after the
    // shared one moved to six.
    if (!isValid(k)) { input.focus(); return; }
    location.href = "./app.html#" + fragment(k, locked);
  });

  fresh(false);
});

/* ========================================================== the dotted path */

/**
 * Two layouts, not one stretched one. `preserveAspectRatio` would squash a
 * 1200-wide path into 44px of height on a phone; instead the geometry itself
 * changes and the path runs top-to-bottom below 620px, which is also the
 * breakpoint where the page drops to a single column.
 */
/**
 * `gap` is how far a caption sits from its node, and it is per-layout because
 * the thing it has to clear is the travelling pill, which is centred on the
 * path. In the wide layout the pill passes a node sideways and only needs the
 * pill's half-height of clearance; in the tall one it stops ON the first and
 * last node, so the caption has to clear the pill's half-WIDTH or the two
 * overlap every time the loop restarts.
 */
const LAYOUTS = {
  wide: {
    gap: 22,
    vb: "0 0 1200 360",
    text:  "M120 180 C 300 180 372 76 600 76 C 828 76 900 180 1080 180",
    files: "M120 204 C 400 350 800 350 1080 204",
    filesLabel: { x: 600, y: 314, place: "below" },   // the low point of that curve
    nodes: [
      { x: 120,  y: 180, kind: "end",   name: "Your laptop",  sub: "copies",           place: "below" },
      { x: 600,  y: 76,  kind: "relay", name: "Relay",        sub: "ciphertext only",  place: "above" },
      { x: 1080, y: 180, kind: "end",   name: "Your desktop", sub: "pastes",           place: "below" },
    ],
  },
  // The viewBox is aspect-locked to the column, so its height IS what this
  // diagram costs a phone: at 420x660 it took 512px of a 390px screen. Every y
  // here is that one scaled by 0.788, which keeps the curve and gives back
  // 108px. `gap` is in PIXELS, not viewBox units, so captions sit the same
  // distance from their node whatever the height.
  tall: {
    gap: 46,
    vb: "0 0 420 520",
    text:  "M92 55 C 92 150 328 158 328 260 C 328 362 92 370 92 465",
    files: "M64 72 C 8 236 8 284 64 448",
    // Under the diagram rather than beside the curve: at 360px there is not
    // enough width for a caption next to the relay's own label without the two
    // colliding.
    filesLabel: { x: 210, y: 508, place: "mid" },
    nodes: [
      { x: 92,  y: 55,  kind: "end",   name: "Your laptop",  sub: "copies",          place: "right" },
      { x: 328, y: 260, kind: "relay", name: "Relay",        sub: "ciphertext only", place: "left"  },
      { x: 92,  y: 465, kind: "end",   name: "Your desktop", sub: "pastes",          place: "right" },
    ],
  },
};

/** What the product is doing at each point along the path, as a fraction of it. */
const STEPS = [
  { at: 0.00, text: "Copying…" },
  { at: 0.13, text: "Encrypting in your browser…" },
  { at: 0.38, text: "Ciphertext through the relay" },
  { at: 0.62, text: "Decrypting on your device…" },
  { at: 0.86, text: "Arriving on your desktop" },
];
const STILL = "Encrypted here, decrypted there";

/**
 * Where the pill parks when motion is turned off.
 *
 * Not the midpoint, which is where it used to sit: on both layouts the middle
 * of the path IS the relay node, so a reduced-motion visitor got the pill
 * permanently parked over "relay · ciphertext only" — the one caption that
 * explains what the middle of the diagram is. A third of the way along is still
 * plainly in transit and covers nothing.
 */
const REST = 0.3;

const TRAVEL_MS = 11000;   // one end to the other
const HOLD_MS   = 1600;    // pause on arrival before it starts again

start("flow", function flow() {
  const stage  = byId("flowStage");
  const svg    = byId("flowSvg");
  const text   = byId("flowText");
  const files  = byId("flowFiles");
  const nodesG = byId("flowNodes");
  const labels = byId("flowLabels");
  const pill   = byId("flowPill");
  const pillText = byId("flowPillText");
  if (!stage || !svg || !text || !files || !nodesG || !labels || !pill || !pillText) return;

  const SVGNS = "http://www.w3.org/2000/svg";
  let layout = null, len = 0, metrics = null, raf = 0, started = 0, onScreen = false;

  const pick = () => (window.innerWidth <= 620 ? LAYOUTS.tall : LAYOUTS.wide);

  /** Path coordinates → pixels inside the stage.
   *  getScreenCTM() and the stage rect are both viewport-relative and read in
   *  the same breath, so their difference survives any amount of scrolling.
   *  Only a resize invalidates it. */
  function measure() {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;                    // display:none, or not laid out yet
    const r = stage.getBoundingClientRect();
    return { ctm, ox: r.left, oy: r.top };
  }

  function toPx(x, y) {
    const p = new DOMPoint(x, y).matrixTransform(metrics.ctm);
    return { x: p.x - metrics.ox, y: p.y - metrics.oy };
  }

  const OFFSETS = {
    below: g => `translate(-50%, ${g}px)`,
    above: g => `translate(-50%, calc(-100% - ${g}px))`,
    right: g => `translate(${g}px, -50%)`,
    left:  g => `translate(calc(-100% - ${g}px), -50%)`,
    mid:   () => "translate(-50%, -50%)",
  };

  function build() {
    layout = pick();
    svg.setAttribute("viewBox", layout.vb);
    text.setAttribute("d", layout.text);
    files.setAttribute("d", layout.files);

    nodesG.textContent = "";
    labels.textContent = "";

    for (const n of layout.nodes) {
      // Squares, like the bullets. The relay is hollow because nothing of yours
      // stays in it.
      const box = document.createElementNS(SVGNS, "rect");
      const s = n.kind === "relay" ? 13 : 11;
      box.setAttribute("x", n.x - s / 2);
      box.setAttribute("y", n.y - s / 2);
      box.setAttribute("width", s);
      box.setAttribute("height", s);
      box.setAttribute("class", "fnode" + (n.kind === "relay" ? " relay" : ""));
      nodesG.appendChild(box);

      const el = document.createElement("div");
      el.className = "flabel";
      const b = document.createElement("b");
      b.textContent = n.name;
      el.appendChild(b);
      el.appendChild(document.createTextNode(n.sub));
      labels.appendChild(el);
      n.el = el;
    }

    // Marked, so the caption can carry the same colour as the curve it names.
    // Two routes drawn in two colours and captioned in one grey leaves the
    // reader matching them by position, which is exactly the work a legend is
    // supposed to save them.
    const fl = document.createElement("div");
    fl.className = "flabel files";
    fl.textContent = "files · straight between machines";
    labels.appendChild(fl);
    layout.filesLabel.el = fl;

    len = text.getTotalLength();
    position();
    // Only reveal the pill once it has somewhere real to be. If the stage is
    // not laid out yet (a background tab on some engines) getScreenCTM() returns
    // null, and an un-transformed pill would sit in the top-left corner. Try
    // once more on the next frame, by which point layout has certainly run.
    if (metrics) stage.dataset.ready = "1";
    else requestAnimationFrame(() => { position(); if (metrics) stage.dataset.ready = "1"; });
  }

  function position() {
    metrics = measure();
    if (!metrics) return;
    pillW = 0;      // the breakpoint changes the pill's font and padding
    for (const n of layout.nodes) {
      const p = toPx(n.x, n.y);
      n.el.style.left = p.x + "px";
      n.el.style.top = p.y + "px";
      n.el.style.transform = OFFSETS[n.place](layout.gap);
    }
    const f = layout.filesLabel;
    const fp = toPx(f.x, f.y);
    f.el.style.left = fp.x + "px";
    f.el.style.top = fp.y + "px";
    f.el.style.transform = OFFSETS[f.place](layout.gap);
    place(reduced.matches ? REST : 0);
  }

  /**
   * Width of the pill as it currently reads.
   *
   * Invalidated when the text changes rather than measured every frame: reading
   * offsetWidth forces a style recalculation, and doing that in the same frame
   * we write a transform is the classic layout thrash. The label changes five
   * times in eleven seconds; the transform changes sixty times a second.
   */
  let pillW = 0;

  function place(t) {
    if (!metrics || !len) return;

    // Label first, so the measurement below is of the string we are about to
    // show and not the one before it.
    let label = STILL;
    if (!reduced.matches) {
      label = STEPS[0].text;
      for (const s of STEPS) if (t >= s.at) label = s.text;
    }
    if (pillText.textContent !== label) { pillText.textContent = label; pillW = 0; }
    if (!pillW) pillW = pill.offsetWidth;

    const p = text.getPointAtLength(len * t);
    const px = toPx(p.x, p.y);

    // The pill is HTML, so unlike the path it can hang outside the stage. On the
    // tall layout the path passes within 90px of the right edge and the pill is
    // wider than that — unclamped it slid off the screen, taking the relay's
    // caption with it. Clamp to the stage, unless the pill is wider than the
    // stage itself, in which case centred is the least-bad answer.
    const stageW = stage.clientWidth;
    const half = pillW / 2;
    const x = pillW + 8 > stageW
      ? stageW / 2
      : Math.min(Math.max(px.x, half + 4), stageW - half - 4);

    pill.style.transform = `translate(${x}px, ${px.y}px) translate(-50%, -50%)`;
  }

  function frame(now) {
    if (!started) started = now;
    const e = (now - started) % (TRAVEL_MS + HOLD_MS);
    place(Math.min(1, e / TRAVEL_MS));
    raf = requestAnimationFrame(frame);
  }

  function run() {
    const want = onScreen && !document.hidden && !reduced.matches;
    if (want && !raf) { started = 0; raf = requestAnimationFrame(frame); }
    if (!want && raf) { cancelAnimationFrame(raf); raf = 0; if (reduced.matches) place(REST); }
  }

  build();

  // Only animate what is on screen. Everything else is a frame budget spent on
  // something nobody is looking at.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(entries => {
      onScreen = entries[0].isIntersecting;
      run();
    }, { rootMargin: "80px" }).observe(stage);
  } else {
    onScreen = true;
    run();
  }

  document.addEventListener("visibilitychange", run);
  reduced.addEventListener?.("change", () => { position(); run(); });

  let resizeTimer = 0;
  let width = window.innerWidth;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // A phone toolbar collapsing changes the height, not the layout. Only a
      // width change can move a line.
      if (window.innerWidth === width && layout === pick()) { position(); return; }
      width = window.innerWidth;
      (layout === pick() ? position : build)();
    }, 150);
  }, { passive: true });
});

/* ================================================================ the globe */

/**
 * Loaded on approach, not on load. It is below the fold, it fetches from a
 * third host, and neither of those belongs in the critical path of the page
 * search engines fetch. If the import fails, the section keeps its static
 * "Sessions worldwide" caption and nothing else notices.
 */
start("globe", function globe() {
  const canvas = byId("globe");
  if (!canvas) return;

  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    import("./globe.js").then(m => m.mount()).catch(() => { /* caption stands */ });
  };

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) { io.disconnect(); load(); }
    }, { rootMargin: "300px" });
    io.observe(canvas);
  } else if ("requestIdleCallback" in window) {
    requestIdleCallback(load, { timeout: 3000 });
  } else {
    setTimeout(load, 1200);
  }
});
