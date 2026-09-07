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
const TIMEOUT_MS = 150_000;  // per launcher, and there are at most two. The one
                             // observed success took 88s on a cold user-data-dir.

console.log("\nVS CODE HOST\n");
const skip = (why) => { console.log(`  SKIP  ${why}\n`); process.exit(0); };

let cli;
try {
  cli = execFileSync("which", ["code"], { encoding: "utf8" }).trim();
} catch { skip("no `code` on PATH — install the VS Code shell command"); }

if (!process.env.DISPLAY && process.platform === "linux") skip("no DISPLAY — needs a graphical session");
if (process.env.CI) skip("CI has no window server");

/**
 * VS Code keeps writing to its user-data-dir for a moment after the report
 * lands, so a bare rmSync races its leveldb and throws ENOTEMPTY — turning a
 * passing suite into a stack trace. A temp directory nobody deletes is a far
 * smaller problem than that, so this retries and then gives up quietly.
 */
/**
 * Killing the launcher does not close what it launched: the `code` shim hands
 * off to a detached Electron and exits, so a bare child.kill() leaves a full VS
 * Code — main process, renderer and half a dozen helpers — running per
 * invocation. Nineteen of them accumulated before anyone noticed, and the next
 * run then failed with a SIGTERM that looked like a launch fault.
 *
 * `dir` is this invocation's mkdtemp path and appears in the argv of everything
 * this run started and of nothing else, which is what makes a pattern kill safe
 * here — a match on "Visual Studio Code" would take the editor you are reading
 * this in.
 */
const closeLaunched = () => {
  try { execFileSync("pkill", ["-f", dir], { stdio: "ignore" }); }
  catch { /* pkill exits 1 when nothing matched, which is the good case */ }
};

const discard = (d) => {
  try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch { /* the OS will reap it */ }
};

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
 * Two ways in on macOS, tried in this order, because neither works everywhere.
 *
 * The shim is first: it holds the run open with `--wait`, so an exit is a real
 * signal and a failure is on stderr. `open -a` reports success the instant
 * LaunchServices accepts the handoff and says nothing afterwards, which makes
 * every failure look identical to a timeout — and it is what this file used to
 * do *exclusively*, which is why the suite had never once run here.
 *
 * `open -a` stays as the fallback for the case it genuinely covers: a shell
 * with no window server of its own, where the shim starts VS Code, no window
 * appears, the extension host never runs and nothing is logged anywhere.
 * LaunchServices lands in the logged-in GUI session instead.
 */
/**
 * A child VS Code must not inherit a parent VS Code's environment.
 *
 * Run this from an integrated terminal — or from anything living on the
 * extension host, which is how it is usually reached — and `VSCODE_PID`,
 * `VSCODE_IPC_HOOK`, `VSCODE_CODE_CACHE_PATH` and above all
 * `VSCODE_ESM_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess` are all
 * set. The new instance reads them, believes it is already somebody's extension
 * host, and never reaches `--extensionTestsPath`. It does not crash and it logs
 * nothing: it just sits there until the timeout, which reads exactly like "this
 * machine has no window server" and is why that was the standing diagnosis.
 *
 * `ELECTRON_RUN_AS_NODE=1` is in the same set and is the most dangerous of them,
 * because it is what the `code` shim sets deliberately for its own process.
 */
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^(VSCODE_|ELECTRON_|NODE_OPTIONS$)/.test(k)));

const LAUNCHERS = process.platform === "darwin"
  ? [
      () => spawn("open", ["-n", "-a", "Visual Studio Code", "--args", ...args],
        { stdio: ["ignore", "pipe", "pipe"], env }),
      () => spawn(cli, [...args, "--wait"], { stdio: ["ignore", "pipe", "pipe"], env }),
    ]
  : [() => spawn(cli, [...args, "--wait"], { stdio: ["ignore", "pipe", "pipe"], env })];

let done = "timeout";
let ended = null;

for (const launch of LAUNCHERS) {
  const child = launch();
  /**
   * Per attempt, never shared. `child.kill()` below is asynchronous, so the
   * previous attempt's "exit" fires while this one is already waiting — and a
   * single `ended` binding hands attempt two the SIGTERM that ended attempt
   * one, which aborts it in the first second and reports the wrong cause.
   *
   * An unhandled "error" event on a ChildProcess is thrown, so a missing `open`
   * or `code` lands here rather than in a stack trace.
   */
  const state = { ended: null };
  child.on("error", (err) => { state.ended = { failed: err.message }; });
  child.on("exit", (code, signal) => { state.ended ??= { code, signal }; });

  // The result file is the signal, not process exit — `open` returns on handoff,
  // and the shim's own exit races the extension host's last write. An exit still
  // ends the wait, except for the clean handoff `open` always reports: without
  // that exemption a launch that fails in a second sits here for the whole
  // budget and then blames the timeout.
  const startedAt = Date.now();
  done = "timeout";
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (existsSync(out)) { done = "reported"; break; }
    if (state.ended && !(process.platform === "darwin" && state.ended.code === 0)) {
      await new Promise(r => setTimeout(r, 250));      // a write racing the exit
      done = existsSync(out) ? "reported" : "exited";
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  try { child.kill(); } catch { /* already gone */ }
  ended = state.ended;
  if (done === "reported") break;
  closeLaunched();                 // a failed attempt must not leave an editor open
}
closeLaunched();

if (!existsSync(out)) {
  discard(dir);
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
discard(dir);

let fail = 0;
for (const r of report.results) {
  if (!r.ok) fail++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
console.log(`\n  VS Code ${report.vscode} · Node ${report.node}`);
console.log(`\n${"=".repeat(58)}\nVS CODE HOST: ${report.results.length - fail}/${report.results.length} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
