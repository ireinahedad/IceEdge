/* ArakIce — player search for the props hub.
   CSP-safe: loaded from 'self', no inline JS, no storage.

   The rows are rendered server-side by scripts/seo-gen.mjs so that the served
   HTML contains a real <a href="/props/..."> for every player — this file only
   SHOWS and HIDES rows that already exist. It used to build them from a JSON
   blob, which left the page with no crawlable links and capped the list at 300
   rows; do not go back to that. */
(function () {
  "use strict";

  var input = document.getElementById("player-search");
  var listEl = document.getElementById("player-list");
  var countEl = document.getElementById("player-count");
  if (!input || !listEl) return;

  var rows = Array.prototype.slice.call(listEl.querySelectorAll("li[data-hay]"));
  if (!rows.length) return;
  var total = rows.length;

  function normalize(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
  }

  function render(filter) {
    var q = normalize(filter).trim();
    var shown = 0;
    for (var i = 0; i < total; i++) {
      var row = rows[i];
      var match = !q || row.getAttribute("data-hay").indexOf(q) !== -1;
      // .hidden keeps the anchor in the DOM — hiding is a display concern, and
      // a crawler that ignores our CSS still sees every link.
      row.hidden = !match;
      if (match) shown++;
    }
    if (countEl) {
      countEl.textContent =
        shown === total ? total + " players" : shown + " of " + total + " players";
    }
  }

  var t = null;
  input.addEventListener("input", function () {
    if (t) clearTimeout(t);
    var v = input.value;
    t = setTimeout(function () { render(v); }, 80);
  });
})();
