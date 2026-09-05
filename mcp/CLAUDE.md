# mcp/ — the agent surface

One file, and how little of it there is *is* the design — the same claim `cli/` makes.

It speaks MCP over stdio directly rather than through `@modelcontextprotocol/sdk`: the whole server
is five tools and a request switch, and a dependency to write a `switch` on `method` would be the
first runtime dependency this repository has ever had.

The protocol and crypto come from `cli/session.mjs`, which the CLI and the VS Code extension also
use. **Nothing here may reimplement a protocol detail.**

## The rule that is specific to this surface

**What an agent reads here is attacker-controlled, and unlike a person it may act on it.**

A room is joinable by anyone holding the key. Everywhere else in this codebase that fact produces a
defused clipboard write; here it produces text going into a model's context, which is a
prompt-injection surface and has to be treated as one.

- Every clip is defused through `clipboard/guard.js` before it is returned, exactly as one bound for
  the OS clipboard is.
- Every tool that returns clip text repeats, in its own description and in its output, that the text
  is data and not instructions.
- A clip that `looksExecutable()` is **labelled, not refused.** Refusing would break the legitimate
  case — moving a command between machines is a thing people use this for — and the label is advice
  to the model, not a control.
- **The control is that this server executes nothing.** No shell, no file writes, no `eval`. If that
  ever stops being true, the labelling above stops being sufficient and the design has to change.

## Rules

- **stdout is the transport.** A stray `console.log` is a parse error at the client, which presents
  as "the server is broken" with nothing saying why. Diagnostics go to stderr.
- The share key and the PIN are never logged. `new_session` returns the link because the user asked
  for it; nothing else prints either.
- The version is read from the root `package.json`, never written here — the same reason
  `cli/CLAUDE.md` gives, and the same bug it records.
- `mcp/package.json` depends on `realtimeclipboard` rather than vendoring `cli/` and `src/`. That is
  what keeps one copy of the crypto, and it is why the version is pinned to the same release.
- `server.json` is the Model Context Protocol registry manifest. Its `version` is a sixth copy of the
  release number; `tests/unit/static-check.mjs` checks it agrees.
