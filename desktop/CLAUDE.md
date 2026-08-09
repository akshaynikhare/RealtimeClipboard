# desktop/

A Tauri v2 shell around **the repository's own `src/`** — not a copy, not a port. `tauri.conf.json`
sets `frontendDist: "../../_desktop"`, built from that same tree by `npm run build:desktop`.

## What that constrains

- **The source tree must keep saying `app.html`.** The clean `/app` URL is a deploy-time rewrite;
  `tauri://` does no extension stripping, so every `./app` link would 404 here — and nothing in the
  web build would show it.
- **Anything that breaks the no-build dev loop breaks this app**, because it serves the same
  unbundled files.
- **Nothing a user is given may be built from `location`.** The webview answers at
  `http://tauri.localhost` (`tauri://localhost` off Windows) — a host that resolves inside this one
  process. The share link, the QR code and the tray's Copy share link were all that URL for two
  releases, which is an app nobody could join. `SITE` in `src/core/config.js` is where a public
  address comes from; `tests/unit/sharelink.mjs` holds the line.

## Rust never sees a frame, a room hash, or a key

`src-tauri/src/main.rs` does five things: watch the system clipboard, write incoming clips without
needing focus, own the tray menu and the window's lifetime, refuse to run twice, and open a project
link in the real browser — the webview has none to hand it to.

The protocol, the encryption, the transport and the entire UI stay in the JavaScript. That keeps
the wire protocol at exactly two implementations — this JavaScript and the Python relay — however
many platforms ship. **Do not move protocol or crypto work into Rust.** A third implementation is a
third place for it to be subtly and silently wrong.

The line is drawn at *state derived from the key*. Rust may own windows, the tray and plain boolean
preferences. It may not own anything computed from the share key — so the tray's "Copy share link"
emits `ui://copy-link` and the webview does the copying, rather than Rust being told what the link
is. A tray menu is also visible on a screen share, which is its own reason not to put a key in one.

The whole integration on the JS side is one capture tier, **T0**, in `src/clipboard/capture.js`,
feeding the same funnel as paste and focus.

## Rules

- **`withGlobalTauri` must stay `true`.** It defaults to false, and with it off `globalThis.__TAURI__`
  never exists — every feature test in `src/clipboard/` fails, T0 never starts, and the app runs
  perfectly as something that is not a desktop app. It shipped that way through two tags.
- **`__TAURI__` is named in `src/core/native.js` and nowhere else**, the way `navigator.clipboard`
  is confined to `clipboard/os.js`. Three modules sniffing it separately is three chances to get
  the same answer wrong at once, which is exactly what happened.
- **The tray menu is the interaction; clicks are a bonus.** `DoubleClick` is Windows-only and Linux
  delivers no tray click events at all, so anything reachable only by clicking the icon is
  unreachable for two thirds of the platforms. Every action has a menu item.
- The relay origins in `tauri.conf.json`'s CSP must match `src/core/config.js`.
  `tests/unit/static-check.mjs` asserts that for the web pages; a self-hoster changes both.
- Build on the oldest supported runner (`ubuntu-22.04`, webkit2gtk 4.1). A newer image silently
  raises the glibc floor and the binary then refuses to start on the distributions we claim.
- `.github/workflows/desktop.yml` answers "does it compile", and **only when you ask it to** —
  `gh workflow run desktop.yml`. It has no push trigger. Run it while working on the Rust and once
  before cutting a tag; nothing else will. `release.yml` signs and publishes, and only on a `v*` tag
  that `main` already contains.
