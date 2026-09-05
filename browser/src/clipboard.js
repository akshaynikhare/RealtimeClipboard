/**
 * The OS clipboard, from an MV3 extension — the whole reason this surface is
 * scoped the way it is.
 *
 * Chromium does not expose `navigator.clipboard` to a service worker, and an
 * offscreen document cannot use it either: the async Clipboard API requires
 * document focus and an offscreen document never has any. So the only route
 * left is the deprecated `execCommand` inside an offscreen document, which is
 * what this file is.
 *
 * That is also why this extension does NOT claim background clipboard sync. It
 * can read on a user gesture — the popup, or a keyboard command — and that is
 * the honest product. The surface that watches the clipboard unattended is the
 * desktop app or the VS Code extension, because the code doing the watching is
 * not a web page. See docs/CLIPBOARD-FLOW.md §5.
 */

const PATH = "src/offscreen.html";

async function ensure() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: PATH,
    reasons: ["CLIPBOARD"],
    justification: "Reading and writing the system clipboard, which a service worker cannot do.",
  });
}

const ask = async (type, text) => {
  await ensure();
  return chrome.runtime.sendMessage({ target: "offscreen", type, text });
};

export const read = () => ask("clipboard-read");
export const write = (text) => ask("clipboard-write", text);
