/**
 * Boot the real app in a DOM and confirm it reaches a connected state.
 *
 * This closes the gap e2e.mjs leaves. e2e proves the transport works by
 * driving it directly; this proves boot() actually GETS to the transport.
 *
 * It exists because it caught exactly that failure: an unguarded
 * `install.init()` threw, the exception escaped boot(), openSession() never
 * ran, and the app silently never connected. Every isolated test passed. The
 * only symptom was "Not connected" in the status bar.
 *
 *   node tests/live/boot.mjs [ws_base]            open session, must CONNECT
 *   node tests/live/boot.mjs [ws_base] --locked    locked link, must NOT connect
 *   node tests/live/boot.mjs [ws_base] --qr        ?qr=1 must open the code
 *
 * The --locked run guards the invariant that is easiest to lose and worst to
 * lose silently: a link marked locked must not open a socket until the PIN has
 * been given. If that ever regresses, the app quietly joins the UNLOCKED room
 * of the same name — a real room, readable by anyone holding the link — while
 * telling the user they are in a private session. Here the prompt is never
 * answered, so "still idle" is the pass condition.
 */

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // jsdom is deliberately not a project dependency — the app ships with no
  // npm install at all. Skip rather than fail so this is safe to run anywhere.
  console.log("\nSKIP: boot test needs jsdom  (npm i -D jsdom)\n");
  process.exit(0);
}

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCKED = process.argv.includes("--locked");
/* The QR deep link is checked HERE and not in a unit test because the bug it
   guards was one of boot ORDER, not of logic: startSession() is deliberately not
   awaited, so the handler used to test for a key once, find none, and return.
   Only a real boot can tell whether it now waits. */
const QR = process.argv.includes("--qr");
const RELAY = process.argv.find(a => a.startsWith("ws")) || process.env.RELAY_BASE
  || "wss://realtimeclipboard.fastapicloud.dev";

/**
 * The relay goes in the URL, because that is the only way to actually move it.
 *
 * RELAY above used to feed nothing but the log line below: the app resolves its
 * relay from core/config.js at import time, so this test printed one address
 * and connected to another. That was invisible while the two happened to
 * agree, and became "CONNECTED: NO against a relay I am running right here"
 * the moment they did not.
 *
 * `?relay=` is the mechanism the app already has for exactly this, so pointing
 * the test with it exercises that path rather than adding a test-only hook.
 */
const dom = new JSDOM(readFileSync(join(REPO, "app.html"), "utf8"), {
  url: `https://realtimeclipboard.com/app.html`
     + `?relay=${encodeURIComponent(RELAY)}${QR ? "&qr=1" : ""}`
     + `#${LOCKED ? "!" : ""}BOOTTEST`,
  pretendToBeVisual: true,
});
const { window } = dom;

// navigator is getter-only in Node 24, so globals need defineProperty.
const put = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

global.window = window;
global.document = window.document;
global.location = window.location;
put("navigator", window.navigator);
global.localStorage = window.localStorage;
global.sessionStorage = window.sessionStorage;
// Node's own `performance`, NOT jsdom's. undici — the fetch built into Node —
// calls performance.markResourceTiming() when a request finishes, and jsdom's
// implementation has no such method, so replacing the global kills the process
// with "markResourceTiming is not a function" the moment the app fetches
// anything. It surfaced when the bundled app started loading changelog.json.
// The app itself only ever calls performance.now(), which Node has.
Object.defineProperty(window, "performance",
  { value: globalThis.performance, configurable: true });
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.CustomEvent = window.CustomEvent;
global.WebSocket = globalThis.WebSocket;
put("crypto", globalThis.crypto);
if (!window.crypto?.subtle) {
  Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true });
}

/**
 * Same-origin requests are served from the tree under test, not from the
 * internet.
 *
 * jsdom is told the page's URL is the production origin, so every relative
 * fetch the app makes — changelog.json is the only one today — resolved to a
 * PUBLIC address and went out over the network. A test that boots local files
 * was quietly asking production for one of its assets.
 *
 * That was invisible for as long as the origin happened to answer: the request
 * 404'd in milliseconds and whatsNew.js's own error path swallowed it. It
 * stopped being invisible the day the site moved to realtimeclipboard.com,
 * because DNS for a freshly bought domain does not resolve yet — and undici
 * does not merely reject on a resolver error, it reports timings first and
 * takes the whole process down from inside Node's own internals, with a stack
 * that names neither this file nor the app. The `performance` note above is the
 * other half of the same seam.
 *
 * Pinning it to disk is also just more correct. This asserts things about THIS
 * working tree; silently checking the deployed site's changelog.json instead
 * was never what it meant to do.
 */
const ORIGIN = window.location.origin;
const netFetch = globalThis.fetch;
put("fetch", (input, init) => {
  const url = new URL(String(input?.url ?? input), ORIGIN);
  // Anything genuinely remote — the relay's /stats, say — still goes out.
  if (url.origin !== ORIGIN) return netFetch(input, init);
  const file = join(REPO, decodeURIComponent(url.pathname));
  return Promise.resolve(existsSync(file)
    ? new Response(readFileSync(file), { status: 200 })
    : new Response("not found", { status: 404 }));
});
window.fetch = globalThis.fetch;

// jsdom has no clipboard API. The app must degrade rather than crash — which
// is itself part of what this asserts.
Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });

const log = [];
for (const level of ["warn", "error", "info"]) {
  const original = console[level];
  console[level] = (...a) => { log.push([level, a.join(" ")]); original(...a); };
}

console.log("\nBooting the real app against " + RELAY + "\n");

const states = [];
const bus = await import(pathToFileURL(join(REPO, "src/core/bus.js")).href);
bus.on(bus.EV.CONN_STATE, ({ state, detail }) => {
  states.push(state);
  console.log("  conn -> " + state + (detail ? " (" + detail + ")" : ""));
});
bus.on(bus.EV.PEERS_CHANGED, ({ count }) => console.log("  peers -> " + count));

const started = Date.now();
await import(pathToFileURL(join(REPO, "src/main.js")).href);
window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

await new Promise(r => setTimeout(r, 12000));

const connected = states.includes("connected");
// The modal mounts on document.body with .qrmodal — see ui/features/qr.js, which
// deliberately avoids #mount-modals because filesPanel.js rewrites that node.
const qrShown = Boolean(window.document.querySelector(".qrmodal"));
const reachedEnd = log.some(([lvl, m]) => lvl === "info" && m.includes("booted"));

// A locked link must never reach the relay unprompted, and must never quietly
// derive an OPEN session for the same key as a fallback.
const openedARoom = log.some(([lvl, m]) => lvl === "info" && m.includes("locked=false"));

console.log("\n" + "=".repeat(60));
console.log("  reached end of boot():  " + (reachedEnd ? "YES" : "NO"));
console.log("  states:                 " + (states.join(" -> ") || "(none)"));
console.log("  CONNECTED:              " + (connected ? "YES" : "NO") +
            "  (" + (Date.now() - started) + " ms)");
if (LOCKED) {
  console.log("  opened an open room:    " + (openedARoom ? "YES — DOWNGRADED" : "no"));
  console.log("  expected:               idle, waiting for the PIN");
}
if (QR) {
  console.log("  ?qr=1 opened the code:  " + (qrShown ? "YES" : "NO"));
  console.log("  expected:               YES — and it must survive the session");
  console.log("                          not being ready when boot() ends");
}

const problems = log.filter(([lvl]) => lvl === "warn" || lvl === "error");
if (problems.length) {
  console.log("\n  contained failures (did not stop the session):");
  problems.forEach(([lvl, m]) => console.log("    [" + lvl + "] " + m.slice(0, 150)));
}
console.log("=".repeat(60));

const ok = LOCKED
  ? (reachedEnd && !connected && !openedARoom)
  : (reachedEnd && connected && (!QR || qrShown));
process.exit(ok ? 0 : 1);
