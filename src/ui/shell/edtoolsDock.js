/**
 * Dock the editor's action buttons into the app bar when the bar has wrapped.
 *
 * On a phone the bar wraps to two rows and the toolbar sits on a third, so
 * three rows of chrome stand between the window edge and the first line of
 * text. The bar's first row has spare width at exactly that point — everything
 * after the spacer has already wrapped away from it — so the buttons go there
 * and the third row disappears.
 *
 * A DOM move, not CSS: `.tabacts` lives inside <main> and `.appbar` is a
 * sibling two levels up, so no media query can put one inside the other.
 *
 * WHY IT MEASURES INSTEAD OF PICKING A WIDTH. Whether the bar wraps depends on
 * what is in it, not on the viewport — a locked session adds a status item, an
 * install offer claims a whole row. A pixel threshold is wrong for some of those
 * states in both directions: too early and the buttons collide with the mode
 * switch, too late and the row it was meant to save is still there.
 *
 * Measuring is stable rather than oscillating, and deliberately so. Docking adds
 * content to the bar, which can only make it wrap more, so "docked and wrapped"
 * stays docked. Undocking removes content, so "undocked and unwrapped" stays
 * undocked. The band between them keeps whichever state it arrived in, which is
 * hysteresis, not flicker.
 *
 * appbar.css says the cluster was moved OUT of the bar so it would sit above the
 * text it acts on rather than float over it. That still holds where there is
 * room for it. This is the narrow case only, and it trades that adjacency for a
 * row of editor — the same trade mobile.css makes for the ad slot and the
 * publisher line.
 */

import { LAYOUT } from "../../core/config.js";

let bar = null;
let tools = null;
let home = null;          // .edtools, where the cluster lives when undocked
let anchor = null;        // the flex:1 spacer; docking goes just after it
let mq = null;
let frame = 0;

export function init() {
  bar = document.querySelector(".appbar");
  tools = document.querySelector(".tabacts");
  anchor = document.getElementById("mount-notice");
  if (!bar || !tools || !anchor) return;

  home = tools.parentElement;

  mq = window.matchMedia?.(LAYOUT.NARROW_MQ) ?? null;
  // addListener is the pre-2019 Safari spelling, and the two must not both fire.
  if (mq?.addEventListener) mq.addEventListener("change", schedule);
  else mq?.addListener?.(schedule);

  window.addEventListener("resize", schedule, { passive: true });
  apply();
}

/** Coalesce to one measurement per frame — resize fires per pixel dragged. */
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; apply(); });
}

/**
 * Has the bar wrapped? Its last visible child sits lower than its first.
 * Cheaper and more honest than reading widths: it asks the layout what actually
 * happened rather than predicting it.
 */
function wrapped() {
  const kids = [...bar.children].filter(el => el.offsetParent !== null);
  return kids.length > 1 && kids[kids.length - 1].offsetTop > kids[0].offsetTop;
}

function apply() {
  if (!mq?.matches) return undock();
  wrapped() ? dock() : undock();
}

function dock() {
  if (tools.parentElement === bar) return;
  // After the spacer, so the spacer's free width pushes the cluster to the far
  // right of the first row. Before it, the buttons would sit against the key.
  bar.insertBefore(tools, anchor.nextSibling);
  tools.classList.add("tabacts-docked");
  home.classList.add("edtools-empty");
}

function undock() {
  if (!home || tools.parentElement === home) return;
  home.appendChild(tools);
  tools.classList.remove("tabacts-docked");
  home.classList.remove("edtools-empty");
}
