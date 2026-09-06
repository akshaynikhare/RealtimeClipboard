# tools/i18n/

Generates the translated content pages under `src/pages/<lang>/`.

```bash
npm run i18n:pages                      # write them
node tools/i18n/build-pages.mjs --check # fail if any is out of date
```

| File | Role |
|---|---|
| `template.mjs` | The shape every translated page has, plus per-language chrome |
| `build-pages.mjs` | Writes one page per content file; `--check` proves none has drifted |
| `content/<lang>/<slug>.json` | The translated prose, one file per page |

`<slug>` is the English page's directory, so `content/zh/live-clipboard.json`
becomes `src/pages/zh/live-clipboard/index.html`, published at
`/zh/live-clipboard/`.

## Adding a translated page

1. Write `content/<lang>/<slug>.json` — see an existing one for the fields.
2. `npm run i18n:pages`.
3. Add the URL to `sitemap.xml` and the path to `REQUIRED` in
   `tools/check/site-check.mjs`. Neither is derived, deliberately.

The pages are **committed**, not generated at deploy time, so `static-check`
still walks them and `sw.js` still sees them. What this removes is the copying.
