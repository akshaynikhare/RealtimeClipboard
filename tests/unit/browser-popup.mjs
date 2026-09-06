/**
 * browser/src/popup.js — the worker not answering.
 *
 * The worker is evicted after ~30s idle (browser/CLAUDE.md), and a wake can
 * fail or the context be invalidated. `chrome.runtime.sendMessage` then
 * resolves undefined or rejects. Every handler in the popup reads a field off
 * that reply, so the popup died on a TypeError before it could render the one
 * string written for this case — and the status was left on "…", which tells
 * the reader nothing at all.
 *
 * Run rather than grepped: the bug was that a line threw, and only executing it
 * proves it no longer does. The popup imports nothing, so it runs in a vm over
 * a fake DOM and a fake `chrome` — what is under test is its handling of a
 * reply, not Chrome's messaging.
 *
 *   node tests/unit/browser-popup.mjs
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
};

console.log("\nBROWSER POPUP\n");

const SRC = readFileSync(new URL("../../browser/src/popup.js", import.meta.url), "utf8");
const NO_ANSWER = "No answer from the extension. Try again.";

/** Boots the popup against a `sendMessage` that behaves however the test says. */
async function boot(sendMessage) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: "", hidden: false, value: "", focus() {} });
    return els.get(id);
  };
  const ctx = {
    document: { getElementById: el },
    chrome: { runtime: { sendMessage } },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
  };
  runInNewContext(SRC, ctx);
  // render() is in flight; let its await chain settle.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { status: () => el("status").textContent, el };
}

/* ------------------------------------------------ the worker never answers */
/* Both shapes of silence. Neither may throw, and neither may describe a
   session the popup cannot actually see. */

let threw = null;
let ui = await boot(async () => undefined).catch((e) => (threw = e));
check("a reply of undefined does not throw", threw === null,
      threw ? String(threw.message) : "");
check("...and the status says so", ui && ui.status() === NO_ANSWER,
      ui ? JSON.stringify(ui.status()) : "");

threw = null;
ui = await boot(async () => { throw new Error("Extension context invalidated."); })
  .catch((e) => (threw = e));
check("a rejected sendMessage does not throw", threw === null,
      threw ? String(threw.message) : "");
check("...and the status says so", ui && ui.status() === NO_ANSWER,
      ui ? JSON.stringify(ui.status()) : "");

/* The regression this file exists for: "…" is what say() sets before the
   await, so a status still holding it means the handler died mid-flight. */
check("the status is never left on the in-flight placeholder",
      ui && ui.status() !== "…");

/* ---------------------------------------------- a worker that does answer */
/* The guard must not swallow the normal path. */

ui = await boot(async () => ({ key: "D75LV", locked: false }));
check("a real reply still renders the session", ui.status() === "Ready.",
      JSON.stringify(ui.status()));
check("...and the key is shown", ui.el("key").textContent === "D75LV");

ui = await boot(async () => ({}));
check("an answering worker with no session is not mistaken for silence",
      ui.status() === "Start a session to begin.", JSON.stringify(ui.status()));

/* --------------------------------------------------------- one copy of it */
/* Three call sites report this. As literals they drift; as a constant they
   cannot. */
check("the no-answer copy is a single constant",
      SRC.split(JSON.stringify(NO_ANSWER)).length - 1 === 1,
      `${SRC.split(JSON.stringify(NO_ANSWER)).length - 1} literal(s)`);

console.log(`\n${"=".repeat(58)}`);
console.log(`BROWSER POPUP: ${pass}/${pass + fail} passed`);
console.log(`${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
