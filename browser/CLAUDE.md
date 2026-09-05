# browser/ — the extension surface

An MV3 extension for **Chromium browsers only** — Chrome, Edge, Brave, Opera, Arc. It imports
`cli/session.mjs`, `src/core/keys.js` and
`src/clipboard/guard.js`, bundled — **nothing here may reimplement a protocol detail**, the same rule
`cli/` states.

## What this surface is, and what it deliberately is not

The obvious pitch for a browser extension is background clipboard sync, which a web page cannot do.
**Chromium cannot do it either, and this extension does not claim it.**

- `navigator.clipboard` is not exposed to an MV3 service worker.
- An offscreen document cannot use it either — the async Clipboard API requires document focus, and
  an offscreen document never has any.
- What is left is `document.execCommand` inside an offscreen document, which needs a user gesture.

So the product is **on demand plus a keyboard command**: the popup, `Ctrl/Cmd+Shift+U` to send,
`Ctrl/Cmd+Shift+Y` to receive.

**And it is why there is no Firefox build.** The whole clipboard path runs through
`chrome.offscreen`, which Firefox does not implement and has said it will not — it extended event
pages instead. Porting means a second clipboard implementation for one browser, not a manifest
tweak, so this said "Chrome, Edge and Firefox" for a while and was wrong about a third of it. The surface that watches the clipboard unattended is the desktop app
or the VS Code extension, because there the code doing the watching is not a web page
(`docs/CLIPBOARD-FLOW.md` §5).

Do not put "background sync" on the store listing. It would be the one claim on the page that is
false, and the reviewer who checks it is the one who decides whether this ships.

## Rules

- **The session lives in the service worker, not the popup**, so closing the popup does not drop the
  room. The worker is still evicted after ~30s idle and there is nothing to be done about that: this
  is the surface that reconnects on demand. The key is re-read from `chrome.storage.local` on wake.
- **A PIN is never stored**, here as everywhere. That means the worker cannot resume a locked room by
  itself — the popup asks. Do not add a "remember the PIN" setting to make it feel smoother.
- **`document.execCommand` is deprecated and is nonetheless correct here.** Anyone replacing it with
  `navigator.clipboard` will find it works in the popup and silently fails everywhere else. The
  reason is in `src/clipboard.js`; keep it there.
- **A flagged clip is never written by the hotkey.** A keystroke is not a decision about a shell
  command somebody else sent you — the popup shows it and a button writes it. Same rule as
  `capture.confirmPending()` on every other surface.
- **Every permission must be justified in `tools/build/build-browser.mjs`'s `USES` table**, and an
  unlisted one fails the build. The first version of that check only validated the permissions it
  already knew about, so adding a new unused one — the actual failure mode — passed silently.
- The manifest's `connect-src` names the relay; `src/core/config.js` decides it. The build checks
  they agree, the same way `site-check.mjs` does for the site's CSP.
- There is **no no-build dev loop** here, unlike `vscode/`: an extension may not import outside its
  own directory. Load `browser/dist/pkg/` unpacked.
