/**
 * Assert that an assembled `_site` is fit to publish. Run against the output of
 * tools/build/build.mjs, immediately after it, as part of the deploy.
 *
 * These lived in a GitHub Actions step until the deploy moved to Cloudflare,
 * which builds the site itself and never runs one. A non-zero exit fails that
 * build, and a failed build is not promoted, so production keeps serving the
 * previous deploy.
 *
 * Node-only on purpose: the old block shelled out to `python3`, and the build
 * image's Python is not something this repo should depend on to ship.
 *
 *   node tools/build/build.mjs _site && node tools/check/site-check.mjs _site
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, process.argv[2] || "_site");

/** The one place the canonical origin is written down for the checks below. */
const ORIGIN = "https://realtimeclipboard.com";

/** The host the site was published from until the move, and must never mention again. */
const OLD_HOST = "akshaynikhare.github.io";

/** Mirrors tools/seo/indexnow.mjs. IndexNow verifies by fetching the key at
    `/<key>.txt`, so the filename IS the credential and a rename breaks it. */
const INDEXNOW_KEY = "d10e264a86258c1431df1f72efb3cf83";

let failed = 0;
const fail = msg => { console.error(`  FAIL  ${msg}`); failed++; };
const pass = msg => console.log(`  ok    ${msg}`);

/* ------------------------------------------------------- files exist ---- */

/**
 * Entry points only — the deploy ships bundles, not the module tree, and
 * tests/dom/bundle.mjs proves the chunks behind them resolve.
 *
 * `_headers` is here because a missing one breaks no page at all: it silently
 * drops frame-ancestors and HSTS and looks exactly like a healthy deploy.
 */
/**
 * The translated content pages, derived from what tools/i18n/ holds prose for.
 *
 * Not circular: the content directory is the source of truth for which
 * translations exist, and this asserts the *build output* contains each one.
 * The four translated homepages are hand-written rather than generated, so they
 * stay listed by hand below. Hand-listing these too would be 288 lines at full
 * coverage, and a list that long stops being read.
 */
const CONTENT = resolve(ROOT, "tools/i18n/content");
const TRANSLATED = !existsSync(CONTENT) ? [] : readdirSync(CONTENT)
  .flatMap(lang => readdirSync(join(CONTENT, lang))
    .filter(f => f.endsWith(".json"))
    .map(f => `${lang}/${f.replace(/\.json$/, "")}/index.html`))
  .sort();

const REQUIRED = [
  "index.html", "app.html", "manifest.webmanifest", "sw.js", "404.html",
  "robots.txt", "sitemap.xml", "changelog.json", "CHANGELOG.md",
  "_headers", "_redirects",
  "src/main.js", "src/styles/main.css",
  "src/landing/landing.js", "src/landing/landing.css",
  "assets/icons/icon-192.png", "assets/icons/icon-512.png",
  "assets/icons/maskable-192.png", "assets/icons/maskable-512.png",
  "assets/social/og-card.png",
  "help/index.html",
  "help/clipboard-sync-not-working/index.html", "help/install/index.html",
  "help/install/windows/index.html", "help/install/mac/index.html",
  "help/install/linux/index.html", "help/install/android/index.html",
  "help/install/iphone/index.html", "help/install/cli/index.html",
  "help/install/relay/index.html",
  "download/index.html", "download/download.css", "src/landing/download.js",
  "snapdrop-alternative/index.html", "what-is-an-online-clipboard/index.html",
  "online-clipboard-no-login/index.html", "clipboard-sync-different-networks/index.html",
  "live-clipboard/index.html",
  "zh/index.html", "pt/index.html", "es/index.html", "ru/index.html",
  ...TRANSLATED,
  "privacy/index.html", "about/index.html", "contact/index.html",
  "terms/index.html",
  // Referenced by no page, so a build that stopped copying them looks healthy.
  // ads.txt is the one with a bill attached: AdSense refuses demand without it.
  "llms.txt", `${INDEXNOW_KEY}.txt`, "ads.txt",
];

console.log("\nSite check\n");

const missing = REQUIRED.filter(f => !existsSync(join(OUT, f)));
missing.length ? missing.forEach(f => fail(`missing ${f}`))
               : pass(`${REQUIRED.length} required files present`);

/* ------------------------------------------------------------ robots ---- */

/**
 * On github.io this sat in a subdirectory, where robots.txt is never fetched —
 * it governed nothing. At an apex it is authoritative, which also means a wrong
 * one can now do damage.
 */
const robots = read("robots.txt");
robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)
  ? pass("robots.txt declares the sitemap on the canonical origin")
  : fail("robots.txt does not declare Sitemap: " + ORIGIN + "/sitemap.xml");

/* ----------------------------------------------------------- sitemap ---- */

const sitemap = read("sitemap.xml");
if (!/^\s*<\?xml/.test(sitemap) || !sitemap.includes("</urlset>")) {
  fail("sitemap.xml is not a well-formed urlset");
} else {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  const foreign = locs.filter(u => !u.startsWith(ORIGIN + "/"));
  if (!locs.length) fail("sitemap.xml contains no <loc> entries");
  else if (foreign.length) foreign.forEach(u => fail(`sitemap.xml <loc> is off-origin: ${u}`));
  else pass(`sitemap.xml: ${locs.length} URLs, all on ${ORIGIN}`);

  /**
   * A sitemap entry is a request to index, so pairing one with `noindex` asks
   * for two opposite things and Search Console logs it against the whole site on
   * every crawl. An empty /blog/ shipped exactly that way despite the sitemap's
   * own header warning against it — the argument for a check over a comment.
   * And a <loc> for a page not in the deploy is a 404 handed to a crawler.
   */
  const sitemapPage = u => u.replace(ORIGIN, "").replace(/^\//, "").replace(/\/$/, "");
  const fileFor = u => (sitemapPage(u) ? `${sitemapPage(u)}/index.html` : "index.html");

  const dead = locs.filter(u => !existsSync(join(OUT, fileFor(u))));
  dead.length ? dead.forEach(u => fail(`sitemap.xml lists ${u}, which is not in the deploy`))
              : pass(`sitemap.xml: every URL resolves to a published page`);

  const noindexed = locs.filter(u => /name="robots"[^>]*content="[^"]*noindex/i.test(read(fileFor(u))));
  noindexed.length
    ? noindexed.forEach(u => fail(`sitemap.xml lists ${u}, but that page is noindex — pick one`))
    : pass("sitemap.xml lists no page that asks not to be indexed");

  /**
   * The other direction: indexable, reachable and absent from the sitemap. Every
   * content page here is meant to be listed, and forgetting the entry is the
   * documented failure mode (src/pages/CLAUDE.md — it is not derived).
   */
  const listed = new Set(locs.map(fileFor));
  const orphans = htmlPages().filter(f =>
    f !== "app.html" &&
    !listed.has(f) &&
    !/name="robots"[^>]*content="[^"]*noindex/i.test(read(f)));
  orphans.length
    ? orphans.forEach(f => fail(`${f} is indexable but missing from sitemap.xml`))
    : pass("every indexable page is listed in sitemap.xml");
}

/* --------------------------------------------------------- IndexNow ---- */

/**
 * Verification is that the key sits at a public URL on the origin claiming the
 * URLs. Name and contents disagreeing gets a 403 that says nothing about which
 * half is wrong.
 */
const keyBody = read(`${INDEXNOW_KEY}.txt`).trim();
keyBody === INDEXNOW_KEY
  ? pass("the IndexNow key file matches its own filename")
  : fail(`${INDEXNOW_KEY}.txt contains "${keyBody}" — IndexNow will answer 403`);

/* ---------------------------------------------------------- manifest ---- */

/**
 * Valid JSON, and no SVG in icons[]. An SVG declaring sizes:"any" passes
 * Chrome's ">= 144px" test on paper and wins the selection, then cannot be
 * rasterised — `no-acceptable-icon`, with NO fallback to the PNGs above it. One
 * line silently removed the install button while every other criterion passed.
 * The favicon <link rel="icon"> is an unrelated path and stays SVG.
 */
try {
  const icons = JSON.parse(read("manifest.webmanifest")).icons || [];
  const svg = icons.filter(i => i.type === "image/svg+xml" || i.src.endsWith(".svg"));
  svg.length && fail(`manifest icons[] contains SVG ${svg.map(i => i.src).join(", ")} `
    + `- this breaks PWA installability in Chrome. Use PNG only.`);
  icons.some(i => i.sizes === "512x512" && i.purpose === "any")
    ? !svg.length && pass("manifest icons[] is PNG-only and has a 512x512 purpose=any")
    : fail("manifest has no 512x512 purpose=any PNG icon");
} catch (e) {
  fail(`manifest.webmanifest is not valid JSON: ${e.message}`);
}

/* --------------------------------------------------------- /app URLs ---- */

/**
 * Every reference to the app points at /app, and /app resolves to something.
 *
 * tools/build/build.mjs rewrites `app.html` to `app` in the deploy only. That
 * split works until someone writes a link the pattern does not match, and then
 * ships a 404 no test on disk can see. A surviving `app.html` is a needless
 * redirect hop and a sign the rewrite stopped matching.
 *
 * The three alternatives below must stay identical to PRETTY in
 * tools/build/build.mjs. This one was missing `\/` — the root-absolute form,
 * which is what every link in src/pages/ uses — so the gate could not see the
 * one shape it most needed to catch.
 */
const appLinks = htmlPages()
  .concat(["manifest.webmanifest", "src/landing/landing.js", "src/landing/redirect.js"])
  .filter(f => existsSync(join(OUT, f)))
  .filter(f => /(["'])((?:\.{1,2}\/)*|\/|https:\/\/realtimeclipboard\.com\/)app\.html(?=[#"'])/.test(read(f)));

appLinks.length
  ? appLinks.forEach(f => fail(`${f} still links to app.html — the /app rewrite missed it`))
  : pass("every reference to the app uses /app");

/**
 * No `_redirects` rule may name /app, in any form. `/app /app.html 200` looked
 * like the rule that made the pretty URL work and was the rule that broke it:
 * Pages 308s the .html form onto the extensionless path and applies that to a
 * rewrite's target too, so /app → /app.html → /app —
 * ERR_TOO_MANY_REDIRECTS, on the app only, with nothing on disk able to see it.
 */
const appRule = read("_redirects").split("\n").find(l => /^\/app(?=[\s/.]|$)/.test(l));
appRule
  ? fail(`_redirects maps /app (\`${appRule.trim()}\`) — Pages already serves /app from app.html, and rewriting to .html loops`)
  : pass("_redirects leaves /app to Cloudflare's extensionless serving");

const swShell = read("sw.js").match(/const SHELL = \[(.*?)\n\];/s)?.[1] ?? "";
swShell.includes('"./app"')
  ? pass("the service worker precaches ./app")
  : fail("sw.js SHELL does not precache ./app — the app would not work offline");

/* ------------------------------------------------------------ noindex --- */

/**
 * Drop this tag and every rendered session — key, clipboard, history — becomes
 * crawlable. Fail the deploy rather than find out from a search result.
 */
/name="robots" content="noindex/.test(read("app.html"))
  ? pass("app.html carries its noindex meta tag")
  : fail("app.html is missing its noindex meta tag");

/* ---------------------------------------------------------------- CSP --- */

const pages = htmlPages();

const noCsp = pages.filter(f => !read(f).includes('http-equiv="Content-Security-Policy"'));
noCsp.length ? noCsp.forEach(f => fail(`${f} is missing its Content-Security-Policy meta tag`))
             : pass(`${pages.length} pages carry a CSP meta tag`);

/**
 * ONE policy, three declarations: the `_headers` one Cloudflare sends, and a
 * meta tag on every page — app.html included — for the servers that are not
 * Cloudflare. Browsers INTERSECT policies rather than letting the looser win, so
 * a directive drifting in one declaration produces a policy no file describes.
 * Hence: the header matches the crawlable pages with `frame-ancestors` the one
 * sanctioned header-only directive; app.html matches them too; and
 * `trusted-types` is loose only while the tags are switched on.
 *
 * What keeps the share key out of the ad request is timing, not the CSP:
 * ui/features/ads.js mounts only after boot strips the key from the fragment.
 */
const appCsp = read("app.html").match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
const siteCsp = read("index.html").match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
const headerCsp = read("_headers").match(/^\s+Content-Security-Policy:\s*(.+)$/m)?.[1];

/** Whether a build actually ships the tags, read from the one place that decides. */
const config = readFileSync(join(ROOT, "src/core/config.js"), "utf8");
const tagsOn = ["GA4_ID", "ADSENSE_CLIENT"]
  .some(k => new RegExp(`${k}:\\s*"[^"]+"`).test(config));

const directives = p => p.split(";").map(d => d.trim()).filter(Boolean);
const ttOf = p => directives(p).find(d => d.startsWith("trusted-types"));

if (!appCsp) fail("could not read the CSP out of app.html");
else if (!siteCsp) fail("could not read the CSP out of index.html");
else if (!headerCsp) fail("_headers declares no Content-Security-Policy");
else {
  /* 1. header vs the crawlable pages */
  const norm = p => directives(p).filter(d => !d.startsWith("frame-ancestors")).sort();
  const [a, b] = [norm(siteCsp), norm(headerCsp)];
  const diff = [...a.filter(d => !b.includes(d)).map(d => `page only: ${d}`),
                ...b.filter(d => !a.includes(d)).map(d => `header only: ${d}`)];
  if (diff.length) {
    fail("the _headers CSP and the crawlable pages' CSP disagree — they "
       + "intersect, so this produces a policy no file describes:");
    diff.forEach(d => console.error(`          ${d}`));
  } else {
    headerCsp.includes("frame-ancestors")
      ? pass("CSP: header and the crawlable pages agree, and the header adds frame-ancestors")
      : fail("_headers CSP has no frame-ancestors — the only directive it exists to add");
  }

  /* 2. app.html declares the same policy as the crawlable pages */
  appCsp === siteCsp
    ? pass("CSP: app.html matches the crawlable pages")
    : fail("app.html CSP differs from index.html's — the header intersects with "
         + "both, so a difference produces a policy no file describes. If the "
         + "difference is deliberate, it is a new security control: document it "
         + "here and assert its shape instead of deleting this check.");

  /* 3. trusted-types */

  /**
   * Loose is allowed — the ad tag mints `goog#html` per injected frame and will
   * not run otherwise — but only while the tags are on. The failure guarded
   * against is the tokens outliving the decision: IDs emptied, policy left wide.
   */
  const headerTt = ttOf(headerCsp);
  const headerLoose = ["*", "'allow-duplicates'"].filter(t => headerTt?.split(/\s+/).includes(t));
  if (!headerTt) fail("_headers has no trusted-types directive");
  else if (headerLoose.length && !tagsOn) {
    fail(`_headers CSP: \`${headerTt}\` — ${headerLoose.join(" and ")} is only `
       + "justified by the Google tags, and GA4_ID and ADSENSE_CLIENT in "
       + "src/core/config.js are both empty. Restore `trusted-types "
       + "realtimeclipboard` here and in the crawlable pages.");
  } else if (!headerLoose.length && tagsOn) {
    fail(`_headers CSP: \`${headerTt}\` — the Google tags are switched on in `
       + "src/core/config.js and adsbygoogle.js cannot create `goog#html` under "
       + "this. It fails as ads that silently never render, not as a build "
       + "error. Either widen this or empty the IDs.");
  } else {
    pass(tagsOn
      ? "CSP: _headers trusted-types is wide, and the tags that need it are on"
      : "CSP: _headers trusted-types names its policies");
  }
}

/* ------------------------------------------------------- old host ------- */

/**
 * Every canonical, og:url and JSON-LD @id here once named the old host, and a
 * single survivor points crawlers and social cards at a tombstone — too many
 * across too many files to re-check by eye. Scoped to what a crawler reads;
 * docs/ discusses the old host in prose, so excluding it is the point.
 */
const crawlable = walk(OUT)
  .map(f => relative(OUT, f).replace(/\\/g, "/"))
  .filter(f => /\.(html|xml|txt|webmanifest)$/.test(f) && !f.startsWith("docs/"));

/**
 * Comments do not count, and robots.txt is why: its header can only explain that
 * the file was inert for the project's whole life by naming the old host. That
 * is the one place the name is load-bearing, and a check that cannot tell the
 * difference pushes you to delete the explanation to go green.
 *
 * Only `#` comments, only in the formats where `#` means one. In HTML and XML
 * the old host would sit in an href or a <loc>, which a crawler follows.
 */
const withoutComments = (name, body) =>
  /\.(txt)$/.test(name) ? body.replace(/^\s*#.*$/gm, "") : body;

const stale = crawlable.filter(f => withoutComments(f, read(f)).includes(OLD_HOST));
stale.length ? stale.forEach(f => fail(`${f} still references ${OLD_HOST}`))
             : pass(`${crawlable.length} crawlable files, none referencing ${OLD_HOST}`);

/* ---------------------------------------------------------------------- */

console.log(`\n  files to publish ${walk(OUT).length}\n`);

if (failed) {
  console.error(`::error::site check failed (${failed} problem${failed > 1 ? "s" : ""})\n`);
  process.exit(1);
}
console.log("  site check passed\n");

function read(f) {
  try { return readFileSync(join(OUT, f), "utf8"); } catch { return ""; }
}

function htmlPages() {
  return walk(OUT)
    .filter(f => f.endsWith(".html"))
    .map(f => relative(OUT, f).replace(/\\/g, "/"));
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
