# 0004 — An ad slot that does not fill gives its height back

**Status:** Superseded by [0006](0006-house-promo-instead-of-collapsing.md) · 2026-09-05

> Reversed after seeing it. The reasoning below still describes the problem correctly —
> an empty reserved box is waste — but collapsing was the wrong answer to it. 0006 has
> the replacement and why.

## Context

`mount()` added the `.adlive` class the moment it ran, which drops the placeholder's dashed
outline. When the ad never arrived — blocked by an extension, offline, or an unfilled auction
— the result was an empty ~90px box above the status bar for the whole session, taking that
height directly out of an editor that is the entire point of the app.

## Decision

**Reserve, then collapse.** The slot keeps its reserved height so nothing moves when an ad
does load, and gives it back once the outcome is known. Three outcomes:

- **filled** → keep
- **unfilled** → collapse. AdSense sets `data-ad-status="unfilled"` on the `<ins>`; a
  `MutationObserver` on that attribute is the signal.
- **never settled** → collapse after `AD.SETTLE_MS`. This is the one that catches a blocked
  script, an offline start and an empty publisher ID, none of which ever set an attribute.

Collapsing adds `.adslot-gone` (`display:none`) to the `<aside>`. It sits `flex:none` in a
column whose editor is `flex:1`, so the height returns to the textarea with no other change.

**A filled unit is never collapsed.** Cutting off a rendered ad is an AdSense policy
violation — the same reason `ads.css` reserves with `min-height` rather than `height`.

## Alternatives considered

**Start collapsed, expand when an ad renders.** Zero wasted space ever, including for every
adblocker user. Rejected because the slot sits directly below the editor, so the textarea
would shrink under the user mid-keystroke. One shift on failure beats one shift on success.

**Only watch `data-ad-status`.** Insufficient: the failure modes that matter most — script
blocked, no network — never set it, because the script that would set it never ran.

**Collapse the box but keep the "Sponsored" chrome.** Rejected: a label over nothing is worse
than nothing.

## Consequences

- Adblocker users get the editor space back instead of a hole.
- `AD.SETTLE_MS` is a timing guess. Too short throws away a slow fill; it lives in
  `src/core/config.js` with the other limits so it is tunable in one place.
- The renderers now report an outcome, so any future network has to answer the same question —
  which is the right shape for the contract anyway.
