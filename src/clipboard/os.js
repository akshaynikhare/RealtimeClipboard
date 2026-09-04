/**
 * The entire OS clipboard boundary — two calls. Everything else in the app
 * goes through this module. See docs/CLIPBOARD-FLOW.md.
 */

import { emit, EV } from "../core/bus.js";
import { IMAGES } from "../core/config.js";
import * as native from "../core/native.js";

/**
 * Requires document focus in a browser. Needs no permission.
 *
 * Under a native host it needs neither: that side owns the OS clipboard, so an
 * arriving clip lands immediately rather than queueing until the user happens to
 * focus the window — which removes the "1 pending" state entirely there, and
 * with it half of what makes the browser version feel like a compromise.
 *
 * The ordering invariant is upheld on the far side: every host's `set_clipboard`
 * records the value BEFORE writing it, so its watcher recognises its own echo
 * instead of broadcasting it back (docs/CLIPBOARD-FLOW.md §6).
 */
export async function write(text) {
  // Falls through to the web path rather than failing: a shell too old to know
  // this command should degrade to the browser behaviour, not lose the clip.
  if (native.hasNativeClipboard() && await native.invoke("set_clipboard", { text }) !== null) {
    return true;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    emit(EV.TOAST, "Window must be focused to write the clipboard");
    return false;
  }
}

/**
 * Requires focus AND the clipboard-read permission AND a secure context.
 * Returns null rather than throwing — callers treat "cannot read right now" as
 * ordinary, because it is: it happens every time the window loses focus.
 */
export async function read() {
  try { return await navigator.clipboard.readText(); }
  catch { return null; }
}

/**
 * Read an image off the system clipboard, if there is one.
 *
 * Separate from read(): `clipboard.read()` returns ClipboardItems and is both
 * slower and more restricted than readText(), so it is only worth calling at
 * moments an image is plausible — not on every poll tick.
 *
 * Returns a Blob, or null. Null is ordinary: no image on the clipboard, no
 * permission, or a browser without the API.
 */
export async function readImage() {
  if (!navigator.clipboard?.read) return null;
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => IMAGES.TYPES.includes(t));
      if (type) return await item.getType(type);
    }
  } catch { /* not readable right now — treat as "no image" */ }
  return null;
}

/** Pull an image out of a paste event. No permission needed on this path. */
export function imageFromPaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === "file" && IMAGES.TYPES.includes(item.type)) {
      return item.getAsFile();
    }
  }
  return null;
}

export const canRead  = () => Boolean(navigator.clipboard?.readText);
export const canWrite = () => Boolean(navigator.clipboard?.writeText);
export const canReadImages = () => Boolean(navigator.clipboard?.read);

/** 'granted' | 'prompt' | 'denied' | 'unknown' */
export async function permission() {
  try {
    const st = await navigator.permissions.query({ name: "clipboard-read" });
    return st.state;
  } catch { return "unknown"; }
}

export async function onPermissionChange(fn) {
  try {
    const st = await navigator.permissions.query({ name: "clipboard-read" });
    st.onchange = () => fn(st.state);
    return st.state;
  } catch { return "unknown"; }
}
