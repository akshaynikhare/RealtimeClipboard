/**
 * Google AdSense, for the web surface only.
 *
 * Lazily imported by ui/features/ads.js once `adNetwork()` has said "adsense"
 * and the share key has left the URL. Nothing else may import this file — the
 * desktop shell and the VS Code extension are software applications, where
 * Google's programme policies forbid ads outright, and the build stubs this
 * module out of those bundles so the identifiers below cannot even ship.
 * docs/decisions/0001.
 *
 * This is the ONLY module in the app that names an AdSense identifier;
 * src/landing/tags.js is the crawlable pages' copy. The two cannot share code —
 * core/ is the only directory both may import and it may not touch the DOM — so
 * the IDs and script URLs come from core/config.js.
 */

import { AD, GOOGLE, GOOGLE_SRC } from "../../core/config.js";
import { $, scriptURL } from "../primitives/dom.js";

/**
 * adsbygoogle "fits" a responsive unit by stamping `height:auto !important`
 * INLINE on every ancestor of its <ins> — the 100vh shell included, which
 * collapses the app to content height. It happens even for an unfilled ad, and
 * CSS cannot answer it: pin the shell with min-height and the next stamp is an
 * inline `min-height:0 !important` beside it, which outranks every stylesheet.
 * So the shell is watched and wiped instead. Stripping re-fires the observer
 * once with nothing left to strip, so this settles rather than loops.
 */
function guardShell() {
  const shell = $("shell");
  if (!shell || typeof MutationObserver === "undefined") return;
  const strip = () => {
    for (const p of ["height", "min-height", "max-height"])
      if (shell.style.getPropertyValue(p)) shell.style.removeProperty(p);
  };
  new MutationObserver(strip).observe(shell, { attributes: true, attributeFilter: ["style"] });
  strip();
}

/**
 * Reveal "Privacy & cookie settings" in the app footer.
 *
 * Withdrawing consent has to be as easy as giving it, and Google's CMP renders
 * no control of its own once dismissed. landing/tags.js does the same job for
 * the crawlable pages and builds its anchor in JS because it serves twenty
 * documents; this is one document, so the anchor is markup in app.html and only
 * the wiring is here.
 *
 * Hidden until the CMP reports in: outside the EEA there is no dialog to
 * reopen, and the CMP arrives with the ad script — which is exactly the moment
 * this module is imported, so a locked session never shows a dead link.
 */
function consentLink() {
  const a = $("consentPrefs");
  if (!a) return;

  a.addEventListener("click", e => {
    e.preventDefault();
    window.googlefc?.showRevocationMessage?.();
  });

  const fc = (window.googlefc = window.googlefc || {});
  (fc.callbackQueue = fc.callbackQueue || []).push({
    CONSENT_DATA_READY: () => { a.hidden = false; },
  });
}

/**
 * `data-ad-status` is the only signal AdSense gives for an empty response: it
 * lands on the <ins> as "unfilled" once the auction returns nothing. Watching
 * it is what lets the slot collapse instead of holding 90px for a session.
 */
function watchFill(ins, settle) {
  if (typeof MutationObserver === "undefined") return;
  const read = () => {
    const status = ins.getAttribute("data-ad-status");
    if (status === "unfilled") return settle(false), true;
    if (status !== "filled") return false;

    // "filled" is the auction's answer, not the page's. An account still in
    // review — or one serving a blank creative — sets it and paints nothing,
    // and the slot then held its reserved height for the whole session because
    // the timeout below had already been cancelled by this very attribute.
    // Believe the rendered height instead, and only after giving it time.
    setTimeout(() => {
      // The IFRAME, not the <ins>: a narrow unit is requested at a fixed size
      // and carries that height inline whether or not anything arrived, so
      // measuring the <ins> would report every empty phone slot as rendered.
      // AdSense paints into an iframe or it has not painted.
      const frame = ins.querySelector("iframe");
      const h = frame ? frame.getBoundingClientRect().height : 0;
      settle(h >= AD.MIN_RENDERED_PX);
    }, AD.RENDER_GRACE_MS);
    return true;
  };
  const mo = new MutationObserver(() => { if (read()) mo.disconnect(); });
  mo.observe(ins, { attributes: true, attributeFilter: ["data-ad-status"] });
  if (read()) mo.disconnect();
}

export function mount({ box, unit, isNarrow, settle }) {
  if (!box || !GOOGLE.ADSENSE_SLOTS.APP) return settle(false);

  guardShell();
  consentLink();

  const s = document.createElement("script");
  s.async = true;
  s.crossOrigin = "anonymous";
  s.src = scriptURL(GOOGLE_SRC.adsense(GOOGLE.ADSENSE_CLIENT));
  s.onerror = () => settle(false);     // blocked by an extension, or offline
  document.head.append(s);

  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.setAttribute("data-ad-client", GOOGLE.ADSENSE_CLIENT);
  ins.setAttribute("data-ad-slot", GOOGLE.ADSENSE_SLOTS.APP);

  if (isNarrow()) {
    // A fixed unit, so what arrives is the size the box already reserved. Left
    // responsive, adsbygoogle read the full width of a phone and served a
    // ~300px creative into a ~90px hole — and since the slot cannot shrink and
    // the editor can, the textarea was squeezed to nothing with no scrollbar to
    // reveal it. See AD.UNIT in core/config.js.
    const { W, H } = unit();
    ins.style.display = "inline-block";
    ins.style.width = `${W}px`;
    ins.style.height = `${H}px`;
  } else {
    // Responsive here because the sidebar is drag-resizable, so this column has
    // no fixed width for a fixed unit to fit. A responsive unit measures its
    // container and writes its own inline height, so only display is set.
    ins.style.display = "block";
    ins.setAttribute("data-ad-format", "horizontal");
    ins.setAttribute("data-full-width-responsive", "true");
  }

  box.replaceChildren(ins);
  box.classList.add("adlive");        // drops the dashed placeholder outline

  watchFill(ins, settle);
  (window.adsbygoogle = window.adsbygoogle || []).push({});
}
