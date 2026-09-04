# Security policy

RealtimeClipboard moves people's clipboards — passwords, tokens, one-time codes,
whatever happened to be copied last. A break here is not an inconvenience, so
please report one privately and give it a chance to be fixed before it is public.

## Reporting a vulnerability

**[Open a private advisory](https://github.com/akshaynikhare/RealtimeClipboard/security/advisories/new)**
— it is private to you and the maintainer, and it is the preferred route.

If that form is unavailable to you, email **info@realtimeclipboard.com** with
`SECURITY` in the subject.

Please do **not** open a public issue for a working attack on someone's session.

Include what you have: what you did, what you expected, what happened instead,
and the browser and version. A proof of concept helps enormously; so does saying
plainly if you are not sure whether the thing you found is a bug.

**Never paste a real share key or PIN into a report.** Use a throwaway session.
Anyone reading the report would otherwise be able to open the session you used
to demonstrate the problem.

### What to expect

This is a single-maintainer side project, not a funded product with an on-call
rota. Expect an acknowledgement within about a week. If a report is valid, you
will be credited in the advisory and the changelog unless you would rather not
be. There is no bug bounty and no money.

## Supported versions

The deployed site at `realtimeclipboard.com/` and the latest
tag are what get fixed. Older tags do not receive backports — a static frontend
updates the moment the tab is reloaded, so there is nothing to backport to.

Self-hosters run their own relay; see
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md). Fixes reach you when you redeploy.

## What is in scope

The parts that could expose a session or its contents:

- The key derivation and encryption in `src/core/crypto.js` — the room hash, the
  PBKDF2/HKDF chain, the locked-session PIN path.
- The relay in `backend/` — anything letting it, or a peer, read plaintext, join
  a room it should not, or replay a frame.
- The file layer in `src/files/` — accepting bytes from a device that was never
  allowed, or retracting a file off someone else's machine.
- XSS anywhere content is rendered, and anything defeating the CSP.
- A share key or PIN escaping into a URL, a log, a referrer, or storage that
  outlives the session.

## What is already known, and not a vulnerability

These are deliberate and documented in [docs/PRD.md](docs/PRD.md). Reports about
them are welcome as discussion, but they are design, not defects:

- **The share key is a bearer credential.** Anyone who has it can read the
  session. That is what makes a short key with no account possible.
- **A 4-digit PIN is weak** and the UI says so in bits. The stretching is set
  against an offline attacker, not against the arithmetic.
- **No background clipboard capture**, on any browser. `readText()` needs focus.
- **The relay sees traffic patterns** — room hashes, sizes, timing. It does not
  see plaintext, and the room hash is not reversible to the key.
- **A malicious peer already in your session** can do anything a peer can do.
  Sharing the key is the trust decision.
