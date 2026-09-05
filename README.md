# RealtimeClipboard — an end-to-end encrypted online clipboard that syncs text between devices

RealtimeClipboard is a free, open-source online clipboard: open it on two devices, type the
same short key, and whatever you copy on one is ready to paste on the
other. No account, no install, no database. Files travel peer-to-peer and never
touch the server.

**[Try it → realtimeclipboard.com](https://realtimeclipboard.com/)**

```
  Machine A  ──┐                                  ┌──  Machine B
               │   text  ──►  relay  ──►  text    │
               │   (encrypted in the browser)     │
               │                                  │
               └───  files ═══ direct P2P ═══─────┘
                     (never touch the server)
```

**Status: beta, and it works end to end.** The relay is deployed and live,
the frontend is wired to it over a WebSocket with an SSE fallback, and the
32-check end-to-end suite runs two real peers with real crypto against the
production relay. See [Known limitations](#known-limitations) for what is not
proven.

---

## What it does

- Syncs clipboard text between Windows, macOS, Android, ChromeOS and Linux
- Works across different networks, not just the same Wi-Fi and not just the same LAN
- No account, no sign-up, no email. A short key is the whole identity of a session
  (ten characters on the web, sixteen in the installed apps, and either works on both)
- End-to-end encrypted in the browser with AES-GCM; one `PBKDF2` derivation produces both the key and the room address
- Peer-to-peer file transfer over a WebRTC data channel, 5 MB per file
- Copy and paste images: a screenshot copied on one machine previews on the other
- Installable progressive web app, with its own window and icon, and it works offline
- Nothing written to disk, on your machine or the server
- Self-hostable relay, one small FastAPI service

## Why

Moving a snippet between a work laptop, a desktop and a phone is
disproportionately annoying. The alternatives want an account, an install with
admin rights, or an email to yourself. This wants a short key.

## How RealtimeClipboard compares to Snapdrop, PairDrop, LocalSend and AirDrop

The nearby tools are mostly *file droppers*: you pick a device and push a file at
it. RealtimeClipboard is a clipboard — what you copy shows up ready to paste, without
picking anything.

| Tool | Account | Install | Across networks | Lands on system clipboard | Files |
|---|---|---|---|---|---|
| **RealtimeClipboard** | None | None — browser | Yes | **Yes** | P2P, 5 MB |
| PairDrop | None | None — browser | Yes, via a 6-digit code | No — you send a message | P2P |
| Snapdrop | Optional since the LimeWire acquisition | None — browser | Same network only | No | P2P |
| LocalSend | None | Native app on both ends | Same network only | No | Unlimited, LAN |
| AirDrop | None | Built in | Nearby devices only | No | Unlimited |
| KDE Connect | None | App on both ends | Same network only | Yes | Yes |
| Pushbullet | Required | App or extension | Yes | Paid tier | Paid above a small cap |

Checked against each project's own documentation in August 2026. Corrections
welcome — open an issue.

## How it works

| Layer | Choice |
|---|---|
| Frontend | Static HTML/JS on Cloudflare Pages, installable as a Chrome PWA |
| Relay | FastAPI on FastAPI Cloud — in-memory rooms, no database, no disk |
| Text | WebSocket through the relay, AES-GCM encrypted in the browser |
| Blocked networks | If a proxy eats the WebSocket, the client moves itself to SSE + POST on the same host and says so |
| Files | WebRTC data channel, direct between peers, 5 MB cap |
| Key | `PBKDF2(key)` is expanded with HKDF into the AES key and the room address. Neither the key nor anything reversible to it is transmitted |

The relay only ever sees a room hash and ciphertext. It cannot decrypt anything,
and it stores nothing beyond the last message in RAM.

## Frequently asked questions

### What is an online clipboard?

An online clipboard is a web page that holds what you copy on one device so you
can paste it on another. Both devices open the same page, identify themselves
with a short key, and share a single clipboard between them.

### How do I sync my clipboard between my phone and my PC?

Open RealtimeClipboard on both, type the same short key on each, and copy
something. It arrives on the other device ready to paste. Nothing to install, so
it works on a machine where you do not have admin rights.

### Does it work if the two devices are on different networks?

Yes. Text goes through a relay, so a laptop on home Wi-Fi and a phone on mobile
data share a clipboard fine. This is the main difference from Snapdrop, LocalSend
and AirDrop, which need both devices on the same network. Files are the
exception — they go directly between machines, and that is the part corporate
firewalls sometimes block.

### Is an online clipboard safe?

It depends on whether the server can read what you copy, and here it cannot. Text
is encrypted in the browser before it is sent; the server sees a room hash and
ciphertext and keeps neither. The honest caveat is that the key is a bearer
credential — anyone who learns it can read that session while it is open.

### Can it read my clipboard in the background?

No, and neither can any other web app on any browser. `readText()` requires
window focus. You switch to the RealtimeClipboard tab and it picks up what you copied.

### Which browsers work?

Chromium browsers get the full experience. Firefox and Safari can receive
everything and can send anything you paste in by hand, but cannot read the
clipboard on their own.

## Repo layout

```
index.html              marketing landing page (indexable)
app.html                the app itself (noindex) — served at /app; the .html is
                        rewritten out by tools/build/build.mjs, in the deploy only
src/
  main.js               composition root — the only file that crosses layers
  core/                 bus, config, state, crypto, keys, storage, paths — no DOM
  transport/            relay facade + interchangeable WebSocket and SSE channels
  clipboard/            OS clipboard read/write, capture tiers
  files/                thumbnails, registry, chunking, P2P transfer
  ui/                   primitives → shell + features → panels, in that order
  styles/               design tokens + per-component CSS; lazy/ is fetched on demand
  landing/              behaviour for index.html — a separate document from the app
  pages/                help/ blog/ download/ — copied to the site root, not bundled
cli/                    the same crypto and protocol, on the command line
backend/                FastAPI relay — deployed separately, shares no code
desktop/                Tauri shell around this very src/ — no second implementation
assets/                 icons/ (precached whole) + social/ (the OG card, never)
tests/                  unit/ needs nothing · dom/ needs jsdom · live/ needs a relay
tools/                  build/ · check/ · release/ · seo/
docs/                   PRD, architecture, clipboard design, P2P design, threat model
```

A directory **at the root** is served at its own path — `assets/icons/icon.svg` is
`/assets/icons/icon.svg`. `src/` is the opposite: inputs that get bundled, plus `src/pages/`, which
is lifted to the site root at build time. `app.html` and `index.html` stay at the root so the app
keeps a dev loop where the disk path and the URL are the same string.

**Every directory carries its own `CLAUDE.md` and `README.md`** — the rules that
govern a change live next to the code they govern, and a static check fails if a
directory has neither. Start at [src/CLAUDE.md](src/CLAUDE.md) for the import
rules.

Details and conventions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

**Frontend** — any static server (ES modules need HTTP, not `file://`):
```bash
python -m http.server 8080
# http://127.0.0.1:8080
```

**Relay:**
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --port 8000
python test_relay.py ws://127.0.0.1:8000    # 51-check protocol gate
python test_sse.py http://127.0.0.1:8000    # 33-check fallback gate
```

The relay must be on **port 8000**: `src/core/config.js` points the app there
automatically when the page is served from localhost, so nothing needs
configuring — but nothing else will be found either. Open `app.html#DEVKEY` in
two windows to watch a clip cross between them.

`app.html` here, not `/app`: the clean URL is a deploy-time rewrite in
`tools/build/build.mjs`, and `python -m http.server` does not strip extensions. The
same is true of the desktop app, which ships this tree as it stands.

With the relay running, `node tests/live/fallback.mjs ws://127.0.0.1:8000` exercises
the client's WebSocket → SSE failover with WebSockets simulated as blocked.

Full setup, the service-worker cache trap, and how to check a UI change:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). For deployment see
[backend/README.md](backend/README.md), **including the replica-pinning step
that must not be skipped.**

## Contributing and releasing

```bash
npm install                          # sets up the git hooks
git switch -c fix/whatever           # main refuses direct commits
git commit -m "fix(scope): what changed"
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the full loop, the commit convention, and
the boundaries the static checks enforce. Security problems go through
[SECURITY.md](SECURITY.md), not the issue tracker.

The tests run **locally, in a git hook, before the commit exists** — there is no
CI. GitHub's only workflow copies files to Pages, and it runs on a version tag
and nothing else. The reasoning, the trade that comes with it, and the commit
message format the changelog is generated from are in
[docs/RELEASING.md](docs/RELEASING.md).

```bash
npm run verify                       # what the pre-commit hook runs
npm test                             # everything, needs a relay
npm run release -- minor             # verify, changelog, release PR, tag, deploy
```

## Docs

| Doc | What it covers |
|---|---|
| [THREAT-MODEL.md](docs/THREAT-MODEL.md) | **What is protected and what is not, with the arithmetic.** Read this before trusting the encryption claim |
| [PRD.md](docs/PRD.md) | Requirements, architecture, security model, open issues |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running it locally, the test suite, the landing-page grid and globe, and the traps |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module layout, boundaries, and how to add a feature |
| [RELEASING.md](docs/RELEASING.md) | Hooks instead of CI, tag-triggered deploys, and the generated changelog |
| [CHANGELOG.md](CHANGELOG.md) | What shipped in each release — generated from the commits |
| [CLIPBOARD-FLOW.md](docs/CLIPBOARD-FLOW.md) | How the browser reaches the OS clipboard, and why background capture is impossible |
| [P2P-FILES.md](docs/P2P-FILES.md) | Thumbnails over the relay, bytes over WebRTC, and the corporate-network problem |
| [ACCESSIBILITY.md](docs/ACCESSIBILITY.md) | Keyboard paths, focus handling, and what the screen reader announces |
| [SELF-HOSTING.md](docs/SELF-HOSTING.md) | Running your own relay and pointing a build at it |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, the commit convention, and the boundaries the checks enforce |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability privately, and what is in scope |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1 |

## Known limitations

- **No background clipboard capture.** No web app can do this on any browser —
  `readText()` requires window focus. You switch to RealtimeClipboard and it grabs what you
  copied. [Why](docs/CLIPBOARD-FLOW.md).
- **P2P file transfer may fail on corporate networks**, which block the UDP that
  WebRTC needs. Falls back to relay-chunked transfer, labelled visibly.
- **The share key is a bearer credential.** Anyone holding it can read the session.
- **Share links created before v0.5.0 no longer work.** The room hash is now
  derived through the same 250k PBKDF2 as the encryption key, and generated keys
  went from 6 characters to 10. Both were needed to stop the relay operator being
  able to reverse a room hash back to a share key — the reasoning and the
  arithmetic are in [THREAT-MODEL.md §4](docs/THREAT-MODEL.md).
- Chromium-first. Firefox and Safari can receive and can send via paste, but
  cannot silently read the clipboard.

## Licence

[MIT](LICENSE).
