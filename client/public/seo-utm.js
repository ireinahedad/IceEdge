/* ArakIce — keep the visitor's real channel through a static SEO page (2026-11-20).

   The daily videos link to static pages (/match/<date>?utm_source=youtube…).
   Those pages' buttons into the app are tagged utm_source=seo, so the app saved
   "seo" as the account's first touch and the real channel (YouTube, X…) was lost.
   When this page was opened WITH a utm_source other than "seo", every link that
   carries utm_source=seo takes the inbound source (and medium/campaign when
   present) instead. Nothing is stored; no cookie. CSP-safe: served from 'self'. */
(function () {
  "use strict";
  var p = new URLSearchParams(window.location.search);
  var src = p.get("utm_source");
  if (!src || src === "seo") return;
  var links = document.querySelectorAll('a[href*="utm_source=seo"]');
  for (var i = 0; i < links.length; i++) {
    try {
      var u = new URL(links[i].href);
      ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) {
        var v = p.get(k);
        if (v) u.searchParams.set(k, v.slice(0, 60));
      });
      links[i].href = u.toString();
    } catch (e) { /* lien illisible : on le laisse */ }
  }
})();
