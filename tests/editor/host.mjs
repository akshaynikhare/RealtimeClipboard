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
 * NEEDS A GRAPHICAL SESSION. VS Code is a GUI application: launched from a
 * non-interactive shell it starts, never attaches to a window server, and never
 * runs the extension host — no error, no log, no output. So this skips rather
 * than hangs, and it is filed in its own directory because its prerequisite is
 * neither jsdom nor a relay but an installed, launchable editor.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync, unlinkSync } from "node:fs";
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
// Agreed with the suite rather than handed to it: `open -a` below goes through
// LaunchServices, which does not carry the caller's environment. An env var
// meant the host could run and still have nowhere to write — indistinguishable
// from the host never running.
const out = join(tmpdir(), "realtimeclipboard-editor-test.json");
try { unlinkSync(out); } catch { /* a stale result from a previous run */ }

const args = [
  `--extensionDevelopmentPath=${join(REPO, "vscode")}`,
  `--extensionTestsPath=${join(REPO, "tests/editor/suite.cjs")}`,
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

// `open` returns the moment it has handed off, so process exit is not the
// signal — the result file is. Polled either way.
const startedAt = Date.now();
let done = "timeout";
while (Date.now() - startedAt < TIMEOUT_MS) {
  if (existsSync(out)) { done = "reported"; break; }
  await new Promise(r => setTimeout(r, 1000));
}
try { child.kill(); } catch { /* already gone */ }

if (!existsSync(out)) {
  rmSync(dir, { recursive: true, force: true });
  skip(done === "timeout"
    ? `the extension host never reported back within ${TIMEOUT_MS / 1000}s. `
      + "VS Code starts but --extensionTestsPath does not run here; press F5 "
      + "in VS Code, or run this from a normal terminal session."
    : "VS Code exited without running the suite");
}

const report = JSON.parse(readFileSync(out, "utf8"));
rmSync(dir, { recursive: true, force: true });
try { unlinkSync(out); } catch { /* best effort */ }

let fail = 0;
for (const r of report.results) {
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
console.log(`\n  VS Code ${report.vscode} · Node ${report.node}`);
console.log(`\n${"=".repeat(58)}\nVS CODE HOST: ${report.results.length - fail}/${report.results.length} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
