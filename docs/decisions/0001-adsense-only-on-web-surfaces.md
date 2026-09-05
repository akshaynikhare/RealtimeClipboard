# 0001 — AdSense runs on the web surfaces only

**Status:** Accepted · 2026-09-04

## Context

On 2026-08-09 the no-ads-in-the-app rule was reversed and `app.html` began carrying the
AdSense tag (`docs/ARCHITECTURE.md` §5). `src/main.js` calls `ads.init()` unconditionally,
and `app.html` is loaded by four things: the website, an installed PWA, the Tauri desktop
shell, and the VS Code extension's webview.

The last two are software applications, and Google's programme policies are explicit:

> Google ads may not be integrated into a software application of any kind, including
> toolbars.

and, from the policy FAQ:

> you're not allowed to put ads in your software, e.g., if you control both a page with ads
> and an app that loads that page, we will take action against it.

That second sentence describes this project exactly. Enforcement is **account-level**, so a
tag in the desktop shell risks the website's revenue, not just the desktop's.

Nothing was actually served, but only by accident: `desktop/src-tauri/tauri.conf.json`
declares no `script-src`, so `default-src 'self'` blocked the script, and
`trusted-types realtimeclipboard` blocked it a second time. No code, comment or test said
the desktop must not carry AdSense. An unrelated CSP edit would have started serving one.

The AdSense client ID was, however, genuinely present in the desktop bundle — in
`config.js`, in `GOOGLE_SRC.adsense`, in the bundled `landing/tags.js`, and in `app.html`'s
own meta CSP.

## Decision

**`src/core/surface.js` `adNetwork()` is the single place that decides**, and it returns
`"none"` for `vscode` and `cli` unconditionally — not because an ID is empty. A rule a
configuration change can undo is not a rule.

The exclusion is enforced at three levels, because only the third makes it *impossible*
rather than merely *currently false*:

1. **Source shape** — `tests/unit/static-check.mjs` asserts AdSense identifiers appear in
   three modules only (`core/config.js` declares them; `ui/features/adsense.js` and
   `src/landing/tags.js` use them), and that the Tauri CSP names no ad origin.
2. **Behaviour** — `tests/unit/adpolicy.mjs` runs one child process per surface and asserts
   the answers, including that a live client ID cannot switch ads on for a software surface.
3. **Artifact** — `tools/build/build.mjs` resolves `adsense.js` to `tools/build/adsense.stub.js`
   for `--desktop`, blanks the IDs in that build's `config.js`, drops the landing tree, and
   strips the ad origins from the desktop copy of `app.html`'s CSP.
   `tools/check/desktop-check.mjs` then fails the build on any AdSense token on disk.

## Alternatives considered

**Leave the CSP to block it.** Rejected: it is one edit from permitting what it forbids, and
it left the publisher ID in shipped installers. Absence beats interception.

**Gate in `src/main.js`.** Rejected: the composition root is the file that must not grow
surface conditionals, and the gate would sit far from the code it governs.

**Empty the IDs for the desktop build only.** Necessary but not sufficient on its own —
`adNetwork()` must still refuse, or a future build that forgets the blanking silently starts
serving.

## Consequences

- The desktop app and the VS Code extension earn no ad revenue. See [0002](0002-house-slot-on-the-desktop-app.md).
- Adding an ad origin to `desktop/src-tauri/tauri.conf.json` now fails `npm run verify`.
- `npm run build:desktop` gained a check; it previously ran none at all.
- The desktop bundle no longer contains `index.html` or `src/landing/*`, which also shrinks
  the installer.
- **If this is reversed**, the risk is not a broken feature: it is termination of the AdSense
  account, which would take the website's revenue with it.
