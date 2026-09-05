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
  say(r.message ?? (r.ok ? "Done." : "Something went wrong."));
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

$("joinForm").onsubmit = async (e) => {
  e.preventDefault();
  const key = $("joinKey").value.trim();
  if (!key) return;
  say("Joining…");
  const r = await ask("join", { key });
  say(r.ok ? "Joined." : r.message);
  render();
};

render();
