# cli/

One file, and how little of it there is *is* the design.

It imports the same modules the browser runs — `core/crypto.js`, `core/keys.js`,
`transport/relay.js` — because none of them ever touched `window` or `document`, and Node has had
`WebSocket`, `fetch` and `crypto.subtle` as globals since 22. The heartbeat, the jittered reconnect
backoff, the WebSocket→SSE failover and the encryption all come for free and cannot drift, because
there is nothing here to drift.

## The one rule

**Nothing in this file may reimplement a protocol detail.** If something is missing, it belongs in
`src/` where both ends get it. A second implementation of the crypto is exactly how the two ends
end up subtly and silently disagreeing.

## Rules

- **`import.meta.url` is allowed here and banned in `src/`.** This file is published as itself and
  never goes through the bundler, so its depth in the tree is fixed. That is the whole exemption —
  it does not extend to anything it imports.
- **Made for pipes.** Clip content goes to stdout and nothing else does; diagnostics go to stderr;
  the exit code is what a script branches on.
- **The version is read from `package.json`**, never written here. It was a literal once and was
  already wrong — the package said 0.2.1 while `--version` said 0.1.0.
- `package.json` `files:` ships `cli/`, `src/core/` and `src/transport/`. Importing anything outside
  those three from here breaks the published package, and only after publish.
- **`session.mjs` acts on its own initiative in exactly one place**, and that place needs the
  caller's permission. Everything else in it runs because a surface asked — it sends when told,
  closes when told. The lock-verification responder answers a frame off the wire with nobody in the
  loop, so it takes a `sharing` predicate (VS Code has an Off rung; the other three do not) and
  carries a session generation, because producing an answer spans two awaits and the surface can
  leave, be evicted, or rejoin on another key inside either. Anything else added here that
  transmits unprompted needs both. `tests/unit/shared-session.mjs`.
- `tests/live/cli.mjs` runs this against a real relay, and `prepublishOnly` runs that suite.
