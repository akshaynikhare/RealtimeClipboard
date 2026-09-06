/**
 * The sync ladder, and the stream/commit split.
 *
 * Three things here are the kind that fail silently, which is why they are
 * asserted rather than reviewed:
 *
 *   1. The stored rung values are a compatibility surface. "live" and "manual"
 *      are on disk under STORAGE_PREFIX for every existing user; renaming them
 *      to match the new labels would reset the one preference where being wrong
 *      means a work machine starts broadcasting its clipboard. The labels are
 *      free to change and live in ui/features/syncMode.js.
 *
 *   2. The `autowrite` migration runs once, from a key that is then deleted. A
 *      regression here is invisible: the app works, and one specific group of
 *      users — the ones who had turned receiving OFF — silently get it back on.
 *
 *   3. A stream frame must fit through the relay by construction. The client
 *      throttles to 10/s and the relay allows 20/s in a class the client does
 *      not share with clips; if `stream` ever fell back into `interactive`,
 *      one person typing would sit on the 10/s ceiling and rate-limit the
 *      clips, which are the product. That is a cross-language invariant, so it
 *      is checked against backend/main.py as text — the same reason
 *      clipsize.mjs duplicates MAX_FRAME_BYTES rather than importing it.
 *
 * Usage: node tests/unit/syncmode.mjs
 */

import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = p => import(pathToFileURL(join(REPO, p)).href);
const read = p => readFileSync(join(REPO, p), "utf8");

let pass = 0, fail = 0;
const ok = (name, good, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/* state.js reaches localStorage through storage.js, which swallows the absence
   of it. That is correct for the browser and useless here: the migration is
   defined entirely by what was already on disk, so the test needs a disk. */
const disk = new Map();
globalThis.localStorage = {
  getItem: k => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: k => disk.delete(k),
};

const { SYNC_MODES, DEFAULT_SYNC_MODE, bindsClipboard, sharesSession, TEXT } =
  await load("src/core/config.js");
const storage = await load("src/core/storage.js");
const state = await load("src/core/state.js");
const proto = await load("src/transport/protocol.js");

/* ------------------------------------------------------------------ rungs */
console.log("\nThe ladder\n");

ok("three rungs, no more", Object.keys(SYNC_MODES).length === 3,
   Object.values(SYNC_MODES).join(" · "));

// The values, not the labels. Changing these orphans every saved preference.
ok("THE COMPAT SURFACE: stored values are unchanged",
   SYNC_MODES.LIVE === "live" && SYNC_MODES.MANUAL === "manual",
   "relabel the UI, never these");
ok("the new rung is additive", SYNC_MODES.OFF === "off");
ok("the default is still the product", DEFAULT_SYNC_MODE === SYNC_MODES.LIVE);

ok("only the top rung touches the OS clipboard",
   bindsClipboard(SYNC_MODES.LIVE)
   && !bindsClipboard(SYNC_MODES.MANUAL)
   && !bindsClipboard(SYNC_MODES.OFF));

ok("Off is the only rung that puts nothing on the wire",
   sharesSession(SYNC_MODES.LIVE)
   && sharesSession(SYNC_MODES.MANUAL)
   && !sharesSession(SYNC_MODES.OFF));

// The ladder is ordered: anything that binds the clipboard must also share.
ok("the rungs nest rather than crossing",
   Object.values(SYNC_MODES).every(m => !bindsClipboard(m) || sharesSession(m)),
   "a rung that writes the clipboard but sends nothing would be incoherent");

/* -------------------------------------------------------------- migration */
console.log("\nThe autowrite migration\n");

storage.saveSettings({ syncMode: "live", autowrite: false, poll: "1s" });
state.restore();

ok("THE REGRESSION: receiving-off is carried to the rung that honours it",
   state.get().settings.syncMode === SYNC_MODES.MANUAL,
   "they asked for nothing to touch their clipboard; only App does that now");
ok("...and the dead key is gone", !("autowrite" in state.get().settings));
ok("...and so is its partner", !("autoread" in state.get().settings));
ok("...and an unrelated setting survives", state.get().settings.poll === "1s");

ok("the migration does not persist the dead keys",
   !("autowrite" in (storage.loadSettings() ?? {})),
   "or it would run again on every boot");

storage.saveSettings({ syncMode: "live", autowrite: true });
state.restore();
ok("someone who never turned receiving off is left alone",
   state.get().settings.syncMode === SYNC_MODES.LIVE);

storage.saveSettings({ syncMode: "manual", autowrite: false });
state.restore();
ok("a device already on App stays there",
   state.get().settings.syncMode === SYNC_MODES.MANUAL);

/* ------------------------------------------------------------ local copies */
console.log("\nA local copy outranks an arriving clip\n");

ok("nothing copied here yet, so an arriving clip wins", !state.recentLocalCopy());
state.markLocalCopy();
ok("THE FIX: just copied here, so the arriving clip waits", state.recentLocalCopy());
ok("the window is long enough to reach for a paste",
   TEXT.LOCAL_COPY_GRACE_MS >= 5_000, `${TEXT.LOCAL_COPY_GRACE_MS} ms`);
ok("...and short enough not to look broken",
   TEXT.LOCAL_COPY_GRACE_MS <= 30_000, `${TEXT.LOCAL_COPY_GRACE_MS} ms`);

/* -------------------------------------------------------- stream vs commit */
console.log("\nStream and commit are two channels\n");

const frame = proto.stream({ text: "hi", caret: 2, name: "Chrome", originId: "u7f3" });

ok("a stream is its own frame type", frame.t === "stream" && frame.t !== proto.T.CLIP);
ok("it carries the caret", frame.caret === 2);
ok("it is self-describing", frame.name === "Chrome",
   "nothing replays these, so a late joiner has no roster to look the name up in");
ok("THE INVARIANT: a stream carries no ts and is not a clip",
   frame.ts === undefined,
   "a retained/replayed stream would resurrect half a sentence as a clip");

ok("a stream always fits inside a clip's budget",
   TEXT.STREAM_MAX_BYTES < TEXT.MAX_BYTES,
   `${TEXT.STREAM_MAX_BYTES} < ${TEXT.MAX_BYTES}`);
ok("the commit boundary is longer than a thinking pause",
   TEXT.COMMIT_IDLE_MS >= 500, `${TEXT.COMMIT_IDLE_MS} ms`);
ok("...and short enough to feel like the text landed",
   TEXT.COMMIT_IDLE_MS <= 2_000, `${TEXT.COMMIT_IDLE_MS} ms`);

/* ------------------------------------------------------------ relay parity */
console.log("\nThe relay agrees (backend/main.py)\n");

const relaySrc = read("backend/main.py");

ok("the relay knows the frame", /ROOM_WIDE\s*=\s*\{[^}]*"stream"/s.test(relaySrc),
   "broadcast to the room, not targeted");
ok("THE STARVATION GUARD: stream is not in the interactive bucket",
   /"stream":\s*"stream"/.test(relaySrc),
   "sharing `interactive` with clip would rate-limit the product at 10/s");
ok("...and its class has a limit", /CLASS_LIMITS\["stream"\]\s*=\s*(\d+)/.test(relaySrc));

const streamLimit = Number(relaySrc.match(/CLASS_LIMITS\["stream"\]\s*=\s*(\d+)/)?.[1]);
const clientRate = Math.ceil(1000 / TEXT.STREAM_THROTTLE_MS);
ok("the client throttles well inside the relay's allowance",
   clientRate * 2 <= streamLimit,
   `client ${clientRate}/s vs relay ${streamLimit}/s — headroom for scheduler jitter`);

/* Read as a set rather than pinned as a literal: the exclusion list grows, and
   a check that fails on the ORDER of it teaches people to edit the test. What
   must not change is that each of these is in it. */
const notFileTraffic =
  relaySrc.match(/FILE_FRAMES\s*=\s*\(TARGETED \| ROOM_WIDE\) - \{([^}]*)\}/)?.[1] ?? "";
ok("a stream is not mistaken for file traffic",
   notFileTraffic.includes('"cursor"') && notFileTraffic.includes('"stream"'),
   "or REALTIMECLIPBOARD_DISABLE_FILES would silently disable live typing");
ok("...and neither is a lock proof",
   notFileTraffic.includes('"verify"'),
   "a relay with files off would leave every locked session unable to confirm its PIN");

console.log(`\n${"=".repeat(58)}`);
console.log(`SYNCMODE: ${pass}/${pass + fail} passed`);
console.log(`${"=".repeat(58)}\n`);
process.exit(fail ? 1 : 0);
