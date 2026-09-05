# 0006 — An unfilled ad slot shows the house promo, it does not collapse

**Status:** Accepted · 2026-09-05 · supersedes [0004](0004-collapse-an-unfilled-ad-slot.md)

## Context

[0004](0004-collapse-an-unfilled-ad-slot.md) had the slot give its height back when no ad
arrived. Seen in the running app, that was the wrong answer to a real problem.

Two things showed up:

- **The space is reserved either way.** Collapsing does not win back a row — the layout is
  built around the slot, and the editor grows by the slot's height only to shrink again if a
  refill lands. What it does buy is a jump, at the moment the reader is least expecting one.
- **A collapsed slot cannot refill.** AdSense can serve into a unit that was empty a moment
  ago. Removing it forecloses that for the rest of the session.

There was also a bug on the way to this, worth recording because it hid the behaviour: the
fill watcher treated `data-ad-status="filled"` as final. "Filled" is the auction's answer, not
the page's — an account still in review reports it and paints nothing, *and* cancels the
timeout that would otherwise have caught the empty box.

## Decision

The slot never collapses and never sits empty. When no ad arrives — unfilled, blocked,
offline, or filled-but-blank — the box is handed to the **house promo**, the same renderer the
desktop app uses.

`settle(false)` now means "fall back", not "hide". `.adslot-gone` and the `:has()` rules that
gave its column back are gone.

The promo's copy differs by caller, because the two situations are not the same thing:

- **Desktop** — "No third-party ads in the desktop app. Nothing here reaches a network." True:
  no ad network is reachable there at all ([0001](0001-adsense-only-on-web-surfaces.md)).
- **Web fallback** — "No ad to show right now. Ads are what pay for the relay." Also true: the
  tag loaded, it simply had nothing to serve. Saying "no third-party ads" on the web would be
  a lie.

Detecting filled-but-blank measures the **iframe** AdSense paints into, not the `<ins>`. A
narrow unit is requested at a fixed 320×50 and carries that height inline whether or not
anything arrived, so measuring the `<ins>` would report every empty phone slot as rendered.

## Alternatives considered

**Keep collapsing.** Rejected above.

**Reserve the space and leave it empty.** What the code did by accident while the fill bug
was live. An empty bordered box reads as broken; a promo reads as deliberate.

**Drop the slot from the web too.** Not on the table — it is what pays for the relay.

## Consequences

- The slot's height is now constant, whatever happens. No layout shift, ever.
- Adblocker users see the house promo rather than an empty box, which is a better trade for
  everyone: they lose nothing and the project gets a line about the CLI and Sponsor.
- A late refill still has somewhere to land — though the promo now occupies it, so if refills
  turn out to matter, the promo needs to yield rather than the slot needing to reappear.
- `AD.SETTLE_MS`, `AD.RENDER_GRACE_MS` and `AD.MIN_RENDERED_PX` still decide *when* the
  fallback fires; only the action changed.
