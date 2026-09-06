# backend/

The relay. A separate deployment that **shares no code with the frontend** — only the protocol in
`docs/PRD.md` §6. Changing a frame shape means changing it in two places, on purpose: two
independent implementations of one written spec, rather than a shared library that hides drift.

## The property the whole product rests on

**The relay learns nothing.** It sees a room hash and ciphertext, keeps neither beyond the last
clip of a live room in RAM, and is never told anything about the visitor. No database, no disk, no
logging of clip content.

Any change that widens that has to argue for itself in `docs/PRD.md` before it is written here.
It is not a performance decision or a storage decision — it is the reason the honest answer to "can
the server read my clipboard" is no.

## Rules

- **In-memory only.** No database, no Redis, no disk. A room evicts 10 minutes after the last
  device leaves.
- **One clip is retained per room** and replayed to whoever joins next (`room.last`). Two features
  depend on this: the last-clip replay users expect, and the lock beacon that proves a joiner
  derived the right room. Changing the retention breaks both.
- **Deploying with replicas requires pinning**, or two devices in one room land on different
  instances and never see each other. See `README.md` — that step is not optional.
- Both test gates take a base URL, so the same suite runs against localhost or a deployed relay.

```bash
python test_relay.py ws://127.0.0.1:8000     # protocol
python test_sse.py http://127.0.0.1:8000     # the SSE + POST fallback
python test_policy.py                        # the REALTIMECLIPBOARD_* flags, each on its own relay
python test_shared.py                        # cross-replica behaviour, against a fake Redis
python test_idle.py ws://127.0.0.1:8000 5    # run against a DEPLOYED relay — nothing local reaps idle connections
```

`test_policy.py` and `test_shared.py` exist for the same reason: **a flag that
silently does nothing looks exactly like a flag that works**, and code that only
runs with two replicas is code nothing else executes. `REALTIMECLIPBOARD_MAX_SESSION` was
read at startup and referenced by nothing for its whole life; the roster and
replay helpers in `shared.py` had no callers at all. Anything added to either
category needs a check here, or it will be discovered the same way.
