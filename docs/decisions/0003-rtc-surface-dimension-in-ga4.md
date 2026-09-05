# 0003 — GA4 carries an `rtc_surface` dimension on every event

**Status:** Accepted · 2026-09-04

## Context

One GA4 property received traffic from the website, the installed PWA, the desktop shell and
the VS Code extension, with nothing distinguishing them. The only signal was `page_location`,
and on desktop that read `http://tauri.localhost/app.html` (Windows) or
`tauri://localhost/app.html` (elsewhere) — two hostnames for one surface, neither of them
ours, mixed into the same reports as the real `/app`.

So "how many people use the desktop app" was unanswerable, and desktop traffic was quietly
corrupting the website's own numbers.

## Decision

Every event carries **`rtc_surface`**, from `src/core/surface.js` `platform()`:

`web-browser` · `web-pwa` · `desktop-windows` · `desktop-mac` · `desktop-linux` ·
`desktop-other` · `vscode` · `cli`

Sent with `gtag("set", …)` as well as on the config, because a config parameter rides only on
events sent through that config and the automatically-collected ones — `session_start`,
`first_visit`, `user_engagement` — have to be attributable too.

`pageLocation()` now returns `${SITE.ORIGIN}/app` on desktop rather than the webview's own
hostname. Which surface a hit came from is `rtc_surface`'s job, not the hostname's.

`desktop-other` exists so `platform()` is total. Tauri ships exactly three desktop targets,
so that value appearing in a report is a user-agent bug worth seeing rather than something to
fold into `desktop-linux`.

## Alternatives considered

**Call it `platform`.** Rejected: GA4 has a built-in `Platform` dimension (web/iOS/Android)
and a custom one of the same name is ambiguous in every report showing both.

**A user-scoped property instead of an event parameter.** Rejected as the primary: user
properties are last-write-wins, so someone using both the web app and the desktop app flips
their own value and corrupts both cohorts. Event scope answers the question actually being
asked.

**A separate GA4 property or data stream per surface.** Rejected: the desktop is a webview and
belongs on the web stream; splitting properties makes cross-surface comparison harder, which
is the whole point.

**Leave `pageLocation()` alone.** Rejected — `tauri.localhost` is not a hostname anyone would
think to look for, and `SITE` exists precisely as the answer to "what is our public address"
when `location` cannot say.

## Consequences

- **A manual step is required and is not retroactive.** Register the dimension under
  Admin → Custom definitions → Create custom dimension, scope **Event**, parameter
  `rtc_surface`. Hits collected before it exists are not queryable in standard reports.
- Desktop rows move from `tauri.localhost` to `realtimeclipboard.com/app` on the deploy date.
  Historical desktop data is not migratable.
- EEA desktop users stay unmeasured: Consent Mode starts denied and the CMP that would lift it
  arrives with the AdSense script, which the desktop no longer loads. Deliberate, and stated
  in `/privacy/` rather than left as a silent undercount.
- **Neither the CLI nor the VS Code extension is measured.** Both are Node hosts with no
  document: the extension runs in VS Code's extension host and owns no webview, so
  `ui/features/analytics.js` is never imported there. `platform()` still answers `vscode` and
  `cli` so the function is total, but `analyticsOn()` is false for both and nothing is ever
  sent. A privacy-first CLI that phones home is also a hard sell to the people who install it.
- **If the extension ever grows a webview**, honouring `vscode.env.isTelemetryEnabled` is the
  prerequisite for switching analytics on there, not a follow-up. An extension that reports
  while the editor's telemetry setting is off is the kind of thing a Marketplace listing is
  pulled for.
