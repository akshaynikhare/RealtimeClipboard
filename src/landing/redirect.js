/**
 * A key in the fragment means someone followed a share link to the landing page
 * rather than to the app. Send them on, rather than showing marketing to
 * somebody who came here to work.
 *
 * An in-page anchor is NOT a key. "#live" and "#compare" are both four or more
 * characters and both used to be swallowed, so deep-linking to a section landed
 * the visitor in the app on a room called LIVE. If the fragment names something
 * on this page, it is a destination, not a credential.
 *
 * A file rather than an inline <script> so `script-src 'self'` holds with no
 * hash and no 'unsafe-inline'. A module script is deferred, which this wants
 * anyway: getElementById cannot answer until the page has been parsed.
 *
 * It does NOT judge the key's length, deliberately. It carried its own copy of
 * the floor, which then disagreed with keys.isValid() — and the disagreement was
 * silent, because a fragment below the copy just showed marketing to somebody
 * holding a share link. Forwarding a bad key reaches ui/shell/keyGate.js, which
 * says what is wrong with it. No import: this is a stand-alone entry point on a
 * page that must not pull in core/ to redirect.
 */

const raw = location.hash.slice(1).trim();

if (raw && !document.getElementById(raw)) {
  const shared = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (shared) location.replace("./app.html#" + shared);
}
