/**
 * Tiny pub/sub. The only way modules talk to each other — UI never imports
 * transport or clipboard, and vice versa. main.js is the only file that knows
 * the full graph.
 */

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => off(event, fn);        // call the return value to unsubscribe
}

export function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  // Copy first: a handler may unsubscribe itself mid-dispatch.
  for (const fn of [...set]) {
    try { fn(payload); }
    catch (err) { console.error(`[bus] handler failed for "${event}"`, err); }
  }
}

/** Canonical event names. Typos here are silent bugs, so use the constants. */
export const EV = {
  // clipboard
  TEXT_CAPTURED:   "text:captured",    // {text, how} — a clip settled here, needs sending
  TEXT_RECEIVED:   "text:received",    // {text, from} — a clip arrived from a peer
  // The VIEW channel — what the text looks like mid-keystroke. The pair above is
  // the COMMIT channel. Keeping them apart is what stops a streamed sentence
  // becoming six history entries and six clipboard writes.
  TEXT_TYPED:      "text:typed",       // {text, caret} out
  TEXT_STREAMED:   "text:streamed",    // {text, caret, name, from} in
  TIER_CHANGED:    "clipboard:tier",   // {tier, note}
  PENDING_CLIP:    "clipboard:pending",// {pending, text} — arrived while unfocused
  CLIP_OFFERED:    "clipboard:offered",// {text, onClipboard} — arrived over unsent work; text:null retracts the offer
  PEER_JOINED:     "peers:joined",     // {name} — a device entered the session
  PEER_LEFT:       "peers:left",       // {name}
  PERMISSION:      "clipboard:permission", // {state} granted|prompt|denied
  IMAGE_CAPTURED:  "clipboard:image",  // {blob, name} — an image was copied or pasted
  SYNC_MODE:       "clipboard:mode",   // {mode} live|manual

  // transport
  CONN_STATE:      "conn:state",       // {state, detail}
  TRANSPORT:       "conn:transport",   // {mode, label, blocked, forced} — ws | sse, or nothing works
  TRANSPORT_SELECT:"conn:transport:set",// {mode} — the user picked one; null = automatic
  PEERS_CHANGED:   "peers:changed",    // {count, list}
  INSTANCE_CHANGED:"conn:instance",    // {from, to} — split-brain warning (OI-3)
  KEY_COLLISION:   "session:collision",// generated key was taken (OI-2)
  ROOM_STATE:      "conn:room",        // {existing, hasLast} — what `welcome` said

  // session
  KEY_CHANGED:     "session:key",      // {key, locked}
  // Announcements are past tense, commands are bare verbs, and the extra
  // syllable here is load-bearing — see core/CLAUDE.md. The bus does no
  // namespacing of its own, so a collision between the two is silent.
  LOCK_STATE:      "session:lockstate",// {locked, verified} — see core/crypto.js
  // {required} — a locked link is open and its PIN has not been given. Separate
  // from LOCK_STATE because `state.locked` is still false: no session was ever
  // opened to be locked.
  LOCK_REQUIRED:   "session:lockrequired",
  FOUNDER:         "session:founder",  // {founder} — first into this room? null = not yet known

  // files
  FILES_CHANGED:   "files:changed",    // full list
  FILE_ADDED:      "files:added",      // {file} — added locally, needs announcing
  FILE_PROGRESS:   "files:progress",   // {id, percent}
  TRANSFER_PATH:   "files:path",       // {id, path: "p2p" | "relay"}

  // ui
  TOAST:           "ui:toast",         // string
  SETTINGS_CHANGED:"ui:settings",      // {name, value} — a preference was toggled
};
