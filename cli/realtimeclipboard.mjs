#!/usr/bin/env node
/**
 * RealtimeClipboard on the command line.
 *
 * The interesting thing about this file is how little of it there is. It
 * imports the SAME modules the browser runs — core/crypto.js, core/keys.js,
 * transport/relay.js — because none of them ever touched `window` or
 * `document`, and Node has had `WebSocket`, `fetch` and `crypto.subtle` as
 * globals since 22. So the CLI gets the heartbeat, the jittered reconnect
 * backoff, the WebSocket→SSE failover and the encryption for free, and cannot
 * drift from the browser's behaviour, because there is nothing here to drift.
 *
 * That is also the constraint: nothing in this file may reimplement a protocol
 * detail. If something is missing, it belongs in src/ where both ends get it.
 *
 *   realtimeclipboard <KEY>              two-way: prints what arrives, sends what you type
 *   realtimeclipboard watch <KEY>        prints incoming clips and nothing else
 *   realtimeclipboard send <KEY>         reads stdin to EOF, sends it, exits
 *   realtimeclipboard new                prints a fresh key
 *
 * Made for pipes, so the rules are the usual ones: clip content goes to stdout
 * and nothing else does, and the exit code is what a script should branch on.
 */

import { createInterface } from "node:readline";
import { stdin, stdout, stderr, argv, exit, env } from "node:process";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";

import * as keys from "../src/core/keys.js";
import * as relay from "../src/transport/relay.js";
import * as room from "./session.mjs";
import { DEFAULT_RELAY_URL, normaliseRelay, TEXT } from "../src/core/config.js";
import { INVISIBLE_SOURCE } from "../src/core/text.js";

/**
 * Read from package.json rather than written here.
 *
 * It was a literal, and it was already wrong: the package said 0.2.1 while
 * `--version` said 0.1.0. That is the failure this codebase avoids everywhere
 * else by deriving — RELAY_HTTP_URL from RELAY_URL, LINKS from REPO, the
 * service worker's precache list from disk — and a version number is the worst
 * place to have it, because the whole point of the number is telling someone
 * which code they are running when they report a bug.
 *
 * import.meta.url is correct HERE and banned in src/: this file is published as
 * itself and never goes through the bundler, so its depth in the tree is fixed.
 * npm always includes package.json in a tarball, so this resolves after install.
 */
const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/* ------------------------------------------------------------------ args -- */

function parse(args) {
  const opts = {
    relay: null, pin: null, once: false, json: false, timeout: 0, quiet: false,
    // A CLI key gets pasted into shells, scripts and CI configs, where length is
    // friction with no QR code to fall back on — so unlike the installed desktop
    // app this stays short unless asked. REALTIMECLIPBOARD_LONG is the way to
    // ask once, for a machine that generates a lot of them.
    long: !!process.env.REALTIMECLIPBOARD_LONG,
  };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => args[++i];
    if (a === "--relay") opts.relay = val();
    else if (a === "--pin") opts.pin = val();
    else if (a === "--timeout") opts.timeout = Number(val()) * 1000;
    else if (a === "--once") opts.once = true;
    else if (a === "--long") opts.long = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-q" || a === "--quiet") opts.quiet = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a.startsWith("-")) die(`unknown option ${a}`, 2);
    else rest.push(a);
  }
  return { opts, rest };
}

const USAGE = `realtimeclipboard ${VERSION} — an online clipboard, on the command line

  realtimeclipboard <KEY>              two-way; prints what arrives, sends what you type
  realtimeclipboard watch <KEY>        print incoming clips
  realtimeclipboard send <KEY>         read stdin to EOF and send it
  realtimeclipboard new [--long]       print a fresh key

Options
  --relay <url>    relay to use            (default ${DEFAULT_RELAY_URL})
                   or set REALTIMECLIPBOARD_RELAY
  --pin <pin>      join a locked session   (or set REALTIMECLIPBOARD_PIN)
  --long           new: a 10-character key (~49 bits) instead of 6 (~29 bits)
                   or set REALTIMECLIPBOARD_LONG
  --once           watch: exit after the first clip
  --json           one JSON object per line instead of raw text
  --timeout <s>    give up after this many seconds
  -q, --quiet      no status on stderr
  -h, --help       this
  -v, --version    version

Examples
  echo "deploy key" | realtimeclipboard send D75LV
  realtimeclipboard watch D75LV > clip.txt
  realtimeclipboard watch D75LV --once --json | jq -r .text
  ssh box 'cat /etc/hosts' | realtimeclipboard send D75LV

The key is a bearer credential: anyone holding it can read the session while it
is open. Clip contents are encrypted here, before they are sent; the relay only
ever sees a room hash and ciphertext.`;

/* ---------------------------------------------------------------- output -- */

/**
 * Escape sequences, stripped from clip text before it reaches a terminal.
 *
 * A clip is written by whoever else is in the room, and printing it raw hands
 * them the terminal's own control channel. That is not theoretical: OSC 52 sets
 * the TERMINAL's clipboard, so `realtimeclipboard watch` printing an untrusted
 * clip is a pastejacking primitive against the machine running it — the exact
 * attack src/clipboard/guard.js exists to stop in the browser. Others retitle
 * the window, or use a bare CR to redraw the tail of a line over its head so
 * that what is displayed is not what was sent.
 *
 * Built from strings so this file contains no literal control characters — a
 * literal one is invisible in a diff, which is the property being defended
 * against.
 *
 *   CSI   ESC [ … final byte   colours, cursor movement
 *   OSC   ESC ] … BEL or ST    window title, and clipboard writes
 *   two-character escapes, then any ESC left over
 *   INVISIBLE_SOURCE          the single characters, shared with the browser
 *                             halves via core/text.js. A terminal needs the
 *                             sequences above ON TOP of that class, not instead
 *                             of it, which is why this composes rather than
 *                             redefining the ranges.
 */
const TERMINAL_UNSAFE = new RegExp([
  "\\u001B\\[[0-9;?]*[ -/]*[@-~]",
  "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
  "\\u001B[@-Z\\\\-_]",
  "\\u001B",
  INVISIBLE_SOURCE,
].join("|"), "g");

/**
 * Only when stdout is a terminal.
 *
 * A pipe is not a terminal and has no control channel to hijack, and the
 * documented uses of this tool are pipes — `watch KEY > clip.txt`,
 * `--json | jq`. Rewriting bytes there would corrupt the payload to defend
 * against a threat that is not present. `--json` is additionally safe by
 * construction: JSON.stringify escapes every one of these.
 */
const forTerminal = text => (stdout.isTTY ? text.replace(TERMINAL_UNSAFE, "") : text);

const note = (msg, opts) => { if (!opts.quiet) stderr.write(`${msg}\n`); };

/** How long EOF waits for queued lines to finish leaving. */
const DRAIN_MS = 5_000;

function die(msg, code = 1) {
  stderr.write(`realtimeclipboard: ${msg}\n`);
  exit(code);
}

/* --------------------------------------------------------------- session -- */

/**
 * Derived exactly as the browser derives it, because it is the same function —
 * see cli/session.mjs. This wrapper exists only to turn a throw into an exit
 * code, which is the part a pipe cares about.
 */
async function derive(rawKey, pin) {
  try { return await room.derive(rawKey, pin); }
  catch (err) { die(err.message, 2); }
}

/**
 * Connect and resolve once the relay has welcomed us. The adapter is shared; what
 * stays here is the CLI's own reporting — a `--quiet`-aware note on a transport
 * error, and a line on stderr for a clip this key cannot read.
 */
function connect(sess, opts, onClip) {
  const url = opts.relay ?? env.REALTIMECLIPBOARD_RELAY ?? undefined;
  if (opts.relay && !normaliseRelay(opts.relay)) die(`"${opts.relay}" is not a usable relay address`, 2);

  return room.open({
    session: sess,
    name: `cli@${hostname()}`,
    url: url ? normaliseRelay(url) : undefined,
    timeoutMs: opts.timeout || 0,
    onClip,
    onState: (state, detail) => { if (state === "error" && detail) note(`  ${detail}`, opts); },
    onUndecryptable: () => note("  (a clip arrived that this key cannot read)", opts),
  });
}

/**
 * Throws rather than exiting. `send` is one shot and dies on a failure, but
 * two-way mode has a session to keep: killing the process on one refused line
 * would drop the reader half too.
 */
async function sendText(sess, text) {
  if (!text) throw new Error("nothing on stdin to send");
  if (text.length > TEXT.MAX_CHARS) {
    throw new Error(`that is ${text.length} characters; the limit is ${TEXT.MAX_CHARS}`);
  }
  await room.send(sess, text, `cli-${Date.now().toString(36)}`);
  // The frame is handed to a socket, not delivered. Give it a moment to flush
  // before the process exits out from under it.
  await new Promise(r => setTimeout(r, 250));
}

const readStdin = () => new Promise(resolve => {
  let buf = "";
  stdin.setEncoding("utf8");
  stdin.on("data", d => { buf += d; });
  stdin.on("end", () => resolve(buf));
});

/**
 * `seq` and `originId` are the only provenance there is, and that is on purpose:
 * the relay rebuilds a clip envelope from scratch (backend/main.py, "clip") and
 * carries neither a timestamp nor a sender identity on it. `at` is therefore
 * when THIS process received it, and is labelled as such rather than implying a
 * send time nobody recorded.
 */
const emitClip = (text, msg, opts) => stdout.write(
  opts.json
    ? `${JSON.stringify({ text, seq: msg.seq ?? null, origin: msg.originId ?? null, receivedAt: new Date().toISOString() })}\n`
    : (t => t.endsWith("\n") ? t : `${t}\n`)(forTerminal(text)),
);

/* ------------------------------------------------------------------ main -- */

const { opts, rest } = parse(argv.slice(2));
if (opts.help) { stdout.write(`${USAGE}\n`); exit(0); }
if (opts.version) { stdout.write(`${VERSION}\n`); exit(0); }

opts.pin ??= env.REALTIMECLIPBOARD_PIN ?? null;

let [cmd, keyArg] = rest;
if (cmd === "new") {
  stdout.write(`${keys.generate(opts.long ? keys.LENGTHS.LONG : keys.LENGTHS.NORMAL)}\n`);
  exit(0);
}
// `realtimeclipboard D75LV` — no verb, so the first word is the key and the mode is both.
if (cmd && !["send", "watch"].includes(cmd)) { keyArg = cmd; cmd = "both"; }
if (!cmd) { stdout.write(`${USAGE}\n`); exit(2); }
if (!keyArg) die(`${cmd} needs a key — try: realtimeclipboard ${cmd} D75LV`, 2);

if (typeof WebSocket === "undefined") {
  die("this needs Node 22 or newer (for the built-in WebSocket)", 3);
}

const session = await derive(keyArg, opts.pin);
note(`realtimeclipboard · room ${session.roomHash.slice(0, 8)}…${session.locked ? " · locked" : ""}`, opts);

/**
 * --timeout bounds the WHOLE run, not just the connection.
 *
 * The distinction matters and was got wrong first time. `watch --once` on a
 * room nobody sends to connects perfectly happily and then waits forever — and
 * with a locked room that is not even an error, because the wrong PIN names a
 * different room, which legitimately exists and is legitimately empty. A
 * connect-only timeout leaves every one of those cases hanging a pipeline.
 */
if (opts.timeout) {
  setTimeout(() => {
    relay.close();
    note(`  timed out after ${opts.timeout / 1000}s`, opts);
    exit(5);
  }, opts.timeout).unref?.();
}

let got = 0;
try {
  await connect(session, opts, (text, msg) => {
    got++;
    emitClip(text, msg, opts);
    if (cmd === "watch" && opts.once) { relay.close(); exit(0); }
  });
} catch (err) {
  die(err.message, 4);
}
note("  connected", opts);

if (cmd === "send") {
  try {
    await sendText(session, await readStdin());
  } catch (err) { die(err.message, 2); }
  relay.close();
  exit(0);
}

if (cmd === "both") {
  // Not readStdin(): that waits for EOF, and this mode has to send each line as
  // it is typed while still printing what arrives in between.
  const rl = createInterface({ input: stdin, terminal: false });
  // Chained, not launched: each line is encrypted before it is sent, and two
  // encryptions in flight complete in whichever order WebCrypto finishes them.
  // A pasted block of lines could reach the relay out of order and be stamped
  // with inverted `seq`, which is what receivers order and dedupe by.
  let sending = Promise.resolve();
  let failed = false;
  rl.on("line", line => {
    if (!line.length) return;
    sending = sending
      .then(() => sendText(session, line))
      .catch(err => { failed = true; note(`  ${err.message}`, opts); });
  });

  // Drained, not abandoned. `close` fires the moment stdin ends, and calling
  // exit() there killed the chain mid-flight: piping three lines in sent none of
  // them, because the first was still being encrypted — and the exit status said
  // it had worked. Bounded, so a wedged relay cannot hold the process open.
  rl.on("close", async () => {
    // Which of the two won matters: the timeout winning means lines are still
    // unsent, and exiting 0 there reports a success that did not happen — the
    // same overstatement as the send path that ignored its own return value.
    const drained = await Promise.race([
      sending.then(() => true, () => true),
      new Promise(done => setTimeout(() => done(false), DRAIN_MS)),
    ]);
    relay.close();
    if (!drained) note("  timed out with lines still unsent", opts);
    exit(failed || !drained ? 4 : 0);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    relay.close();
    note(`  ${got} clip${got === 1 ? "" : "s"} received`, opts);
    exit(0);
  });
}
