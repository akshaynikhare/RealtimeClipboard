/**
 * Declares what this code is running inside, before anything under `src/`
 * evaluates. Imported FIRST by worker.js, and the import order is the whole
 * mechanism: `core/native.js` reads this global at module scope, so a
 * declaration made in a module body would arrive after the answer was fixed.
 *
 * Declared rather than sniffed because an MV3 service worker is undetectable.
 * It has no Tauri globals and no `process`, but it DOES have a `location` — a
 * `WorkerLocation` pointing at `chrome-extension://<id>/src/worker.js` — so
 * `native.js` classified it as "web" and `keys.shareLink()` built every share
 * link out of that origin and path. The links named a file inside the
 * extension: they opened nothing on another device, and there is no other
 * source of a link here, so the "Copy share link" button never once produced a
 * working one.
 *
 * Mirrors vscode/src/extension.js, which does the same thing for the same
 * reason.
 */

globalThis.__REALTIMECLIPBOARD_SURFACE__ = "browser";
