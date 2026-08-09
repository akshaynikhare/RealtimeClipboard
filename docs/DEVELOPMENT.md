# Development

How to get RealtimeClipboard running on your machine, make a change, and know you have
not broken anything. For *what the modules are and where a feature belongs*, see
[ARCHITECTURE.md](ARCHITECTURE.md); for deploying the relay, see
[backend/README.md](../backend/README.md).

---

## 1. What you need

| | Why |
|---|---|
| Python 3.9+ | serves the static files, and runs the relay |
| Node 18+ | runs the test suite (`node --test` is not used; the tests are plain scripts) |
| A Chromium browser | the clipboard API this app is built on is Chromium-first |

There is **no build step and no runtime dependency**. You do not compile,
bundle, or transpile anything: the files in `src/` are the files the browser
loads. `npm install` fetches exactly one *dev* dependency, `jsdom`, used by a
single test — everything else runs without it.

---

## 2. Running it

You need **two servers**: one for the static files, one for the relay. The app
boots without the relay, but it will sit at "Connecting…" forever.

**Terminal 1 — the frontend.** Any static server will do. ES modules are
fetched with CORS rules that `file://` cannot satisfy, so opening `index.html`
by double-clicking it gives you a blank page and a console full of module
errors. Serve it over HTTP:

```bash
python -m http.server 8080
# landing page  http://127.0.0.1:8080/index.html
# the app       http://127.0.0.1:8080/app.html
```

**The content pages are the exception**, and the only thing in this repo that needs
a build to look at. `src/pages/help/` is published at `/help/`, one level up from
where it sits, so its links are root-absolute and point at URLs that exist only
after the lift:

```bash
npm run build:site && (cd _site && python -m http.server 8080)
```

That trade is deliberate and it is contained: `app.html` and `index.html` stayed
at the root so the app — the thing actually being edited — keeps a loop where the
disk path and the URL are the same string. See
[../src/pages/CLAUDE.md](../src/pages/CLAUDE.md).

**Terminal 2 — the relay.**

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --port 8000
```

**You do not have to configure anything to connect the two.**
[src/core/config.js](../src/core/config.js) checks `location.hostname` and
points at `ws://127.0.0.1:8000` when you are on `localhost`, `127.0.0.1` or
`[::1]`, and at the production relay otherwise. This is also why the port
matters: **the relay must be on 8000**, or the app will look for it there and
find nothing. The frontend port is yours to choose.

Two things follow from that hostname check, and both have cost people an hour:

- **Reaching your dev server from a phone on the same Wi-Fi does not work
  out of the box.** The URL is `http://192.168.x.x:8080`, the hostname is not
  localhost, so the app tries the *production* relay. That is a real
  configuration, not a bug — but if you want your phone talking to your local
  relay, edit `RELAY_URL` for the duration.
- **`http://127.0.0.1` is a secure context; `http://192.168.x.x` is not.**
  `crypto.subtle` and the clipboard API are unavailable on the latter, so the
  app cannot even derive a key. Test on a phone against a deployed build, or
  put a TLS proxy in front.

### Two peers on one machine

The fastest way to see the thing actually work: open `app.html` twice with the
same key in the fragment, in two windows.

```
http://127.0.0.1:8080/app.html#DEVKEY
```

Type in one, watch it arrive in the other. The relay log is the quickest
confirmation that both joined the same room — you will see two
`WebSocket /ws/<hash>` lines with an **identical hash**. The hash is a digest of
the key; the relay never learns `DEVKEY` itself.

---

## 3. The service worker will lie to you

[sw.js](../sw.js) caches the app shell, and it is the single most common source
of "I changed the file and nothing happened" in this repo.

**While developing, tick "Bypass for network" or "Update on reload" in
DevTools → Application → Service Workers.** Do it once per profile and forget
about it.

Two rules when you touch anything in `src/` or `index.html`:

1. **Bump `VERSION`** at the top of `sw.js`. Static assets are cache-first, so
   an unchanged version means returning visitors keep the old shell. Changing
   this file is also the only signal the browser has that an update exists — it
   byte-compares `sw.js`.
2. **Add new modules to the `SHELL` list.** There is no build step generating
   it; it is a hand-written array. `tests/unit/static-check.mjs` diffs that list
   against what is on disk and fails if they disagree, which is the safety net
   — but the net only catches you if you run the tests.

Neither kind of drift is fatal in production (a missing entry is cached on
first request instead; a stale one is logged and skipped), but both make local
work confusing.

---

## 4. Tests

```bash
npm test
```

Each file gates one thing, and each exists because the bug it checks for
actually shipped once.

**The directory says what a suite needs**, so `node tests/<path>` never fails
for a reason unrelated to your change: `tests/unit/` needs nothing,
`tests/dom/` needs jsdom, `tests/live/` needs a relay. A suite needing two is
filed under the heavier one — `boot` needs jsdom *and* a relay, so it is
`live/`. The full inventory is in [../tests/README.md](../tests/README.md); the
ones worth knowing by name:

| File | What it proves | Relay it uses by default |
|---|---|---|
| `tests/unit/static-check.mjs` | every import path resolves, every element id referenced in JS exists in the HTML, the `SHELL` list matches disk | none |
| `tests/unit/files.mjs` | adding a file tells the other peers about it | none |
| `tests/live/e2e.mjs` | **the one that matters** — two peers, real crypto, real relay, a string in on A comes out intact on B | **deployed** |
| `tests/live/boot.mjs` | `boot()` actually reaches the transport, in a real DOM | **deployed** (needs `jsdom`; skips cleanly without it) |
| `tests/live/fallback.mjs` | the *client* notices a swallowed WebSocket and moves itself to SSE | **local**, `ws://127.0.0.1:8000`; skips cleanly if nothing is there |

Note the split, because it catches people out: **a bare `npm test` reaches the
internet.** `e2e` and `boot` default to the deployed relay, so on a plane or
behind a firewall they fail for reasons that have nothing to do with your
change. Every one of them takes a relay URL as its first argument, so point the
whole suite at the one on your desk:

```bash
node tests/live/e2e.mjs      ws://127.0.0.1:8000
node tests/live/boot.mjs     ws://127.0.0.1:8000
node tests/live/fallback.mjs ws://127.0.0.1:8000   # already the default
```

Running against your local relay is also the honest way to test a *relay*
change: `npm test` on its own is testing production's relay against your
branch's client.

The relay has its own gates, which test the server rather than the client:

```bash
cd backend
python test_relay.py ws://127.0.0.1:8000     # 51-check protocol gate
python test_sse.py   http://127.0.0.1:8000   # 33-check SSE+POST fallback gate
python test_idle.py  ws://127.0.0.1:8000 5   # hold a connection open on heartbeat alone
```

`test_idle` is the one worth running against a *deployed* relay rather than
localhost — nothing on your own machine reaps an idle connection, which is
exactly what it is looking for.

---

## 5. Changing the landing page

The landing page (`index.html` + `src/landing/`) is a separate document from the
app. `src/landing/tags.js` carries its Google Analytics and AdSense, switched on
by `GOOGLE` in `src/core/config.js`; the app has its own copies in
`src/ui/features/analytics.js` and `ads.js`.

Both tags run in the app too since 2026-08-09, when the no-ads-in-the-app rule
was removed. The constraint that survives it: AdSense reports the page URL with
no override, so the app's ad unit mounts only after boot has stripped the share
key from the fragment — never touch that ordering. gtag gets `pageLocation()`,
which strips the fragment, on every surface. `app.html` declares the same CSP
as the crawlable pages and `tools/check/site-check.mjs` asserts all three
declarations agree — see `docs/ARCHITECTURE.md` §5 before touching any of them.

### The grid

Everything is built on one idea. A fixed set of vertical rules is drawn once for
the whole document (`.rules`), and every content grid splits the *same*
container into the *same* number of equal columns, so section content lands on
those rules instead of floating over them. `--cols` changes both.

Two variables control the whole layout:

- **`--cols`** — 3, then 2, then 1 at the breakpoints.
- **`--gut`** — the inset between a column's rule and the content inside it.
  Every grid cell and every full-width block carries it. This is what keeps type
  and panel borders *off* the hairlines.

When you add a block to the landing page, give it `padding-inline: var(--gut)`
(or `margin-inline`, if it has a border that must come inside the rules too).
Spans are the other half of it: most sections put the label in column 1 and the
prose in 2–3. The live section deliberately inverts that — one column of numbers,
two of globe — because it is the only section with something to *look* at.
And size loose prose in **columns, not characters**: a `max-width` in `ch` lands
wherever the font happens to put it, which is how the FAQ ended up with a rule
drawn through every answer. `calc(200% / 3)` is two columns; the breakpoints
restate it for 2- and 1-column layouts.

### The globe

`src/landing/globe.js` draws the continents from a land mask in
`src/landing/land.js` — a bit per cell of a 360 × 180 equirectangular grid (1° a
side), packed eight to a byte and base64'd. About 10.8 kB for the whole
coastline of the world, on a module that is not fetched at all until the section
comes near the viewport.

**`land.js` is generated. Do not hand-edit it.** To change the resolution or the
source data:

```bash
# Natural Earth 1:110m land, public domain
curl -o land.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson
node tools/build/build-land-mask.mjs land.geojson          # 1° — what ships
node tools/build/build-land-mask.mjs land.geojson 1.5      # coarser, 4.8 kB
```

That writes `src/landing/land.js` and prints the land-cell count. It is **not a
build step** — nothing at deploy or test time runs it, and the output is
committed like any other source file. Pick the resolution against the size the
globe is *drawn* at, not against how much detail the source has: at a 600px
sphere one degree is about four pixels at the equator, so finer buys nothing you
could see and costs bytes on the one page search engines fetch.

Dot spacing is **not** the mask resolution — `stepFor()` picks it from the
radius so the gap between dots stays around 5px at any size, and rebuilds the
field when that changes. This is why the globe can go from a 240px thumbnail to
a 600px centrepiece without the continents either turning to confetti or
clogging into a solid blob. The mask resolution is the floor: sampling finer
than the source just draws the same cell twice and gives coastlines a staircase.

The module has one rule that is worth keeping: **it draws what the relay
reports, and nothing else.** No floor, no demo mode, no seeded traffic. Motion
is allowed from three places only — the globe turning, your pointer, and a
marker easing in or out because the numbers actually changed. Arcs between
countries are absent on purpose: `/stats` reports per-country totals and nothing
about who is paired with whom, so an arc would be a drawing of something we do
not know.

One trap if you touch the animation: **never make visibility depend on a frame
arriving.** Anything that eases checks `canAnimate()` — on screen, tab visible,
motion not reduced — and jumps straight to its target when that is false. An
earlier version faded markers in from zero unconditionally, which meant any
browser throttling `requestAnimationFrame` showed a permanently blank globe.

---

## 6. Checking a UI change for real

The test suite does not look at pixels. For anything visual, drive a browser.
Headless Chrome is enough and needs no driver:

```bash
python -m http.server 8080 &
chrome --headless=new --disable-gpu --hide-scrollbars \
       --window-size=1360,1000 --virtual-time-budget=20000 \
       --screenshot=out.png "http://127.0.0.1:8080/index.html"
```

Then **look at the screenshot.** A blank frame is a failure to launch, not a
pass.

Three headless quirks that will waste your afternoon if you do not know them:

- **Windows clamps the window to 484 CSS px wide.** `--window-size=390,…` does
  not give you a phone; it gives you a 484 px layout cropped to 390, which looks
  exactly like a horizontal-overflow bug. To test a real phone width, put the
  page in a 390 px-wide `<iframe>` — the frame gets its own viewport.
- **`--virtual-time-budget` accelerates timers, not the CPU.** A `setTimeout`
  fires immediately in real time while PBKDF2 is still crunching its 250,000
  iterations, so the app looks stuck at "deriving key". If you are testing
  anything that races real work, drop virtual time and give the process real
  wall-clock seconds instead.
- **`requestAnimationFrame` barely runs.** Expect a handful of frames over
  several virtual seconds, so anything mid-transition will be caught part-way.
  `--force-prefers-reduced-motion` settles every animation instantly and gives
  you a deterministic frame to compare.

Headless follows the OS theme and ignores `--force-light-mode`, so to check the
light palette, inject the `prefers-color-scheme: light` token values as a plain
`:root` block into the page.

---

## 7. Conventions

- **No dependencies, no build step.** Adding either is an architecture decision,
  not a convenience; see ARCHITECTURE.md §1 before reaching for one.
- **Comments say *why*.** The code already says what. A comment that restates
  the line above it is noise; one that records the bug that forced the line is
  the reason anyone can safely change it later.
- **Every constant lives in `src/core/config.js`.** A magic number anywhere else
  is a bug in the making.
- **Contain failures at boot.** Each feature is started inside a `try` so one
  throw cannot take out everything after it — a lesson `tests/live/boot.mjs` exists
  to enforce.
- **The relay learns nothing.** It sees a room hash and ciphertext, keeps
  neither, and is never told anything about the visitor. Any change that widens
  that needs to argue for itself in the PRD first.
