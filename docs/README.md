# docs/

| Doc | What it covers |
|---|---|
| [PRD.md](PRD.md) | Requirements, architecture, security model, and the `OI-*` open issues the code refers to by number |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module layout, the layer rule, security invariants, and where a feature belongs |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Running it locally, the test suite, the landing-page grid and globe, and the traps |
| [RELEASING.md](RELEASING.md) | Hooks instead of CI, tag-triggered deploys, and the generated changelog |
| [CLIPBOARD-FLOW.md](CLIPBOARD-FLOW.md) | How the browser reaches the OS clipboard, and why background capture is impossible |
| [P2P-FILES.md](P2P-FILES.md) | Thumbnails over the relay, bytes over WebRTC, and the corporate-network problem |
| [ACCESSIBILITY.md](ACCESSIBILITY.md) | Keyboard paths, focus handling, and what the screen reader announces |
| [SELF-HOSTING.md](SELF-HOSTING.md) | Running your own relay and pointing a build at it |
| [THREAT-MODEL.md](THREAT-MODEL.md) | What the relay can see, what an attacker can reach, and what is out of scope |

Per-directory rules live next to the code: [../src/CLAUDE.md](../src/CLAUDE.md),
[../tests/CLAUDE.md](../tests/CLAUDE.md), [../tools/CLAUDE.md](../tools/CLAUDE.md), and one in each
subdirectory under `src/`.

- [`decisions/`](decisions/) — Architecture Decision Records. Why a choice was made,
  and what breaks if it is undone.
