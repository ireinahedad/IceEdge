# PERF_PLAN.md — Latence d'ArakIce : ce qui reste à faire

**Owner:** Ireina · **Mis à jour :** 2026-10-25

> Le plan de latence (accueil, calendrier, page match, direct, Cloudflare, compression) est
> **terminé, déployé et vérifié**. Il ne reste que des pistes à faible gain, à ne lancer que si une
> mesure le justifie.

---

## 1. Suivre le LCP mobile

- Lancer PageSpeed Insights (mobile) sur `https://arakice.com/` et noter FCP / LCP / CLS.
- Objectif : LCP < 2,5 s (item P4 de `STATUS.md` §3.7, toujours ouvert).
- Si le LCP reste au-dessus : regarder le bundle principal (≈ 337 ko, 107 ko gzip), surtout le
  dictionnaire i18n (~115 ko avant minification, les deux langues) et react-router.

## 2. Alléger encore le bundle principal (~8 ko gzip)

- Passer en `lazy()` les sections de l'accueil situées sous la ligne de flottaison :
  `BestBetsSection`, `EvSection`, `ProUpsell` (`pages/HockeyLanding.tsx`).
- ⚠️ `BestParlaySection` importe `bestBetToLeg` depuis `BestBetsSection` : déplacer cette fonction
  dans un module à part avant de rendre `BestBetsSection` paresseux.
- Gain faible : ne le faire que si le point 1 montre que le JS pèse sur le LCP.

## 3. Cache partagé Cloudflare (optionnel)

- Aujourd'hui `cf-cache-status: DYNAMIC` : Cloudflare ne met rien en cache, c'est voulu.
- **Bloquant avant toute règle de cache :** nos réponses portent `Vary: Origin` (CORS avec plusieurs
  origines : arakice.com, l'app iOS `capacitor://localhost`, les aperçus Vercel). Le cache Cloudflare
  ignore `Vary: Origin` : une réponse mise en cache pour une origine serait servie aux autres avec le
  mauvais `Access-Control-Allow-Origin` (l'app iOS et les aperçus casseraient).
- Pistes : renvoyer une origine fixe sur les routes publiques en lecture seule, ou inclure l'en-tête
  `Origin` dans la clé de cache. Gain : surtout utile si le trafic augmente fortement.

## 4. Saisie manuelle et paquet ML

- Une saisie manuelle (`/dev/saisie` : gardien, alignement, blessures) vide le cache des marchés
  « règles » tout de suite, mais **pas** le paquet ML d'un match (cache serveur 10 min, servi
  périmé jusqu'à 2 h pendant son recalcul).
- À faire si besoin : vider aussi le paquet ML du match concerné après une saisie
  (`gameMlBundle.ts`, `routes/manual.routes.ts`).

## 5. Connue, décidée, rien à faire

- Utilisateur connecté, premier chargement après une pause : ~2 s de réveil de la base Neon
  (`/auth/refresh`, `/users/me`). **Décidé le 2026-10-24 : on garde la suspension Neon** (coût). À
  revoir seulement si le nombre d'utilisateurs connectés augmente.
