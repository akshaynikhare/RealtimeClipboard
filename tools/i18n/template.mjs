/**
 * The shape every translated content page has.
 *
 * One template, not 72 copies. A translated page is the English page's
 * scaffolding with different prose in it, and the scaffolding is the part that
 * breaks: site-check asserts every page's CSP is byte-identical, so a policy
 * hand-copied into 72 files is 72 chances to fail a deploy over a typo. The CSP
 * and the shared chrome are read from the English original at generation time
 * for exactly that reason — change it there and regenerating carries it.
 *
 * Committed output, not build-time generation. The pages stay real files on
 * disk so tests/unit/static-check.mjs still walks them, sw.js still sees them
 * and sitemap.xml still lists them by hand — CLAUDE.md is explicit that the
 * sitemap is not derived. What this removes is the copying, not the review.
 */

export const ORIGIN = "https://realtimeclipboard.com";

/** Published languages. `tag` is the hreflang/lang value, `og` the OG locale. */
export const LANGS = {
  zh: { tag: "zh-Hans", og: "zh_CN", name: "中文" },
  pt: { tag: "pt-BR",   og: "pt_BR", name: "Português" },
  es: { tag: "es",      og: "es_ES", name: "Español" },
  ru: { tag: "ru",      og: "ru_RU", name: "Русский" },
};

/**
 * Chrome, once per language. Every string a content page needs that is not the
 * article itself — so a nav or footer change is one edit here plus a rebuild,
 * rather than a sweep across every translated file.
 */
export const CHROME = {
  zh: {
    app: "打开应用", oss: "开源项目", crumbLabel: "面包屑导航",
    faqH: "常见问题", faqAll: "全部展开",
    home: "首页", download: "下载", help: "帮助", about: "关于",
    privacy: "隐私政策", terms: "使用条款",
    foot: "会话只保存在内存中，从不写入磁盘。剪贴板内容在发送前已在你的浏览器里完成加密。",
  },
  pt: {
    app: "Abrir o aplicativo", oss: "Código aberto", crumbLabel: "Trilha de navegação",
    faqH: "Perguntas frequentes", faqAll: "Expandir tudo",
    home: "Início", download: "Download", help: "Ajuda", about: "Sobre",
    privacy: "Privacidade", terms: "Termos",
    foot: "As sessões ficam em memória e nunca são gravadas em disco. O conteúdo da área de transferência é criptografado no seu navegador antes de ser enviado.",
  },
  es: {
    app: "Abrir la aplicación", oss: "Código abierto", crumbLabel: "Ruta de navegación",
    faqH: "Preguntas frecuentes", faqAll: "Expandir todo",
    home: "Inicio", download: "Descargas", help: "Ayuda", about: "Acerca de",
    privacy: "Privacidad", terms: "Términos",
    foot: "Las sesiones se mantienen en memoria y nunca se escriben en disco. El contenido del portapapeles se cifra en tu navegador antes de enviarse.",
  },
  ru: {
    app: "Открыть приложение", oss: "Открытый исходный код", crumbLabel: "Навигационная цепочка",
    faqH: "Частые вопросы", faqAll: "Развернуть всё",
    home: "Главная", download: "Загрузки", help: "Помощь", about: "О проекте",
    privacy: "Конфиденциальность", terms: "Условия",
    foot: "Сессии хранятся в памяти и никогда не пишутся на диск. Содержимое буфера обмена шифруется в вашем браузере до отправки.",
  },
};

/* The legal pages are English-only: they state liability limits and name no
   governing language, so a translation would be ambiguous about which version
   binds. Kept in step with UNTRANSLATED in src/landing/lang.js. */
export const ENGLISH_ONLY = ["privacy", "terms"];

const jsonStr = (s) => JSON.stringify(String(s));

/**
 * Only the translations that actually exist.
 *
 * hreflang is reciprocal or it is ignored, and a cluster naming a page that
 * 404s is worse than a smaller one — it is also what src/landing/lang.js reads
 * to decide what it may offer, so a name here that is not on disk becomes a
 * bar offering a dead link. `have` is the set of language codes holding a
 * translation of this slug.
 */
function hreflang(slug, have) {
  const rows = [`<link rel="alternate" hreflang="en" href="${ORIGIN}/${slug}/">`];
  for (const code of have) {
    rows.push(`<link rel="alternate" hreflang="${LANGS[code].tag}" href="${ORIGIN}/${code}/${slug}/">`);
  }
  rows.push(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/${slug}/">`);
  return rows.join("\n");
}

function languageRow(slug, have) {
  const cells = [`<a href="/${slug}/">English</a>`];
  for (const code of have) cells.push(`<a href="/${code}/${slug}/">${LANGS[code].name}</a>`);
  return cells.join(" · ");
}

/**
 * A footer link to a page that may not be translated yet.
 *
 * Falls back to the English original rather than pointing at a directory that
 * does not exist. That is what lets a translation ship before its neighbours
 * do, instead of the whole set having to land in one commit.
 */
/**
 * Rewrite in-body cross-links to translations that do not exist yet.
 *
 * Content is authored linking to /zh/live-clipboard/ — the page it will
 * eventually be — and this downgrades it to /live-clipboard/ until that
 * translation lands, then stops when it does. Without it, shipping one
 * translated page means shipping its links to the siblings it mentions, and
 * every one of those is a 404 for the reader who follows it.
 */
const resolveLinks = (html, lang, index) =>
  html.replace(new RegExp(`href="/${lang}/([a-z0-9-]+(?:/[a-z0-9-]+)*)/"`, "g"),
    (whole, slug) => index[slug]?.has(lang) ? whole : `href="/${slug}/"`);

const navLink = (lang, slug, label, index) =>
  index[slug]?.has(lang)
    ? `<a href="/${lang}/${slug}/">${label}</a>`
    : `<a href="/${slug}/">${label}</a>`;

/**
 * @param {string} lang   language code, a key of LANGS
 * @param {string} slug   the English page's directory, e.g. "live-clipboard"
 * @param {object} c      translated content
 * @param {string} csp    the CSP meta tag, lifted from the English original
 * @param {object} index   { slug: Set(langCodes) } — every translation on disk
 */
export function page(lang, slug, c, csp, index = {}) {
  const { tag, og } = LANGS[lang];
  const ch = CHROME[lang];
  const url = `${ORIGIN}/${lang}/${slug}/`;
  const note = c.note ? `\n<!--\n${c.note.trim()}\n-->\n` : "";
  const have = [...(index[slug] ?? [lang])].sort();

  return `<!doctype html>
<html lang="${tag}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<!-- One policy, identical on every page of the site. Reasoning and the
     directive-by-directive notes live in app.html, which is the page that
     actually needs them. -->
${csp}
${note}
<title>${c.title}</title>
<meta name="description" content="${c.desc}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#007acc">
<link rel="icon" href="/assets/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icons/icon-192.png">

${hreflang(slug, have)}

<meta property="og:type" content="article">
<meta property="og:site_name" content="RealtimeClipboard">
<meta property="og:locale" content="${og}">
<meta property="og:title" content="${c.ogTitle ?? c.title}">
<meta property="og:description" content="${c.ogDesc ?? c.desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/assets/social/og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "@id": "${url}#article",
      "headline": ${jsonStr(c.headline ?? c.h1)},
      "description": ${jsonStr(c.schemaDesc ?? c.desc)},
      "inLanguage": "${tag}",
      "datePublished": "${c.published ?? "2026-09-06"}",
      "dateModified": "${c.modified ?? "2026-09-06"}",
      "publisher": { "@id": "${ORIGIN}/#org" },
      "mainEntityOfPage": "${url}"
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "RealtimeClipboard", "item": "${ORIGIN}/${lang}/" },
        { "@type": "ListItem", "position": 2, "name": ${jsonStr(c.crumb)} }
      ]
    }
  ]
}
</script>

<link rel="stylesheet" href="/src/landing/landing.css">
<script type="module" src="/src/landing/faq.js"></script>
<script type="module" src="/src/landing/tags.js"></script>
<script type="module" src="/src/landing/lang.js"></script>
</head>
<body>

<div class="rules" aria-hidden="true">
  <div class="in"><span></span><span></span><span></span></div>
</div>

<header class="topbar">
  <div class="in">
    <div class="row">
      <a class="brand" href="/${lang}/">
        <b>RealtimeClipboard</b>
      </a>
      <span class="spacer"></span>
      <a class="tlink" href="https://github.com/akshaynikhare/RealtimeClipboard">GitHub</a>
      <a class="tlink strong" href="/app.html">${ch.app}</a>
    </div>
  </div>
</header>

<main>

  <section class="sec">
    <div class="in doc">

      <nav class="crumb" aria-label="${ch.crumbLabel}">
        <a href="/${lang}/">RealtimeClipboard</a> <span aria-hidden="true">/</span>
        <span aria-current="page">${c.crumb}</span>
      </nav>

      <header class="pagehead">
        <h1>${c.h1}</h1>

        <p class="lede">
${resolveLinks(c.lede, lang, index)}
        </p>
      </header>

      <div class="article">
${resolveLinks(c.body, lang, index)}
      </div>

      <div class="faq" id="faq">
        <div class="faqhead">
          <h2>${ch.faqH}</h2>
          <button type="button" class="faqall" id="faqAll"
                  aria-expanded="false" aria-controls="faq" hidden>
            <span class="faqall-i" aria-hidden="true"></span>
            <span class="faqall-t">${ch.faqAll}</span>
          </button>
        </div>
${resolveLinks(c.faq, lang, index)}
      </div>

    </div>
  </section>
</main>

<footer class="sec">
  <div class="in">
    <div class="footgrid">
      <p>${ch.oss} — <a href="https://github.com/akshaynikhare/RealtimeClipboard">github.com/akshaynikhare/RealtimeClipboard</a></p>
      <p>${languageRow(slug, have)}</p>
      <p><a href="/${lang}/">${ch.home}</a> · ${navLink(lang, "download", ch.download, index)} · ${navLink(lang, "help", ch.help, index)} · ${navLink(lang, "about", ch.about, index)} · <a href="/privacy/">${ch.privacy}</a> · <a href="/terms/">${ch.terms}</a></p>
      <p>${ch.foot}</p>
    </div>
  </div>
</footer>

</body>
</html>
`;
}
