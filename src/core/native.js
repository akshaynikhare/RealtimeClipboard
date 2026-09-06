/**
 * The one place that knows there is a native host underneath.
 *
 * Rank 0 and DOM-free, because the answer also decides the default key length in
 * config.js — and core/ is imported by the node tests and shipped in the npm
 * package cli/ runs on.
 *
 * Three files used to feature-test `globalThis.__TAURI__` independently and all
 * three failed at once: `withGlobalTauri` had never been switched on, so the
 * global did not exist, T0 never started, and the desktop app silently degraded
 * to a browser tab that cannot watch the clipboard.
 *
 * There are two hosts now — the Tauri shell, which announces itself through a
 * global, and the VS Code extension, which registers itself through setHost().
 * Both answer the same two questions (`invoke`, `listen`), so everything above
 * this file sees one native boundary rather than a growing list of shells.
 */

const g = globalThis;

// `__TAURI_INTERNALS__` is injected into every Tauri webview; `__TAURI__` only
// when `withGlobalTauri` is on. Both are checked so the answer survives that
// flag being turned off again — the failure this module was written after.
const IN_TAURI = typeof g.__TAURI_INTERNALS__ === "object"
              || typeof g.__TAURI__ === "object";

/** `document` first: jsdom has both, and the DOM suites want to be "web". */
const IN_NODE = typeof document === "undefined" && !!g.process?.versions?.node;

/**
 * A host that cannot be detected declares itself, before this module is first
 * imported. Declared rather than sniffed on purpose: `process.env.VSCODE_PID` is
 * set inside VS Code's *integrated terminal* as well as inside its extension
 * host, so `realtimeclipboard watch …` typed at that terminal would claim to be
 * the extension.
 */
const DECLARED = typeof g.__REALTIMECLIPBOARD_SURFACE__ === "string"
  ? g.__REALTIMECLIPBOARD_SURFACE__
  : null;

export const SURFACE    = DECLARED ?? (IN_TAURI ? "desktop" : IN_NODE ? "cli" : "web");
export const IS_DESKTOP = SURFACE === "desktop";
export const IS_WEB     = SURFACE === "web";
export const IS_CLI     = SURFACE === "cli";

/**
 * Surfaces the user installed rather than visited. What this actually governs is
 * key length: an installed surface keeps its session across restarts and is worth
 * the longer key, a visited one is usually typing it to somebody.
 */
export const IS_INSTALLED = IS_DESKTOP || SURFACE === "vscode" || SURFACE === "browser";

let host = null;

/**
 * Register the process-side half of a native shell. Called once, before anything
 * that depends on it — which is why the three consumers below all ask through a
 * function rather than reading a const captured at import time.
 */
export function setHost(h) { host = h; }

/** Is there something underneath that owns the OS clipboard? */
export const hasNativeClipboard = () => IN_TAURI || host !== null;

/** How this host watches the clipboard, for the tier readout. */
export const hostNote = () => host?.note ?? "watching the system clipboard";

/**
 * Call a command on the host — desktop/src-tauri/src/main.rs, or a registered
 * host's own implementation. Null where there is no host.
 */
export async function invoke(command, args) {
  const core = g.__TAURI__?.core;
  return run(host?.invoke ?? core?.invoke?.bind(core), "invoke", command, args);
}

/**
 * Subscribe to an event the host emits. Resolves to an unsubscribe function, or
 * null where there is no host, so callers can treat "no shell" as ordinary.
 *
 * The Tauri API hands the listener an envelope; a registered host calls back with
 * the payload. Unwrapped here so `clipboard://text` looks the same to capture.js
 * whichever shell is underneath.
 */
export async function listen(event, fn) {
  const api = g.__TAURI__?.event;
  return run(host?.listen ?? (api?.listen && ((e, cb) => api.listen(e, m => cb(m.payload)))),
             "listen", event, fn);
}

async function run(fn, what, a, b) {
  if (!fn) return null;
  try {
    return await fn(a, b);
  } catch (err) {
    console.warn(`[realtimeclipboard] native ${what} "${a}" failed:`, err);
    return null;
  }
}
