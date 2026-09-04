# src/pages/

The indexable content pages. Static HTML, no app JavaScript, published at the site root.

| Directory | Published at | What it is |
|---|---|---|
| `help/` | `/help/` | Help index |
| `help/install/` | `/help/install/` | The install hub — the platform matrix, and a summary per platform |
| `help/install/windows/` | `/help/install/windows/` | Windows: install, verify, first sync, troubleshooting |
| `help/install/mac/` | `/help/install/mac/` | macOS, same shape |
| `help/install/linux/` | `/help/install/linux/` | Linux, same shape, plus the Wayland matrix |
| `help/install/android/` | `/help/install/android/` | Android and ChromeOS |
| `help/install/iphone/` | `/help/install/iphone/` | iPhone and iPad |
| `help/install/cli/` | `/help/install/cli/` | The command-line client |
| `help/install/relay/` | `/help/install/relay/` | Running your own relay |
| `help/clipboard-sync-not-working/` | `/help/clipboard-sync-not-working/` | The most-searched failure case |
| `download/` | `/download/` | Platform downloads. Has its own `download.css` |
| `privacy/` | `/privacy/` | Privacy policy |
| `about/` | `/about/` | Publisher identity: who builds it, how it is funded |
| `contact/` | `/contact/` | Support, security and business routes |
| `terms/` | `/terms/` | Terms of use |

Every URL in `sitemap.xml` except `/` is one of these pages, so their paths are load-bearing for
search. `tools/check/site-check.mjs` pins each of them by name in `REQUIRED`, because the build
*discovers* pages by scanning — a directory that stops being copied would otherwise ship as a
silent 404.

**`/help/install/` keeps every `id` it ever had** (`#windows` `#mac` `#linux` `#android` `#ios`
`#cli` `#relay`). The per-platform pages were split out from under those anchors, not written
beside them, so an external link to one still has to land on real content.

**Each directory is lifted one level to the site root at build time**, which is why every link in
here is root-absolute rather than relative — a relative link would be correct on disk or when
published, never both. [CLAUDE.md](CLAUDE.md) has the full rule and how to preview them.

The marketing landing page is not here: it is `index.html` at the repo root, with its behaviour in
[../landing/](../landing/). It stays at the root so `npm run serve` keeps serving it at `/`.
