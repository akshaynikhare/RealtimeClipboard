/**
 * The gate raised when a link named a key we will not hash.
 *
 * `#F5H4` used to open a session. Four characters is ~19.6 bits — 810,000 rooms
 * for the whole alphabet, which a laptop enumerates — and the relay routes any
 * of them quite happily, so nothing downstream was ever going to object. The
 * floor is KEY.MIN_LENGTH and it is enforced here, at the only place a person
 * can type one.
 *
 * A gate rather than a banner because main.js opens no session at all for a
 * refused key: dropping through to a freshly generated one put two people who
 * followed the same bad link into two different rooms, with the app looking
 * perfectly healthy in both.
 *
 * The GitHub link is there because "your link is wrong" is the kind of message
 * that is occasionally the app's fault, and the person best placed to say so is
 * the one reading it.
 */

import { on, emit, EV } from "../../core/bus.js";
import { KEY, LINKS } from "../../core/config.js";
import { entropyBits } from "../../core/keys.js";
import { esc } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";
import * as gate from "./gate.js";

const ICON = `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2h.01"/>`;

export function init() {
  on(EV.KEY_REJECTED, ({ key, reason }) => raise(key, reason));
}

/** Read back in fives, the way the guide and the header print a key. */
const grouped = key => String(key).replace(/(.{5})(?=.)/g, "$1 ");

function raise(key, reason) {
  const n = String(key).length;
  const min = KEY.MIN_LENGTH;

  const body = reason === "long"
    ? t("That is {n} characters. A share key can be at most {max}.", { n, max: KEY.MAX_LENGTH })
    : n === 1
      ? t("That is 1 character, worth about {bits} bits. The room's name is a hash of the key, "
        + "so a short one is quick for someone else to guess their way into. A key needs at "
        + "least {min} characters.", { bits: Math.round(entropyBits(n)), min })
      : t("That is {n} characters, worth about {bits} bits. The room's name is a hash of the "
        + "key, so a short one is quick for someone else to guess their way into. A key needs "
        + "at least {min} characters.", { n, bits: Math.round(entropyBits(n)), min });

  const link = `<a href="${esc(LINKS.NEW_ISSUE)}" target="_blank" `
    + `rel="noopener noreferrer">${t("report it on GitHub")}</a>`;

  gate.raise({
    icon: ICON,
    title: reason === "long" ? t("That key is too long") : t("That key is too short"),
    body,
    subject: grouped(key),
    actions: [
      { label: t("Start a new session"), onClick: () => emit("session:rotate") },
    ],
    note: t("Nothing was opened and nothing was sent. If you believe this key "
        + "should work, {link} — but never paste a "
        + "key you are actually using into an issue.", { link }),
  });
}
