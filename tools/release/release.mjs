/**
 * Cut a release: verify, write the changelog, land it through a pull request, tag.
 *
 * Two things ship, from one command, on two different triggers: a commit on
 * main deploys the site (Cloudflare Pages), and pushing the tag builds the CLI,
 * the desktop installers and the relay image (.github/workflows/release.yml).
 * The site therefore goes live in about a minute and the binaries take half an
 * hour — see docs/RELEASING.md for what /download/ does in between.
 *
 * It is a script rather than a list of steps in a README because the steps have
 * an order, and two of them are not obvious:
 *
 *   - the changelog is committed BEFORE the tag, or the tag points at a commit
 *     whose changelog does not mention the release the tag is for;
 *   - the tag is cut AFTER the merge, because the ruleset on main takes changes
 *     only through a squashed pull request. Squashing gives the release commit a
 *     new SHA, and release.yml refuses a tag whose commit main does not contain,
 *     so a tag cut before the merge points at a commit that never lands.
 *
 * Usage:
 *   npm run release -- patch          0.1.0 -> 0.1.1
 *   npm run release -- minor          0.1.0 -> 0.2.0
 *   npm run release -- major          0.1.0 -> 1.0.0
 *   npm run release -- v1.4.2         exactly that
 *   npm run release -- minor --dry    say what would happen, change nothing
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG = join(REPO, "package.json");
const CARGO_TOML = join(REPO, "desktop/src-tauri/Cargo.toml");
const CARGO_LOCK = join(REPO, "desktop/src-tauri/Cargo.lock");
const VSCODE_PKG = join(REPO, "vscode/package.json");
const MCP_PKG = join(REPO, "mcp/package.json");
const MCP_SERVER = join(REPO, "mcp/server.json");
const BROWSER_MANIFEST = join(REPO, "browser/manifest.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const target = args.find(a => !a.startsWith("--"));

const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
const run = (cmd, ...a) =>
  execFileSync(cmd, a, { cwd: REPO, stdio: "inherit", shell: process.platform === "win32" });

// No shell for these two: a PR title and a changelog body are full of spaces and
// quotes, and execFileSync with shell:true joins argv without escaping it.
const gh = (...a) => execFileSync("gh", a, { cwd: REPO, encoding: "utf8" }).trim();
const ghLive = (...a) => execFileSync("gh", a, { cwd: REPO, stdio: "inherit" });

const die = msg => { console.error(`\n  ${msg}\n`); process.exit(1); };

/**
 * Rewrite one match in a file, and die if there is not exactly one.
 *
 * The loud part is the point. A version bump that silently matches nothing
 * ships a build labelled with the previous release, which nobody notices until
 * a user reports a bug against a version that never existed.
 */
function replaceOnce(file, pattern, replacement) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) die(`${file} — nothing matched ${pattern}. Refusing to tag a half-bumped tree.`);
  writeFileSync(file, after);
}

if (!target) {
  die("Say what to release:  npm run release -- patch | minor | major | v1.2.3");
}

/* ------------------------------------------------------- refuse to start badly

   Each of these has cost somebody an afternoon somewhere. A release from a
   dirty tree ships something that is in no commit; a release from a feature
   branch tags work that was never merged; a release over an existing tag is
   either a no-op or a rewrite of history other people have already fetched. */

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  die(`Releases are cut from main; you are on "${branch}".\n  Merge your branch first.`);
}

if (git("status", "--porcelain")) {
  die("Working tree is not clean. Commit or stash first — a release must be\n"
    + "  reproducible from the tag, and an uncommitted file is not in the tag.");
}

// Someone else may have pushed since this checkout. Tagging a stale main means
// the release is missing work that is already on the branch.
try {
  git("fetch", "--tags", "--quiet");
  const behind = git("rev-list", "--count", "HEAD..@{upstream}");
  if (behind !== "0") die(`main is ${behind} commit(s) behind the remote. Pull first.`);
} catch {
  console.log("  (no upstream to compare against — continuing)");
}

/* Checked here rather than an hour into the run: the pull request is the only
   way onto main, so without gh this release cannot finish whatever else passes.

   `--active` is load-bearing. Bare `gh auth status` reports on EVERY configured
   account and exits non-zero if any one of them is unhealthy — so a second
   account with a stale token in the keyring, which affects nothing, refused the
   release with a message telling you to install a CLI you already have. What
   this needs to know is whether the account gh will actually act as can act. */
try {
  execFileSync("gh", ["auth", "status", "--active"], { cwd: REPO, stdio: "ignore" });
} catch {
  die("The release lands through a pull request, which needs the GitHub CLI.\n"
    + "  Install https://cli.github.com, then:  gh auth login\n"
    + "  Already signed in? Check the ACTIVE account:  gh auth status --active");
}

/* ------------------------------------------------------------- work out the version */

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const current = pkg.version ?? "0.0.0";

function bump(from, kind) {
  const [maj, min, pat] = from.split(".").map(n => parseInt(n, 10) || 0);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

let version;
if (/^(patch|minor|major)$/.test(target)) {
  version = bump(current, target);
} else if (/^v?\d+\.\d+\.\d+$/.test(target)) {
  version = target.replace(/^v/, "");
} else {
  die(`"${target}" is not patch, minor, major, or a version like v1.2.3`);
}

const tag = `v${version}`;
const releaseBranch = `release/${tag}`;
const tags = git("tag", "--list").split("\n").filter(Boolean);
if (tags.includes(tag)) die(`${tag} already exists. Pick another version.`);

// A leftover from an abandoned attempt at this version would otherwise be
// committed onto, and the pull request would carry both.
if (git("branch", "--list", releaseBranch) || git("ls-remote", "--heads", "origin", releaseBranch)) {
  die(`${releaseBranch} already exists, here or on the remote.\n`
    + "  Finish or delete it before releasing this version again.");
}

console.log(`\n  ${current} -> ${version}   (tag ${tag}, via ${releaseBranch})\n`);

/* --------------------------------------------------------------------- verify

   The same checks the hooks run. Repeated here rather than trusted from the
   last commit, because "it passed when I committed it" and "it passes now" are
   different claims once a merge has happened in between. */

if (!DRY) {
  console.log("  Verifying …\n");
  run("npm", "run", "verify");
}

/* -------------------------------------- changelog, then the pull request, then the tag */

const commits = git("log", tags.length ? `${git("describe", "--tags", "--abbrev=0")}..HEAD` : "HEAD",
                    "--no-merges", "--oneline").split("\n").filter(Boolean);

if (!commits.length) die("Nothing to release — no commits since the last tag.");

console.log(`\n  ${commits.length} commit(s) in this release:`);
commits.slice(0, 10).forEach(c => console.log(`    ${c}`));
if (commits.length > 10) console.log(`    … and ${commits.length - 10} more`);

if (DRY) {
  console.log(`\n  --dry: stopping here. Would open ${releaseBranch} as a pull`);
  console.log(`  request, squash it into main, then tag ${tag} on the result.\n`);
  process.exit(0);
}

console.log("\n  Writing the changelog …");
run("node", "tools/release/changelog.mjs", "--next", tag);

pkg.version = version;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

/* The desktop crate carries the version twice more, and `cargo build --locked`
   fails outright when the manifest and the lock disagree — so a bump that
   misses either one turns the next tag red on all three platforms rather than
   producing a mislabelled binary. tauri.conf.json is NOT here: it reads
   "../../package.json" and derives its version from the write above.

   Anchored to the first `version =` after the [package] header. A bare
   /^version = / would match `rust-version` on some formatter's output, and a
   global replace would rewrite all 600-odd dependency pins in the lock file. */
replaceOnce(CARGO_TOML, /(\[package\][\s\S]*?\r?\nversion = )"[^"]+"/, `$1"${version}"`);
replaceOnce(CARGO_LOCK, /(name = "realtimeclipboard"\r?\nversion = )"[^"]+"/, `$1"${version}"`);

/* The extension manifest is a fifth copy, and unlike tauri.conf.json it cannot
   point at package.json — the Marketplace reads a literal. Missing it fails
   static-check §23 on the release commit itself, which is the good failure, but
   only after the human step. */
const bumpJson = (file, mutate) => {
  const json = JSON.parse(readFileSync(file, "utf8"));
  mutate(json);
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
};

bumpJson(VSCODE_PKG, j => { j.version = version; });
// No dependency to move with it: the MCP server is published as a bundle, so
// its package has none. It carried `realtimeclipboard: ^x` for exactly one
// commit, and this line went on assigning into a `dependencies` that no longer
// existed — which threw here, before anything was written, and would have
// failed the release rather than the build.
bumpJson(MCP_PKG, j => { j.version = version; });
// server.json says it twice: the entry's own version, and which npm version a
// client should fetch. A registry entry pointing at an unpublished version is a
// server nobody can install.
bumpJson(MCP_SERVER, j => { j.version = version; j.packages[0].version = version; });
bumpJson(BROWSER_MANIFEST, j => { j.version = version; });

/* ---------------------------------------------- land it through a pull request

   The ruleset on main requires one and has no bypass actors, so `git push
   origin main` is refused however the commit was made — see docs/RELEASING.md.
   The release commit therefore arrives the same way every other change does. */

git("switch", "-c", releaseBranch);

git("add", "CHANGELOG.md", "changelog.json", "package.json",
    "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock",
    "vscode/package.json", "mcp/package.json", "mcp/server.json",
    "browser/manifest.json");

// --no-verify, and it is not a shortcut: the hook's gate is `npm run verify`,
// which ran a few seconds ago against this same tree, and nothing has changed
// since but the generated files staged above.
execFileSync("git", ["commit", "--no-verify", "-m", `chore(release): ${tag}`],
             { cwd: REPO, stdio: "inherit" });

console.log(`\n  Pushing ${releaseBranch} …\n`);
run("git", "push", "-u", "origin", releaseBranch);

// The release's own changelog section, used twice: as the pull request body,
// and as the tag message so `git show v1.2.0` tells you what shipped.
const section = `## ${readFileSync(join(REPO, "CHANGELOG.md"), "utf8")
  .split(/^## /m)
  .find(s => s.startsWith(tag)) ?? tag}`.trim();

// Everything from here is recoverable by hand, and saying how beats a stack
// trace: the branch is pushed, the tree is intact and nothing is tagged yet.
const stranded = (what, err) => die(
  `${what}\n  ${String(err.message).split("\n")[0]}\n\n`
  + `  Nothing is tagged, and ${releaseBranch} holds the release commit. Finish it:\n`
  + `      gh pr create --base main --head ${releaseBranch} --fill   # if not already open\n`
  + "      gh pr merge --squash --delete-branch\n"
  + "      git switch main && git pull --ff-only\n"
  + `      git tag -a ${tag} -m "…"    # the ${tag} section of CHANGELOG.md\n`
  + `      git push origin ${tag}      # this is what starts release.yml`);

const quiet = fn => { try { return fn(); } catch { return null; } };

console.log("\n  Opening the pull request …\n");
let pr;
try {
  pr = gh("pr", "create", "--base", "main", "--head", releaseBranch,
          "--title", `chore(release): ${tag}`, "--body", section);
} catch (err) {
  stranded("Could not open the pull request.", err);
}
console.log(`  ${pr}`);

// Off the branch before the merge deletes it.
git("switch", "main");

console.log("\n  Merging …\n");
try {
  ghLive("pr", "merge", pr, "--squash", "--delete-branch");
} catch (err) {
  // gh exits non-zero for the branch cleanup as readily as for the merge, and
  // only one of those is the release. Ask what actually happened before dying.
  if (quiet(() => gh("pr", "view", pr, "--json", "state", "-q", ".state")) !== "MERGED") {
    stranded("The merge did not go through.", err);
  }
  console.log("\n  (merged — the branch cleanup is what failed; ignoring)");
}

run("git", "pull", "--ff-only", "origin", "main");
quiet(() => git("branch", "-D", releaseBranch));

/* The squash rewrote the SHA, so the tag has to be cut here, on whatever main
   ended up with — and only once main really carries this version. release.yml
   refuses a tag main does not contain, which turns a mis-ordered tag into a red
   release rather than a wrong one, and the version is the cheapest proof. */
const landed = JSON.parse(git("show", "HEAD:package.json")).version;
if (landed !== version) {
  die(`main is at ${landed}, not ${version} — the release did not land.\n`
    + "  Nothing has been tagged. Check the pull request, then re-run.");
}

// Annotated, not lightweight: it carries a date, an author and a message, and
// `git describe` prefers it.
execFileSync("git", ["tag", "-a", tag, "-m", section], { cwd: REPO, stdio: "inherit" });

console.log(`\n  Tagged ${tag} on main. Pushing …\n`);
run("git", "push", "origin", tag);

console.log(`\n  ${tag} pushed. The site is deploying from main now; the tag builds`);
console.log("  the installers, the CLI and the relay image — watch:");
console.log("    https://github.com/akshaynikhare/RealtimeClipboard/actions\n");
console.log("  The GitHub release stays a DRAFT until all three desktop builds pass.");
console.log("  Until it is published, /download/ keeps offering /releases/latest.\n");
