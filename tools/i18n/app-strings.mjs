/**
 * What the app asks to be translated, and whether the catalogues answer.
 *
 * The English string is the key, so this needs no extraction format and no
 * merge step: it finds every `t("…")` call in src/ and compares that set with
 * each catalogue. Two failures matter and they are not symmetrical.
 *
 * A MISSING key renders English. That is fine — it is how a module ships before
 * its translation does — so it is reported, not failed.
 *
 * An ORPHAN key is one the catalogue has and no call site asks for. That means
 * an English string was edited and its translations were left behind, pointing
 * at wording that no longer exists. Reported too, because deleting it is the
 * translator's call, not the build's.
 *
 * `--check` fails only on a catalogue that is not loadable or whose placeholders
 * disagree with the English — a `{count}` that became `{contagem}` renders a
 * literal brace to the reader, and nothing else would catch it.
 *
 *   node tools/i18n/app-strings.mjs [--check]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = process.argv.includes("--check");
const LANGS = ["zh", "pt", "es", "ru"];

const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? (e.name === "pages" || e.name === "lang" ? [] : walk(join(d, e.name)))
      : e.name.endsWith(".js") ? [join(d, e.name)] : []);

/* Only a literal first argument can be a key. `t(someVariable)` is invisible to
   this and would silently never translate, so it is reported as a hazard.
 *
 * A key may be written as adjacent literals joined by `+` — long sentences are
 * wrapped that way to stay inside the line length. The runtime key is the
 * concatenation, so this has to read it the same way: matching only the first
 * literal reported a fragment as used and the real key as orphaned, which is
 * exactly backwards and made nine correct translations look dead. */
const LITERAL = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const PIECE = new RegExp(LITERAL, "g");

/* The helper may be imported under another name. files/transfer.js already
   calls its live transfer object `t`, so it imports the translator as `tt`;
   assuming the name meant 22 real keys read as orphans. Read the binding out of
   the import instead of assuming it. */
const bindingIn = (src) => {
  const m = src.match(/import\s*\{[^}]*?\bt(?:\s+as\s+([A-Za-z_$][\w$]*))?[^}]*\}\s*from\s*["'][^"']*core\/i18n\.js["']/);
  return m ? (m[1] || "t") : null;
};
const callRe = (name) =>
  new RegExp(String.raw`\b${name}\(\s*((?:${LITERAL})(?:\s*\+\s*(?:${LITERAL}))*)`, "g");
const dynamicRe = (name) => new RegExp(String.raw`\b${name}\(\s*[A-Za-z_$]`, "g");

/* Join the literals back into the key the running app will look up. */
const joinLiterals = (expr) =>
  (expr.match(PIECE) || [])
    .map((lit) => lit.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n"))
    .join("");

const used = new Map();          // key -> [files]
let dynamic = [];

for (const file of walk(join(ROOT, "src"))) {
  const rel = file.slice(ROOT.length + 1);
  if (rel === "src/core/i18n.js") continue;   // it defines t(), it does not call it
  const src = readFileSync(file, "utf8");
  const name = bindingIn(src);
  if (!name) continue;                       // this module does not translate
  for (const m of src.matchAll(callRe(name))) {
    const key = joinLiterals(m[1]);
    if (!used.has(key)) used.set(key, []);
    used.get(key).push(rel);
  }
  if (dynamicRe(name).test(src)) dynamic.push(rel);
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

let failed = 0;
const fail = (m) => { console.error(`  FAIL  ${m}`); failed++; };

console.log(`\nApp strings\n\n  ${used.size} translatable string(s) across the app`);
if (dynamic.length) console.log(`  note: t() called with a non-literal in ${dynamic.join(", ")}`);

for (const lang of LANGS) {
  const file = join(ROOT, "src/core/lang", `${lang}.js`);
  if (!existsSync(file)) { console.log(`  ${lang}: no catalogue yet`); continue; }
  /* Imported, not parsed: it proves the catalogue is a module the browser can
     actually load, which a JSON slice of the text does not. */
  let entries;
  try {
    entries = (await import(pathToFileURL(file).href)).default;
    if (!entries || typeof entries !== "object") throw new Error("no default export object");
  } catch (err) {
    fail(`${lang}: catalogue does not load (${err.message})`);
    continue;
  }
  const keys = Object.keys(entries);
  const missing = [...used.keys()].filter((k) => !(k in entries));
  const orphans = keys.filter((k) => !used.has(k));
  const bad = keys.filter((k) => used.has(k) && placeholders(k) !== placeholders(entries[k]));

  for (const k of bad) fail(`${lang}: placeholders differ — "${k}" vs "${entries[k]}"`);

  const pct = used.size ? Math.round((keys.length - orphans.length) / used.size * 100) : 100;
  console.log(`  ${lang}: ${keys.length - orphans.length}/${used.size} translated (${pct}%)` +
    (missing.length ? `, ${missing.length} untranslated` : "") +
    (orphans.length ? `, ${orphans.length} orphaned` : ""));
  if (orphans.length && !CHECK) orphans.slice(0, 5).forEach((o) => console.log(`      orphan: ${o.slice(0, 60)}`));
}

if (failed) { console.error(`\n  ${failed} problem(s)\n`); process.exit(1); }
console.log("");
