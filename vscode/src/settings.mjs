/**
 * VS Code's contributes.configuration is the source of truth on this surface,
 * and it flows ONE WAY into state.js. The shimmed settings blob is vestigial
 * here; two writers would be two sources of truth.
 *
 * Every value maps onto a constant that already exists in src/core/config.js. A
 * setting here never introduces a tunable — see vscode/CLAUDE.md.
 */

import * as state from "../../src/core/state.js";
import * as capture from "../../src/clipboard/capture.js";
import { POLL_OPTIONS, SYNC_MODES } from "../../src/core/config.js";

const SECTION = "realtimeclipboard";

/** The stored strings are a compatibility surface everywhere else; the enum in
 *  package.json must not fork from them, so it is checked rather than trusted. */
const asMode = (v) => (Object.values(SYNC_MODES).includes(v) ? v : SYNC_MODES.LIVE);

/** POLL_OPTIONS is keyed by label ("1s"); the setting is the number. */
const pollLabel = (ms) =>
  Object.keys(POLL_OPTIONS).find(k => POLL_OPTIONS[k] === ms) ?? "1s";

export function init(vscode, { host, secrets }) {
  const read = () => vscode.workspace.getConfiguration(SECTION);

  async function apply({ first = false } = {}) {
    const cfg = read();
    const mode = asMode(cfg.get("syncMode"));
    const poll = pollLabel(cfg.get("pollMs"));
    const remember = cfg.get("rememberKey") !== false;

    const before = state.get().settings.syncMode;
    state.setSetting("syncMode", mode);
    state.setSetting("poll", poll);
    state.setSetting("rememberKey", remember);

    host.applySettings({ poll, whenUnfocused: cfg.get("pollWhenUnfocused") !== false });

    // applyMode() starts or stops the ladder and discards a clip owed under a
    // rung the user just left. Only on a real change — it emits.
    if (!first && mode !== before) capture.applyMode();

    // The switch is about what is on disk, not only about what happens next.
    if (!remember) await secrets.forget();
  }

  const sub = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(SECTION)) apply();
  });

  return { apply, dispose: () => sub.dispose() };
}

/** relayUrl is deliberately absent above: config.js resolves RELAY_URL at module
 *  scope, so it is seeded in storage.js before the first src/ import and a change
 *  needs a window reload. Saying so is better than pretending it is live. */
export const NEEDS_RELOAD = ["relayUrl"];
