# Architecture

How the frontend is organised, why it is organised that way, and where to put
new code.

---

## 1. The framework question

There isn't one, and that is the decision — not an omission.

The app is **native ES modules**. Real module boundaries, real imports, no
bundler, no build step. That buys one specific thing: the GitHub Pages deploy is
a file copy. No `npm ci`, no build cache, no lockfile drift, no "works locally,
breaks in CI". For a static app of this size, a bundler would trade that away for
tree-shaking we do not need.

**When to revisit:** if the app grows past ~40 modules, needs a component
library, or the `@import` chain in `styles/main.css` becomes a visible load
delay. At that point add a concatenation step at *deploy* time — not a build step
in development.

### That happened. Here is what it cost.

Two of the three conditions arrived together — 47 modules and a 17-deep serial
`@import` chain — so `tools/build/build.mjs` now assembles the deploy with esbuild.
The trade was taken exactly as written above:

- **`src/` is untouched.** Development is still `python -m http.server`, the
  `.husky` hooks still check real modules, and the module graph on disk is still
  the thing you read. The bundle exists only inside `_site`.
- **The deploy is no longer a file copy.** It runs `npm ci` and one script. That
  is the cost, and it is the reason this was deferred until both triggers fired.
- **What it bought:** 113 KB → ~35 KB gzip of eager JavaScript and 40 requests →
  2; CSS 24 KB → 6 KB and 17 serial requests → 1.

Note that the paragraph above this section names "the GitHub Pages deploy" as
what the no-build choice was protecting. Both halves of that have since gone:
there is a build, and the host is **Cloudflare Pages** at `realtimeclipboard.com`.
The reason for the second move was one GitHub Pages could
never satisfy — it cannot set an HTTP response header at all, so `frame-ancestors`
and `Strict-Transport-Security` were unavailable to an end-to-end-encrypted app.
They live in `_headers` now. The original text is left standing because the
decision was correct when it was made and the conditions for revisiting it were
stated in advance; that is the part worth imitating.

Two things bundling broke that nothing else caught, both worth knowing before
touching the build:

1. **`import.meta.url` is not portable across bundling.** Six modules resolved
   asset paths from it, which encodes how deep a file sits in the tree — and
   bundling moves every one of them at once. `install.js` resolved the app root
   one level too high and silently broke the service-worker scope and the PWA
   install criteria (OI-9). `core/paths.js` now owns this, from
   `document.baseURI`, and the static check forbids the old pattern.
2. **`import(variable)` is opaque to a bundler.** The optional-panel loader
   passed path strings, so esbuild could not see them, left the specifiers
   alone, and both panels 404'd in the deploy — caught, warned and degraded
   exactly as designed, which is precisely why it would have shipped. Literal
   specifiers inside thunks keep the laziness and stay analysable.
   `tests/dom/bundle.mjs` boots the built output and fails on either.

The one constraint this imposes: **ES modules require HTTP**. Opening
`index.html` from `file://` fails on CORS. Use `python -m http.server 8080`.

---

## 2. Layout

**A directory's rank decides what it may import**, and every directory carries a `CLAUDE.md`
stating its own rules. The ranks:

```
 0   core/                                     imports nothing above it
10   transport/  clipboard/  files/  landing/  peers — may not import each other
20   ui/primitives/
21   ui/shell/  ui/features/                   peers — may not import each other
22   ui/panels/                                composes shell + features + primitives
99   main.js                                   the only file that may cross layers
```

An import may go downhill or stay inside its own directory, and nothing else. One sideways edge is
allowed and named in the check: `files/transfer.js` reads `transport/protocol.js` for frame shapes,
which are transport-agnostic by design.

```
index.html              markup only — no styles, no behaviour
src/
  main.js               composition root: the only file that knows the whole graph
  core/                 bus, config, state, crypto, keys, storage, paths, device, history
                        no DOM — the CLI and the node suites import these unchanged
  transport/            relay.js is the facade; ws.js and sse.js are interchangeable
                        channels; protocol.js is frame shapes (PRD §6)
  clipboard/            os.js is the whole OS boundary; capture.js owns the T0–T3 tiers
  files/                transfer (WebRTC, relay fallback), registry, chunker, thumbs
  ui/
    primitives/         dom.js, modal.js, statusMenu.js — no domain knowledge
    shell/              statusbar, banners, panes, resizer, mobileNav, toast
    features/           lock*, syncMode, qr, whatsNew, install, cursors, hints, appLinks, ads
    panels/             editor, filesPanel, sessionPanel, historyPanel
  styles/               tokens.css owns every colour; main.css @imports the rest
    lazy/               fetched on first open, never bundled — see below
  landing/              behaviour for index.html: a separate document, CSS co-located
  pages/                help/ blog/ download/ — static content, copied to the
                        site root rather than bundled, so their links are
                        root-absolute and subpath hosting is not supported
```

`src/pages/` is the one directory here that is copied verbatim, and the one whose disk path is not
its URL: `src/pages/help/install/` is published at `/help/install/`. That lift is why every link
inside those pages is root-absolute — a relative one resolves against the page's depth, and these
pages have one depth on disk and another when served, so it would be correct in exactly one place.
`app.html` and `index.html` stay at the root precisely so the app keeps a dev loop where disk and
URL still agree.

### Eager and lazy stylesheets

`styles/` is bundled into one file; `styles/lazy/` is copied and fetched on first open by the panel
that needs it. `core/paths.js` `lazyStyleHref()` can address the second and nothing else, so the
two halves cannot disagree — the build used to recover the lazy set by grepping every module for
call sites, which meant a sheet could sit in both and ship twice. `qr.css` and `history.css` did
exactly that, invisibly, because CSS is idempotent.

Which half a sheet belongs in is a **correctness** question, not a payload one: `mobile.css` loads
last and overrides earlier sheets by source order, and a lazy `<link>` is injected after it. So
anything `mobile.css` restyles has to stay eager whatever it weighs.

---

## 3. The one rule

**UI modules never import a transport channel. They publish and subscribe on the
bus.**

```
  clipboard/capture ──emit(TEXT_CAPTURED)──► bus ──► main.js ──► transport/relay
                                              │
  ui/panels/editor ◄────on(TEXT_STREAMED)─────┘
```

`main.js` is the only file allowed to know both sides. Everything else depends on
the bus and on `core/`, never sideways.

> This rule used to read "transport **or clipboard** modules", and five UI
> modules imported `clipboard/` anyway — `shell/banners`, `panels/editor`,
> `panels/historyPanel`, `panels/sessionPanel` and `features/syncMode`. The
> check only ever enforced the transport half, so the drift was invisible for as
> long as it existed.
>
> The transport half is the one that earned its keep: it carried the entire SSE
> fallback in without a UI file changing, which is the argument the rest of this
> section makes. The clipboard half never paid for itself — `clipboard/` is a
> stable local boundary, not a swappable one, and `os.js` is already confined by
> its own check. So the rule is now narrowed to what is true and enforced, rather
> than left aspirational. Enforcing the wider version instead is a real option;
> it costs a bus round trip in five modules and needs its own tests.

Why it matters here specifically: the transport is the least settled part of the
system. If the deployed relay turns out not to pass WebSocket upgrades
(PRD **OI-1**), `transport/relay.js` gets replaced with an SSE+POST client and
**no UI file changes**. That swap is the whole point of the boundary.

It got used, for the other half of the problem. The relay passes upgrades fine;
the *client's* network may not (PRD §5.4). So the transport is now chosen at
runtime and no UI file changed:

```
  transport/
    relay.js       the facade: protocol, heartbeat, backoff, and which channel
    ws.js          channel — WebSocket
    sse.js         channel — SSE downstream + POST upstream, for blocked networks
    protocol.js    frame shapes, transport-agnostic
```

`ws.js` and `sse.js` implement one contract (`create → {send, close, isOpen}`)
and know nothing but how to move frames. Everything that is easy to get subtly
different between two transports — the hello, the 30 s heartbeat, jittered
reconnect backoff, the last-clip replay — lives in `relay.js` once, for both.
Nothing above `relay.js` can tell which one is live, and the static check
enforces that no UI/files/clipboard module imports a channel from `transport/`.

The switch itself: try WebSocket, give it `NET.PROBE_MS` to become usable, and
after `NET.SWITCH_AFTER` attempts that never do, move to SSE and say so. The
probe matters more than it looks — a blocked WebSocket usually does not fail, it
hangs, so there is no error to react to and nothing but a timer will notice.

The status bar can pin it by hand, and that is a good example of the rule
working rather than an exception to it. `ui/shell/statusbar.js` owns the menu and
knows the three values; it emits `EV.TRANSPORT_SELECT`, `main.js` calls
`relay.setTransport()`, and the UI hears the result back as `EV.TRANSPORT`. No
UI file imports a channel, so the picker would keep working if the channels
were replaced tomorrow.

### Consequences worth knowing

- Event names live in `bus.js` as `EV.*` constants. A typo'd string literal is a
  silent no-op — always use the constant.
- `state.js` is not reactive. Mutate through its setters, which emit. Nothing
  observes the object directly, so data flow stays one-directional and greppable.
- Every colour comes from `tokens.css`. A hex literal in a component file is a
  bug: it means the theme cannot be changed in one place.

---

## 4. Where things actually live

| I want to… | Go to |
|---|---|
| Change a limit (file size, char cap, timeout) | `core/config.js` — nowhere else |
| Add a wire message | `transport/protocol.js`, then handle it in `relay.js` |
| Change how a clip is captured | `clipboard/capture.js` |
| Touch the system clipboard | `clipboard/os.js` — the only file that may |
| Add a DOM helper with no idea what the app does | `ui/primitives/` |
| Add persistent chrome — a bar, a pane, a splitter | `ui/shell/` |
| Add a feature that could be deleted without breaking the layout | `ui/features/` |
| Add a content surface built out of the other three | `ui/panels/` + `styles/*.css`, register in `main.js` |
| Add a stylesheet | `styles/` if `main.css` should bundle it; `styles/lazy/` only if the component is optional **and** `mobile.css` says nothing about it |
| Change a colour | `styles/tokens.css` |
| Add a setting | `state.js` defaults → a row in the right menu in `sessionPanel.js`. No markup in `app.html`: the menus render from state when opened |
| Add a modal | `ui/primitives/modal.js` — `show({className, html, labelledBy, onClose})`. It owns the inert shell, the tab ring, Escape, and focus restore. Do **not** hand-roll another one, and do not mount to `#mount-modals`: `filesPanel.js` owns that node and rewrites its `innerHTML` on a 500 ms tick, which would delete a dialog out from under its own focus trap |
| Release something | `npm run release -- minor`. Tests run in a git hook, not on GitHub; a tag is what deploys — [RELEASING.md](RELEASING.md) |

### Adding a feature, worked example

Say incoming clips should ding.

1. `core/config.js` — `export const SOUND = { enabled: true, url: "…" }`
2. `ui/features/sound.js` — `on(EV.TEXT_RECEIVED, play)`
3. `main.js` — `sound.init()`

No existing module changes. That is the test of whether the boundaries hold.

---

## 5. Security invariants

These are load-bearing. Breaking one is a vulnerability, not a bug.

| Invariant | Enforced in |
|---|---|
| An incoming clip never destroys unsent editor text | `main.js` checks `editor.isDirty()` before overwriting; otherwise it offers |
| A device joining the session is announced, not silent | `state.setPeers()` diffs the roster → `ui/shell/banners.js` |
| Signalling and cursor frames are sealed like clips | `main.js` `encryptFrame()`; only routing fields stay clear |
| A peer may retract only files it announced | `files/registry.js` `applyGone()` checks the relay-stamped `from` |
| The share key is never transmitted — only `SHA-256(key)` and ciphertext | `core/crypto.js`; `core/config.js` `pageLocation()` keeps it out of every analytics call, and `ui/features/ads.js` keeps the ad tag from loading while the key is in the URL — the note below |
| Keys are normalised (uppercased) before hashing | `core/keys.js` |
| A session PIN is never transmitted, never in the URL, never on disk, never logged — only PBKDF2+HKDF output derived from it | `core/crypto.js`, `core/storage.js` `saveLock()`, `main.js` `announce()` |
| A locked link opens no connection until the PIN is given, and never falls back to the unlocked room of the same key | `main.js` `startSession()`; `tests/live/boot.mjs --locked` |
| The app is not usable while a locked link has no PIN — no editor, no history, no files, because none of it is connected to anything | `main.js` emits `EV.LOCK_REQUIRED` → `ui/shell/lockGate.js` holds the shell `inert`; `tests/dom/dialog.mjs` |
| The lock marker is parsed **before** key normalisation | `core/keys.js` `parseFragment()` — normalising first turns `#!ABCDEF` into the different, valid key `ABCDEF` |
| The lock beacon is planted only into a room with no retained clip | `main.js` on `EV.ROOM_STATE` — it is itself a clip, and would otherwise overwrite the last-clip replay of FR-3.3 |
| A locked session claims "Private" only once something has actually decrypted | `state.setVerified()` → `ui/panels/sessionPanel.js` `renderLock()` |
| Only the device that opened the room may lock it, once anyone else is in it | `state.canLock()`, fed by `welcome.existing` — enforced at both call sites (`ui/features/lockButton.js` and `main.js` `session:lock`) |
| Locking never leaves the other devices connected to a session nobody is in | `main.js` `sendEviction()` plants `LOCK.EVICT` in the room being abandoned; `onEvicted()` is the other end |
| A bus event that reports is never named the same as one that commands | `core/bus.js` — `EV.LOCK_STATE` and the `"session:lock"` imperative once shared a name, and every `setKey()` opened the PIN dialog by itself |
| Peer content is escaped before entering `innerHTML` | `ui/primitives/dom.js` `esc()`, and `setHTML()` is the only sink — enforced by Trusted Types in the CSP, and by the static check |
| `lastSent` and the suppression window are set *before* writing to the OS clipboard | `clipboard/capture.js` `writeNow()` — the one path both deferral routes funnel through |
| Reading and writing the OS clipboard are both derived from the sync rung, and neither has a switch of its own | `core/config.js` `bindsClipboard()`, checked in `capture.js` at every tier and in `apply()`; `tests/unit/syncmode.mjs`. Receiving used to have an independent switch, so a device set to Manual stopped sending while arriving clips still landed on its clipboard |
| An `Off` device puts nothing on the wire and shows nothing arriving — but still hears the eviction sentinel | `core/config.js` `sharesSession()`, gated in `main.js` `sendText()`/`sendStream()` and *after* the sentinel checks in `onFrame()` |
| Live typing is a view channel and never reaches history, the OS clipboard or the dedupe | `EV.TEXT_TYPED`/`EV.TEXT_STREAMED` vs `EV.TEXT_CAPTURED`; `tests/dom/editor.mjs` |
| A peer's typing is never merged into yours and never overwrites it | `ui/panels/editor.js` drops an inbound stream while `isDirty()`; `main.js` offers a conflicting commit via `EV.CLIP_OFFERED` rather than applying it |
| The AES key is derived once per session, never per message — and is cleared on leave, rotate and rejoin | `core/crypto.js` cache + `clearCache()` |
| Rejected files always report why | `files/registry.js` → `filesPanel.js` |
| The transfer path (P2P vs relay) is always visible | `ui/panels/filesPanel.js` `badge()` |
| The desktop shell is never told anything derived from the key | `desktop/src-tauri/src/main.rs` — the tray emits `ui://copy-link` and the webview builds the link; Rust owns windows and booleans only |
| The native bridge has one owner and one feature test | `core/native.js` — the only module that may name `__TAURI__` or read `__REALTIMECLIPBOARD_SURFACE__`, both enforced by the static check. Two hosts answer the same two questions (`invoke`, `listen`): the desktop shell announces itself through a Tauri global, the VS Code extension registers itself with `setHost()`. Everything above sees one boundary, and asks `hasNativeClipboard()` rather than naming a shell |
| A surface that cannot be detected is declared, never sniffed | `vscode/src/extension.js` sets `__REALTIMECLIPBOARD_SURFACE__` at require() time. `VSCODE_PID` is set inside VS Code's *integrated terminal* as well as its extension host, so sniffing it would make `realtimeclipboard watch` typed at that terminal claim to be the extension |
| An agent is never handed a clip as instructions | `mcp/server.mjs` — every clip is defused through `clipboard/guard.js`, every tool that returns one repeats in its own description that the text is DATA, and one that `looksExecutable()` is labelled. The labelling is advice to a model; **the control is that the server executes nothing** — no shell, no file writes, no `eval`. If that changes, the labelling stops being sufficient |
| The browser extension never claims what a browser cannot do | `browser/` — Chromium exposes `navigator.clipboard` to neither a service worker nor an offscreen document, so the only route is `execCommand` behind a user gesture. Every read happens because someone asked. A flagged clip is refused by the hotkey outright and written only from the popup, which is `capture.confirmPending()`'s rule on a surface that has no `capture.js` |
| One derive/connect/decrypt, four consumers | `cli/session.mjs` — `cli/`, `vscode/`, `mcp/` and `browser/` share it. It lives in `cli/` and not `src/transport/` because `src/` is the web app: every `.js` under it is precached shell, and a module no page loads would have to be precached anyway |
| The extension host holds no key on disk in the clear | `vscode/src/secrets.mjs` — `context.secrets`, the OS keychain, where every other surface uses `saveLastKey()`'s plaintext `localStorage`. Its `sessionStorage` shim is an in-memory Map, so `core/history.js`'s never-on-disk rule holds by construction rather than by browser behaviour |
| An arriving clip is defused before it reaches the OS clipboard, and one that reads like a shell command is never written without a click | `clipboard/guard.js`, applied in `capture.js` `apply()`; `flushPending()` steps over a flagged clip and only `confirmPending()` writes one. `tests/unit/pasteguard.mjs` |
| The share key leaves the address bar as soon as it has been read, and reaches disk only if the user says so | `main.js` `openSession()` calls `keys.clearUrl()`; `core/storage.js` `saveLastKey()` takes the `rememberKey` setting. A reload is served by `sessionStorage`, which dies with the tab |
| Peer-supplied text cannot render as something other than itself | `core/text.js` — one character class, three consumers (`clipboard/guard.js`, `files/registry.js` `safeName()`, `cli/`). Bidi overrides and C0/C1 are stripped; a filename also loses path separators and leading dots |
| Trusted Types names the policies it allows | The CSP says `trusted-types realtimeclipboard` — never `*`, never `'allow-duplicates'`, either of which lets injected script mint or re-mint a policy and reach `innerHTML`. Asserted by `tools/check/site-check.mjs` |
| A stranger cannot make the relay allocate without bound | `backend/main.py` `MAX_ROOMS` (checked before a Room is created) and `MAX_CONNS_PER_IP` (before that). Every peer removal goes through `_drop_peer()`, so the address count cannot leak. `backend/test_policy.py` |
| Clip text reaching a terminal cannot drive it | `cli/realtimeclipboard.mjs` `forTerminal()` strips CSI and OSC sequences when stdout is a TTY — OSC 52 sets the terminal's own clipboard. A pipe is passed through byte-for-byte |

The suppression ordering is the subtle one. Write first and your own poller sees
a "new" clipboard value and bounces it back to the sender, forever. See
[CLIPBOARD-FLOW.md §6](CLIPBOARD-FLOW.md).

### The one that was enforced by two policies — reversed 2026-08-09

**Ads are per surface, and the split is a policy, not a preference.** Google's programme
policies forbid ads in software applications, so the Tauri shell and the VS Code extension can
never carry AdSense — enforcement is account-level, so a tag there risks the website's revenue
too. `src/core/surface.js` `adNetwork()` is the single decision point;
`docs/decisions/0001-adsense-only-on-web-surfaces.md` has the reasoning and names the three
checks that hold it. The desktop shows a house slot instead
(`docs/decisions/0002-house-slot-on-the-desktop-app.md`).

| Surface | Ads | Analytics |
|---|---|---|
| Web browser | AdSense | GA4 `web-browser` |
| Installed PWA | AdSense | GA4 `web-pwa` |
| Tauri desktop | House slot, no network | GA4 `desktop-*` |
| VS Code extension | None | None — extension host, no webview |
| CLI | None | None |

Everything below concerns **the web surfaces only**.

**AdSense now runs in `app.html` too.** Until 2026-08-09 the app was the one
surface with no ad tag, held closed by its own meta CSP naming no ad origin;
that rule was removed deliberately, and the price the paragraph below always
named — a third-party script in the document that holds decrypted clipboard
text — was accepted with it. Every page now declares one policy, and
`tools/check/site-check.mjs` asserts the header and both meta declarations
agree.

What survives the reversal is **timing**: the ad tag reports the page URL
itself with no supported override, and in this document that URL can contain
the share key. So `ui/features/ads.js` mounts the unit only after boot has
stripped the key from the fragment (`keys.clearUrl()`), and a locked link —
whose fragment stays until the PIN is given — shows the placeholder until then.
gtag takes `page_location` from the page, and `pageLocation()` strips the
fragment there on every surface.

| | Where it stands |
|---|---|
| An ad tag reading `location.hash` | **Cannot happen, by timing.** The tag loads only once the fragment is empty; a document whose URL still holds a key shows no ad |
| An ad tag reading the editor's DOM | **Accepted, 2026-08-09.** Google's script runs where decrypted clipboard text lives, and contextual targeting reads page content by design. This is the cost the old rule existed to refuse; `/privacy/` must state it. It reads `localStorage` (the `rememberKey` store) as easily — that is part of the same acceptance |
| `page_location` carrying the key | **Fixed, both surfaces.** `pageLocation()` in `core/config.js` strips the fragment and every `gtag("config", …)` passes it — a config call without it sends the key to Google. It matters on the landing page too: a share link can arrive on `index.html` and sit in the fragment for the instant before `landing/redirect.js` forwards it |
| Trusted Types naming exactly one policy | **Given up everywhere, 2026-08-09** — AdSense mints `goog#html` per injected frame, so `app.html` now carries the same `trusted-types * 'allow-duplicates'` as the crawlable pages. The `innerHTML` sink in `ui/primitives/dom.js` stays singular by the static check, no longer by the CSP |
| Relay confidentiality | **Unaffected.** Encryption is unchanged; the relay still cannot read a clip, and no key reaches it |
| What Google learns about app usage | Page views, referrer, approximate location, device — against a URL with no key in it. That is a real disclosure and `/privacy/` states it |

`src/ui/features/ads.js` and `analytics.js` are where the rules sit next to the
code, and `/privacy/` is where the disclosure belongs.

#### History — the repair that preceded the reversal, and it was two holes not one

The key is out of the fragment. `main.js` `openSession()` calls `keys.clearUrl()`
the moment the key has been read, and a reload is served from `sessionStorage`
instead of the address bar.

Fixing it turned up the half that was not in the table above: **`storage.js`
`saveLastKey()` had been writing the share key to `localStorage` in plain text
all along**, which every one of these documents claimed never happened
(`src/core/CLAUDE.md`: "never on disk"). A tag reads `localStorage` as easily as
it reads `location.hash`, so removing the fragment alone would have moved the key
without protecting it. That write is now gated on a `rememberKey` setting,
default on — the behaviour FR-1.7 asks for — and switching it off forgets the key
already stored rather than only declining the next one.

What that repair did **not** change: a third-party tag in this document still
reads the DOM, and the DOM still holds decrypted clipboard text. Contextual
targeting is that, by design. This section used to end *"turning ads on means
widening the CSP again and accepting the DOM-reading row above; it is a
decision with a price, not a switch"* — on 2026-08-09 that decision was taken,
knowingly, and the rows above record what was paid and what was kept.

---

## 6. Testing

No test runner in the repo — the modules are pure enough to exercise directly.
Suites are filed by **what they need to run**: `tests/unit/` needs nothing,
`tests/dom/` needs jsdom, `tests/live/` needs a relay, so `node tests/<path>`
never fails for a reason unrelated to your change. See
[../tests/README.md](../tests/README.md).

```bash
mkdir -p /tmp/t && cp -r src /tmp/t/ && echo '{"type":"module"}' > /tmp/t/package.json
cd /tmp/t && node -e 'import("./src/core/crypto.js").then(async c => {
  const { aesKey } = await c.deriveOpen("D75LV");
  const { payload, iv } = await c.encrypt(aesKey, "hello");
  console.log(await c.decrypt(aesKey, payload, iv));
})'
```

`core/` and `files/thumbs.js` are node-testable as-is. `ui/` needs a DOM and is
currently verified by a static check that every `$("id")` in `src/` exists in
`index.html`.

**A bug this caught:** `keys.isValid()` originally required every character to be
in the generation alphabet — which rejected `D75LV`, the worked example used
throughout these docs, because `L` is excluded as ambiguous with `1`. The
alphabet constrains what we *produce*; validation must accept anything a peer
might hand us, or a future alphabet change strands every existing link.

That permissiveness was then read as applying to *length* as well, and it does
not: `#F5H4` opened a real session at ~19.6 bits, on a relay that routes a room
hash without being able to judge what went into it. The floor is now
`KEY.MIN_LENGTH`, refusal is a gate rather than a silent fall-through to a fresh
key, and the reasoning is in
[decisions/0008](decisions/0008-minimum-key-length.md). Permissive about the
alphabet, strict about the length.

---

## 7. Backend

`backend/` is a separate deployment (FastAPI Cloud) and shares no code with the
frontend — only the protocol in [PRD §6](PRD.md). See
[backend/README.md](../backend/README.md), **including the replica-pinning step**.
