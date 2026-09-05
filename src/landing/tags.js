/**
 * Google Analytics and AdSense, for the pages a crawler can reach.
 *
 * The app has its own copies in `src/ui/features/analytics.js` and `ads.js` —
 * they cannot share a module with this one, because `core/` is the only
 * directory both may import from and `core/` may not touch the DOM. What they
 * DO share is every decision worth sharing: the IDs, the script URLs, the
 * consent regions and the fragment-stripping rule all come from
 * `core/config.js`. The app's ad tag additionally waits for the share key to
 * leave the URL — see ads.js.
 *
 * Nothing loads while the IDs in `GOOGLE` are empty, so a fork or a local
 * checkout is exactly as third-party-free as this project used to be.
 *
 * !! No inline <script> anywhere: `tests/unit/static-check.mjs` fails the commit
 * on one, and the CSP has no 'unsafe-inline' to fall back on. That is why the
 * usual copy-pasted gtag snippet cannot be used and the tags are injected from
 * here instead. !!
 */

import {
  GOOGLE, GOOGLE_SRC, CONSENT_REGIONS, pageLocation,
} from "../core/config.js";
import { analyticsOn, adNetwork, platform } from "../core/surface.js";

/**
 * `require-trusted-types-for 'script'` makes `script.src` a guarded sink, so an
 * injected tag needs a policy or the assignment throws. The app gets this from
 * ui/primitives/dom.js; these pages have no such module, so they create the
 * same policy themselves — one per document, so the names never collide.
 */
const policy = (() => {
  try {
    return globalThis.trustedTypes?.createPolicy?.("realtimeclipboard", {
      createScriptURL: s => s,
    }) ?? null;
  } catch {
    return null;   // already registered; a plain assignment is what a browser without TT does
  }
})();

function loadScript(src, attrs = {}) {
  const el = document.createElement("script");
  el.async = true;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.src = policy ? policy.createScriptURL(src) : src;
  document.head.append(el);
}

/* dataLayer takes commands before gtag.js has loaded, which is what lets the
   consent default be set first — it has to be in the queue ahead of anything
   that could set a cookie, or the default never applied. */
window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }   // must be `arguments`, not an array

function analytics() {
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    region: CONSENT_REGIONS,
    wait_for_update: 500,
  });
  gtag("js", new Date());
  /* `set` rather than a config param alone: a config param rides only on events
     sent through that config, and the question "which surface produced this"
     has to be answerable for the automatically-collected ones too —
     session_start, first_visit, user_engagement. Sent on the config as well so
     it is on the page_view that config emits.

     `rtc_surface`, not `platform`: GA4 has a built-in Platform dimension
     (web/iOS/Android) and a custom one of the same name is ambiguous in every
     report that shows both. Register it under Admin -> Custom definitions,
     scope Event, parameter `rtc_surface` — GA4 does not backfill, so a hit
     collected before the dimension exists is not queryable. */
  gtag("set", { rtc_surface: platform() });
  gtag("config", GOOGLE.GA4_ID, {
    page_location: pageLocation(),
    rtc_surface: platform(),
  });
  loadScript(GOOGLE_SRC.gtag(GOOGLE.GA4_ID));
}

/**
 * Fill a reserved box with a real unit.
 *
 * The placeholder markup stays in the HTML and is replaced here rather than the
 * page shipping an empty <ins>: with no slot ID the box keeps its dashed
 * outline and its reserved height, which is what a placeholder is for.
 */
function mountUnit(boxId, slot, format) {
  const box = document.getElementById(boxId);
  if (!box || !slot) return;

  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  // display only. A responsive unit measures its container and writes its own
  // inline height, so anything set here is overwritten a moment later anyway —
  // the reserved space is expressed as a min-height on the box instead.
  ins.style.display = "block";
  ins.setAttribute("data-ad-client", GOOGLE.ADSENSE_CLIENT);
  ins.setAttribute("data-ad-slot", slot);
  ins.setAttribute("data-ad-format", format);
  ins.setAttribute("data-full-width-responsive", "true");

  box.replaceChildren(ins);
  box.classList.add("adlive");        // drops the dashed placeholder outline

  (window.adsbygoogle = window.adsbygoogle || []).push({});
}

function ads() {
  loadScript(GOOGLE_SRC.adsense(GOOGLE.ADSENSE_CLIENT), { crossorigin: "anonymous" });
  mountUnit("adLeaderboard", GOOGLE.ADSENSE_SLOTS.LEADERBOARD, "horizontal");
  mountUnit("adRail", GOOGLE.ADSENSE_SLOTS.RAIL, "vertical");
  consentLink();
}

/**
 * "Privacy & cookie settings", beside the footer's Privacy link.
 *
 * Withdrawing consent has to be as easy as giving it, and Google's CMP renders
 * no control of its own once dismissed. Built here rather than in the markup of
 * twenty pages, and only once the CMP has actually reported in: outside the EEA
 * there is no dialog to reopen, and a link that does nothing is worse than no
 * link — the same reason faq.js hides its button until it can work.
 */
function consentLink() {
  const fc = (window.googlefc = window.googlefc || {});
  fc.callbackQueue = fc.callbackQueue || [];
  fc.callbackQueue.push({
    CONSENT_DATA_READY: () => {
      const privacy = document.querySelector('footer a[href$="privacy/"]');
      if (!privacy || document.getElementById("consentPrefs")) return;

      const a = document.createElement("a");
      a.id = "consentPrefs";
      a.href = "#";
      a.textContent = "Privacy & cookie settings";
      a.addEventListener("click", e => {
        e.preventDefault();
        window.googlefc?.showRevocationMessage?.();
      });

      privacy.after(document.createTextNode(" · "), a);
    },
  });
}

if (analyticsOn()) analytics();
/* These pages are only ever served over http(s), so adNetwork() answers
   "adsense" here or nothing does — but asking the same question as the app
   means a self-hoster who forks this gets one answer, not two. */
if (adNetwork() === "adsense") ads();
