/**
 * The door. CommonJS, because vscode/package.json has no "type" field and the
 * extension host require()s this file — everything behind it is .mjs and real
 * ES modules importing ../../src/** unchanged.
 *
 * Two things must be true before the FIRST module under src/ evaluates, which is
 * why they are here and at module top level rather than inside activate():
 * config.js reads localStorage at module scope to resolve the relay URL, and
 * state.js calls crypto.randomUUID() at module scope. esbuild's CJS output runs
 * this body at require() time, so this is the earliest point that exists.
 */

// Declared, never sniffed: process.env.VSCODE_PID is set inside VS Code's
// integrated terminal too, so `realtimeclipboard watch …` typed there would
// otherwise claim to be the extension. See src/core/native.js.
globalThis.__REALTIMECLIPBOARD_SURFACE__ = "vscode";

const storage = require("./storage.js");

let stop = null;

async function activate(context) {
  const vscode = require("vscode");

  // Synchronous and ordered on purpose: the shims must exist before the dynamic
  // import below resolves, and require() gives that guarantee where an await
  // between two imports would not.
  await storage.install(context, vscode);

  // A literal specifier inside a thunk. `import(variable)` is opaque to esbuild
  // and would 404 in the packaged .vsix alone — see CLAUDE.md's bundler trap.
  const { run } = await import("./main.mjs");
  stop = await run(context, vscode);
}

function deactivate() {
  if (stop) { stop(); stop = null; }
}

module.exports = { activate, deactivate };
