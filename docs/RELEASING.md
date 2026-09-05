# Releasing

How code gets from a branch to users, and why it works this way.

---

## The shape of it

```
  branch ──commit──►  hooks run the tests here, before the commit exists
     │
     └──merge──►  main ──► Cloudflare Pages builds and deploys the site
                    │
                    └── npm run release -- minor
                            verifies, writes the changelog, opens the release PR,
                            squashes it into main, then tags what main ended up with
                                    │
                                    └── tag v1.2.0 ──► .github/workflows/release.yml
                                            CLI, desktop builds, relay image
```

Note that the two arrows out of `main` are now independent, and that is a change
worth understanding before you rely on it. **The site deploys on merge; the
release artifacts deploy on tag.** Merging a copy fix to `main` puts it in front
of users within about a minute without producing a version — which is the point
— but it also means "merged" and "live" are the same event for the frontend, and
the tag no longer gates it. The `.husky` hooks are therefore the only thing
standing between a commit and production for the web app.

If that becomes uncomfortable — a second contributor, or one bad merge — the fix
is to point Cloudflare's *production branch* at a `release` branch and fast-
forward it from `main` deliberately. Pages settings, no code change.

Every rule that follows from that diagram is enforced rather than trusted:

| Rule | Enforced by |
|---|---|
| No commits directly on `main` | `.husky/pre-commit` |
| Every change to `main` arrives as a squashed pull request | the ruleset on `main` — no bypass actors, the release included |
| Tests pass before a commit exists | `.husky/pre-commit` → `npm run verify` |
| A commit says what kind of change it is | `.husky/commit-msg` |
| A broken site is never promoted | `tools/check/site-check.mjs`, in the Cloudflare build |
| Only a tag ships CLI/desktop/extension/relay | `.github/workflows/release.yml` — its only trigger is `push: tags: v*` |
| And only a tag `main` already contains | `release.yml` → *Refuse a tag that is not on main* |
| Nothing else builds anything, anywhere | no workflow has a branch trigger; Pages previews are off |

---

## Where the site is deployed

**Cloudflare Pages, at `realtimeclipboard.com`.** Settings live in the Cloudflare
dashboard rather than in this repo, so they are recorded here:

| Setting | Value | |
|---|---|---|
| Production branch | `main` | |
| Automatic deployments — **Production** | Enabled | this is the thing that deploys on merge |
| Automatic deployments — **Preview** | **Disabled** | the build budget; see below |
| Build command | `npm run build:site` | |
| Build output directory | `_site` | |
| Root directory | *(blank — the repo root)* | |
| Build watch paths | Include `*` | deliberately everything; see below |
| Build system version | `3` | |
| Build cache | Enabled | fewer build *minutes*, same build *count* |
| Build comments | Enabled | |
| `NODE_VERSION` | `22` | plaintext variable, not a secret |

The two *Automatic deployments* rows are one setting seen twice: **Settings →
Build → Branch control** shows the production half when the environment picker
at the top of the page says *Production*, and the preview half when it says
*Preview*. Switching that picker is the whole change — there is no preview
setting on the Production view to find.

`npm run build:site` is `tools/build/build.mjs` followed by `tools/check/site-check.mjs`. The
second half is the gate: it asserts the required files exist, that the sitemap
and `robots.txt` name the canonical origin, that `app.html` still carries its
`noindex`, that the manifest has no SVG icon, and that the `_headers` CSP and the
`<meta>` CSP agree. A non-zero exit fails the build, and a failed build is not
promoted — production keeps serving the previous deploy.

### Preview deployments are off, and that is the build budget

Every non-production branch used to get a preview URL automatically. That is
what **Preview deployments: None** in the table above turns off, and it is the
single biggest lever on the build count: a branch pushed ten times over an
afternoon was ten builds, none of which anyone looked at. Cloudflare does not
charge for a build it *skips* — a skipped branch costs nothing against the
monthly quota, where a build that starts and then exits in four seconds still
counts as one.

So the trigger list for the whole project is now exactly two things:

| Push | What runs |
|---|---|
| a commit to `main` | Cloudflare Pages builds and deploys the site |
| a `v*` tag | `.github/workflows/release.yml` — CLI, desktop, relay image |
| anything else | **nothing** |

`.github/workflows/desktop.yml` is `workflow_dispatch` only, so it is a thing you
run, not a thing that happens.

**When you actually want a preview URL**, switch Branch control to *Custom* with
an include pattern — `preview/*` is the obvious one — push the branch under that
name, and switch it back. Nothing in the repo depends on preview URLs existing;
they were a convenience, and `npm run build:site && (cd _site && python -m
http.server 8080)` is the same bytes without the round trip.

Dashboard path: **Workers & Pages → the project → Settings → Build → Branch
control**. The same setting over the API, for reapplying it or checking it did
not drift:

```bash
curl -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/$CF_PROJECT" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":{"config":{"production_branch":"main","preview_deployment_setting":"none"}}}'
```

⚠️ Preview URLs, while they existed, were real, public and indexable by accident
— `robots.txt` was served from them too. Turning them off closes that as a side
effect, and it is a reason not to switch them back on casually.

### Build watch paths stay at `*`, and that is a decision

Watch paths are the obvious next lever — skip the build when a commit touched
nothing the site is made of — and they are set to `*`, everything, on purpose.

**The exclude list is much shorter than it looks, because `docs/` ships.**
`tools/build/build.mjs` copies `docs/`, `README.md`, `CHANGELOG.md` and
`changelog.json` into `_site` alongside `src/` and `assets/`. A docs-only commit
therefore *does* change the deployed site, and excluding `docs/*` — the first
thing anyone reaches for — would silently stop publishing it. What is genuinely
not an input is `backend/`, `cli/`, `desktop/`, `vscode/`, `deploy/`, `tests/`,
`.github/` and `.husky/` and `tools/release/`.

Which is a real but small saving, against a failure mode this repo goes out of
its way to avoid everywhere else: a skipped build looks exactly like a
successful one. Nothing goes red, the dashboard shows the previous deploy as
current, and the first symptom is someone asking why a change from last week is
not live. `site-check.mjs` cannot catch it — it never runs.

So: previews off is a *count* problem solved by a setting that fails loudly if
it is wrong. Watch paths trade a smaller saving for a silent failure. Revisit it
only if merges to `main` ever get close to the monthly quota, and if you do,
exclude only the eight directories above.

**It used to be GitHub Pages, on a tag.** The move happened because GitHub Pages
cannot set an HTTP response header at all, which left `frame-ancestors` and
`Strict-Transport-Security` unavailable to a product whose pitch is
end-to-end encryption — see `_headers`.

There was a `.github/workflows/tombstone.yml` to go with it, which would have
replaced the old origin with a redirect and a self-deleting service worker. It
was never run, and it is now deleted. GitHub Pages went down on its own — the
old origin already answers GitHub's own *Site not found* 404 — so the workflow
had nothing left to publish over. The cost is real: every link ever shared to
the old origin now dies there rather than redirecting, and `_redirects` catches
only the requests that already reach this host.

---

## Why the tests are not on GitHub

The workflows in this repository build release artifacts. Nothing in them gates
a normal commit, and **no workflow has a branch trigger at all**. That is
deliberate.

CI runs *after* a push. By the time it goes red, the mistake is already in the
history, already fetched by anyone who pulled, and the fix is a second commit
that exists only to undo the first. A hook runs *before* the commit exists, so
the mistake never happens. The feedback is also immediate — no queue, no
runner boot, no waiting for a log to stream.

There is a second reason, and it is arithmetic rather than principle. Build
minutes and Cloudflare builds are both metered monthly, and a branch-triggered
workflow spends them at the rate you push — which, on a branch, is the rate you
think, not the rate you finish. Every automatic trigger was therefore paying for
an answer the hooks had already given locally, before the push, for free.

**The honest cost:** the gate is only as good as the machine it runs on. A hook
can be skipped with `--no-verify`, it only sees the machine's own Node version,
and it cannot prove the code works on anything else. That is a real trade, taken
knowingly for a project of this size. If this ever grows a second regular
contributor, or starts supporting a runtime nobody develops on, put the suite
back on GitHub as a required check for pull requests — the hooks stay useful
either way, as the fast first pass.

---

## Day to day

```bash
git switch -c fix/clipboard-race     # main will refuse the commit
# … work …
git commit -m "fix(clipboard): stop the poller racing a restored clip"
git push                             # pre-push runs the relay-backed suites too
# … open a PR, merge it …
```

**Commit messages** need a type, because the changelog is generated from them:

```
feat      a user can now do something they could not before
fix       something that was wrong is no longer wrong
perf      same behaviour, less time or fewer bytes
refactor  same behaviour, different shape
docs      documentation only
test      tests only
build     dependencies, the service worker shell, deploy plumbing
ci        the hooks and the workflow themselves
chore     none of the above, and not worth a release note
style     whitespace and formatting only
```

Add `!` for a breaking change — `feat!: change the share link format` — or a
`BREAKING CHANGE:` footer. Either one hoists the entry to the top of the release
notes and marks the release in the app.

`feat`, `fix`, `perf`, `refactor`, `docs` and `build` appear in the changelog.
`chore`, `style`, `ci` and `test` do not: they are real work, they are in the
git history, and a release note is read by someone deciding whether an update
matters to them.

---

## Cutting a release

```bash
git switch main && git pull
npm run release -- minor        # or patch, major, or v1.4.2 exactly
```

That single command:

1. refuses if you are not on `main`, the tree is dirty, `main` is behind the remote, or `gh` is not logged in
2. runs `npm run verify`
3. writes `CHANGELOG.md` and `changelog.json` from the commits since the last tag
4. commits them with the version bump on `release/v1.2.0`, as `chore(release): v1.2.0`
5. pushes that branch, opens a pull request whose body is the changelog section, and squash-merges it
6. pulls `main`, and refuses to go on unless `main` now really carries that version
7. creates an **annotated** tag on the squashed commit, whose message is that release's changelog section, so `git show v1.2.0` tells you what shipped
8. pushes the tag

Steps 4-6 are the shape of the thing, and the order is not arbitrary: the
ruleset on `main` takes changes only through a squashed pull request, and
squashing gives the release commit a **new SHA**. A tag cut before the merge —
which is what this script used to do — points at a commit `main` will never
have, and `release.yml` refuses exactly that. So the tag has to come last, and
it has to be cut against what the merge produced rather than what was pushed.

Pushing the tag triggers `release.yml` — the CLI on npm, the desktop builds, the
relay image. **It does not deploy the site**; the merge in step 5 already did, a
minute earlier, via Cloudflare Pages. So by the time the tag artifacts finish
building, the web app has been live for a while. That ordering is fine — the
site is versionless and the artifacts are not — but it does mean a release is
not a single atomic moment.

The download page is built for that gap rather than damaged by it. It asks the
releases API for the current assets at load time instead of being told them at
build time, and `release.yml` keeps the GitHub release a **draft** until all
three desktop builds have passed. `/releases/latest` skips drafts, so during
those twenty-odd minutes the page simply keeps offering the generic releases
link it shipped with. Nothing points at a file that does not exist, and nothing
has to be re-deployed when the binaries land.

### What the jobs do, and what stops

```
verify ──┬── desktop (windows / macos / ubuntu-22.04) ──┬── publish-release ── manifests
         ├── vscode ──┬─────────────────────────────────┤
         │            └── vscode-publish                │
         ├── browser ─────────────────────────────────  ┘
         ├── npm
         ├── mcp
         └── relay-image
```

`publish-release` waits on the jobs that produce a **release asset** using only
`GITHUB_TOKEN` — `desktop`, `vscode`, `browser` — and on none of the jobs that
talk to an external registry. That split is the whole design. An asset job can
only fail for a reason inside this repository, which is what earns each one a
line in `SHA256SUMS`. `npm`, `mcp` and `vscode-publish` hold tokens that expire,
and **nothing waits on any of them**, because one expired token must not hide
three perfectly good installers behind a draft nobody can reach. That is not
hypothetical; it is what happened on the first attempt at v0.3.0.

`browser` builds the store zip and hands it to `publish-release` as a workflow
artifact. It does **not** submit: a Chrome Web Store upload needs OAuth
credentials and enters a review queue, so automating it would replace a
deliberate act with a surprise. The asset is what makes sideloading and the
manual upload possible.

**Everything fans out from `verify`, and that is a correction.** `vscode` and
`browser` were once `needs: desktop`, because they uploaded straight to the
draft release and `tauri-action` is what creates it. The cost showed up on
v0.7.0: the Windows desktop build failed, and the VS Code extension, the browser
zip and the entire GitHub release were skipped — none of which had anything to
do with a Rust toolchain on Windows. They build in parallel now and hand their
output to `publish-release` as artifacts. `vscode-publish` in particular reaches
the Marketplace without caring whether a GitHub release exists, because
publishing an extension never needed one.

`publish-release` is the job that makes the release public, and it needs **all
three** desktop legs. A partial build therefore leaves a draft nobody can
download, which is the intended failure mode: better no installers than a
release page advertising a `.dmg` that failed to compile.

If it stops there, the artifacts are still on the draft and nothing is lost.
Re-running is `gh run rerun <id> --failed`, which restarts from the tag the run
started on — **not** a manual dispatch, because there is no longer one to reach
for. A dispatch off `main` would have handed every downstream job the version
string `"main"`; the trigger is gone rather than guarded, and the re-run path is
the one that was always correct anyway.

If the fix needs a code change rather than a re-run, it needs a new tag: land
the fix on `main`, then `git tag -a v0.3.1` and push that. `release.yml` refuses
a tag `main` does not contain, so tagging the fix on its branch will not work.

Use `--dry` first if you want to see the commit list and the version it would
pick without changing anything.

### The release goes through a pull request, like everything else

The ruleset on `main` (Settings → Rules) requires every change to arrive through
a pull request, allows **squash** as the only merge method, and has no bypass
actors — not even for a repository admin.

`npm run release` used to make the version-bump commit **on `main`** and push
it, so every release died at the last step:

```
remote: - Changes must be made through a pull request.
Error: Command failed: git push origin main
```

Everything before that had already happened and was correct — changelog written,
versions bumped, tag created locally — and the recovery was seven manual git
commands, of which the non-obvious one was deleting the local tag before
re-cutting it on the squashed commit. `release.mjs` now does all of that itself
(steps 4-8 above), so there is nothing left to remember.

Two ways out of this were on the table. **Adding a bypass actor for repository
admins** would have made the old script work unchanged, and was not taken: it
weakens the rule for the one account most able to do damage with it, and it
means the release commit is the only change to `main` nobody could review.
Teaching the script the policy costs one branch per release and leaves the rule
absolute.

**Tags are not covered by the ruleset**, which is why the final `git push origin
v1.2.0` works and is what starts `release.yml`. That hole is deliberate and
closed on the other side: `release.yml`'s first step refuses any tag whose commit
`main` does not already contain, so a tag cut on a branch builds nothing.

If a release stops half-way — the network drops, `gh` is not logged in, the
merge is refused — the script prints the remaining commands and exits without
tagging anything. The branch is pushed and the tree is intact; nothing is
tagged, so nothing has been released.

### First release — the one-time manual steps

None of these can be automated, all of them are invisible until they bite, and
each one silently breaks something the download page promises. They are done
once, ever.

**1. `NPM_TOKEN`.** The `npm` job skips itself when this is missing, so the
release still produces installers — it just never publishes the CLI, and every
`npx realtimeclipboard` example on the site keeps failing.

npm → **Access Tokens** → **Granular Access Token**, and the settings that
matter:

| | |
|---|---|
| **Bypass two-factor authentication (2FA)** | **ticked** |
| Packages and scopes | **Read and write**, **All packages** |
| Expiration | as far out as it allows |

```bash
gh secret set NPM_TOKEN
```

Each of those is a way to fail:

- **Without the 2FA bypass**, publishing dies with `E403 — Two-factor
  authentication or granular access token with bypass 2fa enabled is required`.
  CI cannot answer a 2FA prompt, so this is not optional. It is also the setting
  npm is phasing out (account changes Aug 2026, direct publishing Jan 2027);
  when it goes, move to npm's **Trusted Publishing** over OIDC instead — the
  `npm` job already has the `id-token: write` permission that needs.
- **Scoped to selected packages** does not work for a *first* publish: the
  package does not exist yet, so it cannot be selected, and the token ends up
  with write access to nothing.
- **Expiry** is the quiet one. The default 30 days means a release two months
  from now fails with an auth error nobody connects to a token set today.

**2. Make the relay image public.** A package pushed by `GITHUB_TOKEN` is
created **private**, and linking it to the repository does not grant public
read. Until this is done, the `docker run ghcr.io/…` line on `/download/` and in
`docs/SELF-HOSTING.md` fails with an authentication error for everybody, for
ever — and nothing anywhere reports that it is happening.

Only possible after the first `release.yml` run has created the package:

1. GitHub → your profile → **Packages** → `realtimeclipboard-relay`
2. **Package settings → Manage Actions access** → add the repository with
   **Write**, or the next tag's push gets a 403 now that the package exists
3. **Danger Zone → Change visibility → Public**

**3. The Homebrew tap.** `manifest.mjs` generates the cask and the CLI formula,
but they land in `dist/manifests/` on the runner and are uploaded as an
artifact. They have to be committed to `akshaynikhare/homebrew-tap`, which has
to exist first. Until it does, the `brew install --cask` line stays tagged *not
published yet* on the page.

**4. The winget manifest.** Generated the same way and submitted to
`microsoft/winget-pkgs`, where people who do not work on this project review it.
Expect days, not minutes — which is why the page tags it rather than claiming it
works.

**Nothing on the site claims any of these before they are true.** If you turn
one on, remove its *not published yet* tag on `/download/` **and** in the
matching `src/pages/help/install/` guide in the same commit; they duplicate each
other, and a half-update leaves the site contradicting itself.

### The one place `--no-verify` is used on purpose

The release commit lands on a branch now, so the pre-commit hook's branch guard
no longer applies to it — but its gate is `npm run verify`, which
`tools/release/release.mjs` ran itself seconds earlier against the same tree.
Passing `--no-verify` for that one commit skips a duplicate, not a check. It is
the only automated bypass in the repository, and the pushes are not bypassed:
`pre-push` runs the full suite before the branch and the tag leave the machine.

---

## The changelog

`tools/release/changelog.mjs` reads the git history and writes two files from one pass:

- **`CHANGELOG.md`** — every release, in full, for the repository
- **`changelog.json`** — the last few releases, capped, shipped with the app

Both are generated. Editing them by hand works until the next release
overwrites it; to change an entry, reword the commit.

Commits that predate the hook, or were made with `--no-verify`, are not dropped
— they land in a general "Other changes" section. A changelog that silently
omits work is worse than one with an untidy heading.

```bash
npm run changelog           # regenerate both
npm run changelog -- --check  # exit 1 if they are stale
```

### In the app

`src/ui/features/whatsNew.js` fetches `changelog.json` and shows a dismissible banner
when the running version differs from the last one this browser saw. Two rules:

- **It never interrupts.** Arrival is a banner; the dialog only opens if asked.
  A modal stealing focus while someone is pasting a password would be a worse
  bug than anything it announces.
- **It never shows on a first visit.** A new user has nothing to be caught up
  on. The version is recorded silently and the banner starts from the release
  after that.

A missing or malformed `changelog.json` produces silence, not an error.

### The MCP server and the browser extension

**`realtimeclipboard-mcp` publishes with the same `NPM_TOKEN`** as the CLI — one
token, two packages, no extra setup. What it needs instead is a check on first
release: the published package is the *bundle*, so confirm it installs and
starts before anyone wires it into an agent.

```bash
npm pack mcp/dist/pkg && npm i -g ./realtimeclipboard-mcp-*.tgz
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | realtimeclipboard-mcp
```

`tools/build/build-mcp.mjs` already does that spawn-and-speak check as a build
assert, which is how a duplicate shebang — a syntax error that appeared only
once installed — was caught. Re-run it by hand anyway the first time.

Then submit `mcp/server.json` to <https://registry.modelcontextprotocol.io> with
the `mcp-publisher` CLI. Its `version` and its `packages[0].version` are both
checked against `package.json`; a registry entry naming an unpublished version
is a server nobody can install.

**The browser extension is a manual upload.** The zip is on the release. Chrome
Web Store: a one-time $5 registration, 2FA on the Google account, then a review
queue measured in days. Firefox and Edge take the same zip.

**Do not claim background clipboard sync on any store listing.** The extension
cannot do it, no browser extension can, and it is the one claim a reviewer can
check in a minute.

### The extension's one-time steps

**`VSCE_PAT` and the publisher ID.** `vscode-publish` skips itself when these are
missing, so a tag still produces a `.vsix` — it just never reaches anybody who
would install it from inside their editor.

1. Create the publisher at <https://marketplace.visualstudio.com/manage>. The ID
   is **lowercase and permanent**, and it must equal `publisher` in
   `vscode/package.json` or `vsce` refuses the upload.
2. Mint a PAT in Azure DevOps with scope **Marketplace → Manage**, and
   organisation **All accessible organizations** — scoped to one org it fails
   with an error that does not say why.
3. `gh secret set VSCE_PAT`

**Azure DevOps PATs expire**, and a silently expired one is a channel that stops
updating while every other channel keeps working — the same failure shape as the
npm token, and worth a calendar entry. Microsoft is retiring global PATs on
1 December 2026 in favour of Entra ID; when that lands, this moves the same way
npm's 2FA-bypass token moves to Trusted Publishing.

**`OVSX_PAT`.** Open VSX is where Cursor, Windsurf, VSCodium, Gitpod and
code-server get their extensions — none of them **may** use the Microsoft
Marketplace, so this is a second audience rather than a second-best mirror. Sign
in at <https://open-vsx.org>, agree the publisher agreement, create a namespace
matching the publisher ID (`ovsx create-namespace <id>`), then
`gh secret set OVSX_PAT`. There is no review queue.

Publish `0.0.1` by hand once before a tag depends on it, so the Marketplace page
is known to render.

### One version, one identity

The version is written in **five** places and `tools/release/release.mjs` moves
all of them: `package.json`, `Cargo.toml`, `Cargo.lock`, `vscode/package.json`
and — by reference rather than by copy — `tauri.conf.json`, which reads
`"../../package.json"`. The extension manifest cannot do that, because the
Marketplace reads a literal. `tests/unit/static-check.mjs` asserts all five
agree, so a missed one fails the release commit itself.

`tools/build/build.mjs` stamps `sw.js`'s `VERSION` as **`<package.json version>+<short
commit sha>`** — `0.3.1+9f2c4ab10e77`. The leading half is the same string that
heads `CHANGELOG.md` and appears in "What's new", so a cache name still reads as
a release rather than as an opaque hash.

The commit half is not decoration. `VERSION` is the cache key, and a changed
`sw.js` is the *only* thing that tells a browser an update exists — so it has to
change on every deploy, and deploys are now per-commit rather than per-tag. A
docs fix that ships without touching `package.json` must still invalidate the
shell; keyed on the version alone it would not, and those users would sit on the
old bundle until the next release happened to bump a number.

**This is the part that had to change when the site moved to Cloudflare Pages.**
The stamp read `GITHUB_REF_NAME` before, and none of the `GITHUB_*` variables
exist in a Cloudflare build. The fallback was the literal string `"dev"` — a
perfectly stable cache name, which would have meant a byte-identical `sw.js` on
every deploy, no update ever detected, and every returning visitor pinned to the
first shell ever published. Nothing would have looked wrong from the outside.

---

## Supply chain: what a user can actually verify

Zero runtime dependencies does most of the work here — there is no transitive
package that can be taken over, and `npx realtimeclipboard` installs `src/core`
and `src/transport` unbundled, so what runs is what is in the repository. Three
things back that up, and one gap remains open on purpose.

**Actions are pinned to commit SHAs.** Every `uses:` in `.github/workflows/`
names a 40-character SHA with the tag beside it as a comment. A tag is a movable
pointer in somebody else's repository: `@v4` today and `@v4` next month can be
different code, and a compromised popular action runs inside a job that holds
`GITHUB_TOKEN` and `NPM_TOKEN`. Pinning is what makes "the workflow did not
change" a true statement.

To bump one deliberately:

```bash
gh api repos/actions/checkout/commits/v5 --jq .sha     # then paste it in, keeping the # v5 comment
```

**`SHA256SUMS` is attached before the release goes public.** The `publish-release`
job downloads every asset, hashes it and uploads the file, then flips the draft.
There is no window in which an installer is downloadable and unverifiable.

**Every artifact carries build provenance.** npm publishes with `--provenance`;
the desktop job runs `actions/attest-build-provenance` over `artifactPaths`. Both
mint a Sigstore-signed attestation through an OIDC token the run cannot
fabricate, binding the artifact to the commit and workflow that produced it.
Anyone can check one without trusting this repository or its release page:

```bash
gh attestation verify RealtimeClipboard_0.5.0_x64-setup.exe \
   --repo akshaynikhare/RealtimeClipboard
```

This is strictly stronger than the checksum file, and for a reason worth being
precise about: `SHA256SUMS` is served from the same release as the assets, so
whoever could replace a binary could replace the hash beside it. An attestation
lives in a public transparency log somebody else operates.

It does **not** remove the SmartScreen or Gatekeeper warning. Provenance answers
"did this come from that source", not "may this run" — only a signature does the
second, which is the gap below.

### The gap: the desktop installers are unsigned

`desktop/src-tauri/tauri.conf.json` has `certificateThumbprint: null` and
`signingIdentity: null`. Two consequences, and neither is fixed by the checksum
file:

- Windows SmartScreen and macOS Gatekeeper warn on first run. Users are trained
  through that warning, which is the worst possible outcome — it teaches the
  gesture that a real attack needs.
- Nothing in the binary says who built it. `SHA256SUMS` is served from the same
  release as the assets, so anyone able to replace one could replace both. What
  it gives is a fixed value that can be quoted elsewhere — release notes, a Scoop
  manifest, a mirror's records — so a substitution *after the fact* is detectable
  by anyone who wrote the number down. That is weaker than a signature and worth
  having anyway.

The secrets are already wired up in `release.yml` — `APPLE_CERTIFICATE` and
friends are read, and are simply absent — so closing this is a matter of
obtaining certificates, not of writing code.

| Platform | Option | Cost |
|---|---|---|
| Windows | **[SignPath Foundation](https://signpath.org/)** — free code signing for OSS. Key generated and held in their HSM, signing happens server-side from CI, so no certificate ever touches this repository or a laptop. This project meets the [conditions](https://signpath.org/terms.html): MIT, no proprietary components, actively maintained, released, described on `/download/` | **free** |
| Windows | Azure Artifact Signing (formerly Trusted Signing) — ~$10/month, and **not available here**: individuals must be in the US or Canada, organisations need three years of verifiable history | n/a |
| macOS | Apple Developer Program. There is no free path and no open-source exemption — without membership you cannot sign at all, let alone notarise | **$99/yr** |
| Linux | Not affected. `deb`/`rpm`/AppImage carry no equivalent gate | — |

SignPath issues an **OV** certificate rather than EV, so SmartScreen reputation
accrues with download volume instead of being granted immediately. Warnings fade
over weeks rather than vanishing on the first release — still unlike unsigned,
which never improves.

Until the macOS side is paid for, the honest advice to a Mac user is right-click
→ Open, or a Homebrew cask, which lets `brew` handle the quarantine attribute.

---

## Hooks

| Hook | Runs |
|---|---|
| `pre-commit` | branch guard, then `npm run verify` — static checks, crypto, dialogs, files. Offline and fast; a hook that needs a network fails on a train |
| `commit-msg` | Conventional Commits, and a 72-character subject cap |
| `pre-push` | `verify` again, then the relay-backed suites — **skipped** if no relay answers, so being offline never forces a habit of `--no-verify` |

Set up automatically by `npm install` (husky's `prepare` script). If hooks stop
firing, run `npm install` again, or `npx husky` directly.

Start a relay for the full suite with `npm run relay`; `npm run relay:up` is the
one-second reachability check the pre-push hook uses.

---

## If the deploy fails

Read the Cloudflare build log. A failure is almost always `tools/check/site-check.mjs`
catching something real — a file that moved, a missing `noindex` on `app.html`,
an SVG that crept back into the manifest's `icons[]`, a canonical URL still
naming the old origin. Each check prints what it was protecting.

Reproduce it exactly, locally, without pushing anything:

```bash
npm run build:site
```

That is the same command Cloudflare runs. If it passes locally and fails there,
the difference is the environment — check `NODE_VERSION` is 22 and that
`package-lock.json` is committed.

**Production is unaffected by a failed build.** Cloudflare only promotes a
successful one, so the previous deploy keeps serving. To redeploy an unchanged
commit, use *Retry deployment* in the Pages dashboard; to roll back, promote an
earlier deployment from the same list.

Note that a rollback does **not** roll back the service worker for anyone who
already loaded the bad build — their browser holds a shell keyed to that
version. It will pick up the rollback on its next update check, because the
restored `sw.js` carries a different `VERSION` string than the one they have.
