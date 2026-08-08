# src/clipboard/ — rank 10

May import `core/`. May not import `transport/`, `files/` or `ui/`.

**`os.js` is the only file in the repository that may touch `navigator.clipboard`.** The static
check greps for it everywhere else. Two calls, one boundary — so the browser quirks, the permission
states and the failure modes all live in one readable file instead of being rediscovered per panel.

## The suppression ordering is the subtle part

In `capture.js` `apply()`, `lastSent` and the suppression window are set **before** writing to the
OS clipboard. Write first and the poller sees a "new" clipboard value one tick later, decides it is
a local capture, and bounces it back to the sender — forever. See `docs/CLIPBOARD-FLOW.md` §6.

## The rung owns both directions

`bindsClipboard(syncMode)` gates reading **and** writing, and neither has a switch of its own.
Receiving used to: it defaulted on and was independent of the mode, so a device set to Manual
stopped sending while arriving clips still landed on its system clipboard — the half nobody
expected. If you are about to add a flag that governs one direction, you are rebuilding that bug.

## An arriving clip is attacker-controlled

`guard.js` defuses every clip that comes off the wire before it reaches the OS clipboard, and
`apply()` is the only caller. E2EE protects a clip from the relay; it protects nobody from the other
people in the room, and the room is joinable by whoever holds the key.

Two rules that look like one:

- **Defusing is unconditional.** Trailing newlines and invisible characters are stripped with no
  setting to turn it off. The trailing newline is what makes a pasted line *run* in a terminal
  instead of sitting there.
- **A flagged clip needs a click, and `flushPending()` is not it.** Regaining focus auto-flushes a
  waiting clip, which is right for one held because `writeText()` needed focus and catastrophic for
  one held because it reads like `curl … | sh`. `confirmPending()` is the only path that writes a
  flagged clip; `flushPending()` steps over them.

`putOnClipboard()` is not defused. That is the user restoring their own history, where rewriting
what they saved would be the bug.

`apply()` is for clips arriving from a peer and defers to a recent local copy
(`TEXT.LOCAL_COPY_GRACE_MS`). `putOnClipboard()` is for the user deliberately asking — restoring
from history — and bypasses that window, because the window exists to protect against *remote*
writes. Both go through `writeNow()`, which owns the ordering below.

## Rules

- Capture tiers are T0–T3 and they all funnel through one `capture()`. The desktop shell's native
  watcher is T0 and feeds the same funnel, which is why `main.js` and the editor needed no changes
  for it. Text read off THIS machine's clipboard goes through `fromClipboard()`, which marks the
  local-copy clock first.
- **T1 skips pastes aimed at an editable control.** The editor commits its own pastes through
  idle/blur — capturing them at the document too is what doubled every paste — and what goes into
  the PIN field, or any input, is that field's business, never a clip. The image branch stays
  unconditional: a textarea cannot hold an image, so the files layer is the only home it has.
- No web app can read the clipboard in the background, on any browser — `readText()` requires
  window focus. Do not add code that appears to work around this; document it instead.
- Firefox and Safari cannot read the clipboard silently. Feature-detect and degrade; never assume
  Chromium.
- This directory announces what it captured on the bus. It does not know the network exists.
