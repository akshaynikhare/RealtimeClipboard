/**
 * The share key at rest, in the OS keychain.
 *
 * Every other surface writes it to localStorage in plaintext — the documented,
 * rememberKey-gated cost of FR-1.7 (src/core/CLAUDE.md). context.secrets is
 * right here, so this surface does not pay it. The PIN is still never stored
 * anywhere, on any surface.
 */

const KEY = "realtimeclipboard.session";

export function create(context) {
  return {
    async load() {
      try {
        const raw = await context.secrets.get(KEY);
        if (!raw) return null;
        const v = JSON.parse(raw);
        return v && typeof v.key === "string" ? v : null;
      } catch { return null; }
    },

    async save(key, locked) {
      try { await context.secrets.store(KEY, JSON.stringify({ key, locked: !!locked })); }
      catch { /* a keychain can refuse; the session still works, it just will not resume */ }
    },

    /** Turning rememberKey off removes what is already there — the setting is
     *  about what is on disk, not only about what happens next. */
    async forget() {
      try { await context.secrets.delete(KEY); } catch { /* nothing to do */ }
    },

    /** Two windows sharing one keychain entry stay on the same session. */
    onChange(fn) {
      return context.secrets.onDidChange(e => { if (e.key === KEY) fn(); });
    },
  };
}
