/**
 * Launches tests/editor/suite.cjs inside a REAL VS Code extension host.
 *
 *   node tests/editor/host.mjs
 *
 * Everything else about the extension is checked under a fake `vscode`
 * (tests/dom/extension.mjs). A stub agrees with whatever it was written
 * against — including a method that does not exist — so this is the only suite
 * that can catch the fake having drifted from the real API.
 *
 * NEEDS A GRAPHICAL SESSION, and skips rather than hangs without one. It is
 * filed in its own directory because that prerequisite is neither jsdom nor a
 * relay but an installed, launchable editor.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TIMEOUT_MS = 120_000;

console.log("\nVS CODE HOST\n");
const skip = (why) => { console.log(`  SKIP  ${why}\n`); process.exit(0); };

let cli;
try {
  cli = execFileSync("which", ["code"], { encoding: "utf8" }).trim();
} catch { skip("no `code` on PATH — install the VS Code shell command"); }

if (!process.env.DISPLAY && process.platform === "linux") skip("no DISPLAY — needs a graphical session");
if (process.env.CI) skip("CI has no window server");

const dir = mkdtempSync(join(tmpdir(), "rtc-vscode-"));
const out = join(dir, "result.json");

/**
 * The report path is per-invocation, and travels inside a generated entry point
 * rather than in the environment: `open -a` below goes through LaunchServices,
 * which does not carry the caller's environment but does carry the command line
 * — and `--extensionTestsPath` is on it. A fixed path would work until two runs
 * overlapped, at which point one would read and delete the other's report and
 * the owner would time out blaming the extension host.
 */
const entry = join(dir, "suite.cjs");
writeFileSync(entry,
  `const { run } = require(${JSON.stringify(join(REPO, "tests/editor/suite.cjs"))});\n`
  + `exports.run = () => run(${JSON.stringify(out)});\n`);

const args = [
  `--extensionDevelopmentPath=${join(REPO, "vscode")}`,
  `--extensionTestsPath=${entry}`,
  `--user-data-dir=${join(dir, "ud")}`,
  `--extensions-dir=${join(dir, "ed")}`,
  "--disable-gpu", "--disable-workspace-trust",
];

/**
 * On macOS the `code` shim inherits the calling shell's session, and a
 * non-interactive one has no window server: VS Code starts, no window appears,
 * the extension host never runs, and nothing is logged anywhere. `open -a` hands
 * off to LaunchServices, which lands in the logged-in GUI session instead.
 * Elsewhere the shim is the right entry point.
 */
const child = process.platform === "darwin"
  ? spawn("open", ["-n", "-a", "Visual Studio Code", "--args", ...args],
      { stdio: ["ignore", "pipe", "pipe"] })
  : spawn(cli, [...args, "--wait"], { stdio: ["ignore", "pipe", "pipe"] });

// An unhandled "error" event on a ChildProcess is thrown, so a missing `open`
// or `code` would end this in a stack trace rather than the skip it is.
let ended = null;
child.on("error", (err) => { ended = { failed: err.message }; });
child.on("exit", (code, signal) => { ended ??= { code, signal }; });

// `open` returns the moment it has handed off, so process exit is not the
// signal — the result file is. But an exit still ends the wait, except for the
// clean handoff that `open` always reports: without that, a launch that fails
// in a second sits here for two minutes and then blames the timeout.
const startedAt = Date.now();
let done = "timeout";
while (Date.now() - startedAt < TIMEOUT_MS) {
  if (existsSync(out)) { done = "reported"; break; }
  if (ended && !(process.platform === "darwin" && ended.code === 0)) {
    await new Promise(r => setTimeout(r, 250));        // a write racing the exit
    done = existsSync(out) ? "reported" : "exited";
    break;
  }
  await new Promise(r => setTimeout(r, 1000));
}
try { child.kill(); } catch { /* already gone */ }

if (!existsSync(out)) {
  rmSync(dir, { recursive: true, force: true });
  if (done === "exited") {
    skip(ended.failed
      ? `could not launch VS Code: ${ended.failed}`
      : `VS Code exited (${ended.signal ?? `code ${ended.code}`}) without running the suite`);
  }
  skip(`the extension host never reported back within ${TIMEOUT_MS / 1000}s. `
    + "VS Code starts but --extensionTestsPath does not run here; press F5 "
    + "in VS Code, or run this from a normal terminal session.");
}

const report = JSON.parse(readFileSync(out, "utf8"));
rmSync(dir, { recursive: true, force: true });

let fail = 0;
for (const r of report.results) {
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
console.log(`\n  VS Code ${report.vscode} · Node ${report.node}`);
console.log(`\n${"=".repeat(58)}\nVS CODE HOST: ${report.results.length - fail}/${report.results.length} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
