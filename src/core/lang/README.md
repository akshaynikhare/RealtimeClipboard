# src/core/lang/ — translation catalogues

One module per language, each a default-exported object whose **keys are the
English strings**. `core/i18n.js` explains why that is the key vocabulary.

```js
export default { "Not connected": "未连接" };
```

Loaded lazily, one language at a time, by `core/i18n.js`. An English reader
fetches nothing.

`npm run i18n:app` reports coverage and orphans. `--check` fails only on a
catalogue that will not load, or whose `{placeholders}` disagree with the
English — that one renders a literal brace to the reader.

Excluded from the npm package (`package.json` `files`), because `src/core/` ships
to the CLI and the CLI is not localised.
