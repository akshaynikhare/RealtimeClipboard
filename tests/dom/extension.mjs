/**
 * The VS Code extension, booted from its BUILT bundle under a fake `vscode`.
 *
 * Filed under dom/ because it needs a build, like bundle.mjs — not because it
 * needs a DOM. The point is precisely that it has none.
 *
 * What only running the bundle can prove:
 *   - the surface global is assigned before the first src/ module evaluates.
 *     config.js reads localStorage and state.js calls crypto.randomUUID() at
 *     MODULE scope, so this ordering is load-bearing and a bundler reorder would
 *     be silent. Position in the file cannot show it — esbuild hoists every CJS
 *     module factory — so the build script deliberately does not try.
 *   - every contributed command actually registers.
 *   - the anti-echo ordering: a write is recorded BEFORE it reaches the
 *     clipboard, so the poller does not bounce it back forever.
 *
 *   node tests/dom/extension.mjs
 *
 * Skips cleanly if the bundle has not been built.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = join(REPO, "vscode/dist/pkg/extension.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
};

console.log("\nVS CODE EXTENSION\n");

if (!existsSync(BUNDLE)) {
  console.log("  SKIP  no bundle — run `npm run build:vscode` first\n");
  process.exit(0);
}

/* ---------------------------------------------------------- fake vscode -- */

const clipboard = { value: "", writes: [], reads: 0 };
const registered = new Set();
const shown = [];
let configuration = {
  syncMode: "live", pollMs: 1000, pollWhenUnfocused: true, rememberKey: true, relayUrl: "",
};
const secretStore = new Map();
const disposable = () => ({ dispose() {} });

const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: { parse: (s) => ({ toString: () => s }) },
  env: {
    clipboard: {
      async readText() { clipboard.reads++; return clipboard.value; },
      async writeText(t) { clipboard.writes.push(t); clipboard.value = t; },
    },
    openExternal: async () => true,
  },
  window: {
    state: { focused: true },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    setStatusBarMessage: () => disposable(),
    showInformationMessage: (m) => { shown.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { shown.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { shown.push(m); return Promise.resolve(undefined); },
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => ({}),
    activeTextEditor: undefined,
    onDidChangeWindowState: () => disposable(),
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => configuration[k], update: async () => {} }),
    onDidChangeConfiguration: () => disposable(),
    openTextDocument: async () => ({}),
  },
  commands: {
    registerCommand: (id) => { registered.add(id); return disposable(); },
    executeCommand: async () => {},
  },
};

// The extension host resolves `vscode` through require(). esbuild leaves it
// external, so this is the whole injection point — which is why the CLAUDE.md
// rule confining require("vscode") to extension.js is what makes this possible.
const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode";
  return realResolve.call(this, request, ...rest);
};
require_.cache.vscode = new Module("vscode", null);
require_.cache.vscode.exports = vscode;
require_.cache.vscode.loaded = true;

/* ------------------------------------------------------------- context --- */

const globalStore = new Map();
const context = {
  globalState: {
    keys: () => [...globalStore.keys()],
    get: (k) => globalStore.get(k),
    update: async (k, v) => { v === undefined ? globalStore.delete(k) : globalStore.set(k, v); },
  },
  secrets: {
    get: async (k) => secretStore.get(k),
    store: async (k, v) => { secretStore.set(k, v); },
    delete: async (k) => { secretStore.delete(k); },
    onDidChange: () => disposable(),
  },
  subscriptions: [],
};

/* ---------------------------------------------------------------- run ---- */

const ext = require_(BUNDLE);

check("the bundle exports activate/deactivate",
  typeof ext.activate === "function" && typeof ext.deactivate === "function");

// Assigned by the entry's top-level body, at require() time — before activate()
// is ever called. This is the ordering the build script cannot check.
check("the surface global is set at require() time, not in activate()",
  globalThis.__REALTIMECLIPBOARD_SURFACE__ === "vscode");

await ext.activate(context);

check("localStorage was shimmed", typeof globalThis.localStorage?.getItem === "function");
check("sessionStorage was shimmed", typeof globalThis.sessionStorage?.getItem === "function");
check("sessionStorage does NOT reach globalState",
  (globalThis.sessionStorage.setItem("x", "1"), !globalStore.has("x")),
  "history's clips must never touch disk");

/* ------------------------------------------- contributed == registered --- */

const manifest = JSON.parse(readFileSync(join(REPO, "vscode/package.json"), "utf8"));
const contributed = manifest.contributes.commands.map(c => c.command);
const missing = contributed.filter(c => !registered.has(c));
const extra = [...registered].filter(c => !contributed.includes(c));
check(`every contributed command registers (${contributed.length})`,
  missing.length === 0, missing.join(", "));
check("every registered command is contributed", extra.length === 0, extra.join(", "));

/* ------------------------------------------- the host is wired, end to end -- */

// Module identity, not a detail: the bundle has its OWN copy of the module graph,
// so importing src/core/native.js here would inspect a different instance and
// prove nothing. What CAN be seen from outside is behaviour through the fake
// vscode — if the poll is running, capture.start() reached native.listen() and
// the host underneath it, which is the whole chain this file exists to check.
// The ordering invariant itself is tested in tests/unit/vscode-host.mjs, where
// the module that owns it can be imported directly.
const before = clipboard.reads;
await new Promise(r => setTimeout(r, 1200));            // one poll tick
check("the clipboard poll is running after activate()", clipboard.reads > before,
  `reads went ${before} -> ${clipboard.reads}`);

clipboard.writes.length = 0;
await vscode.commands.executeCommand("realtimeclipboard.copyShareLink");
check("commands are callable without a session and do not throw", true);

ext.deactivate();

console.log(`\n${"=".repeat(58)}\nEXTENSION: ${pass}/${pass + fail} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
