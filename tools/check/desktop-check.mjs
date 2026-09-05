/**
 * What the desktop installer may and may not contain.
 *
 * `npm run build:desktop` shipped nothing but a bundle until this existed —
 * `build:site` had site-check.mjs and the desktop had no equivalent, so the
 * AdSense publisher ID rode into the installer through four separate files with
 * every gate green.
 *
 * The rule is a Google programme policy, not a preference: "Google ads may not
 * be integrated into a software application of any kind", and enforcement is
 * account-level — a tag here risks the website's revenue too.
 * docs/decisions/0001.
 *
 * Absence, not disuse. The CSP already blocked these origins at runtime; this
 * asserts they are not on disk, because a CSP is one edit away from permitting
 * what a missing identifier cannot do at all.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const OUT = resolve(process.argv[2] || "_desktop");

let failed = false;
const pass = m => console.log(`  ok    ${m}`);
const fail = m => { failed = true; console.error(`  FAIL  ${m}`); };
const rel = f => relative(OUT, f).replace(/\\/g, "/");

if (!existsSync(join(OUT, "app.html"))) {
  console.error(`No ${rel(OUT)} — run \`node tools/build/build.mjs _desktop --desktop\` first.`);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    statSync(full).isDirectory() ? walk(full, out) : out.push(full);
  }
  return out;
}

console.log("\nDesktop check\n");

/* ------------------------------------------------------- no AdSense ----- */

const FORBIDDEN = [
  "ca-pub-", "adsbygoogle", "data-ad-client", "googlefc",
  "pagead2.googlesyndication.com", "tpc.googlesyndication.com",
  "partner.googleadservices.com", "googleads.g.doubleclick.net",
  "adservice.google.com", "fundingchoicesmessages.google.com",
  "adtrafficquality.google",
];

/* Source maps are shipped on purpose and contain the original sources, so they
   would report every token the bundle legitimately dropped. The assertion is
   about what EXECUTES and what a policy DECLARES. */
const files = walk(OUT).filter(f =>
  /\.(html|js|json|webmanifest|txt)$/.test(f) && !f.endsWith(".map"));

const hits = files.flatMap(f => {
  const body = readFileSync(f, "utf8");
  return FORBIDDEN.filter(tok => body.includes(tok)).map(tok => `${rel(f)}: ${tok}`);
});

hits.length
  ? fail("AdSense reached the desktop bundle — Google forbids ads in software "
       + "applications, so this is not a preference:\n" + hits.map(h => `          ${h}`).join("\n"))
  : pass(`no AdSense identifier in any of ${files.length} desktop files`);

/* --------------------------------------------- but analytics IS wanted --- */

/* A check that only forbids is satisfied by shipping nothing at all. GA4 runs
   on every surface; only ads differ. */
const anyJs = files.filter(f => f.endsWith(".js")).map(f => readFileSync(f, "utf8")).join("");
anyJs.includes("googletagmanager.com")
  ? pass("GA4 is still present — the exclusion took the ads, not the analytics")
  : fail("googletagmanager.com vanished from the desktop bundle; the ad exclusion "
       + "was too broad — analytics is wanted on every surface");

/* ----------------------------------------- the landing tree is absent --- */

existsSync(join(OUT, "src/landing/tags.js"))
  ? fail("src/landing/tags.js is in the installer — it is the crawlable pages' "
       + "ad loader and nothing in the shell can reach it")
  : pass("the landing page's ad loader is not in the installer");

existsSync(join(OUT, "index.html"))
  ? fail("index.html is in the installer — the shell opens app.html and never "
       + "navigates to the marketing page")
  : pass("the marketing page is not in the installer");

/* --------------------------------------------- the app still resolves --- */

/* The stub swap is a resolve-time trick, so a typo in the filter would silently
   ship an app whose ad slot throws on import. */
const appHtml = readFileSync(join(OUT, "app.html"), "utf8");
appHtml.includes('id="mount-ad"')
  ? pass("the ad slot host survived the desktop rewrites")
  : fail('app.html lost id="mount-ad"');

const csp = appHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
FORBIDDEN.some(t => csp.includes(t))
  ? fail("the desktop app.html CSP still declares an ad origin")
  : pass("the desktop app.html CSP declares no ad origin");

/* ------------------------------------- the precache list resolves ------- */

/* `cache.addAll()` rejects as a UNIT, so one missing entry kills the service
   worker install and offline support with it — silently, because the app still
   loads from the network. Dropping index.html from this build did exactly that
   and nothing caught it until the running app 404'd. */
{
  const sw = readFileSync(join(OUT, "sw.js"), "utf8");
  const list = sw.match(/const SHELL = \[([\s\S]*?)\n\];/)?.[1] ?? "";
  const entries = [...list.matchAll(/"\.\/([^"]*)"/g)].map(m => m[1]);
  const missing = entries.filter(e => e && !existsSync(join(OUT, e)));
  entries.length && !missing.length
    ? pass(`every one of the ${entries.length} precached shell entries exists`)
    : fail(missing.length
        ? `sw.js precaches files this build does not ship — cache.addAll() rejects `
          + `as a unit, so the install fails and offline support dies silently:\n`
          + missing.map(m => `          ./${m}`).join("\n")
        : "could not read SHELL out of the built sw.js");
}

console.log(`\n  files checked ${files.length}\n`);
console.log(failed ? "  desktop check FAILED\n" : "  desktop check passed\n");
process.exit(failed ? 1 : 0);
