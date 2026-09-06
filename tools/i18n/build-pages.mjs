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

const englishPage = slug =>
  readFileSync(join(ROOT, "src/pages", slug, "index.html"), "utf8");

/* The CSP is asserted byte-identical across every page by site-check, so it is
   read from the English original rather than restated here. */
function cspOf(slug) {
  const m = englishPage(slug).match(/<meta http-equiv="Content-Security-Policy"[^>]*>/);
  if (!m) throw new Error(`no CSP found in src/pages/${slug}/index.html`);
  return m[0];
}

/**
 * The stylesheets and modules the English page loads, in its order.
 *
 * Read rather than hardcoded, for the same reason the CSP is. The set is not
 * uniform: /download/ pulls download.css and download.js, every help/install
 * page pulls copy.js, and the pages without an FAQ do not load faq.js at all.
 * A fixed list here published /zh/download/ unstyled and shipped faq.js to
 * pages with no questions on them, and neither failure is visible in review.
 * Paths are root-absolute, so they resolve unchanged from /<lang>/<slug>/.
 */
/**
 * The inline SVG sprite some pages carry, or "" for the pages that do not.
 *
 * /download/ defines seven <symbol> icons that download.js renders with
 * <use href="#i-windows">, and they sit outside <main> as page chrome. Pure
 * path data with no translatable text, so it is lifted rather than retyped —
 * a translation that dropped it published the download page with every
 * platform icon blank, and nothing about the page looked wrong otherwise.
 */
/**
 * Whether the English page wraps its body in div.article.
 *
 * Not every page does: /download/ and /help/ lay out their own sections inside
 * div.in.doc, and .article carries article typography they deliberately avoid.
 * Hardcoding the wrapper restyled the translated download page against its
 * own design.
 */
/**
 * The English page's own publication date, or "" when it declares none.
 *
 * A hardcoded fallback let four pages claim a datePublished their English
 * original contradicted. The translation is a rendering of that article, so it
 * carries the article's date; a content file may still override with
 * `published` when a translation genuinely predates or postdates it.
 */
const datesOf = slug => {
  const en = englishPage(slug);
  const grab = k => (en.match(new RegExp(`"${k}": "([^"]+)"`)) ?? [, ""])[1];
  return { published: grab("datePublished"), modified: grab("dateModified") };
};

const hasArticle = slug => englishPage(slug).includes('<div class="article">');

function spriteOf(slug) {
  const m = englishPage(slug).match(/<svg class="icons"[\s\S]*?<\/svg>/);
  return m ? m[0] : "";
}

function assetsOf(slug) {
  const rows = englishPage(slug).match(
    /<link rel="stylesheet" href="[^"]+">|<script type="module" src="[^"]+"><\/script>/g);
  if (!rows?.length) throw new Error(`no stylesheet or module found in src/pages/${slug}/index.html`);
  return rows.join("\n");
}

/**
 * Every slug a language holds prose for, nested included.
 *
 * Nine of the eighteen translatable slugs live under help/, so a flat readdir
 * would silently translate half the site and skip the rest. A slug is the path
 * below content/<lang>/ with .json removed, which is exactly the directory it
 * publishes to under src/pages/<lang>/.
 */
function slugsIn(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...slugsIn(join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".json")) out.push(prefix + entry.name.replace(/\.json$/, ""));
  }
  return out;
}

/* Which languages hold a translation of each slug. Built first, because a page
   must know about its siblings to emit a correct hreflang cluster. */
const index = {};
for (const lang of Object.keys(LANGS)) {
  for (const slug of slugsIn(join(CONTENT, lang))) {
    (index[slug] ??= new Set()).add(lang);
  }
}

let written = 0, stale = [];

for (const lang of Object.keys(LANGS)) {
  const dir = join(CONTENT, lang);
  for (const slug of slugsIn(dir).sort()) {
    const content = JSON.parse(readFileSync(join(dir, `${slug}.json`), "utf8"));
    const html = page(lang, slug, content, cspOf(slug), index, assetsOf(slug), spriteOf(slug), hasArticle(slug), datesOf(slug));
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

/**
 * A translated page must carry the same head assets and the same structure as
 * the page it translates.
 *
 * Both halves are here because both have already gone wrong. The template once
 * hardcoded landing.css + faq.js, which published /zh/download/ with no
 * download.css and no download.js — a page that looks correct in the
 * generator's output and is broken in a browser. And a translation that quietly
 * loses a paragraph or a table row still renders fine, so nothing else would
 * ever report it.
 *
 * Structure, not prose: this counts tags, and says nothing about the words.
 */
const TAGS = ["h1","h2","h3","p","li","ul","ol","details","table","tr","th","td",
              "dl","dt","dd","div","summary","caption","pre","code","kbd"];
const tagCounts = html => {
  const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  return TAGS.map(t => (main.match(new RegExp(`<${t}[ >]`, "g")) || []).length).join(",");
};
const headAssets = html =>
  (html.match(/<link rel="stylesheet" href="[^"]+">|<script type="module" src="[^"]+"><\/script>/g) || []).join(" ");

const drift = [];
for (const [slug, langs] of Object.entries(index)) {
  const en = englishPage(slug);
  const wantTags = tagCounts(en), wantAssets = headAssets(en);
  for (const lang of langs) {
    const f = join(ROOT, "src/pages", lang, slug, "index.html");
    if (!existsSync(f)) continue;
    const got = readFileSync(f, "utf8");
    if (headAssets(got) !== wantAssets) drift.push(`${lang}/${slug} loads different assets than /${slug}/`);
    if (tagCounts(got) !== wantTags) drift.push(`${lang}/${slug} does not match the structure of /${slug}/`);
  }
}
if (drift.length) {
  console.error(`\n  ${drift.length} translated page(s) diverge from their English original:`);
  drift.forEach(d => console.error(`    ${d}`));
  console.error("");
  process.exit(1);
}

if (CHECK) {
  if (stale.length) {
    console.error(`\n  ${stale.length} translated page(s) out of date with the template:`);
    stale.forEach(s => console.error(`    ${s}`));
    console.error("\n  Run: npm run i18n:pages\n");
    process.exit(1);
  }
  console.log(`  translated pages match the template, and ${Object.keys(index).length} slug(s) match their English original`);
} else {
  console.log(`  wrote ${written} translated page(s)`);
}
