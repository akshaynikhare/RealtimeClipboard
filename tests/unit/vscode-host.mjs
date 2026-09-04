/**
 * vscode/src/host.mjs — the extension's OS clipboard boundary.
 *
 * This file exists for one invariant. `set_clipboard` records the value BEFORE
 * writing it, so the host's own poll recognises its own echo instead of
 * broadcasting it back. Reverse those two lines and one clip circulates around
 * every device in the room forever — and unlike a browser tab, which polls only
 * while focused, this polls whether or not anyone is looking, so nothing bounds
 * the damage. docs/CLIPBOARD-FLOW.md §6, and the same rule as main.rs.
 *
 * Needs nothing but Node: no bundle, no jsdom, no relay. So it runs in
 * `npm run verify`, which is where an invariant this dangerous belongs.
 *
 *   node tests/unit/vscode-host.mjs
 */

import * as host from "../../vscode/src/host.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
};
const tick = (ms = 90) => new Promise(r => setTimeout(r, ms));

/**
 * `writeLagMs` is the point of this fake, not a detail. vscode.env.clipboard is
 * an IPC round-trip to the renderer, so a poll tick CAN fire between the value
 * landing on the clipboard and control returning here. A fake that resolves
 * instantly cannot tell a correct implementation from a reversed one — the first
 * version of this file could not, and passed with the invariant inverted.
 */
function fakeVscode({ focused = true, writeLagMs = 0 } = {}) {
  const clip = { value: "", writes: [], reads: 0 };
  return {
    clip,
    api: {
      window: { state: { get focused() { return focused; }, set focused(v) { focused = v; } } },
      env: {
        clipboard: {
          async readText() { clip.reads++; return clip.value; },
          async writeText(t) {
            clip.writes.push(t);
            clip.value = t;                       // visible to a poll immediately...
            if (writeLagMs) await tick(writeLagMs);  // ...but this call has not returned
          },
        },
      },
    },
    set focused(v) { focused = v; },
  };
}

console.log("\nVS CODE CLIPBOARD HOST\n");

/* ------------------------------------------------------ the echo window -- */
{
  // The write takes longer than a poll interval, so a tick is guaranteed to see
  // the new clipboard value while set_clipboard is still in flight. That is the
  // exact window the ordering exists to close.
  const f = fakeVscode({ writeLagMs: 120 });
  const h = host.create(f.api, { pollMs: 50 });
  const seen = [];
  await h.listen("clipboard://text", t => seen.push(t));

  await h.invoke("set_clipboard", { text: "from a peer" });
  check("the write reached the OS clipboard", f.clip.value === "from a peer");

  await tick(160);                                   // several poll ticks
  check("...and the poll did NOT report our own write back",
    seen.length === 0, `saw ${JSON.stringify(seen)}`);

  f.clip.value = "the user copied something";
  await tick(160);
  check("...but a real copy is reported once",
    seen.length === 1 && seen[0] === "the user copied something", JSON.stringify(seen));

  await tick(160);
  check("...and not again on the next tick", seen.length === 1, JSON.stringify(seen));
  h.dispose();
}

/* --------------------------------------------------- the memory is a ring - */
{
  const f = fakeVscode({ writeLagMs: 10 });
  const h = host.create(f.api, { pollMs: 50 });
  const seen = [];
  await h.listen("clipboard://text", t => seen.push(t));

  // Two writes inside one poll interval. A single lastSeen would remember only
  // the second, and the first would come back as a fresh copy.
  await h.invoke("set_clipboard", { text: "first" });
  await h.invoke("set_clipboard", { text: "second" });
  f.clip.value = "first";                            // e.g. the user hit undo
  await tick(160);
  check("a value written two writes ago is still recognised as ours",
    seen.length === 0, JSON.stringify(seen));
  h.dispose();
}

/* ------------------------------------------------------- writeQuietly ----- */
{
  const f = fakeVscode();
  const h = host.create(f.api, { pollMs: 50 });
  const seen = [];
  await h.listen("clipboard://text", t => seen.push(t));

  await h.writeQuietly("https://realtimeclipboard.com/app#D75LV");
  await tick(160);
  check("copying a share link is not broadcast to the room", seen.length === 0,
    JSON.stringify(seen));
  h.dispose();
}

/* ------------------------------------------------------- the settings ----- */
{
  const f = fakeVscode({ focused: false });                       // VS Code in the background
  const h = host.create(f.api, { pollMs: 50, whenUnfocused: false });
  const seen = [];
  await h.listen("clipboard://text", t => seen.push(t));

  f.clip.value = "copied elsewhere";
  await tick(160);
  check("unfocused and told not to look: nothing is captured", seen.length === 0);

  h.applySettings({ whenUnfocused: true });
  await tick(160);
  check("...and turning it on starts capturing without a reconnect",
    seen.length === 1 && seen[0] === "copied elsewhere", JSON.stringify(seen));

  h.applySettings({ poll: "Off" });
  f.clip.value = "copied again";
  await tick(160);
  check("poll Off stops looking entirely", seen.length === 1, JSON.stringify(seen));
  h.dispose();
}

/* ---------------------------------------------------------- the contract -- */
{
  const f = fakeVscode();
  const h = host.create(f.api, { pollMs: 50 });
  check("an unknown command is refused rather than guessed at",
    await h.invoke("quit", {}) === null);
  check("an unknown event is refused", await h.listen("files://added", () => {}) === null);
  check("the tier note says polling, because that is what it does",
    /poll/i.test(h.note), h.note);
  h.dispose();
}

console.log(`\n${"=".repeat(58)}\nVS CODE HOST: ${pass}/${pass + fail} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
