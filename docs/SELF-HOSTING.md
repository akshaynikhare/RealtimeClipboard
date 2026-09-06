# Running RealtimeClipboard yourself

For anyone who wants the relay inside their own network — a homelab, or an
organisation. It is one Python file with no database, so this is shorter than
you are expecting.

---

## 1. The relay

```bash
docker run -p 8000:8000 ghcr.io/akshaynikhare/realtimeclipboard-relay
```

That is a working relay. It holds ciphertext in RAM, writes nothing to disk, and
has no dependencies beyond Python.

For a real deployment you need TLS, and not for the usual reason: the app is
served over HTTPS, so a browser **refuses** a `ws://` connection from it as mixed
content. A relay without a certificate only works on localhost.

```bash
cd deploy
REALTIMECLIPBOARD_DOMAIN=relay.example.com docker compose up -d
```

Caddy obtains and renews the certificate itself. Point the app at the relay under
**Settings → Relay**, or hand people a link with `?relay=relay.example.com`.

For Kubernetes there is a chart in [`deploy/helm/`](../deploy/helm).

---

## 2. ⚠️ Pin replicas to 1, or turn on Redis

Room state is a process-local dict. With two replicas and no shared backend, two
devices can join the same room name, land on different processes, and **never see
each other**.

It does not error. It presents as "sync just silently doesn't work",
intermittently, and only under load — which is the worst possible way to find out
about it. This is PRD **OI-3**.

You get one of two safe configurations:

| | |
|---|---|
| **One replica** | The default. Correct, and fine for a few hundred users. |
| **Many replicas + Redis** | Set `REALTIMECLIPBOARD_REDIS_URL`. Frames, the replayed last clip and the roster then travel between processes. |

The Helm chart **refuses to render** `replicaCount > 1` unless `redis.enabled` is
true, because a comment is something a hurried operator can not-read.

Two safety nets back that up: `GET /health` returns an `instance` id, and the
client compares it across reconnects and shows a red split-brain banner if it ever
changes. **If your users report that banner, this section is why.**

The Redis it wants is cache-class: pub/sub and two short-TTL keys. No persistence,
no AOF, no backups — nothing durable is ever written. Install the extra with
`pip install -r requirements-ha.txt`.

---

## 3. Point the app at it

Three ways, in the order the app resolves them:

1. **`?relay=` in the address** — `https://…/app.html?relay=relay.example.com`.
   Best for deployment: an MSI transform, a macOS configuration profile, or a
   bookmark pushed by policy. The app remembers it, so the flag is needed once.
2. **Settings → Relay** — for a person setting up their own.
3. **The build default** — `DEFAULT_RELAY_URL` in
   [`src/core/config.js`](../src/core/config.js), if you host the frontend too.

> **You must also edit the Content-Security-Policy.** Every page pins
> `connect-src` to the relay it was built against, so a client pointed at a
> different one will load and then refuse every connection. Change the
> `connect-src` origins in `index.html`, `app.html` and every page under
> `src/pages/` to match. `tests/unit/static-check.mjs` asserts they agree with
> `config.js`, so you will be told if you miss one.
>
> This is deliberate, not friction for its own sake. A build that can physically
> reach only your relay is a property worth having.

## Serve it from an origin root, not a subpath

`https://clip.example.com/` works. `https://example.com/clip/` does not.

The pages under `src/pages/` are published one level above where they sit on disk, so every link
in them is root-absolute — and a root-absolute link cannot be correct under a path prefix.
`src/core/paths.js` resolves the app root the same way, and `sw.js` has to stay at the root or its
scope shrinks to a subdirectory and offline support disappears with nothing throwing.

This used to work, on GitHub Pages at `user.github.io/RealtimeClipboard/`. If you need it back, the
change is `new URL("/", …)` → `new URL(".", …)` in `paths.js` plus converting `src/pages/` back to
relative links — but the two link styles cannot coexist, which is why only one is supported.

---

## 4. Policy

Every flag defaults to the hosted relay's behaviour, so an unconfigured relay is
exactly the relay described above.

| Variable | Default | What it does |
|---|---|---|
| `REALTIMECLIPBOARD_CORS_ORIGINS` | `*` | Comma-separated allowlist. Safe as `*` only because there are no credentials anywhere in this design; pin it anyway. |
| `REALTIMECLIPBOARD_JOIN_TOKEN` | none | A shared secret every client must present as `?org=…`. **A door on the relay, not user authentication** — see below. |
| `REALTIMECLIPBOARD_DISABLE_FILES` | off | Refuses WebRTC signalling and all file frames. Clipboard text is unaffected. |
| `REALTIMECLIPBOARD_MAX_SESSION` | `0` | Hard cap in seconds on a room's lifetime. |
| `REALTIMECLIPBOARD_MAX_PEERS` | `8` | Devices per room. |
| `REALTIMECLIPBOARD_ROOM_TTL` | `600` | Seconds a room survives after its last peer leaves. |
| `REALTIMECLIPBOARD_REDIS_URL` | none | Shared backend. See §2. |
| `REALTIMECLIPBOARD_MAX_FRAME_BYTES` | `32768` | Protocol limit. Changing it desynchronises you from stock clients. |
| `REALTIMECLIPBOARD_TRUSTED_PROXIES` | `*` | Which immediate peers may set `CF-Connecting-IP` / `X-Forwarded-For`. **Set this if your relay is reachable directly** — see below. |
| `REALTIMECLIPBOARD_REQUIRE_SHARED` | on | Whether an unreachable `REALTIMECLIPBOARD_REDIS_URL` is fatal at startup. Leave it on. |

`backend/test_policy.py` is the gate for these. Run it after changing any of
them — a flag that silently does nothing looks exactly like a flag that works,
and an operator who sets `REALTIMECLIPBOARD_DISABLE_FILES` and sees no error has every
reason to believe files are disabled.

**On `REALTIMECLIPBOARD_JOIN_TOKEN`.** Everyone in your organisation holds the same value.
It says *"you may use this relay"*, never *"you may read this room"* — the session
key is still the only thing that decrypts anything. Its job is to stop an internal
deployment being an open relay for anyone who learns the hostname. It travels as a
query parameter because browsers cannot set headers on a WebSocket or an
EventSource, so treat it as a deployment secret, not a credential: it will appear
in proxy logs.

Each device is given the token **once**, and then remembers it:

```
https://your-app.example/app?org=YOUR_TOKEN          # web, desktop — stored per device
REALTIMECLIPBOARD_ORG=YOUR_TOKEN realtimeclipboard watch D75LV       # CLI, MCP server
```

It is deliberately **not** in share links. A link gets pasted into chats and read
off screens; this is the value that admits a device to your deployment, and the
two do not belong in the same string. A device that has not been given one is
refused with `ORG_TOKEN_REQUIRED` rather than failing silently.

**On `REALTIMECLIPBOARD_TRUSTED_PROXIES`.** The relay counts live connections per source
address, and it learns that address from `CF-Connecting-IP` or `X-Forwarded-For`.
Those headers are facts only when something you control sets them. If your relay
can be reached directly — not only through your proxy — a client can put any
address it likes in there: not merely to evade its own limit, but to fill
*somebody else's* bucket and lock a real user out. Name your proxy's address, or
put the relay somewhere only the proxy can reach.

The default is `*` because the hosted deployment sits behind Cloudflare, where
every connection genuinely arrives from an edge address and distrusting the
header would put every user in one bucket.

---

## 5. For a security review

The questions that get asked, and the honest answers.

**Where does clipboard data go?** To the relay you are running, as AES-GCM
ciphertext produced in the browser, and out again to the other devices sharing the
key. The relay cannot decrypt it: it holds a room hash and a payload, and neither
the key nor the PIN is ever transmitted (PRD §7.3, `src/core/crypto.js`).

**What is written to disk?** Nothing, on the relay. Room state is a dict, the last
clip is a string in RAM, and both die with the process or after the room TTL. The
container declares no volume. On a client, only preferences — never clip content.

**What egress does it need?** One hostname, port 443, outbound. That is it.
WebSocket first, falling back to SSE + POST on the same host if a TLS-inspecting
proxy eats the upgrade. Peer-to-peer file transfer additionally attempts UDP via
STUN, which corporate networks routinely block; it falls back to relaying the
chunks, visibly labelled — or set `REALTIMECLIPBOARD_DISABLE_FILES` and remove the question.

**Can you produce an audit log?** Of metadata, yes: joins, room hashes,
timestamps, peer counts. Not of content, because the relay provably cannot read
it. That is the stronger position and worth stating plainly rather than
apologising for.

**Is the client auditable?** Yes, and deliberately so. The deployed JavaScript is
minified but **not obfuscated**, and it ships with source maps. For a product
whose entire claim is "we cannot read your clipboard", being checkable is the
claim.

**What about the desktop app?** It watches the system clipboard continuously —
that is what it is for, and it is a materially larger thing to agree to than a
browser tab. It ships set to **Manual** for that reason: nothing leaves the
machine until the user sends it. It writes nothing to disk beyond its settings, it
needs no administrator rights, and it installs no service or driver.

**The honest caveat.** The share key is a bearer credential. Anyone who learns it
can read that session while it is open. Locked sessions add a PIN that never
travels in the link and is never sent to the relay — for a shared or high-value
session, use one.

---

## 6. What this is not

Not SSO, not user accounts, not per-user access control. Adding those would
contradict the thing that makes the product work — you open a page, type five
characters, and it works, with no directory to be in.

If your requirement is genuinely "only these named employees, authenticated
against our IdP", this is the wrong tool and you should say so early rather than
bolting an identity system onto something designed around not having one.
