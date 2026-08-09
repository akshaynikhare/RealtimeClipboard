/**
 * Package-manager manifests, generated from one release.
 *
 * Every channel below is the same three facts — a version, a URL, a SHA256 —
 * arranged differently. Written by hand that is several files to remember per
 * release, which works for two releases and then quietly does not: someone
 * updates the tap and forgets winget, and `brew install` starts handing out a
 * version four behind `winget install`. Generating them is the same argument the
 * rest of this repo already makes about RELAY_HTTP_URL, LINKS and the service
 * worker's precache list.
 *
 *   node tools/release/manifest.mjs <homebrew|winget|all> <vX.Y.Z>
 *   node tools/release/manifest.mjs publish <vX.Y.Z>     say where they go
 *
 * !! Asset names are READ FROM THE RELEASE, never constructed. This file used
 * to build them from a template — `RealtimeClipboard_${version}_x64_en-US.msi`
 * and so on — under a comment admitting they were "guesses until the first real
 * release, and the most likely thing here to be wrong". They were: Tauri names
 * its Linux output from productName verbatim, so the lowercased `realtimeclipboard_…`
 * guesses could not have matched. A manifest built from a guessed filename
 * points at a 404 and reports it as a corrupt download.
 *
 * Matching is by EXTENSION, which is the one part of the name that is stable
 * across Tauri versions and targets. src/landing/download.js resolves the
 * page's buttons the same way, for the same reason. !!
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "dist/manifests");

const OWNER = "akshaynikhare";
const REPO = "RealtimeClipboard";
const [, , command, rawTag] = process.argv;

if (!command || !rawTag) {
  console.error("usage: node tools/release/manifest.mjs <homebrew|winget|all|publish> <vX.Y.Z>");
  process.exit(2);
}

const tag = rawTag.startsWith("v") ? rawTag : `v${rawTag}`;
const version = tag.slice(1);

/** The one part of a Tauri artifact name that does not move. */
const KIND = {
  msi: /\.msi$/i,
  nsis: /-setup\.exe$/i,
  dmg: /\.dmg$/i,
  deb: /\.deb$/i,
  rpm: /\.rpm$/i,
  appimage: /\.AppImage$/i,
};

/**
 * The release's actual assets, fetched once.
 *
 * A draft release is 404 here to an unauthenticated request, which is exactly
 * the state release.yml leaves it in until every desktop build has passed —
 * hence `needs: publish-release` on the job that calls this.
 */
let assets;
async function load() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`;
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(`cannot read ${tag} (HTTP ${res.status}) — is the release published, not still a draft?`);
  }
  assets = (await res.json()).assets ?? [];
  if (!assets.length) throw new Error(`${tag} has no assets`);
}

/** The asset of a given kind, or a loud failure naming what was actually there. */
function asset(kind) {
  const found = assets.find(a => KIND[kind].test(a.name));
  if (!found) {
    throw new Error(`no ${kind} asset in ${tag}. The release has: ${assets.map(a => a.name).join(", ")}`);
  }
  return found;
}

/** SHA256 of a released asset, fetched rather than assumed. */
async function digest(a) {
  const res = await fetch(a.browser_download_url);
  if (!res.ok) {
    // Loud, and fatal. A manifest carrying a placeholder checksum installs
    // nothing and tells the user their download is corrupt.
    throw new Error(`cannot download ${a.name} (HTTP ${res.status})`);
  }
  return createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
}

const write = (name, body) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), body.trimStart());
  console.log(`  wrote dist/manifests/${name}`);
};

/* --------------------------------------------------------------- homebrew -- */

async function homebrew() {
  const dmg = asset("dmg");
  const hash = await digest(dmg);
  // A cask for the app. The CLI is a separate formula and deliberately not
  // bundled into it: somebody automating a server wants `realtimeclipboard` on PATH and
  // has no use for a tray icon, and installing a GUI to get a pipe is rude.
  // replaceAll, not replace: the version appears twice in a Tauri asset URL —
  // once in the tag and once in the filename. Substituting only the first left
  // the cask pointing at v#{version}/RealtimeClipboard_0.3.0_universal.dmg,
  // which works for exactly one release and 404s for every one after it.
  write("realtimeclipboard.rb", `
cask "realtimeclipboard" do
  version "${version}"
  sha256 "${hash}"

  url "${dmg.browser_download_url.replaceAll(version, "#{version}")}"
  name "RealtimeClipboard"
  desc "End-to-end encrypted clipboard shared between your devices"
  homepage "https://github.com/${OWNER}/${REPO}"

  depends_on macos: ">= :big_sur"

  app "RealtimeClipboard.app"

  # The build is not notarised, so Gatekeeper would quarantine it and the user
  # would meet "Apple cannot check it" after an install that looked fine. brew
  # removes the attribute itself when told the cask is unsigned.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/RealtimeClipboard.app"],
                   sudo: false
  end

  # The app writes nothing but its settings. Named explicitly so an uninstall
  # is complete — a clipboard tool that leaves state behind after you remove it
  # has undermined its own pitch.
  zap trash: [
    "~/Library/Application Support/io.github.akshaynikhare.realtimeclipboard",
    "~/Library/Preferences/io.github.akshaynikhare.realtimeclipboard.plist",
    "~/Library/Saved Application State/io.github.akshaynikhare.realtimeclipboard.savedState",
  ]
end
`);

  /* The formula needs the tarball's checksum, and `brew audit` rejects one
     without it. It can only exist once the npm job has published — which is a
     separate channel that may have failed or been skipped — so a missing
     tarball skips this formula rather than failing the whole run. */
  const tgz = `https://registry.npmjs.org/realtimeclipboard/-/realtimeclipboard-${version}.tgz`;
  const tgzRes = await fetch(tgz);
  if (!tgzRes.ok) {
    console.log(`  skipping realtimeclipboard-cli.rb — ${tgz} is not published (HTTP ${tgzRes.status})`);
    return;
  }
  const tgzHash = createHash("sha256").update(Buffer.from(await tgzRes.arrayBuffer())).digest("hex");

  write("realtimeclipboard-cli.rb", `
class RealtimeClipboardCli < Formula
  desc "Online clipboard on the command line — pipe text between machines"
  homepage "https://github.com/${OWNER}/${REPO}"
  url "https://registry.npmjs.org/realtimeclipboard/-/realtimeclipboard-${version}.tgz"
  sha256 "${tgzHash}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match(/^[0-9A-Z]{6}$/, shell_output("#{bin}/realtimeclipboard new").strip)
  end
end
`);
}

/* ----------------------------------------------------------------- winget -- */

/**
 * Three files in one versioned directory, which is the shape winget-pkgs wants.
 *
 * PackageIdentifier is Publisher.Package and has to match the directory path,
 * so it is written once here and interpolated rather than typed three times.
 */
async function winget() {
  const msi = asset("msi");
  const hash = await digest(msi);
  const id = "AkshayNikhare.RealtimeClipboard";
  const dir = `winget/${id}/${version}`;

  mkdirSync(join(OUT, dir), { recursive: true });
  const put = (name, body) => write(`${dir}/${name}`, body);

  put(`${id}.yaml`, `
# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
PackageIdentifier: ${id}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`);

  put(`${id}.installer.yaml`, `
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
PackageIdentifier: ${id}
PackageVersion: ${version}
InstallerType: wix
Scope: machine
InstallModes:
  - interactive
  - silent
UpgradeBehavior: install
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
  - Architecture: x64
    InstallerUrl: ${msi.browser_download_url}
    InstallerSha256: ${hash.toUpperCase()}
ManifestType: installer
ManifestVersion: 1.6.0
`);

  put(`${id}.locale.en-US.yaml`, `
# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json
PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: CadNative
PublisherUrl: https://github.com/${OWNER}
PackageName: RealtimeClipboard
PackageUrl: https://realtimeclipboard.com/
License: MIT
LicenseUrl: https://github.com/${OWNER}/${REPO}/blob/main/LICENSE
ShortDescription: An end-to-end encrypted clipboard shared between your devices
Description: >-
  Copy on one machine and paste on another. RealtimeClipboard watches the system
  clipboard and sends what you copy, encrypted in the browser, to the other
  devices sharing a short key. No account, and nothing is written to
  disk on any machine or on the relay.
Tags:
  - clipboard
  - clipboard-sync
  - encryption
  - productivity
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`);
}

/* ---------------------------------------------------------------- publish -- */

function publish() {
  // Deliberately not a force-push. These files land in repositories other
  // people also read and touch — a tap, and winget-pkgs — and a bot that pushes
  // to them directly is how a channel acquires a reputation for breaking.
  const notes = `
  Manifests for ${tag} are in dist/manifests/, and uploaded as a workflow
  artifact so they can be fetched from the run page.

    realtimeclipboard.rb        -> ${OWNER}/homebrew-tap   Casks/
    realtimeclipboard-cli.rb    -> ${OWNER}/homebrew-tap   Formula/
    winget/…                    -> microsoft/winget-pkgs   manifests/a/${OWNER}/…

  The winget submission is reviewed by people who do not work on this project,
  so it lands days after the release. Until each one is merged, /download/ and
  the matching page under src/pages/help/install/ must keep saying "not
  published yet" — they duplicate each other, so change both or neither.`;

  console.log(notes);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Manifests for ${tag}\n\n\`\`\`${notes}\n\`\`\`\n`, { flag: "a" });
  }
}

const RUN = { homebrew, winget };

try {
  if (command === "publish") {
    publish();
  } else if (command === "all") {
    await load();
    for (const fn of [homebrew, winget]) await fn();
  } else if (RUN[command]) {
    await load();
    await RUN[command]();
  } else {
    console.error(`unknown command "${command}"`);
    process.exit(2);
  }
} catch (err) {
  console.error(`\n::error::${err.message}\n`);
  // exitCode rather than exit(): killing the process while undici still holds a
  // socket trips a libuv assertion on Windows, which buries the real message
  // above under what looks like a crash in Node itself.
  process.exitCode = 1;
}
