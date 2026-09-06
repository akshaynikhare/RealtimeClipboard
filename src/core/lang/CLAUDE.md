# src/core/lang/ — rank 0, data only

## Rules

- **Data only. No imports, no logic.** A catalogue is a default-exported object
  of string to string. Anything else belongs in `core/i18n.js`.
- **The key is the English string, exactly.** Copy it character for character,
  including the ellipsis in `Connecting…`. A key that does not match the source
  renders English forever and nothing fails.
- **`{placeholders}` must survive translation.** `{n}` stays `{n}`; translating
  the name inside the braces puts a literal `{количество}` on screen. This is
  the one thing `npm run i18n:app -- --check` fails on.
- **Word order is the translator's to move.** That is why the call sites pass
  whole sentences with placeholders rather than concatenating fragments — a
  count goes after the noun in Chinese and inflects the noun in Russian.
- **Terminology matches the translated pages** in `src/pages/<lang>/`:
  中继服务器 / retransmissor / servidor de retransmisión / ретранслятор for the
  relay, and 密钥 / chave / clave / ключ for the key. The app and the site are
  read by the same person.
- **Missing is fine, wrong is not.** An absent key renders English, which is why
  a module can ship before its translation does. Never guess a translation to
  fill a gap.
- **These files are not in the npm package.** `src/core/` ships to the CLI, and
  `package.json` excludes this directory by name. Keep that exclusion if you add
  a language.
