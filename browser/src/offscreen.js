/**
 * The clipboard bridge. `execCommand` is deprecated and is nonetheless the only
 * thing that works here — see clipboard.js for why.
 *
 * The textarea is the transport: `copy` and `paste` act on the focused editable
 * element, and an offscreen document has no user to focus one for it.
 */

const io = document.getElementById("io");

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== "offscreen") return false;

  if (msg.type === "clipboard-read") {
    io.value = "";
    io.select();
    document.execCommand("paste");
    respond(io.value);
    io.value = "";                 // don't leave a clip sitting in the DOM
    return true;
  }

  if (msg.type === "clipboard-write") {
    io.value = msg.text ?? "";
    io.select();
    const ok = document.execCommand("copy");
    io.value = "";
    respond(ok);
    return true;
  }

  return false;
});
