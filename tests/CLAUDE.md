# tests/

**The directory says what a suite needs to run.** That is the whole filing rule, and it exists so
`node tests/<something>` never fails for a reason unrelated to your change.

| Folder | Prerequisite | Suites |
|---|---|---|
| `unit/` | nothing | `static-check` `relay-url` `lock` `files` `transfer` `clipsize` `syncmode` `pasteguard` `sharelink` |
| `dom/` | jsdom | `dialog` `whatsnew` `tiles` `guide` `links` `editor` `capture` `offer` `bundle` (also needs a build) |
| `live/` | a reachable relay | `e2e` `boot` `fallback` `cli` |

A suite needing two things is filed under the heavier one — `boot` needs jsdom *and* a relay, so it
is `live/`.

There is no test runner. These are plain scripts that print `PASS`/`FAIL` lines and exit non-zero.
Keep it that way; the modules are pure enough not to need one.

## Which gate runs what

`npm run verify` is all of `unit/` plus the `dom/` suites that need no build — that is what a
pre-commit hook can afford, and it is what `.husky/pre-commit` runs. `npm test` adds `dom/bundle`
and everything under `live/`, and runs in `.husky/pre-push`.

**There is no CI for the app.** These hooks are the entire gate between a commit and production.

## Rules

- **Every suite takes a relay base URL as `argv[2]`, or `RELAY_BASE`.** `e2e` and `boot` default to
  the *deployed* relay, so a bare `npm test` reaches the internet — and testing a relay change that
  way tests production's relay against your branch's client.
- **Skip cleanly when a prerequisite is absent**, never fail. A hook that blocks a push because you
  are on a plane teaches people to pass `--no-verify` by habit. Print the skip loudly.
- **Never commit a real share key or PIN.** Tests use throwaway keys like `D75LV`.
- `unit/lock.mjs` holds golden derivation vectors. If they fail, the wire format moved and every
  existing share link is dead — that failure is the feature.
- A new check goes in the suite whose prerequisite it already has. Adding a network call to a
  `unit/` suite moves the file.
