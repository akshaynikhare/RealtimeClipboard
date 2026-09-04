/**
 * Repo health check — runs without a browser or a relay.
 *
 * Catches the class of bug that native ES modules fail at silently: a typo'd
 * import path or a missing element id produces a blank page and one console
 * line, with no build step to catch it first.
 *
 * Usage: node tests/unit/static-check.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let pass = 0, fail = 0;

const ok = (name, good, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const jsFiles = walk(join(ROOT, "src")).filter(f => f.endsWith(".js"));
const read = f => readFileSync(f, "utf8");
const rel = f => relative(ROOT, f).replace(/\\/g, "/");

console.log("\nStatic checks\n");

/* ---------- 1. every module parses ---------- */
let bad = [];
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch { bad.push(rel(f)); }
}
ok(`all ${jsFiles.length} modules parse`, bad.length === 0, bad.join(", "));

/* ---------- 2. every relative import resolves ---------- */
bad = [];
for (const f of jsFiles) {
  const src = read(f);
  const specs = [
    ...src.matchAll(/from\s+"([^"]+)"/g),
    ...src.matchAll(/import\("([^"]+)"\)/g),
  ].map(m => m[1]).filter(s => s.startsWith("."));
  for (const spec of specs) {
    if (!existsSync(resolve(dirname(f), spec))) bad.push(`${rel(f)} -> ${spec}`);
  }
}
ok("every relative import resolves", bad.length === 0, bad.join("; "));

/* ---------- 2b. every NAMED import actually exists ----------
   The check above proves the file is there, which is not the same thing.
   Renaming `styleHref` to `lazyStyleHref` left qr.js importing a name that no
   longer existed — and the module graph still resolved, so nothing here failed.
   What happened instead is the failure this repo keeps meeting: main.js loads
   the QR panel inside a try, so the panel simply stopped existing, was warned
   about once in a console nobody was reading, and degraded exactly as designed.

   Static analysis rather than importing the module, because these files expect
   a DOM. */
const exportsOf = src => new Set([
  // [\w$] and not \w: dom.js exports `$` and `$$`, and \w matches neither, so
  // the first run of this check reported all nineteen of its importers.
  ...[...src.matchAll(/export\s+(?:async\s+)?function\s+([\w$]+)/g)].map(m => m[1]),
  ...[...src.matchAll(/export\s+(?:const|let|var|class)\s+([\w$]+)/g)].map(m => m[1]),
  // export { a, b as c }
  ...[...src.matchAll(/export\s*\{([^}]*)\}/g)].flatMap(m =>
    m[1].split(",").map(s => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)),
]);

bad = [];
for (const f of jsFiles) {
  const src = read(f);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
    const target = resolve(dirname(f), m[2]);
    if (!existsSync(target)) continue;                       // already reported above
    const available = exportsOf(read(target));
    // `import { a as b }` — the name that has to exist is the one before `as`.
    for (const name of m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim())) {
      if (name && !available.has(name)) bad.push(`${rel(f)} -> ${name} from ${m[2]}`);
    }
  }
}
ok("every named import exists in the module it comes from", bad.length === 0, bad.join("; "));

/* ---------- 3. every @import resolves ---------- */
const cssEntry = join(ROOT, "src/styles/main.css");
bad = [...read(cssEntry).matchAll(/@import url\("([^"]+)"\)/g)]
  .map(m => m[1])
  .filter(s => !existsSync(resolve(dirname(cssEntry), s)));
ok("every CSS @import resolves", bad.length === 0, bad.join(", "));

/* ---------- 4. every $("id") exists somewhere ----------
   Elements come from two places: index.html, and modules that build their own
   DOM (banners, history pane, QR modal, PWA prompts). Both count. */
const html = read(join(ROOT, "app.html"));
const known = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
for (const f of jsFiles) {
  const src = read(f);
  for (const m of src.matchAll(/id="([\w-]+)"/g)) known.add(m[1]);        // template literals
  for (const m of src.matchAll(/\.id\s*=\s*"([\w-]+)"/g)) known.add(m[1]); // el.id = "x"
  for (const m of src.matchAll(/\bid:\s*"([\w-]+)"/g)) known.add(m[1]);    // {id: "x"} helpers
}
const referenced = new Set();
for (const f of jsFiles) {
  const src = read(f);
  for (const m of src.matchAll(/\$\("([\w-]+)"\)/g)) referenced.add(m[1]);
  for (const m of src.matchAll(/bind\("([\w-]+)"/g)) referenced.add(m[1]);
}
const dangling = [...referenced].filter(id => !known.has(id)).sort();
ok(`all ${referenced.size} referenced element ids exist`, dangling.length === 0, dangling.join(", "));

/* ---------- 5. colours come from tokens ----------
   A hex literal in a component sheet means the theme cannot be changed in one
   place. A few are legitimate and are listed with their reason. */
const ALLOWED_HEX = {
  "tokens.css": "defines them",
  "components.css": "#fff on the accent button, which is not themed",
  "qr.css": "QR must stay black-on-white or scanners fail — see the file",
  "files.css": "badge foregrounds on fixed accent backgrounds",
};
bad = [];
for (const f of walk(join(ROOT, "src/styles"))) {
  const name = f.split(/[\\/]/).pop();
  if (ALLOWED_HEX[name]) continue;
  const hits = [...read(f).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  if (hits.length) bad.push(`${name}: ${hits.join(" ")}`);
}
ok("no stray hex outside tokens", bad.length === 0, bad.join("; "));

/* ---------- 6. clip content is escaped ----------
   Anyone with the session key can put markup on your clipboard, so every
   innerHTML assignment carrying peer content has to go through esc().

   Comments are stripped first — an earlier version flagged dom.js purely for
   the word "innerHTML" appearing in the doc comment above esc() itself. */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// Files whose innerHTML provably carries no peer content, with the reason.
const ESC_EXEMPT = {
  "src/ui/panels/editor.js": "gutter interpolates a loop index integer, nothing else",
  "src/ui/features/lockButton.js": "the template is a constant; every dynamic string it "
    + "later carries goes in through textContent or setAttribute",
};

/* setHTML() as well as innerHTML: the Trusted Types work moved every write
   through ui/primitives/dom.js, and a check that still only looked for `innerHTML =` would
   have gone quietly vacuous — passing because the modules no longer contain the
   pattern, not because they escape anything. */
bad = [];
for (const f of jsFiles.filter(f => /[\\/]ui[\\/]/.test(f))) {
  // dom.js DEFINES esc() and owns the one sink, so it never calls either.
  if (ESC_EXEMPT[rel(f)] || rel(f) === "src/ui/primitives/dom.js") continue;
  const src = stripComments(read(f));
  if (/innerHTML\s*=|setHTML\(/.test(src) && !/\besc\(/.test(src)) bad.push(rel(f));
}
ok("UI modules writing HTML also use esc()", bad.length === 0, bad.join(", "));

/* ---------- HTML is written in exactly one place ----------
   docs/ARCHITECTURE.md §5 makes "peer content is escaped before entering
   innerHTML" a security invariant, and an invariant enforced by 25 call sites
   remembering to call esc() is a convention wearing an invariant's clothes.
   ui/primitives/dom.js setHTML() is now the only sink, which is what lets the CSP's
   Trusted Types directive make it a rule the browser enforces rather than one
   a reviewer has to.

   `= ""` used to be exempt here, on the reasoning that Trusted Types lets the
   empty string through and "clear this node" is not an injection risk. The
   second half is true and the first half is not: Chromium throws on the empty
   string like any other, so four bare clears were live TypeErrors under our own
   CSP. statusMenu.js close() was one, and because every menu action closes
   before it acts, it took Copy link, Show QR, New key, Leave session, the lock
   controls and the relay picker down with it — plus closing on Escape or a
   click away. Nothing surfaced: close()'s callers all sat inside a catch.
   Use dom.js clear(). */
bad = jsFiles
  .filter(f => rel(f) !== "src/ui/primitives/dom.js")
  .filter(f => /\.innerHTML\s*=(?!=)/.test(stripComments(read(f))))
  .map(rel);
ok("innerHTML is written only in ui/primitives/dom.js", bad.length === 0,
   bad.length ? `${bad.join(", ")} — use setHTML() or clear()` : "");

/* ---------- 7. only the clipboard module touches the clipboard ----------
   What this protects is the echo loop, not the API: every read and write in
   the SESSION has to pass the suppression window in clipboard/capture.js, or
   a clip we just applied is seen as new and sent straight back (CLIPBOARD-FLOW
   §6). src/landing/ is exempt because it holds no session — the copy buttons
   on the marketing and help pages write a command string to the clipboard and
   never read it, so there is nothing there to echo. */
bad = jsFiles
  .filter(f => !f.includes("clipboard"))
  .filter(f => {
    const src = read(f);
    if (!/navigator\.clipboard/.test(src)) return false;
    // The exemption is write-only. A landing module that READS the clipboard
    // is back inside the loop this rule exists to prevent, so it still fails.
    return !rel(f).startsWith("src/landing/") || /navigator\.clipboard\.read/.test(src);
  })
  .map(rel);
ok("navigator.clipboard confined to clipboard/ (landing/ may write, not read)",
   bad.length === 0, bad.join(", "));

/* ---------- 8. UI modules do not import the transport ----------
   The boundary that let the transport stay swappable while everything else
   was built — and that later carried the whole SSE fallback in without one UI
   file changing. See docs/ARCHITECTURE.md §3.

   The channels count too, not just relay.js: the day someone reaches past the
   facade for ws.js or sse.js, the app starts knowing which pipe it is on and
   the swap stops being free.

   protocol.js is deliberately exempt. It is frame *shapes* — transport-agnostic
   by design and identical on both channels — and files/transfer.js reads its
   type constants rather than hand-copying eleven string literals. */
bad = jsFiles
  .filter(f => /[\\/](ui|files|clipboard)[\\/]/.test(f))
  .filter(f => /from\s+"[^"]*transport\/(relay|ws|sse)\.js"/.test(read(f)))
  .map(rel);
ok("no UI/files/clipboard module imports a transport channel", bad.length === 0, bad.join(", "));

/* ---------- 9. PWA assets present ---------- */
bad = ["manifest.webmanifest", "sw.js", "assets/icons/icon-192.png", "assets/icons/icon-512.png",
       "assets/icons/maskable-192.png", "assets/icons/maskable-512.png"]
  .filter(f => !existsSync(join(ROOT, f)));
ok("PWA assets present", bad.length === 0, bad.join(", "));

/* ---------- 10. service worker does not cache the relay ---------- */
const sw = read(join(ROOT, "sw.js"));
ok("service worker excludes the relay host",
   /fastapicloud|RELAY|ws:|wss:/.test(sw),
   "must skip relay traffic rather than cache it");

/* ---------- 11. the precache list matches what is on disk ----------
   cache.addAll() rejects as a unit, so ONE stale entry pointing at a deleted
   file kills the whole install and offline support stops working with no
   visible symptom. A hand-maintained list of 52 paths will rot; this makes
   the rot fail a test instead of shipping. */
const shellBlock = sw.match(/const SHELL = \[(.*?)\n\];/s)?.[1] ?? "";
const listed = new Set([...shellBlock.matchAll(/"(\.\/[^"]*)"/g)].map(m => m[1]));

const onDisk = new Set(["./", "./index.html", "./app.html", "./manifest.webmanifest"]);
for (const dir of ["src", "assets/icons"]) {
  for (const f of walk(join(ROOT, dir))) {
    // src/pages/ is content, not app shell: it is copied to the site root
    // rather than bundled, its pages are separate documents, and precaching
    // them would put marketing copy in the offline cache of an app that is
    // supposed to hold nothing.
    if (rel(f).startsWith("src/pages/")) continue;
    // assets/icons is precached whole; assets/social deliberately is not, which
    // is why the walk names the subdirectory rather than assets/.
    if (/\.(js|css)$/.test(f) || dir === "assets/icons") {
      onDisk.add("./" + rel(f));
    }
  }
}
const stale = [...listed].filter(p => !onDisk.has(p));
const unlisted = [...onDisk].filter(p => !listed.has(p));
ok(`precache list matches disk (${listed.size} entries)`,
   stale.length === 0 && unlisted.length === 0,
   [stale.length ? `stale: ${stale.join(" ")}` : "",
    unlisted.length ? `missing: ${unlisted.join(" ")}` : ""].filter(Boolean).join(" | "));

/* ---------- 12. nobody resolves a path from import.meta.url ----------
   `new URL("../../x", import.meta.url)` encodes how deep a module sits in the
   tree. Six of them did, and the deploy bundle collapses src/ui/*.js into
   src/main.js — which moves every one of those paths up a level at once, with
   no error. install.js resolved the app root to the Pages root and silently
   broke the service-worker scope and PWA installability (PRD OI-9).

   core/paths.js resolves it from document.baseURI instead, which is the same
   answer bundled or not. This keeps it that way. */
bad = jsFiles
  .filter(f => rel(f) !== "src/core/paths.js")
  .filter(f => /new URL\([^)]*import\.meta\.url/.test(read(f)))
  .map(rel);
ok("no module resolves a path from import.meta.url", bad.length === 0,
   bad.length ? `${bad.join(", ")} — use core/paths.js` : "");

/* ---------- 13-15. the CSP holds ----------
   Discovered the same way tools/build/build.mjs collects content pages — any
   directory under src/pages/ holding an index.html — so a page added later is
   covered here without anyone remembering to add it, and a dozen more are
   planned.

   The two app documents are named rather than scanned: they sit at the root and
   are the only HTML there. */
const pages = ["index.html", "app.html"].map(p => join(ROOT, p));
for (const f of walk(join(ROOT, "src/pages"))) {
  if (f.endsWith("index.html")) pages.push(f);
}

bad = pages.filter(f => !/http-equiv="Content-Security-Policy"/.test(read(f))).map(rel);
ok(`every page carries a CSP (${pages.length} pages)`, bad.length === 0, bad.join(", "));

/* An inline <script> is what forces 'unsafe-inline' or a hash, and the whole
   point of moving the landing page's fragment redirect into
   src/landing/redirect.js was that there were then none left. JSON-LD is not
   executable and script-src does not apply to it. */
bad = pages.filter(f => [...read(f).matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)]
  .some(m => !/type="application\/ld\+json"/.test(m[1]))).map(rel);
ok("no executable inline <script>", bad.length === 0,
   bad.length ? `${bad.join(", ")} — would need 'unsafe-inline' or a hash` : "");

/* The relay origin now lives in two places: RELAY_URL in core/config.js, and
   connect-src in every page's CSP. Deriving one from the other is impossible
   across a <meta> tag, so this asserts they agree instead — the same trade the
   precache list above makes. Getting it wrong presents as "the app loads and
   every connection is refused", which looks like an outage, not a typo. */
const relayHost = read(join(ROOT, "src/core/config.js"))
  .match(/DEFAULT_RELAY_URL\s*=\s*"wss:\/\/([^"]+)"/)?.[1];
/* Read the meta tag's content attribute, not the first "connect-src" in the
   file — the prose above the tag in app.html explains each directive by name,
   and matching that instead reported a mismatch on a page that was correct. */
bad = pages.filter(f => {
  const csp = read(f)
    .match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
  const connect = csp.match(/connect-src ([^;]+)/)?.[1] ?? "";
  return !connect.includes(`wss://${relayHost}`)
      || !connect.includes(`https://${relayHost}`);
}).map(rel);
ok(`CSP connect-src matches config.js relay (${relayHost})`,
   Boolean(relayHost) && bad.length === 0,
   !relayHost ? "could not read RELAY_URL from config.js" : bad.join(", "));

/* ---------- 16. every module a page loads is a build entry point ----------
   The deploy ships bundles, not the source tree. A module reachable only from
   markup — named in a <script src> and imported by nothing — is invisible to
   the bundler, so it never lands in _site and 404s on the single page that
   needs it. Nothing else catches this: the file exists on disk, the import
   graph is intact, and the page works perfectly in development. */
const buildSrc = read(join(ROOT, "tools/build/build.mjs"));
const entryNames = new Set([
  ...[...buildSrc.matchAll(/entryPoints:\s*\[([^\]]*)\]/gs)]
    .flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1])),
]);

bad = [];
for (const f of pages) {
  for (const m of read(f).matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) {
    const spec = m[1].replace(/^[./]*/, "");                    // src/landing/x.js
    const base = spec.split("/").pop().replace(/\.js$/, "");     // x
    const covered = [...entryNames].some(e => e === base || e.endsWith(spec) || e.includes(spec));
    if (!covered) bad.push(`${rel(f)} -> ${spec}`);
  }
}
ok("every module a page loads is a build entry point", bad.length === 0,
   bad.length ? `${bad.join("; ")} — add it to tools/build/build.mjs` : "");

/* ---------- 17. imports only ever point downhill ----------
   Check 8 pinned one edge of this — no UI module reaching for a transport
   channel — because that edge was the one carrying the SSE failover. The rest
   of the direction was documented and unenforced, which is how five UI modules
   came to import clipboard/ while ARCHITECTURE.md said none did.

   Rank a module by its directory and allow an import only downhill or within
   the same directory. main.js sits above everything precisely so it can be the
   one file that wires the layers together. */
const LAYER = {
  core: 0,
  transport: 10, clipboard: 10, files: 10, landing: 10,
  // ui/ splits by role, and the roles turn out to be ranks: panels compose
  // features and shell, and all three compose primitives. Shell and features
  // are peers that do not reference each other, so they share a rank — which
  // makes the first edge between them a failure rather than a precedent.
  "ui/primitives": 20, "ui/shell": 21, "ui/features": 21, "ui/panels": 22,
};
const layerOf = f => {
  const [, a, b] = rel(f).split("/");                    // src/<a>/<b>…
  return LAYER[`${a}/${b}`] ?? LAYER[a] ?? 99;           // main.js is above all
};

/* files/transfer.js reads protocol.js's type constants rather than hand-copying
   eleven string literals. Frame SHAPES are transport-agnostic by design — this
   is the one sideways edge the architecture actually wants. */
const SIDEWAYS_OK = new Set(["src/transport/protocol.js"]);

bad = [];
for (const f of jsFiles) {
  const from = layerOf(f);
  const specs = [...read(f).matchAll(/from\s+"(\.[^"]+)"/g)].map(m => m[1]);
  for (const spec of specs) {
    const target = rel(resolve(dirname(f), spec));
    if (dirname(target) === dirname(rel(f))) continue;          // same directory
    if (SIDEWAYS_OK.has(target)) continue;
    if (layerOf(join(ROOT, target)) < from) continue;           // downhill
    bad.push(`${rel(f)} -> ${target}`);
  }
}
ok("every import points downhill", bad.length === 0, bad.join("; "));

/* ---------- 18. a stylesheet is eager or lazy, never both ----------
   qr.css and history.css were @imported by main.css AND injected as a <link>
   by the panel that uses them, so both shipped twice — once inside the bundle
   and once over the wire. Nothing caught it: CSS is idempotent, so the page
   looked right.

   The directory is the answer now. styles/ is bundled, styles/lazy/ is copied
   and fetched on open, and core/paths.js can only address the second. */
const eager = new Set([...read(cssEntry).matchAll(/@import url\("\.\/([^"]+)"\)/g)].map(m => m[1]));
const lazyDir = walk(join(ROOT, "src/styles/lazy")).map(f => f.split(/[\\/]/).pop());
const flatSheets = readdirSync(join(ROOT, "src/styles"))
  .filter(n => n.endsWith(".css") && n !== "main.css");

bad = [
  ...lazyDir.filter(n => eager.has(n)).map(n => `${n}: in lazy/ and @imported`),
  ...flatSheets.filter(n => !eager.has(n)).map(n => `${n}: in styles/ but never @imported`),
];
/* And the reverse: a lazy sheet nobody fetches is dead weight the bundle never
   reveals, because it is not in the bundle. */
const fetched = new Set(jsFiles.flatMap(f =>
  [...read(f).matchAll(/lazyStyle(?:Href)?\("([^"]+)"\)/g)].map(m => m[1])));
bad.push(...lazyDir.filter(n => !fetched.has(n)).map(n => `${n}: in lazy/ but never fetched`));
ok(`every stylesheet loads exactly once (${eager.size} eager, ${lazyDir.length} lazy)`,
   bad.length === 0, bad.join("; "));

/* ---------- 19. paths named in prose still exist ----------
   Moving tests/ and tools/ into subdirectories broke sixty references across
   nine docs, a workflow, tauri.conf.json and a dozen source comments. Two were
   executed: the bundle suite shells out to the build, and release.mjs to the
   changelog generator — which would have broken `npm run release` with nothing
   in `verify` to notice.

   The rest are comments, and those fail more quietly still: nothing runs them,
   so a stale path is wrong only for whoever trusts it. Cheap to check, so all
   of it is checked, source included. */
const PROSE = [
  ...walk(join(ROOT, "docs")),
  ...walk(join(ROOT, ".github")),
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "tests")),
  ...walk(join(ROOT, "tools")),
  ...["README.md", "CONTRIBUTING.md", "CLAUDE.md", "package.json", "sw.js",
      "cli/realtimeclipboard.mjs", "backend/README.md", "backend/CLAUDE.md",
      "desktop/README.md", "desktop/CLAUDE.md", "desktop/src-tauri/tauri.conf.json",
      "vscode/README.md", "vscode/CLAUDE.md", "vscode/package.json"]
    .map(f => join(ROOT, f)),
].filter(f => /\.(md|ya?ml|json|m?js)$/.test(f) && existsSync(f));

bad = [];
for (const f of PROSE) {
  const src = read(f);
  for (const m of src.matchAll(/\b((?:tests|tools)\/[\w./-]+\.(?:mjs|py))/g)) {
    // Struck-through paths are deliberately historical — a doc may name a file
    // that was deleted when its milestone closed.
    if (src.includes(`~~\`${m[1]}\`~~`)) continue;
    if (!existsSync(join(ROOT, m[1]))) bad.push(`${rel(f)} -> ${m[1]}`);
  }
}
ok(`paths named in docs, config and comments resolve (${PROSE.length} files)`,
   bad.length === 0, bad.join("; "));

/* ---------- 20. every code directory documents itself ----------
   The rules that matter are the ones you meet while editing, so they live in a
   CLAUDE.md beside the code rather than in one file nobody opens. A new
   directory with neither is a directory whose rules are back to being folklore. */
const DOCUMENTED = [
  ...readdirSync(join(ROOT, "src")).map(d => `src/${d}`).filter(d => statSync(join(ROOT, d)).isDirectory()),
  "src", "tests", "tools", "cli", "backend", "desktop", "docs", "assets", "vscode",
];
bad = DOCUMENTED.flatMap(d => ["CLAUDE.md", "README.md"]
  .filter(f => !existsSync(join(ROOT, d, f)))
  .map(f => `${d}/${f}`));
ok(`every code directory has CLAUDE.md and README.md (${DOCUMENTED.length} dirs)`,
   bad.length === 0, bad.join(", "));

/* ---------- 21-23. the desktop build can actually start ----------
   Every one of these was true in a committed tauri.conf.json, through two tags,
   because nothing here ever read that file. The desktop app is built by CI on
   three runners; the cheapest of these checks is three minutes faster than
   finding out there. */
const TAURI_CONF = join(ROOT, "desktop/src-tauri/tauri.conf.json");
const SRC_TAURI = dirname(TAURI_CONF);
const conf = JSON.parse(read(TAURI_CONF));

/* A "//" key is not a comment. tauri-build deserializes this file with unknown
   fields DENIED, so one is a hard build failure — `unknown field '//version'` —
   not an ignored annotation. The reasoning lives in desktop/README.md instead. */
const commentKeys = [];
(function scan(node, path) {
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("//")) commentKeys.push(`${path}${k}`);
    scan(v, `${path}${k}.`);
  }
})(conf, "");
ok('no "//" comment keys in tauri.conf.json', commentKeys.length === 0,
   commentKeys.length
     ? `${commentKeys.join(", ")} — tauri-build denies unknown fields; the reasoning goes in desktop/README.md`
     : "");

/* bundle.icon named five files that were not in the repo. That is not only a
   bundling problem: build.rs runs tauri-build, which compiles the first .ico
   into the Windows resource, so a missing icon fails `cargo build` as well. */
const icons = [...(conf.bundle?.icon ?? []), conf.app?.trayIcon?.iconPath].filter(Boolean);
bad = icons.filter(p => !existsSync(join(SRC_TAURI, p)));
ok(`every desktop icon exists (${icons.length} named)`, bad.length === 0, bad.join(", "));

/* The version is written in three files and was different in all three. Tauri
   names every artifact from its copy, so a skew means the URLs in
   tools/release/manifest.mjs point at filenames that were never built. */
const pkgVersion = JSON.parse(read(join(ROOT, "package.json"))).version;
/* \r?\n throughout: these two files are checked out with CRLF on Windows, and a
   bare \n silently matches nothing — which reads as "the version is missing"
   rather than "the regex is wrong". */
const cargoVersion = read(join(SRC_TAURI, "Cargo.toml"))
  .match(/\[package\][\s\S]*?\r?\nversion = "([^"]+)"/)?.[1];
const lockVersion = read(join(SRC_TAURI, "Cargo.lock"))
  .match(/name = "realtimeclipboard"\r?\nversion = "([^"]+)"/)?.[1];
/* The config may either restate the version or point at package.json. Pointing
   is preferred — it is the copy that cannot drift — so both are accepted. */
const confOk = conf.version === "../../package.json" || conf.version === pkgVersion;
/* The extension manifest cannot point at package.json the way tauri.conf.json
   can — the Marketplace reads a literal — so it is a fifth copy that must not
   drift, and tools/release/release.mjs rewrites it with the others. */
const vsceVersion = JSON.parse(read(join(ROOT, "vscode/package.json"))).version;
ok(`desktop, extension and package.json versions agree (${pkgVersion})`,
   confOk && cargoVersion === pkgVersion && lockVersion === pkgVersion
     && vsceVersion === pkgVersion,
   `package.json ${pkgVersion}, Cargo.toml ${cargoVersion}, Cargo.lock ${lockVersion}, `
   + `tauri.conf ${conf.version}, vscode ${vsceVersion}`);

/* ---------- 23b-23f. the desktop shell's native half is actually reachable ----
   Every one of these shipped wrong, silently, and each has the same shape: the
   app kept running and quietly stopped being a desktop app. */
const MAIN_RS = read(join(SRC_TAURI, "src/main.rs"));

/* Without this, `globalThis.__TAURI__` does not exist — the default is false.
   Three modules feature-tested it and all three failed at once: T0 never
   started, incoming clips fell back to a path needing window focus, and the
   status bar reported a browser tier. The one reason the app exists, off, with
   no error anywhere. */
ok("desktop shell injects the JS API (withGlobalTauri)", conf.app?.withGlobalTauri === true,
   "without it globalThis.__TAURI__ is undefined and clipboard/ silently degrades to the browser");

/* Two builders means two icons. The config block builds one at Builder::build()
   with whatever the config can express — and it cannot express a per-platform
   show_menu_on_left_click, nor guarantee a menu exists at creation, which is
   what Linux needs before it will draw the icon at all. */
ok("the tray is built in exactly one place",
   (conf.app?.trayIcon === undefined) === /TrayIconBuilder/.test(MAIN_RS),
   "declare it in tauri.conf.json OR build it in main.rs, never both");

/* tauri-bundler writes deb.depends verbatim — it merges nothing and detects
   nothing (crates/tauri-bundler/src/bundle/linux/debian.rs). So the tray's
   runtime library is only there if this file names it. The alternation covers
   both: libappindicator3-1 is gone from newer Debian, libayatana- absent from
   older. */
ok("the .deb depends on an appindicator library",
   /appindicator/.test((conf.bundle?.linux?.deb?.depends ?? []).join(" ")),
   "the tray icon needs it at runtime and the bundler will not add it for you");

/* One owner for the native feature test, the way clipboard/os.js is the one
   owner of navigator.clipboard. Three independent sniffs is three chances to
   get the same answer wrong at once, which is exactly what happened. */
bad = jsFiles
  .filter(f => rel(f) !== "src/core/native.js")
  .filter(f => /__TAURI__|__TAURI_INTERNALS__/.test(stripComments(read(f))))
  .map(rel);
ok("Tauri globals confined to core/native.js", bad.length === 0, bad.join(", "));

/* Same rule, second host. A surface that declares itself is only safe while
   exactly one file reads the declaration — two readers is two answers, which is
   the failure the Tauri check above was written after. The extension ASSIGNS it
   (vscode/src/extension.js) and core/native.js READS it; nothing in src/ else. */
bad = jsFiles
  .filter(f => rel(f) !== "src/core/native.js")
  .filter(f => /__REALTIMECLIPBOARD_SURFACE__/.test(stripComments(read(f))))
  .map(rel);
ok("the declared-surface global is read only by core/native.js",
   bad.length === 0, bad.join(", "));

/* A bare generate() ignores the key-length setting. Two of the six call sites
   did, and they were the two that generate a key FOR the user rather than at
   their request: the first-run key and the collision retry. */
bad = jsFiles
  .filter(f => /keys\.generate\(\s*\)|[^.\w]generate\(\s*\)/.test(stripComments(read(f))))
  .map(rel);
ok("no bare generate() — key length comes from keys.nextLength()",
   bad.length === 0, bad.join(", "));

/* ---------- 24. no page advertises a channel that does not exist ----------
   /download/ shipped `winget install`, `scoop install`, `brew install --cask`,
   a Flathub line and `yay -S` while every one of them errored — there was no
   release, no bucket, no tap and no package. A command on a download page is a
   promise, and these are the ones the project has decided not to keep. Naming
   them in prose is fine ("there is no Flathub package"); printing them as
   something to run is not. */
const DEAD = ["scoop install", "scoop bucket add", "yay -S ", "flatpak install ", "snap install "];
bad = [];
for (const f of pages) {
  for (const cmd of DEAD) if (read(f).includes(cmd)) bad.push(`${rel(f)}: "${cmd}"`);
}
ok(`no page prints a command for a dropped channel (${DEAD.length} checked)`,
   bad.length === 0, bad.join(", "));

console.log("\n" + "=".repeat(56));
console.log(`STATIC: ${pass}/${pass + fail} passed`);
console.log("=".repeat(56));
process.exit(fail ? 1 : 0);
