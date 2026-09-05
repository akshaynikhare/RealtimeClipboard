/**
 * "Sponsor" — the ask, said properly, in a dialog.
 *
 * Both entry points used to be bare anchors onto GitHub Sponsors: a tier list,
 * reached from a two-word link, with nothing having said what the money pays for
 * or that there is a free way to help. Most people who clicked it wanted to know
 * what was being asked, not to pick a tier.
 *
 * It is NOT a form, and cannot become one: src/pages/contact/ records the reason
 * — a form has to post somewhere, and that is a server holding other people's
 * messages, which this project does not run. Every route out of here is a link
 * the reader's own client owns, so nothing they write passes through us.
 */

import { LINKS, SITE } from "../../core/config.js";
import { adNetwork } from "../../core/surface.js";
import { IS_DESKTOP } from "../../core/native.js";
import * as modal from "../primitives/modal.js";
import { esc, lazyStyle } from "../primitives/dom.js";

/**
 * `mailto:` is dead in the desktop shell — ui/features/externalLinks.js hands
 * external links to the Rust side, which allow-lists two https hosts and would
 * refuse this, and wry does nothing with the click by itself. The contact page
 * carries the same address in prose and is already an allowed host.
 */
const ASK = IS_DESKTOP
  ? { href: `${SITE.ORIGIN}/contact/`, label: "Open the contact page" }
  : {
      href: `mailto:${SITE.EMAIL}`
          + `?subject=${encodeURIComponent("Sponsoring RealtimeClipboard")}`,
      label: `Email ${SITE.EMAIL}`,
    };

/**
 * The free row differs by surface and has to. On the web "keep ads on" is a real
 * contribution; in the desktop app there is no ad to keep on — Google's
 * programme policies forbid one there (docs/decisions/0001) — so asking would be
 * asking for nothing.
 */
const free = () => adNetwork() === "adsense"
  ? {
      title: "Leave the ads on",
      body: "One unit under the editor, on this page only. It is what pays the "
          + "relay bill, and it never sees your clipboard — the text is "
          + "encrypted before it leaves this window.",
    }
  : {
      title: "Tell someone about it",
      body: "The apps carry no ads at all, so word of mouth is the whole of "
          + "the marketing budget.",
    };

export function open() {
  lazyStyle("sponsor.css");

  const help = free();

  modal.show({
    className: "spmodal",
    labelledBy: "spTitle",
    html: `
      <div class="sphead">
        <h2 id="spTitle">Sponsor the relay</h2>
        <button class="spclose" type="button" data-modal-dismiss
                aria-label="Close">✕</button>
      </div>

      <div class="spbody">
        <p class="splede">
          RealtimeClipboard has no accounts and no subscription, but the relay
          is a server someone pays for every month. These are the three ways to
          help, cheapest first.
        </p>

        <ul class="splist">
          <li>
            <h3>${esc(help.title)}</h3>
            <p>${esc(help.body)}</p>
          </li>
          <li>
            <h3>Sponsor on GitHub</h3>
            <p>Monthly or one-off, at whatever size makes sense. It goes to the
               hosting bill first.</p>
            <a class="spcta" href="${esc(LINKS.SPONSOR)}"
               target="_blank" rel="noopener noreferrer">Open GitHub Sponsors</a>
          </li>
          <li>
            <h3>Sponsor the app itself</h3>
            <p>For a company that wants the slot under the editor, or the CLI
               and the desktop builds supported. Say what you have in mind and
               you get a real reply.</p>
            <a class="spcta" href="${esc(ASK.href)}">${esc(ASK.label)}</a>
          </li>
        </ul>
      </div>

      <div class="spfoot">
        <a href="${esc(LINKS.REPO)}" target="_blank" rel="noopener noreferrer">Star the repo</a>
        <button class="btn" type="button" data-modal-dismiss>Close</button>
      </div>`,
  });
}
