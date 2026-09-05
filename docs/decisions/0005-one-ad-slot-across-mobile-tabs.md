# 0005 — One slot, outside the panes, shared by the phone tabs

**Status:** Accepted · 2026-09-04

## Context

The ad slot lived inside `<main id="mainPane">`. Below 900px `ui/shell/mobileNav.js` shows one
pane at a time — Text, Files, History — by hiding the others, so the slot existed on the Text
tab and nowhere else. Roughly two-thirds of phone sessions never saw it.

It cannot be fixed with CSS: `display:none` on an ancestor removes the entire subtree, so no
amount of `position:fixed` on `.adslot` keeps it on screen while `#mainPane` is hidden.

## Decision

The slot — and the publisher line beside it — moved out of `<main>` to become direct children
of `#shell`, between `.body` and the status bar. They are then outside every pane
`mobileNav` toggles, so one slot serves both the Text and Files tabs.

## Alternatives considered

**A second mount point in the Files pane, lazily mounted on first activation.** Rejected on
policy: AdSense forbids serving ads into hidden elements, and a rendered unit still ends up
hidden the moment the user switches tabs. It would also mean two units per page, which any
one-ad-per-page network rules out.

**Move the slot between panes as the tab changes.** Rejected: reparenting a mounted
`adsbygoogle` `<ins>` breaks it, and re-requesting on every tab switch inflates impressions —
which is how a publisher account gets flagged.

**Leave it on the Text tab.** The status quo, and the reason this was raised.

## Consequences

- **On wide layouts the two strips now span the full window rather than stopping at the
  splitter.** `ads.css` keeps a 56px left pad above 900px so they still line up with the
  editor text past the gutter, but the strip runs under the sidebar too. This is a visible
  change to the desktop web layout and is the price of one slot serving both phone tabs.
- The publisher line — the policy links an ad reviewer looks for — is now on every phone tab
  as well, which it was not before.
- The existing landscape rule (`mobile.css`, `max-height:480px`) still drops the slot entirely,
  where ~360px of height cannot spare it.
- A collapsed slot at shell level returns its height to `.body`, which is `flex:1`, so
  [0004](0004-collapse-an-unfilled-ad-slot.md) still works from here.
