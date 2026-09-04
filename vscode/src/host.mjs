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

/** A ring, not a single value: two writes can land inside one poll interval. */
const MEMORY = 8;

export function create(vscode, { pollMs = 1000, whenUnfocused = true } = {}) {
  const recent = [];
  let timer = null;
  let listener = null;
  let interval = pollMs;
  let unfocusedOk = whenUnfocused;

  const remember = (text) => {
    recent.push(text);
    while (recent.length > MEMORY) recent.shift();
  };
  const isOwn = (text) => recent.includes(text);

  async function tick() {
    if (!listener) return;
    if (!unfocusedOk && !vscode.window.state.focused) return;
    let text;
    try { text = await vscode.env.clipboard.readText(); }
    catch { return; }                       // a locked screen can refuse; not an error
    if (typeof text !== "string" || !text || isOwn(text)) return;
    remember(text);                         // ours now, so the next tick is quiet
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
      await vscode.env.clipboard.writeText(text);
      return true;
    },

    async listen(event, fn) {
      if (event !== "clipboard://text") return null;
      listener = fn;
      // Seed from the current clipboard so whatever is already on it is not
      // mistaken for a fresh copy the moment the session opens.
      try { remember(await vscode.env.clipboard.readText()); } catch { /* empty is fine */ }
      restart();
      return () => { listener = null; restart(); };
    },

    /** Copy something of ours — a share link, a key — without telling the room.
     *  Without the record, the next tick reads it back and broadcasts it. */
    async writeQuietly(text) {
      remember(text);
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
