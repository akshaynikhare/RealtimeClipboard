# 0002 — The desktop app shows a house slot, not a third-party network

**Status:** Accepted · 2026-09-04

## Context

[0001](0001-adsense-only-on-web-surfaces.md) removes AdSense from the desktop shell, leaving
a slot with nothing in it. The relay is a paid server and the desktop is a real audience, so
a permitted network was wanted.

**EthicalAds** was the candidate: privacy-first, developer-audience, no cookies — which also
means no consent dialog, a good fit for an end-to-end encrypted product. Two problems.

**Their client cannot run here.** Inspecting the live bundle at
`https://media.ethicalads.io/media/client/ethicalads.min.js`:

- it fetches decisions by JSONP — `document.createElement("script")`, a TrustedScriptURL sink
- it renders with `innerHTML = t.html` on **remote** HTML — a TrustedHTML sink
- `trustedTypes` and `createPolicy` appear **zero** times in it
- it injects a `<style>` element, so it also needs `style-src 'unsafe-inline'`

Under `require-trusted-types-for 'script'` both sinks throw. The only way to admit it is a
Trusted Types **`default`** policy, which is document-wide and would silently un-police every
`innerHTML` in the app — against `docs/ARCHITECTURE.md`'s rule that Trusted Types names the
policies it allows, and against the one-owner-for-`innerHTML` invariant.

**And we are not eligible yet.** EthicalAds asks for 50k+ pageviews/month.

## Decision

The desktop slot is filled from this repository. `src/ui/features/house.js` renders a promo
for the CLI and GitHub Sponsors, reaches no network, and needs no CSP entry.

The dispatcher in `src/ui/features/ads.js` selects it via `adNetwork()` returning `"house"`,
so admitting a real network later is a one-line change plus a renderer module.

If EthicalAds is revisited, the integration must **render from their JSON decision API**
(`copy.headline`, `copy.content`, `image`, `link`, `view_url`) through `esc()`/`setHTML()`,
never their client. That API sends no CORS header, so the fetch has to happen in Rust — or be
proxied by the relay — and it needs their approval as a non-standard integration first.

## Alternatives considered

**Ship their client and widen Trusted Types.** Rejected — a `default` policy is a real
security regression traded for a slot on the smallest surface.

**Carbon Ads / BuySellAds.** Higher CPMs, but tracking-based (so the consent dialog has to
cover it) and more selective on volume than EthicalAds.

**Leave the slot empty.** Rejected: the space is reserved either way, and an empty box reads
as broken. [0004](0004-collapse-an-unfilled-ad-slot.md) would collapse it, which is correct
for a failure and wasteful as a permanent state.

## Consequences

- Desktop revenue is zero, and honestly so — it was zero before, silently.
- The desktop app makes **no third-party request of any kind** for advertising. That is a
  stronger privacy claim than the website can make, and `/privacy/` says so.
- The house slot needs occasional editing, unlike an ad network.
- Trusted Types stays narrow on desktop and becomes the enforcement mechanism: any future
  attempt to drop in a stock ad client fails at the first `innerHTML`.
