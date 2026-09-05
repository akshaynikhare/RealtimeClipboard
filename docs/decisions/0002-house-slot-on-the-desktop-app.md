# 0002 — The desktop app shows a house slot, not a third-party network

**Status:** Accepted · 2026-09-04 · amended 2026-09-05 (see the end)

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

---

## Amendment — 2026-09-05: the Trusted Types objection was too strong

**The decision stands. One of the reasons given for it does not.**

The argument above is that admitting EthicalAds means a Trusted Types `default` policy, which
is document-wide and un-polices every `innerHTML` in the app. That is correct — *if their
script runs in that document*. The alternatives section never asked whether it had to.

It does not. An ad unit in a **cross-origin iframe** runs in a document of its own, with a CSP
of its own. Host `adframe.html` on `realtimeclipboard.com`, run the network's stock client
inside it, and iframe that from the desktop app: the client gets the `innerHTML` and the JSONP
it wants, inside a document that holds no clipboard text, while the app's `trusted-types
realtimeclipboard` stays exactly as narrow as it is now. The cost is one `frame-src` entry in
the desktop CSP. This is how most ad networks are integrated in the first place, and it is what
`app.html` already does for AdSense on the web.

So the route named in **Decision** above — rebuild against their JSON decision API, fetch it
from Rust or proxy it through the relay, because the API sends no CORS header — is no longer
the cheapest way in. It was the answer to a problem that isolation solves for free.

### What isolation does not solve

**Network policy.** The frame changes where the script runs, not where the impression happens.
A network that forbids placement inside a desktop application still forbids it, and wrapping
the unit is circumvention rather than compliance. For AdSense specifically the iframe is the
*named* violation, not a loophole — the policy FAQ covers it directly: *"if you control both a
page with ads and an app that loads that page, we will take action against it."*
[0001](0001-adsense-only-on-web-surfaces.md) is unaffected and stays permanent.

**Eligibility.** EthicalAds still wants 50k+ pageviews/month.

**The privacy claim.** Consequences above records that the desktop app makes no third-party
request of any kind for advertising, and `/privacy/` says so. Any network, framed or not, ends
that and `/privacy/` has to change with it.

### What this changes in practice

Nothing today: the house slot stays, because the binding constraints are traffic and network
permission, not code. What changes is the shape of the revisit, and the order of the questions.

1. **Ask the network, in writing, whether it permits placement in a desktop application.** This
   is first because it is the only one that can rule the whole thing out, and because doing it
   the other way round is how the AdSense tag got into `app.html` in the first place.
2. Reach their volume minimum.
3. Build the frame: a page on our own origin, its own CSP, their stock client, `frame-src` in
   the desktop CSP, and a renderer module returning a new string from `adNetwork()`.

Meanwhile the thing that can earn on this surface **today** is selling the slot directly — a
sponsor invoiced by us, rendered from this repository like the house promo already is. No
network, no CSP entry, no policy to satisfy, no code. `ui/features/sponsor.js` routes the ask.
[0007](0007-one-ask-one-dialog.md)
