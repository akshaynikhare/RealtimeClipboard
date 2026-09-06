"""
The shared backend that makes more than one replica safe — PRD OI-3.

Room state is a process-local dict. That is the right design for one process and
the wrong one for two: with two replicas and no shared state, two devices can
join the same room name, land on different processes, and never see each other.
It does not error. It presents as "sync just silently doesn't work",
intermittently and only under load, which is the worst way to find out.

This module is the answer, and it is deliberately the smallest one that works.

  What it shares      every frame the room fans out, the last clip for replay,
                      and the roster.
  What it stores      nothing durable. Pub/sub is fire-and-forget, and the two
                      keys carry the room's TTL, so a Redis restart costs open
                      sessions and nothing else. No persistence, no AOF, no
                      backups — a cache-class instance is the right shape.
  What it never sees  plaintext. Frames are already ciphertext produced in a
                      browser (PRD §7.3); Redis holds exactly what the relay
                      holds, which is nothing readable.

OFF BY DEFAULT. With REALTIMECLIPBOARD_REDIS_URL unset this module is inert and the relay
behaves exactly as it did before it existed — same code path, same in-memory
dict. That matters because the single-process deployment is the common one and
must not pay for a feature it does not use.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os

# redis is an optional dependency FROM SOURCE: a self-hoster running one replica
# should not have to install it, and an import error at startup for a feature
# nobody asked for is a worse outage than the feature being unavailable.
#
# The published image installs it regardless (backend/Dockerfile), because the
# Helm chart tells operators that redis.enabled makes replicas safe and then
# deploys that image — an image that cannot import redis turns that promise into
# the split-brain it was written to prevent.
try:
    import redis.asyncio as aioredis
except ImportError:                                       # pragma: no cover
    aioredis = None

REDIS_URL = os.getenv("REALTIMECLIPBOARD_REDIS_URL", "") or None


class Backend:
    """Cross-replica fan-out. Inert unless a Redis URL was configured."""

    def __init__(self, url: str | None, instance: str) -> None:
        self.instance = instance
        self.enabled = bool(url) and aioredis is not None
        # Whether the connection is actually working RIGHT NOW, as opposed to
        # configured. `enabled` stayed true through a failed ping, so every
        # publish raised — out of _announce_peers, out of _join, past the peer
        # that had already been inserted into the room, leaking its roster entry
        # and its per-address connection count. Health is a separate question
        # from configuration and now has a separate answer.
        self.healthy = False
        self._url = url
        self._redis = None
        self._pubsub = None
        self._tasks: dict[str, asyncio.Task] = {}
        self._subscribers: dict[str, object] = {}
        self._reconnecting: asyncio.Task | None = None

        if url and aioredis is None:
            print("[relay] REALTIMECLIPBOARD_REDIS_URL is set but the redis package is not "
                  "installed. Running single-process — do NOT scale this deployment. "
                  "Install with: pip install 'redis>=5'")

    async def connect(self) -> None:
        if not self.enabled or self._redis is not None:
            return
        self._redis = aioredis.from_url(self._url, decode_responses=True)
        try:
            await self._redis.ping()
        except Exception:
            # Not left half-open: a live client object with a dead server is
            # what made `enabled and not healthy` indistinguishable from
            # working, and every later call raised into a request handler.
            self._redis = None
            raise
        self.healthy = True
        print(f"[relay] shared backend connected; replicas may exceed 1 "
              f"(instance {self.instance})")

    def _degrade(self, what: str, exc: Exception) -> None:
        """Record that Redis is not answering, and start trying to get it back.

        Never raises. Every caller is on a request path, and taking a live
        session down because the cross-replica bus hiccuped is a worse failure
        than the one being reported.
        """
        if self.healthy:
            print(f"[relay] shared backend degraded during {what}: {exc}")
        self.healthy = False
        if self._reconnecting is None or self._reconnecting.done():
            self._reconnecting = asyncio.create_task(self._recover())

    async def _recover(self) -> None:
        """Reconnect, then rebuild every subscription that died with the link."""
        delay = 1.0
        while not self.healthy:
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)
            try:
                if self._redis is not None:
                    with contextlib.suppress(Exception):
                        await self._redis.aclose()
                self._redis = None
                await self.connect()
            except Exception:
                continue

            # Resubscribe. A pump that died took its room off the air until the
            # room itself was evicted — there was no path back, because the
            # dead task stayed registered and subscribe() returns early when it
            # finds one.
            for room_hash, deliver in list(self._subscribers.items()):
                self._tasks.pop(room_hash, None)
                await self.subscribe(room_hash, deliver)
            print("[relay] shared backend recovered")

    # ---- fan-out --------------------------------------------------------

    async def publish(self, room_hash: str, frame: str, to: str | None = None) -> None:
        """
        Hand a frame to the other replicas.

        Stamped with this instance's id so the delivery loop below can drop its
        own echo. Without that, a two-replica deployment doubles every message
        and a three-replica one triples it.

        `to` names a single peer. Targeted frames were never published at all,
        so rtc-* and every file-* frame simply could not reach a peer on another
        replica: the sender got NO_SUCH_PEER and a transfer between two devices
        in the same room failed depending on which pod each had landed on.
        """
        if not self.enabled or not self.healthy:
            return
        try:
            await self._redis.publish(
                f"hb:{room_hash}",
                json.dumps(
                    {"o": self.instance, "f": frame, **({"to": to} if to else {})},
                    separators=(",", ":"),
                ),
            )
        except Exception as exc:
            self._degrade("publish", exc)

    async def subscribe(self, room_hash: str, deliver) -> None:
        """
        Start relaying this room's remote frames into `deliver`.

        One task per room rather than one shared task, so a room going quiet
        cleans itself up and a slow room cannot stall the others.
        """
        if not self.enabled or room_hash in self._tasks:
            return

        # Remembered so a recovery can rebuild it. Registered before the task,
        # so a pump that dies immediately is still known to be wanted.
        self._subscribers[room_hash] = deliver

        async def pump() -> None:
            pubsub = self._redis.pubsub()
            await pubsub.subscribe(f"hb:{room_hash}")
            try:
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    try:
                        envelope = json.loads(message["data"])
                    except (ValueError, TypeError):
                        continue
                    # Our own publish, coming back around.
                    if envelope.get("o") == self.instance:
                        continue
                    await deliver(envelope.get("f", ""), envelope.get("to"))
            except asyncio.CancelledError:
                raise
            except Exception as exc:                      # pragma: no cover
                # A dead subscription is a silently desynced room, which is the
                # exact failure this module exists to prevent. Say so, drop the
                # registration so a retry is possible at all, and ask for one.
                print(f"[relay] room {room_hash[:8]} lost its shared subscription: {exc}")
                self._tasks.pop(room_hash, None)
                self._degrade("subscribe", exc)
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.unsubscribe(f"hb:{room_hash}")
                with contextlib.suppress(Exception):
                    await pubsub.aclose()

        self._tasks[room_hash] = asyncio.create_task(pump())

    async def unsubscribe(self, room_hash: str) -> None:
        self._subscribers.pop(room_hash, None)
        task = self._tasks.pop(room_hash, None)
        if task:
            task.cancel()

    # ---- replay ---------------------------------------------------------
    #
    # FR-3.3: a late joiner is replayed the room's last clip. On one process
    # that is an attribute; across replicas it has to be somewhere both can see,
    # or joining "the same room" gives you a different history depending on
    # which pod the load balancer picked.

    async def set_last(self, room_hash: str, frame: str, ttl: int) -> None:
        if not self.enabled or not self.healthy:
            return
        try:
            await self._redis.set(f"hb:{room_hash}:last", frame, ex=ttl)
        except Exception as exc:
            self._degrade("set_last", exc)

    async def get_last(self, room_hash: str) -> str | None:
        if not self.enabled or not self.healthy:
            return None
        try:
            return await self._redis.get(f"hb:{room_hash}:last")
        except Exception as exc:
            self._degrade("get_last", exc)
            return None

    # ---- roster ---------------------------------------------------------
    #
    # The peer count is on screen, and "2 devices" when there are three is worse
    # than no number at all — it is the number someone checks to confirm their
    # other laptop actually joined.

    async def add_peer(self, room_hash: str, peer_id: str, name: str, ttl: int) -> None:
        if not self.enabled or not self.healthy:
            return
        key = f"hb:{room_hash}:peers"
        try:
            await self._redis.hset(key, peer_id, json.dumps({"name": name, "i": self.instance}))
            await self._redis.expire(key, ttl)
        except Exception as exc:
            self._degrade("add_peer", exc)

    async def drop_peer(self, room_hash: str, peer_id: str) -> None:
        if not self.enabled or not self.healthy:
            return
        try:
            await self._redis.hdel(f"hb:{room_hash}:peers", peer_id)
        except Exception as exc:
            self._degrade("drop_peer", exc)

    async def remote_peers(self, room_hash: str) -> list[dict]:
        """Peers held by the OTHER replicas. This one already knows its own."""
        if not self.enabled or not self.healthy:
            return []
        try:
            raw = await self._redis.hgetall(f"hb:{room_hash}:peers")
        except Exception as exc:
            self._degrade("remote_peers", exc)
            return []
        out = []
        for peer_id, blob in raw.items():
            try:
                entry = json.loads(blob)
            except ValueError:
                continue
            if entry.get("i") == self.instance:
                continue
            out.append({"id": peer_id, "name": entry.get("name", ""), "mode": ""})
        return out

    async def close(self) -> None:
        if self._reconnecting is not None:
            self._reconnecting.cancel()
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()
        self._subscribers.clear()
        self.healthy = False
        if self._redis is not None:
            await self._redis.aclose()
