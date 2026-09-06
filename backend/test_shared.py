"""
Cross-replica behaviour — PRD OI-3, against an in-process fake Redis.

test_relay.py and test_policy.py run one process. This one runs the code that
only matters when there are two, and it exists because that code shipped
half-written: the roster helpers and the replay getter had no callers at all,
targeted frames were never published, and a subscription that died stayed
registered so the room could never come back.

A fake rather than a real server, deliberately. What is being checked is this
module's own logic — envelopes, instance filtering, roster merging, recovery —
not whether redis-py can talk to Redis.

  python test_shared.py
"""

import asyncio
import sys

import shared as shared_mod

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")


class FakePubSub:
    def __init__(self, bus):
        self.bus, self.queue, self.channels = bus, asyncio.Queue(), set()

    async def subscribe(self, channel):
        self.channels.add(channel)
        self.bus.setdefault(channel, []).append(self)

    async def unsubscribe(self, channel):
        self.channels.discard(channel)
        if self in self.bus.get(channel, []):
            self.bus[channel].remove(self)

    async def listen(self):
        while True:
            yield await self.queue.get()

    async def aclose(self):
        for c in list(self.channels):
            await self.unsubscribe(c)


class FakeRedis:
    """Enough of redis-py for this module. Shared by every 'replica'."""

    def __init__(self, store, bus):
        self.store, self.bus = store, bus
        self.fail = False

    async def ping(self):
        if self.fail:
            raise ConnectionError("fake redis is down")
        return True

    async def publish(self, channel, data):
        if self.fail:
            raise ConnectionError("fake redis is down")
        for ps in list(self.bus.get(channel, [])):
            await ps.queue.put({"type": "message", "data": data})

    def pubsub(self):
        return FakePubSub(self.bus)

    async def set(self, key, value, ex=None):
        self.store[key] = value

    async def get(self, key):
        return self.store.get(key)

    async def hset(self, key, field, value):
        self.store.setdefault(key, {})[field] = value

    async def hdel(self, key, field):
        self.store.get(key, {}).pop(field, None)

    async def hgetall(self, key):
        return dict(self.store.get(key, {}))

    async def expire(self, key, ttl):
        return True

    async def aclose(self):
        return None


def backend(store, bus, instance):
    b = shared_mod.Backend("redis://fake", instance)
    b.enabled = True
    b._redis = FakeRedis(store, bus)
    b.healthy = True
    return b


async def main():
    store, bus = {}, {}
    a = backend(store, bus, "replica-A")
    b = backend(store, bus, "replica-B")

    # ---- fan-out --------------------------------------------------------
    print("\nFan-out across replicas\n")
    # deliver() is awaited by the pump — main.py's _deliver_remote is an async
    # function, and a sync stand-in here would only be testing a fake.
    got_b = []

    async def collect_b(frame, to=None):
        got_b.append((frame, to))

    await b.subscribe("room1", collect_b)
    await asyncio.sleep(0.05)

    await a.publish("room1", '{"t":"clip"}')
    await asyncio.sleep(0.05)
    check("a frame from one replica reaches the other", got_b == [('{"t":"clip"}', None)],
          str(got_b))

    got_b.clear()
    await b.publish("room1", '{"t":"clip","n":2}')
    await asyncio.sleep(0.05)
    check("...but never echoes back to the replica that sent it", got_b == [], str(got_b))

    # ---- targeted -------------------------------------------------------
    print("\nTargeted frames (rtc-*, file-*)\n")
    got_b.clear()
    await a.publish("room1", '{"t":"file-req"}', to="peerZ")
    await asyncio.sleep(0.05)
    check("a targeted frame crosses replicas at all",
          got_b == [('{"t":"file-req"}', "peerZ")],
          "these were never published, so a transfer failed on the pod boundary")
    check("...and carries the peer it is for", got_b and got_b[0][1] == "peerZ")

    # ---- replay ---------------------------------------------------------
    print("\nLate-join replay (FR-3.3)\n")
    await a.set_last("room1", '{"t":"clip","payload":"x"}', 600)
    check("a clip stored on one replica is readable from the other",
          await b.get_last("room1") == '{"t":"clip","payload":"x"}',
          "get_last had no callers, so a joiner on the other pod replayed nothing")

    # ---- roster ---------------------------------------------------------
    print("\nRoom-wide roster\n")
    await a.add_peer("room1", "peerA", "laptop", 600)
    await b.add_peer("room1", "peerB", "phone", 600)

    remote_from_b = await b.remote_peers("room1")
    check("each replica sees the OTHER's peers",
          [p["id"] for p in remote_from_b] == ["peerA"], str(remote_from_b))
    check("...and not its own, which it already counts",
          all(p["id"] != "peerB" for p in remote_from_b), str(remote_from_b))
    check("names travel with them", remote_from_b and remote_from_b[0]["name"] == "laptop")

    await a.drop_peer("room1", "peerA")
    check("a departure clears the shared entry",
          await b.remote_peers("room1") == [], str(await b.remote_peers("room1")))

    # ---- degradation and recovery ---------------------------------------
    print("\nRedis goes away, and comes back\n")
    a._redis.fail = True
    await a.publish("room1", '{"t":"clip"}')
    check("a publish against a dead server does not raise", True,
          "it used to propagate out of _join, past a peer already inserted")
    check("...and the backend records that it is degraded", a.healthy is False)
    check("...which /health can report", a.enabled and not a.healthy)

    # A degraded publish is dropped rather than queued; the point is that the
    # request path survived it.
    got_b.clear()
    await a.publish("room1", '{"t":"clip"}')
    check("a degraded replica stops publishing rather than raising", got_b == [])

    # ---- a dead subscription can be rebuilt -----------------------------
    print("\nA dead subscription is not permanent\n")
    async def noop(frame, to=None):
        return None

    c = backend(store, bus, "replica-C")
    await c.subscribe("room2", noop)
    await asyncio.sleep(0.05)
    check("a room is registered once subscribed", "room2" in c._tasks)
    check("...and remembered, so a recovery knows to rebuild it", "room2" in c._subscribers,
          "without this the dead task stayed registered and the room never came back")

    c._tasks.pop("room2").cancel()
    await asyncio.sleep(0.05)
    got_c = []

    async def collect_c(frame, to=None):
        got_c.append(frame)

    await c.subscribe("room2", collect_c)
    await asyncio.sleep(0.05)
    a.healthy = True
    a._redis.fail = False
    await a.publish("room2", '{"t":"clip","again":1}')
    await asyncio.sleep(0.05)
    check("resubscribing to the same room works", got_c == ['{"t":"clip","again":1}'], str(got_c))

    await a.close()
    await b.close()
    await c.close()
    check("close() leaves nothing registered",
          not a._tasks and not a._subscribers and not a.healthy)

    print("\n" + "=" * 56)
    print(f"SHARED: {passed}/{passed + failed} passed")
    print("=" * 56)
    sys.exit(1 if failed else 0)


asyncio.run(main())
