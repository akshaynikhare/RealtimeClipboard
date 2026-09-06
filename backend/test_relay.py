"""Protocol gate harness for the RealtimeClipboard relay.

G1-G9 exercise every M0 exit criterion. G10-G13 cover the M7 additions: peer
identity, targeted forwarding of WebRTC signalling, and the relay-chunk file
fallback (FR-7.6). G14 covers the M8 locked-session admission token.
Usage:  python test_relay.py [base_url]      e.g. ws://127.0.0.1:8000
"""

import asyncio
import json
import sys
import time

import websockets
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8000"
HTTP = BASE.replace("wss://", "https://").replace("ws://", "http://")

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    return ok


async def recv(sock, timeout=5.0):
    return json.loads(await asyncio.wait_for(sock.recv(), timeout))


async def recv_data(sock, timeout=5.0):
    """Next frame that isn't presence noise — peers frames are async and unordered
    relative to clips, so tests that care about payloads must skip them."""
    while True:
        m = json.loads(await asyncio.wait_for(sock.recv(), timeout))
        if m.get("t") != "peers":
            return m


async def send(sock, obj):
    await sock.send(json.dumps(obj))


async def hello(sock, origin, name, intent="join"):
    await send(sock, {"t": "hello", "intent": intent, "originId": origin, "name": name})


async def drain(sock, timeout=0.4):
    """Everything the socket has to offer inside `timeout`. Empty list == silence."""
    out = []
    try:
        while True:
            out.append(json.loads(await asyncio.wait_for(sock.recv(), timeout)))
    except asyncio.TimeoutError:
        return out


async def last_peers(sock, timeout=0.4):
    """The most recent presence frame — one arrives per hello, we want the final."""
    frames = [m for m in await drain(sock, timeout) if m.get("t") == "peers"]
    return frames[-1] if frames else {}


async def main():
    room = f"m0test{int(time.time())}"
    url = f"{BASE}/ws/{room}"

    print(f"\nRelay: {BASE}\nRoom:  {room}\n")

    # --- G1: WebSocket upgrade succeeds (OI-1, the blocker) -------------
    print("G1  WebSocket upgrade")
    t0 = time.monotonic()
    try:
        a = await asyncio.wait_for(websockets.connect(url), timeout=30)
        connect_ms = (time.monotonic() - t0) * 1000
        check("upgrade accepted", True, f"{connect_ms:.0f} ms")
    except Exception as e:
        check("upgrade accepted", False, f"{type(e).__name__}: {e}")
        return summarise()

    w = await recv(a)
    check("welcome frame", w.get("t") == "welcome", json.dumps(w)[:120])
    check("instance id present", bool(w.get("instance")), w.get("instance", ""))
    check("create on empty room: existing == 0", w.get("existing") == 0)

    # --- G2: two peers exchange a string --------------------------------
    print("\nG2  Two-peer exchange")
    b = await websockets.connect(url)
    wb = await recv(b)
    check("second peer welcomed", wb.get("t") == "welcome")
    check("collision signal: existing == 1", wb.get("existing") == 1,
          "an auto-generated key landing here would regenerate (OI-2)")

    pa = await recv(a)   # peers broadcast from b joining
    check("peer count broadcast", pa.get("t") == "peers" and pa.get("count") == 2,
          json.dumps(pa))

    t0 = time.monotonic()
    await send(a, {"t": "clip", "payload": "Y2lwaGVydGV4dA==", "iv": "aXYxMjM=",
                   "originId": "peerA"})
    got = await recv_data(b)
    hop_ms = (time.monotonic() - t0) * 1000
    check("A -> B delivered", got.get("t") == "clip" and got.get("payload") == "Y2lwaGVydGV4dA==",
          f"{hop_ms:.1f} ms")
    check("seq assigned by relay", got.get("seq") == 1, f"seq={got.get('seq')}")

    # --- G3: sender exclusion (loop prevention, FR-3.2) -----------------
    print("\nG3  Sender exclusion")
    try:
        echo = await recv_data(a, timeout=1.0)
        check("sender not echoed", False, f"got {json.dumps(echo)[:80]}")
    except asyncio.TimeoutError:
        check("sender not echoed", True)

    # --- G4: bidirectional ----------------------------------------------
    print("\nG4  Reverse direction")
    await send(b, {"t": "clip", "payload": "YmFja3dhcmRz", "iv": "aXY0NTY=",
                   "originId": "peerB"})
    got = await recv_data(a)
    check("B -> A delivered", got.get("payload") == "YmFja3dhcmRz")
    check("seq incremented", got.get("seq") == 2, f"seq={got.get('seq')}")

    # --- G5: last-clip replay to a late joiner (FR-3.3) -----------------
    print("\nG5  Late joiner replay")
    c = await websockets.connect(url)
    wc = await recv(c)
    last = wc.get("last") or {}
    check("late joiner gets last clip", last.get("payload") == "YmFja3dhcmRz",
          json.dumps(last)[:100])
    check("three peers reported", wc.get("peers") == 3, f"peers={wc.get('peers')}")
    await c.close()

    # --- G6: heartbeat (FR-3.6) -----------------------------------------
    print("\nG6  Heartbeat")
    await send(a, {"t": "ping"})
    m = await recv_data(a)
    check("ping -> pong", m.get("t") == "pong", json.dumps(m)[:80])

    # --- G7: size cap (FR-2.8) -------------------------------------------
    print("\nG7  Limits")
    await send(a, {"t": "clip", "payload": "x" * 40000, "iv": "aXY=", "originId": "peerA"})
    m = await recv_data(a)
    check("32 KB cap enforced", m.get("code") == "TOO_LARGE", json.dumps(m)[:80])
    check("connection survives oversize frame", a.state.name == "OPEN", a.state.name)

    # --- G8: rate limit ---------------------------------------------------
    for i in range(15):
        await send(a, {"t": "clip", "payload": "eA==", "iv": "aXY=", "originId": "peerA"})
    limited = False
    try:
        for _ in range(20):
            m = await recv(a, timeout=1.0)
            if m.get("code") == "RATE_LIMITED":
                limited = True
                break
    except asyncio.TimeoutError:
        pass
    check("rate limit enforced", limited)

    await a.close()
    await b.close()

    # --- G9: /health (OI-3) ----------------------------------------------
    print("\nG9  Health endpoint")
    # Cloudflare fronts FastAPI Cloud and 403s the default "Python-urllib/3.x"
    # User-Agent. The relay itself is fine — curl and browsers get through.
    req = urllib.request.Request(
        f"{HTTP}/health",
        headers={"User-Agent": "Mozilla/5.0 (compatible; realtimeclipboard-test/1.0)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            h = json.loads(r.read())
        check("/health reachable", h.get("ok") is True, json.dumps(h))
        check("instance id stable", h.get("instance") == w.get("instance"),
              f"ws={w.get('instance')} http={h.get('instance')}")
    except Exception as e:
        check("/health reachable", False, f"{type(e).__name__}: {e}")

    # --- G10-G13: P2P plumbing (M7) ---------------------------------------
    # A fresh room: the M0 connections above are deliberately left rate limited.
    await p2p(f"{BASE}/ws/{room}p2p")

    # --- G14: locked-session admission (M8) --------------------------------
    await admission(f"{BASE}/ws/{room}lock")

    return summarise()


async def admission(url):
    """The locked-session admission token (PRD §7.5, D11).

    Worth being clear about what this gate is for, because the test would
    otherwise look like it is proving more than it is. A locked room's NAME is
    already derived from the PIN, so a client without it addresses a different
    room and never arrives here to be refused. This check exists to catch a
    client whose room derivation and key derivation disagree — a bug, which
    would otherwise present as a session that connects and then reads nothing.
    """
    print("\nG14  Locked-session admission")

    first = await websockets.connect(f"{url}?a=deadbeefcafe")
    w = await recv(first)
    check("a token-bearing peer is welcomed into an empty room",
          w.get("t") == "welcome" and w.get("existing") == 0, json.dumps(w)[:100])

    same = await websockets.connect(f"{url}?a=deadbeefcafe")
    w2 = await recv(same)
    check("a matching token joins the same room",
          w2.get("t") == "welcome" and w2.get("existing") == 1, json.dumps(w2)[:100])

    wrong = await websockets.connect(f"{url}?a=0000000000")
    m = await recv(wrong)
    check("a mismatched token is refused", m.get("code") == "AUTH_FAILED", json.dumps(m))
    check("and the refusal says nothing about the right one",
          "a" not in m and "auth" not in m, json.dumps(m))

    none = await websockets.connect(url)
    m2 = await recv(none)
    check("so is no token at all, once the room has one",
          m2.get("code") == "AUTH_FAILED", json.dumps(m2))

    # The open-session path must be completely unaffected: no token in, none
    # expected, and a second peer with no token joins normally.
    plain = await websockets.connect(f"{url}open")
    wp = await recv(plain)
    plain2 = await websockets.connect(f"{url}open")
    wp2 = await recv(plain2)
    check("an untokened room still admits untokened peers",
          wp.get("existing") == 0 and wp2.get("existing") == 1,
          "open sessions are unchanged")

    for sock in (first, same, wrong, none, plain, plain2):
        await sock.close()


async def p2p(url):
    """Peer identity, targeted forwarding, and the relay-chunk file fallback."""

    # --- G10: identity and presence --------------------------------------
    print("\nG10  Peer identity")
    p = await websockets.connect(url)
    wp = await recv(p)
    check("welcome carries own peerId as `you`",
          isinstance(wp.get("you"), str) and bool(wp.get("you")), f"you={wp.get('you')}")
    check("welcome still carries existing + peers (M0 clients)",
          wp.get("existing") == 0 and wp.get("peers") == 1, json.dumps(wp)[:120])
    check("welcome carries the roster list",
          isinstance(wp.get("list"), list) and len(wp["list"]) == wp.get("peers"),
          json.dumps(wp.get("list")))

    q = await websockets.connect(url); await recv(q)
    r = await websockets.connect(url); await recv(r)

    await hello(p, "peerP", "Chrome · Windows")
    await hello(q, "peerQ", "Firefox · Linux")
    await hello(r, "peerR", "Safari · macOS")

    roster = await last_peers(p, 0.6)
    names = {e.get("peerId"): e.get("name") for e in roster.get("list", [])}
    check("peers frame carries a list, not just a count",
          roster.get("count") == 3 and len(roster.get("list", [])) == 3,
          json.dumps(roster, ensure_ascii=False)[:160])
    check("peer list carries ids and nicknames",
          names.get("peerP") == "Chrome · Windows" and names.get("peerQ") == "Firefox · Linux"
          and names.get("peerR") == "Safari · macOS",
          json.dumps(names, ensure_ascii=False))

    await drain(q); await drain(r)

    s = await websockets.connect(url); await recv(s)
    await hello(s, "peerP", "Impostor")
    dup = [m.get("code") for m in await drain(s) if m.get("t") == "error"]
    check("duplicate originId refused, so one id means one socket",
          "PEER_ID_TAKEN" in dup, json.dumps(dup))
    await s.close()
    await drain(p); await drain(q); await drain(r)

    # --- G11: targeted signalling -----------------------------------------
    print("\nG11  Targeted signalling")
    await send(p, {"t": "rtc-offer", "to": "peerQ", "sdp": "v=0 fake", "from": "spoofed"})
    got = await recv_data(q, timeout=2.0)
    check("rtc-offer reaches the addressed peer",
          got.get("t") == "rtc-offer" and got.get("sdp") == "v=0 fake", json.dumps(got)[:120])
    check("relay stamps `from`, overriding the sender's claim",
          got.get("from") == "peerP", f"from={got.get('from')}")
    leaked = [m for m in await drain(r) if m.get("t") != "peers"]
    check("targeted frame does not leak to the rest of the room",
          leaked == [], json.dumps(leaked)[:100])

    await send(q, {"t": "rtc-answer", "to": "peerP", "sdp": "v=0 answer"})
    await send(q, {"t": "rtc-ice", "to": "peerP", "cand": "candidate:1 1 udp"})
    kinds = [m.get("t") for m in await drain(p) if m.get("t") != "peers"]
    check("rtc-answer and rtc-ice forward the same way",
          kinds == ["rtc-answer", "rtc-ice"], json.dumps(kinds))

    await send(p, {"t": "rtc-offer", "to": "peerNOBODY", "sdp": "v=0"})
    m = await recv_data(p, timeout=2.0)
    check("NO_SUCH_PEER for an unknown target", m.get("code") == "NO_SUCH_PEER",
          json.dumps(m)[:100])
    await send(p, {"t": "rtc-ice", "cand": "candidate:2 1 udp"})
    m = await recv_data(p, timeout=2.0)
    check("NO_SUCH_PEER when `to` is missing entirely",
          m.get("code") == "NO_SUCH_PEER" and m.get("to") is None, json.dumps(m)[:100])
    check("connection survives a bad target", p.state.name == "OPEN", p.state.name)

    # --- G12: file frames --------------------------------------------------
    print("\nG12  File frames")
    await send(p, {"t": "file-meta", "id": "f1", "name": "shot.png", "size": 4200000,
                   "thumb": "dGh1bWJuYWls", "originId": "peerP"})
    gq = await recv_data(q, timeout=2.0)
    gr = await recv_data(r, timeout=2.0)
    check("file-meta broadcasts to the room",
          gq.get("t") == "file-meta" and gq.get("id") == "f1" and gr.get("id") == "f1",
          json.dumps(gq)[:120])
    echo = [m for m in await drain(p) if m.get("t") != "peers"]
    check("file-meta is not echoed to its sender", echo == [], json.dumps(echo)[:100])

    await send(q, {"t": "file-req", "id": "f1", "to": "peerP", "originId": "peerQ"})
    req = await recv_data(p, timeout=2.0)
    check("file-req reaches only its target",
          req.get("t") == "file-req" and req.get("from") == "peerQ", json.dumps(req)[:120])
    leaked = [m for m in await drain(r) if m.get("t") != "peers"]
    check("file-req does not reach the rest of the room", leaked == [], json.dumps(leaked)[:100])

    # The accept/deny handshake, completion marker and abort paths the client
    # actually emits (src/files/transfer.js). Any one of these coming back as
    # UNKNOWN_TYPE strands a transfer half-open.
    control = ["file-accept", "file-deny", "file-done", "file-ok", "file-cancel", "file-error"]
    for t in control:
        await send(q, {"t": t, "id": "f1", "to": "peerP", "reason": "test"})
    fwd = [m.get("t") for m in await drain(p) if m.get("t") != "peers"]
    check("transfer control frames all forward", fwd == control, json.dumps(fwd))

    # --- G13: relay-chunk fallback (FR-7.6) --------------------------------
    print("\nG13  Relay-chunk fallback")
    CHUNKS = 160          # a 5 MB file at the 32 KB frame cap — P2P-FILES §5
    t0 = time.monotonic()
    for i in range(CHUNKS):
        await send(p, {"t": "file-chunk", "to": "peerQ", "id": "f1", "seq": i,
                       "iv": "aXY=", "data": "Y2h1bms="})
    got = 0
    try:
        while got < CHUNKS:
            if (await recv(q, timeout=5.0)).get("t") == "file-chunk":
                got += 1
    except asyncio.TimeoutError:
        pass
    ms = (time.monotonic() - t0) * 1000
    check("a whole 5 MB file's worth of chunks is delivered",
          got == CHUNKS, f"{got}/{CHUNKS} in {ms:.0f} ms")
    errs = [m.get("code") for m in await drain(p) if m.get("t") == "error"]
    check("bulk transfer is not rate limited", errs == [], json.dumps(errs[:3]))

    for i in range(520):  # past the 400/s bulk bound
        await send(p, {"t": "file-chunk", "to": "peerQ", "id": "f2", "seq": i,
                       "iv": "aXY=", "data": "Y2h1bms="})
    codes = [m.get("code") for m in await drain(p, 1.0) if m.get("t") == "error"]
    check("bulk is still bounded — a runaway sender is throttled",
          "RATE_LIMITED" in codes, f"{len(codes)} of 520 limited")
    await drain(q, 1.0)

    await send(p, {"t": "file-chunk", "to": "peerQ", "id": "f3", "seq": 0,
                   "iv": "aXY=", "data": "x" * 40000})
    codes = [m.get("code") for m in await drain(p)]
    check("32 KB cap still applies to file-chunk", "TOO_LARGE" in codes, json.dumps(codes[:3]))

    # The other side of that cap: a chunk sized the way the client sizes it
    # (src/files/chunker.js RELAY_CHUNK_BYTES) must fit. 32 KB is the budget for
    # the whole encoded frame, not for the bytes inside it.
    skeleton = {"t": "file-chunk", "to": "peerQ", "id": "f4", "originId": "peerP",
                "seq": 288, "total": 289, "crc": 4294967295,
                "iv": "YWJjZGVmZ2hpamtsbW5v", "b64": ""}
    full = dict(skeleton, b64="A" * (32 * 1024 - len(json.dumps(skeleton)) - 8))
    wire = len(json.dumps(full).encode())
    await send(p, full)
    got = await recv_data(q, timeout=2.0)
    check("a full-size relay chunk fits under the cap",
          got.get("t") == "file-chunk" and got.get("seq") == 288,
          f"{wire} B frame delivered")

    await send(p, {"t": "rtc-bogus", "to": "peerQ"})
    codes = [m.get("code") for m in await drain(p)]
    check("unknown types are still rejected", "UNKNOWN_TYPE" in codes, json.dumps(codes[:3]))

    await p.send("[]")    # valid JSON, not a frame
    codes = [m.get("code") for m in await drain(p)]
    check("non-object JSON is an error, not a disconnect",
          "BAD_JSON" in codes and p.state.name == "OPEN", f"{p.state.name} {codes[:2]}")

    for sock in (p, q, r):
        await sock.close()


def summarise():
    print("\n" + "=" * 62)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"RELAY GATE (M0 + M7 + M8): {passed}/{total} checks passed")
    for name, ok, detail in results:
        if not ok:
            print(f"   FAILED: {name}  {detail}")
    print("=" * 62)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
