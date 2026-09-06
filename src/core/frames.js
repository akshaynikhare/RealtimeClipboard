/**
 * Sealing and opening signalling frames.
 *
 * The relay is a blind pipe (docs/P2P-FILES.md §4). Signalling in the clear
 * would hand it every SDP, every ICE candidate — including peer IPs — and, on
 * the fallback path, every byte of every file. Routing fields stay readable
 * because the relay must deliver the frame; everything else is sealed with the
 * session key.
 *
 * Its own module rather than a pair of private functions in main.js because
 * both halves of it are security rules — what may travel unsealed, and what a
 * payload may not claim — and a rule with no test is a rule until someone
 * edits it.
 */

import * as cryptoBox from "./crypto.js";
import * as state from "./state.js";

/**
 * Readable to the relay, because it has to route on them. `from` is the one the
 * relay STAMPS: it is the connection a frame arrived on, and the only field a
 * client cannot choose.
 */
export const ROUTING_FIELDS = new Set([
  "t", "to", "from", "originId", "id", "seq", "total", "crc",
]);

/**
 * Frame types allowed to arrive with no envelope, because they carry nothing
 * but routing. Set by the composition root from the files layer's own list —
 * inferring it would mean guessing, and guessing wrong in the permissive
 * direction is the bug this exists to prevent.
 */
let plaintext = new Set();

export function setPlaintextFrames(types) {
  plaintext = new Set(types ?? []);
}

export async function encryptFrame(frame) {
  const { aesKey } = state.get();
  if (!aesKey) return frame;

  const routing = {}, secret = {};
  for (const [k, v] of Object.entries(frame)) {
    (ROUTING_FIELDS.has(k) ? routing : secret)[k] = v;
  }
  if (!Object.keys(secret).length) return frame;

  const { payload, iv } = await cryptoBox.encrypt(aesKey, JSON.stringify(secret));
  return { ...routing, payload, iv };
}

/**
 * Open a sealed frame, or refuse it. Two things this must not do, both of which
 * it used to.
 *
 * It must not pass an UNSEALED frame through. A frame arriving with no envelope
 * was returned as it came, so anything that could reach the relay — the relay
 * itself included — could inject editor text, fake file announcements with
 * their thumbnails, and RTC negotiation into a session whose key it does not
 * hold. Only frames carrying nothing BUT routing may legitimately arrive in the
 * clear, and they are named rather than inferred.
 *
 * And it must not let decrypted content overwrite the routing. The merge ran
 * secret-last, so a session member could seal `from: someoneElsesPeerId` inside
 * a payload and displace the relay's stamp — the field file-retraction
 * ownership is checked against.
 */
export async function decryptFrame(frame) {
  const { aesKey } = state.get();
  if (!aesKey) return null;                     // no session: nothing is trusted

  if (!frame.payload || !frame.iv) {
    if (plaintext.has(frame.t)) return frame;
    console.warn("[realtimeclipboard] dropped an unsealed frame", frame.t);
    return null;
  }

  try {
    const secret = JSON.parse(await cryptoBox.decrypt(aesKey, frame.payload, frame.iv));
    state.setVerified();          // a sealed frame opened: the PIN is right
    const { payload, iv, ...routing } = frame;

    // A sealed payload has no business carrying routing: encryptFrame() splits
    // them out before sealing, so one that arrives inside is a forgery or a bug.
    for (const field of ROUTING_FIELDS) {
      if (!(field in secret)) continue;
      console.warn(`[realtimeclipboard] ignored sealed routing field "${field}"`, frame.t);
      delete secret[field];
    }

    // Routing spread LAST as well, so the relay's stamp wins even if the strip
    // above is ever loosened.
    return { ...secret, ...routing };
  } catch {
    // Should be unreachable — drop rather than hand files a half-frame.
    console.warn("[realtimeclipboard] undecryptable signalling frame", frame.t);
    return null;
  }
}
