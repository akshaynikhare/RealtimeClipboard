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

import { GOOGLE, GOOGLE_SRC, adsEnabled } from "../../core/config.js";
import { on, EV } from "../../core/bus.js";
import { $, esc, setHTML, scriptURL } from "../primitives/dom.js";

// Fixed in CSS rather than letting the creative size itself, so the editor does
// not jump when one loads — reserved space is the point of a placeholder.
const PLACEHOLDER_LABEL = "Ad slot · 728 × 90";

let box = null;
let mounted = false;

export function init() {
  const host = $("mount-ad");
  if (!host) return;

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
        <span class="adslot-ph">${esc(PLACEHOLDER_LABEL)}</span>
      </div>
    </aside>`);

  box = host.querySelector("#adBox");

  // Empty IDs mean a fork or local checkout loads no third-party script.
  if (!adsEnabled() || !GOOGLE.ADSENSE_SLOTS.APP) return;

  if (!location.hash) return mount();
  on(EV.KEY_CHANGED, () => { if (!location.hash) mount(); });
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
  // display only. A responsive unit measures its container and writes its own
  // inline height, so anything set here is overwritten a moment later anyway —
  // the reserved space is expressed as a min-height on the box instead.
  ins.style.display = "block";
  ins.setAttribute("data-ad-client", GOOGLE.ADSENSE_CLIENT);
  ins.setAttribute("data-ad-slot", GOOGLE.ADSENSE_SLOTS.APP);
  ins.setAttribute("data-ad-format", "horizontal");
  ins.setAttribute("data-full-width-responsive", "true");

  box.replaceChildren(ins);
  box.classList.add("adlive");        // drops the dashed placeholder outline

  (window.adsbygoogle = window.adsbygoogle || []).push({});
}
