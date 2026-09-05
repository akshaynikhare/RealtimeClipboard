# docs/decisions/

Architecture Decision Records. One file per decision, numbered, never renumbered.

A record is written when a choice would otherwise survive only as a shape in the code —
something a later reader would reasonably undo because the reason is invisible. Each one is
**Status · Context · Decision · Alternatives considered · Consequences**, and the
Consequences section is the load-bearing one: it says what breaks if the decision is reversed.

Superseding rather than editing is the rule. A record whose decision no longer holds gets its
Status changed to `Superseded by NNNN`, and keeps its text — the reasoning that turned out to
be wrong is the most useful thing in the directory.

| # | Decision | Status |
|---|---|---|
| [0001](0001-adsense-only-on-web-surfaces.md) | AdSense runs on the web surfaces only | Accepted |
| [0002](0002-house-slot-on-the-desktop-app.md) | The desktop app shows a house slot, not a third-party network | Accepted |
| [0003](0003-rtc-surface-dimension-in-ga4.md) | GA4 carries an `rtc_surface` dimension on every event | Accepted |
| [0004](0004-collapse-an-unfilled-ad-slot.md) | An ad slot that does not fill gives its height back | Superseded by 0006 |
| [0005](0005-one-ad-slot-across-mobile-tabs.md) | One slot, outside the panes, shared by the phone tabs | Accepted |
| [0006](0006-house-promo-instead-of-collapsing.md) | An unfilled slot shows the house promo, it does not collapse | Accepted |
| [0007](0007-one-ask-one-dialog.md) | One download offer, and "Sponsor" opens a dialog rather than a tier list | Accepted |
| [0008](0008-minimum-key-length.md) | A share key is at least six characters; a shorter one is refused at a gate | Accepted |
| [0009](0009-the-os-owns-the-theme-unless-told-otherwise.md) | The OS owns the theme, with a System/Light/Dark override | Accepted |
