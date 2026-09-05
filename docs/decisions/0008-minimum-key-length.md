# 0008 — A share key is at least six characters, and a shorter one is refused at a gate

**Status:** Accepted · 2026-09-05

## Context

Typing `app.html#F5H4` into the address bar opened a working session.

Four characters over a 30-character alphabet is ~19.6 bits: 810,000 rooms for the entire
keyspace. The room's name is `SHA-256`/PBKDF2 of the key, and `CRYPTO.SALT` is one global
constant, so the table an attacker builds is built **once** and opens every unlocked session
of that length, for everyone, for as long as the salt stands — the same argument
`KEY.LENGTH`'s own comment makes for why six was raised to ten in the first place.

Nothing downstream was ever going to object. The relay routes a room hash without knowing or
caring how much entropy went into it, which is the point of the design: it cannot read the
traffic, so it cannot judge the key either. **The client is the only place this can be
enforced**, and the client enforced `length >= 4`.

Worse, the floor existed in three places with three different values in effect:
`keys.isValid()` (4), `landing/landing.js` (its own literal `4`), and
`landing/redirect.js` (its own literal `4`, which also decided whether a share link forwarded
to the app at all).

## Decision

**`KEY.MIN_LENGTH = 6`**, in `core/config.js`, and `keys.isValid()` is the only reader.
`landing.js` calls `isValid()`; `redirect.js` stops judging length entirely and forwards
anything that survives normalisation.

Six, not ten, because six is the shortest key any build ever *generated*. Raising the floor
above what the app itself handed out would kill working links, which is a worse failure than a
weak room whose holder chose it.

**A refused key opens nothing.** `resolveKey()` returns `intent: "rejected"` and boot skips
`startSession()` — no derivation, no connection, no room. The earlier behaviour was to fall
through to the next key source, which generated a fresh one: two people following the same bad
link landed in two different rooms and the app looked perfectly healthy in both.

**The response is a gate, not a banner.** The same full-screen scrim the lock flow uses, for
the same reason its module header gives: an app that accepts text, marks it SENT and reaches
nobody is the failure this project is least willing to have. The card states the length, the
bits, and the floor; shows the key back so the reader can see which link is bad; offers "Start
a new session"; and links the GitHub issue chooser, because "your link is wrong" is
occasionally the app's fault and the reader is the one who can say so.

`ui/shell/lockGate.js` and `ui/shell/keyGate.js` are now two sets of words over one
`ui/shell/gate.js`, and the styles moved from `styles/lazy/lock.css` to `styles/lazy/gate.css`.

`keys.rejectReason()` answers *why*, so the CLI and the VS Code extension stopped saying
`"X" is not a valid key` and now say which rule was hit, via `keys.rejectMessage()`.

## Alternatives considered

**Raise it to ten, matching `KEY.LENGTH`.** Rejects every six-character link an earlier build
produced. The floor is about what we will *accept*, not what we *emit*, and those are different
questions — see the alphabet, where validation has always been the more permissive of the two.

**Open a fresh session and explain in a dismissible banner.** Never blocks, but silently splits
two people who followed the same link into different rooms — the failure mode above, with an
explanation nobody reads because the app appears to be working.

**Enforce it in the relay.** It cannot: the relay sees a room hash, which is fixed-width
whatever went into it. Enforcing there would also mean the relay deciding what a valid session
is, which is the opposite of its design.

**Leave it and document the risk.** The address bar is a supported way to join a session and
the guide says so. A documented footgun in the one control a user types by hand is not a
mitigation.

## Consequences

- **Any existing 4- or 5-character link stops working.** No build ever generated one, so this
  can only affect a key somebody chose by hand. They get an explanation and a new session, not
  a blank page.
- `KEY.MIN_LENGTH` and `KEY.MAX_LENGTH` join the compatibility surfaces in the root
  `CLAUDE.md`: lowering the floor later re-opens the guessable range, raising it strands links.
- `tests/unit/keyfloor.mjs` pins both ends, the reason strings, and the fact that an *empty*
  key still means "generate one" rather than "refuse" — collapsing those two either gates every
  new visitor or swallows a bad link.
- Test keys had to grow. `D75LV` is five characters and now fails validation; it survives only
  in `tests/unit/lock.mjs`, where it is a golden hashing vector rather than a key anything
  validates. `tests/CLAUDE.md` records the new throwaway, `D75LVX9QRS`.
- The gate is the second caller of a scrim that had exactly one. A third would be a smell —
  at that point the question is why so many things stop a session opening.
