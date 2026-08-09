# Threat model

What RealtimeClipboard protects, what it does not, and the arithmetic behind both.

`PRD.md` §7 is the requirement and the design argument. This file is the **published** version:
written for someone who has opened the network tab, does not trust the marketing copy, and wants
the numbers. Where the two disagree, this file is newer.

Scope: the hosted service at `realtimeclipboard.com` and the relay in `backend/`, as of
**2026-08-08**, v0.5.0. No third-party audit has been done. Nothing here has been reviewed by
anyone but the author — read it as a self-assessment, not an assurance.

---

## 1. The one-paragraph version

Text is encrypted with AES-GCM-256 in your browser before it is sent. The relay stores nothing on
disk and routes by a room hash that is **derived through the same 250,000-iteration PBKDF2 as the
encryption key**, so the value the relay holds cannot be turned back into your share key without
paying that cost per guess. Generated keys are 10 characters, which puts a full sweep of the
keyspace at roughly 19 years on 100 GPUs. A PIN-locked session raises it further and also hides
that the session exists at all.

**This is what v0.5.0 changed, and §4 records what it was before** — the room hash used to be an
unsalted SHA-256 of the key, which the relay operator could reverse in well under a second. If you
are reading this because you saw that earlier version, §4 is the section you want.

---

## 2. What the relay can see

The relay is one Python file. It holds room state in memory, writes nothing to disk, and has no
database — `backend/Dockerfile` declares no `VOLUME` and no writable path deliberately.

| It sees | It does not see |
|---|---|
| The room hash | The share key, directly |
| Ciphertext and its length | Plaintext of clips, files or filenames |
| Device nicknames, sent in the clear on `hello` | Your identity — no account, no email, no cookie |
| Routing fields: `originId`, `id`, `seq`, `total`, `crc` | Which device is which person |
| Message timing and frequency | File contents — those go peer-to-peer |
| Connection IP addresses | |

Signalling and cursor frames are sealed like clips (`encryptFrame()`); only routing fields stay in
the clear. Without that the relay would learn every SDP, ICE candidate and peer IP.

**Metadata is not hidden.** A locked session hides content and membership, not the existence of a
session. The relay knows some room had devices in it at some time.

---

## 3. The keys, and what each is worth

Generated keys are drawn from a 30-character alphabet (`23456789ABCDEFGHJKMNPQRSTVWXYZ` — no
`0/O`, no `1/I/L`).

| | Keyspace | Entropy | Full sweep, 100 GPUs |
|---|---:|---:|---:|
| 10 characters — default | 5.9 × 10¹⁴ | **49.1 bits** | ~19 years |
| 16 characters — "longer keys" in settings, default on desktop | 5.3 × 10²³ | **78.5 bits** | out of reach |

**6 characters was the default until v0.5.0 and has been removed.** At 29.4 bits a full sweep is
~12 minutes on 100 rented GPUs — and because the open salt is one global constant, that table is
built once and then opens every unlocked 6-character session ever created. No iteration count
fixes a keyspace that small. Keys of any length from 4 to 32 are still *accepted*, because a key
from another build or an older link has to keep working; nothing shorter than 10 is *generated*.

Two derivations, from `src/core/crypto.js`:

```
OPEN      prk       = PBKDF2-SHA256(KEY, "realtimeclipboard-v1", 250k)
          aesKey    = HKDF(prk, ".../aes")
          roomHash  = HKDF(prk, ".../room")   -> sent to the relay

LOCKED    prk       = PBKDF2-SHA256(PIN, "realtimeclipboard-lock-v1:" + KEY, 600k)
          aesKey    = HKDF(prk, ".../aes")
          roomHash  = HKDF(prk, ".../room")   -> sent
          authToken = HKDF(prk, ".../auth")   -> sent, proves PIN knowledge
```

---

## 4. The weakness that v0.5.0 fixed

> **Resolved 2026-08-08.** The construction described below shipped from the first release until
> v0.5.0. It is kept in full because it is the evidence for why the change was worth a wire-format
> break, and because anyone who read the earlier version of this file deserves to see what
> replaced it rather than a paragraph quietly disappearing. **What follows describes the OLD
> behaviour.** The resolution is at the end of the section.

**Read the two derivations as they were.** `aesKey` is stretched with 250,000 PBKDF2 iterations.
`roomHash` is a single SHA-256 with a fixed prefix and **no per-session salt and no stretching**.

The room hash is what travels to the relay. So the attack is not "brute-force the ciphertext", it
is "brute-force the room hash", and the room hash is the cheap one. Recovering `KEY` from it hands
over `aesKey` for one further PBKDF2 run.

Order-of-magnitude, one consumer GPU, SHA-256 at ~10 GH/s:

| Attack on an **unlocked** session | 6-char key | 10-char key |
|---|---|---|
| Sweep the whole keyspace | **0.07 seconds** | **16.4 hours** |
| Precomputed roomHash → key table | **10.2 GB** — build once, reuse forever | 10.6 PB — infeasible |
| Then: recover `aesKey` | one PBKDF2 run | one PBKDF2 run |

**A 10-character key does not fix this.** It defeats the *table*, but a targeted preimage search
against one room hash is under a day on a single GPU, and hours on a handful.

### What this means in practice

- **Against a passive network observer** — someone on your Wi-Fi, your ISP, a coffee-shop router —
  the design holds. The room hash travels inside TLS, so they never see it.
- **Against the relay operator, or anyone who obtains relay logs, metrics or memory** — an
  unlocked session is **not** end-to-end encrypted in any meaningful sense. They hold the room
  hash by construction. For a 6-character key, recovering the plaintext is minutes of work with a
  table that fits on a cheap SSD.
- **A PIN-locked session is unaffected.** There `roomHash` is HKDF over a 600k-iteration PBKDF2
  whose salt includes the share key, so no global table exists and each guess costs a full PBKDF2.
  This is the correct construction, and the codebase already contains it.

### What shipped instead — v0.5.0

Two changes, together, because neither is sufficient alone.

**1. The room hash is derived from the PBKDF2 output**, exactly the shape `deriveLocked()` always
used. It costs nothing at runtime: that PBKDF2 was already awaited before the connection opened,
so the room hash is one extra HKDF expansion over a value already in hand. `deriveKey()` and
`roomHash()` were merged into a single `deriveOpen()` — two exported functions is precisely what
allowed a caller to obtain a room hash without ever paying for the derivation.

**2. Generated keys went from 6 characters to 10**, and the "longer keys" option from 10 to 16.
This is the part that is easy to skip and must not be. Change 1 alone leaves a 6-character sweep
at ~40 GPU-hours — and since `SALT` is one global constant, that table is built **once** and then
opens every unlocked 6-character session, for every user, permanently. Roughly $30 of rented GPU,
forever. A keyspace that small cannot be rescued by an iteration count.

| Full sweep of the keyspace | before | after |
|---|---:|---:|
| default key | **0.07 s** (6 chars, bare SHA-256) | **~19 years on 100 GPUs** (10 chars, PBKDF2) |
| "longer keys" | 16.4 h | out of reach (16 chars) |

**The cost was a wire-format break**: every share link created before v0.5.0 resolves to a
different room, and the golden vectors in `tests/unit/lock.mjs` were rebaselined — which is what
those vectors exist to force. `lock.mjs` now also asserts the room hash is *not* the bare SHA-256,
so the cheap path cannot be reintroduced quietly.

### Why not Argon2

Argon2 is the better password hash and PBKDF2-HMAC-SHA256 is the dated one; that is not in dispute.
It is also **not the problem here**, and swapping it would fix nothing: the weakness is an
unstretched room hash, and an unstretched SHA-256 is equally unstretched whatever the *other*
derivation uses. Fix the construction first.

There is also a practical constraint worth stating plainly, because "just use Argon2" is the
predictable reply: `crypto.subtle` implements PBKDF2 and does not implement Argon2. Using Argon2
in the browser means shipping WebAssembly, which this project has avoided precisely so that the
whole cryptographic surface is a 175-line file anyone can read. That is a defensible trade at
250k/600k iterations. It would stop being defensible if it were being used as a reason not to fix
§4 — it was not, and §4 is now fixed.

---

## 5. Guessing and enumeration, online

Enumerating room hashes *against the live relay* is a different and much worse deal for the
attacker than offline work, which is the point of the limits in `backend/main.py`:

- `MAX_PEERS = 8` per room.
- Token buckets per connection, per class: **10 msg/s** interactive, 60 signalling, 400 bulk,
  60 HTTP. Over budget answers `RATE_LIMITED`; the HTTP path answers `429`.
- Rooms are evicted after **10 minutes idle**, so a room hash is only interesting while someone is
  using it.
- A locked room additionally checks `authToken` at join, trust-on-first-use per room. This is
  defence in depth against derivation bugs — the room's *name* already required the PIN — and is
  no defence against the relay operator.

None of this helps against §4, because §4 does not require talking to the relay at all.

---

## 6. The PIN, when a link leaks

The case the lock exists for: the link was forwarded, screenshotted, or pasted into a group chat.
Against someone **who has the link**, the share key contributes **zero** bits and the PIN is the
entire secret. One consumer GPU, PBKDF2-HMAC-SHA256 at 600k:

| PIN | Entropy | Offline |
|---|---|---|
| `1234` | ~13 bits | seconds |
| `445566` | ~20 bits | minutes |
| 6 characters, human-chosen | ~22 bits | minutes |
| 6 characters, mixed alphabet | ~36 bits | weeks |
| 4 dictionary words | ~52 bits | infeasible |

The UI reports entropy in bits at the point of entry rather than calling a short PIN "secure". The
minimum is 6 characters and free-form rather than 4–6 digits, because a 4-digit PIN is ~13 bits.

---

## 7. Files, WebRTC, and what happens when P2P fails

Files go **directly between the two browsers** over a WebRTC data channel and do not touch the
relay. They are encrypted in transit by DTLS, and the application layer encrypts on top, so no
fallback path ever exposes plaintext.

**There is no TURN server, deliberately.** TURN would fix connectivity on restrictive networks by
relaying the bytes — which costs bandwidth linear in file size and puts the operator back in the
data path, both of which contradict the design. `src/files/transfer.js` uses one public STUN
server (`stun.l.google.com:19302`), which learns only that some IP asked for its own reflexive
address.

**It does not silently fail.** Direct connection is attempted for `ICE_TIMEOUT_MS` (5 seconds);
if no candidate pair forms — the usual cause is a corporate network blocking UDP — the transfer
**falls back to relay-chunked delivery and is labelled visibly in the UI**. The relay sees
ciphertext chunks, the same as it does for text. `docs/P2P-FILES.md` §4 is the long version.

Limits: **5 MB** per file, 20 files per session, memory only.

---

## 8. What is out of scope

- **A compromised endpoint.** Malware, a hostile browser extension, or someone reading your screen
  defeats every clipboard tool including this one. The clipboard is readable by any app on the
  machine by design.
- **Traffic analysis.** Frame sizes and timing are not padded.
- **The relay operator's honesty about §2.** You are trusting a deployment you cannot inspect.
  `deploy/docker-compose.yml` brings up your own with TLS in one command; that is the answer, and
  it is why the Dockerfile has no volume.
- **Availability.** No uptime guarantee. Room state is in RAM and dies with the process.
- **Anything after decryption.** History is `sessionStorage` on your own device.
- **The third-party tags, as of 2026-08-09.** Google Analytics and AdSense run site-wide,
  `app.html` included — the no-ads-in-the-app rule was removed on that date. Google's script
  therefore runs in the document that holds decrypted clipboard text, and this model does not
  defend against what it does there; that is an accepted disclosure, stated in `/privacy/`.
  What *is* enforced: the ad tag never loads while the share key is in the URL
  (`ui/features/ads.js` waits for boot to strip the fragment), and `pageLocation()` strips the
  fragment from every analytics call, so the key itself is never reported. See
  `docs/ARCHITECTURE.md` §5.

---

## 9. Reporting

`SECURITY.md` has the contact. Findings that contradict anything above are the most valuable kind
— particularly §4, which was found by reading the code rather than by an attack, and which nobody
outside the project has yet checked.
