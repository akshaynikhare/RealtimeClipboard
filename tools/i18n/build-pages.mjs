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
import { page, LANGS, ORIGIN } from "./template.mjs";

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

/* Which languages hold a translation of each slug. Built first, because a page
   must know about its siblings to emit a correct hreflang cluster. */
const index = {};
for (const lang of Object.keys(LANGS)) {
  const dir = join(CONTENT, lang);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const slug = f.replace(/\.json$/, "");
    (index[slug] ??= new Set()).add(lang);
  }
}

let written = 0, stale = [];

for (const lang of Object.keys(LANGS)) {
  const dir = join(CONTENT, lang);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    const slug = file.replace(/\.json$/, "");
    const content = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const html = page(lang, slug, content, cspOf(slug), index);
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

/**
 * The English originals carry the same cluster.
 *
 * hreflang is reciprocal or it is ignored outright, so a translation that names
 * its English original while the original names nothing back buys nothing. The
 * block is delimited so regenerating replaces it rather than stacking copies,
 * and it is emitted only for slugs that actually have a translation.
 */
const MARK_OPEN = "<!-- i18n:hreflang -->";
const MARK_CLOSE = "<!-- /i18n:hreflang -->";

for (const [slug, langs] of Object.entries(index)) {
  const file = join(ROOT, "src/pages", slug, "index.html");
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");

  const rows = [`<link rel="alternate" hreflang="en" href="${ORIGIN}/${slug}/">`];
  for (const code of [...langs].sort()) {
    rows.push(`<link rel="alternate" hreflang="${LANGS[code].tag}" href="${ORIGIN}/${code}/${slug}/">`);
  }
  rows.push(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/${slug}/">`);
  const block = `${MARK_OPEN}\n${rows.join("\n")}\n${MARK_CLOSE}`;

  let next;
  if (src.includes(MARK_OPEN)) {
    next = src.replace(new RegExp(`${MARK_OPEN}[\\s\\S]*?${MARK_CLOSE}`), block);
  } else {
    // After the canonical, which is the tag it belongs beside.
    next = src.replace(/(<link rel="canonical"[^>]*>\n)/, `$1\n${block}\n`);
    if (next === src) throw new Error(`no canonical to anchor hreflang in ${slug}`);
  }
  if (next === src) continue;

  if (CHECK) stale.push(`${slug} (English hreflang)`);
  else { writeFileSync(file, next); written++; }
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
