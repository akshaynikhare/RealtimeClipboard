/**
 * The gate raised when a locked link has no PIN.
 *
 * The scrim, the card and the inert shell are ui/shell/gate.js — this file is
 * only the words and the two buttons, which are bus events, so it knows nothing
 * about keys or rooms.
 *
 * It does NOT cover a WRONG PIN, which is not detectable: a wrong PIN lands you
 * in a different, empty room, exactly what being first to arrive looks like, and
 * gating on "alone in a locked room" would grey out every session the moment its
 * creator opened it. That case stays a banner — see ui/shell/banners.js.
 */

import { on, emit, EV } from "../../core/bus.js";
import { t } from "../../core/i18n.js";
import * as gate from "./gate.js";

const ICON = `<rect x="4" y="10" width="16" height="10" rx="2"/>`
  + `<path d="M8 10V7a4 4 0 018 0v3"/>`;

export function init() {
  on(EV.LOCK_REQUIRED, ({ required }) => (required ? raise() : gate.drop()));
}

function raise() {
  gate.raise({
    icon: ICON,
    title: t("This session is locked"),
    body: t("It needs its PIN before this device can join. The PIN is not in the "
        + "link — whoever sent it to you has to pass it on separately."),
    actions: [
      { label: t("Enter PIN"), onClick: () => emit("session:relock") },
      { label: t("Start a new session"), ghost: true, onClick: () => emit("session:rotate") },
    ],
    note: t("A new session is a different room with a new key, open to anyone you "
        + "give the link to. It does not get you into this one."),
  });
}
