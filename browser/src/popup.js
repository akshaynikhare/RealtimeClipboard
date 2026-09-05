/**
 * The popup. It owns no session — the worker does, so closing this window does
 * not drop the room. Everything here is a message and a render.
 */

const $ = (id) => document.getElementById(id);
const ask = (type, extra = {}) =>
  chrome.runtime.sendMessage({ target: "worker", type, ...extra });

const say = (msg) => { $("status").textContent = msg; };

async function render() {
  const s = await ask("state");
  $("key").textContent = s.key ?? "no session";
  say(s.key ? (s.locked ? "Locked with a PIN." : "Ready.") : "Start a session to begin.");
  // A flagged clip is shown, never written. The button is the only path that
  // writes one — the hotkey deliberately refuses.
  $("risk").hidden = !s.executable;
  if (s.executable) $("riskText").textContent = s.latest ?? "";
}

const run = (type) => async () => {
  say("…");
  const r = await ask(type);
  say(r.message ?? (r.ok ? "Done." : "No answer from the extension. Try again."));
  render();
};

$("bSend").onclick = run("send");
$("bPaste").onclick = run("paste");
$("bConfirm").onclick = run("confirm-paste");

$("bNew").onclick = async () => {
  say("Creating…");
  const r = await ask("new");
  say(r.ok ? "Session started." : r.message);
  render();
};

$("bLink").onclick = async () => {
  const s = await ask("state");
  if (!s.link) return say("No session yet.");
  await navigator.clipboard.writeText(s.link);
  say("Share link copied.");
};

/** `#!KEY` is the locked form — keys.js LOCK_SIGIL, not a guess at the shape. */
const looksLocked = (v) => {
  const frag = v.includes("#") ? v.slice(v.indexOf("#") + 1) : v;
  return frag.trimStart().startsWith("!");
};

// Revealed as soon as the link says it is locked, so the PIN is asked for
// before the join rather than after it has quietly landed in the wrong room.
$("joinKey").oninput = () => {
  $("pinRow").hidden = !looksLocked($("joinKey").value.trim());
};

$("joinForm").onsubmit = async (e) => {
  e.preventDefault();
  const key = $("joinKey").value.trim();
  if (!key) return;
  const pin = $("joinPin").value;
  if (looksLocked(key) && !pin) {
    $("pinRow").hidden = false;
    $("joinPin").focus();
    return say("That link is locked — enter its PIN.");
  }
  say("Joining…");
  const r = await ask("join", { key, pin });
  say(r.ok ? "Joined." : r.message);
  $("joinPin").value = "";              // never leave a PIN sitting in the DOM
  render();
};

render();
