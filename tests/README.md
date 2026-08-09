# tests/

Plain node scripts, filed by what they need to run. No test runner.

```bash
npm run verify        # everything that needs no relay and no build — the pre-commit gate
npm test              # all of it, needs a relay — the pre-push gate

node tests/live/e2e.mjs ws://127.0.0.1:8000    # any suite takes a relay base URL
RELAY_BASE=ws://127.0.0.1:8000 npm test        # or point the whole run at one
```

### unit/ — needs nothing

| Suite | What it proves |
|---|---|
| `static-check.mjs` | 20 repo invariants: imports resolve and point downhill, ids exist, the precache list matches disk, every stylesheet loads exactly once, the CSP holds |
| `lock.mjs` | Locked-session derivation, against golden vectors |
| `relay-url.mjs` | Relay address resolution and normalisation |
| `files.mjs` | Adding a file tells the other peers about it |
| `transfer.mjs` | A direct transfer delivers every byte before the connection is torn down |
| `clipsize.mjs` | A clip at the limit actually fits through the relay |
| `syncmode.mjs` | The sync ladder's stored values, the `autowrite` migration, stream vs commit |
| `pasteguard.mjs` | An arriving clip is defused before the OS clipboard sees it |
| `sharelink.mjs` | The link the desktop app and the CLI hand out is one another devices can open |

### dom/ — needs jsdom

| Suite | What it proves |
|---|---|
| `dialog.mjs` | The PIN dialog, driven in a real DOM |
| `whatsnew.mjs` | When release notes appear, when they stay quiet |
| `tiles.mjs` | The files grid does not rebuild itself on a progress tick |
| `guide.mjs` | The installed app's guide gates to the desktop and renders three ways to link a device |
| `links.mjs` | A link that leaves the desktop app reaches the real browser, and the shell will open it |
| `bundle.mjs` | The built `_site` boots — catches what only bundling breaks. Also needs a build |

### live/ — needs a relay

| Suite | What it proves |
|---|---|
| `e2e.mjs` | **The one that matters** — two peers, real crypto, a string in on A comes out intact on B |
| `boot.mjs` | `boot()` reaches the transport, in a real DOM. `--locked` covers the PIN path |
| `fallback.mjs` | The client notices a swallowed WebSocket and moves itself to SSE |
| `cli.mjs` | The CLI, end to end |

The relay has its own gates, which test the server rather than the client — see
[../backend/README.md](../backend/README.md).

Rules that govern edits here: [CLAUDE.md](CLAUDE.md).
