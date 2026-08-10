# Launch kit — the copy, ready to paste

`SEO.md` §6 settles **where** to post and what each channel's rules are. This file is the other
half: the **text to submit**, written once so the same claims go out everywhere and a correction
has one place to happen.

Nothing here is scheduled. `SEO.md` §6 sets a hard timing gate — **hold every public channel until
two devices actually sync end to end** — and §10 items 12–16 list the objections that will be
raised on the day. Read both before using any of this.

**That timing gate was met on 2026-08-09** (§7.2 item 2: two real browser windows, by hand). The
remaining constraint on the date is AlternativeTo's one-week account rule, which puts the earliest
launch day at **2026-08-16** (§3, §7.3).

---

## 1. The one string, and its shorter forms

The repo description, the `<title>` tail, the `meta description` and the OG card already carry the
same sentence (`SEO.md` §5). Every listing below is a length-cut of it, not a rewrite. **If the
product changes, change it here first, then propagate** — the failure mode this prevents is four
listings each describing a slightly different tool.

**Canonical (repo description, 138 chars)**

> End-to-end encrypted online clipboard: sync clipboard text between devices and send files
> peer-to-peer. No account, no install - just a short key.

**Short (60 chars — store subtitles, directory taglines)**

> Encrypted clipboard sync between devices. No account.

**Medium (~250 chars — AlternativeTo, SourceForge, most directories)**

> RealtimeClipboard is a free, end-to-end encrypted online clipboard. Open the same short key on
> two devices and text you copy on one lands on the other's clipboard — across different networks,
> with no account and nothing to install. Files travel peer-to-peer.

⚠️ AlternativeTo descriptions **may not contain URLs** (`SEO.md` §6).

**Long (~600 chars — Microsoft Store, awesome-list PRs, Reddit body)**

> RealtimeClipboard is a free and open-source online clipboard. Open it on two devices, type the
> same short key on both, and whatever you copy on one is on the other's system clipboard ready to
> paste. There is no account, no email address and nothing to install — it runs in a browser tab,
> and installs as a PWA if you want it to.
>
> Text is encrypted in your browser with AES-GCM before it is sent. The relay is addressed by a
> hash of your key rather than the key itself, so it routes messages it cannot read, and it stores
> nothing on disk. Files skip the server entirely and go directly between the two browsers over
> WebRTC.
>
> It works between devices on different networks, which most tools in this space do not — they
> discover each other by broadcasting on the local network, and that stops at the router. MIT
> licensed; the relay can be self-hosted.

⚠️ **Two Reddit rows in `SEO.md` §6 also move.** r/PrivacyGuides and r/degoogle audiences will
find the ad and analytics tags and will lead with them — that is the documented pattern, not a
guess. Neither is now a good first-day channel. r/privacy was already comment-only.

**The caveats, which go in every long-form post.** Leaving them out is what turns a launch thread
into the QuickClip thread (`SEO.md` §6): the short key is a bearer credential · files capped at
5 MB · automatic clipboard capture needs a Chromium-based browser · no browser can read the
clipboard while its tab is in the background · P2P can fail on corporate networks and falls back
to a relayed transfer, labelled.

**"pre-alpha" was dropped from this list on 2026-08-07, and the replacement is not "nothing".** The
label was doing two jobs: a maturity signal, which was wrong — v0.4.0, 32/32 e2e against the
*production* relay, shipped desktop builds — and a shorthand for the caveats, which is redundant
now they are spelled out. A vague self-deprecation cannot be verified and cannot be outgrown, so a
reader just discounts everything else on the page; a specific limit is checkable, earns the
credibility, and gets retired one at a time. **Never trade the specific caveats away** — those are
the asset the QuickClip thread proves you need.

---

## 2. Titles

`SEO.md` §6 measured this: **the title is a checklist, not a headline.** PairDrop's 1,645-upvote
title ran verbatim across four subs with zero personality — every adjective pre-answers an
objection. Required tokens: Free · No Account · End-to-End Encrypted · Cross Platform · Browser
Based · Clipboard · Peer-to-Peer.

| Channel | Title |
|---|---|
| **r/InternetIsBeautiful** | RealtimeClipboard is a free, open-source, browser-based clipboard that syncs text between your devices with a short key — no account, end-to-end encrypted, and it works across different networks |
| **r/SideProject** | I built a browser-based clipboard that syncs between devices with a 10-character key — no account, no install, end-to-end encrypted |
| **r/coolgithubprojects** | RealtimeClipboard — end-to-end encrypted online clipboard, no account, files peer-to-peer over WebRTC |
| **r/opensource** | RealtimeClipboard: MIT-licensed encrypted clipboard sync between devices, no account, self-hostable relay |
| **r/webdev** *(Showoff Saturday only)* | Built an E2EE clipboard sync: WebRTC data channels for files, AES-GCM in the browser, and a relay that only ever sees SHA-256(key) |
| **r/degoogle / r/fossdroid** | ⚠️ **Not a launch-day channel — see below.** Free, open-source clipboard sync between Android and desktop — no Google account, end-to-end encrypted |
| **Hacker News** | RealtimeClipboard – an end-to-end encrypted clipboard shared by typing the same key |

⚠️ **Three corrections to this table, 2026-08-10.**

**The r/SideProject key length was wrong** — it read *6-character key*. Keys are `KEY.LENGTH = 10`,
and 16 on desktop. Six was dropped in v0.5.0 as a **defect**, not a preference: 29.4 bits, ~12
minutes on 100 rented GPUs against a single global salt (`src/core/config.js` `KEY`). That title
would have advertised the exact weakness the release fixed, to the one audience that checks.

**The Hacker News row said to lead on P2P file transfer.** §6 and §7.3 both later decided the
opposite and this row was never updated. The title above is clipboard-led, per that decision.

**The r/degoogle / r/fossdroid title claimed "no telemetry", which is no longer true.** AdSense and
GA4 went live on the crawlable pages on 2026-08-08 — `adsEnabled()` and `analyticsEnabled()` are
both true. §3 and §7.3 already removed both subs as launch-day channels for exactly that reason,
and §1 records the pattern: these audiences find the tags and lead with them. The claim is struck
from the title and the row is flagged, because a title that is checkably false is worse in these
two subs than no post at all. **Do not restore the phrase unless the tags come off** — the same
condition that closed `pluja/awesome-privacy` (§3).

**Hacker News, specifically.** §6 measured the ceiling: clipboard posts top out around 141 points
ever, file-sharing posts reach 923. It also found every large post in this category was a
**third-party plain link, not a Show HN**. And it flags the trap: **the 5 MB file cap will become
the top comment if you lead with files** — which is why §6 resolved to keep the cap and lead with
the clipboard anyway, giving up that ceiling deliberately. Resubmission is the strategy, not the
fallback — LocalSend's same URL scored 1, 4 and 3 before it scored 563.

**Why this title and not a punchier one.** HN titles are penalised for the adjective stacking that
works on Reddit — the PairDrop checklist formula is a Reddit formula. What earns the click here is
the mechanism, stated flatly: *typing the same key* is the whole product in four words, and it
raises the question the thread will want to answer (what does the server see?). Two alternates, both
mechanism-led, for a resubmission that changes nothing but timing:

- `RealtimeClipboard – encrypted clipboard sync where the relay only sees SHA-256(key)`
- `RealtimeClipboard – a clipboard two devices share without an account or an install`

Do **not** use "Show HN". §6 measured every Show HN in this category at 1–5 points, with the single
clipboard Show HN — *"I built a universal clipboard that syncs realtime on multiple devices"* — at
40. Plain links scored 923, 816, 563, 527, 476, 447.

### 2.1 Bodies, ready to post

§7.4 is the argument for all of these: the post is 10% of the work, and what decides the outcome is
whether the first objection is already answered. Every body below ends in the same caveat block,
which is §1's list unchanged. **Never trade the caveats away to tighten a post** — they are what
buys the credibility, and their absence is what turned the QuickClip thread.

**The caveat block** — paste verbatim, all five lines, every long-form post:

> Known limits, up front: the key is a bearer credential — anyone who has it can read the session,
> so treat a share link like a password. Files are capped at 5 MB and held in memory, 20 per
> session. Automatic clipboard capture needs a Chromium-based browser; Firefox and Safari can still
> send and receive anything you paste in. No browser can read the clipboard while its tab is in the
> background — that is a browser rule, not a bug in this. And a direct peer-to-peer connection fails
> on some corporate networks, where transfers fall back to a relayed path that is labelled as such
> in the UI.

**1 — r/coolgithubprojects** (morning, the dry run; repo link)

> An end-to-end encrypted online clipboard. Open it on two devices, type the same 10-character key
> on both, and what you copy on one lands on the other's system clipboard.
>
> Text is encrypted in the browser with AES-GCM before anything is sent. The relay is addressed by
> `SHA-256(key)` rather than the key, so it routes ciphertext it cannot read and stores nothing on
> disk. Files skip it entirely and go browser-to-browser over WebRTC.
>
> Zero runtime dependencies, MIT, and the relay is self-hostable. I'm the author.
>
> [caveat block]

**2 — r/InternetIsBeautiful** (+1h, the 1,000+ shot; link the **live site**, not GitHub)

Rule 6 bans sites requiring an email, name or account — lead with that, because it is the rule this
product was accidentally written for. Rule 2 removes "not unique" posts and both Snapdrop and
PairDrop have already run here **as file tools**, so the clipboard is the angle that survives it.

> There's no sign-up, no email box and nothing to install — you open the same page on two devices,
> type the same short key on each, and they share a clipboard. Copy on the laptop, it's on the
> phone. It works across different networks, not just the same Wi-Fi, which is where most tools in
> this space stop.
>
> Everything is encrypted in your browser before it leaves. The server is addressed by a hash of
> your key instead of the key itself, so it forwards messages it cannot decrypt, and it writes
> nothing to disk — close the tab and the session is gone. Files go directly between the two
> browsers and never touch it at all.
>
> Free and open source (MIT). I built it.
>
> [caveat block]

**3 — r/SideProject** (+2h; author voice is fine here)

> I wanted to paste a URL from my laptop onto my phone without emailing it to myself, and every
> option was an account, an install, or the same Wi-Fi network. So this is the version with none of
> those: same page on both devices, same 10-character key, shared clipboard.
>
> The part I'd want feedback on is the sync model. It's one setting with three rungs — off, sync
> inside the window, or wire the OS clipboard both ways — because a clipboard that syncs everything
> also syncs the password you copied two minutes ago. Getting that default right mattered more than
> any feature.
>
> Encrypted in the browser with AES-GCM, relay addressed by `SHA-256(key)` and stores nothing,
> files peer-to-peer over WebRTC. MIT, self-hostable, zero runtime dependencies.
>
> [caveat block]

**4 — r/opensource** (+3h; needs correct flair, and Rule 6 removes drive-by posts — budget the hour)

> MIT-licensed, zero runtime dependencies, and the relay is a single self-hostable service with a
> Dockerfile — it shares no code with the frontend, only a documented protocol.
>
> Text is encrypted in the browser with AES-GCM. The key never leaves it: what reaches the relay is
> `SHA-256(key)` as a room address plus ciphertext, so a hosted relay learns which rooms exist and
> nothing about what is in them. Signalling and cursor frames are sealed the same way, or the relay
> would learn every SDP and peer IP. Files go browser-to-browser over WebRTC.
>
> Four surfaces share one codebase: the web app, a Node CLI, a Tauri desktop shell, and the
> landing site. Threat model is in the repo at `docs/THREAT-MODEL.md` — including what it does
> *not* defend against.
>
> I'm the author, and I'd rather have the crypto picked apart here than after launch.
>
> [caveat block]

**5 — Hacker News** (+4h; plain link, then post this as your own first comment immediately)

§7.4: someone *will* open DevTools. Two things in this comment are non-negotiable — it discloses
authorship, and it volunteers PBKDF2 before anyone finds it. `SEO.md` §10 item 13 flagged that HN
named Argon2 as the successor in the QuickClip thread and **that item was never actioned**:
`CRYPTO.ITERATIONS` is still PBKDF2 at 250k (600k locked). Owning it costs one sentence; being
caught on it costs the thread.

> Author here. The short version of the design, since it's the part worth arguing about:
>
> The key is 10 characters from a 30-character alphabet (16 on desktop), and it never leaves the
> browser. One PBKDF2 pass over it yields both the AES-GCM content key and the room address the
> relay is indexed by, so the relay sees `SHA-256`-derived room IDs and ciphertext, holds sessions
> in memory, and writes nothing to disk. Files skip it and go over a WebRTC data channel.
>
> On the crypto, before anyone has to dig: it's PBKDF2 at 250k iterations, 600k for PIN-locked
> rooms — not Argon2. WebCrypto has no Argon2, so using one means shipping WASM into the page that
> handles decrypted clipboard text, and I judged that a worse trade than a well-understood KDF with
> a keyspace large enough to make offline search pointless. The salt is a single global constant,
> which is why the key length is 10 and not 6 — six was 29.4 bits and roughly 12 minutes on 100
> rented GPUs, and it shipped that way until v0.5.0. Share links created before that release
> stopped working, deliberately.
>
> Threat model, including what it doesn't defend against:
> https://github.com/akshaynikhare/RealtimeClipboard/blob/main/docs/THREAT-MODEL.md
>
> [caveat block]

**On the 5 MB cap, when it comes up — and it will.** §7.4: never argue. Agree, say why, say what
would change it. *"Agreed, it's low. It's the relay fallback that sets it — when P2P fails, chunks
go base64'd through a JSON envelope that caps them around 18 KB, and files are held in RAM on both
ends besides. Doing it properly means streaming to disk through the File System Access API, which
isn't built yet."*

---

## 3. Product boards and directories

Ordered by the expected value measured in `SEO.md` §6. Every one of these is free.

| Target | Status | The submission |
|---|---|---|
| **AlternativeTo** | ✅ Account created **2026-08-09**; the one-week maturity rule makes it submittable from **2026-08-16** | Tag `clipboard-sync`. List as an alternative to **KDE Connect** (the big funnel), Pushbullet, and Apple Universal Clipboard. Use the Medium string, **no URLs in it**. Do *not* position as a clipboard *manager* (saturated) or as a Snapdrop clone (declined on sight) |
| **nuzulul/awesome-webrtc** | ✅ **Submitted 2026-08-10** — [PR #13](https://github.com/nuzulul/awesome-webrtc/pull/13), open | File Transfer, between `Peertransfer` and `ShareDrop`. `CONTRIBUTING.md` rules checked off in the PR body — the binding one is *don't repeat the resource name in the description* |
| **hemanth/awesome-pwa** | ✅ **Submitted 2026-08-10** — [PR #459](https://github.com/hemanth/awesome-pwa/pull/459), open | Tools and Utilities, between `QR Code Scanner` and `Remember`, on `master` |
| **pluja/awesome-privacy** | ❌ **Closed as of 2026-08-08.** The condition this row warned about has happened: AdSense and GA4 are live (`adsEnabled()` and `analyticsEnabled()` both true), and the list requires *no user-tracking on the project website*. Do not submit — a rejection here is public and is worse than an absence. Revisit only if the tags come off |
| **Microsoft Store via PWABuilder** | ✅ Registration is now free | Start at `storedeveloper.microsoft.com` — entering via Partner Center lands in the legacy paid flow. Review 24–48h. Bonus: Store installs send `Referer: app-info://platform/microsoft-store`, which is free install attribution |
| **awesome-selfhosted** | ⏳ Blocked until ~December 2026 (4-month rule from first release) | PR `awesome-selfhosted-data`, not the main list. Copy `software/privydrop.yml` as the template. Needs the Dockerfile — §10 item 16 |
| **GitHub social preview** | ✅ Uploaded **2026-08-09** | Settings → Social preview → `assets/social/og-card.png`. **Re-upload whenever the card is regenerated** — GitHub keeps a copy, not a reference. The REST field `uses_custom_open_graph_image` still read `null` right after the upload; the rendered card is the thing to trust, not that field |
| **Product Hunt** | ❌ Skip | LocalSend: 86,691 GitHub stars, **3 Product Hunt upvotes**. The category does not launch there |
| **Chrome Web Store** | ❌ Skip | Extensions and themes only; a wrapper extension is a standard rejection |
| **Wikipedia / Privacy Guides / BetaList / SaaSHub** | ❌ Skip for now | Each needs independent coverage or a security white paper that does not exist yet |

### 3.1 The two awesome-list lines, ready to paste

Both conventions read off the live lists on **2026-08-08**. They disagree with each other on every
detail — bullet character, separator, and whether the link is the repo or the site — so these are
transcribed rather than written. **Match the neighbours, not each other**: a line that does not look
like the ones around it is the standard reason an awesome-list PR is closed without discussion.

Each is one commit on a fork, one PR, no issue first.

✅ **Both submitted 2026-08-10**, exactly as transcribed below — the placements and both repos'
default branches were re-verified against the live lists on the day and had not moved. Each PR is a
single `+1/-0` line. Nothing here needs doing again unless a maintainer asks for a change.

**`nuzulul/awesome-webrtc`** — `README.md` → `### File Transfer`. Hyphen bullet, ` - ` separator,
trailing full stop, **repo** link. Alphabetical: insert after `Peertransfer`, before `ShareDrop`.

```markdown
- [RealtimeClipboard](https://github.com/akshaynikhare/RealtimeClipboard) - End-to-end encrypted clipboard sync between devices, with files sent peer-to-peer.
```

**`hemanth/awesome-pwa`** — `README.md` on the **`master`** branch, capitalised, → `### Tools and
Utilities`. Asterisk bullet, `: ` separator, no trailing stop, and this list links the **live app**
rather than the repo. Alphabetical: insert after `QR Code Scanner`, before `Remember`.

```markdown
* [RealtimeClipboard](https://realtimeclipboard.com/): End-to-end encrypted clipboard sync between devices — type the same short key on each, no account. Files go peer-to-peer over WebRTC. Open-source (MIT)
```

Neither link is worth anything as PageRank — every external link on GitHub is `nofollow`
(`SEO.md` §5). These are for discovery and for being quotable by an answer engine, which is why the
`awesome-pwa` line spends its length on what the thing *is* rather than on adjectives.

---

## 4. Search console registration — do these first, they gate everything else

1. **Google Search Console — Domain property** for `realtimeclipboard.com`, verified by **DNS TXT
   record**. A Domain property covers `www`, the apex and every scheme at once; the old `github.io`
   host was on the Public Suffix List and could never have one. Submit `sitemap.xml`. Request
   indexing **once** — re-submitting burns quota and speeds nothing.
2. **Bing Webmaster Tools** — register by **importing from Search Console**, which auto-verifies.
   Its **AI Performance report** reports Citations and grounding queries: the only first-party
   readout of query fan-out that exists anywhere, and free.
3. **IndexNow** is already wired — `npm run seo:indexnow`. It reaches Bing, Yandex, Seznam and
   Naver in one call. Google does not participate. Run it **after** a deploy is live, never before:
   the endpoint fetches each URL to verify it, so submitting early records a 404.
4. **Verify Cloudflare is not blocking answer-engine crawlers.** Measured 2026-08-07: it is not,
   and structurally cannot be while both DNS records stay `DNS only` — the zone security pipeline
   only runs on proxied traffic. Do not take that on trust after any DNS change; the check is one
   command and needs no dashboard access:

   ```bash
   for ua in OAI-SearchBot ClaudeBot PerplexityBot Googlebot bingbot; do
     echo "$ua $(curl -s -o /dev/null -w '%{http_code}' -A "$ua" https://realtimeclipboard.com/)"
   done
   ```

   Anything other than `200` means the edge is filtering. If it ever is: the control is under the
   zone's **Security → Bots** / **AI Crawl Control** section (Cloudflare has moved and renamed it
   more than once — look for AI crawlers or "Block AI bots", and note Cloudflare began enabling it
   by default for new zones in 2025). Allow `OAI-SearchBot`, `Claude-SearchBot` and
   `PerplexityBot` at minimum; blocking `GPTBot` costs nothing, since it is training-only.

5. **`www` is currently `HTTP 522` — fix before any launch.** DNS is fine: `www` CNAMEs to
   `realtimeclipboard.pages.dev`, resolves to Cloudflare, and TLS completes (a 522 means the
   handshake succeeded). What is missing is a route — `www` is not attached to the Pages project,
   so the edge terminates the connection and has nowhere to send it.

   **Do not fix it by adding `www` as a Pages custom domain.** That makes it serve a second copy
   of the whole site at a second hostname: split ranking signals and two separate service-worker
   registrations. `www` should redirect, not serve. `_redirects` cannot express it — that file
   matches paths, not hostnames.

   **Step 1 — proxy the `www` record.** DNS → Records → the `www` CNAME → Edit → set **Proxy
   status** to **Proxied** (orange cloud) → Save. A Redirect Rule only runs on proxied traffic, so
   this is what makes step 2 possible. Leave the **apex on `DNS only`**: proxying it is what would
   put it behind the AI-crawler blocking in item 4, and it is serving correctly as it is.

   **Step 2 — create the redirect.** Rules → **Redirect Rules** → Create rule. Newer dashboards
   offer a **"Redirect from www to root domain"** template, which does all of this; if you see it,
   use it and skip to step 3. Otherwise, by hand:

   | Field | Value |
   |---|---|
   | Rule name | `www to apex` |
   | If — custom filter expression | `(http.host eq "www.realtimeclipboard.com")` |
   | Then — Type | **Dynamic** |
   | Expression | `concat("https://realtimeclipboard.com", http.request.uri.path)` |
   | Status code | **301** |
   | Preserve query string | ✅ |

   Dynamic rather than Static, because a static target drops the path: `www…/help/` has to land on
   `/help/`, not on the homepage. Same reasoning as the `:splat` note in `_redirects`.

   **Step 3 — verify.** Both must pass:

   ```bash
   curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' https://www.realtimeclipboard.com/help/
   #   expect: 301 -> https://realtimeclipboard.com/help/

   curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://www.realtimeclipboard.com/
   #   expect: 200 https://realtimeclipboard.com/
   ```

   Then re-run the crawler check in item 4 — `www` is now proxied, so the zone security pipeline
   applies to it for the first time.

---

## 5. The one video

> **Dropped for this launch — 2026-08-09.** The video is not being made, and §7.2's "do not launch
> without it" no longer gates the day. What that costs is what this section already argues it is
> worth: every channel in §7.3 posts without an embeddable demo, and the README shares as a still.
> The clipboard claim then has to survive on the copy in §1 and on the site itself, so the caveat
> block matters more, not less. The shot list below stands unchanged for whenever it is recorded —
> post-launch is a normal time to do it, and §5's own measurement (under 150 views, YouTube coverage
> trailing Hacker News by ~10 days regardless) is why this is a deferral and not a loss.

`SEO.md` §6: founder demo videos in this niche all measured under 150 views, and YouTube coverage
follows Hacker News by about ten days without anyone pitching it. So make exactly one asset — a
**45–90 second silent screen recording** whose only job is to be embeddable in the README and
droppable into comments. Two devices, one key, copy on the left, paste on the right. No voiceover,
no intro, no logo.

Worth an email only *after* traction: **Brodie Robertson** (`brodierobertsonbusiness@gmail.com`)
and **Lon.TV** (`lon@lon.tv`). Both explicitly invite suggestions.

### The shot list

Two windows side by side, or a phone beside a laptop — the second is more convincing and harder to
film. Screen recording only, no camera, no voice, no music, no intro card. Target 60 seconds.

| t | Shot | The point it makes |
|---|---|---|
| 0–5s | Left window: open the app. A key appears. | No sign-up screen. Nothing was installed. |
| 5–12s | Right window: type the same key. Both show connected. | The whole setup is one short string. |
| 12–25s | Left: select a paragraph, `Ctrl+C`. Switch to right, `Ctrl+V`. It pastes. | **The one thing to show.** It lands on the *system* clipboard — not a message you copy out of a box. |
| 25–35s | Right: copy something. Switch to left. Paste. | Both directions, no configuration. |
| 35–48s | Drag an image onto the left. It appears on the right. Save it. | Files, peer-to-peer. |
| 48–60s | Close both tabs. Reopen. Session gone. | Nothing persisted — the privacy claim, shown rather than asserted. |

Record at 1280×720 or larger and keep the text legible at half size; most of its life is an
embedded thumbnail in a README or a comment. Export a GIF **and** an MP4 — GitHub renders the GIF
inline, Reddit and HN want a link.

**Do not narrate the caveats in the video.** They belong in the post body, where they can be read
and quoted accurately. A 60-second video that spends 15 seconds on disclaimers converts nobody and
reassures nobody.

---

## 6. The 5 MB cap — decided: do not raise it for this launch

`SEO.md` §6 flags it as a launch risk twice: the file-sharing ceiling on Hacker News is 923 points
against the clipboard's ~141, **but "the 5 MB file cap will become the top comment if you lead with
files."** Both are true, and they point in opposite directions. This is the resolution.

**What actually constrains the cap.** Not WebRTC — a data channel will stream far more than 5 MB in
32 KB chunks. Two other things do:

1. **The relay fallback.** When P2P fails, chunks go through the relay base64'd inside a JSON
   envelope, which caps them at ~18 KB — 289 chunks for a 5 MB file, inside the relay's 400
   chunks/sec bulk allowance. Raise the file cap and the fallback path is what breaks, on exactly
   the corporate networks it exists to serve.
2. **Memory.** Files are held in RAM, 20 per session, on both ends. Doing large files properly
   means streaming to disk through the File System Access API, which is real work and does not
   exist yet.

**So the honest options were:** raise it properly (weeks, and the fallback needs its own answer),
raise it carelessly (ship a cap that breaks on the networks that most need the fallback), or keep
it and stop leading with files.

**Keep it, and lead with the clipboard everywhere — including Hacker News.** Three reasons:

- The cap is only fatal *if files are the pitch*. Nobody objects to a 5 MB limit on a clipboard
  tool that also happens to send images.
- **r/InternetIsBeautiful needs this anyway.** Rule 2 removes "not unique" posts, and Snapdrop and
  PairDrop have both already run there *as file tools*. Leading on files invites the removal;
  leading on the clipboard is the thing neither of them does.
- It gives up the 923-point HN ceiling, which is a real cost. Take it: a plain link that survives
  its comment thread beats a higher-ceiling framing that gets dismantled in the first reply.

Say the cap plainly in the caveat block rather than waiting to be asked. **Revisit HN with a
file-led submission once streaming-to-disk lands** — §6 already establishes that resubmission is
the strategy and that LocalSend's same URL scored 1, 4 and 3 before it scored 563.

## 7. Launch day — the runbook

GitHub Trending ranks star *velocity* against a repo's own baseline, so a zero-star repo needs a
concentrated spike rather than a large one. Spreading launches across three weeks guarantees you
never trend. That is the whole argument for doing this in one day.

### 7.1 Pre-flight — re-verified 2026-08-09

Everything below was measured, not assumed. Re-run before the day; the commands are in §4 and §5.

| Check | State |
|---|---|
| All 18 sitemap URLs | 200 — `/live-clipboard/` re-checked 2026-08-09, the last unverified row |
| `og:image` | 200, 1200×630, badge reads **BETA** |
| `www` → apex | 301, path **and** query preserved |
| `http` → `https` | 301 |
| `OAI-SearchBot` · `ClaudeBot` · `PerplexityBot` · `Googlebot` · `bingbot` | all 200 — Cloudflare is not filtering |
| IndexNow key | validated (submission returns **200**, no longer 202) |
| Search Console · Bing | verified, sitemap submitted |
| `/download/` for an anonymous visitor | **v0.6.0**, 8 assets, every platform |
| Repo | MIT · 20 topics · correct description · homepage set · social preview uploaded |
| Soft-404 | a bogus path returns **404**, not the homepage at 200 |
| `npm test` against a relay | 0 failures, **0 skipped** — a skipped suite is not a pass |
| `npm run build:site` | site-check passes, 117 files |

### 7.2 Four things to settle first — all settled 2026-08-09

1. ~~**Record the demo** (§5).~~ **Dropped**, and no longer a gate — §5 records what that costs.
2. ✅ **Two-way typing checked by hand**, in two real browser windows. The Playwright observation —
   the device that *joined via the link* having its later local edits reverted seconds after
   receiving a clip — did not reproduce with real OS focus, which is what the clipboard path gates
   on. It was the headless-focus artefact it looked like.
3. ✅ **v0.6.0 is published**, not a draft: 8 assets, every platform, so the Releases page and
   `/download/` now both serve v0.6.0 rather than v0.5.0.
4. ✅ **GitHub social preview uploaded** (§3), so the repo no longer shares as a grey box.

**The code gate is green too**, measured the same day: `npm test` against a relay passes with 0
failures and nothing skipped, and `npm run build:site` passes site-check. That matters here because
`.husky` is the only gate there is — there is no CI for the app, and a merge to `main` *is* the
deploy.

### 7.3 The order, and what changed from `SEO.md` §10 item 17

Three revisions, each with its reason recorded elsewhere in this file:

- **AlternativeTo moves off the day entirely** — submit it days ahead (§3). It is a moderated
  directory, not a velocity-ranked feed; a listing that is still pending on the day helps nobody.
- **`pluja/awesome-privacy` is out**, and r/PrivacyGuides and r/degoogle are no longer good
  first-day channels. AdSense and GA4 are live (§3).
- **Lead with the clipboard on Hacker News too**, not P2P file transfer. §6 has the argument: the
  file framing has the higher ceiling and the 5 MB cap makes it the top comment.

| # | When | Channel | Notes |
|---|---|---|---|
| 0 | days before | **AlternativeTo** | account created 2026-08-09, so submittable from **2026-08-16** — that date is the earliest the day can be |
| 1 | morning | **r/coolgithubprojects** | ✅ **Posted 2026-08-10.** The dry run. Low ceiling (top hot post: 49), no promo rule, and it surfaces the first objections while the stakes are nil |
| 2 | +1h | **r/InternetIsBeautiful** | ✅ **Posted 2026-08-10 — the one shot is spent.** 🥇 the only 1,000+ shot. Clipboard-led. Link the **live site**, not GitHub. Rule 6 bans sites needing an email — written for this. Rule 8 removes posts whose site buckles |
| 3 | +2h | **r/SideProject** | ✅ **Posted 2026-08-10.** No configured rules, best reach-to-risk |
| 4 | +3h | **r/opensource** | ✅ **Posted 2026-08-10.** Needs correct flair and hours in the comments; Rule 6 removes drive-by posts |
| 5 | +4h | **Hacker News** | ⬜ **Not posted.** Plain link, **not** a Show HN. Every large post in this category was a plain link. Title and first comment: §2 and §2.1 |
| — | next day | **Brodie Robertson / Lon.TV** | only *after* traction. They mine HN and Reddit anyway |
| — | ~Nov 5 | r/selfhosted | 3-month rule. Megathread or a Wednesday tools post |
| — | ~Dec 7 | awesome-selfhosted | 4 months from first release. PR `awesome-selfhosted-data` |

**What actually happened, 2026-08-10.** All four Reddit channels went out on the 10th rather than
on or after the 16th that row 0 sets as the earliest possible day, and Hacker News did not go with
them. Recording it because two things in this section were predicated on the opposite:

- **The one-day rule was for star velocity.** GitHub Trending ranks a repo against its own
  baseline, so the concentrated spike was the entire argument for firing together (§7). Reddit
  landing without HN splits that spike across two days, and HN is the larger half.
- **Row 0's date came from AlternativeTo's one-week account rule**, not from readiness. That
  submission is the only item the date actually gated.

**The live consequence: §7.4 is now the work, not the posting.** Four threads are open and the
first three hours decide them. Answer the crypto question before it is asked, link
`docs/THREAT-MODEL.md` in your own first comment, never argue the 5 MB cap, disclose authorship,
and do not ask for stars. **PR #46 is also unmerged**, so the site those threads point at does not
yet carry the schema and favicon fixes — merging is what deploys them.

For HN, whenever it goes: the title and the full first comment are ready in §2 and §2.1, and the
first comment volunteers PBKDF2 before the thread finds it.

Spacing them by an hour is deliberate: it is how many comment threads one person can actually hold
at once, and an unanswered thread in the first hour is what kills a post that was otherwise fine.

### 7.4 The first three hours are the work

The post is 10% of it. From the two threads in §6 that went wrong, what decides the outcome:

- **Answer the crypto question before it is asked.** Link `/docs/THREAT-MODEL.md` in your own first
  comment. Someone *will* open DevTools. You have the rare advantage of having published the
  weakness and then fixed it — say so plainly, including that share links from before v0.5.0 broke.
- **Never argue with the 5 MB cap.** Agree, say why (relay fallback and browser memory), say what
  would change it (streaming to disk). §6.
- **"Why not KDE Connect / Syncthing / just email yourself"** — answer on the site already. Lead
  with "use it if it fits", then the four cases it rules out.
- **Do not ask for stars.** r/PrivacyGuides bans it outright and every other audience reads it the
  same way.
- **Disclose that you are the author** everywhere. It costs nothing and its absence is fatal.

### 7.5 If it flops

**A dud is not a verdict.** PairDrop's first two r/InternetIsBeautiful attempts scored **1 upvote
each** before the third hit 1,645, and LocalSend's *same URL* scored 1, 4 and 3 on HN before it
scored 563, then 447, then 923. Nothing material changed between the 3 and the 563.

So: **resubmission is the strategy, not the fallback.** Wait three months, change nothing but the
timing, post again. The realistic target here is **150–300 upvotes**, not 1,600 — ClipCascade, the
true analogue, got 158 in r/selfhosted and is at 1.9k stars today.

And the calibration that matters most: **LocalSend, the project that actually won this category at
86.8k stars, never had a big Reddit post at all.** Budget this day as a credibility beachhead, not
as the growth engine.
