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

import { GOOGLE, GOOGLE_SRC, CONSENT_REGIONS, analyticsEnabled, pageLocation } from "../../core/config.js";
import { scriptURL } from "../primitives/dom.js";

export function init() {
  if (!analyticsEnabled()) return;

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
  gtag("config", GOOGLE.GA4_ID, { page_location: pageLocation() });

  const el = document.createElement("script");
  el.async = true;
  el.src = scriptURL(GOOGLE_SRC.gtag(GOOGLE.GA4_ID));
  document.head.append(el);
}
