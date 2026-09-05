/**
 * Runs INSIDE a real VS Code extension host, via --extensionTestsPath.
 *
 * CommonJS, because that is what VS Code require()s. Everything else about the
 * extension is checked under a fake `vscode` in tests/dom/extension.mjs; what
 * only a real host can answer is whether the real API shapes match the ones that
 * fake asserts — a stub agrees with whatever it was written against, including
 * a method that does not exist.
 *
 * Results go to a file rather than stdout: the host's console is interleaved
 * with everything else VS Code says on startup, and the launcher needs a verdict
 * it can exit on.
 */

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

/**
 * The launcher passes the report path in, rather than setting it in the
 * environment: on macOS the only way to reach a window server from a
 * non-interactive shell is `open -a`, which goes through LaunchServices, and
 * LaunchServices does NOT carry the caller's environment. It does carry the
 * command line, so host.mjs generates a one-line entry point holding a path
 * unique to that run and points --extensionTestsPath at it.
 *
 * The default is for pointing --extensionTestsPath straight at this file by
 * hand. Two runs sharing it would fight over one report; the launcher does not.
 */
const DEFAULT_OUT = join(tmpdir(), "realtimeclipboard-editor-test.json");

exports.run = async (out = DEFAULT_OUT) => {
  const vscode = require("vscode");
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok, detail: String(detail) });

  const ID = "akshaynikhare.realtimeclipboard";
  const ext = vscode.extensions.getExtension(ID);
  check("the extension is present in a real host", Boolean(ext), ID);

  if (ext) {
    await ext.activate();
    check("it activates without throwing", ext.isActive === true);
  }

  // The manifest's ids against the real command registry — the fake can only
  // check them against itself.
  const all = await vscode.commands.getCommands(true);
  const contributed = (ext?.packageJSON?.contributes?.commands ?? []).map(c => c.command);
  const missing = contributed.filter(c => !all.includes(c));
  check(`every contributed command is registered (${contributed.length})`,
    contributed.length > 0 && missing.length === 0, missing.join(", "));

  // The real clipboard, through the real host, on the real OS.
  const probe = `realtimeclipboard-host-probe-${Date.now()}`;
  const before = await vscode.env.clipboard.readText();
  try {
    await vscode.env.clipboard.writeText(probe);
    check("vscode.env.clipboard round-trips", await vscode.env.clipboard.readText() === probe);
  } finally {
    await vscode.env.clipboard.writeText(before);      // leave the user's clipboard alone
  }

  // A command that touches no network, executed for real.
  try {
    await vscode.commands.executeCommand("realtimeclipboard.pasteLatest");
    check("a command executes in the real host without throwing", true);
  } catch (err) {
    check("a command executes in the real host without throwing", false, err.message);
  }

  check("the host is the runtime the extension was built for",
    typeof WebSocket === "function" && typeof crypto?.subtle === "object",
    `node ${process.versions.node}, WebSocket ${typeof WebSocket}`);

  writeFileSync(out, JSON.stringify({
    vscode: vscode.version, node: process.versions.node, results,
  }, null, 2));

  const failed = results.filter(r => !r.ok);
  if (failed.length) throw new Error(`${failed.length} check(s) failed in the extension host`);
};
