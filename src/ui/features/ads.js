/**
 * The ad slot under the editor: reserve it, dispatch to a network, take the
 * space back if nothing arrives.
 *
 * Why an ad at all: no accounts and no subscription, but the relay is a paid
 * server, and the slot that pays for it is what keeps the app free.
 *
 * This module knows no network. Which one a surface may load is
 * `core/surface.js` `adNetwork()`, because the answer is a Google programme
 * policy rather than a preference — ads may not be integrated into a software
 * application, so the desktop shell and the extension can never carry AdSense.
 * docs/decisions/0001. The renderers are lazy so that only the surface that
 * uses one pays for it, and each `import()` takes a LITERAL specifier: a path
 * in a variable is opaque to the bundler and 404s in the deploy alone.
 *
 * What survives from the 2026-08-09 reversal is TIMING: the ad request reports
 * the page URL and AdSense offers no override, so nothing may load while the
 * share key is still in `location.hash`. That subscription is here, eager, and
 * must stay here — boot strips the fragment during init, so a renderer that
 * only subscribed after its own dynamic import would miss the event entirely.
 */

import { AD, LAYOUT } from "../../core/config.js";
import { adNetwork } from "../../core/surface.js";
import { on, EV } from "../../core/bus.js";
import { $, esc, setHTML } from "../primitives/dom.js";

const RENDERERS = {
  adsense: () => import("./adsense.js"),
  house:   () => import("./house.js"),
};

const isNarrow = () => window.matchMedia?.(LAYOUT.NARROW_MQ)?.matches ?? false;

const unit = () => (isNarrow() ? AD.UNIT.NARROW : AD.UNIT.WIDE);

let slot = null;
let box = null;
let settleTimer = null;
let done = false;

export function init() {
  const host = $("mount-ad");
  if (!host) return;

  const network = adNetwork();
  if (network === "none") return;      // no chrome either — see settle() below

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

  slot = host.querySelector("#adSlot");
  box = host.querySelector("#adBox");

  // The reservation is not open-ended. Every failure mode that leaves the box
  // empty — blocked script, no network, an unfilled response that reports
  // nothing — looks identical from here, and they all end the same way.
  settleTimer = setTimeout(() => settle(false), AD.SETTLE_MS);

  if (network !== "adsense") return load(network);

  if (!location.hash) return load(network);
  on(EV.KEY_CHANGED, () => { if (!location.hash) load(network); });
}

function load(network) {
  if (done) return;
  RENDERERS[network]()
    .then(m => m.mount({ box, unit, isNarrow, settle }))
    .catch(() => settle(false));      // a renderer that will not load is an empty slot
}

/**
 * The slot's one exit. `filled` leaves the ad alone; anything else hands the
 * box to the house promo.
 *
 * It does NOT collapse. The space is reserved either way, so removing it buys
 * nothing a late refill would not want back — and an empty bordered box reads
 * as broken while a promo reads as deliberate. docs/decisions/0006.
 *
 * A filled unit is never touched. Cutting off a rendered ad is an AdSense
 * policy violation, which is the same reason ads.css reserves with `min-height`
 * rather than `height`.
 */
export function settle(filled) {
  if (done) return;
  done = true;
  clearTimeout(settleTimer);
  if (!filled) fallback();
}

/** The house promo, in the box the ad did not use. */
function fallback() {
  RENDERERS.house()
    // settle() has already run, so the house renderer gets a no-op: it reports
    // "filled" on principle and there is nothing left to decide.
    .then(m => m.mount({ box, unit, isNarrow, settle: () => {} }))
    .catch(() => {});
}
