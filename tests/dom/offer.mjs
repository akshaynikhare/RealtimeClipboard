/**
 * The app offer in the header: the desktop build and the PWA install, on one row.
 *
 * Two banners above the editor became one line in the app bar, and the reason
 * every assertion below exists is that the row is unsolicited. It has to be
 * small (one row whatever is on offer), honest (the sentence it shows matches
 * what is actually available), and answerable — it stays until it is dealt
 * with, and once it HAS been declined it must never come back.
 *
 * Usage:  node tests/dom/offer.mjs
 */

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("\nSKIP: app-offer test needs jsdom  (npm i -D jsdom)\n");
  process.exit(0);
}

const dom = new JSDOM(
  `<header class="appbar"><div class="tabspace" id="mount-notice"></div></header>` +
  `<div id="mount-banners"></div>`,
  { url: "https://example.com/app.html#D75LVX9QRS", pretendToBeVisual: true });

const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.CustomEvent = window.CustomEvent;
global.location = window.location;
global.history = window.history;
global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
global.getComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

/* A mouse on a desktop, which is what makes the desktop offer true. */
window.matchMedia = query => ({
  matches: /hover: hover/.test(query),
  addEventListener() {},
  addListener() {},
});

/* Nothing here should reach the network or the worker. */
window.open = () => { opened++; return null; };
let opened = 0;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const host = () => document.getElementById("mount-notice");
const row = () => host().querySelector(".topnotice");
const acts = () => [...host().querySelectorAll(".topnotice-act")].map(b => b.textContent);
const msg = () => host().querySelector(".topnotice-msg")?.textContent ?? "";
const declined = name => localStorage.getItem(`realtimeclipboard.${name}Dismissed`) === "true";

/**
 * A fresh module instance per scenario. install.js keeps the live offers in
 * module scope on purpose — there is one header — so a query-string cache-bust
 * is what gives each case a clean one.
 */
let nth = 0;
async function boot() {
  host().innerHTML = "";
  const mod = await import(`../../src/ui/features/install.js?${nth++}`);
  mod.init();
  return mod;
}

/** Chrome offering the install. init() has already run by the time this fires. */
function installable() {
  const evt = new window.Event("beforeinstallprompt");
  evt.prompt = () => {};
  evt.userChoice = Promise.resolve({ outcome: "accepted" });
  window.dispatchEvent(evt);
}

console.log("\nOne row, whatever is on offer\n");

await boot();
check("the desktop offer alone names the desktop app",
  /desktop app/i.test(msg()), msg());
check("...with one action", acts().length === 1, acts().join(" / "));

installable();
check("both offers still make ONE row",
  host().querySelectorAll(".topnotice").length === 1);
check("...with two actions, one per destination",
  acts().length === 2, acts().join(" / "));
check("...and a sentence that claims neither in particular",
  !/desktop app\./i.test(msg()) && /runs as an app/i.test(msg()), msg());

console.log("\nA row nobody asked for stays out of the editor\n");

check("nothing is mounted above the editor",
  document.getElementById("mount-banners").children.length === 0,
  "two banners here is two rows of the text area spent on an advert");
check("the notice sits in the app bar",
  host().closest("header.appbar") !== null);
check("it announces itself politely",
  row().getAttribute("role") === "status");

console.log("\nTaking one offer leaves the other\n");

const desktopBtn = [...host().querySelectorAll(".topnotice-act")]
  .find(b => /desktop/i.test(b.textContent));
desktopBtn.click();
check("the row survives with the offer that was not taken",
  acts().length === 1 && /install/i.test(acts()[0]), acts().join(" / "));
check("...and it opened the download page", opened === 1);
check("...and the taken one is remembered as seen",
  declined("desktop"), "otherwise it is offered again tomorrow");

console.log("\nIt stays until it is answered\n");

localStorage.clear();
await boot();
installable();
host().querySelector(".topnotice-x").click();
check("× clears the row", row() === null);
check("...and remembers BOTH offers as declined",
  declined("desktop") && declined("install"),
  "the × dismisses what is on screen, which is both of them");

await boot();
installable();
check("so a later visit offers nothing at all", row() === null);

/* THE REGRESSION: it used to clear itself after a minute, and the row was gone
   by the time anyone looked up at the header. Nothing may schedule its removal. */
localStorage.clear();
let scheduled = null;
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { scheduled = ms; return realSetTimeout(fn, ms); };

await boot();
check("a fresh visit offers again", row() !== null);
check("...and nothing is counting down to take it away", scheduled === null,
  scheduled === null ? "no timer is set at all" : `a timer was set for ${scheduled} ms`);

global.setTimeout = realSetTimeout;

console.log("\nPhones are not lied to\n");

localStorage.clear();
window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
await boot();
check("no desktop offer without a mouse", row() === null,
  "a native app cannot watch a phone's clipboard either");
installable();
check("...but the install offer still stands",
  row() !== null && acts().length === 1 && /install/i.test(acts()[0]),
  "Android is where installing this matters most");

console.log(`\n${"=".repeat(58)}\nAPP OFFER: ${pass}/${pass + fail} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
