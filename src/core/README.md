# src/core/

Foundations. No DOM, no network, no imports from elsewhere in `src/` — which is what lets the CLI
and the node test suites run these files unchanged.

| File | What it does |
|---|---|
| `bus.js` | Tiny pub/sub. The only channel between modules, and the `EV.*` name constants |
| `config.js` | Every tunable constant, the relay address, and the crypto parameters |
| `state.js` | Session state and the setters that announce changes |
| `crypto.js` | Room hashing, PBKDF2/HKDF derivation, AES-GCM. No libraries |
| `keys.js` | Share-key generation, normalisation, the URL fragment, and the link a peer opens |
| `storage.js` | localStorage, wrapped so a disabled-storage browser degrades instead of throwing |
| `paths.js` | Where the app is served from, resolved once for the whole codebase |
| `device.js` | A human-readable name for this device, shown in the peer list |
| `history.js` | In-session clip history — the model behind the history pane |

Rules that govern edits here: [CLAUDE.md](CLAUDE.md).
