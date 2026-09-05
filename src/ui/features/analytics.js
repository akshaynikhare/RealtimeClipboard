/**
 * Google Analytics, inside the app. AdSense lives next door in ads.js, which
 * owns the timing rule that lets an ad tag run in this document at all.
 *
 * !! `page_location` is overridden, always. This document's URL carries the
 * share key in its fragment, and gtag's default `page_location` is
 * `location.href`. Send that and the key — the thing the whole product promises
 * never leaves the browser — arrives at Google in the first page_view, in a
 * form anyone with access to the property can read and use to decrypt the
 * session. `pageLocation()` in core/config.js is the only value that may be
 * used here. !!
 *
 * The landing page's copy of this is `src/landing/tags.js`; neither can import
 * the other, because `core/` is the only directory both may reach and `core/`
 * may not touch the DOM. Everything worth sharing is shared through
 * `core/config.js`.
 */

import { GOOGLE, GOOGLE_SRC, CONSENT_REGIONS, pageLocation } from "../../core/config.js";
import { analyticsOn, platform } from "../../core/surface.js";
import { on, EV } from "../../core/bus.js";
import { scriptURL } from "../primitives/dom.js";

export function init() {
  // analyticsOn() is analyticsEnabled() plus the surface rule: the CLI has no
  // document to report from. Ads differ far more — see core/surface.js.
  if (!analyticsOn()) return;

  window.dataLayer = window.dataLayer || [];
  // `arguments`, not an array — gtag reads it as an arguments object.
  function gtag() { window.dataLayer.push(arguments); }

  // Queued before the script loads, so the denied default is in place ahead of
  // anything that could set a cookie.
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

  const el = document.createElement("script");
  el.async = true;
  el.src = scriptURL(GOOGLE_SRC.gtag(GOOGLE.GA4_ID));
  document.head.append(el);

  /* The one event worth counting: a second device arrived, which is the whole
     product working. A lone visitor is not a conversion and page_view cannot
     tell the two apart. Sent bare — the peer's name is user-controlled text and
     Google has no need of it, and there is nothing else here that is not the
     key or the clipboard. Once per page, or a flapping connection reports a
     conversion per reconnect. Mark it as a key event under Admin -> Events. */
  let paired = false;
  on(EV.PEER_JOINED, () => {
    if (paired) return;
    paired = true;
    gtag("event", "session_paired");
  });
}
