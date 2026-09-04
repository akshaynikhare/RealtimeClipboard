# vscode/ — the editor surface

The fifth surface, and the second one that is a **native host** rather than a browser. It runs on the
VS Code extension host: bare Node 24, no `document`, no `localStorage`, but with `WebSocket`,
`crypto.subtle`, `fetch` and `btoa`/`atob` as globals — so it imports `src/core/`,
`src/transport/` and `src/clipboard/` and gets the protocol, the crypto, the heartbeat, the jittered
backoff, the sync-mode ladder, the anti-echo suppression and the pastejacking guard for free.

`EventSource` is **not** a global here, so `sse.js` reports `available() === false` and this surface
is WebSocket-only. `relay.js:117,158` already guards both the initial pick and the failover; nothing
needed changing for it.

There is no webview. Transport and crypto live on the extension host so the session survives the
window losing focus, a panel being hidden, and every editor tab being closed. A clipboard sync that
stops when you switch tabs is not a clipboard sync.

## The one rule, inherited from cli/

**Nothing here may reimplement a protocol detail.** If something is missing it belongs in `src/`,
where every surface gets it.

This is why there is no clipboard state machine in this directory. It is tempting to write one —
`clipboard/capture.js`'s T1–T3 tiers are browser workarounds and look like dead weight on a host
that needs no focus and no permission. But the same file owns `writeNow()`'s ordering invariant, the
pending queue, the local-copy grace window and the `guard.js` calls, and a second copy of those is
exactly how two ends come to disagree silently. So `capture.js` was made **DOM-optional** instead:
its listeners self-skip when `document` is undefined, and this surface calls `capture.start()` and
receives T0 through the registered host below.

## What this directory may import

`src/core/`, `src/transport/`, `src/clipboard/`. Nothing else.

`src/ui/` and `src/files/` assume a DOM — `tests/unit/static-check.mjs` fails the commit.
`files/transfer.js` needs `RTCPeerConnection`, which the extension host does not have, so **there is
no file transfer in this surface**, by capability rather than by choice.

## CommonJS at the door, ES modules behind it

Root `package.json` says `"type": "module"`. `vscode/package.json` deliberately has **no `type`
field**, which makes everything under it CommonJS — what the extension host `require()`s. `.mjs`
overrides that per file, so:

- `src/extension.js` is **CJS** and is the only file that `require("vscode")`.
- everything else is `.mjs`, real ES modules, statically importing `../../src/**` — the same files
  the browser runs, unbundled, off disk.

One CJS→ESM hop, at the entry, once.

## Two things must happen before the first src/ module evaluates

`src/core/config.js` reads `localStorage` at **module scope** to resolve the relay URL, and
`src/core/state.js` calls `crypto.randomUUID()` at module scope. So neither of these can be lazy,
and both live at the top of `extension.js` — not inside `activate()`, because esbuild's CJS output
runs the entry's top-level body at `require()` time.

1. **`globalThis.__REALTIMECLIPBOARD_SURFACE__ = "vscode"`.** `src/core/native.js` reads it to answer
   `SURFACE`. Without it this host is indistinguishable from `cli/` — no `document`, but
   `process.versions.node` — and would inherit the CLI's key length and its terminal-escape
   handling. **Declared, never sniffed**: `process.env.VSCODE_PID` is set inside VS Code's
   *integrated terminal* too, so `realtimeclipboard watch D75LV` typed there would misreport as the
   extension.
2. **`storage.mjs` installs the shims**, which is why `src/core/storage.js` itself needed no changes.
   - `localStorage` → a synchronous mirror over `context.globalState`, written behind.
   - `sessionStorage` → a plain in-memory Map that dies with the window. Not a shortcut: it is what
     makes `core/history.js`'s never-on-disk invariant true here **by construction** rather than by
     browser behaviour.
   - **The share key is the exception and goes to `context.secrets`**, the OS keychain. Everywhere
     else `saveLastKey()` writes it in plaintext — the documented, `rememberKey`-gated cost of
     FR-1.7. Here we can do better for free, so we do.

**Never shim `document`.** A `document` global flips `native.js`'s `IN_NODE` and un-guards every
branch above it. Statically checked.

## Rules

- **`vscode.env.clipboard` appears in `host.mjs` and nowhere else**, the way `navigator.clipboard` is
  confined to `clipboard/os.js` and the Tauri globals to `core/native.js`. Likewise `require("vscode")`
  belongs only in `extension.js` — every other module takes the API by injection, which is what makes
  `tests/live/vscode.mjs` able to run it under a fake `vscode` with no editor present.
- **The anti-echo ordering is load-bearing twice, and more dangerous here than in a browser.**
  `capture.writeNow()` sets `lastSent` and `state.suppress()` before `os.write()`; `host.mjs`'s
  `set_clipboard` records `lastSeen` before `env.clipboard.writeText()`. A browser tab polls only
  while focused, so a mistake there loops until you click away. This polls whether or not you are
  looking, so a mistake here bounces a clip around the room forever. Same invariant, same reason, as
  `desktop/src-tauri/src/main.rs` — see `docs/CLIPBOARD-FLOW.md` §6.
- **`guard.defuse()` runs on every arriving clip with no setting to turn it off**, and a clip that
  `looksExecutable()` waits for an explicit action calling `capture.confirmPending()`. Never an
  auto-flush; `flushPending()` already steps over flagged clips and must not gain a second path. The
  integrated terminal is one keystroke from the cursor, which makes this the surface where a defused
  trailing newline matters most.
- **Every tunable is `src/core/config.js`.** A VS Code setting maps onto one; it does not introduce
  one. `pollMs` matches `POLL_OPTIONS`, `syncMode` matches `SYNC_MODES` — including the stored
  strings, which are a compatibility surface everywhere else and must not fork here.
  `PASTE_GUARD.ENABLED` is deliberately not exposed: it is a security invariant, not a preference.
- **Settings flow one way.** VS Code's `contributes.configuration` owns the values and pushes them
  into `state.js`. The shimmed settings blob is vestigial on this surface; two writers would be two
  sources of truth.
- **The peer name is passed explicitly** as `"VS Code · <platform>"`, never `device.name()` — Node
  has a synthetic `navigator` that would report "Browser · Unknown" — and never the hostname.
  `protocol.hello()` sends it in the clear and the relay rebroadcasts it to the whole roster.
- The key and the PIN are never logged. Diagnostics go to one `OutputChannel`; an extension's log is
  a file the user can hand to anyone.
- **`main` points at `src/extension.js`, not at `dist/`.** F5 loads the source tree, so development
  needs no build — the same trade as `app.html` on disk versus `/app` in the deploy. The build
  stages its own manifest with `main: "./extension.js"` into `dist/`. Rewriting the source form to
  match the deploy form silently breaks the dev loop.
- `LICENSE` and `CHANGELOG.md` are **staged from the repo root** by the build, never copied here. A
  second copy is a copy that drifts.
- `vscode/package.json` restates the version; `tests/unit/static-check.mjs` asserts it matches the
  root, and `tools/release/release.mjs` rewrites it along with the Cargo and Tauri copies.
- Every id in `contributes.commands` must be registered in `vscode/src/`, and every registration
  contributed. Statically checked — the analogue of the `$("id")` rule, and the same failure shape:
  a dead Command Palette entry with no error anywhere.
