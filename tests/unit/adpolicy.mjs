/**
 * Which surface may load which ad network.
 *
 * This exists because the rule is a Google programme policy, not a preference:
 * "Google ads may not be integrated into a software application of any kind."
 * Enforcement is account-level, so an AdSense tag reaching the desktop shell or
 * the VS Code extension risks the website's revenue too. docs/decisions/0001.
 *
 * One CHILD PROCESS per surface, not one import per surface. `native.js`
 * computes SURFACE once at module evaluation, so a cache-busted re-import of
 * surface.js still sees the first surface the process ever declared — the whole
 * suite passed as "web" four times over before this was spawned out.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let pass = 0, fail = 0;
const ok = (name, cond, why) => {
  cond ? (pass++, console.log(`  PASS  ${name}`))
       : (fail++, console.log(`  FAIL  ${name}${why ? `  — ${why}` : ""}`));
};

console.log("\nAd policy per surface\n");

/** Answer the three questions inside a fresh process that declares `surface`. */
function probe(surface) {
  const src = `
    globalThis.__REALTIMECLIPBOARD_SURFACE__ = ${JSON.stringify(surface)};
    const s = await import(${JSON.stringify(resolve(REPO, "src/core/surface.js"))});
    process.stdout.write(JSON.stringify({
      network: s.adNetwork(), analytics: s.analyticsOn(), platform: s.platform(),
    }));`;
  return JSON.parse(execFileSync(process.execPath,
    ["--input-type=module", "-e", src], { cwd: REPO, encoding: "utf8" }));
}

const EXPECT = [
  ["web",     "adsense", true,  "web-browser"],
  ["desktop", "house",   true,  "desktop-other"],   // no UA in node
  ["vscode",  "none",    false, "vscode"],   // extension host, no webview
  ["cli",     "none",    false, "cli"],
];

for (const [surface, network, analytics, name] of EXPECT) {
  const r = probe(surface);
  ok(`${surface}: adNetwork() is "${network}"`, r.network === network, `got "${r.network}"`);
  ok(`${surface}: analyticsOn() is ${analytics}`, r.analytics === analytics);
  ok(`${surface}: platform() is "${name}"`, r.platform === name, `got "${r.platform}"`);
}

/* The point of the whole file: for a software surface the answer is "none"
   whatever the config says. A rule a config change can undo is not a rule. */
{
  const { GOOGLE } = await import("../../src/core/config.js");
  ok("the AdSense client ID is set, so the next two assertions mean something",
     Boolean(GOOGLE.ADSENSE_CLIENT));
  for (const surface of ["vscode", "cli"]) {
    ok(`${surface}: still "none" with a live AdSense client ID`,
       probe(surface).network === "none",
       "a configured ID must not switch ads on for a software surface");
  }
}

/* platform() is total — every surface lands in the frozen vocabulary. */
{
  const ALLOWED = new Set([
    "web-browser", "web-pwa", "desktop-windows", "desktop-mac",
    "desktop-linux", "desktop-other", "vscode", "cli",
  ]);
  for (const [surface] of EXPECT) {
    const p = probe(surface).platform;
    ok(`${surface}: platform() is in the known set`, ALLOWED.has(p), `got "${p}"`);
  }
}

console.log(`\n${"=".repeat(56)}\nAD POLICY: ${pass}/${pass + fail} passed\n${"=".repeat(56)}\n`);
assert.equal(fail, 0, `${fail} ad-policy assertions failed`);
