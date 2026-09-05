#!/usr/bin/env node
/**
 * Publish the browser extension to Microsoft Edge Add-ons.
 *
 *   node tools/release/edge-publish.mjs <path-to.zip>
 *
 * Edge is the one Chromium store with no registration fee, which is the whole
 * reason this exists: the same zip that is attached to every release, on a store
 * that gives one-click install and auto-update, for nothing. Chrome wants $5 and
 * Firefox cannot run this extension at all (no chrome.offscreen).
 *
 * THE API CANNOT CREATE A PRODUCT. Microsoft is explicit: the first submission is
 * made by hand in Partner Center, and only updates are automatable. So this
 * needs a product ID that already exists, and says so rather than failing at a
 * 404 nobody can read.
 *
 * Four calls, two of them polls:
 *   POST   /v1/products/:id/submissions/draft/package   -> 202 + Location: opId
 *   GET    …/draft/package/operations/:opId             -> InProgress | Succeeded | Failed
 *   POST   /v1/products/:id/submissions                 -> 202 + Location: opId
 *   GET    /v1/products/:id/submissions/operations/:opId
 *
 * Skips rather than fails when the credentials are absent, like every other
 * publish step here: a fork, and the first tag cut before the store account
 * exists, must still produce a release.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const ROOT = "https://api.addons.microsoftedge.microsoft.com";
const CLIENT_ID = process.env.EDGE_CLIENT_ID;
const API_KEY = process.env.EDGE_API_KEY;
const PRODUCT_ID = process.env.EDGE_PRODUCT_ID;
const ZIP = process.argv[2];

const POLL_MS = 10_000;
const POLL_LIMIT = 60;              // ten minutes; certification itself is longer and async

const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`::error::${m}`); process.exit(1); };

if (!CLIENT_ID || !API_KEY || !PRODUCT_ID) {
  say("Edge Add-ons: no credentials — skipped.");
  say("Set EDGE_CLIENT_ID, EDGE_API_KEY and EDGE_PRODUCT_ID to publish.");
  process.exit(0);
}
if (!ZIP || !existsSync(ZIP)) die(`no package at ${ZIP ?? "(no path given)"}`);

const headers = { Authorization: `ApiKey ${API_KEY}`, "X-ClientID": CLIENT_ID };

/** The operation id comes back in Location. It is an id, not a URL, but take the
 *  last segment anyway so a future absolute URL does not break this. */
const opIdFrom = (res) => (res.headers.get("location") ?? "").split("/").filter(Boolean).pop();

async function poll(url, what) {
  for (let i = 0; i < POLL_LIMIT; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const res = await fetch(url, { headers });
    if (!res.ok) die(`${what}: status check returned ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (body.status === "Succeeded") return body;
    if (body.status === "Failed") {
      const detail = (body.errors ?? []).map(e => e.message ?? JSON.stringify(e)).join("; ");
      die(`${what} failed: ${body.message ?? ""} ${detail}`.trim());
    }
    say(`${what}: ${body.status ?? "InProgress"} …`);
  }
  die(`${what}: still running after ${(POLL_MS * POLL_LIMIT) / 60000} minutes`);
}

/* ------------------------------------------------------------------ upload -- */

say(`uploading ${basename(ZIP)} to product ${PRODUCT_ID.slice(0, 8)}…`);
const upload = await fetch(`${ROOT}/v1/products/${PRODUCT_ID}/submissions/draft/package`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/zip" },
  body: readFileSync(ZIP),
});

if (upload.status === 404) {
  die("no such product. The Edge API cannot create one — make the first submission "
    + "by hand in Partner Center, then set EDGE_PRODUCT_ID to its GUID.");
}
if (upload.status === 401 || upload.status === 403) {
  die(`the credentials were rejected (${upload.status}). Edge API keys expire — check `
    + "Partner Center > Publish API.");
}
if (upload.status !== 202) die(`upload returned ${upload.status}: ${await upload.text()}`);

await poll(`${ROOT}/v1/products/${PRODUCT_ID}/submissions/draft/package/operations/${opIdFrom(upload)}`,
           "upload");
say("package accepted.");

/* ----------------------------------------------------------------- publish -- */

const publish = await fetch(`${ROOT}/v1/products/${PRODUCT_ID}/submissions`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ notes: `Automated publish of ${basename(ZIP)}` }),
});

// Already published: the store refuses a duplicate the way npm and vsce do, and
// a re-run after one channel failed must not go red on the one that worked.
if (publish.status === 400) {
  const text = await publish.text();
  if (/no.*modules.*updated|nothing to publish|same/i.test(text)) {
    say("nothing changed since the last submission — nothing to do.");
    process.exit(0);
  }
  die(`publish returned 400: ${text}`);
}
if (publish.status !== 202) die(`publish returned ${publish.status}: ${await publish.text()}`);

await poll(`${ROOT}/v1/products/${PRODUCT_ID}/submissions/operations/${opIdFrom(publish)}`,
           "publish");

say("submitted to Edge Add-ons. Certification review takes hours to days;");
say("the listing updates when it passes, and Partner Center emails either way.");
