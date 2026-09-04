# src/pages/

Static content pages — `/help/`, `/download/`, `/about/`. The one part of `src/` that is **copied
verbatim rather than bundled**, and the one part whose disk path is not its URL:

```
src/pages/help/install/index.html      on disk
          /help/install/               published
```

`tools/build/build.mjs` lifts each directory here to the site root.

## Every link must be root-absolute. No exceptions.

`/app.html`, `/help/install/`, `/src/landing/landing.css`, `/icons/icon.svg`.

A relative link resolves against the page's *depth*, and a page here has two depths — three on
disk, one or two when published. So a relative link is correct in exactly one of the two places and
404s in the other, which is why all 74 of them were converted when these pages moved. There is no
depth that works for both, and adding one relative link reintroduces the whole problem.

This is also what retired subpath hosting: a root-absolute link cannot be right under a path
prefix. See `src/core/paths.js`.

## Rules

- **No app JavaScript.** These pages may load `src/landing/*.js` and `landing.css` and nothing
  else. An app module resolving an asset through `core/paths.js` is fine now that `APP_ROOT` is the
  origin root, but the pages have no need of one and staying out keeps it that way.
- **Every page carries a CSP `<meta>` and no executable inline `<script>`.** The static check
  scans this directory for `index.html` and fails otherwise, so a new page is covered without
  anyone remembering.
- **A new page is a new directory with an `index.html`.** The build scans; nothing lists pages by
  name, because a forgotten entry fails silently as a 404 rather than loudly as a broken build.
- **Add it to `sitemap.xml`** — that part is not derived.
- **Not precached.** `sw.js` covers the app shell; marketing copy has no business in the offline
  cache of an app that otherwise holds nothing. The SHELL check skips this directory.
- Link to the app as `/app.html`. The build rewrites it to `/app`, and
  `tools/check/site-check.mjs` asserts no page ships the `.html` form.

## Previewing

`npm run serve` serves the repo root, where these sit at `/src/pages/help/` — so their
root-absolute links point at URLs that only exist after a build. To look at them:

```bash
npm run build:site && (cd _site && python -m http.server 8080)
```

That is the deliberate trade for keeping the app's own no-build loop: `app.html` and `index.html`
stay at the root and are unaffected.
