/**
 * Pastejacking defence for clips arriving from a peer.
 *
 * E2EE protects a clip from the relay. It does nothing to protect you from the
 * other people in the room, and the room is joinable by anyone holding the key.
 * `apply()` hands peer-supplied text straight to the OS clipboard — on the
 * Clipboard rung in the desktop shell that happens with no focus and no click —
 * so a peer has a write primitive to the thing you are about to paste into a
 * terminal.
 *
 * The classic payload ends in a newline: the shell runs it on paste, before the
 * line can be read. Removing that newline is most of the defence and costs
 * nothing, which is why it is unconditional rather than a setting.
 *
 * !! Applies to the ARRIVING path only. `putOnClipboard()` is the user restoring
 * from their own history, where mangling what they saved would be the bug. !!
 */

import { PASTE_GUARD } from "../core/config.js";
import { stripInvisible, hasInvisible } from "../core/text.js";

/** Trailing blank lines, however many. One of them is the auto-execute. */
const TRAILING_NEWLINES = /\n+$/;

/**
 * Make an arriving clip safe to place on the clipboard, without changing what it
 * says.
 *
 * Order is load-bearing, and is what makes this idempotent: strip the invisibles
 * BEFORE the trailing newlines. A payload ending LF + NUL keeps its newline
 * otherwise — the trailing-newline pattern does not match while the NUL is still
 * there, and nothing looks again once it has gone.
 */
export function defuse(text) {
  if (typeof text !== "string") return "";
  return stripInvisible(text.replace(/\r\n/g, "\n"))
    .replace(TRAILING_NEWLINES, "");
}

/**
 * Ordered most-specific first, because the first match is the reason shown.
 *
 * Anchored to the start of the clip or of a line: `curl` inside a paragraph is
 * prose, `curl` beginning a line is an instruction. That is also what keeps an
 * article about installing software from tripping this on every read.
 */
const PATTERNS = [
  {
    pattern: /(?:^|\n)[ \t]*(?:curl|wget)[^\n]*\|[ \t]*(?:sudo[ \t]+)?(?:ba|z|k|d)?sh\b/i,
    reason: "it pipes a download into a shell",
  },
  {
    pattern: /(?:^|\n)[ \t]*(?:powershell|pwsh)[^\n]*[-/]e(?:nc|ncoded(?:command)?)?[ \t]/i,
    reason: "it is an encoded PowerShell command",
  },
  {
    pattern: /(?:^|\n)[ \t]*(?:iex|invoke-expression|eval)\b/i,
    reason: "it evaluates a string as code",
  },
  {
    pattern: /(?:^|\n)[ \t]*(?:sudo|doas)[ \t]+\S/i,
    reason: "it asks for administrator rights",
  },
  {
    pattern: /(?:^|\n)[ \t]*rm[ \t]+-[a-z]*[rf]/i,
    reason: "it deletes files recursively",
  },
  {
    pattern: /(?:^|\n)[ \t]*(?:chmod|chown|dd|mkfs|shutdown|reboot)[ \t]+\S/i,
    reason: "it is a system command",
  },
  {
    pattern: /(?:^|\n)[ \t]*(?:ba|z|k)?sh[ \t]+-c[ \t]/i,
    reason: "it runs a shell with an inline script",
  },
  {
    pattern: /(?:^|\n)[ \t]*(?:python3?|perl|ruby|node)[ \t]+-[ce][ \t]/i,
    reason: "it runs an inline script",
  },
  {
    pattern: /(?:^|\n)[ \t]*(?:curl|wget|nc|ncat|telnet)[ \t]+\S/i,
    reason: "it contacts a network host",
  },
];

/**
 * Does this look like something a shell would run?
 *
 * Returns a short human reason, or null. Deliberately a heuristic with a low
 * bar: the cost of a false positive is one extra click on a banner that was
 * already the design for a clip arriving unfocused, and the cost of a false
 * negative is a command the user pasted without reading. It is not a parser and
 * cannot be — the goal is to make the dangerous case require a gesture, not to
 * classify every string correctly.
 */
export function looksExecutable(text) {
  if (!PASTE_GUARD.ENABLED) return null;
  const s = String(text ?? "").trim();
  if (!s) return null;

  // Line by line, and nothing is skipped for being large. A whole clip over the
  // scan budget used to return "safe", which made the guard opt-out: the limit
  // sat below the clip limit, so 8 KB of padding in front of `curl … | sh` was
  // enough to have it written to the OS clipboard with no click. Padding BEFORE
  // the payload also defeats scanning only the first N characters — every
  // pattern is anchored to the start of a line, so the payload can sit at the
  // start of any line, at any depth.
  //
  // Per line is the same test with a bound that holds: no pattern spans a
  // newline, so no single regex ever sees more than one line.
  for (const line of s.split("\n")) {
    // A line too long to check is not a line known to be safe. It costs one
    // click, on the banner that a clip arriving unfocused already uses.
    if (line.length > PASTE_GUARD.MAX_SCAN_CHARS) return "it is too long to check";
    for (const { pattern, reason } of PATTERNS) {
      if (pattern.test(line)) return reason;
    }
  }
  return null;
}

/**
 * Did defuse() remove something invisible, as opposed to merely trimming the
 * newline that most clips end with?
 *
 * Only the first is worth telling the user about. Announcing the second on every
 * paste would train people to ignore the banner that matters.
 */
export function wasAltered(raw) {
  return typeof raw === "string" && hasInvisible(raw.replace(/\r\n/g, "\n"));
}
