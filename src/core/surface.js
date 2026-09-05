/**
 * What this surface is allowed to load, and what to call it in a report.
 *
 * Ads differ per surface by POLICY, not by preference. Google's programme
 * policies forbid ads in software applications — "Google ads may not be
 * integrated into a software application of any kind" — and enforcement is
 * account-level, so an AdSense tag in the desktop shell or the extension would
 * put the website's revenue at risk too. `adNetwork()` is the one place that
 * decides, so the rule is greppable rather than spread across three tag
 * modules. docs/decisions/0001 has the reasoning.
 *
 * A leaf on purpose: it imports from core/ and nothing in core/ imports it.
 * `device.js` reaches `storage.js` which reaches `config.js` which reaches
 * `native.js`, so folding this into any of those would close a cycle and the
 * symptom would be a TDZ error at import time, not a legible one.
 */

import { SURFACE } from "./native.js";
import { os } from "./device.js";
import { adsEnabled, analyticsEnabled } from "./config.js";

/**
 * Running as an installed app rather than a browser tab. Guarded the way
 * core/CLAUDE.md requires — this module is imported by the node tests and by
 * the published npm package, where `matchMedia` does not exist.
 *
 * `fullscreen` is deliberately NOT in this list, though ui/features/install.js
 * tests for it: F11 in an ordinary tab matches it, which is harmless when the
 * question is "should I offer to install" and wrong when the question is "which
 * surface produced this event" — it would file plain web traffic as web-pwa.
 */
export function isStandalone() {
  const mm = globalThis.matchMedia;
  if (!mm) return false;
  return ["standalone", "window-controls-overlay", "minimal-ui"]
    .some(mode => mm.call(globalThis, `(display-mode: ${mode})`).matches)
    || globalThis.navigator?.standalone === true;   // iOS Safari's non-standard flag
}

/**
 * The GA4 `rtc_surface` value. One vocabulary for every tag module.
 *
 * `desktop-other` exists so the function is total: Tauri ships exactly three
 * desktop targets, so that value appearing in a report is a user-agent bug worth
 * seeing rather than something to quietly fold into desktop-linux.
 */
export function platform() {
  if (SURFACE === "vscode") return "vscode";
  if (SURFACE === "cli") return "cli";
  if (SURFACE === "desktop") {
    const name = os();
    return name === "Windows" ? "desktop-windows"
         : name === "macOS"   ? "desktop-mac"
         : name === "Linux"   ? "desktop-linux"
         : "desktop-other";
  }
  return isStandalone() ? "web-pwa" : "web-browser";
}

/**
 * Which ad network this surface may load, if any.
 *
 * "none" for vscode and cli is unconditional — it does not depend on an ID being
 * empty, because a rule that a configuration change can undo is not a rule.
 * tests/unit/adpolicy.mjs asserts exactly that.
 */
export function adNetwork() {
  if (SURFACE === "web") return adsEnabled() ? "adsense" : "none";
  if (SURFACE === "desktop") return "house";
  return "none";
}

/**
 * Only a surface with a document can carry a tag at all.
 *
 * The CLI and the VS Code extension are both Node hosts — the extension runs in
 * the extension host and owns no webview, so ui/features/analytics.js is never
 * even imported there. Saying "vscode reports" would describe something that
 * cannot happen, and it would also mean answering to `vscode.env.isTelemetryEnabled`
 * before it ever could. If the extension grows a webview, that opt-out is the
 * prerequisite, not an afterthought. docs/decisions/0003.
 */
export const analyticsOn = () =>
  (SURFACE === "web" || SURFACE === "desktop") && analyticsEnabled();
