/**
 * The theme setting, and the one thing about it that is easy to get wrong.
 *
 * "System" is not a third palette. It is the ABSENCE of a choice, and it has to
 * stamp NOTHING on <html> — because styles/tokens.css answers
 * `prefers-color-scheme` on its own, and that is what renders before any of this
 * JavaScript has loaded. A module that wrote `data-theme="dark"` for System
 * would look identical on a dark machine, freeze the app on a light one, and
 * stop following a live OS switch. All three failures are invisible in the
 * surface it is most likely to be tested on.
 *
 * The CSS half is checked too: the light palette is written twice on purpose —
 * once behind the media query, once behind the attribute — and the whole
 * mitigation for that is the two copies staying identical.
 *
 * Usage: node tests/dom/theme.mjs
 */

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("\nSKIP: theme test needs jsdom  (npm i -D jsdom)\n");
  process.exit(0);
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const dom = new JSDOM(`<div class="vs"></div>`, {
  url: "https://example.com/app.html",
  pretendToBeVisual: true,
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

let pass = 0, fail = 0;
const ok = (name, good, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const { THEMES, DEFAULT_THEME } = await import("../../src/core/config.js");
const state = await import("../../src/core/state.js");
const theme = await import("../../src/ui/features/theme.js");

const root = () => document.documentElement;
const stamped = () => root().getAttribute("data-theme");

console.log("\nTheme\n");

ok("the default is System", DEFAULT_THEME === THEMES.SYSTEM, DEFAULT_THEME);
ok("...and that is what state starts on",
   state.get().settings.theme === THEMES.SYSTEM);

theme.init();

/* THE POINT OF THE FILE. */
ok("System stamps nothing at all", stamped() === null,
   "an attribute here overrides prefers-color-scheme and stops following the OS");

state.saveSetting("theme", THEMES.DARK);
ok("Dark stamps the attribute", stamped() === "dark", String(stamped()));

state.saveSetting("theme", THEMES.LIGHT);
ok("Light stamps the attribute", stamped() === "light", String(stamped()));

state.saveSetting("theme", THEMES.SYSTEM);
ok("going back to System takes it off again", stamped() === null,
   "left behind, the app would be frozen at whatever was last chosen");

/* The panel's note reads this, and a wrong answer there is a lie on screen. */
window.matchMedia = q => ({ matches: /light/.test(q), media: q,
  addEventListener() {}, removeEventListener() {} });

ok("under System it reports what the OS says", theme.resolved() === THEMES.LIGHT,
   theme.resolved());
state.saveSetting("theme", THEMES.DARK);
ok("...and an explicit choice out-ranks the OS", theme.resolved() === THEMES.DARK,
   "the machine says light and the user said dark");
state.saveSetting("theme", THEMES.SYSTEM);

console.log("\nThe two copies of the light palette\n");

const tokens = readFileSync(join(REPO, "src/styles/tokens.css"), "utf8");

/** The declarations inside a block, as a comparable map. */
function palette(startsWith) {
  const at = tokens.indexOf(startsWith);
  if (at === -1) return null;
  const body = tokens.slice(tokens.indexOf("{", at) + 1, tokens.indexOf("\n  }\n", at) + 1
    || tokens.indexOf("\n}\n", at) + 1);
  const out = new Map();
  for (const [, k, v] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(k, v.trim());
  return out;
}

const viaQuery = palette('@media (prefers-color-scheme: light)');
const viaAttr = palette(':root[data-theme="light"]');

ok("both light blocks exist", !!viaQuery?.size && !!viaAttr?.size,
   `${viaQuery?.size} vs ${viaAttr?.size}`);
ok("...and declare the same tokens",
   [...viaQuery.keys()].join() === [...viaAttr.keys()].join(),
   "one was edited and the other was not — the failure this pair is prone to");

const differing = [...viaQuery].filter(([k, v]) => viaAttr.get(k) !== v).map(([k]) => k);
ok("...with the same values", differing.length === 0, differing.join(", "));

/* An explicit Dark has to beat a LIGHT machine, which means the media query
   cannot apply unconditionally. */
ok("the media query yields to an explicit dark",
   /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)/.test(tokens),
   "without the :not(), Dark is unreachable on a light OS");

ok("the page declares color-scheme, so the UA paints scrollbars to match",
   /color-scheme:\s*light dark/.test(tokens));

console.log(`\n${"=".repeat(58)}`);
console.log(`THEME: ${pass}/${pass + fail} passed`);
console.log("=".repeat(58) + "\n");
process.exit(fail ? 1 : 0);
