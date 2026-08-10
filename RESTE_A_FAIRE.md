# ARAKICE / ICEEDGE — Ce qui reste

**Créé le 2026-08-10.** Ce document regroupe **tout ce qui n'est pas fait**, tiré
des 6 plans et audits du dépôt. Il ne raconte pas ce qui a été livré — l'historique
Git et `PROJECT_CONTEXT.md` s'en chargent.

**Trois plans ont été supprimés** parce qu'ils étaient terminés ; leur restant est
ici et leur contenu durable a été déplacé (détail en dernière section) :

| Supprimé | Pourquoi | Où est parti le contenu durable |
|---|---|---|
| `PLAN.md` | Sections 1-5 livrées ; §6 (Share) livrée depuis, §7 (Opportunities) morte, §8 remplacée par les audits | rien à garder |
| `DEPLOY_PLAN.md` | Redondant avec `DEPLOYMENT.md` | `DEPLOYMENT.md` §4 (hôte canonique) et §6 (checklist) |
| `MARKETPLACE_PLAN.md` | Livré le 2026-08-09 | `DEPLOYMENT.md` §7 (invariants + annexe marketplace) |

**Toujours vivants, à tenir à jour :** `ml/REFACTOR_PLAN.md`, `QA_TEST_PLAN.md`,
`AUDIT_SCALABILITE_COUTS.md`, `PRODUCTION_READINESS_AUDIT.md` (ce dernier est
désormais entièrement absorbé — cf. § « Audit de production : soldé »).

---

## 1. Bloquant avant lancement

Rien ici ne demande de conception ; tout demande **ta machine ou une console**.

| # | Quoi | Où | Pourquoi ça bloque |
|---|---|---|---|
| B1 | `npm run typecheck && npm test` (server) et `npm run build` (client) | local | Le sandbox ne peut ni compiler ni lancer vitest. **Aucun** des changements récents n'a été validé autrement que par lecture. |
| B2 | Appliquer `npm run db:migrate:all` sur la base de **prod** (jusqu'à 030) | Neon | Les migrations sont dans le dépôt ; leur application en prod n'est pas confirmée. |
| B3 | Tir de charge **S1 de validation** : `NHL_USE_MOCK=true` vérifié dans les logs de démarrage, 50 VUs | préprod | Les deux premiers tirs ont mesuré une API NHL morte. Un critère vert peut vouloir dire que le code n'a pas tourné. `AUDIT_SCALABILITE_COUTS.md` §5. |
| B4 | Parcours critiques **F1, F2, I1, I2** en staging | staging | Auth complète, gating Pro, chaîne ML, CORS+cookie cross-site. `QA_TEST_PLAN.md` §1-2. |
| B5 | **C1** — parcours mobile iOS Safari (login → prédiction → paiement) | appareil réel | Safari iOS est la source n°1 de bugs cookies/`SameSite`/PWA. |
| B6 | Poser les **alertes de budget** dans les consoles (Railway, Neon, Odds, LLM, Stripe, Sentry, R2) | consoles | Seuils déjà documentés dans `MONITORING.md`. Hard limits là où ils existent. |
| B7 | Définir `SENTRY_DSN` sur le service **ML** Railway | console | Variable propre à ce service ; le code est prêt et no-op sans elle. |
| B8 | Confirmer la présence de **toutes** les variables d'env dans Railway/Vercel | consoles | Les `.env.example` sont complets ; leur miroir en prod ne l'est pas vérifié. |
| B9 | **Vérifier côté UI** qu'aucune cote factice n'est présentée comme réelle | client | Côté serveur c'est réglé (panne odds → `[]`, jamais de cote inventée). |

**Reportés au lancement officiel, sciemment** — pas des oublis :

- **Vercel Pro** (~20 $/mo). Le plan Hobby interdit l'usage commercial. Le risque
  commence **à la première vente**, pas au premier utilisateur.
- **Cloudflare devant Railway.** Les en-têtes de cache sont posés ; c'est ce qui
  manque pour qu'un CDN serve à quelque chose. Réduit aussi l'egress facturé.

---

## 2. ML — le chemin critique

Source : `ml/REFACTOR_PLAN.md`, qui reste la référence. Ordre imposé :
**A5 et A3 d'abord, S4 en dernier** — S4 est le seul chantier qui touche ce que
voit l'app, et l'ouvrir pendant que le modèle peut encore changer de features
obligerait à revérifier les routes deux fois.

### ⚠️ A5 — le run a été interrompu en pleine écriture

`ml/models/score_feature_selection.json` fait **356 octets et s'arrête au milieu
de `"seasons": [`**. Vérifié : taille et md5 identiques sur trois lectures
consécutives — ce n'est pas l'artefact de mount connu, le fichier est réellement
tronqué sur le disque. **Ne pas le lire comme un résultat.**

Bonne nouvelle : `score_ablation_cache.json` contient **686 entrées**, donc
l'essentiel du calcul est fait et le run reprendra là où il s'est arrêté.

- [ ] Relancer `python backtest_walkforward.py --select-score-features`
      (reprend sur le cache ; `--min-season 2016` réduit à ~260 fits si besoin)
- [ ] **Lire les sentinelles avant le tableau** : médiane près de 50 % = la
      procédure est saine ; le maximum est la barre à battre
- [ ] Décider l'élagage, modifier `ATK_COLS` / `DEF_COLS` **à la main**
- [ ] Contrôle : réentraîner en **supprimant réellement** les « RETIRER » et
      vérifier que la log-loss puck line ne monte pas

### A3 — CLV (promu chemin critique)

A2 a rendu ce poste obligatoire : ~51 paris par saison ne permettront **jamais**
de conclure sur un ROI. Le CLV se mesure comme un écart de prix sur chaque pari,
donc il converge en quelques centaines de paris.

- [ ] Conserver plusieurs snapshots par match (ouverture, T−3 h, clôture) — le
      fetcher les récupère déjà et les jette
- [ ] Colonnes `*_open` réelles dans `odds.csv` (aujourd'hui vides à dessein)
- [ ] Mode `--clv` dans `backtest_walkforward.py`

### A2 — puck line : règle figée, à évaluer

La règle est pré-enregistrée (miser la jambe qui **donne** les 1.5 buts quand
`p_modèle − p_marché ≥ 0.04`, mise à plat, critère **ROI > 0** et non « ≈ 20 % »).

- [ ] Comprendre pourquoi 2022-23 n'a que **26 %** de couverture puck line
      (342 lignes pour 1 312 matchs) — saison récente et l'une des deux négatives
- [ ] Évaluer la règle en **CLV** (via A3), pas en ROI
- [ ] **Ne rien miser d'ici là.** « Non réfuté » n'est pas « établi ».

### A1bis — collecte gratuite (livré, reste l'activation)

- [ ] **Local :** `npm test`, puis appliquer la migration **028**
- [ ] **Prod :** poser `ODDS_LOG_ENABLED=true` et `ODDS_USER_RESERVE`

> **Le compteur tourne.** Chaque journée de match non collectée est définitivement
> perdue — la cote de clôture d'hier n'existe plus nulle part.

### S4 — servir le moneyline depuis le modèle de score

Conception faite, **code non commencé volontairement**. Ne pas démarrer avant A5.

- [ ] Blend `score ⊕ marché` dans `train_score.py`, poids dans `score_report.json`
- [ ] Décomposition λ pour `feature_importances` (`pred_contribs`, 7 groupes)
- [ ] `confidence` depuis |λ_dom − λ_ext|, calibrée sur la distribution actuelle
- [ ] `base_prob = dist.p_home_win()` pour les marchés non dérivables
      (`last_team_score`, `period{1,2,3}_winner`, `winning_margin`, `double_chance`)
- [ ] Puis suppression du classifieur, **route par route**

> Le piège de S4 : le blend marché est **vivant** (`featureEngineering.ts:238`
> passe les cotes). Supprimer le classifieur supprimerait le blend, et P1 a mesuré
> le marché seul meilleur que les deux modèles nus. C'est pour ça qu'on réajuste
> le blend au lieu de le perdre.

### En attente d'un plan payant

- **A1** — comparer les deux sources de cotes. `/v4/historical/` n'est pas servi
  aux clés gratuites ; ce n'est pas un quota mais une offre. Le fetch est prêt et
  borné (3 barrières anti-dépense). ~300 crédits suffisent pour comparer.
- **A6** — team totals, prolongation, écarts ±2.5 : priçables, jamais confrontés
  à des prix réels. À regarder **après** A1 et A2.

### A4 — fenêtre de confirmation du gardien

Mesure préalable, pas une stratégie : elle dit s'il y a lieu de construire.

- [ ] Extraire la trajectoire des lignes autour de l'heure de confirmation

---

## 3. Scalabilité — déclenchés sur seuil

Source : `AUDIT_SCALABILITE_COUTS.md` §3. **Rien ici n'est requis pour 500
simultanés.**

| # | Quoi | Déclencheur | Effort |
|---|---|---|---|
| **D** 🔴 | **Redis (Upstash)** : adapter Socket.io + `RedisRateLimitStore` (déjà écrit, à brancher) + quota LLM Free | **avant la 2ᵉ instance** | 1 j |
| E | Migrer les data-URI d'avatars déjà en base vers R2 — code et variables en place | ~500 utilisateurs avec avatar | 2 h |
| Q | 2ᵉ instance Railway + sticky sessions | CPU > ~70 % en régime | 4 h |
| 7 bis | **Décider** : scale-to-zero Neon **ou** compute permanent assumé. Aujourd'hui : le coût des deux, le bénéfice d'aucun | hors-saison NHL | 2 h |
| U | RAM du service ML : 2 workers uvicorn à ~300-500 Mo RSS chacun ne tiennent pas dans 512 Mo | avant le premier pic réel | 15 min |
| I | TanStack Query côté client — `fetch` brut partout, aucune déduplication | quand la facture Railway devient visible | 2 j |
| R | `apiLimiter` : clé par `userId` quand authentifié, IP en repli (NAT mobile) | premiers signalements de 429 | 2 h |
| S | `fetchGamesRange` : clé de cache sur semaines calendaires | prolifération de clés dans `/api/dev/metrics` | 2 h |
| T | Cache de prompts LLM identiques | quand l'usage LLM devient significatif | 4 h |
| V | Échantillonner les logs 2xx | à la première facture de logs | 1 h |
| W | Purge Tailwind — le CSS pèse 124 ko (le JS est déjà découpé par route) | — | 2 h |

**Écarté sciemment** — décision produit, pas oubli : Redis tant qu'il n'y a
qu'une instance, et les TTL différenciés Tennis (ligne O).

**Non traité, repéré ligne X :** les **4 `fetch` bruts vers `STATS_BASE`**
(classements, sommaires de saison) contournent `fetchNHL` et restent **sans
timeout**. Ils n'étaient pas exercés par S1. À faire si un tir les met en cause.

**Amélioration optionnelle, repérée RES-2 :** servir le **cache d'odds périmé**
plutôt que `[]` pendant une panne de The Odds API — évite un écran sans cotes.

---

## 4. QA — campagnes à exécuter

Source : `QA_TEST_PLAN.md`, qui garde le détail (résultat attendu, notes, pièges).
Sécurité et résilience sont **validées en statique** ; ce qui reste est dynamique.

**Fonctionnel** — F1 auth complète · F2 gating Pro bout en bout · F3 slip +
settlement · F4 prédictions NHL du jour · F5 Best Bets / value bet scan ·
F6 récupération de mot de passe · F7 tennis

**Intégration** — I1 chaîne ML Front→Node→FastAPI · I2 CORS + cookie cross-site ·
I3 webhook Stripe idempotent · I4 Google OAuth · I5 socket.io · I6 pipeline
données externes → features

**Performance** — P1 charge sur l'endpoint ML (définir le p95 accepté) ·
P2 cache et quotas externes · P4 Lighthouse mobile · P5 pool Postgres
(**vérifier d'abord que `DATABASE_URL` pointe sur `-pooler`**, sinon le test
échoue pour la mauvaise raison) · P3 rate limiting en multi-instance

**Compatibilité** — C1 mobile iOS/Android · C4 pages SEO statiques sur crawlers ·
C2 cross-navigateur desktop · C3 push web

**Vérifications dynamiques de sécurité** (le statique est passé) — test IDOR à
2 comptes · JWT expiré/altéré rejeté et refresh non rejouable après logout ·
en-têtes **CSP réellement servis par Vercel** (l'API n'y peut rien, c'est le front)

**Tests de résilience à provoquer** — couper le ML · couper The Odds API et
retirer `scratches.json` · redeploy Railway sous trafic · webhook Stripe rejoué

**Reprise** — exécuter un **vrai test de restauration** de la base (`BACKUP_DR.md`
existe, il n'a jamais été joué) et **documenter + tester une fois** le rollback
Railway/Vercel.

---

## 5. Décisions en attente

Petites, mais chacune bloque un nettoyage.

1. **`ml/data/raw/odds/download_dataset.py` et `build_dataset_extra.py`.** Ils
   produisent `nhl_data_extensive.csv`, dont les colonnes de paris sont
   **factices** (chaque match 2004-2018 : `favorite_moneyline -105`,
   `over_under 5.5`, `spread -1.5`). Leur lecteur a été supprimé (S5). Les garder
   comme scraper ESPN de stats de match est défendable ; les garder **dans le
   dossier que le fetcher lisait** ne l'est pas. → déplacer ou supprimer.
2. **Plafond d'usage par code promo** (SEC-6). Sans table `promo_redemptions`
   (`max_uses` / `expires_at`), un code volontairement partagé reste utilisable
   par plusieurs comptes. Acceptable pour des codes de lancement contrôlés ;
   à border si les codes deviennent individuels. → changement de schéma.
3. **`ml/models/score_ensemble/`** — 20 membres, 8.9 Mo. Déjà hors de l'image
   Docker (S1), mais toujours dans Git. Les en sortir
   (`git rm -r --cached`) est une décision à part, pas faite.
4. **Purge de l'historique Git** pour le mot de passe DB (CFG-4). Il s'agit d'une
   base **locale** — sans valeur pour un attaquant — donc la purge reste
   optionnelle. À trancher une fois pour ne plus y revenir.
5. **Dépendances npm devenues inutilisées** — cf. section suivante.

---

## 6. Ménage du 2026-08-10 — ce qui a été fait, ce qu'il te reste

### Supprimé du code (0 importeur, prouvé par analyse transitive)

**Le kit `client/src/app/components/ui/` en entier — 49 fichiers.** C'était un
dump shadcn/ui complet dont **rien dans l'application n'importait quoi que ce
soit** : les seuls importeurs des composants `ui/*` étaient d'autres fichiers
`ui/*`. Aucune occurrence de `@/components` dans tout le client.

**7 fichiers de code projet :**

| Fichier | Pourquoi mort |
|---|---|
| `services/affiliateService.ts` | Remplacé par `services/bookmakers.ts` (multi-book Bet365 + Stake, codes affiliés par book) |
| `pages/TennisPredictionsPage.tsx` · `pages/TennisPlayerPage.tsx` | 0 route, 0 importeur. **Attention : le tennis n'est pas mort** — `TennisStatsPage` reste rendu par `StatsPage` via le toggle de sport. Seules les deux pages de *prédiction* tennis étaient orphelines. |
| `data/hockeyProps.ts` | Module vide de 10 lignes. Les props joueur et futures sont générés dynamiquement depuis `/api/nhl/players` et `/api/nhl/standings` |
| `components/RulesWeightsCard.tsx` | 151 lignes, jamais montées |
| `components/brand/IceBackground.tsx` | 132 lignes, jamais montées |
| `components/ui/Balatro.jsx` | 127 lignes + `Balatro.css`, jamais montées |

**Gardé délibérément :** `server/src/middleware/redisRateLimitStore.ts`. Il
apparaît orphelin, mais c'est le stub prévu pour la ligne D — le brancher est
« une ligne par limiteur » précisément parce qu'il existe déjà.

### ⚠️ À faire chez toi, dans cet ordre

1. **`cd client && npm run build`.** L'analyse est statique et le sandbox ne peut
   pas compiler. Si un import dynamique construit par concaténation référençait un
   de ces fichiers, seul le build le dira.
2. **Retirer les dépendances devenues inutilisées** de `client/package.json`, puis
   `npm install` pour régénérer le lockfile. Je ne l'ai pas fait : je ne peux pas
   valider un lockfile ici.

   Devenues inutilisées : les **26 `@radix-ui/react-*`**, plus
   `class-variance-authority`, `cmdk`, `embla-carousel-react`, `input-otp`,
   `react-day-picker`, `react-hook-form`, `react-resizable-panels`, `vaul`.

   **À garder absolument** — utilisées par du vrai code applicatif :
   `sonner` (`App.tsx`, `ProfilePage`, `RoomList`, `CreateRoomModal`,
   `InjuriesAdminCard`, `RuleFactorEditor`) et `recharts` (`ChartPage.tsx`).

3. Si tu veux réintroduire un composant shadcn plus tard :
   `npx shadcn@latest add <nom>`. Rien n'est perdu.

### Documentation corrigée au passage

- `DEPLOYMENT.md` §4 : la **valeur littérale de `VITE_ODDS_API_KEY`** a été
  remplacée par un placeholder, avec la note expliquant pourquoi `VITE_*` est
  public par construction et pourquoi le proxy serveur existe.
  **Si cette clé était réelle et que le dépôt a circulé : la révoquer et la
  régénérer.**
- `DEPLOYMENT.md` §7 : la procédure disait « courriel + bandeau in-app » alors
  que la décision du 2026-08-09 est **courriel uniquement**. Corrigé, et la
  commande `npm run notify:slips` ajoutée.
- Les en-têtes de `content_insights.py` et `content_insights_team_player.py`
  citaient `totals_model.json`, supprimé par S2. Remplacé par `score_model.json`.

### Constaté au passage : deux cases de `REFACTOR_PLAN.md` étaient déjà faites

`ml/models/totals_model.json` et `feature_importance_totals.json` **n'existent
plus** sur le disque. La case S2 « sur ta machine » peut être cochée.

---

## 7. Audit de production : soldé

`PRODUCTION_READINESS_AUDIT.md` (2026-07-20) est conservé comme trace, mais
**toutes ses recommandations sont traitées**. Vérifié dans le code aujourd'hui pour
les quatre qui restaient ambiguës :

- **H8** (hacher les refresh tokens) → fait, `auth.service.ts` les stocke hachés
- **M2** (registre de migrations) → fait, `migrate-all.ts` tient `schema_migrations`,
  une transaction par fichier
- **M4** (transactions multi-écritures) → fait, `auth.service.ts` ouvre
  `BEGIN`/`COMMIT` et les helpers acceptent le client de l'appelant
- **M7** (index composite chat) → fait, migration `019_chat_pagination_index.sql`
  crée `(room_id, sent_at DESC)`
- **M1** (code splitting) → fait, le JS est découpé par route ; reste le CSS
  Tailwind (ligne W ci-dessus)

Seul survivant, et il est déjà dans ce document : **M6 / la CSP réellement servie
par Vercel** (§4), et la question de la purge d'historique Git (§5.4).
