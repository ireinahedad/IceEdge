/* ===========================================================================
   ICEEDGE — moteur d'animation des plans
   ---------------------------------------------------------------------------
   Expose window.setProgress(t), t ∈ [0, 1]. Le rendu appelle cette fonction
   image par image au lieu de laisser une animation tourner en temps réel.

   POURQUOI PILOTER LA PROGRESSION PLUTÔT QUE LE TEMPS. Capturer une animation
   CSS qui tourne toute seule oblige à espérer que la capture tombe au bon
   moment : le résultat dépend de la charge de la machine et deux exécutions ne
   donnent pas les mêmes images. Ici l'état est une fonction pure de t. Deux
   rendus du même plan sont identiques au pixel près, et on peut recalculer une
   seule image sans rejouer toute la séquence.

   État par défaut : t = 1, l'image finale. L'aperçu HTML et le rendu statique
   affichent donc le bon résultat sans rien avoir à appeler.
   =========================================================================== */

(function () {
  'use strict';

  /* Départ vif puis freinage long. Un mouvement linéaire paraît mécanique, et
     un rebond ferait cabaret sur un compte d'analyse. */
  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* Sous-fenêtre de la progression globale : permet d'échelonner les éléments
     sans multiplier les horloges. */
  function phase(t, start, end) {
    if (t <= start) return 0;
    if (t >= end) return 1;
    return easeOut((t - start) / (end - start));
  }

  /* Découpe "61.5%" ou "+8.2" en préfixe / nombre / suffixe.
     Renvoie null pour "7-0" ou "3-4", qui sont des scores et non des
     grandeurs : les compter reviendrait à animer un tiret. */
  function splitNumber(text) {
    var m = /^([+\-−]?)(\d+(?:\.\d+)?)(.*)$/.exec(String(text).trim());
    if (!m) return null;
    if (/^\s*[-−]\s*\d/.test(m[3])) return null;
    return { prefix: m[1], value: parseFloat(m[2]), suffix: m[3], decimals: (m[2].split('.')[1] || '').length };
  }

  var bigEl = document.querySelector('.big');
  var bigParts = bigEl ? splitNumber(bigEl.textContent) : null;

  window.setProgress = function (t) {
    t = Math.max(0, Math.min(1, t));

    /* Le chiffre : il grandit et se remplit sur le premier tiers du plan.
       L'échelle part de 0.82 et non de 0 — un chiffre qui naît d'un point
       attire l'œil sur le mouvement au lieu de la valeur. */
    if (bigEl) {
      var p = phase(t, 0, 0.34);
      bigEl.style.transform = 'scale(' + (0.82 + 0.18 * p) + ')';
      bigEl.style.opacity = String(Math.min(1, p * 1.6));
      if (bigParts) {
        var v = bigParts.value * p;
        bigEl.textContent = bigParts.prefix + v.toFixed(bigParts.decimals) + bigParts.suffix;
      }
    }

    /* Libellé et comparaison arrivent après le chiffre : on lit la valeur,
       puis ce qu'elle mesure. L'ordre inverse gâche les deux. */
    ['.label', '.sub', '.body-text'].forEach(function (sel, i) {
      var el = document.querySelector(sel);
      if (!el) return;
      var p2 = phase(t, 0.22 + i * 0.08, 0.62 + i * 0.08);
      el.style.opacity = String(p2);
      el.style.transform = 'translateY(' + (14 * (1 - p2)) + 'px)';
    });

    /* Barres horizontales : elles poussent depuis la gauche, dans l'ordre du
       classement, avec un décalage par rang. */
    var hBars = document.querySelectorAll('.anim-bar-h');
    hBars.forEach(function (el, i) {
      var start = 0.12 + i * 0.045;
      el.setAttribute('transform', 'scale(' + phase(t, start, start + 0.4) + ', 1)');
    });

    /* Barres verticales : depuis le bas, d'où la translation qui compense
       l'origine SVG en haut à gauche. */
    document.querySelectorAll('.anim-bar-v').forEach(function (el, i) {
      var p3 = phase(t, 0.12 + i * 0.09, 0.62 + i * 0.09);
      var baseY = parseFloat(el.dataset.baseY || '0');
      var h = parseFloat(el.dataset.height || '0');
      el.setAttribute('y', String(baseY + h * (1 - p3)));
      el.setAttribute('height', String(Math.max(h * p3, 0.01)));
    });

    /* La courbe se trace. */
    document.querySelectorAll('.anim-line').forEach(function (el) {
      var len = parseFloat(el.dataset.length || '0');
      el.style.strokeDasharray = String(len);
      el.style.strokeDashoffset = String(len * (1 - phase(t, 0.1, 0.75)));
    });

    document.querySelectorAll('.anim-dot').forEach(function (el, i) {
      el.style.opacity = String(phase(t, 0.25 + i * 0.06, 0.55 + i * 0.06));
    });

    /* Étiquettes chiffrées posées sur le graphique. */
    document.querySelectorAll('.anim-fade').forEach(function (el, i) {
      el.style.opacity = String(phase(t, 0.3 + i * 0.04, 0.7 + i * 0.04));
    });
  };

  window.setProgress(1);
})();
