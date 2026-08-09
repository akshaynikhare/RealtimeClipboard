# RealtimeClipboard desktop

The Windows, macOS and Linux app. A Tauri v2 shell around **the repository's own
`src/`** — not a copy of it, not a port of it, the same files the website serves.

## Why it exists

One reason, and it is worth being precise about it. A web page can only read the
clipboard while its window is focused; that is a rule every browser enforces, and
[docs/CLIPBOARD-FLOW.md](../docs/CLIPBOARD-FLOW.md) §5 explains why it is never
going to change. So the browser version's model is *"switch to RealtimeClipboard and it
grabs what you copied"*.

A native process is not bound by that rule. This app watches the system clipboard
continuously, which turns the model into *"copy anywhere, it is already there"*.
That is the whole difference, and it is the reason a desktop app is worth
building while an Android or iOS one is not — both of those platforms forbid
background clipboard reads outright, so a native mobile app could not do this
either.

## What is in Rust, and what is deliberately not

`src-tauri/src/main.rs` does five things:

1. watches the system clipboard and emits `clipboard://text`
2. writes incoming clips to the clipboard without needing focus
3. owns the tray icon and its menu, the window's lifetime, and a global hotkey
4. refuses to run twice
5. opens a project link in the real browser, because the webview cannot

**Rust never sees a frame, a room hash, or a key.** The protocol, the encryption,
the transport and the whole UI are the JavaScript in `../src/`, built into
`_desktop/` by `npm run build:desktop` and loaded unmodified. That is what keeps
the wire protocol at exactly two
implementations — this app's JavaScript, and the Python relay — however many
platforms ship. A Rust client would have been a second place for the crypto to be
subtly and silently wrong.

On the JavaScript side the integration is one new capture tier, **T0**, in
[`src/clipboard/capture.js`](../src/clipboard/capture.js). It feeds the same
`capture()` funnel as the paste and focus tiers, so `main.js`, the editor, the
history and the transport are all untouched — the boundary in
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §3 doing exactly what it was for.

Everything crossing the IPC boundary goes through
[`src/core/native.js`](../src/core/native.js), which is the only module allowed
to mention `__TAURI__` — the static check enforces it. Three modules used to
feature-test that global independently, which is how all three came to fail at
once (see `withGlobalTauri` below).

### The tray, per platform

The three platforms genuinely differ, and the menu is the only thing common to
all of them — which is why **Open RealtimeClipboard** is its first item.

| | left click | double click | right click |
|---|---|---|---|
| **Windows** | show the window | show the window | menu |
| **macOS** | menu | — | menu |
| **Linux** | — | — | menu |

`DoubleClick` is documented **Windows Only** in `tray-icon`, and on Linux no
tray click event is delivered at all: libappindicator offers a context menu and
nothing else. So clicks are a convenience on two platforms and the menu is the
guarantee on three. macOS opens the menu on a left click because that is what a
menu-bar item does; the handler returns early there so one click cannot both
open the menu and raise the window.

The menu is built in `main.rs`, not declared in `tauri.conf.json`, for three
reasons: the config cannot express a per-platform `show_menu_on_left_click`; the
Linux icon may not appear at all unless a menu exists when it is created; and
having icon, menu and both handlers in one block beats having them in two files.

### Closing is not quitting

The **X** button hides the window so the watching continues, and the first close
says so in a dialog offering *Quit now* / *Keep it running* and an "always quit
instead" checkbox that becomes `settings.closeToTray`. **Quit** is in the tray
menu regardless.

That shape is deliberate. Before it, close hid the window, the tray had no menu
and no click handler, and the only way to quit was Task Manager — the exact
complaint people file about tray applications. A dialog works here rather than a
notification because `prevent_close()` means the window is still on screen while
the question is asked; if the webview cannot answer within two seconds the shell
hides the window anyway, because an unclosable window is the worse failure.

## Build

Needs the [Rust toolchain](https://rustup.rs) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
npm install -g @tauri-apps/cli    # or: cargo install tauri-cli --version "^2"

# dev — serve the frontend first, because the app loads the real src/
npm run serve                     # from the repo root, port 8080
cargo tauri dev --config desktop/src-tauri/tauri.conf.json

# release
cargo tauri build --config desktop/src-tauri/tauri.conf.json
```

Artifacts land in `desktop/src-tauri/target/release/bundle/`.

### The icons

`src-tauri/icons/` is generated and committed. It is not decoration: `build.rs`
runs `tauri-build`, which compiles the first `.ico` into the Windows resource, so
a missing icon set fails `cargo build` on Windows — not just `tauri build`. That
is exactly what it did, silently, through the v0.2.0 and v0.2.1 tags.

Regenerate it only when the logo changes, and never on its own:

```bash
npm run build:icons     # this directory AND assets/icons/, from one source
npm run check:icons     # exit non-zero if either set is stale
```

`tools/build/build-icons.py` draws all seventeen files here plus the five web
icons from the same geometry, so the launcher icon and the favicon cannot come
apart. It replaced a recipe — headless Chrome to raster the SVG, then a transient
`npx @tauri-apps/cli icon` — that produced these two sets in two separate runs
and left nothing able to tell that only one of them had been done.

> **Not yet compiled.** This scaffold was written without a Rust toolchain
> available, so it has never been through `cargo build`. Treat the first build as
> part of the work: expect plugin API details — particularly the
> `tauri-plugin-clipboard-manager` v2 trait import in `main.rs` — to need
> adjusting against the crate versions that actually resolve.

## Why tauri.conf.json looks like that

The file carries no `"//"` comment keys. **It cannot**: `tauri-build` deserializes
the config with unknown fields denied, so a `"//"` key is not an ignored comment
but a hard build failure — `unknown field '//version', expected one of …`. The
config had carried six of them since it was written and nobody found out, because
the app had never been compiled. The reasoning they held lives here instead.

- **`version: "../../package.json"`** is a path, not a number. Tauri reads the
  version from the repository's own manifest rather than restating it. A second
  copy is a copy that drifts, and this one already had: the config said `0.1.0`
  through both the v0.2.0 and v0.2.1 tags, which would have named every artifact
  after a version nobody released. `tools/release/release.mjs` bumps the two
  remaining copies — `Cargo.toml` and `Cargo.lock` — together, because
  `cargo build --locked` fails outright when they disagree.

- **`frontendDist: "../../_desktop"`**, built by `beforeBuildCommand`, is the
  same bundle the website ships — not a copy, not a variant. That is the most
  important property in the file: it is what stops the desktop app becoming a
  second implementation that drifts. It used to be `"../../"`, the repository
  itself, which meant `node_modules/` and `docs/` went inside the installer;
  `tools/build/build.mjs --desktop` exists to make pointing at a real build
  possible. See the header comment there for why an ignore file was not the fix.

  **`beforeBuildCommand` is an npm script and must stay one.** Its working
  directory is not fixed: `tauri-action` in CI runs it from the repository root,
  while `npx tauri build` inside `src-tauri/` runs it from `desktop/`. Any
  relative path to `tools/build/build.mjs` is therefore correct in exactly one
  of the two and fails with `Cannot find module` in the other — both of which
  this repository has now done, on three runners each. `npm run` resolves the
  package root by walking up from wherever it starts, so it lands on the same
  directory either way.

  `frontendDist` has no such problem: Tauri always resolves it against the
  config file, so `../../_desktop` is the repository root.

- **`security.csp`** is the website's policy plus what the shell needs. The
  webview renders clipboard content arriving from other devices, so it gets the
  same protection. `ipc:` is how the frontend reaches the commands in `main.rs`
  (`set_clipboard`, `set_window_prefs`, `resolve_close`, `set_sync_indicator`).
  The relay origins must match `src/core/config.js` —
  `tests/unit/static-check.mjs` asserts that for the web pages, and a self-hoster
  changes both.

- **`security.assetProtocol.enable: false`.** It was `true`, with an empty
  `scope` — a protocol switched on that was permitted to serve zero files, and
  which nothing calls: there is no `convertFileSrc` anywhere in `src/`. It also
  broke the build outright, because enabling it requires the `protocol-asset`
  feature on the `tauri` dependency, which `Cargo.toml` does not carry. Bundled
  files are served over `tauri://`, not `asset:` — the latter is for reading
  arbitrary paths off the disk, which this app has no reason to do. `asset:` is
  gone from `img-src` for the same reason.

- **`app.withGlobalTauri: true`** is what makes the native half exist. It
  defaults to **false** (`tauri-utils`, `with_global_tauri` under
  `#[serde(default)]`), and without it `globalThis.__TAURI__` is never injected.
  This repo ships zero runtime dependencies, so there is no `@tauri-apps/api`
  import to fall back on: every feature test in `src/clipboard/` failed, T0 never
  started, incoming clips took a path that needs window focus, and the status bar
  reported a browser tier — while the help pages told people to look for
  `T0 · watching the system clipboard` as proof the install had worked. The app
  ran perfectly and was not a desktop app. The static check now asserts it.

  It injects the whole JS API onto `window`, so `capabilities/default.json` is
  the real gate and is kept correspondingly short.

- **There is no `app.trayIcon` block.** The tray is built in `main.rs` — see
  [The tray, per platform](#the-tray-per-platform). Note that the config could
  not have expressed the behaviour anyway: `menuOnLeftClick` is applied and then
  overwritten by `showMenuOnLeftClick`, which defaults to **true**, so the
  committed `false` never took effect and the shipped app was in "left click
  opens a menu" mode with no menu attached. Left click did nothing.

  The icon comes from `bundle.icon` via `default_window_icon()`. It stays a
  colour icon rather than a macOS template image: a template is drawn from its
  **alpha channel alone**, and that asset is a full-bleed opaque square, so it
  would render as a solid black block in the menu bar. A monochrome-on-
  transparent asset would fix macOS and then be invisible on a dark Windows
  taskbar, so it needs to be a *separate* asset — worth doing now that the menu
  bar is the primary macOS interaction, and not done here.

- **`bundle.targets`** is one list covering every desktop platform; `tauri-action`
  picks the ones each runner can actually produce.

- **`bundle.linux.deb.depends`** names webkit2gtk **4.1** as the floor, so apt
  refuses the install on a distribution too old to run it. Without it the package
  installs cleanly and then fails at launch with a missing symbol, which reads as
  "the app is broken" rather than "the dependency is wrong".

  It also names `libayatana-appindicator3-1 | libappindicator3-1`, and the
  alternation is required: the plain package is gone from newer Debian, the
  ayatana one is absent on some older releases, so naming either alone breaks the
  install on the other. This list is **not merged with anything** — `tauri-bundler`
  writes `settings.deb().depends` verbatim into the control file, with no
  auto-detection — so a tray library missing here is a tray library missing at
  runtime. Verify with `dpkg -I` on the built `.deb`.

- **`bundle.windows.certificateThumbprint: null`** and **`macOS.signingIdentity:
  null`** are empty so a local build still works. See [Signing](#signing) for what
  CI does when the secrets exist, and what users see when they do not.

## The thing to get right

`ECHO_SUPPRESS` in `main.rs`, and the ordering in `set_clipboard`.

A clip arrives, we write it to the clipboard, and our own watcher sees a "new"
value and sends it back — forever, to every device in the session. Three guards
close that loop (CLIPBOARD-FLOW §6), and `set_clipboard` must **remember before it
writes**. Reversed, the watcher thread can observe the value before it has been
recorded, and the storm starts.

This mattered less in the browser, where the poller only ran while the window was
focused. A background watcher has no such bound. Before shipping any change here,
run the loop test: two agents, one session, Live mode, copy once, and assert the
clip crosses exactly once each way and then stops — for five minutes.

## Signing

Matters more for this app than for most. SmartScreen and a lot of antivirus
treat an unsigned binary that reads the clipboard and opens outbound TLS
connections as suspicious, which is a fair description of what this does.

**Today it ships unsigned**, and `release.yml` is wired so that adding the
secrets is the only step needed to change that — no workflow edit. What users
see meanwhile is written on `/download/` rather than left for them to discover:

| | Unsigned | What the user does |
|---|---|---|
| Windows | SmartScreen: "Windows protected your PC" | **More info → Run anyway** |
| macOS | Gatekeeper refuses: "Apple cannot check it for malicious software" | **System Settings → Privacy & Security → Open Anyway** |
| Linux | nothing to sign | AppImage needs `chmod +x` |

**Do not try to ad-hoc sign through `APPLE_SIGNING_IDENTITY: "-"`.** It looks
like a free improvement and it breaks the macOS build outright: setting the
identity makes Tauri take the signing path, which starts by importing
`APPLE_CERTIFICATE` into a keychain, and with no certificate that fails with
`failed to run command security import`. It cost v0.3.0 a build. An ad-hoc
signature has to be applied to the `.app` after bundling, before the `.dmg` is
made — which is worth doing one day, because "unidentified developer" is a
warning while an entirely unsigned bundle can be reported as "damaged".

### Getting a Windows certificate

Since June 2023 every code-signing key must live on FIPS 140-2 hardware, so a
`.pfx` you can simply buy and copy into a secret no longer exists.

- **Azure Trusted Signing — about $10/month.** Cheapest by an order of
  magnitude, no hardware, built for CI. Individual identity validation exists but
  wants roughly three years of verifiable history. **Start here.**
- **OV certificate — $200–400/year** (Sectigo, SSL.com, DigiCert). Ships a USB
  token, or uses a cloud HSM. SmartScreen reputation still has to accumulate
  over downloads, so the first few users are warned anyway.
- **EV certificate — $400+/year**, hardware token. The only option that gives
  **immediate** SmartScreen reputation, i.e. a clean first download.

Then set `WINDOWS_CERTIFICATE` (base64 of the `.pfx`) and
`WINDOWS_CERTIFICATE_PASSWORD`. `release.yml` imports it and writes the
thumbprint into the config at build time; the committed `certificateThumbprint`
stays `null` so local builds keep working.

### Getting an Apple certificate

About $99/year, and worth it — the unsigned macOS experience is the worst of the
three by a distance.

1. Join the **Apple Developer Program** (individual, or an organization with a
   D-U-N-S number).
2. Create a **Developer ID Application** certificate — the one for distribution
   *outside* the Mac App Store. Export it as a `.p12`.
3. Create an app-specific password for notarization, or an App Store Connect API
   key.
4. Set `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY` (`Developer ID Application: Name (TEAMID)`),
   `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

`release.yml` already reads all six, so signing and notarization turn on the
moment they exist. Notarization is what removes the Gatekeeper dialog entirely.

## Defaults worth knowing

The app ships set to **Live** sync, the same as the website —
`DEFAULT_SYNC_MODE` in [`core/config.js`](../src/core/config.js) is not
per-surface. This paragraph used to claim Manual, and that was never true of any
build.

It is worth stating why it stays Live rather than being made true. The consent
argument for Manual is real — the app reads every copy you make while it is
running, which is a materially larger thing to agree to than a browser tab that
can only look while you are looking at it. But a default of Manual means the
first thing a new user copies does not arrive, and the first impression of a
clipboard app whose first clip does not sync is that it is broken, not that it is
careful. The consent is better obtained where the guide now obtains it: at first
launch, in words, with the switch in the dialog.

**Installed builds default to a 10-character key**, where the website stays at 6
(`KEY.DEFAULT_LONG` in `core/config.js`). Six characters is ~29 bits and chosen
for a phone keyboard; an installed app links a device by QR or by a copied link,
so it does not pay that cost, and it is the surface running unattended all day.

The share key is the only thing sent per-surface. The **key derivation is
unchanged** — length is not a wire format, `isValid` has always accepted 4–32
characters, and `tests/unit/lock.mjs`'s golden vectors are unaffected.

Nothing is written to disk beyond the settings file — no history, no cache, no
log. That claim is checkable and should be checked: run a full session under
Procmon, `fs_usage` or `strace` before a release.
