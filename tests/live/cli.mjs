/**
 * The CLI, end to end, against a real relay.
 *
 * Two processes, real crypto, a real socket — the same shape as tests/live/e2e.mjs
 * but through the command line, because the CLI's whole claim is that it is the
 * browser's code with a different front door. The thing worth testing is
 * therefore not the protocol (e2e.mjs owns that) but that the front door does
 * not corrupt anything on the way past: exit codes, stdout/stderr separation,
 * multi-line payloads, and locked rooms.
 *
 *   node tests/live/cli.mjs [ws_base]     default: the deployed relay
 *
 * Skips cleanly if no relay answers, so it is safe in CI and in a hook.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(REPO, "cli/realtimeclipboard.mjs");

// Read, not restated. These assertions used to spell the lengths as 6 and 10,
// so raising the keyspace failed a test that was checking the old constant
// against the new generator rather than checking anything about the CLI.
const { KEY } = await import(
  new URL("../../src/core/config.js", import.meta.url).href);
const BASE = process.argv[2] || process.env.RELAY_BASE
  || "wss://realtimeclipboard.fastapicloud.dev";
const HTTP = BASE.replace(/^ws/i, "http");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
};

console.log("\nCLI\n");

try {
  const res = await fetch(`${HTTP}/health`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.log(`\nSKIP: no relay at ${HTTP}  (${err.message})\n`);
  process.exit(0);
}

/** Run the CLI to completion. `input` is written to stdin, then closed. */
function run(args, { input = null, killAfter = 0 } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args, "--relay", BASE],
      { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    if (input !== null) p.stdin.end(input); else p.stdin.end();
    if (killAfter) setTimeout(() => p.kill("SIGINT"), killAfter);
    p.on("close", code => resolve({ code, out, err }));
  });
}

const newKey = async () => (await run(["new"])).out.trim();

/* ---------- arguments and exit codes ---------- */

const bad = await run(["send", "!!!"], { input: "x" });
check("an invalid key exits 2", bad.code === 2, `code ${bad.code}`);
// Asserted on shape, not wording. This pinned the literal "not a valid key" and
// went red when keys.rejectMessage() started explaining WHY a key was refused —
// a better message failing a test that was checking the old string. What a pipe
// actually depends on is that the reason names the key, reaches stderr, and
// leaves stdout clean for clip content.
check("and says so on stderr, not stdout",
  bad.err.includes("!!!") && /key|character/i.test(bad.err) && bad.out === "");

const unknown = await run(["--nope"]);
check("an unknown option exits 2", unknown.code === 2, `code ${unknown.code}`);

const key = await newKey();
const longKey = (await run(["new", "--long"])).out.trim();
check("`new` prints one usable key",
  new RegExp(`^[0-9A-Z]{${KEY.LENGTH}}$`).test(key), `${key} (want ${KEY.LENGTH})`);
check("`new --long` is longer",
  new RegExp(`^[0-9A-Z]{${KEY.LONG_LENGTH}}$`).test(longKey)
    && KEY.LONG_LENGTH > KEY.LENGTH, `${longKey} (want ${KEY.LONG_LENGTH})`);

/* ---------- a clip crosses between two processes ----------
   Multi-line and non-ASCII on purpose: the payload goes through base64, JSON,
   AES-GCM and a pipe, and any of those is a plausible place to lose a newline
   or mangle UTF-8. */
const PAYLOAD = "line one\nline two\ttabbed\nunicode: café ✓ 日本語";

const room = await newKey();
const watcher = run(["watch", room, "--once", "--json", "--timeout", "45"]);
await new Promise(r => setTimeout(r, 5000));          // let it join first
const sent = await run(["send", room, "--timeout", "30"], { input: PAYLOAD });
check("send exits 0", sent.code === 0, `code ${sent.code}  ${sent.err.trim()}`);

const seen = await watcher;
check("watch exits 0 after --once", seen.code === 0, `code ${seen.code}`);

let parsed = null;
try { parsed = JSON.parse(seen.out.trim()); } catch { /* reported below */ }
check("--json emits one parseable object per clip", parsed !== null, seen.out.slice(0, 120));
check("the text survives the round trip byte for byte",
  parsed?.text === PAYLOAD,
  parsed ? JSON.stringify(parsed.text) : "");
check("the relay's sequence number is reported", typeof parsed?.seq === "number", `seq=${parsed?.seq}`);
check("status goes to stderr, clip content to stdout",
  seen.err.includes("connected") && !seen.out.includes("connected"));

/* ---------- locked rooms ----------
   The security property, at the CLI: the same key with the wrong PIN is a
   DIFFERENT room, not the same room with unreadable contents. So the wrong-PIN
   watcher must time out having seen nothing, rather than print anything. */
const lockKey = await newKey();
const PIN = "correct-horse";
const locked = run(["watch", lockKey, "--pin", PIN, "--once", "--timeout", "45"]);
const wrong = run(["watch", lockKey, "--pin", "battery-staple", "--once", "--timeout", "18"]);
await new Promise(r => setTimeout(r, 6000));
await run(["send", lockKey, "--pin", PIN, "--timeout", "30"], { input: "locked payload" });

const lockedSeen = await locked;
check("the right PIN reads the clip", lockedSeen.out.trim() === "locked payload",
  JSON.stringify(lockedSeen.out.trim()));

const wrongSeen = await wrong;
check("the wrong PIN reads nothing at all", wrongSeen.out.trim() === "",
  JSON.stringify(wrongSeen.out.slice(0, 80)));
check("and times out rather than hanging forever", wrongSeen.code === 5, `code ${wrongSeen.code}`);
check("the lock beacon is never printed as a clip",
  !lockedSeen.out.includes("realtimeclipboard-lock-v1") && !wrongSeen.out.includes("realtimeclipboard-lock-v1"));

console.log("\n" + "=".repeat(56));
console.log(`CLI: ${pass}/${pass + fail} passed`);
console.log("=".repeat(56));
process.exit(fail ? 1 : 0);
