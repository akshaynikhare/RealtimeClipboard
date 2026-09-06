/**
 * Offer the reader this page in their own language. A link, never a redirect.
 *
 * Accept-Language is a preference, not an identity: a Brazilian reading English
 * documentation on purpose, a shared machine, a browser installed in whatever
 * the shop had — each is common, and a redirect sends each of them somewhere
 * they did not ask to go with no obvious way back. Google advises against
 * locale redirects for the same reason. So this offers, once, and remembers
 * being turned down.
 *
 * It runs on every page including the translations, because the reader who
 * needs it most is the one who landed on the wrong one: a Russian speaker on
 * /zh/download/ is offered /ru/download/, and someone who reads English is
 * offered the original. What decides is the page's own `lang` attribute
 * against the browser's list, so there is nothing per-page to keep in sync.
 *
 * The path maps by prefix — /download/ has a twin at /pt/download/, and "/" has
 * one at /pt/. UNTRANSLATED lists the pages where that is not true, and every
 * one of them is deliberate: the legal pages state liability limits and name no
 * governing language, so a translation of one would be ambiguous about which
 * version binds. Offering a link that 404s is worse than offering nothing, so
 * anything added here without a translation belongs in that list too.
 *
 * A file rather than an inline <script> so `script-src 'self'` holds with no
 * hash, and no innerHTML: Trusted Types rejects it outside
 * ui/primitives/dom.js. No import — it runs on 85 pages and must not pull core/
 * in to show a bar, the same reasoning redirect.js states.
 */

/* Keyed by primary subtag, which is what a browser sends for every regional
   variant: pt-BR and pt-PT both want the same page. `prefix` is what goes in
   front of the path, so English — the original — is the empty string. */
const LANGS = {
  en: { prefix: "",    name: "English",    offer: "This page is also available in English" },
  zh: { prefix: "/zh", name: "中文",        offer: "本页也有中文版" },
  pt: { prefix: "/pt", name: "Português",  offer: "Esta página também está em português" },
  es: { prefix: "/es", name: "Español",    offer: "Esta página también está en español" },
  ru: { prefix: "/ru", name: "Русский",    offer: "Эта страница также доступна на русском" },
};

/* Paths with no translations. Matched against the language-stripped path. */
const UNTRANSLATED = ["/privacy/", "/terms/"];

const DISMISSED = "rtc.lang.dismissed";
const primary = (tag) => String(tag || "").toLowerCase().split("-")[0];

/* An offer refused is refused for good. Storage throws in a blocked
   third-party context, and a language bar is not worth an exception escaping
   onto a marketing page. */
const dismissed = () => {
  try { return localStorage.getItem(DISMISSED) === "1"; } catch { return false; }
};
const remember = () => {
  try { localStorage.setItem(DISMISSED, "1"); } catch { /* nothing to do */ }
};

/** What this page is written in, from its own lang attribute. */
const pageLang = () => {
  const code = primary(document.documentElement.lang);
  return LANGS[code] ? code : "en";
};

/** The first of the reader's preferences we actually publish. */
function readerLang() {
  const tags = navigator.languages?.length ? navigator.languages
             : [navigator.language || ""];
  for (const t of tags) if (LANGS[primary(t)]) return primary(t);
  return null;
}

/** This page's path with any language prefix taken off. */
function basePath() {
  const path = location.pathname;
  for (const { prefix } of Object.values(LANGS)) {
    if (!prefix) continue;
    if (path === prefix) return "/";
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  }
  return path;
}

function show(code) {
  const { name, offer, prefix } = LANGS[code];

  const bar = document.createElement("aside");
  bar.className = "langbar";
  bar.lang = code;

  const text = document.createElement("span");
  text.textContent = offer;

  const link = document.createElement("a");
  // basePath() keeps its leading slash, so "/" under /pt becomes "/pt/".
  link.href = `${prefix}${basePath()}` || "/";
  link.textContent = name;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "langbar-x";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => { remember(); bar.remove(); };

  bar.append(text, link, close);
  document.body.prepend(bar);
}

const want = dismissed() || UNTRANSLATED.includes(basePath())
  ? null : readerLang();
if (want && want !== pageLang()) show(want);
