# ARAKICE / ICEEDGE — Ce qui reste

**Créé le 2026-08-10 · mis à jour le 2026-08-23.**

> **Reprendre ici.** Une seule décision est en attente côté ML : **payer ou non
> un mois de The Odds API (59 $)**. Le calcul complet, avec les arguments des
> deux côtés, est en **§2**. Indépendamment de cette décision, la mise en
> service de la collecte live a une échéance réelle — **la pré-saison NHL, fin
> septembre**.

Ce document regroupe **tout ce qui n'est pas fait**, tiré
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
| **B0** | ⚠️ `cd client && npm install && npm run build` | local | **42 dépendances ont été retirées de `package.json` le 2026-08-10** — le `package-lock.json` n'est plus en phase. Le build validé plus tôt l'a été *avant* cette coupe : il ne prouve plus rien. À refaire en premier. |
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

## 2. ML — où reprendre

**Une seule décision est en attente, et elle commande tout le reste : payer ou
non un mois de The Odds API.** Le calcul est plus bas, avec les arguments des
deux côtés.

### L'état en une table

| Poste | État |
|---|---|
| **A5** — élaguer les features du modèle de score | ✅ **Clos.** Non tranchable avec 14 saisons. Conclusion en tête de `train_score.py`. **Ne pas recommencer.** |
| **A3** — outillage CLV | ✅ **Livré.** Mode `--clv` avec placebo, dissection et « ROI clôture ». Table `odds_snapshots` (migration 031). Backfill historique corrigé. |
| **A3** — mesure moneyline et totaux | ✅ **Faite le 2026-08-23.** Résultats ci-dessous. |
| **A3** — mesure puck line | ⛔ **Impossible sur l'historique** : SBRO ne donne qu'un prix de puck line par match, pas de paire ouverture/clôture. |
| **A1** — backfill payant | ⏸️ **En attente de ta décision.** Le code est prêt et borné. |
| **A1bis** — collecte live gratuite | ⏸️ **Codée, jamais activée.** Migrations 028 + 031 à appliquer, `ODDS_LOG_ENABLED=true` en prod. **Échéance : la pré-saison, fin septembre.** |
| **A2** — règle puck line | ⏸️ Figée et falsifiable, non évaluable avant l'un des deux postes ci-dessus. |
| **S4** — servir le moneyline depuis le modèle de score | ⏸️ Conçu, code non commencé. **Plus bloqué par A5** : le jeu de features est figé. |
| **A4** — fenêtre de confirmation du gardien | ⏸️ Demande des snapshots serrés autour du coup d'envoi. |
| **A6** — team totals, prolongation, écarts ±2.5 | ⏸️ Après A1 et A2. |

---

### Ce que la mesure du 2026-08-23 a établi

Neuf saisons, 19 644 paris moneyline et 19 638 paris totaux aux **prix
d'ouverture**, chacun comparé à ce que la clôture en disait.

| edge ≥ | paris | ROI réalisé | ROI selon la clôture | écart | CLV net du placebo |
|---|---|---|---|---|---|
| 1 % | 8 103 | −1,13 % | −1,78 % | +0,52 σ | +0,0083 |
| 2 % | 6 475 | −0,93 % | −1,30 % | +0,25 σ | +0,0101 |
| 3 % | 4 988 | +2,11 % | −0,85 % | +1,76 σ | +0,0115 |
| **4 %** | 3 751 | **+4,30 %** | **−0,25 %** | +2,28 σ | **+0,0133** |
| 5 % | 2 760 | +4,30 % | **+0,44 %** | +1,61 σ | +0,0151 |

**Trois conclusions, dans l'ordre de solidité.**

**1. Le CLV moneyline est réel.** Le placebo — modèle permuté entre les matchs,
même sélection, même effectif — ne décroche que **+0,0002**. Le signal n'est
donc pas de la régression vers la moyenne : le modèle prend bien des prix que le
marché déplace ensuite dans son sens.

**2. Et il suffit tout juste à annuler la marge, pas à gagner.** C'est la
colonne « ROI selon la clôture », et c'est le vrai résultat de ce run : elle
monte de −1,78 % à **+0,44 %** avec le seuil d'edge. Autrement dit, aux edges
élevés, le modèle trouve des ouvertures que la clôture juge **à peu près
équitables après la marge de 4,43 %** — pas rentables. P1 disait « on ne bat pas
la clôture » ; on peut préciser : **on bat l'ouverture d'environ une marge**.

**3. Le +4,30 % réalisé est probablement de la chance.** Il dépasse de 1,6 à
2,3 σ ce que la clôture justifie. La dissection le montre sans ambiguïté : par
tercile d'edge le ROI fait **1,60 % / 0,36 % / 10,93 %** — l'edge ne trie pas le
rendement, tout est dans le tercile supérieur ; le taux de réussite n'est que de
45,7 %, donc le gain vient de **cotes longues qui sont tombées** ; et retirer
44 paris sur 3 751 (1,2 %) annule le résultat.

> **Les totaux sont morts pour de bon.** Leur CLV net est **inférieur à leur
> propre placebo** à tous les seuils (+0,0020 contre +0,0030) : ce qu'on y voyait
> était entièrement de la régression vers la moyenne. Et la clôture leur donne
> −3,2 % constant. Le placebo a payé son billet ici.

---

### La décision : payer 59 $ un mois, ou non

**L'argument, en un calcul.** C'est le bloc que le mode imprime lui-même :

```
écart-type du rendement par pari : 1,1542
écart-type du CLV par pari       : 0,0317
paris pour détecter 2 % de ROI   : ~13 321
paris pour détecter 0,5 % de CLV : ~160        → rapport 83×
```

Le CLV converge **83 fois plus vite** que le ROI. Mais — et c'est tout le
problème — **le CLV de la puck line n'est pas mesurable sur les données
actuelles**, faute de paire ouverture/clôture chez SBRO. Le levier existe et on
ne peut pas l'appliquer là où il servirait.

Or la règle A2 produit **463 paris sur 9 saisons, soit ~51 par saison** sur la
jambe −1.5. D'où l'arithmétique qui décide :

| Chemin | Paris disponibles | Verdict CLV possible en |
|---|---|---|
| **Backfill payant** (2023-24 → 2025-26) | ~154 | **une semaine** |
| Collecte live seule (démarre en octobre) | ~51/an | **~2029** |

**Un mois à 59 $ achète précisément l'échantillon qui rend la règle A2
décidable** — ~154 paris contre les ~160 nécessaires — et il le fait maintenant
au lieu de 2029. C'est la seule chose que cet argent achète et qu'on ne peut pas
obtenir autrement : l'archive SBRO est close, le site est injoignable, et
l'endpoint historique n'est pas servi aux clés gratuites.

**Ce que le mois donne aussi, sans coût supplémentaire :**

- **~3 900 matchs vraiment hors échantillon** (2023-24 → 2025-26) pour confirmer
  ou tuer le résultat moneyline ci-dessus. Il n'existe aujourd'hui **aucune**
  donnée que le modèle n'ait pas vue : SBRO s'arrête au 2022-11-27.
- **+30 % de volume sur A2 lui-même**, en ROI cette fois, pas seulement en CLV.
- **A4 devient mesurable** : les snapshots à 5 minutes permettent de voir la
  ligne bouger autour de la confirmation du gardien.
- Un jeu de données qui **reste sur ton disque après résiliation** — le cache
  rend toute reprise gratuite.

**Les arguments contre, et ils sont sérieux :**

- **Le résultat moneyline ci-dessus est un avant-goût du verdict probable.** Si
  la puck line se comporte pareil — CLV réel mais qui annule tout juste la marge
  — le mois achète un **résultat négatif**. Utile pour arrêter de chercher, pas
  pour gagner de l'argent.
- **Les ~160 paris sont une estimation empruntée au moneyline** (écart-type du
  CLV 0,0317). Celui de la puck line est inconnu et pourrait être plus grand,
  auquel cas 154 paris ne suffiraient pas.
- **La collecte live est gratuite** et démarre dans cinq semaines. L'attente
  coûte du temps, pas de l'argent.
- Rien n'est urgent : **on n'est pas en train de perdre des données** en août,
  la NHL est inactive.

**Ce qui n'est PAS un argument pour payer** : espérer que les saisons neuves
fassent réapparaître le +4,30 %. La dissection dit qu'il tient à 44 paris et que
l'edge n'y trie pas le rendement. S'il revient, ce sera une surprise, pas
l'attendu.

> **En une phrase :** 59 $ compriment une attente de trois ans en une semaine,
> sur la seule piste encore vivante du projet — et le résultat le plus probable
> est un « non » propre plutôt qu'un « oui ».

---

### Reprendre : les commandes

Tout ce qui suit tourne sur ta machine (xgboost et `node_modules` sont
Windows-only pour ce dépôt).

```bash
cd ml/python

# Gratuit — chiffre le backfill sans dépenser ni clé
python fetch_data_v4.py --only odds --odds-api-dry-run \
    --odds-api-from 2023-10-01 --odds-api-to 2026-06-30

# Si tu paies — dans l'ordre, et JAMAIS sans --from-local ni --only odds
#   1. la clé, pour cette fenêtre seulement (cmd.exe) :
#      for /f "tokens=1,* delims==" %a in ('findstr /b "ODDS_API_KEY=" ..\..\server\.env') do set ODDS_API_KEY=%b
#   2. ~300 crédits : comparer SBRO et l'API sur une plage couverte par les deux
python fetch_data_v4.py --only odds --from-local --odds-api-budget 300 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2021-11-01 --odds-api-to 2021-11-10
#   3. le backfill, plafond dur posé
#   4. python build_dataset.py, puis --clv et --derived sur des saisons neuves
#   5. résilier
```

> ⚠️ **`odds.csv` est irremplaçable et réécrit à chaque exécution.** Il a été
> détruit une fois le 2026-08-23 (commande sans `--from-local` : SBRO échoue en
> réseau, et 17 lignes du log live ont suffi à écraser 10 591). Récupéré depuis
> les pages HTML de `ml/data/raw/odds/`. Un garde-fou refuse désormais toute
> écriture qui ferait perdre plus de 10 % des lignes, et `odds.csv.backup-2026-08-23`
> est posé à côté. **Toujours `--only odds --from-local`.**

**Cohérence de source à ne pas casser :** le collecteur live utilise
`regions: eu` et préfère Bet365. Le backfill doit utiliser les mêmes
(`--odds-api-regions eu --odds-api-book bet365`), sinon on recrée le mélange de
sources que la comparaison est censée détecter. Le défaut du script est `us`.

---

### Ce qui reste, poste par poste

**A1bis — mise en service de la collecte live** (indépendant de la décision de
payer, et à faire de toute façon) :

- [ ] Migrations **028 et 031** : `npm run db:migrate:all`, puis `npm test`
- [ ] Railway : `ODDS_LOG_ENABLED=true` et `ODDS_USER_RESERVE`
- [ ] Optionnel, le temps d'un déploiement : `ODDS_LOG_RUN_AT_BOOT=true` pour
      voir une passe complète dans les logs, **puis le retirer** (3 crédits par
      démarrage)

Le calendrier posé coûte **10 crédits/jour, 300/mois** — deux passes complètes
(11 h, 17 h ET) et quatre passes `spreads` seules (18 h 45, 19 h 45, 21 h 45,
22 h 45 ET), sous les 350 disponibles pour la première fois.

**A2 — puck line :** la règle est figée (miser la jambe qui **donne** les
1.5 buts quand `p_modèle − p_marché ≥ 0.04`, mise à plat, critère **ROI > 0** et
non « ≈ 20 % »). **Ne rien miser d'ici là** — « non réfuté » n'est pas
« établi ».

**S4 — servir le moneyline depuis le modèle de score.** Conception faite, code
non commencé, plus bloqué par A5.

- [ ] Blend `score ⊕ marché` dans `train_score.py`, poids dans `score_report.json`
- [ ] Décomposition λ pour `feature_importances` (`pred_contribs`, 7 groupes)
- [ ] `confidence` depuis |λ_dom − λ_ext|, calibrée sur la distribution actuelle
- [ ] `base_prob = dist.p_home_win()` pour les marchés non dérivables
      (`last_team_score`, `period{1,2,3}_winner`, `winning_margin`, `double_chance`)
- [ ] Puis suppression du classifieur, **route par route**

> Le piège de S4 : le blend marché est **vivant** (`featureEngineering.ts:238`
> passe les cotes). Supprimer le classifieur supprimerait le blend, et P1 a
> mesuré le marché seul meilleur que les deux modèles nus. D'où le réajustement
> plutôt que la perte.

**A4 — fenêtre de confirmation du gardien.** Mesure préalable, pas une
stratégie : elle dit s'il y a lieu de construire.

- [ ] Extraire la trajectoire des lignes autour de l'heure de confirmation

**A6 — team totals, prolongation, écarts ±2.5.** Priçables par `score_model.py`,
jamais confrontés à des prix réels. Après A1 et A2.


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

## 5. Décisions — toutes tranchées

**Purge de l'historique Git : abandonnée (2026-08-10).** Le mot de passe présent
dans l'historique est celui d'une base **locale**, sans valeur pour un attaquant.
Point clos, ne pas le rouvrir. Le scanner gitleaks du CI empêche qu'un vrai secret
y entre à l'avenir.

### 🐛 Trouvé pendant le ménage : la synchro des poids de règles n'est pas câblée

Ce n'est pas du code mort, c'est une fonctionnalité **à moitié construite** — et
c'est pour ça que `applyServerFamilyWeights` a été gardée alors qu'elle n'a aucun
appelant.

Le serveur a tout : colonne `user_profiles.rule_weights` (migration **017**), lue
en `ruleWeights` par `profile.service.ts` et écrivable via `PATCH /api/profile`.
Côté client, `RuleFactorEditor` n'écrit que dans `localStorage` et **rien ne lit
jamais la valeur du compte**. Conséquence : les poids ne suivent pas l'utilisateur
d'un appareil à l'autre, alors que la base les stocke.

- [ ] Appeler `applyServerFamilyWeights(profile.ruleWeights)` au chargement du profil
- [ ] Pousser le store vers `PATCH /api/profile` quand `RuleFactorEditor` sauvegarde

### Codes promo — tranché le 2026-08-10 : pas de changement de schéma

Les codes sont **réservés au lancement** et doivent cesser de fonctionner ensuite.
Le mécanisme existant suffit : `promoCatalog()` (`subscription.service.ts`) lit
`PRO_PROMO_CODES` et, si la variable est absente **en production**, le catalogue
est vide — tout code est rejeté en 400, avec un `logger.warn`.

**Retirer les codes = vider `PRO_PROMO_CODES` sur Railway et redéployer.** Rien à
coder, pas de table `promo_redemptions`.

> Ce qu'il faut accepter en attendant : tant que la variable porte un code, il
> reste utilisable par **plusieurs comptes** — il n'y a pas de plafond d'usage.
> C'est sans conséquence pour des codes de lancement distribués sciemment ; ça ne
> le serait plus si les codes devenaient individuels. Le jour où ça change, il
> faudra la table (`max_uses` / `expires_at`), et ce sera un changement de schéma.

- [ ] **Après le lancement :** vider `PRO_PROMO_CODES` sur Railway, redéployer,
      et vérifier qu'un ancien code renvoie bien 400.

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

### `package.json` — 42 dépendances sur 50 retirées

Chaque dépendance a été testée individuellement contre le code survivant
(`src/`, `scripts/`, `index.html`, `vite.config`). Après la coupe : **8 restantes,
0 inutilisée**.

**Gardées, chacune avec un consommateur réel :** `@sentry/react`, `html-to-image`,
`lucide-react`, `react-router`, `recharts` (`ChartPage`), `socket.io-client`,
`sonner` (`App.tsx`, `ProfilePage`, `RoomList`, `CreateRoomModal`,
`InjuriesAdminCard`, `RuleFactorEditor`), `tw-animate-css`.

**Retirées :** les 26 `@radix-ui/react-*`, `class-variance-authority`, `clsx`,
`cmdk`, `date-fns`, `embla-carousel-react`, `input-otp`, `motion`, `next-themes`,
`react-day-picker`, `react-hook-form`, `react-popper`, `@popperjs/core`,
`react-resizable-panels`, `react-responsive-masonry`, `tailwind-merge`, `vaul`.

> `motion` méritait une vérification à part vu les animations de l'app : la seule
> occurrence dans le dépôt était un **commentaire** de `routes.tsx`. `clsx` et
> `tailwind-merge` ne servaient qu'au helper `cn` de `ui/utils.ts`, parti avec le
> kit.

**→ `npm install` obligatoire** pour resynchroniser le lockfile (ligne B0 du §1).
Je ne l'ai pas lancé : `node_modules` a été installé sous Windows et le sandbox
n'aurait pas produit un lockfile valide pour ta machine.

Pour réintroduire un composant shadcn plus tard : `npx shadcn@latest add <nom>`.
Rien n'est perdu.

### Exports morts : 15 supprimés, 5 gardés exprès

Le premier scan en annonçait 108 — il n'incluait pas `server/scripts/` parmi les
consommateurs, donc il proposait de supprimer des fonctions dont dépendent les
commandes npm (`notify:slips`, `odds:export`). Corrigé, il en restait 19.

**Supprimés (15) :** `TENNIS_CATEGORY_LABELS`, `TENNIS_CATEGORY_ICONS`,
`getTennisMarketsByCategory`, `lastNGamesOptions`, `probToOdds`, `getLLMUsage`,
`decimalToWinPct`, `fetchAvailableSports`, `sendToUser`, et l'ancien modèle de
poids à six facteurs de `ruleWeightsService` (`WEIGHT_META`, `FACTOR_COLORS`,
`getWeights`, `isCustom`, `applyServerWeights` + leurs dépendances privées).

> Deux suppressions valent mieux qu'un simple gain de lignes : `probToOdds` était
> un **doublon exact** de `probToOddsLabel` (privée, dans `predictionApiService`),
> et `decimalToWinPct` inversait une cote isolée là où `HockeyLanding` dévigue la
> paire. Deux conversions concurrentes finissent toujours par diverger.

**Gardés (5), avec un commentaire disant pourquoi :** `clearBestBetsCache`,
`clearLeaderboardCache`, `stopOddsLogger`, `snapshot` (oddsQuota) — les points
d'entrée dont un test d'intégration a besoin — et `applyServerFamilyWeights`
(cf. le bug ci-dessus).

### Découpage des fichiers > 500 lignes — en cours

Méthode : **extraction de plages de lignes par script**, jamais à la main. Le
corps du code est identique à l'original ; seuls les imports et les `export` sont
ajoutés. Trois contrôles automatiques à chaque fichier : syntaxe, résolution de
chaque import interne, et **comparaison des multiensembles de lignes avant/après**
(c'est celui qui prouve qu'aucune ligne n'a été perdue ni altérée). Un détecteur
d'imports circulaires a été ajouté après le premier faux positif.

| Fichier | Avant | Après | Plus gros morceau | Build |
|---|---|---|---|---|
| `ChartPage.tsx` | 3106 | 11 fichiers (`pages/charts/`) | `GameCharts.tsx` 457 | ✅ vert |
| `PredictionPage.tsx` | 2367 | 10 fichiers (`pages/prediction/`) | `PredictionSheet.tsx` 491 | ✅ vert |
| `HockeyLanding.tsx` | 1468 | 5 fichiers (`pages/landing/`) | `LandingCards.tsx` 471 | ✅ vert |
| `ProfilePage.tsx` | 866 | 3 fichiers (`pages/profile/`) | `SettingsTab.tsx` 509 | ✅ vert |
| `BetBuilderPage.tsx` | 739 | 3 fichiers (`pages/bet/`) | `MySlipsTab.tsx` 288 | ⏳ à builder |

Dans les cinq cas le fichier d'origine ne garde que l'aiguillage et **reste le
seul export public** — `routes.tsx` est inchangé. **8 546 lignes réparties, zéro
ligne perdue** (vérifié fichier par fichier).

> Trois pièges rencontrés, tous attrapés par les contrôles et aucun par la
> relecture : le script a d'abord écrasé son propre fichier source (depuis, il lit
> une copie) ; l'extraction d'identifiants attrapait les noms **cités dans les
> commentaires**, fabriquant des imports circulaires imaginaires (elle passe
> désormais par l'AST) ; et les imports **à effet de bord** (`import "x.css"`)
> n'ayant aucun binding, ils étaient silencieusement supprimés — la page aurait
> perdu ses styles sans qu'aucun test ne bronche. Le script les réinjecte dans la
> coquille et refuse de tourner s'il en trouve un sans coquille désignée.

#### Ce qui dépasse encore 500 lignes — et pourquoi je m'y suis arrêté

| Fichier | Lignes | Pourquoi ce n'est pas un découpage mécanique |
|---|---|---|
| `i18n/index.tsx` | 855 | Dictionnaire de traductions. Le découper par domaine est faisable mais c'est du rangement, pas de la structure. |
| `data/betMarkets.ts` | 628 | Table de données. Même remarque. |
| `pages/NHLPredictionsPage.tsx` | 589 | Jamais analysé — candidat sérieux pour la suite. |
| `pages/TennisStatsPage.tsx` | 578 | Idem, mais le tennis est en périmètre réduit : à faire seulement si on le garde. |
| `components/MLPredictionCard.tsx` | 541 | Idem. |
| `components/MarketSelectorSheet.tsx` | 519 | Idem. |
| `profile/SettingsTab.tsx` | 509 | **453 lignes de code réel.** Un seul composant portant ~20 `useState` partagés par toutes ses sections. Les séparer = faire descendre ces états en props, donc un vrai refactoring — à faire avec le navigateur ouvert, pas à l'aveugle. |

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
- `client/ATTRIBUTIONS.md` : l'attribution shadcn/ui a été retirée — le kit ne
  fait plus partie du produit. La ligne à remettre en cas de réintroduction est
  gardée en commentaire dans le fichier.
- `routes.tsx` : le commentaire M1 citait `motion` et `ogl` comme libs lourdes
  découpées par route. Ni l'une ni l'autre n'est plus une dépendance.

### Côté ML

- **`ml/data/raw/odds/download_dataset.py` et `build_dataset_extra.py` supprimés.**
  Ils produisaient `nhl_data_extensive.csv`, dont les colonnes de paris sont
  factices (chaque match 2004-2018 : `favorite_moneyline -105`, `over_under 5.5`,
  `spread -1.5`), et leur lecteur avait déjà disparu avec S5.
- **`ml/models/score_ensemble/` sorti du dépôt** (`git rm -r --cached`) et ajouté
  à `.gitignore` — 8.9 Mo. **Les 20 membres restent sur ton disque**, et
  `ml_service.py` les chargera si le dossier est là : le chargement était déjà
  entièrement facultatif, et l'image Docker les excluait depuis S1. Régénérables
  par `python train_score.py --ensemble 20`.
- **Deux cases de `REFACTOR_PLAN.md` étaient déjà faites :**
  `ml/models/totals_model.json` et `feature_importance_totals.json` n'existent
  plus sur le disque. La case S2 « sur ta machine » peut être cochée.

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
