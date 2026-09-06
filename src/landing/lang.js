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
 * What it may offer comes from the page's own <link rel="alternate" hreflang>
 * tags, and nothing else. Those have to be right for search engines anyway, so
 * reading them means there is no second list to keep in step and no way to
 * offer a translation that does not exist — during a rollout, or on the legal
 * pages, which stay English because they state liability limits and name no
 * governing language.
 *
 * A file rather than an inline <script> so `script-src 'self'` holds with no
 * hash, and no innerHTML: Trusted Types rejects it outside
 * ui/primitives/dom.js. No import — it runs on 85 pages and must not pull core/
 * in to show a bar, the same reasoning redirect.js states.
 */
/* Keyed by primary subtag, which is what a browser sends for every regional
   variant: pt-BR and pt-PT both want the same page. The href comes from the
   page's own hreflang, so there is no path to build here. */
const LANGS = {
  en: { name: "English",    offer: "This page is also available in English" },
  zh: { name: "中文",        offer: "本页也有中文版" },
  pt: { name: "Português",  offer: "Esta página também está em português" },
  es: { name: "Español",    offer: "Esta página también está en español" },
  ru: { name: "Русский",    offer: "Эта страница также доступна на русском" },
};

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

/**
 * The translations this page declares, as { code: href }.
 *
 * x-default is skipped: it duplicates the English URL and is a fallback
 * instruction to a crawler, not a language a reader chose.
 */
function alternates() {
  const found = {};
  for (const el of document.querySelectorAll("link[rel=alternate][hreflang]")) {
    const code = primary(el.getAttribute("hreflang"));
    if (code === "x" || !LANGS[code]) continue;
    found[code] = el.getAttribute("href");
  }
  return found;
}

function show(code, href) {
  const { name, offer } = LANGS[code];

  const bar = document.createElement("aside");
  bar.className = "langbar";
  bar.lang = code;

  const text = document.createElement("span");
  text.textContent = offer;

  const link = document.createElement("a");
  link.href = href;
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

const want = dismissed() ? null : readerLang();
const href = want ? alternates()[want] : null;
if (want && href && want !== pageLang()) show(want, href);
