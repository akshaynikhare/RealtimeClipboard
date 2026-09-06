/**
 * Proving a locked session, without spending the room's replay slot.
 *
 * A wrong PIN is silent by design. The PIN is stretched into the room hash, so
 * mistyping it does not get you turned away from the right room — it puts you
 * in a different, empty one, which on screen is indistinguishable from being
 * the first to arrive. Something in the room has to be readable before the app
 * can tell those apart.
 *
 * That used to be a sentinel clip planted on arrival, and the cost was the
 * room's single retained clip (FR-3.3): proving the PIN either overwrote the
 * last thing the user copied, or — once the plant started honouring the sync
 * rung — was skipped in a way that left correctly-joined devices being warned
 * their PIN might be wrong. The two guards could not both hold, because the
 * proof and the user's data were competing for one slot.
 *
 * So the proof is its own frame now. It is forwarded and not retained, which
 * removes the competition rather than arbitrating it.
 *
 * Everything here is dependency-injected rather than imported, and not for
 * purity: `build` is a frame shape (rank 10) and `send` is the transport (also
 * rank 10), neither of which core/ may reach. It buys the thing that matters
 * anyway — every rule below is reachable from a test with four fakes, instead
 * of being four lines in the composition root that only a source-reading check
 * can see.
 */

import { LOCK, sharesSession } from "./config.js";
import * as state from "./state.js";

/**
 * @param build  proto.verify — the frame shape
 * @param seal   frames.encryptFrame
 * @param send   relay.send
 * @param gen    () => the session generation, so a seal that outlived its room is dropped
 */
export function createVerifier({ build, seal, send, gen, now = () => Date.now() }) {
  /**
   * "Never asked", which is not the same as "asked at time zero". Spelled 0, it
   * is a real timestamp that happens to be in 1970, and the first probe of a
   * session is refused for being too soon after it. Invisible against
   * Date.now(), and a dead session under any injected clock.
   */
  let lastAsk = -Infinity;

  /**
   * Bumped by cancel(). `gen` covers the same ground in the app — leaveRoom()
   * moves it — but this module must be able to abandon in-flight work on its
   * own, or "cancel" would mean "ask the caller nicely".
   */
  let epoch = 0;

  /**
   * The relay has to know the frame type. An older one answers UNKNOWN_TYPE,
   * which arrives looking exactly like a probe nobody chose to answer — and the
   * difference between those two is "your PIN is wrong" and "this relay needs
   * redeploying". Asked rather than guessed, and there is deliberately no
   * fallback to the old retained beacon: silently spending the replay slot
   * again is the behaviour being removed, not a degraded mode to keep.
   */
  const relaySupports = () => (state.get().relayCaps ?? []).includes("verify");

  /**
   * Off means nothing leaves. Both directions: a device on Off does not ask,
   * and does not answer either. Answering is a frame put on the wire for
   * somebody else's benefit, which is exactly what an Off device has said it
   * will not do — and a rung that leaks for control traffic is a rung that does
   * not mean what the UI says.
   */
  function eligible() {
    const s = state.get();
    return !!s.aesKey
      && s.locked
      && sharesSession(s.settings.syncMode)
      && relaySupports();
  }

  /**
   * Checked before sealing and again immediately before sending, because the
   * seal is an await: a room change, a rung change or a cancel can all land
   * inside it, and a frame sealed for the room we left is either undecryptable
   * noise in the room we arrived at or an Off device transmitting after the
   * fact.
   */
  async function transmit(probe) {
    if (!eligible()) return false;
    const g = gen(), e = epoch;
    const frame = await seal(build({ probe, originId: state.get().originId }));
    if (g !== gen() || e !== epoch) return false;
    if (!eligible()) return false;
    send(frame);
    return true;
  }

  return {
    /**
     * Ask the room to prove itself. Only worth doing unverified and in company:
     * a probe into an empty room is answered by nobody, and once anything has
     * decrypted the question is settled for the life of the session.
     */
    async request() {
      const s = state.get();
      if (s.verified || s.peers <= 1) return false;
      // Before the interval stamp, so an ineligible attempt does not consume
      // the window. It is the Off device that most needs the next call to get
      // through — enabling sharing is a trigger, and swallowing it would strand
      // the device that just asked to be included.
      if (!eligible()) return false;
      if (now() - lastAsk < LOCK.VERIFY_MIN_INTERVAL_MS) return false;
      lastAsk = now();
      return transmit(true);
    },

    /**
     * Answer one, if it is a question. `probe !== true` is the whole loop guard
     * and it is one-directional on purpose: an answer can never produce another
     * frame, so two unverified devices converge in one exchange instead of
     * trading proof until the rate limiter stops them.
     *
     * Answered even when already verified — this is a service to the asker, not
     * to us — and answered by an unverified device too, which by then has
     * decrypted the probe and so is about to be verified itself.
     */
    async answer(frame) {
      if (!frame || frame.probe !== true) return false;
      if (frame.originId && frame.originId === state.get().originId) return false;
      return transmit(false);
    },

    /**
     * Proof nobody asked for, sent when this device becomes able to give it.
     *
     * Without it the rung is a one-way trapdoor. A device that was on Off while
     * a peer probed did not answer — correctly — and the peer has no reason to
     * ask again: its trigger was the arrival, and nobody new is going to
     * arrive. So coming off Off has to push, not wait to be pulled.
     *
     * Safe to fire unconditionally because an answer is not a probe: it ends
     * there, however many devices send one at once.
     */
    async announce() {
      if (state.get().peers <= 1) return false;
      return transmit(false);
    },

    /** Abandon anything in flight. Called from the session teardown. */
    cancel() {
      epoch++;
      lastAsk = -Infinity;       // a new room may ask at once
    },
  };
}
