# realtimeclipboard-mcp

An end-to-end encrypted clipboard, as tools for an AI agent. Drop a clip from Claude Code on one
machine and pick it up in a browser, an editor or a terminal on another — or the other way round.

Text is encrypted before it leaves the machine and routed by a hash of the key. The relay stores
nothing and can read nothing.

## Install

```json
{
  "mcpServers": {
    "realtimeclipboard": {
      "command": "npx",
      "args": ["-y", "realtimeclipboard-mcp"]
    }
  }
}
```

Set `REALTIMECLIPBOARD_RELAY` to point at your own relay. Needs Node 22+.

## Tools

| | |
|---|---|
| `new_session` | start a session and get a share link for your other device |
| `join_session` | join one by key or link, with a PIN if it is locked |
| `send_clip` | share text with every device in the session |
| `recent_clips` | what has arrived, newest first |
| `wait_for_clip` | block until the next clip lands — for "I'm about to copy something" |

## Read this before you wire it to an agent

**Clips are attacker-controlled.** Anyone holding the key can join the room and send anything, and
a model reading a clip may act on what it reads. That is a prompt-injection surface.

What this server does about it: every clip is stripped of invisible characters and trailing newlines
before you see it, one that reads like a shell command is labelled as such, and every tool that
returns clip text says in its own description that the content is data rather than instructions.

What it does **not** do: run anything. There is no shell, no file access and no `eval` in this
server. Treat the labelling as advice to the model and that as the actual control.

Share keys with people, not with rooms you do not control.

## Source

[github.com/akshaynikhare/RealtimeClipboard](https://github.com/akshaynikhare/RealtimeClipboard) ·
MIT · rules that govern edits here: [CLAUDE.md](CLAUDE.md)
