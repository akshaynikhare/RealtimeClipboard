# Changelog

Generated from the commit history by `tools/release/changelog.mjs` — do not edit by
hand, the next release will overwrite it. To change an entry, reword the
commit.

Format follows [Keep a Changelog](https://keepachangelog.com); versions follow
[Semantic Versioning](https://semver.org).

## v1.0.0 — 2026-09-07

### Added

- i18n: finish the app translation and fix the download card (#76)
- i18n: translate the app, keyed by the English string (#74)
- i18n: translate all eighteen content pages into four languages (#73)
- seo: add Chinese, Portuguese, Spanish and Russian landing pages (#70)
- download: offer the editor extension, now that it exists (#67)
- vscode: make the listing findable for what people search (#66)

### Fixed

- remediate the 2026-09-06 audit across all seven surfaces (#71)
- seo: redirect /blog/, and let site-check see the links it missed (#72)
- browser: Chromium only, and say how to actually install it (#68)

## v0.7.1 — 2026-09-05

### Fixed

- build,ci: unbreak the Windows desktop build, and stop it gating the extensions (#64)

## v0.7.0 — 2026-09-05

### Breaking

- app: per-surface ads and analytics, a key floor, and a theme (#55)

### Added

- mcp,browser: an agent surface and a browser surface, on one shared session (#57)
- vscode: show the session QR, drawn by the app (#58)
- vscode: add the VS Code extension surface (#54)
- files: preview images and PDFs before downloading (#36)
- site: add /live-clipboard, the live and realtime keyword page (#34)

### Fixed

- release: probe the active gh account, not every configured one (#62)
- vscode: set the Marketplace publisher to cadnative (#61)
- seo: add about, contact and terms, drop the empty blog (#53)
- seo: lead the landing title with the realtime phrase (#52)
- seo: brand entity signals, favicon fallback, and launch-copy corrections (#46)
- desktop links, the share-link origin, and the phone ad unit (#45)
- clipboard: flush owed clips from the tick, keep grace reads (#42)
- clipboard: a refused flush requeues, and the poll waits for it (#41)
- ads: keep the shell full-height under AdSense (#40)
- clipboard: route pastes by target, and keep the clip banners honest (#35)

### Documentation

- decisions: amend 0002 — isolation solves the Trusted Types block (#56)
- drop the launch kit and SEO playbook, compress code comments (#47)
- launch: settle the four pre-flight gates and drop the demo video (#44)
- launch: turn item 17 into a runbook, with the pre-flight measured (#33)

### Other changes

- Fix 21 race conditions across the app, relay, desktop shell and CLI (#43)
- Serve AdSense in the app, plus clipboard and history fixes (#39)
- Clipboard routing fixes, a taller history list, and AdSense in the app (#37)
- Correct three launch statements that the ad rollout and v0.5.0 invalidated (#32)

## v0.6.0 — 2026-08-08

### Added

- site: AdSense on the crawlable pages, analytics everywhere (#27)

## v0.5.0 — 2026-08-08

### Breaking

- Stretch the open room hash, and drop 6-character keys (#24)

### Added

- site: threat model, corrected E2EE claim, SEO pages and a real 404

### Fixed

- release: land the release through a pull request (#25)
- ui: the app offer stays put instead of clearing itself (#22)

## v0.4.0 — 2026-08-07

### Added

- ui: one header row for the app offer, a gate on locked links (#19)
- sync: Off/App/Clipboard ladder, and typing that streams (#18)
- download: Homebrew is live, winget is in review — say which (#17)

### Documentation

- release: npm run release cannot push to main, and says so (#16)

## v0.3.0 — 2026-08-07

### Added

- download: ship real installers, and a page that links to them

### Fixed

- ci: do not define APPLE_* at all when there is no certificate (#15)
- ci: stop the ad-hoc signature breaking the macOS build (#14)
- ci: do not let a failed npm publish hide the installers (#11)
- desktop: make beforeBuildCommand independent of its cwd (#10)
- release: match the Cargo version through CRLF line endings (#8)
- cli: read the version from package.json

### Build & deploy

- deploy: move the site to Cloudflare Pages and the new domain

## v0.2.1 — 2026-08-07

### Fixed

- test: keep the fallback suite on a local relay

## v0.2.0 — 2026-08-07

### Added

- desktop: scaffold a Tauri shell and native capture tier
- add the download and installation pages
- relay: optional Redis backend for several replicas
- relay: add deployment policy flags
- cli: add a command-line client
- let the relay address be configured
- relay: add deployment policy flags
- cli: add a command-line client
- let the relay address be configured
- security: enforce a CSP and Trusted Types on every page
- implement modal dialog for consistent user experience
- enhance QR code functionality and session locking

### Fixed

- relay: ship shared.py in the image and the package
- social: regenerate the OG card, which still said Hopboard
- test: point the suites at the relay the hook actually found

### Changed

- core: resolve asset paths from document.baseURI

### Documentation

- add a code of conduct and a contributing guide
- add SECURITY.md and funding metadata
- self-hosting, and record why there is now a build step

### Build & deploy

- relay: ship a Dockerfile, compose stack and Helm chart
- assemble the deploy with esbuild

### Other changes

- First content page: clipboard sync not working
- Keyword mine from Google Autocomplete, and the ad-revenue arithmetic
- Project links from one constant, and the landing page's globe
- Move the settings out of the sidebar and into the status bar
- SEO doc: real domain prices, and hopboard.com is already taken
- Slide the transport menu up out of the item that opens it
- Pick the transport by hand; stop file requests holding the app hostage
- Fire the rate-limit probe concurrently, not in a loop
- CORS on every response, so a stale relay stops reading as a CORS bug
- Phone layout: one view at a time, behind a bottom tab bar
- Transport failover: SSE + POST when WebSockets are blocked
- Refactor app structure and enhance accessibility
- SEO: keyboard-reachable comparison table, and the search strategy doc
- All improvements: data loss, security signals, a11y, file removal
- Move the editor hints to the bottom
- Landing page: Cloudflare-editorial theme, dotted path, live globe
- Live peer cursors, /stats endpoint, session panel redesign
- Fix: files and clipboard images were never announced to peers
- Landing page, SEO, and editor hints
- Clipboard images, Live/Manual mode, equal panes
- Service worker: network-first for code, so builds cannot go stale
- Fix: the app never connected. Plus layout rework.
- Integrate P2P files, history and QR; fix three real bugs
- PWA: manifest, service worker, install prompt
- Relay: peer identity, targeted signalling, file frames
- Remove the m0 spike harness
- M1: transport wired end to end, encrypted
- M0 CLEARED: 20/20 against the deployed relay
- Fix relay image build: declare py-modules
- Point RELAY_URL at the deployed relay; trigger rebuild
- Pages: self-enable on first run
- Modularise the frontend and add Pages deploy
- Initial commit: Hopboard — shared clipboard
- Initial commit
