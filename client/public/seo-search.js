/* ArakIce — player search for the props hub.
   CSP-safe: loaded from 'self', reads an inert <script type="application/json">
   blob and filters the rendered list client-side. No inline JS, no storage. */
(function () {
  "use strict";

  var input = document.getElementById("player-search");
  var listEl = document.getElementById("player-list");
  var countEl = document.getElementById("player-count");
  var dataEl = document.getElementById("players-data");
  if (!input || !listEl || !dataEl) return;

  var players = [];
  try {
    players = JSON.parse(dataEl.textContent || "[]");
  } catch (e) {
    return;
  }

  // Pre-sort alphabetically by name for a stable default view.
  players.sort(function (a, b) {
    return (a.name || "").localeCompare(b.name || "");
  });

  function normalize(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
  }

  function render(filter) {
    var q = normalize(filter);
    var frag = document.createDocumentFragment();
    var shown = 0;
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var hay = normalize(p.name + " " + (p.team || "") + " " + (p.pos || ""));
      if (q && hay.indexOf(q) === -1) continue;
      shown++;
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = p.url;
      a.className = "player-row";
      var name = document.createElement("span");
      name.className = "player-name";
      name.textContent = p.name;
      var meta = document.createElement("span");
      meta.className = "player-meta";
      meta.textContent = [p.pos, p.team].filter(Boolean).join(" · ");
      a.appendChild(name);
      a.appendChild(meta);
      li.appendChild(a);
      frag.appendChild(li);
      if (shown >= 300) break; // cap DOM size for very long queries
    }
    listEl.innerHTML = "";
    listEl.appendChild(frag);
    if (countEl) {
      countEl.textContent = shown === players.length
        ? players.length + " players"
        : shown + " of " + players.length + " players";
    }
  }

  var t = null;
  input.addEventListener("input", function () {
    if (t) clearTimeout(t);
    var v = input.value;
    t = setTimeout(function () { render(v); }, 80);
  });

  render("");
})();
