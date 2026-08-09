/**
 * Links that leave the app, in the desktop shell.
 *
 * `target="_blank"` and `window.open()` are SWALLOWED in a Tauri webview. With
 * no `on_new_window` handler registered — and the only thing one can return is
 * another webview, not a browser — wry answers the request with
 * `SetHandled(true)` and nothing else: WebView2 on Windows, the WKUIDelegate on
 * macOS, an unconnected `create` signal on WebKitGTK. So Report issue, Sponsor,
 * Full history and the guide's own Report it were dead clicks in the installed
 * app while working perfectly on the web, which is why nothing showed it.
 *
 * Dropping `target="_blank"` is not the fix. Nothing constrains navigation
 * either, so the link would load GitHub over the app, in a window with no
 * address bar and no back button, and the session would be gone.
 *
 * One delegated listener rather than an edit at each call site, so a link added
 * later is covered by having been written the ordinary way.
 */

import * as native from "../../core/native.js";

export function init() {
  if (!native.IS_DESKTOP) return;
  document.addEventListener("click", onClick);
}

/** An http(s) URL somewhere other than this document's own origin, or null. */
function elsewhere(href) {
  try {
    const url = new URL(href, location.href);
    return /^https?:$/.test(url.protocol) && url.origin !== location.origin
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function onClick(e) {
  // A modifier click asks for something this cannot honour — a new window, a
  // download, a saved target — and the shell has no second window to put it in.
  if (e.defaultPrevented || e.button !== 0
      || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const url = elsewhere(e.target.closest?.("a[href]")?.href ?? "");
  if (!url) return;

  e.preventDefault();
  native.invoke("open_external", { url });
}
