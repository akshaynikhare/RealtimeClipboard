/**
 * The house slot — the desktop app's own promo, filled from this repo.
 *
 * The desktop shell cannot carry AdSense: Google's programme policies forbid
 * ads in software applications, and enforcement is account-level, so a tag here
 * would put the website's revenue at risk too. docs/decisions/0001.
 *
 * A third-party network for this surface is still open (docs/decisions/0002),
 * but EthicalAds — the candidate — cannot run here either: its client fetches
 * by JSONP and renders with `innerHTML` on remote HTML, and registers no
 * Trusted Types policy, so under `require-trusted-types-for 'script'` both
 * sinks throw. Admitting it would mean a document-wide `default` policy, which
 * un-polices every innerHTML in the app. Until that is solved this slot is
 * ours, which costs nothing and reaches no network at all.
 */

import { SITE } from "../../core/config.js";
import { adNetwork } from "../../core/surface.js";
import { esc, setHTML } from "../primitives/dom.js";
import * as sponsor from "./sponsor.js";

export function mount({ box, settle }) {
  if (!box) return settle(false);

  const slot = box.closest(".adslot");
  const tag = slot?.querySelector(".adslot-tag");
  const note = slot?.querySelector(".adslot-note");

  if (tag) tag.textContent = "RealtimeClipboard";
  if (note) {
    // Two callers, two truths. On desktop this is the only thing the slot ever
    // shows and no ad network is reachable at all. On the web it is standing in
    // for an ad that did not arrive, where saying "no third-party ads" would be
    // false — the tag is loaded, it simply had nothing to serve.
    const line = adNetwork() === "house"
      ? "No third-party ads in the desktop app. Nothing here reaches a network."
      : "No ad to show right now. Ads are what pay for the relay.";
    note.textContent = line;
    note.title = line;
  }

  setHTML(box, `
    <div class="house">
      <p class="house-copy">Sync from the terminal too —
        <code>npx realtimeclipboard</code></p>
      <a class="house-cta" href="${esc(`${SITE.ORIGIN}/help/install/cli/`)}"
         target="_blank" rel="noopener noreferrer">Read the guide</a>
      <button class="house-cta" type="button" data-sponsor>Sponsor the relay</button>
    </div>`);

  box.querySelector("[data-sponsor]").addEventListener("click", () => sponsor.open());

  // Not `adlive`, which drops the border: this is still a placeholder, and a
  // borderless one reads as a paragraph that wandered in under the editor. The
  // dotted rule says the space is reserved and nothing bought it.
  //
  // REMOVED, not merely not-added. On the web this usually runs as a fallback
  // *after* adsense.js has already mounted and claimed the box, and the two
  // classes then sat on the same element at equal specificity — `adlive`'s
  // `border:0` keeping the width at zero under `adhouse`'s dotted style, and its
  // `display:block` keeping the copy off-centre. A dotted border nobody can see.
  box.classList.remove("adlive");
  box.classList.add("adhouse");
  settle(true);                      // our own content always fills
}
