# RealtimeClipboard — realtime clipboard sync for VS Code

A **shared clipboard between your machines**. Copy on one, paste on another. Text is encrypted in the
editor before it leaves, routed by a hash of your key through a relay that stores nothing and can
read nothing.

It keeps syncing while VS Code is in the background, which is the thing a web page cannot do — so
this is a clipboard that follows you rather than one you have to go and fetch from.

Works with the [web app](https://realtimeclipboard.com/app), the desktop app and the CLI — they all
speak the same protocol, so one session can have any mix of them in it. Copy in a terminal on a
server, paste in your editor at home.

Also on [Open VSX](https://open-vsx.org/extension/cadnative/realtimeclipboard), so it installs in
Cursor, Windsurf, VSCodium, Gitpod and code-server too.

## Use it

1. **RealtimeClipboard: New Session** from the command palette. A key appears in the status bar.
2. **Copy Share Link**, and open it on your other machine — or run `npx realtimeclipboard <KEY>`
   there, or paste the key into this extension's **Join Session…**.
3. Copy something. It lands on the other machine's clipboard.

| Command | |
|---|---|
| New Session · Join Session… | start or enter a room |
| Copy Share Link | a link that opens the same room in a browser |
| Send Selection | <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> — share what is selected without touching your clipboard |
| Insert Latest Clip at Cursor | <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> |
| History… | this window's clips, kept in memory only |
| Lock Session… | add a PIN, so the link alone is not enough |

The status bar shows the key, the connection and how many other devices are in the room. Click it
for the same menu.

## What it is good for

- **Sync your clipboard between two computers** — a laptop and a desktop, a host and a VM, a Mac and
  a Windows box. Any pair, any direction.
- **Move text off a remote machine** without scp or a paste bin: `npx realtimeclipboard send KEY`
  over SSH, and it arrives in your editor.
- **A clipboard history for this session** — the last 20 clips, in a QuickPick, held in memory and
  never written to disk.
- **Hand something to a phone** with the QR code, without typing a key.

It is not a local clipboard manager. It does one thing local managers do not: cross the gap between
machines, encrypted, without an account.

## Sync modes

One setting, three rungs, each adding one thing to the one below:

- **off** — nothing leaves and nothing arrives.
- **manual** — the session syncs, but your system clipboard is never read or written.
- **live** — your system clipboard is wired to the room, both directions. The default.

VS Code keeps watching the clipboard while it is in the background, which a web page fundamentally
cannot do. `realtimeclipboard.pollWhenUnfocused` turns that off if you would rather it only looked
while you are in the editor.

## What is protected, and what is not

- The relay sees a room hash and ciphertext. Not your key, not your PIN, not your text — those never
  leave the machine, and are never logged.
- Keys are stored in your **OS keychain**, not in a settings file. Turning off
  `realtimeclipboard.rememberKey` erases what is already stored.
- Clip history lives in memory and dies with the window. It is never written to disk.
- Anyone holding the key can join the room, so **an arriving clip is not trusted**. Trailing
  newlines and invisible characters are stripped from every one, and a clip that reads like a shell
  command is held until you click — the integrated terminal is one keystroke away from your
  clipboard, and that is the whole reason for the rule.
- A locked session opens no connection at all until the PIN is given.

## Limits

No file transfer here — that needs WebRTC, which the extension host does not have. Use the
[web app](https://realtimeclipboard.com/app) or the desktop app in the same room for files.

Needs VS Code 1.100 or newer, where the extension host is on Node 22+ and has the `WebSocket` and
`crypto.subtle` globals this shares with the browser.

## Source

[github.com/akshaynikhare/RealtimeClipboard](https://github.com/akshaynikhare/RealtimeClipboard) ·
MIT licensed · [report an issue](https://github.com/akshaynikhare/RealtimeClipboard/issues)
