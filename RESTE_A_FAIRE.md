# ARAKICE / ICEEDGE — Ce qui reste

**Mis à jour le 2026-09-16.**

> **Règle du document.** Il ne contient que ce qui **reste à faire**. Un point
> terminé est **retiré**, pas coché ni raconté : l'historique Git garde le détail.
> Les seules traces de travail fini sont les règles de la dernière section
> (« À ne pas défaire »), en une ou deux lignes chacune.

**Plans encore vivants, à tenir à jour :** `ml/REFACTOR_PLAN.md`,
`QA_TEST_PLAN.md`, `AUDIT_SCALABILITE_COUTS.md`.

---

## 1. Avant le lancement

Rien ici ne demande de conception ; tout demande **ta machine ou une console**.

| # | Quoi | Où | Pourquoi ça bloque |
|---|---|---|---|
| B3 | Tir de charge **S1 de validation** : `NHL_USE_MOCK=true` vérifié dans les logs de démarrage, 50 VUs | préprod | Les deux premiers tirs ont mesuré une API NHL morte : un critère vert peut vouloir dire que le code n'a pas tourné. `AUDIT_SCALABILITE_COUTS.md` §5. |
| B4 | Parcours critiques **F1, F2** + **étape 4 de I2** | prod (pas de staging) | F1 et F2 écrivent en base (comptes, essai Pro, session Stripe) et attendent une cible jetable. L'étape 4 de I2 est un `curl` sans en-tête `Origin`, à lancer depuis ta machine (commande dans `QA_TEST_PLAN.md` § « Runbooks B4 »). |
| B5 | **C1** — parcours mobile iOS Safari (login → prédiction → paiement) | appareil réel | Safari iOS est la source n°1 de bugs cookies/`SameSite`/PWA. |

- [ ] **Pousser le correctif de `useNHLData`** (boucle de rendu de
      `/nhl-predictions`, ~500 `GET /api/nhl/teams/:id/stats` par seconde en
      production par visiteur), puis vérifier sur le site que la page affiche
      les matchs et ne fait plus que quelques appels.

### Cloudflare (compte d'origine, géré depuis `ireinahedad24@gmail.com`)

- [ ] **R6 (option) · *Full (strict)* pour `arakice.com` et `www` seulement**, par
      une règle de configuration, `api` restant en *Full*. Seulement **après**
      avoir vu dans Vercel (Settings → Domains) que le certificat se renouvelle
      bien derrière le proxy.
- [ ] **R1 · Adresse de récupération** du compte Google `ireinahedad24@gmail.com`
      à vérifier à la main (hors Cloudflare).
- [ ] **R7 · `support@arakice.com`.** Envoyer un vrai mail **depuis une autre
      adresse** que la gmail et le voir arriver (Gmail masque souvent un message
      qui revient à son expéditeur). Puis trancher l'adresse publiée :
      `support.arakice@gmail.com` (celle de `AUDIT_PRE_FREEZE_IOS.md`) ou la
      nouvelle. **Poser un DMARC** avant d'envoyer du courrier depuis le domaine.
- [ ] **R8 · `cdn.arakice.com` (optionnel, pas avant le lancement).** Retire la
      limite de débit de `r2.dev`. ⚠️ Changer `R2_PUBLIC_URL` rend les avatars
      existants non supprimables (`deleteAvatarByUrl` compare au préfixe
      courant) : à faire **avec** un `UPDATE user_profiles SET avatar_url =
      replace(…)` dans la même fenêtre, sinon pas du tout.
- [ ] **R9 · Fermer le compte `Ireinahedad@icloud.com's Account`** (zone et R2
      déjà nettoyés). Irréversible, à faire à la main.

### À trancher avant le lancement

- [ ] **`EMAIL_VERIFICATION_DISABLED=true` en production.** Une inscription
      authentifie immédiatement avec une adresse non vérifiée. Sans doute
      délibéré (`RESEND_API_KEY` absente), mais **la récupération de mot de passe
      (F6) repose sur ce même canal absent**.
- [ ] **`/nhl-predictions` affiche des nombres inventés.** `computeRulePrediction`
      sort des pourcentages codés en dur pour une vingtaine de marchés (30 %
      buteur, 55 % tirs, 38 % période la plus prolifique…) ou dérivés par
      coefficients arbitraires (`hw × 0.55`), et « Ask LLM » est un texte simulé
      (`askLLMForMarket`, placeholder avec délai). Contredit la règle « pas de
      nombre inventé ». Brancher sur le backend, retirer la page, ou la
      masquer.
- [ ] **Staging.** Il n'en existe aucun (Railway n'a que `production`). Soit on en
      crée un, soit chaque campagne du §4 marquée « en staging » choisit entre la
      production et rien.
- [ ] **Sentry** : l'essai *Business* devait expirer vers le 2026-09-12. Vérifier
      sur quel plan le compte est retombé.

### À la première vente

- [ ] **Vercel Pro** (~20 $/mo) — le plan Hobby interdit l'usage commercial.
- [ ] **Railway et GitHub s'inversent.** Le hard limit Railway (25 $) mettrait
      hors ligne des gens qui ont payé, et le budget GitHub à 0 $ **bloque** les
      appels LLM des abonnés Pro au lieu de les facturer. Relever les deux.
- [ ] **Cache Cloudflare devant `api.arakice.com`** : le proxy est en place et
      les en-têtes de cache sont posés ; vérifier qu'il met réellement en cache
      ce qu'ils autorisent (réduit l'egress Railway facturé).
- [ ] **Après le lancement :** vider `PRO_PROMO_CODES` sur Railway, redéployer,
      vérifier qu'un ancien code renvoie 400. Si les codes deviennent
      individuels : table `promo_redemptions` (`max_uses` / `expires_at`),
      changement de schéma.

### Échéances techniques

- **`pg` v9 / `pg-connection-string` v3** : les modes SSL `prefer`, `require`,
  `verify-ca` sont aujourd'hui des alias de `verify-full` et changeront de sens.
  À traiter avant cette montée de version.
- **Node ≥ 22 avant janvier 2027** : le conteneur tourne sur node v20.20.2, et le
  SDK AWS v3 (celui qui parle à R2) l'exigera.
- **GitHub Actions** : `actions/checkout@v4`, `actions/setup-node@v4` et
  `gitleaks/gitleaks-action@v2` ciblent Node 20, déprécié sur les runners. Les
  monter d'un cran à la prochaine ouverture de `ci.yml`, **sans toucher aux
  déclencheurs**.
- **Paris tennis en base** : restent « pending » pour toujours. Les solder est
  une requête SQL manuelle, à décider séparément.

---

## 2. ML — où reprendre

**Une seule décision commande le reste : payer ou non un mois de The Odds API
(59 $).**

| Poste | État |
|---|---|
| **A1** — backfill payant | ⏸️ **En attente de ta décision.** Code prêt et borné. |
| **A1bis** — collecte live | Un contrôle, à la pré-saison (ci-dessous). |
| **A2** — règle puck line | ⏸️ Figée, non évaluable avant A1 ou une saison de collecte live. |
| **S4** | Restent γ et ⑤, reportés sciemment. |
| **A4** — fenêtre de confirmation du gardien | ⏸️ Demande des snapshots serrés autour du coup d'envoi. |
| **A6** — team totals, prolongation, écarts ±2.5 | ⏸️ Après A1 et A2. |

### La décision : payer 59 $ un mois, ou non

**Ce que la mesure CLV du 2026-08-23 a établi** (9 saisons, prix d'ouverture) :
le CLV moneyline est réel mais **annule tout juste la marge** — on bat
l'ouverture d'environ une marge, pas la clôture ; le +4,30 % réalisé à edge ≥ 4 %
est probablement de la chance. **Les totaux sont morts** (CLV sous leur propre
placebo).

**L'argument pour.** Le CLV converge **83 fois plus vite** que le ROI (~160 paris
pour détecter 0,5 % de CLV contre ~13 300 pour 2 % de ROI). Mais le CLV de la
puck line n'est pas mesurable sur SBRO (pas de paire ouverture/clôture), et la
règle A2 ne produit que ~51 paris par saison :

| Chemin | Paris disponibles | Verdict CLV possible en |
|---|---|---|
| **Backfill payant** (2023-24 → 2025-26) | ~154 | **une semaine** |
| Collecte live seule | ~51/an | **~2029** |

Le mois donne aussi ~3 900 matchs vraiment hors échantillon (SBRO s'arrête au
2022-11-27), rend **A4 mesurable**, et **débloque le blend marché** : la tranche
de test (2023-02-26 → 2026-04-16) ne contient aucune cote, donc aucun blend n'est
ajustable tant que 2023-2026 n'est pas comblé. Le jeu de données reste sur ton
disque après résiliation.

**Les arguments contre.** Le résultat moneyline annonce un verdict probablement
**négatif** pour la puck line — utile pour arrêter de chercher, pas pour gagner.
Les ~160 paris sont une estimation empruntée au moneyline. La collecte live est
gratuite. **Espérer que le +4,30 % réapparaisse n'est pas un argument.**

**Le chiffrage.** En **trois plages** calées sur `1er octobre → 30 avril`
(saison régulière seulement, la seule que `build_dataset.py` sait joindre) :
**66 630 crédits sur 100 000**, pour 3 936 matchs. Une plage continue en
consommerait 88 000 à 94 000 (étés et séries inutilisables). Le « ~4 appels par
jour » reste une hypothèse (docstring de `fetch_odds_api`), surtout sur 2025-26
(calendrier comprimé) : d'où `--odds-api-budget` par plage, seul plafond dur.

### Les commandes, si tu paies

Tout tourne sur ta machine (xgboost et `node_modules` sont Windows-only ici).

```bash
cd ml/python

# JAMAIS sans --only odds --from-local : odds.csv est irremplaçable et réécrit
# à chaque exécution.
#   1. la clé, pour cette fenêtre seulement (cmd.exe) :
#      for /f "tokens=1,* delims==" %a in ('findstr /b "ODDS_API_KEY=" ..\..\server\.env') do set ODDS_API_KEY=%b
#   2. ~300 crédits : comparer SBRO et l'API sur une plage couverte par les deux
python fetch_data_v4.py --only odds --from-local --odds-api-budget 300 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2021-11-01 --odds-api-to 2021-11-10
#   3. le backfill, en trois plages (plafond volontairement au-dessus de
#      l'estimation : il borne la casse sans couper une plage correcte)
python fetch_data_v4.py --only odds --from-local --odds-api-budget 23000 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2023-10-01 --odds-api-to 2024-04-30
python fetch_data_v4.py --only odds --from-local --odds-api-budget 23000 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2024-10-01 --odds-api-to 2025-04-30
python fetch_data_v4.py --only odds --from-local --odds-api-budget 23000 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2025-10-01 --odds-api-to 2026-04-30
#   4. python build_dataset.py, puis --clv et --derived sur des saisons neuves
#   5. résilier
```

`regions eu` + `bet365` : les mêmes que le collecteur live, sinon on recrée le
mélange de sources que la comparaison doit détecter (le défaut du script est
`us`).

### A1bis — le contrôle de pré-saison

- [ ] **Fin septembre (tâches planifiées le 22 septembre et le 13 octobre — elles
      demandent le relevé, elles ne le lisent pas à ta place).**
      1. **D'abord** la bannière du conteneur en cours :
         `[OddsLogger] ✅ ODDS_API_KEY acceptée par The Odds API`, calendrier armé
         (`slots: 6, creditsPerDay: 10`), et **pas** de `DORMANT=true`.
      2. Puis, en fin de journée de matchs, `https://arakice.com/dev/ml` → onglet
         « Données » → carte « Série temporelle des cotes » (compte admin, **par le
         dashboard**, pas par l'URL de l'API) : `passes_today` = **6** et
         `with_puckline` > 0. Si `rows` reste à 0 alors que `odds_log.rows` monte,
         chercher `[OddsLogger] snapshot non archivé` dans les logs.
- [ ] **En octobre :** envisager `ODDS_LOG_RUN_AT_BOOT=true` (sans objet avant :
      `logTodaysOdds` sort sur `isSeasonActive()`).

### A2 — puck line

Règle figée : miser la jambe qui **donne** les 1.5 buts quand
`p_modèle − p_marché ≥ 0.04`, mise à plat, critère **ROI > 0**. **Ne rien miser
d'ici là** — « non réfuté » n'est pas « établi ».

### S4 — ce qui reste

> ⚠️ **Contrainte en vigueur.** Le modèle de score est **mal calibré dans les
> queues** : bin 0,7-0,8, il annonce ~0,73 pour un observé de ~0,80. Les six
> marchés servis par `base_prob` (`last_team_score`, `period{1,2,3}_winner`,
> `winning_margin`, `double_chance`) sortent donc une probabilité de favori trop
> basse de ~7 points sur les affiches tranchées. **Ne pas miser dessus** tant que
> γ n'est pas posé.

- [ ] **Étirer l'écart de λ (γ) — après la saison 2026-27.** `S = λ_dom + λ_ext`
      conservé, `δ = log λ_dom − log λ_ext` remplacé par `γ·δ`, un seul paramètre
      ajusté sur la validation ; totaux intacts, marchés dérivés corrigés. On
      attend parce qu'il n'y a que 228 matchs au-dessus de 0,75 : poser γ
      maintenant, ce serait l'ajuster sur du bruit. `backtest.py --reliability`
      mesure déjà tout.
- [ ] **La mesure qui tranchera ⑤ — quand la saison 2026-27 sera dans le
      dataset.** `python build_dataset.py`, puis `train.py` et `train_score.py` :
      comparaison sur des matchs qu'aucun des deux modèles n'a vus.
- [ ] **⑤ Suppression du classifieur — après le lancement**, en « option 1 » :
      classifieur rétrogradé en **repli pur**, `_blend_w` et le chemin nominal
      supprimés, `game_model.json` gardé **une release de plus** (la mesure
      ci-dessus a besoin des deux modèles).

### A4 et A6

- [ ] **A4** — extraire la trajectoire des lignes autour de l'heure de
      confirmation du gardien. Mesure préalable : elle dit s'il y a lieu de
      construire.
- [ ] **A6** — team totals, prolongation, écarts ±2.5 : priçables par
      `score_model.py`, jamais confrontés à des prix réels. Après A1 et A2.

---

## 3. Scalabilité — déclenchés sur seuil

Source : `AUDIT_SCALABILITE_COUTS.md` §3. **Rien ici n'est requis pour 500
simultanés.**

| # | Quoi | Déclencheur | Effort |
|---|---|---|---|
| **D** 🔴 | **Redis (Upstash)** : adapter Socket.io + store de rate limit Redis + quota LLM Free. Le stub `redisRateLimitStore.ts` a été retiré le 2026-09-15 : le récupérer dans l'historique Git ou le réécrire. | **avant la 2ᵉ instance** | 1 j+ |
| E | Migrer les data-URI d'avatars déjà en base vers R2 — code et variables en place | ~500 utilisateurs avec avatar | 2 h |
| Q | 2ᵉ instance Railway + sticky sessions | CPU > ~70 % en régime | 4 h |
| U | RAM du service ML : 2 workers uvicorn à ~300-500 Mo RSS chacun ne tiennent pas dans 512 Mo | avant le premier pic réel | 15 min |
| I | TanStack Query côté client — `fetch` brut partout, aucune déduplication | quand la facture Railway devient visible | 2 j |
| T | Cache de prompts LLM identiques | quand l'usage LLM devient significatif | 4 h |
| V | Échantillonner les logs 2xx | à la première facture de logs | 1 h |
| W | Purge Tailwind — CSS à 90,5 ko brut / 21 ko gzip | — | 2 h |

- [ ] **Question ouverte :** `writeLimiter` (30 écritures/min sur `/api/chat` et
      les routes d'écriture) est encore **par IP**, donc exposé au NAT mobile.
      Passer « par compte » affaiblirait l'anti-spam là où il sert le plus (les
      salons ont déjà leur limiteur par action). À trancher.

---

## 4. QA — campagnes à exécuter

Source : `QA_TEST_PLAN.md` (résultat attendu, notes, pièges). Sécurité et
résilience sont validées en statique ; ce qui reste est dynamique. F1 et F2 ont
un runbook (§ « Runbooks B4 »), les autres pas encore.

**Fonctionnel** — F1 auth complète · F2 gating Pro bout en bout · F3 slip +
settlement · F4 prédictions NHL du jour · F5 Best Bets / value bet scan ·
F6 récupération de mot de passe

**Intégration** — I3 webhook Stripe idempotent · I4 Google OAuth · I5 socket.io ·
I6 pipeline données externes → features

**Performance** — P1 charge sur l'endpoint ML (définir le p95 accepté) ·
P2 cache et quotas externes · P3 rate limiting en multi-instance · P4 Lighthouse
mobile · P5 pool Postgres (**vérifier d'abord que `DATABASE_URL` pointe sur
`-pooler`**)

**Compatibilité** — C1 mobile iOS/Android · C2 cross-navigateur desktop · C3 push
web · C4 pages SEO statiques sur crawlers

**Sécurité dynamique** — IDOR à 2 comptes · JWT expiré/altéré rejeté et refresh
non rejouable après logout

**Résilience** — couper le ML · couper The Odds API et retirer `scratches.json` ·
redeploy Railway sous trafic · webhook Stripe rejoué

**Reprise** — un **vrai test de restauration** de la base (`BACKUP_DR.md` n'a
jamais été joué) · documenter et tester une fois le rollback Railway/Vercel

---

## 5. SEO

- [ ] **Search Console** : cliquer « Valider la correction » sur « Redirect
      error » (la redirection `www` → apex est en place), puis relire les
      rapports d'indexation dans un mois (vers le 2026-10-16).
- [ ] **Une fois la saison 2026-27 commencée :**
      1. `npm run seo:gen` — les statistiques affichées sont celles de 2025-26.
         Pas avant : hors saison, l'API rendrait des zéros. (Ajoute aussi le
         `<lastmod>` qui manque au sitemap servi.)
      2. Refaire le relevé Search Console et réviser la liste blanche des pages
         `/props/` (`client/scripts/props-allowlist.json`, seuil 5 impressions) :
         les chiffres actuels sont d'intersaison et sous-estiment les joueurs
         établis. **Répercuter chaque changement dans la regex d'exclusion de
         `client/vercel.json`.**

---

## À ne pas défaire

**Production et consoles**
- **Une valeur saisie n'est pas une valeur en service.** Railway garde une
  variable modifiée en attente derrière « Deploy ». Ne conclure que sur la
  bannière `[Server] Réglages effectifs` du conteneur **en cours** — une mesure
  porte une date, pas un état.
- **`NHL_USE_MOCK=true`** empêche tout règlement de paris, sans une erreur ;
  **`DORMANT=true`** coupe la collecte de cotes, sans un message.
- **Une sonde verte ne dit pas que c'est la bonne cible** : `HeadBucket ✅` prouve
  qu'un bucket répond ; lire l'endpoint imprimé (`2216e2d9…`). Un contrôle muet en
  cas de succès ne se distingue pas d'un contrôle qui n'a pas tourné.
- **DNS : ne jamais deviner une valeur.** La cible de `api` est
  `zhynah7t.up.railway.app`. Si l'apex est retouché : CNAME
  `cname.vercel-dns.com` plutôt qu'une IP Vercel figée. Ne jamais importer une
  zone depuis un scan (il relève les IP anycast Cloudflare). **Ne jamais
  supprimer le TXT `google-site-verification`** : il porte la propriété Search
  Console.
- **Cloudflare SSL/TLS : zone en *Full*, jamais *Full (strict)* pour `api`**
  (Railway sert un moment `*.up.railway.app` pendant ses renouvellements), et
  **jamais *Always Use HTTPS*** (bloque le challenge HTTP de Vercel ; Vercel et
  Railway redirigent déjà). TLS minimum 1.2 depuis le 2026-09-16.
- **Service ML `Unexposed`** : ne pas suivre la suggestion du panneau *Agent* de
  Railway (`ML_SERVICE_URL=${{ …RAILWAY_PUBLIC_DOMAIN }}`).
- **Sentry** : ne pas suivre l'assistant « Configure Express SDK » (second
  `Sentry.init()`) ; `SENTRY_TRACES_SAMPLE_RATE` est absente **volontairement**.
- **Migrations** : `npm run db:migrate:all` applique **tout l'arriéré** ; la
  cible doit être visible dans la sortie (`[migrate] Cible : …`) ; vérifier
  `PUBLIC_SLIPS_SINCE` avant.

**Code**
- **Pas de repli local de prédiction, jamais** : en panne, « — » et un bandeau ;
  `MarketSelectorSheet` refuse d'ajouter la jambe.
- **`useNHLData` renvoie des fonctions stables (`useCallback`)** : des pages les
  mettent dans les dépendances d'effets réseau. Recréées à chaque rendu, elles
  ont fait tourner `/nhl-predictions` en boucle (2026-09-16).
- **Jamais un secret derrière `VITE_`** (inliné dans le bundle). **Ne jamais
  journaliser l'URL de The Odds API** (clé en query string).
- **`ci.yml`** : ne pas retirer `master` des déclencheurs, ne pas élargir à
  toutes les branches.
- **`isSeasonActive()`** répond « en saison » sur `!res.ok` : voulu. **`fetchSpreadsOnly`**
  renvoie `[]` en panne au lieu d'un prix périmé : voulu.
- **Un typecheck se prouve actif** en y insérant une faute volontaire (TS5101
  arrête `tsc` sans rien vérifier).
- **Tennis retiré** : ne pas le réintroduire ; `SportContext` reste en mono-sport ;
  garder les commentaires qui le mentionnent.
- **SEO** : les hubs émettent leurs ancres côté serveur — ne jamais revenir au
  rendu JS (il a créé 786 orphelines). Le nombre de matchs joués n'est pas un test
  de qualité : trancher sur la donnée Search Console.
- **Découper un fichier** : par script, avec trois contrôles — syntaxe, résolution
  des imports internes, multiensemble des lignes avant/après. Pièges : identifiants
  cités en commentaire (passer par l'AST), imports à effet de bord
  (`import "x.css"`) silencieusement perdus.

**Dépôt**
- **`git config core.autocrlf input`** (local, non versionné) neutralise le bruit
  CRLF de `npm ci` sous Windows. `git diff --shortstat --ignore-all-space` dit en
  une seconde si un gros diff contient du vrai travail. **`npm ci`, jamais
  `npm install`.**
- **Purge de l'historique Git : abandonnée, ne pas rouvrir** (dépôt privé, clés
  mortes, et elle casserait les SHA cités).
