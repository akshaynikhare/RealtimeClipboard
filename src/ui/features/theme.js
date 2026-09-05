/**
 * Light, dark, or whatever the machine is set to.
 *
 * The app had no theme control and did not need one: styles/tokens.css answers
 * `prefers-color-scheme` and the OS decides. That is still the default, and
 * "System" is not a third palette — it is the ABSENCE of a choice, which is why
 * it stamps no attribute at all and leaves the media query in charge. The first
 * paint of every load is therefore correct without this module having run.
 *
 * Only an explicit Light or Dark writes `data-theme` on <html>, and tokens.css
 * is built so that attribute out-ranks the media query in both directions.
 *
 * The desktop shell is the reason this is worth having. Its window used to
 * declare `"theme": "Dark"`, which pins `prefers-color-scheme` as well as the
 * native decorations, so the app stayed dark on a light machine and no
 * stylesheet could reach it. Removing that made the OS the authority everywhere
 * — and made "I want the app dark on a light desktop" a request with no answer,
 * which this is. docs/decisions/0009.
 */

import { THEMES } from "../../core/config.js";
import { on, EV } from "../../core/bus.js";
import * as state from "../../core/state.js";

const root = () => document.documentElement;

export function init() {
  apply();
  on(EV.SETTINGS_CHANGED, ({ name }) => { if (name === "theme") apply(); });
}

export function apply() {
  const choice = state.get().settings.theme;
  if (choice === THEMES.LIGHT || choice === THEMES.DARK)
    root().setAttribute("data-theme", choice);
  else
    root().removeAttribute("data-theme");     // System: hand it back to the media query
}

/** What is actually on screen, for a label that has to say so. */
export function resolved() {
  const choice = state.get().settings.theme;
  if (choice === THEMES.LIGHT || choice === THEMES.DARK) return choice;
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches
    ? THEMES.LIGHT
    : THEMES.DARK;
}
