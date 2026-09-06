/**
 * The entire OS clipboard boundary for this surface — the analogue of
 * desktop/src-tauri/src/main.rs, and the only file that may name
 * `vscode.env.clipboard`.
 *
 * It implements exactly the two calls src/clipboard/{os,capture}.js already make
 * of a native host, so registering it with native.setHost() turns on T0 and
 * nothing above had to learn a new shape:
 *
 *   invoke("set_clipboard", {text})   write, having first recorded the value
 *   listen("clipboard://text", fn)    every change that was not our own
 *
 * !! THE ORDERING BELOW IS THE WHOLE FILE. `remember()` runs BEFORE the write,
 * so the poller recognises its own echo instead of broadcasting it back. A
 * browser tab polls only while focused, so a mistake there is bounded by the
 * user looking away; this polls whether or not anyone is looking, so a mistake
 * here bounces one clip around the room forever. docs/CLIPBOARD-FLOW.md §6. !!
 */

import { POLL_OPTIONS, TEXT } from "../../src/core/config.js";

/**
 * Two different questions, which one ring could not answer.
 *
 * `lastSeen` is what the previous tick read, and it stops one copy being
 * reported twice. `writes` records what WE put on the clipboard, so our own
 * writes are not read straight back and broadcast — a ring, not a single value,
 * because two writes can land inside one poll interval, and time-bounded,
 * because something written a minute ago is something the user may legitimately
 * copy again.
 *
 * Remembering every OBSERVED value in the write ring conflated the two: copy A,
 * then B, then A again, and the second A was discarded as "ours" until eight
 * other values had pushed it out. Alternating between a few values suppressed
 * every re-copy indefinitely.
 */
const MEMORY = 8;
const WRITE_MEMORY_MS = 30_000;

export function create(vscode, { pollMs = 1000, whenUnfocused = true } = {}) {
  const writes = new Map();          // text -> when we wrote it
  let lastSeen = null;               // what the previous tick read
  let timer = null;
  let listener = null;
  let interval = pollMs;
  let unfocusedOk = whenUnfocused;

  /** Record a write of OURS, so reading it back is not a capture. */
  const remember = (text) => {
    const now = Date.now();
    writes.set(text, now);
    for (const [value, at] of writes) {
      if (now - at > WRITE_MEMORY_MS) writes.delete(value);
    }
    while (writes.size > MEMORY) writes.delete(writes.keys().next().value);
  };

  const isOwn = (text) => {
    const at = writes.get(text);
    if (at === undefined) return false;
    if (Date.now() - at > WRITE_MEMORY_MS) { writes.delete(text); return false; }
    return true;
  };

  async function tick() {
    if (!listener) return;
    if (!unfocusedOk && !vscode.window.state.focused) return;
    let text;
    try { text = await vscode.env.clipboard.readText(); }
    catch { return; }                       // a locked screen can refuse; not an error
    if (typeof text !== "string" || !text) return;
    if (text === lastSeen) return;          // nothing has changed since last tick
    lastSeen = text;
    if (isOwn(text)) return;                // our own write, read back
    listener(text);
  }

  function restart() {
    clearInterval(timer);
    timer = null;
    if (!listener || !interval) return;
    timer = setInterval(tick, interval);
    if (timer.unref) timer.unref();         // never hold the host open on our account
  }

  return {
    // Reported to the user as the capture tier. The desktop shell is told by the
    // OS; we ask. Claiming an event we do not get would be a lie in the UI.
    note: "polling the system clipboard",

    async invoke(command, args) {
      if (command !== "set_clipboard") return null;
      const text = String(args?.text ?? "");
      remember(text);                       // BEFORE the write. See the header.
      lastSeen = text;
      await vscode.env.clipboard.writeText(text);
      return true;
    },

    async listen(event, fn) {
      if (event !== "clipboard://text") return null;
      listener = fn;
      // Seed from the current clipboard so whatever is already on it is not
      // mistaken for a fresh copy the moment the session opens.
      // Seeded as SEEN, not as ours: it is the user's own clipboard, and
      // recording it as one of our writes would suppress the next real copy of
      // the same value.
      try { lastSeen = await vscode.env.clipboard.readText(); } catch { /* empty is fine */ }
      restart();
      return () => { listener = null; restart(); };
    },

    /** Copy something of ours — a share link, a key — without telling the room.
     *  Without the record, the next tick reads it back and broadcasts it. */
    async writeQuietly(text) {
      remember(text);
      lastSeen = text;
      await vscode.env.clipboard.writeText(text);
    },

    applySettings({ poll, whenUnfocused: u }) {
      if (typeof poll === "string") interval = POLL_OPTIONS[poll] ?? interval;
      else if (typeof poll === "number") interval = poll;
      if (typeof u === "boolean") unfocusedOk = u;
      restart();
    },

    dispose() {
      clearInterval(timer);
      timer = null;
      listener = null;
    },

    /** For the tests: the suppression window this host assumes upstream. */
    SUPPRESS_MS: TEXT.SUPPRESS_MS,
  };
}
