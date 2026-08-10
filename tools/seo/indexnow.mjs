/**
 * Push the sitemap's URLs to IndexNow, which is how Bing finds out about a
 * change in minutes instead of on its own schedule.
 *
 * One submission reaches Bing, Yandex, Seznam and Naver — they share a single
 * endpoint and forward between themselves, so submitting to more than one is
 * duplicated work. **Google does not participate** and has said it is not
 * evaluating it; Google is Search Console's job and nothing here substitutes.
 *
 * Bing is worth this on its own even at Bing's market share, because the answer
 * engines ground their citations on Bing's index. A page Bing has not crawled
 * cannot be cited by them, whatever Google thinks of it.
 *
 * Run it by hand AFTER a deploy has gone live — the endpoint fetches each URL
 * to verify it, so submitting a URL that Cloudflare is still building gets it
 * recorded as a 404 rather than queued for retry.
 *
 *     npm run seo:indexnow            # every URL in sitemap.xml
 *     npm run seo:indexnow -- --dry   # print the payload, send nothing
 *     npm run seo:indexnow -- /help/ /download/    # just these
 *
 * The key is not a secret. IndexNow's whole verification model is that the key
 * sits at a public URL on the origin that is claiming the URLs, which is what
 * proves the submitter controls the site. It has nothing to do with the share
 * keys in src/core/config.js and is not covered by the rule against committing
 * those.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://realtimeclipboard.com";
const KEY = "d10e264a86258c1431df1f72efb3cf83";
const ENDPOINT = "https://api.indexnow.org/IndexNow";

/* The key file is the verification, so a submission is pointless if the two
   have drifted — IndexNow answers 403 and says nothing about which half is
   wrong. Reading it back off disk is the cheapest way to never debug that. */
const keyFile = `${KEY}.txt`;
const onDisk = readFileSync(join(ROOT, keyFile), "utf8").trim();
if (onDisk !== KEY) {
  console.error(`  ${keyFile} contains "${onDisk}", not "${KEY}"`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const only = args.filter(a => !a.startsWith("--"));

const sitemap = readFileSync(join(ROOT, "sitemap.xml"), "utf8");
const all = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());

const urlList = only.length
  ? only.map(p => (p.startsWith("http") ? p : ORIGIN + (p.startsWith("/") ? p : `/${p}`)))
  : all;

const foreign = urlList.filter(u => !u.startsWith(`${ORIGIN}/`));
if (foreign.length) {
  console.error(`  off-origin URL, IndexNow rejects the whole batch: ${foreign[0]}`);
  process.exit(1);
}
if (!urlList.length) {
  console.error("  no URLs to submit");
  process.exit(1);
}

const body = {
  host: new URL(ORIGIN).host,
  key: KEY,
  keyLocation: `${ORIGIN}/${keyFile}`,
  urlList,
};

console.log(`\n  ${urlList.length} URL${urlList.length > 1 ? "s" : ""} -> ${ENDPOINT}`);
urlList.forEach(u => console.log(`    ${u}`));

if (dry) {
  console.log("\n  --dry, nothing sent\n");
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

/* 200 and 202 both mean accepted — 202 specifically means "accepted, key not
   checked yet", which is the normal answer for a first submission. Neither
   says the URLs were indexed, only that they were queued. */
const note = {
  200: "accepted",
  202: "accepted, key validation pending",
  400: "malformed payload",
  403: `key rejected — is ${ORIGIN}/${keyFile} live and readable?`,
  422: "a URL does not belong to this host, or the key does not match",
  429: "too many submissions; wait rather than retry",
}[res.status] ?? "unexpected";

console.log(`\n  HTTP ${res.status} — ${note}\n`);
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
