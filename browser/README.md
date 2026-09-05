# RealtimeClipboard for the browser

Send what you copied to your other machines, end-to-end encrypted. The relay stores nothing and can
read nothing — it sees a room hash and ciphertext.

## Use it

1. Click the icon → **New session**, then **Copy share link**.
2. Open that link on your other device, or join from its own RealtimeClipboard app.
3. **Send my clipboard** — or <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>.
4. **Get latest clip** — or <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd>.

## It does not sync in the background, and no browser extension can

Chrome does not give a service worker access to the clipboard, and an offscreen document cannot read
it either because the API needs document focus. Every clipboard read here therefore happens because
you asked for one — a click or a keyboard shortcut.

If you want a clipboard that follows you without being asked, install the
[desktop app or the VS Code extension](https://realtimeclipboard.com/download/). Those can watch,
because they are not web pages.

## Safety

Anyone with the key can join the room, so an arriving clip is not trusted. Invisible characters and
trailing newlines are stripped from every one, and a clip that reads like a shell command is shown
in the popup rather than written to your clipboard — the keyboard shortcut refuses it outright.

## Build it

```bash
node tools/build/build-browser.mjs        # → browser/dist/pkg
node tools/build/build-browser.mjs --zip  # → the upload zip
```

Load `browser/dist/pkg` at `chrome://extensions` → Developer mode → Load unpacked.

Rules that govern edits here: [CLAUDE.md](CLAUDE.md).
