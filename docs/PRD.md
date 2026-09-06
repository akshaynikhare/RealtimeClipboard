# RealtimeClipboard — Product Requirements Document

| Field | Value |
|---|---|
| Product | RealtimeClipboard — realtime multi-directional clipboard sync |
| Version | 0.2 (draft) |
| Date | 2026-08-05 |
| Status | Draft — core decisions settled (§11.1), remainder open (§11.2) |
| Platforms | Windows, macOS, Android — Chrome-first |
| Stack | Static PWA on Cloudflare Pages + FastAPI relay on FastAPI Cloud (free), E2E encrypted. Text over the relay, files P2P |
| Reference | https://live-clipboard.netlify.app/D75LV |

---

## 1. Overview

### 1.1 Problem
Moving a snippet of text between two machines you own (work laptop ↔ desktop ↔ phone, or a VM/RDP session ↔ host) is disproportionately annoying. Existing options require accounts (Google/Apple ecosystems), installs with admin rights, or emailing yourself.

### 1.2 Product
A static web app. Open it on machine A, get a short share key (e.g. `D75LV`). Enter the same key on machine B. From then on, copying on either machine makes that content available on the other — **multi-directional**, realtime, no account, no install required, and installable as a Chrome app if the user wants it.

### 1.3 Goals
| # | Goal |
|---|---|
| G1 | Two or more machines sync clipboard text in realtime via a short shared key |
| G2 | Sync is multi-directional — every peer is both reader and writer, no host/client roles |
| G3 | Installable as an app from Chrome (PWA), with its own window and icon |
| G4 | Read from and write to the **system** clipboard, not just an in-page textarea |
| G5 | Frontend is a static site hosted on Cloudflare Pages (GitHub Pages until v0.2.1) |
| G6 | Minimum backend: no database, no user accounts, all room state in memory |
| G7 | Zero-friction: land on URL → working in under 10 seconds, no signup |
| G8 | Cross-platform: Windows, macOS and Android, targeting Chrome on all three |
| G9 | Works inside locked-down corporate environments — **no extension install required** |

### 1.4 Non-goals
- **A Chrome extension — permanently excluded.** The target corporate environment blocks extension installation, so the product must work as a plain web app / PWA. This is a hard product constraint, not a phasing decision, and it means background clipboard capture is off the table for good (§5.1).
- User accounts, login, persistent history across sessions
- Native desktop apps (Electron/Tauri)
- Server-side file storage of any kind — files move peer-to-peer or not at all (§3.7)
- Server-side persistence of any clipboard content, ever
- Firefox/Safari **silent** clipboard read (platform-blocked — see §5.1)

### 1.5 Success criteria
- Two Chrome machines on the same key propagate a copied string in **< 300 ms** p95
- A cold visitor with a key reaches synced state in **≤ 3 interactions** (open link → grant clipboard permission → done)
- Total recurring infrastructure cost: **$0** at expected volume

---

## 2. Personas & journeys

**P1 — Dev on two machines.** Copies an error string on a VM, wants it in the browser on their laptop.
**P2 — Phone ↔ desktop.** Copies a URL on Android Chrome, wants it on desktop.
**P3 — Support/pairing.** Two people on a call share a temporary key to pass tokens/snippets back and forth.

### Journey A — Create a room
1. User opens `https://realtimeclipboard.com/`
2. App auto-generates key `D75LV` and shows it large, with a Copy-link button and a QR code
3. URL becomes `.../RealtimeClipboard/#D75LV` (shareable, bookmarkable)
4. Status pill shows `Connected · 1 device`

### Journey B — Join from second machine
1. User types `D75LV` into the join box (or opens the link/scans QR)
2. Both devices show `Connected · 2 devices`
3. Latest clipboard value already in the room is delivered to the joiner immediately

### Journey C — Sync a copy
1. User copies text on machine A (Ctrl+C anywhere in the OS)
2. Machine A's RealtimeClipboard tab detects it (see §5.1 capture modes) and broadcasts
3. Machine B receives it; per its mode setting, either writes it to the system clipboard automatically or shows a "New clip — Paste" card with one-click copy
4. Both devices show the entry at the top of the session list

### Journey D — Install as app
1. Chrome shows the install icon in the address bar (PWA criteria met)
2. User installs; RealtimeClipboard opens in a standalone window with icon, remembering the last key

---

## 3. Functional requirements

### 3.1 Session / room key
| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | Auto-generate a key on first visit with no key present | Must |
| FR-1.2 | Key alphabet excludes ambiguous chars (`0/O`, `1/I/L`), i.e. Crockford-style base32; default length **6** | Must |
| FR-1.3 | Key is carried in the URL **fragment** (`#D75LV`), never the path or query — see §5.2 and §7.3 | Must |
| FR-1.4 | Manual join box accepts a key case-insensitively, trims whitespace/dashes | Must |
| FR-1.5 | "Copy link" and QR code for the current room | Should |
| FR-1.6 | Leave / rotate key (generates a new room, drops the old connection) | Should |
| FR-1.7 | Last-used key persisted in `localStorage`, offered as "Rejoin `D75LV`" on next launch | Should |
| FR-1.8 | **Locked sessions.** A session may carry a second secret — a PIN — that is never in the link. It is folded into the derivation of both the encryption key and the room hash, so a device holding the link without the PIN reaches a different room entirely (§7.5) | Should |
| FR-1.9 | The PIN is **never** in the URL, never in `localStorage`, never sent to the relay, and never logged. Within a tab it may be remembered only as its PBKDF2 output, in `sessionStorage`, scoped to the share key | Must |
| FR-1.10 | The link carries a lock **marker** (`#!D75LV`) — that a session is locked is not a secret. The marker is parsed before key normalisation, since normalisation would strip it and yield a valid unlocked key | Must |
| FR-1.11 | A link marked locked **must not open a connection** until the PIN is given. Cancelling leaves the app idle; it must never fall through to the unlocked room of the same name | Must |
| FR-1.12 | Locking, unlocking and changing the PIN each start a **new room**, because the lock state and the PIN are both part of the room's name. The UI says so before acting | Must |
| FR-1.13 | Minimum PIN length **6**, free-form. The dialog states the entropy in bits as it is typed | Should |
| FR-1.14 | A locked session distinguishes **confirmed** from **unconfirmed**: the padlock claims privacy only once something in the room has actually decrypted | Must |
| FR-1.15 | **Locking is reachable in one press.** A `Lock session` control sits in the app header, beside the mode switch. It opens the PIN dialog when pressed and at no other time — nothing about locking is ever raised unprompted | Should |
| FR-1.16 | **Only the founder may lock a shared session.** Alone, any device may. With other devices present, only the one that was first into the room — the relay's `welcome.existing` is the authority, not the client's own belief. A device that may not is told why rather than shown a control that silently does nothing | Must |
| FR-1.17 | **Locking says goodbye.** Because FR-1.12 makes locking a room change, the devices left behind are removed from the session, not merely desynchronised. Before leaving, the locking device plants a sealed sentinel in the old room; every device that reads it disconnects and is shown what happened and what it would now need to rejoin. The relay retains it, so a device that was offline at that moment — or that follows the old link afterwards — is told too | Must |

### 3.2 Clipboard engine
| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | Write received content to the system clipboard via `navigator.clipboard.writeText()` | Must |
| FR-2.2 | Read local clipboard via `navigator.clipboard.readText()` when permitted and focused | Must |
| FR-2.3 | Capture local copies via `paste` event (user presses Ctrl+V inside the app) with no permission required — the always-available fallback | Must |
| FR-2.4 | Poll/read clipboard on `focus` and `visibilitychange` → visible, so returning to the tab picks up whatever was copied elsewhere | Must |
| FR-2.5 | Optional foreground polling at a configurable interval (default 1000 ms) while the tab is focused | Should |
| FR-2.6 | **Loop suppression**: content written locally as a result of a remote message must not be re-broadcast. Enforced by content hash + `originId` + a 1500 ms suppression window | Must |
| FR-2.7 | Ignore empty strings and duplicates of the current value | Must |
| FR-2.8 | Max payload 32 KB in v1; larger clips are rejected with a visible toast | Must |
| FR-2.9 | In-session history list (last 20 clips, in memory + `sessionStorage` only), each with one-click copy | Should |

### 3.3 Sync / transport
| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | Persistent WebSocket to the relay, one connection per tab | Must |
| FR-3.2 | Server broadcasts a clip to **all peers in the room except the sender** | Must |
| FR-3.3 | Server holds only the **last** clip per room in memory, for delivery to late joiners | Must |
| FR-3.4 | Room state evicted after **10 min** with zero connected peers | Must |
| FR-3.5 | Auto-reconnect with exponential backoff (1s → 30s cap) and jitter; resubscribe on reconnect | Must |
| FR-3.6 | Heartbeat ping/pong every 30 s to survive idle-timeout proxies | Must |
| FR-3.7 | Presence: peer count broadcast on join/leave | Should |
| FR-3.8 | Last-write-wins ordering using a monotonic per-room sequence number assigned by the relay | Must |
| FR-3.9 | **Transport failover.** Where a WebSocket cannot be established — including the case where it hangs rather than fails — the client falls back to SSE + POST on the same host, without user action, and states which transport is in use. The remembered choice expires so leaving that network restores the default | Must |
| FR-3.10 | **Transport override.** The connection item in the status bar picks the transport: Automatic, WebSocket, or HTTP fallback. A pinned transport does not fail over (the status bar says `locked`) and does not expire, and pinning one must not teach the automatic path anything — a forced success is a click, not evidence about the network | Should |

### 3.4 Installability (PWA)
| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | `manifest.webmanifest` with `name`, `short_name`, `start_url`, `display: standalone`, `theme_color`, 192/512 px icons (incl. maskable) | Must |
| FR-4.2 | Service worker caching the app shell so the UI loads offline (sync itself requires network) | Must |
| FR-4.3 | Served over HTTPS — satisfied by Cloudflare Pages, and enforced by `Strict-Transport-Security` in `_headers` | Must |
| FR-4.4 | Custom in-app "Install" action driven by `beforeinstallprompt` | Should |
| FR-4.5 | `start_url` must restore the last room from `localStorage` (fragments are not preserved by the manifest) | Must |
| FR-4.6 | SW update flow: new version detected → non-blocking "Update available · Reload" toast | Should |

### 3.5 Settings

Persisted in `localStorage`. **Not a panel** — every setting lives in a slide-up
menu on the status-bar item that already reports the thing it governs:
connection → transport, device count → roster and session keys, Live sync →
clipboard and receiving, P2P → files, gear → key strength and pointer sharing.

It was a sidebar pane. On a phone that made it one tab out of four, so every
setting, the device roster, and the split-brain warning that means sync has
silently stopped all sat behind the editor until someone went looking. The
status bar is on screen in every view on every layout, which is also why an item
holding a menu is never dropped at narrow widths — hiding it would hide the only
route to what is inside.

| ID | Setting | Default |
|---|---|---|
| FR-5.1 | **Auto-write to clipboard** — apply incoming clips to system clipboard automatically | On |
| FR-5.2 | **Auto-read local clipboard** — capture local copies while focused (needs permission) | On, degrades to manual |
| FR-5.3 | **Poll interval** — 500 / 1000 / 2000 ms, or Off | 1000 ms |
| FR-5.4 | **Direction** — Both / Send only / Receive only | Both |
| FR-5.5 | **Notifications** — toast on incoming clip | On |
| FR-5.6 | **Clear history** / **Leave room** actions | — |
| FR-5.7 | Device nickname shown in the peer list | auto (`Chrome · Windows`) |

### 3.6 UI

Three panels, no navigation, everything on one screen. Built as [`index.html`](../index.html).

```
┌────────────────────────────────────────────┬──────────────────────────────┐
│ Text Editor      653/24000  ⛶ ⧉ ⎘ ⤳        │ Files & Images    ● P2P idle │
│────────────────────────────────────────────│──────────────────────────────│
│  1  https://tibco-p.aws.local:8000/…       │  ┌──────────────────────┐    │
│  2                                          │  │ Drop files or click  │    │
│  3  Correlation ID                          │  │ Max 5 MB each · P2P  │    │
│  4  c866bac7a1d54ccaa85455de0d9d667a        │  └──────────────────────┘    │
│  5                                          │   ┌────┐┌────┐┌────┐        │
│  6  [                                       │   │IMG ││ 📄 ││IMG │  HERE  │
│  7    {                                     │   └────┘└────┘└────┘        │
│  8      "error": "UNEXPECTED_ERROR",        │   shot.png  log.txt  ui.jpg  │
│  9      "message": "…"                      │   1.2 MB    18 KB    840 KB  │
│ 10    }                                     ├──────────────────────────────┤
│ 11  ]                                       │ Session            ● Preview │
│                                             │──────────────────────────────│
│                                             │ SHARE KEY                    │
│     (line numbers, monospace, wraps)        │  ┌───────┐ [Copy link][New]  │
│                                             │  │ D75LV │                   │
│                                             │  └───────┘                   │
│                                             │ ⚠ Anyone with this key…      │
│                                             │                              │
│                                             │ DEVICES                   3  │
│                                             │  ● This device (you)         │
│                                             │  ● Chrome · Windows    P2P   │
│                                             │  ● Chrome · Android   RELAY  │
│                                             │                              │
│                                             │ CLIPBOARD    T3 auto-capture │
│                                             │  Auto-write incoming   [=O]  │
│                                             │  Auto-read on focus    [=O]  │
│                                             │  Poll while focused  [1s ▾]  │
│                                             │                              │
│                                             │ TRANSFER                     │
│                                             │  Auto-accept files     [O=]  │
│                                             │  Direction          [Both ▾] │
└────────────────────────────────────────────┴──────────────────────────────┘
        PANEL 1 — main, full height              PANEL 2 (top 50%) — files
                                                 PANEL 3 (bottom) — session
```

Layout rules:
- Left column is fluid, right column is a fixed **400 px**. Below 900 px the grid
  collapses to a single stacked column (Android).
- Panel 1 owns the full height; panels 2 and 3 split the right column evenly.
- Each panel scrolls independently. The page itself never scrolls on desktop.

Four things the layout does deliberately:

- **Line numbers in the main panel.** The content people paste into this thing is
  stack traces and JSON — line numbers are what make a shared error message
  discussable ("look at line 10").
- **Actions live top-right of their own panel**, not in a global toolbar, so each
  panel is self-contained.
- **The capture tier is always on screen** (`T3 · auto-capture`), because what the
  app can and cannot see is the thing users get wrong. See
  [CLIPBOARD-FLOW.md](CLIPBOARD-FLOW.md).
- **The key warning sits next to the key**, not in a footer or modal. The key is a
  bearer credential and the UI should say so where it is read.

### 3.7 Files and images (P2P)

Full design in [P2P-FILES.md](P2P-FILES.md).

| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | Drag-drop or click to add files; **5 MB hard cap each**, rejected with a visible reason | Must |
| FR-7.2 | Image thumbnails generated **locally** (canvas, 160 px, JPEG q0.7, ~8 KB); non-images get an extension icon | Must |
| FR-7.3 | Only the thumbnail + metadata travel automatically, inside the normal encrypted envelope. **The file bytes never leave the machine until requested** | Must |
| FR-7.4 | Clicking a remote thumbnail requests the file; transfer runs over a WebRTC data channel, signalled through the existing relay | Must |
| FR-7.5 | Per-tile transfer progress and cancel | Should |
| FR-7.6 | If ICE fails within ~5 s, fall back to chunked transfer over the relay (32 KB frames) — **and label it visibly as RELAY, never silently** | Must |
| FR-7.7 | Max 20 files per session, memory only, cleared on leave | Should |
| FR-7.8 | Local files are click-to-save; remote files are click-to-request | Must |
| FR-7.9 | **The approval prompt must not block the app.** It is docked rather than modal, does not take focus, and leaves the editor and every panel usable while it is open — an unanswered request from another device must never stop this one being used | Must |
| FR-7.10 | Both ends of a request share one deadline (`FILES.REQUEST_TIMEOUT_MS`). An unanswered prompt expires **into a denial**, and the requester stops waiting on the same number, so neither side is left believing in a transfer the other abandoned | Must |
| FR-7.11 | **"Allow all"** — a per-device standing approval for the rest of the session. Scoped to the room and the tab (`sessionStorage`), dropped when the key rotates, and every transfer it authorises is still announced. The permanent, all-devices version is the existing `autoaccept` setting | Should |

| ID | Requirement |
|---|---|
| FR-6.1 | Single screen: key display, connection status pill, big paste/clip area, history list, settings drawer |
| FR-6.2 | Explicit permission-state UI: `granted` / `prompt` (show "Enable clipboard access" button) / `denied` (show manual-paste instructions) |
| FR-6.3 | Connection states are always visible: Connecting / Connected (n devices) / Reconnecting / Offline |
| FR-6.4 | Responsive down to 360 px; touch-friendly targets for mobile |
| FR-6.5 | Dark/light via `prefers-color-scheme` |
| FR-6.6 | No content ever rendered as HTML — clips are inserted as `textContent` only (XSS) |

---

## 4. Architecture

### 4.1 Recommended topology

```
  Windows PC            macOS                  Android
 ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
 │  Chrome PWA   │   │  Chrome PWA   │   │  Chrome PWA   │
 │  (GitHub      │   │  (GitHub      │   │  (installed   │
 │   Pages)      │   │   Pages)      │   │   to home)    │
 └───────┬───────┘   └───────┬───────┘   └───────┬───────┘
         │                   │                   │
         │      wss://<app>.fastapicloud.dev/ws/<roomHash>
         └───────────────────┼───────────────────┘
                             ▼
        ┌────────────────────────────────────────────┐
        │  Relay — FastAPI, single replica            │
        │  rooms: dict[str, Room]                     │
        │    Room = { peers: set[WebSocket],           │
        │             last: ciphertext | None,         │
        │             seq: int }                       │
        │  evict room after 10 min with no peers      │
        │  NO DATABASE. NO DISK. NO REDIS.            │
        └────────────────────────────────────────────┘
```

- **Frontend**: static HTML/CSS/JS on GitHub Pages. No framework required; vanilla or Preact/Svelte if preferred. No build step is a valid choice.
- **Relay**: FastAPI (Python) on FastAPI Cloud Hobby (free). One `WebSocket` endpoint, a module-level dict of rooms, fan-out to the room's peer set. ~120 lines, no dependencies beyond FastAPI itself.
- **Content is end-to-end encrypted** (§7.3). The relay is a dumb, blind pipe that never sees plaintext.

```python
# backend/main.py — the entire sync model
rooms: dict[str, Room] = {}

@app.websocket("/ws/{room_hash}")
async def ws(sock: WebSocket, room_hash: str):
    await sock.accept()
    room = rooms.setdefault(room_hash, Room())
    room.peers.add(sock)
    await sock.send_json({"t": "welcome", "peers": len(room.peers), "last": room.last})
    try:
        async for raw in sock.iter_json():
            room.seq += 1
            room.last = raw | {"seq": room.seq}
            for p in room.peers - {sock}:          # sender excluded
                await p.send_json(room.last)
    finally:
        room.peers.discard(sock)
        if not room.peers:
            schedule_eviction(room_hash, after=600)
```

### 4.2 Split transport: relay for text, P2P for files

The two payload types have opposite economics, so they get different transports.

| | Text & thumbnails | File bytes |
|---|---|---|
| Size | Bytes to ~8 KB | Up to 5 MB |
| Transport | WebSocket relay | WebRTC data channel (P2P) |
| Why | Tiny, constant, must be reliable | Too big to push through a free-tier relay per transfer |

**Text does not use WebRTC** because WebRTC would still need a signalling server *plus* TURN for peers behind symmetric NAT — more infrastructure, not less, to move a few hundred bytes. A relay carrying already-encrypted payloads gives the same privacy property far more simply.

**Files do not use the relay** (by default) because a 5 MB body per transfer on a 0.1 vCPU free instance is how you acquire a throttle or a bill.

The relay doubles as the WebRTC signalling channel, so P2P costs no extra infrastructure. See [P2P-FILES.md](P2P-FILES.md) — including why the answer to P2P failing on corporate networks is a relay fallback rather than a TURN server (**OI-14**).

### 4.3 Relay hosting — FastAPI Cloud (chosen)

**Decision: FastAPI Cloud, Hobby tier ($0, no credit card).** Deploy is `fastapi deploy`; HTTPS and a subdomain come free, so `wss://` works out of the box.

Hobby tier allowances, and what each means here:

| Allowance | Impact on RealtimeClipboard |
|---|---|
| 3 apps, 1 custom domain | Fine — we need one app |
| 0.1 vCPU / 512 MB shared (burst to 0.5) | Ample. The relay does no crypto and no parsing beyond JSON fan-out |
| **Autoscale up to 2–3 replicas** | ⚠️ **Must be pinned to 1** — see R1 below |
| **Scale-to-zero** | ⚠️ Cold start on the first connect after idle — see R2 |
| 1-day log/metric retention | Fine — we log no content anyway (§7.3) |
| Compute not yet invoiced during public beta | Free today; re-evaluate before GA pricing lands |

#### Risks that must be resolved in M0

| # | Risk | Why it matters | Mitigation |
|---|---|---|---|
| **R1** | **Multi-replica breaks in-memory fan-out** | Room state is a process-local dict. If two devices land on *different* replicas they join the same room name but never see each other — a silent, intermittent "it just doesn't sync" bug that looks like a network problem | **Pin max replicas to 1.** A fan-out relay is I/O-bound, not CPU-bound; one async worker handles thousands of idle sockets. If we ever outgrow it, the fix is sticky routing on `roomHash` or Redis pub/sub — the latter would break the no-database goal, so pinning is strongly preferred |
| **R2** | **Scale-to-zero cold start** | After an idle period the first `wss://` connect must wake a container — seconds of dead air on what should be an instant-on app | Client shows an honest "Waking relay…" state rather than a spinner; retry with backoff; consider a cheap keep-alive ping if the tier permits. Measure actual wake time in M0 |
| **R3** | **WebSocket support is not documented** | FastAPI speaks WebSockets natively, but the *platform's* ingress proxy must pass the HTTP Upgrade through. This is unverified and is the single biggest unknown in the plan | **M0 exists to prove this first.** Deploy a 20-line echo endpoint and connect from two machines before any other work |
| **R4** | Scale-to-zero may drop live sockets when idle-scaling | A room could evaporate mid-session | Client auto-reconnect (FR-3.5) + last-clip replay (FR-3.3) already cover this; verify behaviour in M0 |

#### Fallbacks, in order, if R3 fails
1. **SSE + POST** — server-sent events downstream, `fetch` POST upstream. Plain HTTP, no Upgrade required, works through nearly every proxy, and needs no change to the message schema in §6. Costs one extra HTTP round trip per send.
2. **Another free Python-friendly host** — Railway, Render, or Fly.io free tiers, all of which document WebSocket support.
3. **Cloudflare Workers + Durable Objects** — no cold start and per-room isolation by construction, but the relay would be JavaScript rather than Python.

> The client's transport layer must be written behind a small interface (`connect / send / onMessage / close`) so that swapping WebSocket for SSE+POST touches one file and nothing else.

**Built, and for the other end of the wire.** R3 turned out fine — the platform passes upgrades (OI-1). Fallback 1 shipped anyway, because the risk it addresses is symmetric and only half of it was ever about the host: the *client's* network is the one this product is aimed at (§5.4), and it is the half that cannot be fixed by changing providers. It is not a manual switch or a deploy-time flag. The client tries a WebSocket, and if two attempts fail to become usable it moves to `GET /sse/<roomHash>` + `POST /pub/<roomHash>` on the same host and says so in the status bar and a banner. Both transports serve the same rooms, so a device on each still sync with one another.

### 4.4 Repo layout
```
/                      → static site root (Cloudflare Pages)
  index.html           → app shell / layout
  app.js  ui.js  clipboard.js  crypto.js  transport.js
  manifest.webmanifest
  sw.js
  icons/
/backend/              → FastAPI relay (FastAPI Cloud "Application Directory")
  main.py              → WebSocket endpoint + in-memory rooms
  pyproject.toml       → required for deploy
  requirements.txt
  test_relay.py  test_idle.py
/tests/live/e2e.mjs         → end-to-end: two peers, real crypto, live relay
/docs/                 → PRD.md, ARCHITECTURE.md, CLIPBOARD-FLOW.md, P2P-FILES.md
```

Both halves live in one repo and deploy independently:

| Half | Trigger | Target |
|---|---|---|
| Static site | Cloudflare Pages build on push to `main` | Cloudflare Pages |
| Relay | FastAPI Cloud watches the repo, builds on push to the **default branch** | FastAPI Cloud |

The frontend reaches the relay through a single configurable `RELAY_URL` constant.

### 4.5 FastAPI Cloud auto-deploy

FastAPI Cloud connects to the GitHub repo directly and redeploys on every push to
the default branch. Pushes to other branches are ignored.

**The `backend/` folder name is a convention, not a requirement.** FastAPI Cloud
defaults to the repository *root* and looks for the app there. Because this repo
has the static site at the root, the app location must be set explicitly — as
**Root Directory** when creating the app from GitHub, or **Application
Directory** in app settings afterwards. `backend` is a clear, conventional value
and is what this repo uses. Path rules: relative only, no `..`.

If deployments stop triggering after a push, the first thing to check is that the
Application Directory still points at `backend`.

#### Two traps that cost three failed deployments

1. **Application Directory defaults to `null` (the repo root).** It is not
   inferred from the presence of a `pyproject.toml` in a subdirectory. Left
   unset, the build targets the root — where this repo keeps the static site —
   and fails at `verifying` with no obvious clue. Set it via the dashboard, or
   `fastapi cloud apps update <id> --directory backend`.
2. **A flat directory with more than one top-level module fails to build.**
   `backend/` holds `main.py` plus two test scripts, and setuptools refuses to
   guess: *"Multiple top-level modules discovered in a flat-layout"*. Fixed by
   declaring `py-modules = ["main"]`.

#### Cloudflare fronts the relay

`/health` returns **403** to the default `Python-urllib/3.x` User-Agent while
`curl` and browsers get 200. Any monitoring or uptime check must send a normal
User-Agent or it will report a false outage.

> ⚠️ **Every push to the default branch restarts the relay** — including
> frontend-only commits. Restart drops all live WebSocket connections and clears
> in-memory rooms. Clients reconnect automatically (FR-3.5) and the last clip is
> gone, which is acceptable, but it means a busy commit day is a choppy day for
> anyone using it. Tracked as **OI-13**.

---

## 5. Hard platform constraints

> These are not design choices. They are browser rules that the product must be shaped around, and they are the most common source of "why doesn't it just work like a native app" confusion.

### 5.1 The clipboard cannot be read in the background
`navigator.clipboard.readText()` requires **all** of: a secure context, the `clipboard-read` permission, **and the document to be focused**. It rejects with `DOMException: Document is not focused` otherwise. There is no clipboard-change event on the web platform.

**Consequence:** a PWA in a background window cannot notice that you copied something in another app. Capture is therefore defined as three tiers:

| Tier | Mechanism | Permission | Works when |
|---|---|---|---|
| T1 | `paste` event (Ctrl+V into the app) | none | always — universal fallback |
| T2 | `readText()` on focus/visibility change | `clipboard-read` | user switches back to the app |
| T3 | `readText()` polling while focused | `clipboard-read` | app window is focused |
| ~~T4~~ | ~~Chrome extension with `clipboardRead` + offscreen document~~ | ~~install-time~~ | **Unavailable — extensions are blocked by corporate policy (§1.4)** |

**T4 is permanently out of reach, so T1–T3 must carry the whole product.** Practical consequence for design: the user's mental model must be *"switch to RealtimeClipboard and it grabs what you copied"*, not *"it watches my clipboard forever"*. Making that switch cheap is therefore a primary UX concern, not a detail:

- Installed as a PWA, RealtimeClipboard is one Alt-Tab / Cmd-Tab away in its own window
- Capture on focus (T2) is instant and silent, so the round trip is: copy → Alt-Tab → it's already sent
- The UI must confirm capture visibly ("Sent · 2s ago") so the user learns to trust the focus gesture
- Never present a state that implies background capture is happening when it isn't

**Receiving is easier than sending.** `writeText()` works whenever the document is focused, so auto-apply on the receiving side is reliable; when the tab is unfocused the clip is queued and written on next focus, with a visible "1 pending clip" badge.

### 5.2 The host is static-only
- No server code, so no WebSocket endpoint — hence the separate relay in §4.
- **The room key lives in the URL fragment (`#D75LV`), not the path.** Originally this was forced: GitHub Pages served project sites from `/<repo>/` with no SPA rewrite, so a path-style URL like the reference app's `/D75LV` would have needed a `404.html` redirect hack.
- **That constraint is gone and the decision stands anyway.** Since the move to Cloudflare Pages at an apex domain, a path-style room key would be perfectly serveable. It is still wrong: a fragment is never transmitted to the server, which is exactly what the E2E encryption design requires (§7.3). The constraint and the security requirement happened to point the same way, and only the requirement was load-bearing.

### 5.3 Platform & browser support matrix

Target platforms: **Windows, macOS, Android** — Chrome on all three.

| Platform / browser | Write | Silent read | PWA install | Verdict |
|---|---|---|---|---|
| Chrome — Windows | ✅ | ✅ after prompt | ✅ standalone window | **Primary** |
| Chrome — macOS | ✅ | ✅ after prompt | ✅ standalone window | **Primary** |
| Chrome — Android | ✅ | ✅ after prompt | ✅ home-screen app | **Primary** |
| Edge (Chromium) — Win/Mac | ✅ | ✅ after prompt | ✅ | Supported, same engine |
| Safari — macOS/iOS | ✅ (gesture) | ❌ per-read gesture required | iOS: Add to Home Screen | Degraded — T1 paste tier only |
| Firefox — all | ✅ | ❌ not exposed to web content | ❌ no install | Degraded — T1 paste tier only |

Platform notes:
- **macOS** — Cmd-based shortcuts; the `paste` handler must accept Cmd+V as well as Ctrl+V.
- **Android** — no window focus in the desktop sense; T2 capture fires on `visibilitychange`, which is the dominant path on mobile. Long-press paste into the app (T1) is the reliable fallback. Android also aggressively suspends background tabs, making auto-reconnect on resume (FR-3.5) essential rather than optional.
- **All platforms** — the app must **detect and communicate** its capture tier rather than silently doing nothing.

### 5.4 Corporate network constraints

The primary deployment context is a managed corporate environment, which shapes several requirements:

| Constraint | Consequence |
|---|---|
| Extension installation blocked | PWA-only, permanently (§1.4). Already reflected throughout |
| Outbound traffic restricted to 443 | `wss://` on 443 is standard and should pass. No custom ports, ever |
| TLS-inspecting proxies may not pass WebSocket Upgrade | **Handled: automatic failover to SSE+POST (FR-3.9).** Note the failure mode it had to be built around — a blocked upgrade usually *hangs* rather than erroring, so the client cannot wait for an error it will never get, and gives each transport a fixed window to prove itself. Still test from inside the actual corporate network, not only from a home connection |
| Proxies commonly kill idle connections at 60–120 s | 30 s heartbeat (FR-3.6) is a hard requirement, not a nicety |
| Domain allowlisting | Relay lives on one stable hostname so IT can allowlist a single domain. Avoid rotating subdomains; a custom domain (D5) makes this easier to justify to IT |
| Data-handling policy | E2EE (§7.3) means clipboard contents never exist in plaintext outside the browser — the strongest available answer to "where does our data go?" Worth documenting for any security review |

---

## 6. Wire protocol

Transport: WebSocket, JSON text frames. URL: `wss://<app>.fastapicloud.dev/ws/<roomHash>`.

The schema below is transport-agnostic on purpose, and this is now load-bearing rather than aspirational: the SSE+POST fallback (§4.3, FR-3.9) carries these same envelopes over `GET /sse/<roomHash>` and `POST /pub/<roomHash>`, with two transport-level additions and no schema change.

1. `welcome` carries an extra `sid` on that path only. A stream is the session; a POST is a separate request that could claim to be anyone, so `?sid=` is what ties one back to the other. It is stripped in the transport and never reaches the protocol layer.
2. A POST body is one frame per line. `JSON.stringify` escapes every literal newline, so the split is unambiguous, and each line is still held to the 32 KB cap individually.

### Client → Server
```jsonc
// first frame after connect — declares why we are here (see OI-2)
{ "t": "hello", "intent": "create" | "join", "originId": "u7f3" }

{ "t": "clip", "payload": "<base64 ciphertext>", "iv": "<base64>", "originId": "u7f3", "ts": 1754400000000 }

// live typing, for the far editor to render — NOT a clip. `text` and `caret`
// are sealed inside `payload`; only `t` and `originId` are readable.
{ "t": "stream", "payload": "<base64 ciphertext>", "iv": "<base64>", "originId": "u7f3" }

// a locked session proving its PIN. `probe` is sealed inside `payload`: true is
// the question, false is the answer. Forwarded to the room and NOT retained,
// which is the whole reason it is not a clip.
{ "t": "verify", "payload": "<base64 ciphertext>", "iv": "<base64>", "originId": "u7f3" }

{ "t": "ping" }
```

**`clip` versus `stream`.** A clip is a discrete thing that settled: it is retained by the room and
replayed to late joiners (FR-3.3), it goes into history, and on the Clipboard rung it is written to
the receiving machine's OS clipboard. A stream is what the text looks like mid-keystroke: broadcast,
never retained, never replayed, never written to anyone's clipboard. Merging the two would put a
history entry and a clipboard write behind every keystroke in the session.

The split is also what lets a stream carry the *whole* text rather than a diff, which is why this
protocol has no positions and no operational transform in it. That trade only holds while the text
is small, so the client stops streaming above 4 KB and the text syncs on commit alone. Anything
larger is pasted rather than typed, and a paste commits immediately.

A server that does not know `stream` answers `UNKNOWN_TYPE`; the client treats that as "this relay
is older than live typing" and degrades to commit-only, which is the pre-streaming behaviour.

**`welcome.caps` and why guessing was not good enough.** `stream` can degrade by guessing because
its failure is visible and harmless — typing simply stops appearing. `verify` cannot: an
`UNKNOWN_TYPE` from an old relay is indistinguishable, at the client, from a probe that no peer
chose to answer, and those two mean "this relay needs redeploying" and "your PIN may be wrong". So
the relay lists what it understands and the client asks before sending. Absent from an older
relay's `welcome`, which is exactly the signal wanted; the client says so plainly and does **not**
fall back to the retained-clip beacon it replaced (§7.5).

`intent` exists to prevent a silent collision: an auto-generated key that happens to match a **live** room would otherwise drop the user straight into a stranger's clipboard. On `intent: "create"`, a `welcome` reporting `peers > 0` means the key is taken — the client discards it, regenerates, and reconnects (max 5 attempts). On `intent: "join"`, `peers == 0` is legitimate and simply means you arrived first.

### Server → Client
```jsonc
{ "t": "welcome", "peers": 2, "last": { /* clip envelope or null */ }, "caps": ["verify"] }
{ "t": "clip",    "payload": "...", "iv": "...", "originId": "u7f3", "seq": 42 }
{ "t": "verify",  "payload": "...", "iv": "...", "originId": "u7f3", "from": "p9k2" }
{ "t": "peers",   "count": 3 }
{ "t": "pong" }
{ "t": "error",   "code": "TOO_LARGE" | "RATE_LIMITED" | "ROOM_FULL" }
```

**Rules**
- Server never inspects, decrypts, logs, or persists `payload`.
- Server assigns `seq`; clients discard out-of-order `seq`.
- Sender is excluded from its own broadcast; `originId` is a second-line defence against loops.
- Limits: 32 KB/message, 8 peers/room, and **per frame class** per connection: 10/s `interactive`
  (`clip`, `ping`, `hello`), 20/s `cursor`, 20/s `stream`, 60/s `signal`, 400/s `bulk`
  (`file-chunk`). The classes exist so that presence and live typing — both a steady trickle —
  cannot rate-limit the clips, which are the product. A client that puts `stream` in the
  `interactive` bucket would sit on its ceiling with one person typing.

---

## 7. Security & privacy

### 7.1 Threat model
The clipboard carries passwords, tokens, and PII. The share key is a **bearer credential**: anyone who has it can read everything pasted into that room. This must be stated plainly in the UI, not buried.

### 7.2 Risks
| Risk | Mitigation |
|---|---|
| Key guessing / enumeration | 10-char Crockford base32 ≈ 49 bits (16-char option ≈ 78); the room hash is HKDF over the same 250k PBKDF2 as the AES key, so each guess costs a full derivation; server-side rate limiting on connect; short room TTL. **Was 6 chars over a bare SHA-256 until v0.5.0** |
| Relay operator reads clips | E2E encryption (§7.3) — relay only ever sees ciphertext |
| Key leaks via URL sharing | Fragment is not sent to the server and not stored in server logs; warn on "Copy link" that the link *is* the password |
| Persistence | Nothing written to disk anywhere; browser keeps history in `sessionStorage` only; server keeps one clip in RAM with a 10-min idle eviction |
| Stale room reuse | Room key rotation; explicit Leave |
| XSS via clip content | `textContent` only, strict CSP, no `innerHTML`, no `eval` |
| **Link is forwarded, screenshotted or pasted into a group chat** | Locked sessions (§7.5): a PIN that never travels with the link, so holding the link is not sufficient |
| **PIN guessing by someone who already holds the link** | Against them the key contributes **zero** bits and the PIN is the whole secret — see the table in §7.5. Mitigated by a 6-character minimum, 600k PBKDF2 iterations, and stating the entropy in bits at the point of entry. Not mitigated by the iteration count alone, which buys ~1.3 bits |
| **A locked link opened by a build that predates the feature** | The old build strips the `!` and joins the *unlocked* room of that name. It learns nothing about the locked session, but the user believes they are private — OI-21. Mitigated by the `sw.js` version bump on release |

### 7.3 End-to-end encryption (recommended, and it's cheap)
The elegant part of the fragment-based design: the key the user types can serve **both** purposes without the server ever learning it.

```
user key       :  D75LV                       (never transmitted)
prk            :  PBKDF2-SHA256(key, salt="realtimeclipboard-v1", 250k iters)
roomHash       :  HKDF(prk, "realtimeclipboard/room") → 16 bytes, hex  (sent in the WS URL)
encryption key :  HKDF(prk, "realtimeclipboard/aes")  → AES-GCM-256
payload        :  AES-GCM(plaintext, random 12-byte IV per message)
```

⚠️ **Amended in v0.5.0.** `roomHash` was `SHA-256("realtimeclipboard:" + key)[0..16]` — unsalted,
unstretched, and the one derived value the relay holds. Anyone with it could sweep the whole
6-character keyspace in ~0.07s and recover the key, which made the 250k iterations on the
encryption key worth a single derivation to an attacker. Deriving both from one PRK costs nothing:
that PBKDF2 was already awaited before the connection opened. See `docs/THREAT-MODEL.md` §4.
The relay sees only `roomHash` and ciphertext. It cannot derive the key from the hash, so it cannot decrypt. All of this is `crypto.subtle` — no libraries.

**Honest caveat, amended in v0.5.0:** this section originally argued that a 6-character key (~30 bits) was an acceptable default because short keys are the product's core UX, with a 10-character option for sensitive material. That reasoning does not survive the arithmetic. The open salt is a single global constant, so one precomputed table covers every user and every session of a given length forever — ~12 minutes on 100 rented GPUs at 6 characters. The default is now **10 characters** (~49 bits) and the option is **16** (~78 bits). Typing cost is paid once per session, and only by someone who has declined both the QR code and the copied link.

### 7.4 Notices required in UI
- On room creation: "Anyone with this key can read what you copy here."
- On first clipboard-permission prompt: what is read, when, and that it never leaves encrypted.
- On "Copy link" **in a locked session**: that the PIN is *not* in the link and has to be sent another way.
- On the QR code in a locked session: the same — the code carries the key, not the PIN.
- On locking, unlocking, or changing the PIN: that it starts a new session and leaves the current devices behind. When other devices are actually present, how many, stated in the dialog *before* the button is pressed rather than in a toast afterwards.
- On a device that has just been removed by someone else's lock: that the session was locked, that this is why it disconnected, and that rejoining needs both the new link and the PIN.

### 7.5 Locked sessions

A second secret that never travels with the link. Implemented in `core/crypto.js`.

```
── open session (v0.5.0 — no longer wire-compatible with earlier links) ──
prk        :  PBKDF2-SHA256(KEY, salt="realtimeclipboard-v1", 250k)
roomHash   :  HKDF(prk, info="realtimeclipboard/room")[0..16] hex
aesKey     :  HKDF(prk, info="realtimeclipboard/aes")  → AES-GCM-256

── locked session ────────────────────────────────────────────────────────
PIN        :  NFC-normalised, ends trimmed, case and interior preserved.
              Never in the link, never on disk, never sent.
prk        :  PBKDF2-SHA256(password = PIN,
                            salt     = "realtimeclipboard-lock-v1:" + KEY,
                            iters    = 600_000, dkLen = 32)
aesKey     :  AES-GCM-256( HKDF(prk, info="realtimeclipboard-lock/aes",  32) )
roomHash   :  hex(         HKDF(prk, info="realtimeclipboard-lock/room", 16) )   ← sent
authToken  :  hex(         HKDF(prk, info="realtimeclipboard-lock/auth", 16) )   ← sent
fragment   :  "#!" + KEY
```

**The room hash requires the PIN, and that is the load-bearing decision.** It turns the
feature from "you cannot read it" into "you cannot find it": a device with the link but
not the PIN computes a different room hash, joins a different room, and never appears in
the real one — no peer slot, no roster entry, no traffic metadata. Locked and unlocked
rooms for one key are likewise disjoint, so the two kinds of client can never meet and
spray decryption failures at each other.

**One PBKDF2 run, three outputs, via HKDF.** PBKDF2 reruns its full iteration count per
32-byte output block, so asking it for 64 bytes costs double — and OI-8 already flags
PBKDF2 cost on low-end Android. HKDF expansion is a couple of HMACs.

**What the salt does and does not buy.** The share key is the salt, which stops one
precomputed table covering every session — the open-session path, with its single global
`"realtimeclipboard-v1"`, has exactly that weakness. It buys **nothing** against the attacker this
feature exists for: someone holding the link holds the key and can compute the salt.

#### The honest number

Against an attacker **who has the link**, the key contributes 0 bits and the PIN is the
entire secret. Orders of magnitude, one consumer GPU, PBKDF2-HMAC-SHA256 at 600k:

| PIN | Entropy | Offline |
|---|---|---|
| `1234` | ~13 bits | seconds |
| `445566` | ~20 bits | minutes |
| 6 chars, human-chosen | ~22 bits | minutes |
| 6 chars, mixed alphabet | ~36 bits | weeks |
| 4 dictionary words | ~52 bits | infeasible |

Against an attacker **without** the link the two secrets multiply: a 6-digit PIN on top of
a 6-char key is ~49 bits, comparable to the 10-char "Longer keys" option. The UI quotes
the first number, because it is the one that matters when a link leaks.

#### Confirming a PIN, and why it can be ambiguous

A wrong PIN is not rejected — it addresses a different, empty room, which looks exactly
like being the first to arrive. So a locked session **asks the room to prove itself**: it sends a
`verify` frame sealed with the session key, and any device that can open it answers with one of its
own. Opening either is the proof — a peer that can encrypt to this key derived it from the same
PIN — and `verified` is set from that decryption and from nothing else. Presence in the roster is
the relay's word for it, and the relay is not trusted for anything else here.

**It used to be a clip, and that was the bug.** The original design planted a NUL-prefixed sentinel
as an ordinary clip and relied on the relay retaining one clip per room (FR-3.3) to replay it to
the next joiner. The proof and the user's data were then competing for a single slot, and no guard
could satisfy both: plant unconditionally and you overwrite whatever the user had actually copied;
guard on the slot being free and a room whose first arrival is set to **Off** never gets a beacon at
all, leaving correctly-joined devices warned that their PIN might not match. `verify` is forwarded
and forgotten, so there is nothing left to arbitrate.

**When it asks.** On joining, when a peer arrives, and when the sync rung comes off Off — every
moment at which the answer could have changed, rather than a timer. Off is honoured in both
directions: a device set to Off neither asks nor answers, because answering is a frame put on the
wire for somebody else's benefit. Coming off Off therefore both asks *and* answers unprompted, or
the peer that gave up while this device was silent would wait for ever. An answer is never itself
answerable, which is what stops two unverified devices trading proof.

Residual ambiguity, tracked as OI-19: a locked session alone in its room has nobody to ask, and
stays **"Private · unconfirmed"** with a banner offering to re-enter the PIN rather than the app
guessing. Once a peer is present the banner is dismissed — its own claim, "nobody else is here
yet", has stopped being true — but `verified` still waits for something this device decrypted
itself.

#### What a locked session does not hide

The relay still sees a room hash with devices in it, their nicknames (sent in the clear on
`hello`), the routing fields of every frame (`originId`, `id`, `seq`, `total`, `crc`), and
frame timing. **Locked mode hides content, not the existence of a session.** What it does
remove is any way for a link-holder without the PIN to be *in* that session.

The relay additionally checks `authToken` at join (`?a=`, `backend/main.py` `_admits`),
trust-on-first-use per room. This is defence in depth against our own derivation bugs, not
a new security property — the room's name already required the PIN — and it is no defence
against the relay operator, who sees the room hash regardless.

---

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | p95 end-to-end propagation < 300 ms **same region**, < 800 ms cross-continent. **Measured: 278 ms India → `us-east-1` → India.** That is cross-continent traffic landing just inside the *same-region* budget, so the figure is honest but tight — if it needs improving the lever is the relay's region, not the code, since the relay itself contributes ~0 ms |
| NFR-2 | App shell < 100 KB gzipped; first paint < 1 s on 4G |
| NFR-3 | Reconnect within 5 s of network restoration |
| NFR-4 | $0 recurring cost up to ~50 k messages/day |
| NFR-5 | **Revised 2026-08-09.** Google Analytics and AdSense run site-wide, `app.html` included; the share key is never reported to either. gtag is configured with `pageLocation()`, which strips the URL fragment, and the ad tag — which reports the URL itself with no override — loads only after boot has stripped the key from the fragment (`ui/features/ads.js`). All pages declare one CSP, asserted by `tools/check/site-check.mjs`. See `docs/ARCHITECTURE.md` §5 |
| NFR-6 | Keyboard accessible; visible focus rings; status changes announced via `aria-live` |
| NFR-7 | Graceful degradation to T1 (manual paste) on any browser lacking the async clipboard read |

---

## 9. Milestones

| M | Scope | Exit criteria |
|---|---|---|
| **M0 — De-risk the relay** ⚠️ | Deploy a ~20-line FastAPI echo WebSocket to FastAPI Cloud Hobby. Pin replicas to 1. Nothing else gets built until this passes | **Gate:** WS Upgrade succeeds (R3); two machines exchange a string; cold-start wake time measured (R2); connection survives 5 min idle with heartbeat; **verified from inside the corporate network** (§5.4). If it fails → switch to SSE+POST before M1 |
| **M1 — Core sync** | Key generation, fragment routing, transport interface, reconnect, loop suppression, last-clip replay | Two machines sync via a typed key |
| **M2 — System clipboard** | Permission flow, T1–T3 capture tiers, auto-write, pending-clip queue, capture-confirmation UI | Ctrl+C on A appears in Ctrl+V on B across Win/Mac/Android |
| **M3 — PWA** | Manifest, service worker, install prompt, offline shell, `start_url` room restore | Installs from Chrome on Windows, macOS and Android |
| **M4 — Settings & polish** | Settings drawer, history list, QR, presence, toasts, dark mode | All §3.5 settings functional and persisted |
| **M5 — Security** | E2EE, rate limits, size caps, CSP, privacy copy | Relay logs verified to contain no plaintext |
| **M6 — Ship** | GitHub Actions deploy to Pages, relay deploy, README, full matrix tested | Public URL live |
| **M7 — P2P files** | Thumbnails over the relay, WebRTC signalling + data channel, progress/cancel, relay-chunk fallback with visible labelling | 5 MB file moves between two machines directly; corporate path falls back and says so (§3.7, OI-14) |
| **M8 — Locked sessions** | PIN folded into the room hash and the encryption key, fragment marker, PIN dialog, `verify` confirmation, relay admission token (§7.5) | A link without its PIN reaches an empty room; a wrong PIN never appears in the real room's roster; the open-session wire format is byte-identical |

> **M0 is a genuine gate, not a formality.** WebSocket support on FastAPI Cloud is undocumented (R3) and it is the assumption the entire architecture rests on. Proving it costs an afternoon; discovering it at M4 costs a rewrite.

---

## 10. Out of scope for v1 (candidate v2)

| Item | Note |
|---|---|
| ~~Chrome extension (MV3)~~ | **Excluded permanently, not deferred** — extension installation is blocked in the target corporate environment. Background clipboard capture is therefore unavailable at any point in the roadmap; T1–T3 (§5.1) are the complete capture story |
| ~~Image & file transfer~~ | **Now in scope** as P2P (§3.7, M7). Moved in because peer-to-peer transfer avoids the object storage that made it a scope problem — the relay carries an 8 KB thumbnail, not a 5 MB file |
| Copying images *via the clipboard* | Distinct from file transfer: reading image blobs out of the system clipboard with `clipboard.read()`. Still deferred |
| Persistent history across sessions | Conflicts with the no-persistence privacy stance; would be local-only (IndexedDB) if built |
| Rich text / HTML flavours | `text/html` clipboard type, sanitisation burden |
| Device pairing without typing a key | QR is v1; BLE/local discovery is not viable on the web |
| Self-hosted relay | Document a one-command deploy so users can run their own |

---

## 11. Decisions

### 11.1 Settled

| # | Decision | Resolution |
|---|---|---|
| D1 | Relay host | ✅ **FastAPI Cloud, Hobby (free)**. Must be pinned to 1 replica (R1). WebSocket support is unverified and is M0's gate (R3); SSE+POST is the documented fallback |
| D2 | E2E encryption in v1? | ✅ **Yes, from the start.** ~40 lines of `crypto.subtle`; it is what makes "no DB, blind relay" a real privacy claim rather than a slogan, and it is the answer to corporate data-handling review |
| D6 | Chrome extension? | ✅ **No — excluded permanently.** Corporate policy blocks extension installs. PWA only |
| D7 | Target platforms | ✅ **Windows, macOS, Android — Chrome on each.** Firefox/Safari degrade gracefully to the paste tier rather than being blocked |
| D9 | Does the PIN belong in the room hash? | ✅ **Yes.** The alternative — PIN in the encryption key only, room hash unchanged — was considered and rejected. It keeps a wrong PIN *visible* (you sit in the right room failing to decrypt, which is easy to report), but it costs three things: a link-holder with no PIN occupies one of 8 peer slots and appears in everyone's roster; they can overwrite `room.last` with ciphertext nobody can decrypt, permanently forging "wrong PIN" for every subsequent joiner; and locked and unlocked clients on one key collide in a single room. Binding the PIN into the hash removes all three and makes the feature admission control rather than encryption alone. The cost — a wrong PIN is silent — is paid down by `verify` and the "unconfirmed" state (§7.5, OI-19) |
| D10 | Is the PIN ever persisted? | ✅ **Never as the PIN.** Within a tab, its PBKDF2 output is kept in `sessionStorage` scoped to the share key, so a refresh does not re-prompt and does not re-run 600k iterations. Never `localStorage`: that is where the plaintext key already lives, and storing both together would mean the second secret bought nothing. The string the user typed is not retained anywhere |
| D11 | Relay-side admission in v1? | ✅ **Yes, but as defence in depth.** The relay compares an `authToken` (HKDF output, trust-on-first-use per room) at join on both transports. It is not the primary control — the room's *name* already requires the PIN — and it does not defend against the relay operator. It catches the case where a client's room derivation and key derivation disagree, which would otherwise present as a session that connects and then reads nothing |

### 11.2 Still open

| # | Decision | Recommendation |
|---|---|---|
| D3 | Default key length | **6** chars for UX parity with the reference app, with a 10-char option in settings |
| D4 | Frontend stack | **Vanilla JS** — revisited at ~47 modules: `src/` is still plain ES modules, and `tools/build/build.mjs` bundles at *deploy* time only |
| D5 | Custom domain? | **Worth it here.** Beyond a shorter URL, a stable custom hostname is much easier to get onto a corporate allowlist than a platform subdomain (§5.4) |
| ~~D8~~ | ~~Keep-alive against scale-to-zero?~~ | ✅ **Resolved: do nothing.** Measured cold start is 973 ms including TLS — well under the ~2 s threshold where a keep-alive would earn its fair-use cost. Show "Connecting…" and move on |

---

## 12. Acceptance test matrix

| # | Scenario | Expected |
|---|---|---|
| T1 | A creates room, B joins by typing key | Both show "2 devices" within 2 s |
| T2 | Copy on A (app focused) | Appears on B < 300 ms; B's system clipboard contains it |
| T3 | Copy on A while A unfocused, then focus A | Captured on focus and propagated |
| T4 | B receives while unfocused | Queued; "1 pending" badge; written on focus |
| T5 | Remote clip written locally | Is **not** re-broadcast (no ping-pong loop) |
| T6 | Kill network on B for 30 s, restore | Auto-reconnects; receives the room's last clip |
| T7 | Third device joins mid-session | Immediately receives the current last clip |
| T8 | Clip > 32 KB | Rejected with a clear toast; connection stays alive |
| T9 | Clipboard permission denied | App still works via Ctrl+V paste tier; UI explains this |
| T10 | Firefox / Safari visit | Receive works; send works via paste tier; capability banner shown |
| T11 | Install as Chrome app, relaunch | Opens standalone, rejoins last room |
| T12 | Relay logs inspected after a session | Contain no plaintext clipboard content |
| T13 | Room idle 10 min, then revisited | Room is empty (evicted), no stale clip served |
| T14 | **Windows ↔ macOS ↔ Android, all three in one room** | All three sync; Cmd+V and Ctrl+V both captured; Android captures on `visibilitychange` |
| T15 | **Two devices connect after relay has scaled to zero** | Both wake the relay and land in the *same* room — the direct check for R1/R2 |
| T16 | **Connect from inside the corporate network** | WS Upgrade passes the proxy; session survives 5 min idle on heartbeat alone |
| T17 | Android tab backgrounded 10 min, then resumed | Reconnects automatically and receives the room's last clip |
| T18 | Relay restarted mid-session (redeploy) | All clients reconnect; no crash, no duplicate delivery |
| T19 | Auto-generated key collides with a live room | Client detects `peers > 0` on a `create` and silently regenerates — never joins a stranger |
| T20 | Two tabs open on the same machine, same room | Content sent once, not twice; no self-echo between tabs |
| T21 | B opens a locked link and enters the right PIN | Joins the same room as A; clips flow both ways |
| T22 | B enters the wrong PIN | Lands in an empty room of its own — never appears in A's roster, never occupies one of A's 8 slots |
| T23 | B cancels the PIN prompt | No socket is opened at all; app sits idle. **Must not** fall through to the unlocked room of the same key |
| T24 | Locked session, network drops and recovers | Reconnects without re-prompting; the padlock stays confirmed |
| T25 | B refreshes the tab mid-session | No re-prompt (the stretched PIN is in `sessionStorage`); closing the tab and reopening does prompt |
| T26 | B joins a locked room whose creator has gone and whose last clip has expired | Reads "Private · unconfirmed" with a re-enter-PIN banner — never a confident padlock |
| T27 | A locked and an unlocked client use the same key | Two different rooms; neither sees the other; no "key mismatch" toasts |
| T28 | Rotate the key inside a locked session | New link, PIN unchanged, still locked; toast says so |
| T29 | A build predating the feature opens `#!KEY` | Lands in the unlocked room `KEY` — learns nothing about the locked session (OI-21) |
| T30 | A locked session verifies while the room holds a real clip | The clip is still what a late joiner is replayed — `verify` is forwarded, never retained (FR-3.3) |
| T31 | Two devices join a locked room on Off, then both enable sharing | Both verify, and no user content is sent to do it |
| T32 | A locked session on a relay that predates `welcome.caps` | Says the relay cannot confirm the PIN; never falls back to planting a clip |

---

## 13. Open issues register

Severity: **Blocker** = stops the build · **High** = silent wrong behaviour if unfixed · **Medium** = degrades UX or trust · **Low** = polish/spec gap · **Watch** = external, monitor only.

| # | Severity | Issue | Proposed resolution | Owner milestone |
|---|---|---|---|---|
| ~~**OI-1**~~ | ✅ **CLOSED** | ~~WebSocket support on FastAPI Cloud is unverified~~ | **Resolved 2026-08-05: it works.** 20/20 gate against `wss://realtimeclipboard.fastapicloud.dev`, upgrade accepted in 973 ms. The SSE+POST fallback is no longer needed; the transport interface stays isolated anyway since it cost nothing | M0 ✅ |
| **OI-2** | 🟠 High | **Key collision joins a stranger's room.** The app auto-generates a key on first visit and connects. If that key matches a *live* room, two unrelated people silently share a clipboard. The protocol currently has no create-vs-join distinction | Add `intent: "create" \| "join"` to the connect frame. On `create`, if `welcome.peers > 0`, discard the key, regenerate, retry (max 5). On `join`, `peers == 0` is legitimate (first arrival). See §6 | M1 |
| **OI-3** | 🟠 High | **Multi-replica split-brain** (R1). Room state is a process-local dict; two devices on different replicas silently never see each other | Pin max replicas to 1. Add `GET /health` returning an instance id so the client can detect a mismatch and warn loudly rather than failing quietly | M0 |
| **OI-4** | 🟡 Medium | **Duplicate sends from multiple tabs.** Two RealtimeClipboard tabs on one machine both poll the same system clipboard and both broadcast the same clip | Leader election across tabs via the Web Locks API (fallback: `BroadcastChannel`). Only the leader tab polls and sends; followers render | M2 |
| **OI-5** | 🟡 Medium | **Password-manager content lingers on remote machines.** A copied credential syncs to another device's system clipboard and stays there indefinitely — RealtimeClipboard would be *undoing* the auto-clear that password managers deliberately perform | Product decision needed. Options: auto-clear remote clipboard after N seconds; a "sensitive — don't auto-write" heuristic; or default `auto-write` off and require a click. Recommend surfacing it as an explicit setting with a documented default | M4 |
| **OI-6** | 🟡 Medium | **Android Chrome clipboard-read UX is unverified.** Desktop shows a persistent per-origin permission prompt; mobile Chrome's behaviour around `readText()` differs and may require a gesture or a paste chip each time | Verify on a real device in M2. If silent read is unavailable, Android falls back to T1 (long-press paste) — which must therefore be a first-class mobile flow, not a desktop afterthought | M2 |
| **OI-7** | 🟡 Medium | **Cold-start dead air** (R2). Scale-to-zero means the first connect after idle waits for a container to wake | Measure in M0, then resolve D8. Under ~2 s: show "Waking relay…" and do nothing else. 10 s+: consider a low-frequency keep-alive, weighed against Hobby-tier fair use | M0 → M4 |
| **OI-8** | 🟢 Low | **PBKDF2 cost on low-end Android.** 250k iterations can take several hundred ms | Derive the `CryptoKey` once per session and cache it in memory — never per message. Show an "Unlocking…" state during derivation | M5 |
| **OI-9** | 🟢 Low | **Service worker scope and updates.** ~~SW scope is confined to `/<repo>/` on a Pages subpath~~ — **subpath hosting was dropped** when `src/pages/` began publishing its pages one level above where they sit on disk, which forces root-absolute links, which cannot be correct under a path prefix. `sw.js` must still stay AT the site root or its scope shrinks to a subdirectory and offline support disappears silently. A stale `sw.js` can still pin users to an old build | Keep `sw.js` at the root; resolve every app path through `core/paths.js`; version the cache name; ship the update toast in FR-4.6. Verify an update actually reaches an installed PWA | M3 |
| **OI-10** | 🟢 Low | **PWA install drops the URL fragment.** `start_url` cannot carry `#KEY`, so the installed app opens with no room | FR-4.5 restores from `localStorage`. Undefined today: what the app shows when that is empty — specify "generate a fresh key and explain why" rather than a blank screen | M3 |
| **OI-11** | ⚪ Watch | **FastAPI Cloud is in public beta and compute is not yet invoiced.** The $0 assumption (NFR-4) rests on beta pricing | Monitor. The relay is ~120 lines of standard FastAPI with no platform lock-in, so migrating to another free host is days, not weeks |
| **OI-12** | ⚪ Watch | **Corporate-network verification needs physical access to that network.** A proxy that blocks WS Upgrade would not show up in testing from a home connection | Schedule an on-network test as part of the M0 gate, not after it. **The consequence is now degradation rather than breakage**: FR-3.9 fails over to SSE+POST by itself, so an untested network costs a slower transport and a banner instead of a dead app. `tests/live/fallback.mjs` simulates the block (a socket that hangs, which is how it actually presents) and `backend/test_sse.py` gates the relay side, so the path is exercised without the network. Neither replaces the on-network test — a proxy that also buffers the event stream is the remaining unknown, and the client detects that case by requiring the welcome frame within a fixed window | M0 |
| **OI-14** | 🟠 High | **WebRTC is least likely to work in exactly the environment this is built for.** P2P uses UDP; managed corporate networks routinely block outbound UDP and TLS-inspecting proxies do not pass peer traffic. Direct transfer will frequently fail on the target network — the same class of unknown as OI-1, and it cannot be answered from a home connection | Do **not** buy a TURN server: TURN relays the bytes, so it fixes connectivity by discarding the property that motivated P2P. Instead fall back to chunked transfer over the relay we already have (FR-7.6) — viable precisely because the cap is 5 MB, and the payload is already encrypted so the relay still sees nothing. Label the path visibly. Test on the corporate network alongside OI-12 | M7 |
| ~~**OI-15**~~ | ✅ **CLOSED** | ~~Thumbnails leak content automatically~~ | **Resolved: "Send previews" toggle, default on.** Kept on because a preview is most of the value of sharing an image at all; the setting is in the Files group and `transfer.announce()` honours it. `tests/unit/files.mjs` asserts thumbs=off actually suppresses the preview, so the toggle cannot rot into decoration | M7 ✅ |
| ~~**D3-long-key**~~ | ✅ **CLOSED** | ~~The 10-character key option was specified and never built~~ | **Resolved: Settings → Security.** States the tradeoff in numbers — `6 chars · ~29 bits` vs `10 chars · ~49 bits` — and says "applies to the next key", because flipping it does not re-key the session you are in and implying otherwise would be a security claim the app does not honour | ✅ |
| **OI-16** | 🟠 High | **~~An incoming clip destroyed unsent typing.~~** ✅ Fixed. `editor.setText()` was called unconditionally on every received clip, so text you were mid-way through typing vanished with no undo. With Live mode and a 1s poll on the far side this was a matter of time, not a race | The OS clipboard write still always happens — that is the product. The editor is only overwritten when `editor.isDirty()` is false; otherwise the clip is offered as a banner with the text already on the clipboard | ✅ |
| **OI-17** | 🟡 Medium | **A device joining was silent.** The key is a bearer credential and the device list going 2→3 is not something anyone notices — the moment of arrival is the only observable signal that someone else holds your key | ✅ Fixed: roster diffing in `state.setPeers` raises a named warning with a "New key" action. The first roster after connecting is not announced, and the roster resets on disconnect, so a relay redeploy does not report your own devices as intruders and train you to ignore the alert |
| **OI-18** | 🟢 Low | **The retraction seam is in the wrong module.** `registry.announceGone()` takes an injected signal sender because `registry` sits under `transfer` and cannot import it. The outbound half arguably belongs in `transfer.js` beside `announce()`, which already subscribes to `EV.FILE_ADDED` | Left as built: it works, it is covered by 39 tests, and it uses the same injection contract `transfer.js` itself uses. Worth moving if `transfer.js` is touched for other reasons |
| **OI-13** | 🟡 Medium | **Frontend commits restart the relay.** FastAPI Cloud redeploys on any push to the default branch, so a CSS tweak drops every live WebSocket and clears in-memory rooms | Clients already auto-reconnect and re-fetch the last clip, so the blast radius is a brief blip rather than data loss. If it becomes disruptive: develop the frontend on a branch and merge in batches, or move the relay to its own repo so its deploys are independent of site changes | M6 |

| **OI-19** | 🟡 Medium | **A locked session alone in its room cannot be confirmed.** A wrong PIN addresses a different, empty room, indistinguishable from being the first to arrive. `verify` (§7.5) closes this the moment any peer is present — including a peer that arrives an hour later — but with nobody to ask, the app genuinely cannot tell "you are first" from "your PIN is wrong". The narrower case it *used* to have, a room whose retained beacon had expired, is gone: the proof no longer depends on room state surviving | Not papered over: the padlock reads **"Private · unconfirmed"** and a banner offers to re-enter the PIN after 12 s alone with no successful decrypt. Resolving it properly needs server-side state keyed on the room hash, which trades away the "no persistence anywhere" property in §7.2. Not obviously worth it | M8 |
| **OI-20** | 🟢 Low | **Locked mode hides content, not the existence of a session.** The relay still sees a room hash with devices in it, their nicknames in the clear (`hello.name`), every routing field, and frame timing | Documented in §7.5 rather than fixed. The link-holder-without-PIN — the attacker the feature is for — cannot reach the room at all, so what leaks leaks only to the relay operator, who is already outside the trust boundary. Sealing the nickname would be a genuine improvement and is independent of this feature |
| **OI-21** | 🟢 Low | **A cached old build downgrades a locked link.** `sw.js` serves the shell cache-first, so during a rollout a client on the previous build opening `#!KEY` strips the marker and joins the *unlocked* room `KEY`. It learns nothing about the locked session, but the user clicked a link they were told was private | Bounded to the rollout window and mitigated by the `VERSION` bump (`v3` → `v4`), which is mandatory on any deploy touching `src/` anyway. A permanent fix would need the marker to make the fragment unparseable to an old build, which would break the "old clients degrade quietly" property in the other direction |

### 13.1 Decisions still open
Carried from §11.2, repeated here so the register is complete: **D3** default key length (rec. 6, with a 10-char option) · **D4** frontend stack (rec. vanilla JS, no build) · **D5** custom domain (rec. yes — allowlisting) · **D8** keep-alive vs scale-to-zero (blocked on M0 measurement).
