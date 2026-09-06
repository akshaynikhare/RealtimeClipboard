"""
Deployment policy gate — the REALTIMECLIPBOARD_* flags a self-hoster sets.

test_relay.py proves the protocol. This proves the switches that change it, and
it exists because every one of them fails in the same dangerous direction: a
flag that silently does nothing looks exactly like a flag that works. An
operator who sets REALTIMECLIPBOARD_DISABLE_FILES and gets no error has every reason to
believe files are disabled.

Runs its own relays, on their own ports, with their own environments — the flags
are read at import time, so they cannot be toggled inside one process.

  python test_policy.py
"""

import asyncio
import contextlib
import json
import os
import subprocess
import sys
import time
import urllib.request

import websockets

PORT_TOKEN = 8021
PORT_FILES = 8022
PORT_CAPS = 8023
PORT_IP = 8024
PORT_SESSION = 8025
PORT_CORS = 8026
HERE = os.path.dirname(os.path.abspath(__file__))

passed = failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


def spawn(port: int, env_extra: dict) -> subprocess.Popen:
    env = {**os.environ, **env_extra}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app",
         "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=HERE, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1):
                return proc
        except Exception:
            time.sleep(0.25)
    proc.kill()
    raise RuntimeError(f"relay on {port} did not come up")


# Frames the relay sends on its own initiative. Saying hello produces a roster
# announcement, so a test that reads "the next frame" reads that instead of the
# answer it asked for — and then reports the product broken when it is not.
UNSOLICITED = {"welcome", "peers"}


async def first_frame(url: str, send: dict | None = None, hello: bool = False):
    """Connect, optionally speak, and return the first frame that ANSWERS us."""
    try:
        async with websockets.connect(url) as ws:
            if hello:
                await ws.send(json.dumps({"t": "hello", "intent": "join",
                                          "originId": "policy", "name": "test"}))
            if send is not None:
                await ws.send(json.dumps(send))

            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=4))
                # When nothing was asked, the welcome IS the answer.
                if send is None:
                    return frame
                if frame.get("t") not in UNSOLICITED:
                    return frame
            return {"t": "__timeout__"}
    except Exception as exc:
        return {"t": "__error__", "detail": f"{type(exc).__name__}: {exc}"}


async def main() -> None:
    print("\nDeployment policy\n")

    # ---- REALTIMECLIPBOARD_JOIN_TOKEN -------------------------------------------
    token = spawn(PORT_TOKEN, {"REALTIMECLIPBOARD_JOIN_TOKEN": "s3cret"})
    files = spawn(PORT_FILES, {"REALTIMECLIPBOARD_DISABLE_FILES": "true"})
    try:
        base = f"ws://127.0.0.1:{PORT_TOKEN}/ws/{'a' * 32}"

        got = await first_frame(base)
        check("no token is refused", got.get("code") == "ORG_TOKEN_REQUIRED", json.dumps(got)[:90])

        got = await first_frame(base + "?org=wrong")
        check("a wrong token is refused", got.get("code") == "ORG_TOKEN_REQUIRED", json.dumps(got)[:90])

        # The refusal must not distinguish "no token" from "wrong token": one of
        # those tells an attacker the door exists and the other tells them their
        # guess was the wrong shape.
        a = await first_frame(base)
        b = await first_frame(base + "?org=wrong")
        check("and the two refusals are identical", a == b)

        got = await first_frame(base + "?org=s3cret")
        check("the right token is welcomed", got.get("t") == "welcome", json.dumps(got)[:90])

        # A relay with no token configured must not start demanding one.
        got = await first_frame(f"ws://127.0.0.1:{PORT_FILES}/ws/{'b' * 32}")
        check("an unconfigured relay asks for nothing", got.get("t") == "welcome",
              json.dumps(got)[:90])

        # ---- REALTIMECLIPBOARD_DISABLE_FILES ------------------------------------
        base = f"ws://127.0.0.1:{PORT_FILES}/ws/{'c' * 32}"

        got = await first_frame(base, send={"t": "file-meta", "id": "1", "name": "x",
                                            "size": 1, "type": "text/plain"}, hello=True)
        check("a file frame is refused", got.get("code") == "FILES_DISABLED", json.dumps(got)[:90])

        got = await first_frame(base, send={"t": "rtc-offer", "to": "someone", "sdp": "x"},
                                hello=True)
        check("WebRTC signalling is refused too", got.get("code") == "FILES_DISABLED",
              json.dumps(got)[:90])

        # Refused, not silently dropped: a transfer that never starts and never
        # fails is one the user retries for five minutes.
        check("the refusal is an error frame, not silence", got.get("t") == "error")

        # The product still works. Disabling files must not disable the clipboard.
        got = await first_frame(base, send={"t": "ping"}, hello=True)
        check("clips and pings still work", got.get("t") == "pong", json.dumps(got)[:90])
    finally:
        token.kill()
        files.kill()

    # ---- resource ceilings --------------------------------------------------
    #
    # Both caps answer the same question: a stranger can ask this process to
    # allocate, and nothing used to bound how often. One relay each, because the
    # flags are read at import time and because a failure that could be either
    # cap is not a useful failure. Set absurdly low so the ceiling is reachable
    # in a test rather than in production.
    rooms_relay = spawn(PORT_CAPS, {"REALTIMECLIPBOARD_MAX_ROOMS": "2"})
    ip_relay = spawn(PORT_IP, {"REALTIMECLIPBOARD_MAX_CONNS_PER_IP": "3",
                               "REALTIMECLIPBOARD_MAX_ROOMS": "500"})
    try:
        # ---- MAX_ROOMS ----
        host = f"ws://127.0.0.1:{PORT_CAPS}"
        held = []
        try:
            # Held open: the cap counts LIVE rooms, and a room with no peers is
            # only evicted after the TTL. Closing between attempts tests nothing.
            for i in range(2):
                ws = await websockets.connect(f"{host}/ws/{chr(ord('d') + i) * 32}")
                await asyncio.wait_for(ws.recv(), timeout=4)          # the welcome
                held.append(ws)
            check("two rooms fit under MAX_ROOMS=2", len(held) == 2)

            got = await first_frame(f"{host}/ws/{'f' * 32}")
            check("a THIRD room is refused", got.get("code") == "RELAY_BUSY",
                  json.dumps(got)[:90])

            # The cap must not lock people out of a session already running —
            # only stop new hashes being minted, which is what a keyspace sweep
            # looks like from in here.
            got = await first_frame(f"{host}/ws/{'d' * 32}")
            check("but an EXISTING room still admits peers", got.get("t") == "welcome",
                  json.dumps(got)[:90])
        finally:
            for ws in held:
                await ws.close()

        # ---- MAX_CONNS_PER_IP ----
        host = f"ws://127.0.0.1:{PORT_IP}"
        held = []
        try:
            for i in range(3):
                ws = await websockets.connect(f"{host}/ws/{'h' * 32}")
                await asyncio.wait_for(ws.recv(), timeout=4)
                held.append(ws)
            check("three connections fit under MAX_CONNS_PER_IP=3", len(held) == 3)

            got = await first_frame(f"{host}/ws/{'i' * 32}")
            check("a FOURTH from the same address is refused",
                  got.get("code") == "TOO_MANY_CONNECTIONS", json.dumps(got)[:90])
        finally:
            for ws in held:
                await ws.close()

        # The leak this guards against: a counter decremented at three of the
        # four removal sites locks a real user out of their own relay, and the
        # symptom arrives days later. Everything above is closed, so the table
        # must have drained.
        await asyncio.sleep(0.5)
        health = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{PORT_IP}/health", timeout=2).read())
        check("health reports the ceilings, so a refusal is diagnosable",
              health.get("max_conns_per_ip") == 3, json.dumps(health)[:110])
        check("the per-address table drains as peers leave — no leak",
              health.get("addresses") == 0, f"addresses={health.get('addresses')}")

        got = await first_frame(f"{host}/ws/{'j' * 32}")
        check("and the address is usable again afterwards", got.get("t") == "welcome",
              json.dumps(got)[:90])
    finally:
        rooms_relay.kill()
        ip_relay.kill()

    # --- REALTIMECLIPBOARD_MAX_SESSION -------------------------------------------------
    #
    # Read at startup and then referenced by nothing at all, so an operator who
    # capped session lifetime got no cap — the exact shape of failure this file
    # exists to catch, and it had no test.
    print("\nREALTIMECLIPBOARD_MAX_SESSION")
    session_relay = spawn(PORT_SESSION, {"REALTIMECLIPBOARD_MAX_SESSION": "2"})
    try:
        host = f"ws://127.0.0.1:{PORT_SESSION}"
        room = "s" * 32
        ws = await websockets.connect(f"{host}/ws/{room}")
        await asyncio.wait_for(ws.recv(), timeout=4)
        check("a room opens normally under the cap", True)

        # Past the cap, and the sweeper runs on its own without anyone joining.
        await asyncio.sleep(4.0)
        health = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{PORT_SESSION}/health", timeout=2).read())
        check("the room is retired once it outlives REALTIMECLIPBOARD_MAX_SESSION",
              health.get("rooms") == 0, json.dumps(health)[:110])

        # The peers have to actually GO. Connection had no close() for a while,
        # and the AttributeError was swallowed — so the room vanished from the
        # table while every socket carrying it stayed open, which is a cap on
        # joining wearing the clothes of a cap on the session.
        told = None
        with contextlib.suppress(Exception):
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
                if frame.get("t") == "error":
                    told = frame.get("code")
                    break
        check("...and the peers are told why", told == "SESSION_EXPIRED", str(told))

        closed = False
        try:
            await asyncio.wait_for(ws.recv(), timeout=3)
        except websockets.ConnectionClosed:
            closed = True
        except Exception:
            pass
        check("...and actually disconnected, not just forgotten", closed,
              "a live transport on a room that no longer exists is worse than no cap")
        with contextlib.suppress(Exception):
            await ws.close()

        # And the retirement takes the retained clip with it: rejoining is a
        # fresh room, not the old one with its history intact.
        got = await first_frame(f"{host}/ws/{room}")
        check("...and rejoining gets a fresh room, not the expired one",
              got.get("t") == "welcome" and got.get("existing") == 0
              and got.get("last") is None, json.dumps(got)[:110])
    finally:
        session_relay.kill()

    # --- REALTIMECLIPBOARD_CORS_ORIGINS ------------------------------------------------
    #
    # The SSE and /pub routes wrote their own "*" header, which survived a
    # pinned allowlist all the way to the browser: Starlette neither sets nor
    # strips the header for a disallowed origin, so pinning did nothing on the
    # transport that actually needs CORS.
    print("\nREALTIMECLIPBOARD_CORS_ORIGINS")
    cors_relay = spawn(PORT_CORS, {"REALTIMECLIPBOARD_CORS_ORIGINS": "https://allowed.example"})
    try:
        base = f"http://127.0.0.1:{PORT_CORS}"

        def acao(url: str, origin: str) -> str | None:
            req = urllib.request.Request(url, headers={"Origin": origin})
            try:
                with urllib.request.urlopen(req, timeout=3) as r:
                    return r.headers.get("Access-Control-Allow-Origin")
            except urllib.error.HTTPError as e:
                return e.headers.get("Access-Control-Allow-Origin")

        allowed = acao(f"{base}/pub/{'c' * 32}?sid=nope", "https://allowed.example")
        check("an allowed origin is echoed back", allowed == "https://allowed.example",
              str(allowed))

        denied = acao(f"{base}/pub/{'c' * 32}?sid=nope", "https://evil.example")
        check("a DENIED origin gets no wildcard to ride in on", denied != "*",
              f"got {denied!r} — a hard-coded * here voids the allowlist")
    finally:
        cors_relay.kill()

    print("\n" + "=" * 56)
    print(f"POLICY: {passed}/{passed + failed} passed")
    print("=" * 56)
    sys.exit(1 if failed else 0)


asyncio.run(main())
