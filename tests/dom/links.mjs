/**
 * Links that leave the app, in the installed app.
 *
 * A Tauri webview swallows `target="_blank"`: no new-window handler is
 * registered, so wry answers with `SetHandled(true)` and nothing happens. Report
 * issue, Sponsor, the guide's Report it and What's new's Full history were all
 * dead clicks in the desktop app and perfect on the web — the failure mode this
 * whole file exists for is one that only the surface nobody tests can have.
 *
 * Driven through the markup the app really renders, not through fixture
 * anchors: the interception is delegated, so what it must survive is a real
 * dialog, a real modal and a real click path.
 *
 * The surface is decided at MODULE EVALUATION in core/native.js, so the web case
 * is a child process rather than another block here.
 *
 * Usage:  node tests/dom/links.mjs
 */

import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("\nSKIP: links test needs jsdom  (npm i -D jsdom)\n");
  process.exit(0);
}

const WEB_CHILD = process.argv[2] === "--as-web";

const dom = new JSDOM(`<div class="vs"><div id="mount-menus"></div></div>`, {
  url: "http://tauri.localhost/app.html",
  pretendToBeVisual: true,
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.CustomEvent = window.CustomEvent;
global.MouseEvent = window.MouseEvent;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

if (!globalThis.crypto?.randomUUID) {
  globalThis.crypto = { ...globalThis.crypto, randomUUID: () => "0000-test-0000" };
}

/* What the shell would answer with. Set before the first import that reaches
   core/native.js, which resolves the surface once. */
const opened = [];
if (!WEB_CHILD) {
  globalThis.__TAURI_INTERNALS__ = {};
  globalThis.__TAURI__ = {
    core: { invoke: (command, args) => { opened.push({ command, args }); return null; } },
  };
}

/* changelog.json, so What's new has something to render. */
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    current: "9.9.9",
    releases: [{ version: "9.9.9", date: "2026-01-01", groups: [] }],
  }),
});

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const externalLinks = await import("../../src/ui/features/externalLinks.js");
const state = await import("../../src/core/state.js");
const { LINKS, SITE } = await import("../../src/core/config.js");

externalLinks.init();

/** Click it the way a person does, and report whether the webview was let go. */
function click(anchor, init = {}) {
  const before = opened.length;
  const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  anchor.dispatchEvent(ev);
  return { handed: opened.slice(before), prevented: ev.defaultPrevented };
}

if (WEB_CHILD) {
  // A browser opens its own links. Intercepting them would break middle-click,
  // "open in new tab" and every other thing a browser does with an anchor. The
  // guide does not render off the desktop, so this is a plain one.
  const a = document.createElement("a");
  a.href = LINKS.NEW_ISSUE;
  document.body.appendChild(a);
  const { handed, prevented } = click(a);
  process.exit(!prevented && !handed.length ? 0 : 1);
}

/* ---- the guide, which is the desktop app's own dialog -------------------- */
state.setKey({ key: "D75LVX9QRS", roomHash: "deadbeef", aesKey: null });
const guide = await import("../../src/ui/panels/guidePanel.js");
guide.init();

const guideLink = document.querySelector(`.guide a[href^="https://github.com"]`);

console.log("\nLinks that leave the app\n");

check("the guide really renders one", !!guideLink, guideLink?.href);

const guided = click(guideLink);
check("THE FIX: the shell is asked to open it", guided.handed.length === 1,
      guided.handed[0]?.command);
check("...with the URL the anchor named", guided.handed[0]?.args?.url === LINKS.NEW_ISSUE,
      guided.handed[0]?.args?.url);
check("...and the webview is not left to swallow it", guided.prevented,
      "target=_blank is SetHandled(true) and nothing else");

/* ---- What's new: its own copy of the changelog is not reachable outside -- */
const whatsNew = await import("../../src/ui/features/whatsNew.js");
await whatsNew.init();
whatsNew.open();

const fullLog = document.querySelector(".wnfoot a");
check("What's new offers the full history", !!fullLog, fullLog?.href);
check("THE SECOND FIX: it does not point inside the app",
      !fullLog?.href.includes("tauri.localhost"),
      "tauri.localhost/CHANGELOG.md resolves in this webview and nowhere else");

const logged = click(fullLog);
check("...so the shell can open it", logged.handed[0]?.args?.url === LINKS.CHANGELOG,
      logged.handed[0]?.args?.url);

/* ---- Sponsor: a dialog here, and every route out of it has to work ------- */
const mountLinks = document.createElement("div");
mountLinks.id = "mount-links";
document.querySelector(".vs").appendChild(mountLinks);

const appLinks = await import("../../src/ui/features/appLinks.js");
appLinks.init();

const sponsorLink = document.getElementById("lSponsor");
const asked = click(sponsorLink);
check("the header's Sponsor is not a straight hand-off any more", !asked.handed.length,
      "it opens the dialog that says what the money is for");
check("...and the anchor keeps its href for middle-click",
      sponsorLink?.getAttribute("href") === LINKS.SPONSOR);

await new Promise(r => setTimeout(r, 0));      // the dialog is a dynamic import

const spGithub = document.querySelector(`.splist a[href^="https://github.com"]`);
check("the dialog opened and offers GitHub Sponsors", !!spGithub, spGithub?.href);
const sponsored = click(spGithub);
check("...and the shell is asked to open it",
      sponsored.handed[0]?.args?.url === LINKS.SPONSOR, sponsored.handed[0]?.args?.url);

const ask = document.querySelector(`.splist li:last-child .spcta`);
check("THE THIRD FIX: the sponsorship ask is not a mailto in the shell",
      !!ask && !ask.getAttribute("href").startsWith("mailto:"),
      "open_external allow-lists two https hosts and wry does nothing with a mailto");
const asking = click(ask);
check("...so that one opens too", asking.handed.length === 1, asking.handed[0]?.args?.url);

/* ---- what must NOT be intercepted --------------------------------------- */
const own = document.createElement("a");
own.href = "./app.html";
own.textContent = "same origin";
document.body.appendChild(own);
const internal = click(own);
check("a link inside the app is left alone", !internal.handed.length && !internal.prevented,
      "the webview serves these itself");

const modified = click(guideLink, { ctrlKey: true });
check("a modifier click is left alone", !modified.handed.length,
      "it asks for a new window, and there is none to open");

const dead = document.createElement("a");
dead.textContent = "no href";
document.body.appendChild(dead);
check("an anchor with no href is not a link", !click(dead).handed.length);

/* ---- the shell is the other half, and it is a different language -------- */
const MAIN_RS = readFileSync(new URL("../../desktop/src-tauri/src/main.rs", import.meta.url), "utf8");

check("the command the webview calls exists in the shell",
      /fn open_external/.test(MAIN_RS) && /open_external\s*\n?\s*\]/.test(MAIN_RS),
      "declared AND in generate_handler! — a command missing from the list is not reachable");

const allowed = (MAIN_RS.match(/HOSTS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "")
  .match(/"([^"]+)"/g)?.map(s => s.slice(1, -1)) ?? [];
const refused = [...new Set([...Object.values(LINKS), SITE.APP_URL])]
  .map(u => new URL(u).host)
  .filter(host => !allowed.includes(host));

check("THE CROSS-LANGUAGE INVARIANT: the shell opens every host the app links to",
      allowed.length > 0 && refused.length === 0,
      refused.length ? `refused: ${refused.join(", ")}` : allowed.join(" · "));

/* ---- and the web is untouched ------------------------------------------- */
let webClean = false;
try {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--as-web"], { stdio: "pipe" });
  webClean = true;
} catch { /* non-zero exit means it interfered */ }
check("a browser still opens its own links", webClean);

console.log("\n" + "=".repeat(58));
console.log(`LINKS: ${pass}/${pass + fail} passed`);
console.log("=".repeat(58) + "\n");
process.exit(fail ? 1 : 0);
