/**
 * Promote the platform you are probably on, and hide nothing.
 *
 * The usual version guesses your OS and shows one button. The guess is wrong
 * often enough — a Linux user on a Chromebook, a work Mac read on a phone,
 * anyone behind a UA-reducing browser — and when it is wrong that page has no
 * other route. So this only ever ADDS a card at the top: every platform stays
 * where it was, and a browser with no JavaScript sees the complete page.
 *
 * Whether background clipboard capture works is a property of the operating
 * system, not of the browser reading this, so the cards state it in the markup.
 *
 * The second half swaps the generic /releases/latest links for real asset URLs —
 * same principle: it sharpens what the markup says, or does nothing.
 */

import { t, pick, load } from "../core/i18n.js";

const byId = id => document.getElementById(id);

/**
 * The language of the page this is running on, not of the reader.
 *
 * A landing page has already committed to a language — /zh/download/ is Chinese
 * whatever the browser asks for — so the <html lang> is the answer and
 * navigator.languages is not. Getting this backwards would put Chinese chrome
 * on the English page for a Chinese reader who deliberately opened it.
 */
const PAGE_LANG = pick("", [document.documentElement.lang || "en"]);

/* The install guides are translated, so a card on /zh/download/ must send the
   reader to /zh/help/install/mac/ rather than dropping them into English. */
const localised = path => (PAGE_LANG === "en" ? path : `/${PAGE_LANG}${path}`);

/**
 * `navigator.userAgentData` where it exists, the string where it does not.
 *
 * Deliberately coarse. The page has five destinations, so telling Windows 10
 * from 11 or Ubuntu from Fedora buys nothing and only adds ways to be wrong.
 */
function detect() {
  const d = navigator.userAgentData;
  const platform = (d?.platform || navigator.platform || "").toLowerCase();
  const ua = navigator.userAgent.toLowerCase();

  // iPad has reported itself as a Mac since iPadOS 13, and the only reliable
  // tell is that a Mac has no touch points. Checked FIRST: an iPad that falls
  // through to the macOS card is offered a .dmg it cannot possibly run.
  const iPad = platform.startsWith("mac") && navigator.maxTouchPoints > 1;
  if (iPad || /iphone|ipad|ipod/.test(ua)) return "ios";

  if (d?.mobile && /android/.test(ua)) return "android";
  if (/android/.test(ua)) return "android";
  if (/cros/.test(ua)) return "android";              // ChromeOS installs the PWA the same way
  if (platform.startsWith("win")) return "windows";
  if (platform.startsWith("mac")) return "mac";
  if (platform.startsWith("linux") || /linux|x11/.test(ua)) return "linux";
  return null;
}

/* name and lead are read at render time, after the catalogue has loaded. The
   platform names stay Latin in every language; only "iPhone or iPad" is a
   phrase rather than a brand, so only it goes through t(). */
const COPY = {
  windows: { name: () => "Windows", lead: () => t("The installer for Windows 10 and 11."), to: "#desktop",
             icon: "#i-windows", doc: "/help/install/windows/" },
  mac:     { name: () => "macOS",   lead: () => t("One download for Intel and Apple Silicon."), to: "#desktop",
             icon: "#i-apple",   doc: "/help/install/mac/" },
  linux:   { name: () => "Linux",   lead: () => t(".deb, .rpm and AppImage."), to: "#desktop",
             icon: "#i-linux",   doc: "/help/install/linux/" },
  android: { name: () => "Android", lead: () => t("No app to install — add it to your home screen from Chrome."), to: "#mobile",
             icon: "#i-android", doc: "/help/install/android/" },
  ios:     { name: () => t("iPhone or iPad"), lead: () => t("No app to install — add it to your home screen from Safari."), to: "#mobile",
             icon: "#i-apple",   doc: "/help/install/iphone/" },
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A `<use>` of one of the sprite symbols in the page.
 *
 * createElementNS, not createElement: `createElement("svg")` builds an
 * HTMLUnknownElement that lays out as nothing at all and reports no error.
 * `className` is a read-only SVGAnimatedString on an SVG element, so the class
 * has to go on as an attribute too.
 */
function mark(href) {
  const tile = document.createElement("span");
  tile.className = "dlicon";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "brandmark");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", href);

  svg.append(use);
  tile.append(svg);
  return tile;
}

const os = detect();
const host = byId("pick");

/* Awaited before the card is built, not after: every label below is written
   once with textContent, so a catalogue arriving late would leave English on
   screen with nothing to redraw it. The card is purely additive, so waiting on
   it delays nothing the page already showed. */
if (os && host && COPY[os]) await load(PAGE_LANG);

if (os && host && COPY[os]) {
  const { name, lead, to, icon, doc } = COPY[os];
  const card = document.createElement("div");
  card.className = "pickcard";

  // Built with the DOM rather than a markup string: this page has no esc()
  // helper and nothing here needs one, but the CSP enforces Trusted Types and
  // a plain innerHTML assignment would throw. textContent cannot be an
  // injection either way, which is the better habit to leave behind.
  const h = document.createElement("p");
  h.className = "pickhead";
  h.textContent = t("Looks like you are on {name}", { name: name() });

  const p = document.createElement("p");
  p.textContent = lead();

  const a = document.createElement("a");
  a.className = "btn";
  a.href = to;
  a.textContent = to === "#mobile" ? t("How to add it") : t("Get it for {name}", { name: name() });

  const guide = document.createElement("p");
  guide.className = "doclink";
  const guideLink = document.createElement("a");
  guideLink.href = localised(doc);
  guideLink.textContent = t("{name} install guide", { name: name() });
  guide.append(guideLink);

  const alt = document.createElement("p");
  alt.className = "hint";
  alt.textContent = t("Not right? Every platform is listed below.");

  card.append(mark(icon), h, p, a, guide, alt);
  host.append(card);
  host.hidden = false;
}

/**
 * The markup already points at /releases/latest, which is a correct page on its
 * own, so this only replaces a correct answer with a more specific one and every
 * failure path is `return`: offline, rate-limited (60 unauthenticated requests
 * an hour per IP), no published release, or no matching asset. No spinner and no
 * empty state, because the page is never waiting on this.
 *
 * When it appears to do nothing: the API returns the latest *published* release,
 * so an unpublished draft finds nothing here — and neither does /releases/latest.
 */
const REPO = "akshaynikhare/RealtimeClipboard";
const ASSET = {
  msi:      /\.msi$/i,
  exe:      /-setup\.exe$/i,
  dmg:      /\.dmg$/i,
  deb:      /\.deb$/i,
  rpm:      /\.rpm$/i,
  appimage: /\.AppImage$/i,
};

const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;

async function hydrate() {
  let assets;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) return;
    ({ assets } = await res.json());
  } catch {
    return;
  }
  if (!Array.isArray(assets) || !assets.length) return;

  const find = key => ASSET[key] && assets.find(a => ASSET[key].test(a.name));

  for (const el of document.querySelectorAll("[data-dl]")) {
    const asset = find(el.dataset.dl);
    if (asset) el.href = asset.browser_download_url;
  }

  for (const el of document.querySelectorAll("[data-dl-meta]")) {
    const asset = find(el.dataset.dlMeta);
    if (asset) el.textContent = `${el.textContent.trim()} · ${mb(asset.size)}`;
  }
}

hydrate();
