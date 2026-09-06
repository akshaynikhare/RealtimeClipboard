# tools/i18n/ — the translated pages

## The rule

**The scaffolding is generated; the prose is written.** Everything outside
`content/` is structure, and structure is what breaks silently across 70-odd
files — a footer link added to 71 pages and missed on the 72nd looks fine in
review and is wrong in production. The prose is the opposite: it is the whole
value, and it is not something to derive.

## Why the head is read and never restated

`site-check.mjs` asserts every page's Content-Security-Policy is byte-identical
to `index.html`'s. A policy copied into each content file would be one typo away
from failing the Cloudflare build, and the failure would name the CSP rather
than the copy. `build-pages.mjs` reads it out of the English original for the
same slug, so there is exactly one source and changing it there carries.

The same argument covers the stylesheets and modules, and there the uniformity
is only apparent: `/download/` pulls `download.css` and `download.js`, every
`help/install` page pulls `copy.js`, and the pages with no questions on them do
not load `faq.js` at all. A hardcoded list published `/zh/download/` unstyled
with its download logic missing — a page that looks fine in the generator's
output and is broken in a browser.

## Rules

- **A slug may nest, and the path is the slug.** `content/<lang>/help/install/mac.json`
  publishes to `/<lang>/help/install/mac/`. Nine of the eighteen translatable
  slugs live under `help/`, so a flat `readdir` would have translated half the
  site and skipped the rest without failing — `slugsIn()` walks the tree in both
  `build-pages.mjs` and `site-check.mjs`, and the two must agree.
- **A slug here must exist in English first.** The generator reads
  `src/pages/<slug>/index.html` for the CSP and will throw without it, which is
  the intended failure: a translation of a page that does not exist has no
  canonical, no hreflang target and nothing to be a translation *of*.
- **Terminology does not vary between pages.** 在线剪贴板, 密钥, 中继服务器 and
  their equivalents are fixed per language. A term that changes page to page is
  the clearest tell of machine output, and it is the thing a reader notices
  before they notice anything else.
- **`ENGLISH_ONLY` in `template.mjs` and `UNTRANSLATED` in
  `src/landing/lang.js` are the same list and must stay in step.** The legal
  pages state liability limits and name no governing language, so a translation
  is ambiguous about which version binds. `lang.js` reads its copy to avoid
  offering a link that 404s.
- **Adding a language means adding it to three places**: `LANGS` and `CHROME`
  here, `LANGS` in `src/landing/lang.js`, and the hreflang cluster is then
  emitted for it automatically. Missing the second means the bar never offers it.
- **The output is committed.** Do not move this into `build.mjs`: the pages must
  exist on disk for `static-check.mjs` to walk them for CSP and inline scripts,
  and for `sw.js`'s precache list to be derivable. `--check` is what stops the
  committed copy drifting from the template.
- **`sitemap.xml` and `site-check.mjs`'s `REQUIRED` stay hand-edited.**
  CLAUDE.md is explicit that the sitemap is not derived; a generated sitemap
  would mean a page could be published without anyone deciding it should be.
