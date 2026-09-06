/**
 * App translation, keyed by the English string itself.
 *
 * There is no key vocabulary to invent and keep in step: `t("Send")` looks up
 * "Send" and falls back to "Send". A catalogue that is missing an entry — or a
 * catalogue that never loaded — renders exactly what the source file already
 * said, so partial coverage is a normal state rather than a broken one. That is
 * the same property the translated pages have, and it is what lets this land a
 * module at a time instead of all at once.
 *
 * The cost is that editing an English string orphans its translations. That is
 * the right way round: the orphan renders English, which is correct but
 * untranslated, whereas a stale key renders the old wording, which is wrong.
 * `npm run i18n:app -- --check` reports orphans.
 *
 * English pays nothing. `pick()` returns "en" for an English reader and `load()`
 * resolves without a fetch, so the only reader who waits on a catalogue is one
 * who is getting a translation out of it.
 */

const PLACEHOLDER = /\{(\w+)\}/g;

let catalogue = null;
let current = "en";

/** The language actually in force — "en" until a catalogue has loaded. */
export const lang = () => current;

/**
 * Translate `en`, substituting `{name}` placeholders from `vars`.
 *
 * Placeholders rather than concatenation because word order moves: Chinese puts
 * the count after the noun, and Russian inflects around it. A translator needs
 * the whole sentence, not two halves and a variable.
 */
export function t(en, vars) {
  const s = (catalogue && catalogue[en]) || en;
  return vars ? s.replace(PLACEHOLDER, (whole, k) => (k in vars ? vars[k] : whole)) : s;
}

/* Literal specifiers inside thunks. `import(variable)` is opaque to the
   bundler, and passing a path string is what left two optional panels 404ing
   in the deploy — see the trap in CLAUDE.md. */
const LOADERS = {
  zh: () => import("./lang/zh.js"),
  pt: () => import("./lang/pt.js"),
  es: () => import("./lang/es.js"),
  ru: () => import("./lang/ru.js"),
};

export const SUPPORTED = Object.keys(LOADERS);

/**
 * The language to use, given a stored override and the browser's preferences.
 *
 * An explicit choice wins outright, including an explicit choice of English —
 * a reader who picked English wants English, not their browser's guess.
 */
export function pick(stored, preferred = []) {
  if (stored === "en" || SUPPORTED.includes(stored)) return stored;
  for (const tag of preferred) {
    const code = String(tag).toLowerCase().split("-")[0];
    if (SUPPORTED.includes(code)) return code;
  }
  return "en";
}

/**
 * Load a catalogue. Resolves to the language actually in force.
 *
 * Never throws: a catalogue that fails to fetch leaves English in place, which
 * is a fully working app. The session must not fail to open because a
 * translation did not arrive.
 */
export async function load(code) {
  const get = LOADERS[code];
  if (!get) return "en";
  try {
    const mod = await get();
    catalogue = mod.default;
    current = code;
  } catch (err) {
    console.warn("[realtimeclipboard] translation unavailable, staying in English:", err.message);
  }
  return current;
}

/** Test seam: install a catalogue without a fetch. */
export function useCatalogue(code, entries) {
  catalogue = entries;
  current = code;
}
