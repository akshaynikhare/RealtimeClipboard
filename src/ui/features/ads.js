/**
 * The ad slot, under the editor.
 *
 * Why an ad at all: no accounts and no subscription, but the relay is a paid
 * server, and the slot that pays for it is what keeps the app free. The
 * crawlable pages carry the same tags from src/landing/tags.js; the two cannot
 * share a module — core/ is the only directory both may import and it may not
 * touch the DOM — so the IDs and script URLs come from core/config.js.
 *
 * This document ran no ad tag until 2026-08-09, when the no-ads-in-the-app
 * rule was removed. What survives that decision is TIMING: the ad request
 * reports the page URL and AdSense offers no override, so the tag must never
 * load while the share key is still in `location.hash`. Boot strips the
 * fragment (keys.clearUrl) before EV.KEY_CHANGED fires, and a locked link
 * keeps its fragment until the PIN is given — so the slot mounts on that
 * event, never before, and a document whose URL still holds a key shows the
 * placeholder instead of an ad.
 *
 * It sits here rather than in the sidebar because the sidebar holds the key,
 * the file previews and the settings. A mis-click beside "fetch this file"
 * transfers data; below the editor is outside the flow of every task.
 */

import { GOOGLE, GOOGLE_SRC, LAYOUT, adsEnabled } from "../../core/config.js";
import { on, EV } from "../../core/bus.js";
import { $, esc, setHTML, scriptURL } from "../primitives/dom.js";

const isNarrow = () => window.matchMedia?.(LAYOUT.NARROW_MQ)?.matches ?? false;

const unit = () =>
  isNarrow() ? GOOGLE.ADSENSE_APP_UNIT.NARROW : GOOGLE.ADSENSE_APP_UNIT.WIDE;

let box = null;
let mounted = false;

export function init() {
  const host = $("mount-ad");
  if (!host) return;

  const { W, H } = unit();

  setHTML(host, `
    <aside class="adslot" id="adSlot" aria-label="Sponsored">
      <div class="adslot-head">
        <div class="adslot-tag">Sponsored</div>
        <p class="adslot-note"
           title="Ads pay for the relay. Your clipboard is encrypted before it leaves this window.">
          Ads pay for the relay. Your clipboard is encrypted before it leaves
          this window.
        </p>
      </div>

      <div class="adslot-box" id="adBox" role="presentation">
        <span class="adslot-ph">${esc(`Ad slot · ${W} × ${H}`)}</span>
      </div>
    </aside>`);

  box = host.querySelector("#adBox");

  // Empty IDs mean a fork or local checkout loads no third-party script.
  if (!adsEnabled() || !GOOGLE.ADSENSE_SLOTS.APP) return;

  consentLink();

  if (!location.hash) return mount();
  on(EV.KEY_CHANGED, () => { if (!location.hash) mount(); });
}

/**
 * Reveal "Privacy & cookie settings" in the app footer.
 *
 * Withdrawing consent has to be as easy as giving it, and Google's CMP renders
 * no control of its own once dismissed. landing/tags.js does the same job for
 * the crawlable pages and builds its anchor in JS because it serves twenty
 * documents; this is one document, so the anchor is markup in app.html and
 * only the wiring is here — which is also what keeps the eager bundle inside
 * the build's budget.
 *
 * Hidden until the CMP reports in: outside the EEA there is no dialog to
 * reopen. That wait settles the locked-link case for free — the CMP arrives
 * with the ad script, which does not load until the key has left the URL.
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

function mount() {
  if (mounted || !box) return;
  mounted = true;
  guardShell();

  const s = document.createElement("script");
  s.async = true;
  s.crossOrigin = "anonymous";
  s.src = scriptURL(GOOGLE_SRC.adsense(GOOGLE.ADSENSE_CLIENT));
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
    // reveal it. See GOOGLE.ADSENSE_APP_UNIT in core/config.js.
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

  (window.adsbygoogle = window.adsbygoogle || []).push({});
}
