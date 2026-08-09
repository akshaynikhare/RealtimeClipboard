"""
RealtimeClipboard relay — M0 clipboard fan-out + M7 peer-to-peer plumbing.

In-memory only: no database, no disk, no Redis. Room state lives in this
process, which is exactly why the deployment MUST be pinned to a single
replica (PRD OI-3). /health exposes INSTANCE_ID so a client can detect a
split-brain deployment loudly instead of silently failing to sync.

The relay never sees plaintext. Payloads are AES-GCM ciphertext produced in
the browser, and the room name is a hash of the user's key (PRD 7.3). Nothing
here decrypts, inspects, stores or logs clip content.

Two jobs:

  1. Clipboard fan-out (M0). `clip` frames go to everyone but the sender, and
     the last one is replayed to a late joiner (FR-3.3).
  2. P2P plumbing (M7). WebRTC signalling and file frames are forwarded to one
     *named* peer via a `to` field (docs/P2P-FILES.md §3), or fanned out to the
     room in the case of `file-meta`. The relay reads exactly three things out
     of these frames — `t`, `to`, and, from `hello`, the sender's id and
     nickname. `sdp`, `thumb`, `payload` and `data` are never touched.

Two ways in, one room. A managed corporate network — the primary deployment
context (PRD §5.4) — may run a TLS-inspecting proxy that refuses the HTTP
Upgrade a WebSocket needs, or accepts the connection and then swallows it. So
every room is reachable two ways:

    WS  /ws/{room}     the default: one socket, both directions
    GET /sse/{room}    downstream as text/event-stream    ┐ PRD §4.3 R3
    POST /pub/{room}   upstream as plain POSTs            ┘ the fallback

They are the same room, the same protocol (PRD §6) and the same peers — a
WebSocket client and an SSE client in one room see each other and sync normally.
Everything below `Connection` is written against a send-a-string interface for
exactly that reason: the fan-out, roster and routing code never learns which
transport it is talking to, so the fallback cannot drift from the main path.

Addressing. Every connection owns a `peerId`. It is provisional (relay
generated) until the client's `hello` arrives, at which point the client's own
`originId` is adopted, so both ends agree on names — the client already labels
files and clips with `originId`. `welcome.you` reports the provisional id; the
roster carried by `welcome.list` and every `peers` frame reports the live one.
Ids are unique per room: a second claimant keeps its provisional id and is told
so with PEER_ID_TAKEN, because targeted delivery is only meaningful if one id
means one socket.
"""

import asyncio
import hmac
import json
import os
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from shared import Backend, REDIS_URL

INSTANCE_ID = uuid.uuid4().hex[:8]
BOOTED_AT = time.time()

# PRD OI-3. Inert unless REALTIMECLIPBOARD_REDIS_URL is set, in which case this is what
# makes replicaCount > 1 safe. See backend/shared.py.
shared = Backend(REDIS_URL, INSTANCE_ID)


def _int(name: str, default: int) -> int:
    """
    A tunable, overridable by environment for self-hosted deployments.

    Named REALTIMECLIPBOARD_* rather than bare, because this process may share an
    environment with anything. Junk is ignored rather than fatal: a relay that
    refuses to start because someone typed MAX_PEERS=eight is a worse outage
    than one that logs it and uses the documented default.
    """
    raw = os.getenv(f"REALTIMECLIPBOARD_{name}")
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        print(f"[relay] REALTIMECLIPBOARD_{name}={raw!r} is not a number; using {default}")
        return default
    if value <= 0:
        print(f"[relay] REALTIMECLIPBOARD_{name}={value} must be positive; using {default}")
        return default
    return value

# PRD FR-2.8. Applies to *every* frame including file-chunk, per
# docs/P2P-FILES.md §5 ("chunk size matches the existing relay frame cap — no
# protocol change"). Note for client authors: 32 KB is the cap on the encoded
# JSON frame, not on the chunk inside it. Base64 inflates 4/3, so a chunk must
# be ~24 KB of ciphertext (~23 KB of file) to fit a 32 KB frame with its
# envelope. A literal 32 KB chunk becomes a ~44 KB frame and is rejected.
MAX_FRAME_BYTES = _int("MAX_FRAME_BYTES", 32 * 1024)
MAX_PEERS = _int("MAX_PEERS", 8)                  # PRD §6
ROOM_TTL_SECONDS = _int("ROOM_TTL", 600)          # PRD FR-3.4 — evict 10 min after the last peer leaves
MAX_ID_CHARS = 64             # peerId / `to` — long enough for a uuid, bounded
MAX_NAME_CHARS = 64           # nickname, e.g. "Chrome · Windows" (FR-5.7)

# ---- resource ceilings --------------------------------------------------
#
# MAX_PEERS bounds a room. Nothing bounded the number of ROOMS, and a room is
# created by asking for one: connect to a random hash and this process allocates
# a Room, a shared-backend subscription and — once the connection drops — a task
# sleeping for the 10-minute TTL. All of it before MAX_PEERS is consulted,
# because that check needs a room to count the peers of. A loop opening and
# closing connections to random hashes therefore costs the attacker nothing and
# costs this process memory for ten minutes a time.
#
# Neither number is a fairness scheduler. They are the point past which the
# relay says so out loud instead of being killed by the platform's OOM reaper,
# which is the failure mode they replace: an OOM takes every live session with
# it, and reports nothing to anyone.
#
# 5,000 rooms is far above any plausible real load for a single pinned replica
# (see the deflate note below for the connection ceiling this pairs with) and
# well inside the memory of the smallest container we deploy.
MAX_ROOMS = _int("MAX_ROOMS", 5_000)

# Per source address, across all rooms. A rate limit is per CONNECTION, so
# opening N sockets multiplies an attacker's frame budget by N; this is what
# bounds N. Generous on purpose — one office behind one NAT is a single address,
# and 64 is far more than the handful of devices a person syncs while still
# being a ceiling.
#
# Its own parse rather than _int(), which treats 0 as junk and substitutes the
# default. Here 0 is a meaningful answer: "do not count", for a deployment that
# fronts this with something better at the job, or one where every client
# genuinely arrives from one address.
def _limit(name: str, default: int) -> int:
    raw = os.getenv(f"REALTIMECLIPBOARD_{name}")
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        print(f"[relay] REALTIMECLIPBOARD_{name}={raw!r} is not a number; using {default}")
        return default
    if value < 0:
        print(f"[relay] REALTIMECLIPBOARD_{name}={value} cannot be negative; using {default}")
        return default
    return value


MAX_CONNS_PER_IP = _limit("MAX_CONNS_PER_IP", 64)

# ---- deployment policy --------------------------------------------------
#
# Everything above is a protocol limit and has one correct value. These are
# choices an OPERATOR makes, and they exist because the interesting deployment
# of this relay is not ours — it is one inside somebody's own network, where the
# pitch is "your engineers already paste secrets into pastebin; here is the same
# convenience on hardware you control".
#
# All default to the hosted behaviour, so an unconfigured relay is exactly the
# relay that was here before and both protocol gates still pass unchanged.
#
#   REALTIMECLIPBOARD_CORS_ORIGINS   comma-separated allowlist. Default "*", which is
#                           safe here only because there are no credentials
#                           anywhere in this design — see the note by the
#                           middleware below. A self-hoster should pin it.
#   REALTIMECLIPBOARD_DISABLE_FILES  refuse WebRTC signalling and file frames outright.
#                           For an operator whose DLP position is "text may
#                           move between a person's own machines, files may
#                           not". Clips are unaffected.
#   REALTIMECLIPBOARD_JOIN_TOKEN     a shared secret every client must present to join
#                           any room. NOT user authentication and not a
#                           substitute for the session key — it is a door on
#                           the relay, so an internal deployment is not an open
#                           relay for anyone who finds the hostname.
#   REALTIMECLIPBOARD_MAX_SESSION    hard cap in seconds on how long one room may live,
#                           counted from its first peer. 0 disables.
#   REALTIMECLIPBOARD_MAX_ROOMS      how many rooms may exist at once. The ceiling that
#                           stops a sweep of the keyspace allocating one Room,
#                           one subscription and one TTL task per guess.
#   REALTIMECLIPBOARD_MAX_CONNS_PER_IP  live connections from one source address. Rate
#                           limits are per connection, so this is what stops
#                           them being multiplied by opening more. 0 disables,
#                           for a deployment that caps this at the edge.
CORS_ORIGINS = [o.strip() for o in os.getenv("REALTIMECLIPBOARD_CORS_ORIGINS", "*").split(",") if o.strip()]
DISABLE_FILES = os.getenv("REALTIMECLIPBOARD_DISABLE_FILES", "").lower() in {"1", "true", "yes"}
JOIN_TOKEN = os.getenv("REALTIMECLIPBOARD_JOIN_TOKEN", "") or None
MAX_SESSION_SECONDS = _int("MAX_SESSION", 0)

# ---- SSE + POST fallback ------------------------------------------------
#
# A POST may carry several frames, one per line, because the fallback pays a
# round trip per request and a client that is trickling ICE candidates or
# pushing file chunks would otherwise make thirty of them. Each LINE is still
# held to MAX_FRAME_BYTES and metered individually, so batching buys latency,
# never allowance.
MAX_BODY_BYTES = 24 * MAX_FRAME_BYTES

# Idle streams must write something or nobody notices they are dead: a browser
# tab that vanishes without closing TCP leaves a peer in the roster until a
# write fails. It also beats the 60-120 s idle reaping common in corporate
# proxies (PRD §5.4) — the same reason the client heartbeats at 30 s.
SSE_KEEPALIVE_SECONDS = 15

# A stream whose reader has stopped reading (suspended tab, dead TCP that has
# not surfaced yet) must not grow without bound. 256 frames is far more than any
# real burst and small enough to be irrelevant to memory; overflowing it means
# the peer is gone, and it is dropped exactly as a failed socket write would.
SSE_QUEUE_MAX = 256

RATE_LIMIT_WINDOW = 1.0

# Rate limits are per connection, per frame class, over a fixed 1 s window.
# Three classes, because one number cannot serve three very different jobs:
#
#   interactive   10/s  PRD §6, unchanged from M0. Human-speed traffic — clip,
#                       ping, hello, and anything unrecognised.
#   signal        60/s  WebRTC setup and file metadata. Trickle ICE emits a
#                       burst of candidates in well under a second, and a user
#                       dropping the 20-file session cap (P2P-FILES §5) emits
#                       20 file-meta frames at once. Both would trip a 10/s cap
#                       and stall connection setup for no good reason.
#   bulk         400/s  file-chunk only — the relay fallback used when ICE
#                       fails (FR-7.6). A 5 MB file is ~160 frames at the 32 KB
#                       cap (P2P-FILES §5, ~220 once base64 overhead is taken
#                       into account), so 400/s clears the largest legal
#                       transfer inside a single window with headroom to spare.
#                       This is a runaway bound, not a fairness scheduler:
#                       400 x 32 KB = 12.8 MB/s worst case from one connection,
#                       and MAX_PEERS bounds how many can do that at once.
#   http          60/s  POST *requests* on the fallback path, charged on top of
#                       the frames inside them. The frame classes bound frame
#                       volume; without this, empty POSTs are free. A client
#                       coalesces everything queued while a request is in
#                       flight, so it makes about one POST per round trip and
#                       never comes near this.
RATE_LIMIT_MSGS = 10          # kept as the documented PRD §6 number
CLASS_LIMITS = {"interactive": RATE_LIMIT_MSGS, "signal": 60, "bulk": 400, "http": 60}

# Frames the relay forwards without looking inside them. Targeted frames name
# one recipient in `to`; ROOM_WIDE frames fan out to everyone but the sender.
#
# The five file-* control frames after file-req are not in docs/P2P-FILES.md,
# which only sketches the happy path. They are what the client actually emits
# (src/files/transfer.js FRAMES): a transfer needs an accept/deny handshake,
# a completion marker and a way to abort, and every one of them is addressed to
# a single peer. Left out, they come back UNKNOWN_TYPE and the fallback path in
# FR-7.6 cannot complete. The relay still reads nothing but `t` and `to`.
TARGETED = {
    "rtc-offer", "rtc-answer", "rtc-ice",
    "file-req", "file-accept", "file-deny",
    "file-chunk", "file-done", "file-cancel", "file-error",
}
ROOM_WIDE = {"file-meta", "file-gone", "cursor", "stream"}

# What REALTIMECLIPBOARD_DISABLE_FILES turns off: everything that moves a file or sets up
# the channel to move one. Not `cursor` or `stream`, which are presence and the
# editor's own view channel rather than data movement, and not `clip`, which is
# the product.
FILE_FRAMES = (TARGETED | ROOM_WIDE) - {"cursor", "stream"}

# Every forwarded frame is setup/teardown control traffic — bursty for a moment,
# then silent — except file-chunk, which is the bulk path, and cursor, which is
# a steady trickle.
FRAME_CLASS = dict.fromkeys(TARGETED | ROOM_WIDE, "signal")
FRAME_CLASS.update({
    "clip": "interactive",
    "ping": "interactive",
    "hello": "interactive",
    "file-chunk": "bulk",
    # Live pointers. Its own class deliberately: the client throttles to ~10/s,
    # but presence is a nicety and clipboard sync is the product. Sharing the
    # interactive bucket would let a moving mouse starve the thing people came
    # for. 20/s leaves the client room to jitter without ever competing.
    "cursor": "cursor",
    # Live typing, for the far editor to render. Same reasoning as `cursor` and
    # the same numbers: the client throttles to 10/s (TEXT.STREAM_THROTTLE_MS)
    # and this leaves it room to jitter. It must NOT share `interactive`, which
    # is 10/s and also carries `clip` — one person typing would sit exactly on
    # that ceiling and rate-limit the clips, which is the product, in favour of
    # a view update, which is not.
    "stream": "stream",
})
CLASS_LIMITS["cursor"] = 20
CLASS_LIMITS["stream"] = 20

# ---- permessage-deflate, off ---------------------------------------------
#
# The single largest thing standing between this relay and its memory ceiling.
#
# `websockets` negotiates the permessage-deflate extension by default, and every
# accepted connection then allocates a zlib context — a ~256 KB window, per
# socket, for as long as the socket is open. Measured against this relay on a
# 512 MB container:
#
#     deflate on    63.6 MB baseline + 276 KB/connection  ->  ~1,600 sockets
#     deflate off   38.3 MB baseline +  80 KB/connection  ->  ~5,900 sockets
#
# and the compression was never buying anything, because of what this relay
# carries. Every payload is AES-GCM ciphertext, base64'd, produced in a browser
# (PRD §7.3). Ciphertext is incompressible by construction — that is what makes
# it ciphertext — so deflate was spending a quarter of a megabyte per peer to
# emit random bytes slightly larger than it found them. Turning it off gives
# back roughly three quarters of the connection ceiling and costs nothing at
# all; it even trims a few bytes per frame that deflate was adding.
#
# Why a monkeypatch and not a flag: the flag is `--ws-per-message-deflate false`
# on uvicorn's command line, and on a managed platform we do not own that
# command line — `fastapi deploy` builds it. So this reaches the same switch
# from inside the app.
#
# Why a property and not an assignment: `Config.__init__` has already run and
# already written `ws_per_message_deflate = True` into the config INSTANCE by
# the time this module is imported (the server loads the app after building its
# config), so a class attribute would be shadowed by it. A property is a data
# descriptor, and data descriptors on the class take precedence over the
# instance `__dict__` — which is what makes this work on the live config object
# rather than only on ones built later. All three of uvicorn's WebSocket
# implementations read this one attribute per connection, so patching it covers
# whichever is in play.
#
# Set REALTIMECLIPBOARD_WS_DEFLATE=1 to leave the default alone.
def _disable_permessage_deflate() -> str:
    """Force permessage-deflate off. Returns what happened, for the boot log."""
    if os.getenv("REALTIMECLIPBOARD_WS_DEFLATE", "").lower() in {"1", "true", "yes"}:
        return "left on (REALTIMECLIPBOARD_WS_DEFLATE)"
    try:
        from uvicorn.config import Config
    except ImportError:
        # Not running under uvicorn. Nothing to do, and nothing is broken —
        # another server simply will not have this knob.
        return "skipped (not uvicorn)"
    try:
        if isinstance(Config.__dict__.get("ws_per_message_deflate"), property):
            return "already off"
        Config.ws_per_message_deflate = property(
            lambda self: False,
            lambda self, value: None,      # swallow Config.__init__'s assignment
        )
        return "off"
    except Exception as exc:               # pragma: no cover — never fail boot
        # A memory optimisation must never be the reason the relay does not
        # start. Worst case we run as we did before, using more RAM.
        return f"could not disable ({exc.__class__.__name__})"


WS_DEFLATE_STATE = _disable_permessage_deflate()
print(f"[relay] permessage-deflate: {WS_DEFLATE_STATE}")

app = FastAPI(title="RealtimeClipboard relay", version="0.2.0-m7")

# CORS on every response, including the ones this file never writes.
#
# The routes below set their own headers, so this looks redundant. It is not,
# and the reason is worth stating: the responses that need it most are the ones
# FastAPI generates on its own — 404 for a route that does not exist, 405, 422,
# 500. Those carry no CORS header, and a browser reports a header-less response
# as "blocked by CORS policy" rather than as the status it actually was.
#
# That cost real debugging time exactly once: a frontend deployed ahead of the
# relay asked for /sse, got a bare 404 because that build did not have the
# route yet, and every console message said CORS. The bug was a stale deploy;
# the diagnosis said cross-origin policy. With this, the same mistake reports
# an honest 404 and takes a minute instead of an evening.
#
# "*" because there are no credentials anywhere in this design — the session key
# never leaves the browser and the relay only ever holds ciphertext. WebSocket
# scopes pass through untouched; CORS does not apply to them.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    max_age=86400,
)


class RateBuckets:
    """Fixed-window counters, one per frame class, for a single connection."""

    __slots__ = ("count", "start")

    def __init__(self) -> None:
        now = time.monotonic()
        self.count = dict.fromkeys(CLASS_LIMITS, 0)
        self.start = dict.fromkeys(CLASS_LIMITS, now)

    def allow(self, cls: str) -> bool:
        now = time.monotonic()
        if now - self.start[cls] > RATE_LIMIT_WINDOW:
            self.count[cls], self.start[cls] = 0, now
        self.count[cls] += 1
        return self.count[cls] <= CLASS_LIMITS[cls]


class Connection:
    """One client, whatever transport is carrying it.

    The room logic needs exactly two things from a transport: something it can
    push a text frame at, and an identity it can key a dict by (object identity,
    which both subclasses get for free). Keeping the surface this small is what
    makes the SSE fallback a peer of the WebSocket path rather than a parallel
    implementation of it — there is nowhere for the two to diverge.
    """

    kind = "?"

    async def send_text(self, text: str) -> None:
        raise NotImplementedError


class WsConnection(Connection):
    """A WebSocket peer.

    The lock is the whole of this class beyond the socket. `_broadcast` awaits
    each `send_text` in turn, and nothing serialises one fan-out against
    another: two senders in a room, or a local fan-out racing the Redis pump,
    put two coroutines on the same socket the moment one of them suspends —
    which a backpressured reader guarantees. Concurrent sends on one connection
    are outside the ASGI contract, and the failure is either interleaved frames
    or an exception that `_broadcast` reads as a dead peer and evicts a healthy
    client for. SSE needs no equivalent: its `send_text` never awaits.
    """

    kind = "ws"

    __slots__ = ("sock", "lock")

    def __init__(self, sock: WebSocket) -> None:
        self.sock = sock
        self.lock = asyncio.Lock()

    async def send_text(self, text: str) -> None:
        async with self.lock:
            await self.sock.send_text(text)


class SseConnection(Connection):
    """Downstream half of the fallback: a queue drained by the event stream.

    `sid` is the session token. The relay only ever trusts the connection a
    frame arrived on (see `_forward`), and on this transport that connection is
    the stream — a POST is a separate TCP request that could claim to be anyone.
    The token is server-issued, handed out once on `welcome`, and is what ties
    the two halves together.
    """

    kind = "sse"

    __slots__ = ("sid", "queue")

    def __init__(self) -> None:
        self.sid = uuid.uuid4().hex
        self.queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=SSE_QUEUE_MAX)

    async def send_text(self, text: str) -> None:
        # Never awaits: a fan-out must not block on one slow reader, and a full
        # queue means this peer has stopped consuming. QueueFull propagates to
        # the caller, which treats it exactly like a failed socket write and
        # drops the peer.
        self.queue.put_nowait(text)

    def end(self) -> None:
        """Sentinel that tells the streaming generator to finish."""
        try:
            self.queue.put_nowait(None)
        except asyncio.QueueFull:
            pass


@dataclass
class Peer:
    conn: Connection
    peer_id: str
    name: str = ""
    # Source address, kept ONLY as the key of the per-address connection count
    # and released the moment the peer leaves. Never sent to a peer, never
    # logged, and not the same thing as `country` below, which survives as a
    # counter input. Empty when the address could not be determined, which
    # disables counting for that connection rather than lumping every unknown
    # together under one key — that bucket would fill and lock out real clients.
    ip: str = ""
    # Two-letter country, read once from Cloudflare's header at connect time
    # and kept only as a counter input for /stats. The address it was derived
    # from is never stored, and this is never sent to any peer — a country code
    # is coarse, but it is still more than anyone in a clipboard session needs
    # to know about the others.
    country: str = ""
    # Rate limiting belongs to the peer, not to the read loop: on the fallback
    # transport there is no loop to hang it on — frames arrive on unrelated POST
    # requests — and a limit that resets whenever a request ends is not a limit.
    buckets: RateBuckets = field(default_factory=RateBuckets)


@dataclass
class Room:
    # Its own key in `rooms`. Needed because a frame being fanned out has to be
    # published under the room's name, and the fan-out only ever received the
    # Room object. Defaulted so nothing that constructs a bare Room breaks.
    hash: str = ""

    # Keyed by connection: the connection is the identity that always exists,
    # whereas a peerId only becomes meaningful once `hello` lands.
    peers: dict[Connection, Peer] = field(default_factory=dict)
    last: str | None = None       # last clip envelope, as a JSON string. Ciphertext.
    seq: int = 0
    evict_task: asyncio.Task | None = None

    # Locked sessions: the admission token the first arrival presented, if any.
    #
    # Trust on first use, and safe here for a reason that is worth stating: the
    # room hash of a locked session is itself derived from the PIN, so reaching
    # this room at all already required the secret. A squatter cannot get here
    # first without it. That also means this check is defence in depth rather
    # than the primary control — see the note on _admits().
    auth: str | None = None


rooms: dict[str, Room] = {}

# Live connections per source address. A key exists only while it is non-zero —
# see _drop_peer — so this does not become a second unbounded dict and quietly
# undo the reason the caps exist.
ip_conns: dict[str, int] = {}


def _drop_peer(room: Room, conn: Connection) -> Peer | None:
    """Remove a peer from a room and release what it was holding.

    Every removal goes through here. There are four sites that drop a peer — an
    ordinary departure, a failed fan-out write, a failed targeted forward, and
    the SSE generator closing — and a per-address counter decremented at three
    of them is worse than no counter at all: it leaks, and the leak locks a real
    user out of their own relay with a message about connection limits.
    """
    peer = room.peers.pop(conn, None)
    if peer is None:
        return None
    if peer.ip:
        remaining = ip_conns.get(peer.ip, 1) - 1
        if remaining > 0:
            ip_conns[peer.ip] = remaining
        else:
            ip_conns.pop(peer.ip, None)
    return peer


# ---------------------------------------------------------------- health

@app.get("/health")
async def health():
    """Instance identity, so the client can detect multi-replica split-brain (OI-3)."""
    return {
        "ok": True,
        "instance": INSTANCE_ID,
        "uptime_s": round(time.time() - BOOTED_AT, 1),
        "rooms": len(rooms),
        "peers": sum(len(r.peers) for r in rooms.values()),
        # Reported so "why is it refusing connections" is answerable from
        # outside. A relay sitting on its ceiling looks identical to a broken
        # one from a client, which is the whole difficulty of a cap.
        "max_rooms": MAX_ROOMS,
        "max_conns_per_ip": MAX_CONNS_PER_IP,
        "addresses": len(ip_conns),
        # Reported because the thing it reports is a monkeypatch against another
        # project's internals, and its failure is silent and expensive: if a
        # uvicorn upgrade moves that attribute, the relay keeps working while
        # quietly costing ~3.5x the memory per connection and losing three
        # quarters of its ceiling. This is how you find that out from outside.
        "ws_deflate": WS_DEFLATE_STATE,
    }


@app.get("/stats")
async def stats(response: Response):
    """Aggregate activity, for the live globe on the landing page.

    Deliberately blunt about what it is NOT. This returns counts and country
    codes and nothing else:

      - no room hashes. A room hash is derived from the share key, so
        publishing the set of live hashes would let anyone confirm whether a
        guessed key is currently in use — an oracle for the one secret the
        whole design rests on.
      - no session contents, ever. The relay only holds ciphertext anyway.
      - no IP addresses, and none are stored. The country is read from the
        Cloudflare header already attached to the connection, counted, and the
        header itself is discarded.

    The counts are per-instance, which is honest given replicas are pinned to
    one (OI-3), and they are live rather than cumulative — a device that closes
    its tab stops being counted.
    """
    # CORS, on this route only.
    #
    # The site is served from github.io and the relay from fastapicloud.dev, so
    # this is a cross-origin fetch. WebSockets never needed CORS, which is why
    # nothing else here sets it — and without this header the landing page's
    # globe silently stays dark forever, with the request failing in a way only
    # the browser console mentions.
    #
    # "*" rather than a pinned origin because the payload is public aggregate
    # counts with no credentials, and pinning would break local development, a
    # future custom domain and anyone running their own copy. Deliberately not
    # applied app-wide: the WebSocket route has no business advertising this.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Cache-Control"] = "public, max-age=15"
    return _stats_payload()


# How long a computed /stats payload is reused. The globe polls on a 30 s floor
# (src/landing/globe.js) and the response is already declared cacheable for 15 s,
# so nothing observable changes — this is only about what happens when the
# browser cache is not the thing asking.
STATS_CACHE_SECONDS = 5.0
_stats_cached: dict | None = None
_stats_cached_at = 0.0


def _stats_payload() -> dict:
    """The globe's counts, recomputed at most once every STATS_CACHE_SECONDS.

    This walks every peer in every room, which is O(rooms x peers) on the event
    loop — the same loop every clip and every heartbeat is waiting on. It is
    also public, unauthenticated and linked from the landing page, so the number
    of times it runs is chosen by whoever is visiting rather than by us.

    On the hosted tier that loop has 0.1 vCPU to work with. A few hundred people
    with the landing page open is then enough for the globe to measurably slow
    down the clipboard, which is a poor trade for a decoration. Recomputing on a
    timer instead makes the cost of a request independent of how many arrive.

    Deliberately not a background task: a room with no visitors should compute
    nothing at all, and a timer that keeps running when the page is closed is
    the thing scale-to-zero exists to avoid.
    """
    global _stats_cached, _stats_cached_at

    now = time.monotonic()
    if _stats_cached is not None and now - _stats_cached_at < STATS_CACHE_SECONDS:
        return _stats_cached

    countries: dict[str, int] = {}
    devices = 0
    for room in rooms.values():
        devices += len(room.peers)
        for peer in room.peers.values():
            if peer.country:
                countries[peer.country] = countries.get(peer.country, 0) + 1

    _stats_cached = {
        "rooms": len(rooms),
        "devices": devices,
        "countries": countries,
        "instance": INSTANCE_ID,
    }
    _stats_cached_at = now
    return _stats_cached


# ---------------------------------------------------------------- helpers

def _short(value, limit: int) -> str | None:
    """Accept a short, non-empty string; reject everything else.

    Applied to routing metadata only (ids, `to`, nicknames) so a hostile or
    buggy client cannot inject a 30 KB peer id or a non-string into the roster.
    """
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed and len(trimmed) <= limit:
            return trimmed
    return None


async def _send(conn: Connection, obj: dict) -> bool:
    try:
        await conn.send_text(json.dumps(obj, separators=(",", ":")))
        return True
    except Exception:
        return False


async def _broadcast(room: Room, frame: str, exclude: Connection | None = None,
                     local_only: bool = False) -> None:
    """Fan out a raw frame to every peer but the sender (PRD FR-3.2).

    `local_only` is set when this frame ARRIVED from another replica: it has
    already been fanned out there, and re-publishing it would loop it between
    the two forever.
    """
    if not local_only:
        await shared.publish(room.hash, frame)
    dead = []
    for peer in list(room.peers):
        if peer is exclude:
            continue
        try:
            await peer.send_text(frame)
        except Exception:
            dead.append(peer)
    for peer in dead:
        _drop_peer(room, peer)


async def _deliver_remote(room_hash: str, frame: str) -> None:
    """A frame that another replica fanned out. Deliver it to our peers only."""
    room = rooms.get(room_hash)
    if room and frame:
        await _broadcast(room, frame, local_only=True)


@app.on_event("startup")
async def _open_shared() -> None:
    try:
        await shared.connect()
    except Exception as exc:
        # Loud, and non-fatal. A relay that refuses to start because Redis is
        # slow to come up is worse than one that serves a single process and
        # says so — but it MUST say so, because the silent version of this is
        # the split-brain in PRD OI-3.
        print(f"[relay] shared backend unavailable ({exc}). "
              f"Serving single-process — do NOT run more than one replica.")


@app.on_event("shutdown")
async def _close_shared() -> None:
    await shared.close()


def _roster(room: Room) -> list[dict]:
    """Who is in the room, in join order. Nicknames only — no payload, ever.

    An empty `name` means the client has not told us one (it has not sent hello
    yet, or sent it without a nickname). The relay does not invent a label for
    it: naming a device is the client's job (FR-5.7), and `""` is the signal the
    UI needs to substitute its own wording.
    """
    return [{"peerId": p.peer_id, "name": p.name} for p in room.peers.values()]


def _find(room: Room, peer_id: str | None) -> Peer | None:
    if peer_id is None:
        return None
    for peer in room.peers.values():
        if peer.peer_id == peer_id:
            return peer
    return None


async def _announce_peers(room: Room, exclude: Connection | None = None) -> None:
    """Presence frames report *changes*: who is here and what they are called.

    `count` is kept alongside `list` because existing clients read it (and the
    M0 gate asserts it). A peer that just joined already learned the roster from
    its own welcome, so it is excluded to avoid a duplicate frame.
    """
    await _broadcast(
        room,
        json.dumps(
            {"t": "peers", "count": len(room.peers), "list": _roster(room)},
            separators=(",", ":"),
        ),
        exclude=exclude,
    )


async def _forward(room: Room, me: Peer, msg: dict) -> None:
    """Relay a signalling/file frame to the peer named in `to`.

    `from` is stamped by the relay and overwrites anything the sender put
    there: the connection a frame arrived on is the one fact a client cannot lie
    about, and the recipient needs it to address its reply (an rtc-offer with
    no verified sender is unanswerable). On the SSE fallback that connection is
    the event stream the sid resolved to, never the POST itself.
    """
    target = _find(room, _short(msg.get("to"), MAX_ID_CHARS))
    if target is None:
        # Also covers a missing/blank/non-string `to`; the echoed value tells a
        # client which of the two it was without adding a second error code.
        await _send(me.conn, {
            "t": "error",
            "code": "NO_SUCH_PEER",
            "to": _short(msg.get("to"), MAX_ID_CHARS),
        })
        return

    msg["from"] = me.peer_id
    if not await _send(target.conn, msg):
        _drop_peer(room, target.conn)
        await _announce_peers(room)


def _adopt_identity(room: Room, me: Peer, msg: dict) -> tuple[bool, bool]:
    """Apply `hello`. Returns (roster_changed, id_was_taken)."""
    changed = False
    taken = False

    wanted = _short(msg.get("originId"), MAX_ID_CHARS)
    if wanted and wanted != me.peer_id:
        if _find(room, wanted) is None:
            me.peer_id = wanted
            changed = True
        else:
            taken = True

    nickname = _short(msg.get("name"), MAX_NAME_CHARS)
    if nickname and nickname != me.name:
        me.name = nickname
        changed = True

    return changed, taken


async def _evict_later(room_hash: str) -> None:
    """Drop the room (and its last clip) once it has been empty for the TTL."""
    try:
        await asyncio.sleep(ROOM_TTL_SECONDS)
    except asyncio.CancelledError:
        return
    room = rooms.get(room_hash)
    if room and not room.peers:
        rooms.pop(room_hash, None)
        # One pump task per room, so an evicted room must give its back.
        # Without this a long-lived relay accumulates a task and a subscription
        # for every room it has ever seen.
        await shared.unsubscribe(room_hash)


# ------------------------------------------------------- session, either way

def _country_of(headers) -> str:
    """Two-letter country from Cloudflare's header, or "" if it is not sane.

    Cloudflare fronts this service, so CF-IPCountry is already on the request.
    Read once, counted in /stats, and the address it was derived from is never
    stored.
    """
    country = (headers.get("cf-ipcountry") or "").upper()
    return country if len(country) == 2 and country.isalpha() else ""


def _client_ip(headers, client) -> str:
    """Source address, for the per-address connection count and nothing else.

    Cloudflare fronts this service and CF-Connecting-IP is the address it saw;
    it cannot be spoofed by a client through Cloudflare, because Cloudflare
    overwrites it. X-Forwarded-For is read only as a fallback for a self-hosted
    deployment behind a different proxy, and it CAN be spoofed by anyone talking
    to this process directly — which is why it buys nothing worse than the cap
    being evaded, never a cap applied to someone else's address.

    Not stored on any object that outlives the connection, not logged, and never
    sent to a peer. Returns "" when there is nothing trustworthy to key on.
    """
    direct = (headers.get("cf-connecting-ip") or "").strip()
    if direct:
        return direct[:64]

    forwarded = (headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded[:64]

    return (getattr(client, "host", "") or "")[:64]


def _admits(room: Room, auth: str | None) -> bool:
    """Does this room accept a peer presenting `auth`?

    Locked sessions (see src/core/crypto.js `deriveLocked`) hand the relay a
    token derived alongside the encryption key. The relay can compare two peers'
    tokens without being able to reverse either into the PIN or the share key —
    it is HKDF output over 600k-iteration PBKDF2, and the relay never sees the
    inputs.

    Be clear about what this buys, because over-claiming it would be worse than
    not having it. A locked room's NAME already requires the PIN, so a peer
    without it cannot address this room and never arrives to be refused. This
    check therefore catches implementation slips — a client that derives a room
    hash correctly but its key wrongly, a future refactor that decouples the
    two — not an attacker. It is also no defence against the relay operator,
    who sees the room hash regardless.

    An empty token matches an empty token, so open sessions are unaffected.
    """
    if room.auth is None and not room.peers:
        return True                       # first arrival sets the room's answer
    return hmac.compare_digest(room.auth or "", auth or "")


async def _join(room_hash: str, conn: Connection, country: str,
                extra: dict | None = None, auth: str | None = None,
                org: str | None = None, ip: str = ""):
    """Put a connection in a room and welcome it. Returns (room, peer) or None.

    None means the connection must be ended — the relay is at its room ceiling,
    this address holds too many connections, the room is full, the deployment
    requires an org token this peer did not present, or the peer failed the
    locked-session admission check. The error frame has already been sent
    either way.
    """
    # REALTIMECLIPBOARD_JOIN_TOKEN: a door on the RELAY, checked before anything else,
    # including before the room is created. Without it, an internal deployment
    # is an open relay for anyone who learns the hostname.
    #
    # It is not user authentication and must not be mistaken for the session
    # key: everyone in an organisation holds the same value, and it says
    # "you may use this relay", never "you may read this room". The key is
    # still the only thing that decrypts anything.
    #
    # compare_digest because this is a secret compared on every connection, and
    # `==` on strings leaks its length and prefix through timing.
    if JOIN_TOKEN is not None and not hmac.compare_digest(org or "", JOIN_TOKEN):
        await _send(conn, {"t": "error", "code": "ORG_TOKEN_REQUIRED"})
        return None

    # Before the room is created, for the same reason as the join token: a check
    # that runs after allocation does not bound allocation.
    if MAX_CONNS_PER_IP and ip and ip_conns.get(ip, 0) >= MAX_CONNS_PER_IP:
        await _send(conn, {"t": "error", "code": "TOO_MANY_CONNECTIONS"})
        return None

    room = rooms.get(room_hash)
    if room is None:
        # Creating a room is the only unbounded allocation a stranger can ask
        # for, so this is where the ceiling belongs. An EXISTING room is never
        # refused on this count — the cap must not lock people out of sessions
        # that are already running, only stop new hashes being minted, which is
        # what a sweep of the keyspace looks like from in here.
        if len(rooms) >= MAX_ROOMS:
            await _send(conn, {"t": "error", "code": "RELAY_BUSY"})
            return None

        room = rooms[room_hash] = Room(hash=room_hash)
        # Frames from the other replicas are fanned out locally and NOT
        # re-published, or the two processes would bounce each one forever.
        await shared.subscribe(
            room_hash,
            lambda frame, rh=room_hash: _deliver_remote(rh, frame),
        )

    if len(room.peers) >= MAX_PEERS:
        await _send(conn, {"t": "error", "code": "ROOM_FULL"})
        return None

    if not _admits(room, auth):
        # Deliberately says nothing about what the right token would look like,
        # and nothing about whether the room exists — the response to a bad
        # token is identical to the response to a token for the wrong room.
        await _send(conn, {"t": "error", "code": "AUTH_FAILED"})
        return None

    if not room.peers:
        room.auth = auth or None          # includes re-arming after an eviction

    # A room that was counting down to eviction is alive again.
    if room.evict_task and not room.evict_task.done():
        room.evict_task.cancel()
        room.evict_task = None

    existing = len(room.peers)   # peers already here, BEFORE we join — the collision signal

    # Provisional id: welcome must go out immediately (a client is entitled to
    # sit silent and still be told the room state), and `hello` has not arrived
    # yet. It is replaced by the client's originId the moment hello lands.
    me = Peer(conn=conn, peer_id=uuid.uuid4().hex[:8], country=country, ip=ip)
    room.peers[conn] = me
    # Counted only once the peer is actually in a room, so every path that
    # returned None above leaves the count untouched and _drop_peer is the sole
    # decrement. Paired insert and remove, one site each.
    if ip:
        ip_conns[ip] = ip_conns.get(ip, 0) + 1

    # `existing > 0` on an intent:"create" means the auto-generated key is taken,
    # and the client must regenerate rather than land in a stranger's room (OI-2).
    await _send(conn, {
        "t": "welcome",
        "instance": INSTANCE_ID,
        "existing": existing,
        "peers": len(room.peers),
        "you": me.peer_id,
        "list": _roster(room),
        "last": json.loads(room.last) if room.last else None,
        **(extra or {}),
    })
    await _announce_peers(room, exclude=conn)
    return room, me


async def _after_departure(room_hash: str, room: Room) -> None:
    """Tell whoever is left, or start the room's eviction clock."""
    if room.peers:
        await _announce_peers(room)
    else:
        room.evict_task = asyncio.create_task(_evict_later(room_hash))


async def _depart(room_hash: str, room: Room, me: Peer) -> None:
    """Remove a peer and either re-announce the roster or start the TTL clock."""
    _drop_peer(room, me.conn)
    await _after_departure(room_hash, room)


async def _handle_raw(room: Room, me: Peer, raw: str) -> None:
    """Everything the relay does with one inbound frame, whatever carried it.

    Both transports funnel through here, so size caps, rate limits and routing
    cannot behave differently on the fallback path — a client that is forced
    onto SSE gets the identical relay, not a lenient copy of it.
    """
    if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
        # Charged to the interactive bucket. Before this, an oversize frame
        # `continue`d past the rate check, so a flood of 33 KB frames bought an
        # unmetered error echo for free.
        code = "TOO_LARGE" if me.buckets.allow("interactive") else "RATE_LIMITED"
        await _send(me.conn, {"t": "error", "code": code})
        return

    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        msg = None

    # `[]`, `"x"` and `5` are all valid JSON and none of them is a frame.
    # Rejecting them here keeps a stray frame from raising AttributeError deep
    # in the loop and dropping the connection.
    if not isinstance(msg, dict):
        code = "BAD_JSON" if me.buckets.allow("interactive") else "RATE_LIMITED"
        await _send(me.conn, {"t": "error", "code": code})
        return

    kind = msg.get("t")

    if not me.buckets.allow(FRAME_CLASS.get(kind, "interactive")):
        await _send(me.conn, {"t": "error", "code": "RATE_LIMITED"})
        return

    if kind == "ping":                      # heartbeat (PRD FR-3.6)
        await _send(me.conn, {"t": "pong"})

    elif kind == "hello":                   # intent already answered by welcome
        changed, taken = _adopt_identity(room, me, msg)
        if taken:
            # Never silent: the client is addressable, just not under the name
            # it asked for, and it needs to know which.
            await _send(me.conn, {
                "t": "error", "code": "PEER_ID_TAKEN", "you": me.peer_id,
            })
        if changed:
            # Sender included: this is the frame that tells it which id and
            # nickname the room actually knows it by.
            await _announce_peers(room)

    elif kind == "clip":
        room.seq += 1
        envelope = {
            "t": "clip",
            "payload": msg.get("payload"),
            "iv": msg.get("iv"),
            "originId": msg.get("originId"),
            "seq": room.seq,
        }
        room.last = json.dumps(envelope, separators=(",", ":"))
        # FR-3.3 replay, shared. Carries the room's own TTL, so it expires with
        # the room rather than outliving it.
        await shared.set_last(room.hash, room.last, ROOM_TTL_SECONDS)
        await _broadcast(room, room.last, exclude=me.conn)

    elif DISABLE_FILES and kind in FILE_FRAMES:
        # Refused, not dropped. A client whose file-req vanishes shows a
        # transfer that never starts and never fails, and the user retries it
        # for five minutes; an error says whose decision this was. `cursor` is
        # deliberately still allowed — it is presence, not data movement.
        await _send(me.conn, {"t": "error", "code": "FILES_DISABLED"})

    elif kind in ROOM_WIDE:                 # file-meta: thumbnails to the room
        msg["from"] = me.peer_id
        await _broadcast(
            room, json.dumps(msg, separators=(",", ":")), exclude=me.conn
        )

    elif kind in TARGETED:                  # rtc-*, file-req, file-chunk
        await _forward(room, me, msg)

    else:
        await _send(me.conn, {"t": "error", "code": "UNKNOWN_TYPE"})


# ---------------------------------------------------------------- websocket

@app.websocket("/ws/{room_hash}")
async def ws(sock: WebSocket, room_hash: str):
    await sock.accept()
    conn = WsConnection(sock)

    # ?a= is a locked session's admission token. Absent for open sessions, and a
    # client older than this check simply never sends one.
    joined = await _join(room_hash, conn, _country_of(sock.headers),
                         auth=sock.query_params.get("a"),
                         org=sock.query_params.get("org"),
                         ip=_client_ip(sock.headers, sock.client))
    if joined is None:
        await sock.close(code=1013)
        return
    room, me = joined

    try:
        while True:
            await _handle_raw(room, me, await sock.receive_text())
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await _depart(room_hash, room, me)


# ------------------------------------------------------- SSE + POST fallback
#
# The same room and the same protocol over two plain HTTP requests, for clients
# whose network will not pass a WebSocket upgrade (PRD §4.3 R3, §5.4).

# CORS matters here in a way it never did for WebSockets, which are exempt from
# it: the site is served from github.io and this relay from another host, so an
# EventSource and a fetch POST are both cross-origin. "*" because there are no
# credentials anywhere in this design — the session key never leaves the browser
# and the relay only ever holds ciphertext — and pinning an origin would break
# local development, a future custom domain, and anyone self-hosting a copy.
CORS = {"Access-Control-Allow-Origin": "*"}

SSE_HEADERS = {
    **CORS,
    "Cache-Control": "no-cache, no-store, no-transform",
    "Connection": "keep-alive",
    # Ask intermediaries not to buffer. nginx and several corporate proxies
    # honour this; a proxy that buffers anyway turns the stream into a response
    # that arrives all at once at the end, which the client detects on its own
    # (it gives every transport a fixed window to deliver the welcome frame).
    "X-Accel-Buffering": "no",
}


def _event(data: str) -> bytes:
    """One SSE message. The protocol frame is the payload, unchanged."""
    return f"data: {data}\n\n".encode("utf-8")


@app.get("/sse/{room_hash}")
async def sse(room_hash: str, request: Request):
    """Downstream half of the fallback: everything the room sends this peer."""
    conn = SseConnection()

    # Same admission check as the WebSocket path. The fallback exists so a
    # blocked network is not a broken app, not so it is a laxer door — a check
    # that only one transport enforces is a check an attacker chooses not to
    # meet.
    joined = await _join(room_hash, conn, _country_of(request.headers),
                         extra={"sid": conn.sid},
                         auth=request.query_params.get("a"),
                         org=request.query_params.get("org"),
                         ip=_client_ip(request.headers, request.client))

    async def stream() -> AsyncIterator[bytes]:
        # 2 KB of comment before anything else. Some proxies (and one or two
        # browsers) will not surface a response body until a few kilobytes have
        # arrived, which would hold the welcome frame — and therefore the whole
        # session — hostage behind the first clip. A comment line is ignored by
        # every SSE parser.
        yield b":" + b" " * 2048 + b"\n\n"

        if joined is None:                     # room full or refused; error queued
            while not conn.queue.empty():
                item = conn.queue.get_nowait()
                if item is not None:
                    yield _event(item)
            return

        room, me = joined
        try:
            while True:
                try:
                    item = await asyncio.wait_for(conn.queue.get(), SSE_KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    # Keepalive. Also how a dead client is discovered: writing
                    # to a socket nobody is reading is what eventually raises.
                    yield b": ka\n\n"
                    continue
                if item is None:
                    break
                yield _event(item)
        finally:
            # Runs on cancellation too, which is what a closed tab looks like.
            #
            # The removal is synchronous so the roster never briefly shows a
            # ghost, but the announcement that follows is NOT awaited here: this
            # `finally` usually runs because the generator is being closed, and
            # an await that suspends at that point is a RuntimeError ("async
            # generator ignored GeneratorExit") that would take the cleanup with
            # it. Telling the other peers is a separate task.
            _drop_peer(room, me.conn)
            try:
                asyncio.create_task(_after_departure(room_hash, room))
            except RuntimeError:
                pass                    # the loop is going away; so is the room

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.options("/pub/{room_hash}")
async def pub_preflight(room_hash: str) -> Response:
    """The client sends text/plain to stay a "simple request", so this should
    never be reached. It exists for any other client that does not."""
    return Response(status_code=204, headers={
        **CORS,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    })


@app.post("/pub/{room_hash}")
async def pub(room_hash: str, request: Request, sid: str = "") -> Response:
    """Upstream half of the fallback: one or more frames, one per line.

    The sid names the *stream*, and the stream is the session — a peer that has
    no live stream has nowhere to receive replies, so 404 here is the client's
    signal to reopen rather than to keep posting into the void.
    """
    room = rooms.get(room_hash)
    me = _by_sid(room, sid) if room else None
    if me is None:
        return _json(404, {"t": "error", "code": "NO_STREAM"})

    # The request itself is metered, on top of the frames inside it: otherwise
    # a flood of empty POSTs costs a client nothing.
    if not me.buckets.allow("http"):
        return _json(429, {"t": "error", "code": "RATE_LIMITED"})

    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        return _json(413, {"t": "error", "code": "TOO_LARGE"})

    for line in body.decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if line:
            await _handle_raw(room, me, line)

    # Nothing to say in the response: every answer the relay has — pong, error,
    # peers, a forwarded frame — goes down the stream, exactly as it would over
    # a WebSocket.
    return Response(status_code=204, headers=CORS)


def _by_sid(room: Room, sid: str) -> Peer | None:
    if not sid:
        return None
    for conn, peer in room.peers.items():
        if isinstance(conn, SseConnection) and conn.sid == sid:
            return peer
    return None


def _json(status: int, obj: dict) -> Response:
    return Response(
        content=json.dumps(obj, separators=(",", ":")),
        status_code=status,
        media_type="application/json",
        headers=CORS,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
