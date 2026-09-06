/**
 * "What's new" — the changelog, in the app.
 *
 * A service worker swaps the shell under you and nothing says what changed, so
 * features appear and behaviour shifts for no visible reason. These are the
 * release notes, generated from commit history by tools/release/changelog.mjs.
 *
 * Two rules about when it appears. It never interrupts — a release is not
 * urgent, and a modal stealing focus while someone pastes a password is a worse
 * bug than the one it announces, so arrival is a dismissible banner. And it never
 * shows on a first visit: the version is recorded silently and the banner starts
 * from the release after.
 *
 * Failure here is silence, never an error: a missing or malformed changelog.json
 * means no banner and no menu entry.
 */

import { emit } from "../../core/bus.js";
import { read, write } from "../../core/storage.js";
import * as modal from "../primitives/modal.js";
import { esc, lazyStyle } from "../primitives/dom.js";
import { atRoot } from "../../core/paths.js";
import { IS_DESKTOP } from "../../core/native.js";
import { LINKS } from "../../core/config.js";
import { t } from "../../core/i18n.js";

const SEEN = "seenVersion";
const SOURCE = atRoot("changelog.json");

/**
 * The web app links its own copy: precached, so it opens offline and is exactly
 * the file this build shipped. The desktop shell's copy is on `tauri.localhost`
 * — a host that exists only inside the app, which is where this link does not
 * open (see ui/features/externalLinks.js).
 */
const FULL_LOG = IS_DESKTOP ? LINKS.CHANGELOG : atRoot("CHANGELOG.md");

let log = null;          // the parsed changelog, once it has loaded

export async function init() {
  log = await load();
  if (!log?.releases?.length) return;

  const seen = read(SEEN, null);
  const current = log.current;

  // First run on this device: record where they came in, say nothing.
  if (!seen) {
    write(SEEN, current);
    return;
  }
  if (seen === current) return;

  // Behind by one release or ten, the offer is the same.
  const behind = log.releases.findIndex(r => r.version === seen);
  const count = behind === -1 ? 1 : behind;

  emit("ui:banner", {
    key: "whatsnew",
    tone: "info",
    title: t("Updated to {version}", { version: current }),
    body: count > 1
      ? t("{n} releases have landed since you were last here.", { n: count })
      : t("A new version of RealtimeClipboard is running in this tab."),
    action: { label: t("See what's new"), onClick: () => open() },
    dismissAfter: 20000,
  });

  // Marked as seen on arrival, not on read. The alternative nags on every load
  // until the dialog is opened, which turns a courtesy into an obstacle.
  write(SEEN, current);
}

/** Is there anything to show? Used by the menu to hide a dead entry. */
export const available = () => !!log?.releases?.length;

/** The current version, for the status bar / about. Null before init(). */
export const version = () => log?.current ?? null;

export function open() {
  if (!log?.releases?.length) return;
  ensureStyles();

  modal.show({
    className: "wnmodal",
    labelledBy: "wnTitle",
    html: `
      <div class="wnhead">
        <h2 id="wnTitle">${t("What's new")}</h2>
        <button class="wnclose" type="button" data-modal-dismiss
                aria-label="${t("Close")}">✕</button>
      </div>
      <div class="wnbody">${log.releases.map(release).join("")}</div>
      <div class="wnfoot">
        <a href="${esc(FULL_LOG)}" target="_blank" rel="noopener noreferrer">${t("Full history")}</a>
      </div>`,
  });
}

function release(r) {
  return `
    <section class="wnrel">
      <h3>${esc(r.version)}${r.date ? ` <span class="wndate">${esc(r.date)}</span>` : ""}${
        r.breaking ? ` <span class="wnbreak">${t("breaking")}</span>` : ""}</h3>
      ${(r.groups ?? []).map(group).join("")}
    </section>`;
}

function group(g) {
  const more = g.more
    ? `<li class="wnmore">${g.more === 1 ? t("…and 1 more") : t("…and {n} more", { n: g.more })}</li>`
    : "";
  return `
    <h4>${esc(g.title)}</h4>
    <ul>${(g.items ?? []).map(i => `<li>${esc(i)}</li>`).join("")}${more}</ul>`;
}

/**
 * Fetch the notes.
 *
 * Deliberately not bundled into a module: the changelog changes on every
 * release and the code does not, so keeping it a data file means a release note
 * fix is not a code change. `cache: "no-cache"` because the service worker
 * serves this shell cache-first, and a stale changelog is the one file where
 * being one version behind defeats the entire point.
 */
async function load() {
  try {
    const res = await fetch(SOURCE, { cache: "no-cache" });
    if (!res.ok) return null;
    const data = await res.json();
    return data && Array.isArray(data.releases) ? data : null;
  } catch {
    return null;      // offline, missing, or not JSON. All the same answer.
  }
}

const ensureStyles = () => lazyStyle("whatsnew.css");
