/**
 * Load the built site in real Chromium and fail on any CSP or Trusted Types
 * violation.
 *
 * tests/unit/static-check.mjs proves the policy is PRESENT and self-consistent, and
 * tests/dom/bundle.mjs proves the bundle boots — but both run in Node, where no
 * policy is enforced. Nothing in the repo actually exercises the CSP. A policy
 * that is too strict does not fail a build; it fails a user, silently, in the
 * one browser tier the product targets.
 *
 * Not part of `npm test`: it needs a browser and a port. Run it before shipping
 * a change to a CSP directive, and after any change to how HTML is written.
 *
 *   node tools/build/build.mjs _site
 *   node tools/check/csp-check.mjs
 */

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = join(ROOT, "_site");
const PORT = 8099;

if (!existsSync(join(SITE, "app.html"))) {
  console.error("No _site — run `node tools/build/build.mjs _site` first.");
  process.exit(1);
}

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
  // macOS was missing until 2026-09-04, so this check skipped rather than ran
  // on every Mac — and a skip prints green. It is the only gate that loads the
  // real CSP in a real browser.
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const browser = BROWSERS.find(existsSync);
if (!browser) { console.log("\nSKIP: no Chromium found\n"); process.exit(0); }

/* ---------- serve _site ---------- */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".xml": "application/xml",
  ".map": "application/json", ".md": "text/plain", ".txt": "text/plain",
};

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let file = join(SITE, p);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) { res.writeHead(404).end("no"); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

/* ---------- drive the browser ---------- */

const profile = mkdtempSync(join(tmpdir(), "realtimeclipboard-csp-"));
const proc = spawn(browser, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=9223", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

/**
 * Noise this harness creates for itself, and which is not a policy finding:
 *   - no relay is running, so the transport fails as designed;
 *   - the pages declare no favicon, so Chromium asks for /favicon.ico and 404s.
 * Both would otherwise mask a real violation behind expected red.
 */
const EXPECTED = [
  /ws:\/\/127\.0\.0\.1:8000/,
  /favicon\.ico/,
  /Failed to load resource.*404/,
];
const expected = t => EXPECTED.some(re => re.test(t));

const violations = [];
const consoleErrors = [];
let failed = false;

try {
  const target = await waitForTarget();
  const ws = new WebSocket(target);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });

  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise(r => {
    const n = ++id;
    pending.set(n, r);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === "Log.entryAdded") {
      const { source, level, text, url } = msg.params.entry;
      if (source === "security" || /Content Security Policy|Trusted Type/i.test(text)) {
        violations.push(`${text}${url ? `  (${url})` : ""}`);
      } else if (level === "error" && !expected(text)) {
        consoleErrors.push(text);
      }
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description
        ?? msg.params.exceptionDetails.text);
    }
  };

  await send("Log.enable");
  await send("Runtime.enable");
  await send("Page.enable");

  for (const path of ["/index.html", "/app.html#CSPTEST", "/help/", "/about/",
                    "/contact/", "/terms/", "/download/", "/help/install/"]) {
    violations.length = 0; consoleErrors.length = 0;
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}${path}` });
    await new Promise(r => setTimeout(r, 3500));

    const bad = violations.length || consoleErrors.length;
    if (bad) failed = true;
    console.log(`  ${bad ? "FAIL" : "PASS"}  ${path}`);
    for (const v of violations) console.log(`          CSP  ${v.slice(0, 200)}`);
    for (const c of consoleErrors) console.log(`          ERR  ${c.slice(0, 200)}`);
  }

  // The policy must actually be ON, not merely present: if the meta tag were
  // malformed the browser would ignore it and every check above would pass for
  // the wrong reason. Injecting a script the policy forbids must throw.
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/app.html#CSPTEST` });
  await new Promise(r => setTimeout(r, 2500));
  const probe = await send("Runtime.evaluate", {
    expression: `(() => { try { document.createElement("div").innerHTML = "<i>x</i>"; return "ALLOWED"; }
                          catch (e) { return "BLOCKED: " + e.name; } })()`,
    returnByValue: true,
  });
  const verdict = probe?.result?.value ?? "(no result)";
  const enforced = String(verdict).startsWith("BLOCKED");
  if (!enforced) failed = true;
  console.log(`  ${enforced ? "PASS" : "FAIL"}  Trusted Types is enforced  — raw innerHTML: ${verdict}`);

  ws.close();
} finally {
  proc.kill();
  server.close();
  // Best effort: Chromium holds file handles briefly after SIGKILL, and a
  // leftover temp profile is not worth failing a security check over.
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
}

console.log("\n" + "=".repeat(56));
console.log(failed ? "CSP CHECK: violations found" : "CSP CHECK: clean");
console.log("=".repeat(56) + "\n");
process.exit(failed ? 1 : 0);

async function waitForTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9223/json/list");
      const page = (await res.json()).find(t => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Chromium did not expose a debugging target");
}
