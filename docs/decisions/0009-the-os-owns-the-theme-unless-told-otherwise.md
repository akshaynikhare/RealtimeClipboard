# 0009 — The OS owns the theme, unless the user says otherwise

**Status:** Accepted · 2026-09-05

## Context

The installed app was dark on a machine set to light, and had been for every release.

`desktop/src-tauri/tauri.conf.json` declared `"theme": "Dark"` on the window. In Tauri that
pins the **webview's `prefers-color-scheme`** as well as the native decorations, so
`styles/tokens.css`'s `@media (prefers-color-scheme: light)` block could never match — the
light palette was unreachable on that surface alone, and no stylesheet change could have fixed
it. Nothing on the web could show the problem, because on the web the same CSS is correct.

The app has no theme control and until now did not need one: the OS decides, tokens.css
answers. That is a good default and stays the default. But removing the pin made the OS the
authority *everywhere*, which turned "I want the app dark on a light desktop" into a request
with no answer — and the installed app, sitting open all day next to a light editor, is exactly
where someone asks it.

## Decision

**The window declares no `theme`.** Omitted means "follow the system", and
`tests/unit/static-check.mjs` fails on any window that pins one, because the omission reads as
an oversight otherwise.

**A three-way setting: System · Light · Dark**, in the Settings menu under Appearance,
defaulting to System.

**System stamps nothing.** It is not a third palette — it is the absence of a choice, so
`ui/features/theme.js` removes `data-theme` from `<html>` and leaves the media query in charge.
That also means the *first paint of every load* is correct under the default, before this module
has run at all.

**The light palette is written twice in `tokens.css`**, once behind
`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) }` and once behind
`:root[data-theme="light"]`. CSS offers no way to share one declaration block across a media
query and a selector. The `:not()` is what lets an explicit Dark beat a light OS.

**`color-scheme: light dark` on `:root`.** The tokens cover everything the stylesheet reaches;
scrollbars, form controls and the canvas behind the first frame are painted by the UA, and
without this declaration they stayed light in a dark window. This was already wrong on the web
and nobody had noticed.

## Alternatives considered

**Set `"theme": "Light"` instead.** Same bug, other direction.

**Stamp `data-theme` from JavaScript in every case, including System.** Removes the duplicated
palette, and flashes the dark default on a light machine for as long as the module takes to
load. It would also stop following a live OS switch unless a `matchMedia` listener were added —
a listener that exists to undo a problem introduced by stamping in the first place.

**An inline `<script>` in `<head>` to stamp before first paint.** The standard fix elsewhere,
and unavailable here: the CSP is `require-trusted-types-for 'script'` with no `unsafe-inline`,
and a static check forbids executable inline `<script>`. A deferred module script is what we
have, and it is too late.

**Two switches (follow-system on/off, plus light/dark).** The same mistake the sync ladder
already made once and had to undo: two controls for one setting, where the second silently
disagrees with the first.

## Consequences

- **`tokens.css` now has two copies of the light palette**, and editing one without the other is
  the failure mode. `tests/dom/theme.mjs` parses both out of the file and asserts they declare
  the same tokens with the same values — the entire mitigation.
- The theme strings are a compatibility surface like `SYNC_MODES`: relabel the UI, never the
  stored values.
- **The landing page does not follow the setting.** It is a separate document with its own
  `prefers-color-scheme` blocks in `landing.css`, and the choice lives in the app's
  localStorage. Following it there is possible and deliberately not done yet.
- The desktop window's native decorations now follow the OS too, and will not match an in-app
  override. That is the correct trade: a title bar that disagrees with the system is worse than
  one that disagrees with the page.
