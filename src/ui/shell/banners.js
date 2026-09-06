/**
 * Inline banners above the editor: clipboard permission, pending clips, and the
 * split-brain warning.
 *
 * Self-contained — builds its own DOM under #mount-banners so no markup lives
 * in index.html for it. Each banner is keyed, so showing the same key twice
 * updates rather than stacks.
 */

import { on, emit, EV } from "../../core/bus.js";
import { TRANSPORT, RELAY_URL } from "../../core/config.js";
import * as state from "../../core/state.js";
import * as capture from "../../clipboard/capture.js";
import { $, esc, setHTML, autoDismiss, nextFrame } from "../primitives/dom.js";
import { t } from "../../core/i18n.js";

const banners = new Map();
/** key -> a function that cancels that banner's auto-dismiss timer. */
const timers = new Map();
let mount;

/**
 * How long a locked session gets to prove itself before we say anything.
 *
 * Long enough that the ordinary case — you locked a session five seconds ago
 * and your phone has not been picked up yet — never sees the banner, short
 * enough that a mistyped PIN is caught before you have pasted a password into
 * a room nobody is listening to.
 */
const LOCK_DOUBT_MS = 12_000;
let lockDoubt = null;

/** The relay's host:port as a person would type it to their IT desk. */
function relayHost() {
  try { return new URL(RELAY_URL).host; } catch { return RELAY_URL; }
}

export function init() {
  mount = $("mount-banners");
  if (!mount) return;

  on(EV.PERMISSION, ({ state }) => {
    if (state === "granted") return dismiss("perm");

    if (state === "denied") {
      // Not a dead end — the paste tier always works and needs no permission.
      show("perm", {
        tone: "info",
        title: t("Clipboard reading is blocked"),
        body: t("Paste into the editor with Ctrl/Cmd+V — that always works, no permission needed."),
      });
      return;
    }

    if (state === "prompt") {
      show("perm", {
        tone: "info",
        title: t("Allow clipboard access"),
        body: t("Lets RealtimeClipboard pick up what you copied when you switch back to this window."),
        action: { label: t("Allow"), onClick: () => capture.requestPermission() },
      });
    }
  });

  on(EV.PENDING_CLIP, ({ pending, text, risk, altered }) => {
    if (!pending) return dismiss("pending");

    const preview = text ? ` “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”` : "";

    // A clip that reads like a shell command never lands on its own, however
    // this window is focused — see clipboard/guard.js. Discard is the primary
    // button: the safe answer should be the one under the cursor, and anyone who
    // genuinely wanted the command is reading the banner either way.
    if (risk) {
      return show("pending", {
        tone: "warn",
        title: t("A clip is asking to run something"),
        body: t("Someone in this session sent text that looks like a command — {risk}. It has NOT been put on your clipboard.{preview}",
                { risk, preview }),
        action: [
          { label: t("Discard"), onClick: () => capture.discardPending() },
          { label: t("Put it on my clipboard"), onClick: () => capture.confirmPending() },
        ],
      });
    }

    // writeText() needs focus, so a clip that arrives in the background is held
    // rather than dropped. Routine and self-healing — the next focus flushes
    // it — so it informs rather than warns; only the flagged-command banner
    // above has something to warn about.
    show("pending", {
      tone: "info",
      title: t("1 clip waiting"),
      body: t("Focus this window and it lands on your clipboard automatically.{preview}", { preview })
          + (altered ? " " + t("Hidden control characters were removed from it.") : ""),
      action: { label: t("Apply now"), onClick: () => capture.confirmPending() },
    });
  });

  // A clip arrived while there was unsent work in the editor. Applying is
  // offered rather than done, so nothing typed is lost. A later clip that
  // applies cleanly retracts the offer (`text: null`) — a banner left up
  // describes a clip the session has moved past, and its "Show it" would
  // roll the editor backwards.
  on(EV.CLIP_OFFERED, ({ text, onClipboard }) => {
    if (!text) return dismiss("offered");
    // apply() said whether the OS clipboard got it. Below the Clipboard rung,
    // or while unfocused, it did not — and this banner used to claim it had.
    show("offered", {
      tone: "info",
      title: t("New clip received"),
      body: (onClipboard ? t("It is on your clipboard.") + " " : "")
          + t("Applying it here replaces what you have typed. {clip}",
              { clip: `“${text.slice(0, 70)}${text.length > 70 ? "…" : ""}”` }),
      action: {
        label: t("Show it"),
        onClick: () => { emit("clip:accept", { text }); dismiss("offered"); },
      },
    });
  });

  // The key is a bearer credential: whoever holds it is in. Silently adding a
  // device to a list nobody re-reads is not enough — if a stranger guesses or
  // is handed the key, the moment they arrive is the only moment it is
  // noticeable.
  // "What's new" is a notice about the build whose content comes from a data
  // file, so the shape stays here and the content comes in — teaching this
  // module to parse a changelog would put the knowledge in the wrong place.
  on("ui:banner", ({ key, ...opts }) => { if (key) show(key, opts); });

  on(EV.PEER_JOINED, ({ name }) => {
    const who = name || t("An unnamed device");
    // In a locked session the arrival means more, not less: reaching this room
    // at all required the PIN, so this device is not somebody who merely found
    // the link. That is worth saying, because the open-session wording would
    // otherwise raise an alarm about the feature working correctly.
    const locked = state.get().locked;
    show("joined", {
      tone: "warn",
      title: t("A device joined this session"),
      body: locked
        ? t("{who} has the PIN as well as the link, and can now read what you copy and request your files. If that was not you, change the PIN.", { who })
        : t("{who} can now read what you copy and request your files. If that was not you, generate a new key.", { who }),
      action: locked
        ? { label: t("Change PIN"), onClick: () => emit("session:repin") }
        : { label: t("New key"), onClick: () => emit("session:rotate") },
      // Fifteen seconds is comfortable if you saw it arrive; the clock stops
      // while it holds focus or the pointer — autoDismiss() in primitives/dom.js.
      dismissAfter: 15000,
    });
  });

  /**
   * A locked session that has not proved itself. An empty locked room is
   * ambiguous by construction — you are either first here, or your PIN does not
   * match the one that named the room everyone else is in. The app cannot tell,
   * so it says so rather than picking the flattering interpretation, and offers
   * the one action that resolves it either way.
   *
   * Only raised once peers have had a chance to appear; firing the instant a
   * creator opens their own session would be pure noise.
   *
   * (A cancelled PIN prompt was a banner here. It is now the whole screen —
   * ui/shell/lockGate.js — because a banner in a stack of three said it far too
   * quietly.)
   */

  on(EV.LOCK_STATE, ({ locked, verified }) => {
    if (!locked || verified) return dismiss("lock");
    clearTimeout(lockDoubt);
    lockDoubt = setTimeout(() => {
      const s = state.get();
      if (!s.locked || s.verified || s.connection !== "connected") return;
      if (s.peers > 1) return;
      // A relay too old to carry the verification frame cannot be asked, and a
      // session on one is unverifiable rather than suspect. Saying "your PIN
      // may not match" here would send someone to re-type a PIN that was right
      // the first time, and the second attempt would fail identically. There is
      // deliberately no fallback to the retained-clip beacon this replaced —
      // that is what spent the room's replay slot to answer the question.
      if (!(s.relayCaps ?? []).includes("verify")) {
        return show("lock", {
          tone: "warn",
          title: t("This relay cannot confirm the PIN"),
          body: t("{host} is running a build from before locked sessions could prove themselves. The session is encrypted and works normally — it just cannot tell you whether anyone else is on the same PIN. Redeploying the relay fixes it.",
                  { host: relayHost() }),
        });
      }
      // Two ways out, because the app cannot tell which one is needed: this is
      // either a wrong PIN or an empty session you opened first, and only the
      // person reading it knows which. It stays a banner rather than the gate
      // the cancelled prompt gets — greying out a session because its creator
      // is alone in it would be wrong far more often than right.
      show("lock", {
        tone: "warn",
        title: t("Nobody else is here yet"),  // kept true by the PEERS_CHANGED handler below
        body: t("If someone should be, the PIN may not match theirs — a different PIN is a different session, so neither of you would see the other."),
        action: [
          { label: t("Re-enter PIN"), onClick: () => emit("session:relock") },
          { label: t("New session"), onClick: () => emit("session:rotate") },
        ],
      });
    }, LOCK_DOUBT_MS);
  });

  /**
   * The doubt banner claims solitude, so it may not outlive it.
   *
   * The check above runs once, when the timer fires, and a device arriving one
   * second later left a warning on screen saying nobody was there — beside a
   * roster listing them. A peer in a LOCKED room got there by deriving the same
   * room hash, which is HKDF over the stretched PIN, so its arrival is evidence
   * against the very thing the banner is warning about.
   *
   * It clears the banner and does NOT set `verified`: that stays reserved for
   * something this device decrypted itself. Presence is the relay's word for
   * it, and the relay is not trusted for anything else here either.
   */
  on(EV.PEERS_CHANGED, ({ count }) => {
    if (count > 1) {
      clearTimeout(lockDoubt);
      dismiss("lock");
    }
  });

  // Which pipe the session is running down. Silence here would be the same
  // mistake FR-7.6 forbids for file transfers: a fallback nobody is told about
  // reads as "the app is just slow today".
  on(EV.TRANSPORT, ({ mode, blocked, unsupported }) => {
    if (blocked && unsupported) {
      // The relay answered /health and refused /sse, so this is not the
      // network: it is a relay running a build from before the fallback
      // existed. Says so plainly, because the console will be full of CORS
      // errors — a bare 404 carries no CORS header — and that sends anyone
      // debugging it in exactly the wrong direction.
      show("transport", {
        tone: "bad",
        title: t("This relay is out of date"),
        body: t("WebSockets are blocked here and the relay does not have the HTTP fallback yet. It needs redeploying — the browser will report this as a CORS error, but nothing is wrong with the network."),
      });
      return;
    }

    if (blocked) {
      // Not "reconnecting". Neither a WebSocket nor a plain HTTP stream is
      // getting through, which no amount of waiting fixes — this is the banner
      // that gives someone something concrete to take to their IT desk.
      show("transport", {
        tone: "bad",
        title: t("Cannot reach the relay"),
        // The host it actually tried, not the one this was built against. A
        // self-hoster, anyone on ?relay=, and a developer on 127.0.0.1 were all
        // told to allowlist a domain their app had never contacted.
        body: t("Neither WebSockets nor HTTP streaming is getting through. If you are on a managed network, ask for {host} to be allowed.",
                { host: relayHost() }),
      });
      return;
    }

    if (mode !== TRANSPORT.SSE) return dismiss("transport");

    show("transport", {
      tone: "info",
      title: t("Using the HTTP fallback"),
      body: t("WebSockets are blocked on this network, so RealtimeClipboard switched to HTTP streaming. Everything works and is still end-to-end encrypted; sending is a little slower."),
    });
  });

  on(EV.INSTANCE_CHANGED, ({ from, to }) => {
    show("split", {
      tone: "bad",
      title: t("Relay instance changed"),
      body: t("{from} → {to}. Rooms live in process memory, so devices on different replicas cannot see each other. Pin max replicas to 1.",
              { from, to }),
    });
  });
}

/**
 * A banner appears without anyone asking for it, so it has to announce itself
 * or a screen-reader user simply never learns that a clip is waiting or that
 * clipboard access was refused.
 *
 * Two roles, not one. "Relay instance changed" means sync has silently stopped
 * working and reads as lag until someone is told, so it interrupts (alert).
 * The rest are things you can act on when you get to them, and interrupting
 * whatever is being read for a permission prompt is the behaviour that trains
 * people to turn the screen reader's verbosity down.
 */
const ROLE = { bad: "alert" };

function show(key, { tone, title, body, action, dismissAfter }) {
  dismiss(key);

  const el = document.createElement("div");
  el.className = `banner banner-${tone}`;
  el.setAttribute("role", ROLE[tone] ?? "status");

  const txt = document.createElement("div");
  txt.className = "banner-txt";
  el.appendChild(txt);

  // One or several. A banner offering a choice — re-enter the PIN, or give up
  // and start again — is the case that made this a list; the first alternative
  // is styled as the quieter one because it is the destructive answer.
  [].concat(action ?? []).forEach((act, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = i === 0 ? "btn sm" : "btn sm ghost";
    btn.textContent = act.label;
    btn.onclick = () => act.onClick();
    el.appendChild(btn);
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "banner-x";
  // Three banners can be on screen at once, and three buttons all called
  // "Dismiss" are indistinguishable in a screen reader's element list.
  close.setAttribute("aria-label", t("Dismiss: {title}", { title }));
  close.textContent = "×";
  close.onclick = () => dismiss(key);
  el.appendChild(close);

  mount.appendChild(el);
  banners.set(key, el);

  // Filled a frame AFTER the live region is in the tree. A region that arrives
  // with its text already inside it is announced inconsistently across screen
  // readers — some treat the whole subtree as one insertion and say nothing.
  // Populating it once it is being watched is the behaviour they all agree on.
  nextFrame(() => {
    if (banners.get(key) !== el) return;              // dismissed within the frame
    setHTML(txt, `<b>${esc(title)}</b><span>${esc(body)}</span>`);
  });

  if (dismissAfter > 0) timers.set(key, autoDismiss(el, dismissAfter, () => dismiss(key)));
}

function dismiss(key) {
  timers.get(key)?.();
  timers.delete(key);
  banners.get(key)?.remove();
  banners.delete(key);
}
