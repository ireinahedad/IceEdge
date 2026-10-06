# QA — ce qui reste (ArakIce / ICEEDGE)

> Tout le reste est passé ou clos (campagnes statiques de juillet, I1 et I2 (7/7, étape 4 le 2026-10-06), QA dynamique
> du 2026-09-26, F1/F2/F6/C1 le 2026-10-05, I6, C4 et I4 les 2026-10-05/06). P1, P2 et P5 sont clos
> sans tir contre la production (décision du 2026-10-06 : bancs du 2026-09-18/19 et QA locale du
> 2026-09-26). Détail de ces campagnes : `git show 9b9a907:QA_TEST_PLAN.md`.

Règles inchangées : **pas de staging**. On teste en production avec des comptes jetables, le Pro
s'obtient par code promo et jamais par un vrai paiement. L'authentification se teste sur
arakice.com, pas sur un aperçu `*.vercel.app`.

## 1. P4 — Performance mobile (Lighthouse) · Haute · Échoué (correctifs à déployer)

PSI mobile sur arakice.com le 2026-10-06 à 09:21, après déploiement : **59**
(FCP 3,4 s · LCP 3,8 s · TBT 0 ms · **CLS 0,481** · SI 4,3 s). Avant : 58, LCP 4,2 s, SI 5,3 s.
Attendu : LCP < 2,5 s, CLS < 0,1.

- **CLS : cause trouvée et corrigée (non déployé)**. Chaque carte de match mesurait 92 px pendant le
  chargement, puis 99 px quand les pastilles de cote (`FairOddsPill`, 22 px) apparaissaient avec
  `/api/predict/game/…/bundle` ; chaque carte poussait les suivantes de 7 px de plus. `FairOddsPill`
  accepte maintenant `reserve`, qui garde la place pendant le chargement (utilisé par `LandingCards`).
  Vérifié en prod en simulant le correctif : 99 px avant et après.
- **Forced reflow de 749 ms (701 nœuds) : corrigé (non déployé)**. Le défilement automatique de
  `TeamCarousel` lisait `scrollLeft`, `scrollWidth` et `clientWidth` à chaque image ; après chaque
  mise à jour du DOM par React (arrivée d'un `bundle`), cette lecture forçait une mise en page du
  document entier. Les tailles sont maintenant mises en cache (`ResizeObserver`), la boucle ne lit plus
  rien, le recalage passe par `onScroll`, et le défilement attend 4 s après le chargement.
- **À faire** : déployer, puis relancer PSI mobile et comparer (CLS attendu < 0,1).
- **Polices : 750 ms bloquantes** (une seule requête Google Fonts depuis le correctif). Pour les
  supprimer : héberger Oswald, Inter et Merriweather 700 dans `public/fonts` (la CSP accepte `'self'`).
- LCP = paragraphe « Best Parlay », 1,7 s de délai de rendu (contenu rendu en JS).

## 2. Vérifications après le lot du 2026-09-26 · Haute

- [x] Connexion et refresh sur arakice.com, `/stats/chart` (2026-10-06).
- [x] Déconnexion sur arakice.com (2026-10-06).
- [ ] Provoquer une 500 et vérifier que l'événement Sentry affiche `authorization: [Filtered]` et
      `cookie: [Filtered]`.
- [x] I4 : connexion Google avec un compte neuf (création) (2026-10-06).

## 3. Appareils réels · Moyenne

| # | Test | Attendu | Fait |
|---|---|---|---|
| C2 | Firefox, Safari, Edge (desktop) + Android Chrome | Rendu et interactions Radix/Recharts identiques, aucune erreur console bloquante, graphiques Charts corrects, partage d'image (`html-to-image`) fonctionnel | Chromium desktop ✔ (2026-10-06, 9 routes) ; iPhone Safari ✔ (C1) |
| C3 | Notifications push (PWA) | Abonnement, réception et clic fonctionnent là où c'est supporté ; dégradation propre ailleurs (restrictions iOS) ; ajout à l'écran d'accueil et permission refusée testés | — |

## 4. SEO — restes de C4 · Moyenne

- [ ] **Commiter les 53 pages `/matchup/*` hors sitemap corrigées le 2026-10-06** (phrase « only
      road win » fausse). Les 137 pages du sitemap sont déjà justes en prod. `seo:gen` ne repasse pas
      sur les paires sorties de l'horizon de 3 semaines.
- [ ] Titres trop longs, tronqués par Google au-delà d'environ 60 caractères : `/matchup/*`
      (70–85 c, `seo-gen.mjs`) et pages `/fr/match/*` (jusqu'à 96 c, `gameday-gen.mjs`).
- [ ] Descriptions de 176 à 191 caractères sur `/nhl-predictions-today`, `/best-nhl-picks-today`,
      `/nhl-ai-predictions` et `/best-nhl-betting-software` (à garder sous 160).
- [ ] Le script Cloudflare `static.cloudflareinsights.com/beacon.min.js` est bloqué par la CSP sur
      chaque page (une erreur console partout, Best Practices 92). Couper Web Analytics dans
      Cloudflare, ou ajouter le domaine à `script-src` et `connect-src`.

## 5. Après une vraie fréquentation du chat

`npm run moderation:dry-run` (serveur) : relire ce que le filtre aurait refusé.
