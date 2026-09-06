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
import contextlib
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
#   REALTIMECLIPBOARD_TRUSTED_PROXIES  which immediate peers may set CF-Connecting-IP or
#                           X-Forwarded-For on this relay's behalf. Default "*",
#                           which is what the hosted deployment needs: it sits
#                           behind Cloudflare and every connection arrives from
#                           an edge address. A relay reachable DIRECTLY should
#                           name its proxy — otherwise a client picks its own
#                           rate-limit bucket, including somebody else's.
#   REALTIMECLIPBOARD_REQUIRE_SHARED   whether REALTIMECLIPBOARD_REDIS_URL being unreachable is
#                           fatal at startup. Default on. Configured HA with no
#                           working backend is the split-brain in PRD OI-3, and
#                           a pod that restarts until Redis answers is the
#                           behaviour an orchestrator can actually act on.
CORS_ORIGINS = [o.strip() for o in os.getenv("REALTIMECLIPBOARD_CORS_ORIGINS", "*").split(",") if o.strip()]
DISABLE_FILES = os.getenv("REALTIMECLIPBOARD_DISABLE_FILES", "").lower() in {"1", "true", "yes"}
JOIN_TOKEN = os.getenv("REALTIMECLIPBOARD_JOIN_TOKEN", "") or None
MAX_SESSION_SECONDS = _int("MAX_SESSION", 0)

# Which immediate peers may set CF-Connecting-IP / X-Forwarded-For on this
# relay's behalf. "*" trusts whatever is in front, which is what the hosted
# deployment needs (Cloudflare rewrites the header, and every connection
# arrives from an edge address). A self-hosted relay reachable directly should
# name its proxy, or a client can pick which rate-limit bucket to land in —
# including somebody else's.
# Whether a configured-but-unreachable shared backend is fatal at startup.
# Default on: asking for Redis and not getting it is how rooms split in half.
REQUIRE_SHARED = os.getenv("REALTIMECLIPBOARD_REQUIRE_SHARED", "1").lower() not in {"0", "false", "no"}

TRUSTED_PROXIES = [
    p.strip() for p in os.getenv("REALTIMECLIPBOARD_TRUSTED_PROXIES", "*").split(",") if p.strip()
]


def _trusted_proxy(peer: str) -> bool:
    return "*" in TRUSTED_PROXIES or (bool(peer) and peer in TRUSTED_PROXIES)


# A control message on the room's channel, distinguishable from a protocol
# frame because it is not JSON. Says "my roster changed", carries no roster —
# each replica reads the shared hash and computes the total itself.
ROSTER_NUDGE = "\x00roster"

# How long one peer may take to accept a broadcast frame before it is dropped.
# Generous for a phone on a slow link, short enough that a dead reader cannot
# hold a room's fan-out.
PEER_WRITE_TIMEOUT = 5.0

# How often the lifetime sweeper looks. Only runs when a cap is configured, and
# never coarser than half the cap — a fixed 30s interval would let a 60s limit
# overrun by half again, and a 2s one by fifteen times.
SWEEP_SECONDS = 30

# The sweeper task, so shutdown can stop it.
_sweeper: asyncio.Task | None = None

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
    # file-ok is the receiver's "I have it, and the digest matched" — without it
    # the holder can only say the bytes left, never that they arrived.
    "file-chunk", "file-done", "file-ok", "file-cancel", "file-error",
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

    async def close(self, code: int = 1000) -> None:
        """End the transport. Every subclass must actually end it.

        _retire() calls this to evict a room that has hit its lifetime cap, and
        for a while nothing implemented it: the AttributeError was swallowed by
        the suppress() around the call, so the room was removed from `rooms`
        while every socket carrying it stayed open. The peers went on talking to
        a Room object nothing could reach — a cap on joining, dressed as a cap
        on the session.
        """
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

    async def close(self, code: int = 1000) -> None:
        await self.sock.close(code=code)


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

    async def close(self, code: int = 1000) -> None:
        # There is no socket to close: the stream ends when its generator does,
        # and the sentinel is what tells it to.
        self.end()


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

    # When the room's first peer arrived, for REALTIMECLIPBOARD_MAX_SESSION. The setting
    # was read at startup and then never used by anything, so an operator who
    # capped session lifetime got no cap at all and no way to tell — which is
    # the failure mode docs/SELF-HOSTING.md names as the reason these flags are
    # gated by backend/test_policy.py in the first place.
    created: float = field(default_factory=time.monotonic)

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
    # Fire-and-forget: this function is synchronous and called from four places
    # including an async generator's finally, where an await would be a
    # GeneratorExit. Only scheduled when there is a shared backend to tell.
    if shared.enabled and peer.peer_id:
        with contextlib.suppress(RuntimeError):
            asyncio.create_task(shared.drop_peer(room.hash, peer.peer_id))
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
        # Whether the cross-replica bus is actually working, as opposed to
        # configured. A readiness probe that stays green through a Redis outage
        # is a probe that lets an orchestrator keep routing into rooms that have
        # quietly split in half — which is the failure PRD OI-3 is about.
        "shared": ("off" if not shared.enabled
                   else "ok" if shared.healthy
                   else "degraded"),
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
    """One frame to one connection, on a deadline.

    Bounded for the same reason the fan-out is: a socket write suspends while
    the receiver is not reading, and every caller here is on the sender's own
    read loop. A targeted frame to a peer that had stopped reading held up the
    peer that sent it.
    """
    try:
        await asyncio.wait_for(
            conn.send_text(json.dumps(obj, separators=(",", ":"))), PEER_WRITE_TIMEOUT
        )
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

    # Concurrent, and each write on a deadline.
    #
    # This used to await every peer in turn with no bound. A WebSocket write
    # applies backpressure when the receiver stops reading, so one peer that had
    # gone quiet without closing TCP suspended the fan-out — and because
    # _handle_raw awaits this, it suspended the SENDER's read loop too, and
    # every other peer's fan-out behind the same lock. One slow reader stalled
    # the whole room. The SSE side already had this right (SseConnection uses a
    # bounded queue and put_nowait, for exactly this reason); the socket side
    # did not.
    targets = [p for p in room.peers if p is not exclude]
    if not targets:
        return

    async def deliver(peer: Connection) -> Connection | None:
        try:
            await asyncio.wait_for(peer.send_text(frame), PEER_WRITE_TIMEOUT)
            return None
        except Exception:
            # A timeout is a peer that is not reading. Dropped like any other
            # failed write: it will reconnect, and the room does not wait.
            return peer

    for peer in await asyncio.gather(*(deliver(p) for p in targets)):
        if peer is not None:
            _drop_peer(room, peer)


async def _deliver_remote(room_hash: str, frame: str, to: str | None = None) -> None:
    """A frame another replica published. Delivered here, never re-published.

    Three things this has to get right, and it used to do only the first.

      - A ROOM-WIDE frame is fanned out to our peers.
      - A TARGETED frame goes to the one peer it names, if that peer is ours.
        Targeted frames were never published at all, so rtc-* and file-* could
        not cross replicas and a transfer failed on the pod boundary.
      - A `clip` updates this replica's replay slot. Without it a device joining
        replica B mid-session was welcomed with `last: null` while replica A had
        the clip all along.
    """
    room = rooms.get(room_hash)
    if not room or not frame:
        return

    # A roster nudge, not a frame: the sender changed who it is holding and
    # every other replica needs to recount. Answered by recomputing, never by
    # forwarding somebody else's list as if it were the room.
    if frame == ROSTER_NUDGE:
        await _on_roster_nudge(room_hash)
        return

    if to:
        target = _find(room, to)
        if target is not None and not await _send_raw(target.conn, frame):
            _drop_peer(room, target.conn)
            await _announce_peers(room)
        return

    with contextlib.suppress(ValueError, TypeError):
        if json.loads(frame).get("t") == "clip":
            room.last = frame

    await _broadcast(room, frame, local_only=True)


async def _send_raw(conn: Connection, frame: str) -> bool:
    """A frame that is already serialised. Same deadline as _send()."""
    try:
        await asyncio.wait_for(conn.send_text(frame), PEER_WRITE_TIMEOUT)
        return True
    except Exception:
        return False


@app.on_event("startup")
async def _open_shared() -> None:
    try:
        await shared.connect()
    except Exception as exc:
        # Configured HA with no working backend is the split-brain in PRD OI-3,
        # and it is the one failure this module exists to prevent — so a
        # deployment that asked for Redis and cannot reach it does NOT come up
        # pretending otherwise. The old message said "serving single-process",
        # which was not even true: `enabled` stayed set, so every publish raised
        # into a join and left the peer counted but not connected.
        #
        # Failing here is self-healing under an orchestrator: the pod restarts
        # until Redis answers. REALTIMECLIPBOARD_REQUIRE_SHARED=0 opts out for anyone who
        # would rather serve one process while their cache is down — which is
        # safe only at replicas=1, and says so.
        if REQUIRE_SHARED:
            raise RuntimeError(
                f"REALTIMECLIPBOARD_REDIS_URL is set but the shared backend is unreachable ({exc}). "
                "Refusing to start: with more than one replica this silently splits "
                "rooms. Set REALTIMECLIPBOARD_REQUIRE_SHARED=0 to serve single-process anyway."
            ) from exc
        shared.enabled = False
        print(f"[relay] shared backend unavailable ({exc}). "
              f"Serving single-process — do NOT run more than one replica.")

    if MAX_SESSION_SECONDS:
        global _sweeper
        _sweeper = asyncio.create_task(_sweep_expired())


async def _sweep_expired() -> None:
    """Retire rooms that have hit REALTIMECLIPBOARD_MAX_SESSION.

    The join path checks too, but a cap that only applies to arrivals is not a
    cap on a session: a room whose peers simply stay connected would never be
    asked the question.
    """
    every = max(0.5, min(SWEEP_SECONDS, MAX_SESSION_SECONDS / 2))
    while True:
        await asyncio.sleep(every)
        for room_hash, room in list(rooms.items()):
            if _expired(room):
                with contextlib.suppress(Exception):
                    await _retire(room_hash, room)


@app.on_event("shutdown")
async def _close_shared() -> None:
    if _sweeper is not None:
        _sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _sweeper
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


async def _full_roster(room: Room) -> list[dict]:
    """Everyone in the room, on this replica and on the others."""
    return _roster(room) + await shared.remote_peers(room.hash)


async def _announce_peers(room: Room, exclude: Connection | None = None) -> None:
    """Presence frames report *changes*: who is here and what they are called.

    `count` is kept alongside `list` because existing clients read it (and the
    M0 gate asserts it). A peer that just joined already learned the roster from
    its own welcome, so it is excluded to avoid a duplicate frame.

    Two things had to change for replicas, and they pull in opposite directions.
    The roster is now the WHOLE room, not this process's share of it. And the
    frame is fanned out LOCALLY — it used to go through the publishing
    _broadcast, so every replica re-fanned another replica's partial list to its
    own peers as though it were the room, and the count on screen flapped
    between two wrong answers. Each replica computes the same total and tells
    only its own peers; the nudge below is what makes the others recompute.
    """
    await _broadcast(
        room,
        json.dumps(
            {"t": "peers", "count": len(room.peers) + len(await shared.remote_peers(room.hash)),
             "list": await _full_roster(room)},
            separators=(",", ":"),
        ),
        exclude=exclude,
        local_only=True,
    )
    await shared.publish(room.hash, ROSTER_NUDGE)


async def _on_roster_nudge(room_hash: str) -> None:
    """Another replica's roster changed: recompute ours and tell our peers."""
    room = rooms.get(room_hash)
    if room and room.peers:
        await _broadcast(
            room,
            json.dumps(
                {"t": "peers",
                 "count": len(room.peers) + len(await shared.remote_peers(room_hash)),
                 "list": await _full_roster(room)},
                separators=(",", ":"),
            ),
            local_only=True,
        )


async def _forward(room: Room, me: Peer, msg: dict) -> None:
    """Relay a signalling/file frame to the peer named in `to`.

    `from` is stamped by the relay and overwrites anything the sender put
    there: the connection a frame arrived on is the one fact a client cannot lie
    about, and the recipient needs it to address its reply (an rtc-offer with
    no verified sender is unanswerable). On the SSE fallback that connection is
    the event stream the sid resolved to, never the POST itself.
    """
    to = _short(msg.get("to"), MAX_ID_CHARS)
    target = _find(room, to)
    msg["from"] = me.peer_id

    if target is None:
        # Not here — but with replicas it may be on another one, and only the
        # shared roster knows. Published rather than refused; NO_SUCH_PEER is
        # kept for a peer no replica claims.
        if to and shared.enabled and any(p["id"] == to for p in await shared.remote_peers(room.hash)):
            await shared.publish(
                room.hash, json.dumps(msg, separators=(",", ":")), to=to
            )
            return

        # Also covers a missing/blank/non-string `to`; the echoed value tells a
        # client which of the two it was without adding a second error code.
        await _send(me.conn, {"t": "error", "code": "NO_SUCH_PEER", "to": to})
        return

    if not await _send(target.conn, msg):
        _drop_peer(room, target.conn)
        await _announce_peers(room)


async def _adopt_identity(room: Room, me: Peer, msg: dict) -> tuple[bool, bool]:
    """Apply `hello`. Returns (roster_changed, id_was_taken).

    Uniqueness is checked across the whole room, not just this replica: two
    devices claiming one id on two pods would each be told it was free, and
    every targeted frame after that would reach whichever of them the roster
    happened to name.
    """
    changed = False
    taken = False

    wanted = _short(msg.get("originId"), MAX_ID_CHARS)
    if wanted and wanted != me.peer_id:
        elsewhere = any(p["id"] == wanted for p in await shared.remote_peers(room.hash))
        if _find(room, wanted) is None and not elsewhere:
            await shared.drop_peer(room.hash, me.peer_id)
            me.peer_id = wanted
            changed = True
        else:
            taken = True

    nickname = _short(msg.get("name"), MAX_NAME_CHARS)
    if nickname and nickname != me.name:
        me.name = nickname
        changed = True

    # Re-registered under whatever it ended up being called, so the other
    # replicas' rosters and their targeted routing agree with this one.
    if changed:
        await shared.add_peer(room.hash, me.peer_id, me.name, ROOM_TTL_SECONDS)

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


def _expired(room: Room) -> bool:
    """Has this room outlived REALTIMECLIPBOARD_MAX_SESSION? 0 disables the cap."""
    return bool(MAX_SESSION_SECONDS) and (
        time.monotonic() - room.created > MAX_SESSION_SECONDS
    )


async def _retire(room_hash: str, room: Room) -> None:
    """Close a room that has hit its lifetime cap, and forget what it held.

    Every peer is disconnected rather than merely refused: the cap is on the
    SESSION, so leaving the current occupants connected until they happen to
    reconnect would make it a cap on joining instead.
    """
    for conn in list(room.peers):
        # Told before it is cut off, so the client can say why rather than
        # showing a bare disconnect.
        with contextlib.suppress(Exception):
            await _send(conn, {"t": "error", "code": "SESSION_EXPIRED"})
        try:
            await conn.close(1013)
        except Exception as exc:
            # NOT silent. A close that cannot happen leaves a live transport
            # attached to a room that no longer exists, which is worse than the
            # expiry never firing — and swallowing it is how that shipped.
            print(f"[relay] could not close a {conn.kind} peer on expiry: {exc}")
        _drop_peer(room, conn)
    room.last = None
    rooms.pop(room_hash, None)
    await shared.unsubscribe(room_hash)


def _client_ip(headers, client) -> str:
    """Source address, for the per-address connection count and nothing else.

    Cloudflare fronts the hosted service and CF-Connecting-IP is the address it
    saw; it cannot be spoofed THROUGH Cloudflare, because Cloudflare overwrites
    it. Reached directly, both it and X-Forwarded-For are whatever the client
    typed — and the old note here claimed that bought "nothing worse than the
    cap being evaded, never a cap applied to someone else's address", which was
    wrong in its second half: claiming a victim's address MAX_CONNS_PER_IP times
    fills that victim's bucket and locks them out.

    So the headers are honoured only when the immediate peer is a proxy the
    operator has named. REALTIMECLIPBOARD_TRUSTED_PROXIES defaults to "*" — the hosted
    deployment sits behind Cloudflare and every connection arrives from an edge
    address, so distrusting them would put every user in one bucket and lock
    the whole relay out at once. Self-hosted deployments should set it.

    Not stored on any object that outlives the connection, not logged, and never
    sent to a peer. Returns "" when there is nothing trustworthy to key on.
    """
    peer = (getattr(client, "host", "") or "")[:64]
    if not _trusted_proxy(peer):
        return peer

    direct = (headers.get("cf-connecting-ip") or "").strip()
    if direct:
        return direct[:64]

    forwarded = (headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded[:64]

    return peer


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

    # The lifetime cap, enforced here as well as by the sweeper, so a room
    # cannot be held open indefinitely by reconnecting into it. Retired BEFORE
    # the lookup, so what follows rebuilds it through the ordinary creation
    # path — with its shared subscription and its room-ceiling check.
    stale = rooms.get(room_hash)
    if stale is not None and _expired(stale):
        await _retire(room_hash, stale)

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
        # A named function, not a lambda. The pump calls deliver(frame, to=...)
        # and the lambda took `frame` plus a defaulted `rh` — so the second
        # argument bound to `rh` and every remote frame was delivered to a room
        # named after a peer id. Nothing raised; cross-replica delivery simply
        # stopped, which is the exact silent failure shared.py exists to prevent.
        async def deliver(frame: str, to: str | None = None, rh: str = room_hash) -> None:
            await _deliver_remote(rh, frame, to)

        await shared.subscribe(room_hash, deliver)

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

    # Peers already here, BEFORE we join — the collision signal, and the basis
    # for who may lock the session. Counted across replicas: on one process
    # alone, two devices creating the same key on different pods would each be
    # told they were first.
    existing = len(room.peers) + len(await shared.remote_peers(room_hash))

    # Provisional id: welcome must go out immediately (a client is entitled to
    # sit silent and still be told the room state), and `hello` has not arrived
    # yet. It is replaced by the client's originId the moment hello lands.
    me = Peer(conn=conn, peer_id=uuid.uuid4().hex[:8], country=country, ip=ip)
    room.peers[conn] = me
    # Registered where the other replicas can see it, so their rosters and their
    # targeted routing both know this peer exists.
    await shared.add_peer(room_hash, me.peer_id, "", ROOM_TTL_SECONDS)
    # Counted only once the peer is actually in a room, so every path that
    # returned None above leaves the count untouched and _drop_peer is the sole
    # decrement. Paired insert and remove, one site each.
    if ip:
        ip_conns[ip] = ip_conns.get(ip, 0) + 1

    # `existing > 0` on an intent:"create" means the auto-generated key is taken,
    # and the client must regenerate rather than land in a stranger's room (OI-2).
    replay = room.last or await shared.get_last(room_hash)

    await _send(conn, {
        "t": "welcome",
        "instance": INSTANCE_ID,
        "existing": existing,
        "peers": len(room.peers),
        "you": me.peer_id,
        "list": await _full_roster(room),
        # The room's last clip, from wherever it is. `shared.get_last` was
        # written and then never called, so a late joiner that landed on a
        # replica which had not itself seen the clip was welcomed with nothing
        # to replay — and for a locked session that also meant no beacon, so it
        # could not tell "right PIN" from "wrong PIN".
        "last": json.loads(replay) if replay else None,
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
        changed, taken = await _adopt_identity(room, me, msg)
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
# EventSource and a fetch POST are both cross-origin. The default is "*",
# because there are no credentials anywhere in this design — the session key
# never leaves the browser and the relay only ever holds ciphertext — and
# pinning would break local development, a future custom domain and anyone
# self-hosting a copy. An operator who pins REALTIMECLIPBOARD_CORS_ORIGINS gets what
# they asked for, on every route.


def _cors(request: Request | None = None) -> dict:
    """The configured allowlist, for the routes that write their own headers.

    These routes used to set a hard-coded "*", which silently overrode
    REALTIMECLIPBOARD_CORS_ORIGINS on every SSE and /pub response. Starlette's
    CORSMiddleware neither sets nor strips the header for a DISALLOWED origin,
    so the wildcard survived all the way to the browser: a deployment that had
    pinned its origins — which docker-compose, the Helm values and
    SELF-HOSTING.md all tell operators to do — was not pinned at all on the
    fallback transport, and the fallback needs no preflight to be driven end to
    end.
    """
    if "*" in CORS_ORIGINS:
        return {"Access-Control-Allow-Origin": "*"}
    origin = (request.headers.get("origin") if request else None) or ""
    if origin and origin in CORS_ORIGINS:
        return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}
    return {"Vary": "Origin"}


def _sse_headers(request: Request) -> dict:
    return {**SSE_HEADERS, **_cors(request)}


SSE_HEADERS = {
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

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers=_sse_headers(request))


@app.options("/pub/{room_hash}")
async def pub_preflight(room_hash: str, request: Request) -> Response:
    """The client sends text/plain to stay a "simple request", so this should
    never be reached. It exists for any other client that does not."""
    return Response(status_code=204, headers={
        **_cors(request),
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
        return _json(404, {"t": "error", "code": "NO_STREAM"}, request)

    # The request itself is metered, on top of the frames inside it: otherwise
    # a flood of empty POSTs costs a client nothing.
    if not me.buckets.allow("http"):
        return _json(429, {"t": "error", "code": "RATE_LIMITED"}, request)

    # Capped WHILE reading. request.body() buffers the whole thing first, so the
    # limit was enforced after the allocation it exists to prevent: a declared
    # length is a claim, and a chunked body makes no claim at all, so a handful
    # of concurrent posts could hold far more than the cap in a 512 MB container
    # — and an OOM here takes every live session with it.
    body = await _read_capped(request, MAX_BODY_BYTES)
    if body is None:
        return _json(413, {"t": "error", "code": "TOO_LARGE"}, request)

    for line in body.decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if line:
            await _handle_raw(room, me, line)

    # Nothing to say in the response: every answer the relay has — pong, error,
    # peers, a forwarded frame — goes down the stream, exactly as it would over
    # a WebSocket.
    return Response(status_code=204, headers=_cors(request))


async def _read_capped(request: Request, cap: int) -> bytes | None:
    """Read at most `cap` bytes, then give up. None means "over the limit".

    Stops at the boundary instead of trusting Content-Length, so a lying header
    and a slow chunked trickle are both bounded by what has actually arrived.
    """
    total = 0
    parts: list[bytes] = []
    async for chunk in request.stream():
        total += len(chunk)
        if total > cap:
            return None
        parts.append(chunk)
    return b"".join(parts)


def _by_sid(room: Room, sid: str) -> Peer | None:
    if not sid:
        return None
    for conn, peer in room.peers.items():
        if isinstance(conn, SseConnection) and conn.sid == sid:
            return peer
    return None


def _json(status: int, obj: dict, request: Request | None = None) -> Response:
    return Response(
        content=json.dumps(obj, separators=(",", ":")),
        status_code=status,
        media_type="application/json",
        headers=_cors(request),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
