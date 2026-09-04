/**
 * Web Storage, shimmed over ExtensionContext.
 *
 * CommonJS and importing nothing from src/, so extension.js can require() it and
 * get synchronous, ordered execution. src/core/storage.js reaches for these
 * globals at call time and returns a fallback when they are missing — which on
 * bare Node means every setting silently fails to persist. Installing them here
 * is why that file needed no changes at all.
 *
 *   localStorage    -> context.globalState, mirrored in memory, written behind.
 *   sessionStorage  -> a plain Map that dies with the window.
 *
 * The Map is not a shortcut. core/history.js keeps this session's clips in
 * sessionStorage precisely so they never reach disk, and here that invariant
 * holds by construction rather than by trusting a browser.
 *
 * The share key never comes through here — see secrets.mjs. It is the one value
 * the web writes to disk in plaintext, and the keychain is right there.
 */

const PREFIX = "realtimeclipboard.";

/** Web Storage is synchronous; Memento is not. The mirror is what bridges them. */
function shim(seed, persist) {
  const map = new Map(seed);
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) { map.set(k, String(v)); persist?.(k, String(v)); },
    removeItem(k) { map.delete(k); persist?.(k, undefined); },
    clear() { for (const k of [...map.keys()]) this.removeItem(k); },
  };
}

async function install(context, vscode) {
  const seed = context.globalState.keys()
    .filter(k => k.startsWith(PREFIX))
    .map(k => [k, context.globalState.get(k)]);

  // Fire-and-forget: Memento.update() returns a Thenable and Web Storage has no
  // await to give it. A dropped write costs one preference, not correctness.
  globalThis.localStorage = shim(seed, (k, v) => {
    Promise.resolve(context.globalState.update(k, v)).then(undefined, () => {});
  });

  globalThis.sessionStorage = shim([]);

  // config.js resolves RELAY_URL at module scope from exactly this key, so a
  // configured relay has to be in place before the first src/ import — there is
  // no later moment that would work.
  const configured = vscode.workspace.getConfiguration("realtimeclipboard").get("relayUrl");
  if (configured) globalThis.localStorage.setItem(PREFIX + "relayUrl", JSON.stringify(configured));
  else globalThis.localStorage.removeItem(PREFIX + "relayUrl");
}

module.exports = { install, PREFIX };
