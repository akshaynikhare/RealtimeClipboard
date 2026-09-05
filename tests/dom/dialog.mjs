/**
 * The PIN dialog, driven in a real DOM.
 *
 * It collects the one secret in the app that is never written down anywhere, and
 * it is the only thing standing between a locked link and a connection. Both of
 * those make "it looked fine when I clicked it" an inadequate standard, so the
 * things that would be quietly wrong are asserted here: that the field is a
 * password field, that focus is trapped and then given back, that a cancelled
 * prompt resolves rather than hanging its caller forever, and that no input node
 * carrying a typed PIN is left in the document afterwards.
 *
 * Usage:  node tests/dom/dialog.mjs
 */

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // Same bargain as tests/live/boot.mjs: jsdom is not a project dependency, because
  // the app ships with no npm install at all.
  console.log("\nSKIP: dialog test needs jsdom  (npm i -D jsdom)\n");
  process.exit(0);
}

const dom = new JSDOM(`<div class="vs"><button id="opener">x</button></div>`, {
  url: "https://example.com/app.html",
  pretendToBeVisual: true,
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
// navigator is getter-only in Node 24.
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

const dlg = await import("../../src/ui/features/lockDialog.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const $ = sel => document.querySelector(sel);
const click = sel => $(sel).click();

console.log("\nPIN dialog\n");

document.getElementById("opener").focus();

/* ---- joining a locked session ---- */

const joining = dlg.ask({ mode: "join", key: "D75LV" });

check("a dialog mounts", !!$(".lockmodal-dlg"));
check("it is a modal dialog", $(".lockmodal-dlg").getAttribute("aria-modal") === "true");
check("the app shell is made inert behind it", $(".vs").inert === true);
check("focus lands in the PIN field", document.activeElement?.id === "lockPin");

// The obvious ones, which are exactly the ones that rot in a refactor.
check("the PIN field is a password field", $("#lockPin").type === "password");
check("autocapitalize is off", $("#lockPin").getAttribute("autocapitalize") === "none");
check("autocomplete is off", $("#lockPin").getAttribute("autocomplete") === "off");
check("joining does not ask twice", !$("#lockPin2"));
check("the session key is shown", $(".lockkey")?.textContent.includes("D75LV"));

$("#lockPin").value = "abc";
click("[data-ok]");
check("a PIN under the minimum is refused", !!$(".lockerr").textContent);
check("and the dialog stays open", !!$(".lockmodal-dlg"));

$("#lockPin").value = "hunter2!";
$("#lockPin").dispatchEvent(new window.Event("input", { bubbles: true }));
const strength = $(".lockstrength").textContent;
check("the strength line reports bits, not an adjective",
  /~\d+ bits/.test(strength), strength);

click("[data-ok]");
check("the PIN is handed back to the caller", await joining === "hunter2!");
check("the dialog is gone", !$(".lockmodal-dlg"));
check("the shell is interactive again", $(".vs").inert === false);
check("focus is returned to whatever opened it", document.activeElement?.id === "opener");
check("no field holding the typed PIN is left behind",
  document.querySelectorAll("#lockPin").length === 0);

/* ---- creating one ---- */

const creating = dlg.ask({ mode: "create" });
check("creating asks for it twice", !!$("#lockPin2"));

$("#lockPin").value = "abcdefgh";
$("#lockPin2").value = "different";
click("[data-ok]");
check("a mismatch is refused", $(".lockerr").textContent.includes("do not match"));

click("[data-modal-dismiss]");
check("cancelling resolves null, not a value", await creating === null);

/* ---- getting out ---- */

const escaping = dlg.ask({ mode: "join" });
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Escape resolves null", await escaping === null);

// A caller awaiting a prompt that got replaced would otherwise wait forever —
// and in main.js that caller is the one deciding whether to connect at all.
const first = dlg.ask({ mode: "join" });
const second = dlg.ask({ mode: "join" });
check("a superseded prompt still settles", await first === null);
click("[data-modal-dismiss]");
check("and so does the one that replaced it", await second === null);
check("nothing is left mounted", !$(".lockmodal"));

/* ---- the goodbye notice ----
   What a device sees when the session it was in has just been locked without
   it. No field, and it must settle whichever way the user leaves it — the
   caller is deciding whether to open a fresh session on the answer. */

const notice = dlg.notice({
  title: "This session has been locked",
  body: ["The device that started this session added a PIN."],
  dismiss: "Close",
  action: "Start a new session",
});

check("the notice mounts", !!$(".lockmodal-dlg"));
check("it collects no secret", !$("input"));
check("it says what happened", $("#lockTitle").textContent.includes("locked"));
click("[data-ok]");
check("the primary button reports itself", await notice === "action");

const closed = dlg.notice({ title: "x", body: ["y"], action: "go" });
click("[data-modal-dismiss]");
check("closing it resolves null rather than the action", await closed === null);

/* ---- the header button ----
   Renders the answer state.canLock() gives, and must be able to change its
   mind: whether this device was first into the room is not known until the
   relay's welcome arrives, which is after this button has already been drawn. */

const state = await import("../../src/core/state.js");
const bus = await import("../../src/core/bus.js");
const lockButton = await import("../../src/ui/features/lockButton.js");

const host = document.createElement("div");
host.id = "mount-lock";
document.body.appendChild(host);

state.get().locked = false;
state.get().peers = 1;
state.get().founder = null;
lockButton.init();

check("a button mounts", !!$("#bLock"));
check("nothing opened by itself", !$(".lockmodal"));
check("alone, it is offered", $("#bLock").getAttribute("aria-disabled") === "false");

let toast = "";
bus.on(bus.EV.TOAST, m => { toast = m; });
let asked = 0;
bus.on("session:lock", () => { asked++; });

// A second device turns up, and this one was not first.
state.get().peers = 2;
state.setFounder(false);
check("company plus a late arrival refuses it",
  $("#bLock").getAttribute("aria-disabled") === "true");
check("and it is still focusable, so it can explain itself",
  !$("#bLock").disabled);
check("the reason is on the control itself",
  /first device/i.test($("#bLock").title), $("#bLock").title);

$("#bLock").click();
check("pressing it asks for no PIN", asked === 0);
check("it says why instead", /first device/i.test(toast), toast);

// The relay's welcome lands and says this device opened the room after all.
state.setFounder(true);
check("being told we were first re-offers it",
  $("#bLock").getAttribute("aria-disabled") === "false");
$("#bLock").click();
check("and now pressing it asks to lock", asked === 1);

state.get().locked = true;
bus.emit(bus.EV.LOCK_STATE, { locked: true, verified: false });
check("once locked, the button reports the state", $("#bLock").classList.contains("on"));
check("and refuses to do it twice",
  $("#bLock").getAttribute("aria-disabled") === "true");
$("#bLock").click();
check("pointing at where the PIN is changed instead",
  /already locked/i.test(toast), toast);
check("still only one lock request in total", asked === 1);

/* ---- the gate ----
   What a cancelled PIN prompt leaves behind. The app underneath is connected to
   nothing, so the only failure that matters here is the app being usable — and
   the subtle version of it is the shell coming back to life when the PIN dialog
   on TOP of the gate closes. */

console.log("\nThe gate over an unopened locked session\n");

const gate = await import("../../src/ui/shell/lockGate.js");
gate.init();

check("nothing is gated to begin with", !$(".gate"));

bus.emit(bus.EV.LOCK_REQUIRED, { required: true });
check("a cancelled PIN prompt greys out the app", !!$(".gate"));
check("...and the app behind it cannot be used or tabbed into",
  $(".vs").inert === true, "the editor accepted text into a session that did not exist");
check("...it announces itself", $(".gate").getAttribute("role") === "alert");
check("...and focus is on the way back in",
  document.activeElement === $(".gate [data-gate=\"0\"]"));

bus.emit(bus.EV.LOCK_REQUIRED, { required: true });
check("saying so twice does not stack two of them",
  document.querySelectorAll(".gate").length === 1);

let relocks = 0, rotates = 0;
bus.on("session:relock", () => { relocks++; });
bus.on("session:rotate", () => { rotates++; });

$(".gate [data-gate=\"0\"]").click();
check("Enter PIN asks for the PIN again", relocks === 1);

/* THE REGRESSION: the prompt opens on top of the gate, and closing it must not
   hand the app back while the gate is still standing in front of it. */
const onGate = dlg.ask({ mode: "join", key: "D75LV" });
check("the prompt opens over the gate", !!$(".lockmodal-dlg"));
click("[data-modal-dismiss]");
check("...and cancelling it resolves rather than hanging", (await onGate) === null);
check("cancelling it leaves the gate up", !!$(".gate"));
check("...and the app still inert behind it",
  $(".vs").inert === true, "the modal's close must not out-vote the gate");

$(".gate [data-gate=\"1\"]").click();
check("Start a new session asks for a new key", rotates === 1);

bus.emit(bus.EV.LOCK_REQUIRED, { required: false });
check("opening a session takes the gate down", !$(".gate"));
check("...and gives the app back", $(".vs").inert === false);

/* ---- the same gate, over a key we refused ----
   `#F5H4` opened a session for as long as the floor was four. It is the same
   failure the lock gate exists for — an app that looks fine and reaches nobody
   — so it is the same gate, and the app behind it has to be just as unusable. */

console.log("\nThe gate over a key we would not hash\n");

const keyGate = await import("../../src/ui/shell/keyGate.js");
const { KEY, LINKS } = await import("../../src/core/config.js");
keyGate.init();

bus.emit(bus.EV.KEY_REJECTED, { key: "F5H4", reason: "short" });

check("a refused key raises the gate", !!$(".gate"));
check("...and the app behind it cannot be used",
  $(".vs").inert === true, "no session was opened, so nothing typed would go anywhere");
check("it shows the key back", $(".gate-key")?.textContent.includes("F5H4"));
check("it names the floor", $(".gate-card p").textContent.includes(String(KEY.MIN_LENGTH)),
  $(".gate-card p").textContent);
check("...and states the cost in bits", /\d+ bits/.test($(".gate-card p").textContent));

const issue = $(".gate-note a");
check("there is a way to report it", !!issue, issue?.href);
check("...which is the issue chooser, where the do-not-paste-your-key warning is",
  issue?.getAttribute("href") === LINKS.NEW_ISSUE, issue?.getAttribute("href"));
check("...opened outside the app", issue?.target === "_blank");

rotates = 0;
$(".gate [data-gate=\"0\"]").click();
check("the only way out asks for a new session", rotates === 1);

/* Both gates draw from one module, so a second one must replace rather than
   stack — two scrims and the app is inert twice with one release. */
bus.emit(bus.EV.LOCK_REQUIRED, { required: true });
check("raising the other gate does not stack them",
  document.querySelectorAll(".gate").length === 1);
bus.emit(bus.EV.LOCK_REQUIRED, { required: false });
check("and one drop is enough to give the app back", $(".vs").inert === false);

bus.emit(bus.EV.KEY_REJECTED, { key: "A".repeat(40), reason: "long" });
check("a too-long key gets its own sentence",
  /too long/.test($(".gate-card h2").textContent), $(".gate-card h2").textContent);
check("...naming the ceiling, not the floor",
  $(".gate-card p").textContent.includes(String(KEY.MAX_LENGTH)));

console.log(`\n${"=".repeat(58)}`);
console.log(`DIALOG: ${pass}/${pass + fail} passed`);
console.log("=".repeat(58));
process.exit(fail ? 1 : 0);
