/**
 * Report / sponsor, in the far-right corner of the app header.
 *
 * The two places the app asks the user for something rather than doing something
 * for them. They sit together and they sit last, which is the honest weight of
 * an ask inside a tool you opened to move text between two machines.
 *
 * Rendered here rather than in app.html so the URLs come from core/config.js and
 * exist once — hard-coded markup would repeat the same owner/repo in the header,
 * the landing page and the manifest, with nothing keeping them equal.
 *
 * Anchors, not buttons: they leave the app, so middle-click, "copy link address"
 * and "open in new tab" all have to work. Sponsor now intercepts the plain click
 * for a dialog and keeps the href for the rest — see its `dialog` field.
 */

import { LINKS } from "../../core/config.js";
import { $, esc, setHTML } from "../primitives/dom.js";

/**
 * Each icon is a single path set, drawn on the same 24-grid and stroke weight
 * as the header's other icons — under 1080px the label hides and the glyph is
 * the whole control, so it has to be legible at 14px on its own.
 */
const ITEMS = [
  {
    id: "lIssue",
    href: LINKS.NEW_ISSUE,
    label: "Report issue",
    title: "Report a problem on GitHub",
    aria: "Report an issue on GitHub",
    icon: `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2h.01"/>`,
  },
  {
    id: "lSponsor",
    cls: "sponsor",
    href: LINKS.SPONSOR,
    label: "Sponsor",
    title: "How to support RealtimeClipboard",
    aria: "How to support RealtimeClipboard",
    /* A plain click opens the dialog, which says what the money is for before
       showing anyone a tier list. The href stays real so middle-click, "copy
       link address" and a keyboard "open in new tab" still reach GitHub — the
       reason this was an anchor in the first place.

       Lazily imported, with a LITERAL specifier: this header is eager, the
       dialog is a stylesheet and a screenful of copy that most sessions never
       open, and a path in a variable is invisible to the bundler. */
    dialog: () => import("./sponsor.js").then(m => m.open()),
    icon: `<path d="M12 20.2s-7.3-4.6-7.3-9.4A3.9 3.9 0 0112 8.4a3.9 3.9 0 017.3 2.4c0 4.8-7.3 9.4-7.3 9.4z"/>`,
  },
];

export function init() {
  const host = $("mount-links");
  if (!host) return;

  // rel is spelled out even though target=_blank implies noopener in current
  // browsers — the page is also meta referrer=no-referrer, so no URL carrying a
  // session key travels with the click.
  setHTML(host, `
    <nav class="applinks" aria-label="Project links">
      ${ITEMS.map(i => `
        <a class="alink${i.cls ? ` ${esc(i.cls)}` : ""}" id="${esc(i.id)}"
           href="${esc(i.href)}" target="_blank" rel="noopener noreferrer"
           title="${esc(i.title)}" aria-label="${esc(i.aria)}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${i.icon}</svg>
          <span class="lbl">${esc(i.label)}</span>
        </a>`).join("")}
    </nav>`);

  for (const item of ITEMS) {
    if (!item.dialog) continue;
    $(item.id)?.addEventListener("click", e => {
      // Modifier and middle clicks are asking for the href, not the dialog.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      item.dialog();
    });
  }
}
