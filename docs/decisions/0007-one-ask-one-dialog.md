# 0007 — "Sponsor" opens a dialog, and there is one download offer, not three

**Status:** Accepted · 2026-09-05 · refines [0006](0006-house-promo-instead-of-collapsing.md)

## Context

Two things were noticed on the same screenshot of the running app, and they are the same
problem seen twice: the app asks for things more often than it explains them.

**Download, three times, at once.** The header carried the one-shot offer row
("RealtimeClipboard also runs as an app · Desktop app · Install"), a standing line under the
editor said "Get the desktop & mobile apps", and the footer nav carried a Download link. Three
pitches for one action, all visible together, on a page whose job is to hold text.

The standing line had a stated reason: the header offer is one-shot, so once it is dismissed
there is no route back. That reason stopped being true when the app footer landed — its nav
has carried Download ever since.

**"Sponsor" went straight to a tier list.** Both the header link and the house promo's CTA
were bare anchors onto GitHub Sponsors. Two words, then a payment page — with nothing having
said what the money pays for, that the relay is the cost, or that there is a free way to help.
The house promo's link also had no `target`, so on the web it navigated the app away and took
the session with it.

**The promo lost its border.** [0006](0006-house-promo-instead-of-collapsing.md) had the
house renderer add `.adlive`, which is the class that says "a real unit is here" and drops the
placeholder outline. A borderless promo reads as a paragraph that wandered in under the
editor rather than as a reserved space with nothing sold in it.

## Decision

**One offer of the apps.** The standing `#mount-getapp` line is gone, with it `.getapp` in
`styles/lazy/install.css` and `mountGetApp()` in `ui/features/install.js`. What remains is the
dismissible header offer (the *ask*) and the footer's Download link (the *route*).

**One sponsor ask, and it is a dialog.** `ui/features/sponsor.js` opens a modal that says what
the relay costs and gives three routes, cheapest first: leave the ads on (or, where there are
none, tell someone), GitHub Sponsors, and a direct approach for a company that wants the slot.
Both entry points — the header link and the house promo's CTA — open it.

The header stays an **anchor** with a live `href`. Only the plain left click is intercepted, so
middle-click, Ctrl/Cmd-click and "copy link address" still reach GitHub, which is the reason
`appLinks.js` used an anchor in the first place.

**It is not a form, and cannot become one.** `src/pages/contact/` records why this site has no
contact form: a form has to post somewhere, and that is a server holding other people's
messages. Every route out of the dialog is a link the reader's own client owns.

**The promo keeps a border.** `.adhouse` instead of `.adlive` — dotted rather than the
pre-load dashed, which is the difference between "nothing here yet" and "nothing here".

## Alternatives considered

**Drop the footer Download link and keep the standing line.** Backwards: the footer nav is
where a reader looks for a permanent route, and the line under the editor was the one
competing with the text.

**Keep "Sponsor" as a plain link and just fix its `target`.** Fixes the session-loss bug and
nothing else. The complaint was that the link led nowhere meaningful, not that it opened in
the wrong tab.

**A real sponsorship form.** Blocked by the contact page's own decision, above. A `mailto:` is
the form: it opens the reader's client, prefilled, and posts to nobody.

**The same `mailto:` on desktop.** It is dead there — `externalLinks.js` hands external links
to `open_external`, which allow-lists two https hosts, and wry does nothing with a `mailto:`
by itself. The desktop dialog offers the contact page instead, which carries the same address
in prose and is an allowed host. Widening the Rust allow-list to a URL scheme was rejected as
a larger security surface than the problem.

## Consequences

- Someone who dismisses the header offer and never opens the footer will not be asked about
  the apps again. That is the intent: an offer declined is an answer.
- `SITE.EMAIL` now exists in `core/config.js`. `src/pages/contact/`, `src/pages/about/` and
  the AdSense publisher identity all name the same address in markup — a change here is a
  change there, and nothing enforces it.
- The dialog is lazily imported from the header (a literal specifier inside a thunk) and
  statically imported by `house.js`, which is itself lazy. A session that never opens it pays
  for neither the module nor `styles/lazy/sponsor.css`.
- `tests/dom/links.mjs` now covers all three routes out of the dialog, including the assertion
  that the desktop ask is not a `mailto:`. Reintroducing one fails the suite.
- The house slot is visibly a placeholder again. If a real desktop ad network ever lands
  ([0002](0002-house-slot-on-the-desktop-app.md)), it takes `.adlive` and the border goes.
