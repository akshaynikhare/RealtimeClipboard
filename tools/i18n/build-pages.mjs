/**
 * Write every translated content page from tools/i18n/content/.
 *
 *   node tools/i18n/build-pages.mjs           write them
 *   node tools/i18n/build-pages.mjs --check   fail if any file is out of date
 *
 * --check is what a hook runs: the pages are committed, so the template and the
 * committed output can drift, and drift here means one page quietly keeping an
 * old footer. Regenerating and diffing is the cheapest way to make that
 * impossible rather than merely unlikely.
 *
 * Content lives in content/<lang>/<slug>.json, one file per translated page.
 * The English page is the source of the CSP — read, never restated.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { page, LANGS } from "./template.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTENT = join(ROOT, "tools/i18n/content");
const CHECK = process.argv.includes("--check");

/* The CSP is asserted byte-identical across every page by site-check, so it is
   read from the English original rather than restated here. */
function cspOf(slug) {
  const src = readFileSync(join(ROOT, "src/pages", slug, "index.html"), "utf8");
  const m = src.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/);
  if (!m) throw new Error(`no CSP found in src/pages/${slug}/index.html`);
  return m[0];
}

let written = 0, stale = [];

for (const lang of Object.keys(LANGS)) {
  const dir = join(CONTENT, lang);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    const slug = file.replace(/\.json$/, "");
    const content = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const html = page(lang, slug, content, cspOf(slug));
    const out = join(ROOT, "src/pages", lang, slug, "index.html");

    if (CHECK) {
      const have = existsSync(out) ? readFileSync(out, "utf8") : null;
      if (have !== html) stale.push(`${lang}/${slug}`);
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    written++;
  }
}

if (CHECK) {
  if (stale.length) {
    console.error(`\n  ${stale.length} translated page(s) out of date with the template:`);
    stale.forEach(s => console.error(`    ${s}`));
    console.error("\n  Run: npm run i18n:pages\n");
    process.exit(1);
  }
  console.log("  translated pages match the template");
} else {
  console.log(`  wrote ${written} translated page(s)`);
}
