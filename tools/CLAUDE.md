# tools/

Scripts, filed by what they are for. Nothing here runs in the browser or ships to a user.

| Folder | Role |
|---|---|
| `build/` | Produces artifacts — the deploy, the land mask, the OG card, the icon set |
| `check/` | Answers yes/no about an artifact and exits non-zero. Never writes to it |
| `release/` | Version, changelog, tag, package-manager manifests, relay probe |
| `i18n/` | Generates the translated pages from one template plus a content file each. Writes into `src/pages/`, which `build/` may not — the output is committed so `static-check` can walk it |
| `seo/` | Run by hand, never by a hook or a build. `kwmine.py` researches; `indexnow.mjs` talks to a search engine, so running it twice is not free — it is the one script here with an effect outside the repo |

Reach for these through `npm run`, not by path — the scripts in `package.json` are the interface,
and `tests/unit/static-check.mjs` verifies that every path named in a doc or config still resolves.

## Rules

- **`build/build.mjs` never writes into `src/`.** It runs against a throwaway output directory, so
  development stays `python -m http.server` and the hooks keep checking real modules. That
  separation is the reason a bundler was acceptable at all.
- **Derive, do not maintain a list.** The `sw.js` precache list is generated from disk, the lazy
  stylesheets are a directory copy, the CLI's version is read from `package.json`, and
  `RELAY_HTTP_URL` is computed from `RELAY_URL`. A hand-written second copy is one forgotten edit
  away from shipping wrong, and this repo has been bitten by each of these.
- **The pretty-URL rewrite happens in the deploy and never on disk.** Three things depend on the
  source tree continuing to say `app.html`, and two fail silently — see the comment on `PRETTY` in
  `build/build.mjs`.
- **A check does not fix.** `check/site-check.mjs` gates the Cloudflare build; if it also repaired
  what it found, a broken source tree would keep publishing a working site.
- Naming here is `kebab-case.mjs`, unlike `src/`, which is `camelCase.js`.
