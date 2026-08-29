# ARAKICE / ICEEDGE — Ce qui reste

**Créé le 2026-08-10 · mis à jour le 2026-08-29.**

> **Reprendre ici.** Décidé le 2026-08-24 : **mettre d'abord la collecte live en
> service** (A1bis, gratuit, échéance réelle à la pré-saison de fin septembre).
> La décision des **59 $** de backfill The Odds API reste ouverte et n'est pas
> urgente — le calcul complet, avec les arguments des deux côtés, est en **§2**.

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
| B3 | Tir de charge **S1 de validation** : `NHL_USE_MOCK=true` vérifié dans les logs de démarrage, 50 VUs | préprod | Les deux premiers tirs ont mesuré une API NHL morte. Un critère vert peut vouloir dire que le code n'a pas tourné. `AUDIT_SCALABILITE_COUTS.md` §5. |
| B4 | Parcours critiques **F1, F2, I1, I2** en staging | staging | Auth complète, gating Pro, chaîne ML, CORS+cookie cross-site. `QA_TEST_PLAN.md` §1-2. |
| B5 | **C1** — parcours mobile iOS Safari (login → prédiction → paiement) | appareil réel | Safari iOS est la source n°1 de bugs cookies/`SameSite`/PWA. |
| B6 | Poser les **alertes de budget** dans les consoles (Railway, Neon, Odds, LLM, Stripe, Sentry, R2) | consoles | Seuils déjà documentés dans `MONITORING.md`. Hard limits là où ils existent. |
| B7 | Définir `SENTRY_DSN` sur le service **ML** Railway | console | Variable propre à ce service ; le code est prêt et no-op sans elle. |
| B8 | Confirmer la présence de **toutes** les variables d'env dans Railway/Vercel | consoles | Les `.env.example` sont complets ; leur miroir en prod ne l'est pas vérifié. |

### B9 — clos le 2026-08-29 : la couche de mocks est supprimée

L'audit avait trouvé pire que « une cote factice » : `predictionApiService.ts`
retombait, sur **toute** défaillance (base non configurée, réseau, 500, service ML
éteint), sur `buildMockPrediction` / `buildMockPlayerProp` / `buildMockFutures`.
`estimateProbability` y tenait des taux de victoire **écrits en dur**
(`bos: 68, nyr: 61, col: 66…`) et des taux de but par joueur indexés sur de vrais
`playerId` ; `probToOddsLabel()` en dérivait une cote américaine complète affichée
sous le libellé « Cote ». Deux autres nombres inventés se cachaient aux appelants :
`GamePrediction` avait un `.catch(() => ({ probability: 55 }))`, et le parlay se
repliait sur une multiplication naïve corrigée d'un facteur 0,95 arbitraire.

**Ce qui a été fait.** Tout le repli local est supprimé — six fonctions et deux
tables de constantes. Le service lève désormais un seul type d'erreur,
`PredictionUnavailableError`, qui porte la cause (`not_configured`, `network`,
`http`, `bad_response`) pour que l'UI dise quelque chose de vrai. Chaque point
d'appel a été traité :

| Où | Comportement en panne |
|---|---|
| `landingTypes` / `LandingCards` | `winPct` et `totalPct` deviennent `number \| null` → « — » à l'écran, edge neutralisé, ajout rapide au coupon désactivé |
| `GamePrediction` | bandeau d'indisponibilité ; les marchés **dérivés du modèle** ne sont plus construits, seuls ceux du moteur de règles (backend) restent |
| `MarketSelectorSheet` | **refuse d'ajouter la jambe** et l'explique — une jambe porte sa probabilité jusqu'au règlement, un chiffre inventé y survivrait à la panne qui l'a produit |
| `BetContext` / `BetBuilderPage` / `betParts` | `combinedProbability` devient `number \| null` → « — », pas de cote implicite affichée |
| `PlayerPropPrediction` | état d'erreur explicite ; la ligne « Cote » n'apparaît **que** si le serveur en a envoyé une vraie (`oddsLabel` est devenu optionnel) |
| `PredictionSheet` | déjà correct — son `.catch` retombe sur `rulePct`, une vraie mesure du moteur de règles. Il recevait pourtant du mock jusqu'ici, puisque le service ne levait jamais : **supprimer les mocks l'a réparé sans le toucher.** |

Six clés i18n EN/FR ajoutées (`pred.unavailable*`). Trois exports morts sont partis
au passage — `getFactors`, `getFutures`, `getAvailableMarketsFor*` — dont un qui
référençait `PLAYER_MARKET_TYPES`, **une constante qui n'existe pas dans le
fichier** : l'appel aurait jeté un `ReferenceError`, et seul le fait qu'il était
mort l'a caché.

**Vérifié** : `vite build` vert (2 594 modules) et **zéro régression de type** —
mesuré en comparant `tsc --noEmit` en `strict` avant et après, erreur par
erreur. Le bundle principal perd 2,7 ko.

> ⚠️ **Correction d'une affirmation fausse du 2026-08-29.** Il a d'abord été
> écrit ici que le typecheck rendait « 0 erreur ». C'était un artefact : le
> `tsconfig` d'essai portait un `baseUrl`, que TypeScript 5.6 refuse avec
> l'erreur de configuration **TS5101** — et `tsc` s'arrête là, **sans rien
> vérifier**. Une sortie vide ne voulait pas dire « aucune erreur », mais
> « aucune vérification ». Le vrai chiffre de départ est **13 erreurs**, dont
> 3 refermées par le correctif B9 ; les 10 restantes sont listées au §6.

- [x] **Les trois derniers gisements de nombres inventés — supprimés le
      2026-08-29.** Ce n'étaient pas des replis de panne, donc ils avaient
      survécu au premier passage :
      **①** `generateForm()` fabriquait avec **`Math.random()`** une suite de
      W/L/OT, rendue sous le titre « Forme récente » avec sa légende — donc lue
      comme les vrais derniers résultats, et **différente à chaque
      rechargement**. Quatre pages l'affichaient. Aucune source ne donne
      aujourd'hui l'*ordre* des derniers résultats (`getTeamLastNGamesStats` ne
      rend que des totaux) : la fonction est supprimée et la carte ne s'affiche
      plus tant qu'on ne lui passe pas de vrais résultats.
      **②** `useNHLData` faisait `?? 50` sur `winPct`, `winPct1` et `winPct2` —
      un champ absent devenait « 50 % » à l'écran. Les trois sont désormais
      `number | null`.
      **③** `NHLPredictionsPage` remplaçait une probabilité manquante par
      `50 + (winPct saison − 50) × 0,8`, avec un `||` qui déclenchait aussi sur
      un vrai 0. Comme **tous** les marchés de la page en dérivent
      (`computeRulePrediction`), le match est maintenant simplement masqué.
      Deux blocs morts sont partis au passage : un `topPredictions` alimenté mais
      jamais rendu, qui portait un `trend: "+2%"` écrit en dur, et la branche
      « données statiques » de `GamePrediction`, morte depuis que `hockeyData`
      n'expose que des tableaux vides. `LastNGamesSection` n'invente plus de
      bilan W/L pour les N derniers matchs, et la pastille de cote équitable de
      `BestBetsSection` porte enfin une infobulle qui dit ce qu'elle est.

> **La règle, écrite en tête de `predictionApiService.ts` pour qu'elle survive :**
> pas de repli local, jamais. Un nombre faux qui a l'air juste est pire que pas de
> nombre — et une cote fabriquée à partir d'une probabilité l'est doublement,
> parce que rien à l'écran ne la distingue d'un prix de bookmaker.

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
| **A3** — outillage CLV | ✅ **Livré.** Mode `--clv` avec placebo, dissection et « ROI clôture ». Table `odds_snapshots` (migration 031). |
| **A3** — mesure moneyline et totaux | ✅ **Faite le 2026-08-23.** Résultats ci-dessous. |
| **A3** — mesure puck line | ⛔ **Impossible sur l'historique** : SBRO ne donne qu'un prix de puck line par match, pas de paire ouverture/clôture. |
| **A1bis** — collecte live gratuite | ✅ **En service depuis le 2026-08-29.** Migrations, variables et sondes posées et vérifiées. Reste **un seul contrôle**, à la pré-saison. |
| **S4** — servir le moneyline depuis le modèle de score | 🔸 **Livré et déployé**, sauf ⑤ (suppression du classifieur) et le correctif de calibration γ, tous deux reportés sciemment. |
| **A1** — backfill payant | ⏸️ **En attente de ta décision.** Le code est prêt et borné. |
| **A2** — règle puck line | ⏸️ Figée et falsifiable, non évaluable avant A1 ou une saison de collecte live. |
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

**Trois conclusions.** ① **Le CLV moneyline est réel** — le placebo (modèle
permuté, même sélection, même effectif) ne décroche que +0,0002. ② **Mais il
suffit tout juste à annuler la marge, pas à gagner** : la colonne « ROI selon la
clôture » monte de −1,78 % à +0,44 %, c'est-à-dire que le modèle trouve des
ouvertures que la clôture juge **à peu près équitables après la marge de
4,43 %**. On ne bat pas la clôture ; **on bat l'ouverture d'environ une marge.**
③ **Le +4,30 % réalisé est probablement de la chance** — 1,6 à 2,3 σ au-dessus
de ce que la clôture justifie, ROI par tercile d'edge à 1,60 / 0,36 / **10,93 %**
(l'edge ne trie pas le rendement), taux de réussite de 45,7 % seulement, et
retirer 44 paris sur 3 751 annule le résultat.

> **Les totaux sont morts pour de bon.** CLV net **inférieur à leur propre
> placebo** à tous les seuils (+0,0020 contre +0,0030) : c'était entièrement de
> la régression vers la moyenne. La clôture leur donne −3,2 % constant.

---

### La décision : payer 59 $ un mois, ou non

**L'argument, en un calcul** — le bloc que le mode imprime lui-même :

```
écart-type du rendement par pari : 1,1542
écart-type du CLV par pari       : 0,0317
paris pour détecter 2 % de ROI   : ~13 321
paris pour détecter 0,5 % de CLV : ~160        → rapport 83×
```

Le CLV converge **83 fois plus vite** que le ROI. Mais **le CLV de la puck line
n'est pas mesurable sur les données actuelles**, faute de paire
ouverture/clôture chez SBRO. Le levier existe et on ne peut pas l'appliquer là
où il servirait. Or la règle A2 produit **463 paris sur 9 saisons, ~51 par
saison** sur la jambe −1.5. D'où l'arithmétique qui décide :

| Chemin | Paris disponibles | Verdict CLV possible en |
|---|---|---|
| **Backfill payant** (2023-24 → 2025-26) | ~154 | **une semaine** |
| Collecte live seule (démarre en octobre) | ~51/an | **~2029** |

**Un mois à 59 $ achète précisément l'échantillon qui rend A2 décidable** — ~154
paris contre les ~160 nécessaires — maintenant au lieu de 2029. C'est la seule
chose que cet argent achète et qu'on ne peut pas obtenir autrement : l'archive
SBRO est close, le site injoignable, et l'endpoint historique n'est pas servi
aux clés gratuites.

**Ce que le mois donne aussi, sans coût supplémentaire :** ~3 900 matchs
vraiment hors échantillon (2023-24 → 2025-26) — il n'existe aujourd'hui
**aucune** donnée que le modèle n'ait pas vue, SBRO s'arrête au 2022-11-27 ;
+30 % de volume sur A2 en ROI ; **A4 devient mesurable** ; et un jeu de données
qui **reste sur ton disque après résiliation**. **Il débloque aussi le blend
marché**, aujourd'hui impossible à ajuster (voir l'encadré en fin de §2).

**Les arguments contre, et ils sont sérieux :**

- **Le résultat moneyline ci-dessus est un avant-goût du verdict probable.** Si
  la puck line se comporte pareil, le mois achète un **résultat négatif** —
  utile pour arrêter de chercher, pas pour gagner de l'argent.
- **Les ~160 paris sont une estimation empruntée au moneyline.** L'écart-type du
  CLV de la puck line est inconnu et pourrait être plus grand.
- **La collecte live est gratuite** et démarre dans cinq semaines. L'attente
  coûte du temps, pas de l'argent. Rien n'est urgent : on ne perd pas de données
  en août, la NHL est inactive.

**Ce qui n'est PAS un argument pour payer** : espérer que les saisons neuves
fassent réapparaître le +4,30 %. S'il revient, ce sera une surprise.

> **En une phrase :** 59 $ compriment une attente de trois ans en une semaine,
> sur la seule piste encore vivante du projet — et le résultat le plus probable
> est un « non » propre plutôt qu'un « oui ».

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

> ⚠️ **`odds.csv` est irremplaçable et réécrit à chaque exécution.** Détruit une
> fois le 2026-08-23 par une commande sans `--from-local` (SBRO échoue en
> réseau, 17 lignes du log live ont écrasé 10 591) ; récupéré depuis les pages
> HTML de `ml/data/raw/odds/`. Un garde-fou refuse désormais toute écriture qui
> ferait perdre plus de 10 % des lignes, et `odds.csv.backup-2026-08-23` est posé
> à côté. **Toujours `--only odds --from-local`.**

**Cohérence de source à ne pas casser :** le collecteur live utilise
`regions: eu` et préfère Bet365. Le backfill doit utiliser les mêmes
(`--odds-api-regions eu --odds-api-book bet365`), sinon on recrée le mélange de
sources que la comparaison est censée détecter. Le défaut du script est `us`.

---

### A1bis — en service. Un seul contrôle reste.

**Mise en service terminée le 2026-08-29.** Les migrations (dont 028 et 031) sont
appliquées sur **Neon** et vérifiées par rejoue idempotente ; `npm test` et
`npm run typecheck` sont verts ; `ODDS_LOG_ENABLED=true`, `ODDS_USER_RESERVE=150`,
`ODDS_QUOTA_WARN=100` et `ENABLE_DEV_ROUTES=true` sont posées sur Railway ; la
bannière `[OddsLogger] calendrier armé — slots: 6, creditsPerDay: 10` et la sonde
`[OddsLogger] ✅ odds_snapshots présente` ont été vues en prod. Le calendrier coûte
**10 crédits/jour, 300/mois** — deux passes complètes (11 h, 17 h ET) et quatre
passes `spreads` (18 h 45, 19 h 45, 21 h 45, 22 h 45 ET), sous les 350 disponibles.

**Où lire la mesure :** `https://arakice.com/dev/ml`, onglet **« Données »**, carte
**« Série temporelle des cotes (odds_snapshots) »**. **Par le dashboard, jamais par
l'URL de l'API** — les routes exigent un `Authorization: Bearer` qu'un onglet de
navigateur n'envoie pas. Compte **admin** obligatoire. Hors saison, 0 partout est
le succès ; le seul échec est la carte en « table indisponible ».

- [ ] **À la pré-saison, le seul contrôle qui compte** — *deux tâches planifiées
      posées le 2026-08-28 : le 22 septembre (pré-saison) et le 13 octobre (filet,
      saison régulière). Ne pas compter dessus seul : elles demandent le bloc
      `data-health`, elles ne le lisent pas à ta place.* Revenir sur `data-health`
      en fin de journée de matchs : `passes_today` doit valoir **6** et
      `with_puckline` être > 0. Si `rows` reste à 0 alors que `odds_log.rows`
      monte, la 031 est en place mais les snapshots échouent — chercher
      `[OddsLogger] snapshot non archivé` dans les logs.
- [ ] `ODDS_LOG_RUN_AT_BOOT=true` — **sans objet avant octobre** : `logTodaysOdds`
      sort sur le garde-fou `isSeasonActive()` avant la moindre écriture. À garder
      en tête pour la reprise, pas maintenant.

> **La leçon de la mise en service, en une ligne, parce qu'elle se repaiera.**
> La question « la 031 est-elle sur Neon ? » a été posée trois fois à trois
> mauvaises adresses — `db:migrate:all` avec le `.env` (→ le Postgres local),
> `curl localhost:3001` (→ le local via le serveur de dév), `arakice.com/api/dev/…`
> (→ le front Vercel) — et chacune a répondu de façon plausible sans jamais
> toucher Neon. La leçon n'est pas « faire attention » : c'est que **la cible doit
> être visible dans la sortie**. D'où la ligne `[migrate] Cible : hôte/base ssl=…
> ← BASE LOCALE`, et d'où la carte du dashboard, qui ne peut interroger que la
> base de son propre backend. Même principe pour les sondes : **un contrôle muet
> en cas de succès ne se distingue pas d'un contrôle qui n'a pas tourné** — c'est
> pourquoi la sonde `odds_snapshots` imprime désormais sa réussite.
>
> **Deux pièges du même run, à ne pas réintroduire.** `npm run db:migrate:all`
> n'applique pas « 028 et 031 » mais **tout l'arriéré**, dont la 030 et son
> `UPDATE user_profiles SET show_slips = TRUE` de masse — sans danger tant que
> `PUBLIC_SLIPS_SINCE` n'est pas renseignée sur Railway, **à vérifier avant, pas
> après**. Et `USER_RESERVE` se lisait avec `??`, qui n'attrape que `undefined` :
> une variable vide donnait 0 (plus de réserve visiteurs) et une valeur non
> numérique donnait `NaN` (collecte qui ne démarre jamais, sans un message). La
> lecture est désormais validée avec repli sur 150 et `logger.warn`.

---

### A2 — puck line

La règle est figée : miser la jambe qui **donne** les 1.5 buts quand
`p_modèle − p_marché ≥ 0.04`, mise à plat, critère **ROI > 0** et non « ≈ 20 % ».
**Ne rien miser d'ici là** — « non réfuté » n'est pas « établi ».

**A2 n'est pas biaisé par la calibration** (vérifié le 2026-08-26) : la puck line
−1.5 est calibrée dans tous ses bins d'effectif suffisant (ECE 0,0071 contre
0,0200 pour le moneyline) et la règle opère entre 0,15 et 0,55, précisément la
plage vérifiée. Nuance : la puck line n'a **aucune queue** (4 matchs au-dessus de
0,60, zéro au-dessus de 0,70), donc ce contrôle blanchit A2, **pas** la
distribution.

---

### S4 — servir le moneyline depuis le modèle de score

**Livré et déployé entre le 25 et le 26 août.** Ce qui est en service : le blend
`score ⊕ marché` écrit dans `train_score.py` ; `evaluate()` corrigée (elle
mesurait un autre modèle que celui servi) ; la décomposition λ des
`feature_importances` via `pred_contribs` (7 concepts, traduits EN/FR pour la
première fois) ; la `confidence` dérivée de |λ_dom − λ_ext| par rang dans les
déciles ; `base_prob = dist.p_home_win()` pour les **six** marchés non dérivables
(`last_team_score`, `period{1,2,3}_winner`, `winning_margin`, `double_chance`),
+1,5 à +3,1 points ; et les **deux estimateurs exposés côte à côte**
(`probability_score_model` / `probability_classifier`, avec leur Δ dans
`DevMLDashboard`), à coût de calcul nul. Détail complet dans
`ml/REFACTOR_PLAN.md` §S4.

**La prolongation dépendante de l'affiche est en service** depuis le run du
2026-08-26 : `σ(+0,264466·Δλ − 0,06097)` sur 3 427 prolongations, `mean_fitted`
0,49956, cinq garde-fous qui font retomber sur le scalaire sans bruit. Cause
mesurée, pas déduite : quand le modèle fait du domicile un favori ≥ 0,65 il gagne
**61,7 %** de ses prolongations (n = 149), et la constante 0,4996 est hors de
l'IC. Confirmé hors échantillon (log-loss 0,66368, ECE 0,02146, pente 1,1045 ±
0,0753) et vu au démarrage en prod :
`[ML] ✅ Prolongation dépendante de l'affiche — σ(+0.2645·Δλ -0.0610)`.

> **La mesure qui compte, et sa conséquence encore ouverte.** `backtest.py
> --reliability` (2026-08-26) a établi que **c'est le classifieur qui a raison
> dans les extrêmes** : sur ses propres bins, le modèle de score sort de l'IC là
> où ça compte — bin 0,7-0,8, il annonce 0,726 pour un observé de **0,821** sur
> 240 matchs. La compression est symétrique et mécanique (écart-type 0,095 contre
> 0,120, maximum 0,804 contre 0,877). La log-loss globale reste à parité (Δ
> apparié −0,00111 ± 0,00186, l'IC contient 0) : le modèle de score n'est pas
> moins bon, il est **mal calibré** — un autre défaut, et réparable.
>
> ⚠️ **La correction de prolongation ne referme pas la queue.** Après elle, le bin
> 0,7-0,8 annonce 0,7295 pour un observé de 0,8018 : toujours hors de son IC. La
> prolongation n'expliquait que ~2 points sur les 9,5. **Conséquence directe : les
> six marchés basculés sur `base_prob` sortent une probabilité de favori trop
> basse de ~7 points sur les affiches tranchées, donc une EV faussée dans le sens
> qui pousse vers l'outsider. Ne pas miser dessus** tant que γ n'est pas posé.

- [ ] **Étirer l'écart de λ (γ) — REPORTÉ, sciemment, après la saison 2026-27.**
      Le correctif de fond : `S = λ_dom + λ_ext` conservé, `δ = log λ_dom −
      log λ_ext` remplacé par `γ·δ`, un seul paramètre ajusté sur la validation.
      Les totaux sont intacts par construction et tous les marchés dérivés
      héritent de la correction. **Pourquoi on attend :** la pente vaut 1,105 ±
      0,075 — elle n'est **plus** significativement > 1, alors que le bin de queue
      échoue encore. Les deux tests se contredisent faute de matchs au-dessus de
      0,75 : il y en a 228. Poser γ là-dessus serait ajuster un paramètre sur du
      bruit. `backtest.py --reliability` mesure déjà tout ce qu'il faut.
- [ ] **⑤ Suppression du classifieur — REPORTÉE À APRÈS LE LANCEMENT**, et alors
      en « option 1 » : classifieur rétrogradé en **repli pur**, `_blend_w` et le
      chemin nominal supprimés, `game_model.json` gardé **une release de plus**.
      Réversible ; suppression définitive au déploiement suivant si rien n'a bougé.
- [ ] **La mesure qui tranchera ⑤ — quand la saison 2026-27 sera dans le
      dataset.** `python build_dataset.py`, puis `train.py` et `train_score.py` :
      la comparaison porte alors sur des matchs qu'**aucun des deux modèles n'a
      vus**, au lieu des 0,0011 de log-loss actuels qui sont dans le bruit. C'est
      la vraie raison de garder `game_model.json` une release de plus — la mesure
      a besoin des deux modèles.

> ### 🔍 Le blend marché n'a jamais tourné, et c'est un argument pour A1
>
> `_blend_w` se lit dans `training_report.json → game_model.baselines.market.
> blend_weights` — clé **absente** du rapport. Cause : le découpage est
> chronologique et les cotes SBRO s'arrêtent en 2022-23, donc la tranche de
> **test (4 304 matchs, 2023-02-26 → 2026-04-16) ne contient AUCUNE cote**.
> `train.py` bute sur le même mur depuis toujours. **Aucun blend marché n'est
> ajustable tant qu'A1 ou A1bis n'a pas comblé 2023-2026.**
>
> Conséquence : la crainte qui bloquait ④ et ⑤ portait sur un blend inexistant.
> Sur la même tranche de test, **modèle de score + τ 0,6642 contre classifieur +
> Platt 0,6653** — le modèle de score est déjà devant. S4 est une simplification
> **à parité**, pas un compromis. Le blend reste écrit et juste : ses poids
> s'appliqueront par-dessus `dist.p_home_win()` le jour où il y aura des cotes.
> Attention en attendant : le blend marché est **vivant** côté serveur
> (`featureEngineering.ts:238` passe les cotes), et P1 a mesuré le marché seul
> meilleur que les deux modèles nus — d'où le réajustement plutôt que la perte.

---

### A4 et A6

**A4 — fenêtre de confirmation du gardien.** Mesure préalable, pas une stratégie :
elle dit s'il y a lieu de construire.

- [ ] Extraire la trajectoire des lignes autour de l'heure de confirmation

**A6 — team totals, prolongation, écarts ±2.5.** Priçables par `score_model.py`,
jamais confrontés à des prix réels. Après A1 et A2.

---

## 3. Scalabilité — déclenchés sur seuil

Source : `AUDIT_SCALABILITE_COUTS.md` §3. **Rien ici n'est requis pour 500
simultanés.**

| # | Quoi | Déclencheur | Effort |
|---|---|---|---|
| **D** 🔴 | **Redis (Upstash)** : adapter Socket.io + `RedisRateLimitStore` (déjà écrit, à brancher) + quota LLM Free | **avant la 2ᵉ instance** | 1 j |
| E | Migrer les data-URI d'avatars déjà en base vers R2 — code et variables en place | ~500 utilisateurs avec avatar | 2 h |
| Q | 2ᵉ instance Railway + sticky sessions | CPU > ~70 % en régime | 4 h |
| 7 bis | **Décidé le 2026-08-24 : scale-to-zero.** À activer dans la console Neon ; accepter un cold start de quelques secondes après inactivité | maintenant | 30 min |
| U | RAM du service ML : 2 workers uvicorn à ~300-500 Mo RSS chacun ne tiennent pas dans 512 Mo | avant le premier pic réel | 15 min |
| I | TanStack Query côté client — `fetch` brut partout, aucune déduplication | quand la facture Railway devient visible | 2 j |
| T | Cache de prompts LLM identiques | quand l'usage LLM devient significatif | 4 h |
| V | Échantillonner les logs 2xx | à la première facture de logs | 1 h |
| W | Purge Tailwind — le CSS pèse **90,5 ko brut / 21 ko gzip** (mesuré le 2026-08-29 ; le JS est déjà découpé par route, et le gros morceau est le chunk `charts` à 537 ko / 154 ko gzip, chargé seulement sur les routes qui l'utilisent) | — | 2 h |

**Écarté sciemment** — décision produit, pas oubli : Redis tant qu'il n'y a
qu'une instance. (La ligne O, TTL différenciés Tennis, est sans objet depuis le
retrait du tennis.)

**Question ouverte, laissée exprès :** `writeLimiter` (30 écritures/min, monté
sur `/api/chat` et les routes d'écriture) est encore classé **par IP** et souffre
donc du NAT mobile que `apiLimiter` ne subit plus. Passer les écritures « par
compte » affaiblirait l'anti-spam là où il sert le plus, et les salons ont déjà
leur propre limiteur par action. À trancher.

**Ne pas « corriger » :** `fetchSpreadsOnly` (`oddsClient`) renvoie `[]` en cas de
panne au lieu de servir un prix périmé. C'est voulu — un collecteur qui rate un
cycle perd un point de mesure, alors qu'un snapshot réécrit avec un prix ancien
fabriquerait un faux mouvement de ligne.

- [ ] **Sur ta machine :** `cd server && npm test` pour le dernier lot du
      2026-08-24 (limiteur, cache du calendrier, hôte des stats,
      `profileUpdateSchema`)

---

## 4. QA — campagnes à exécuter

Source : `QA_TEST_PLAN.md`, qui garde le détail (résultat attendu, notes, pièges).
Sécurité et résilience sont **validées en statique** ; ce qui reste est dynamique.

**Fonctionnel** — F1 auth complète · F2 gating Pro bout en bout · F3 slip +
settlement · F4 prédictions NHL du jour · F5 Best Bets / value bet scan ·
F6 récupération de mot de passe

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

**Deux avis `npm audit` « high » en dépendance de production du client** — relevés
le 2026-08-29, aucun ne bloque le lancement :

- **`react-router` 7.13.0 (épinglé).** La douzaine d'avis vise en majorité les modes
  **SSR / RSC / framework** (RCE turbo-stream, single-fetch, `__manifest`,
  hydratation) : `routes.tsx:75` utilise `createBrowserRouter`, SPA pure, donc sans
  objet ici. **Restent deux redirections ouvertes côté client** — antislash et `//`
  protocol-relative dans `<Link>` / `useNavigate` — réelles dès qu'une cible de
  navigation vient d'une entrée utilisateur. Correctif en 7.18.3, **hors de la
  plage épinglée** : c'est une montée de version à planifier, pas un `audit fix`.
- **`socket.io-parser` 4.2.6 (transitif).** Épuisement mémoire par pièce jointe
  vide. Correctif **dans la plage** : `npm audit fix`, puis rejouer le build.

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

### Synchro des poids de règles — câblée le 2026-08-24

Le câblage et ses règles de conflit sont dans le code (`ruleWeightsService`) ;
`PATCH /users/me` est désormais borné par `profileUpdateSchema` (liste blanche
zod sur la route + double barrière dans le service). Il ne reste qu'une
vérification, qui ne peut se faire qu'à la main :

- [ ] **À 2 appareils** (ou 2 navigateurs) : régler une pondération et
      l'enregistrer sur A, recharger B connecté au même compte → B doit voir les
      curseurs de A. Puis en invité : l'onglet Réseau ne doit montrer **aucun**
      appel `/users/me` déclenché par une carte de règles.

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

## 6. Ménage du 2026-08-10 — ce qu'il en reste

Le détail de ce qui a été supprimé (kit shadcn de 49 fichiers, 7 fichiers morts,
42 dépendances sur 50, 15 exports) est dans l'historique Git. Ne restent ici que
les points encore vivants.

### Reste à faire

- [ ] **Révoquer et régénérer `VITE_ODDS_API_KEY`** si la valeur littérale qui
      était en clair dans `DEPLOYMENT.md` §4 était réelle et que le dépôt a
      circulé. (La doc porte un placeholder depuis.)
- [ ] **Découpage > 500 lignes**, si on le poursuit :

| Fichier | Lignes | Pourquoi ce n'est pas un découpage mécanique |
|---|---|---|
| `i18n/index.tsx` | 855 | Dictionnaire de traductions. Le découper par domaine est du rangement, pas de la structure. |
| `data/betMarkets.ts` | 628 | Table de données. Même remarque. |
| `pages/NHLPredictionsPage.tsx` | 589 | Jamais analysé — le candidat le plus sérieux. |
| `components/MLPredictionCard.tsx` | 541 | Candidat. |
| `components/MarketSelectorSheet.tsx` | 519 | Candidat. |
| `profile/SettingsTab.tsx` | 509 | **453 lignes réelles**, un seul composant portant ~20 `useState` partagés. Les séparer = faire descendre ces états en props : un vrai refactoring, à faire avec le navigateur ouvert. |

### Retrait du tennis — décidé et fait le 2026-08-24

Le tennis est sorti du produit : les 5 fichiers dédiés (2 pages, le service et le
client d'API, la route serveur) sont **déplacés dans `_to_delete/tennis-2026-08-24/`**
— le bridge ne peut pas supprimer, c'est à toi de le faire — et 18 fichiers ont
été nettoyés (branche tennis de `HockeyLanding`, `BestBetsSection`, `StatsPage`,
`PredictionPage`, marchés, types, i18n, route et branche ML côté serveur).

`SportContext` **reste**, en mono-sport : il porte le thème que consomment une
vingtaine d'écrans. Le supprimer aurait disséminé trois constantes partout.

- [x] **Sorti de l'index Git le 2026-08-25** (`git rm -r --cached _to_delete`,
      `_to_delete/` ajouté au `.gitignore`). Les 5 fichiers étaient **commités**
      dans `_to_delete/` par 1583804 : ils partaient donc encore avec le dépôt.
      **Dossier supprimé pour de bon le 2026-08-29** — plus rien sur le disque,
      `_to_delete/` reste au `.gitignore` par sécurité.
- [x] **Contrôle statique passé le 2026-08-25** : zéro référence vivante à
      `tennis`/`rapidapi` (il ne reste que 4 commentaires d'explication), zéro
      usage de `setSport`, `TennisLiveCard`, `TennisMatchRow`,
      `TENNIS_MARKET_DEFINITIONS`, `tennisLive`/`tennisUpcoming`, et sur les 194
      fichiers de `client/src` + `server/src` : 0 erreur de syntaxe, 0 import
      relatif cassé.
- [x] **Build Windows rejoué le 2026-08-29** — `npm ci && npm run build` côté
      `client`, vert : `dist/` reconstruit, les 7 shells de route écrits, 0 erreur.
      Le `npm ci` a du même coup nettoyé un `node_modules` à moitié installé (58
      répertoires de staging npm laissés par un `npm install` tué en cours
      d'extraction). À noter pour la suite : `client` n'a **pas de
      `tsconfig.json`**, son build est `vite build` seul — il ne typecheck donc
      pas. Le seul vrai typecheck du dépôt reste `server` → `npm run typecheck`,
      joué vert le 2026-08-28.
- [x] **Le client a désormais son typecheck** — `tsconfig.json` en `strict`,
      plus `@types/react`, `@types/react-dom` et `typescript` en
      devDependencies, et un script `npm run typecheck`.
      ⚠️ **`package.json` a changé sans le lock : lancer `npm install` une fois**
      (il régénère `package-lock.json`, à commiter), puis `npm run typecheck` —
      **il rend 0 erreur** (vérifié ici avant livraison, avec `vite build` vert).
- [x] **Les 10 erreurs de type préexistantes sont refermées — 2026-08-29.
      `npm run typecheck` rend 0 erreur.** Quatre d'entre elles n'étaient pas
      des broutilles de typage, mais des bogues visibles :
      **①** `MLPredictionCard.tsx:412` utilisait une variable `accent` **qui
      n'existe nulle part dans le fichier** — un `ReferenceError` levé dès que
      `feature_importances` n'était pas vide, c'est-à-dire chaque fois que la
      carte ML avait quelque chose à montrer. Remplacée par le violet ML de la
      carte.
      **②** `betMarkets.ts` : `CATEGORY_LABELS` et `CATEGORY_ICONS` portaient la
      clé `game`, alors qu'aucune des définitions n'utilise `category: "game"` —
      elles disent toutes `"match"`. Les deux tables étaient donc interrogées
      avec une clé absente et rendaient `undefined` : le groupe « Game Lines »,
      le plus important de la feuille de marchés, s'affichait **sans titre ni
      icône**.
      **③** `BetBuilderPage` jetait le `message` renvoyé par le serveur à la
      réception puis le lisait au rendu : le sous-titre de l'écran « Slip
      Locked! » était vide depuis toujours.
      **④** `MarketSelectorSheet:526` appelait `onSelect(t.id, t.name, t.logo)`
      sur une fonction à un seul argument.
      Les six autres étaient du typage à remettre d'aplomb : `AddSheetState` ne
      déclarait pas le `gameId` que `HockeyLanding` y écrivait et relisait,
      `LiveGameCard` recevait une prop `accent` qu'il n'accepte pas, plus trois
      détails (`chartsMetrics`, `pushService`, extension `.tsx` dans `main.tsx`).

> **Le typecheck a été prouvé actif, pas seulement silencieux.** Une faute
> volontaire (`const x: number = "texte"`) a été insérée dans `main.tsx` : `tsc`
> l'a signalée, puis le fichier a été restauré et la sortie est redevenue vide.
> C'est exactement le contrôle qui manquait le 2026-08-29 au premier essai, où
> une sortie vide voulait dire « rien n'a été vérifié ». Un contrôle muet ne se
> distingue pas d'un contrôle qui n'a pas tourné.
- [ ] Railway : retirer `RAPIDAPI_KEY` (la ligne est partie de `.env.example`)
- [ ] Vérifier une page d'accueil et l'onglet Stats dans le navigateur

> **Les paris tennis déjà en base ne bougent pas.** `settlement.service` les
> laissait déjà en attente (aucune logique de règlement tennis n'a jamais
> existé) et un coupon affiche des libellés stockés, pas des définitions de
> marché : rien ne casse, ils restent simplement « pending » pour toujours. Si
> tu veux les solder, c'est une requête SQL manuelle, à décider séparément.

### À ne pas défaire

- **`server/src/middleware/redisRateLimitStore.ts`** paraît orphelin : c'est le
  stub de la ligne D (§3). Le brancher est « une ligne par limiteur » *parce
  qu'il existe déjà*.
- **5 exports sans appelant sont gardés exprès**, chacun commenté :
  `clearBestBetsCache`, `clearLeaderboardCache`, `stopOddsLogger`, `snapshot`
  (oddsQuota) — points d'entrée dont un test d'intégration a besoin — et
  `applyServerFamilyWeights`, désormais appelée (§5).

### Méthode de découpage — les trois pièges, si on reprend

Extraction de plages de lignes **par script**, jamais à la main, avec trois
contrôles : syntaxe, résolution de chaque import interne, et comparaison des
multiensembles de lignes avant/après (c'est celui qui prouve qu'aucune ligne n'a
été perdue). Les trois pièges rencontrés, tous attrapés par les contrôles et
aucun par la relecture :

1. le script écrasait son propre fichier source (il lit une copie depuis) ;
2. l'extraction d'identifiants attrapait les noms **cités dans les commentaires**
   et fabriquait des imports circulaires imaginaires (elle passe par l'AST) ;
3. les imports **à effet de bord** (`import "x.css"`) n'ont aucun binding : ils
   étaient silencieusement supprimés — la page aurait perdu ses styles sans
   qu'aucun test ne bronche. Le script les réinjecte et refuse de tourner s'il en
   trouve un sans coquille désignée.

Pour réintroduire un composant shadcn : `npx shadcn@latest add <nom>`.

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
