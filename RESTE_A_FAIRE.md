# ARAKICE / ICEEDGE — Ce qui reste

**Créé le 2026-08-10 · mis à jour le 2026-08-26.**

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

**A1bis — mise en service de la collecte live. C'EST LE PROCHAIN POSTE**
(décidé le 2026-08-24 ; indépendant de la décision de payer) :

- [ ] Migrations **028 et 031** : `npm run db:migrate:all`, puis `npm test`
- [ ] Railway : `ODDS_LOG_ENABLED=true` et `ODDS_USER_RESERVE`
- [ ] Optionnel, le temps d'un déploiement : `ODDS_LOG_RUN_AT_BOOT=true` pour
      voir une passe complète dans les logs, **puis le retirer** (3 crédits par
      démarrage)

> **Revue de mise en service faite le 2026-08-25 — la chaîne est complète.**
> `028` et `031` sont idempotentes (`IF NOT EXISTS` partout) et le runner
> `migrate-all.ts` découvre le dossier tout seul avec un registre
> `schema_migrations` : il n'y a rien à déclarer, `npm run db:migrate:all` suffit.
> `startOddsLogger()` est bien appelé (`server.ts:46`), `insertSnapshots` écrit
> bien dans `odds_snapshots`, et le calendrier code (2 passes `full` à 3 crédits
> + 4 passes `spreads` à 1) fait bien **10 crédits/jour**, conforme au texte.
>
> **Un piège corrigé au passage.** `USER_RESERVE` se lisait
> `Number(process.env.ODDS_USER_RESERVE ?? 150)` : le `??` n'attrape que
> `undefined`. Or cette variable se pose **à la main dans une console**, et les
> deux fautes de frappe possibles échouaient en silence — valeur vide → `0`,
> donc plus de réserve visiteurs et une collecte libre de vider le quota ;
> valeur non numérique → `NaN`, et `remaining - cost >= NaN` est toujours faux,
> donc **la collecte ne démarre jamais sans un seul message**. La lecture est
> désormais validée (vide / non numérique / négatif → défaut 150 + `logger.warn`).
> `oddsQuota.test.ts` pose `'150'` avant l'import : comportement inchangé pour lui.
>
> Reste vraiment à faire côté machine : les migrations, `npm test`, et les
> variables Railway. Après le premier déploiement, `GET /api/dev/...` relit
> `odds_quota_state` (`dev.routes.ts:184`) pour vérifier le solde sans dépenser
> de crédit.

Le calendrier posé coûte **10 crédits/jour, 300/mois** — deux passes complètes
(11 h, 17 h ET) et quatre passes `spreads` seules (18 h 45, 19 h 45, 21 h 45,
22 h 45 ET), sous les 350 disponibles pour la première fois.

**A2 — puck line :** la règle est figée (miser la jambe qui **donne** les
1.5 buts quand `p_modèle − p_marché ≥ 0.04`, mise à plat, critère **ROI > 0** et
non « ≈ 20 % »). **Ne rien miser d'ici là** — « non réfuté » n'est pas
« établi ».

**S4 — servir le moneyline depuis le modèle de score.** Conception faite, code
non commencé, plus bloqué par A5.

- [x] Blend `score ⊕ marché` dans `train_score.py`, poids dans `score_report.json`
      — **écrit le 2026-08-25, pas encore exécuté.** Détail et caveat dans
      `ml/REFACTOR_PLAN.md` §S4. Rien du service n'a bougé : c'est un
      post-traitement du rapport. **À toi : `cd ml/python && python
      train_score.py`, puis on lit la table log-loss avant d'aller plus loin.**
- [x] **`evaluate()` mesurait un autre modèle que celui servi — corrigé le
      2026-08-25.** Elle retombait sur la constante `P_OT_HOME` au lieu du
      `p_ot_home` mesuré sur l'entraînement, celui que `ml_service` relit
      (`ml_service.py:326`). Attendu au prochain run : les chiffres du bloc
      `test` de `score_report.json` bougent légèrement — c'est la correction.
      Le réglementaire (nul, dom −1.5) et le MAE du total sont inchangés.
      Le même oubli est laissé exprès à `backtest_walkforward.py:1556` (A5 est
      clos et sa mémoïsation mélangerait les résultats) — détail dans
      `ml/REFACTOR_PLAN.md` §S4.
- [x] **Décomposition λ pour `feature_importances` — livrée le 2026-08-25.**
      `pred_contribs` sur la DMatrix déjà construite (zéro prédiction en plus),
      `contrib(dom) − contrib(ext)`, 7 concepts, parts normalisées. Remplace les
      gains globaux du classifieur, identiques pour tous les matchs ; celui-ci
      ne reste qu'en repli. Le service envoie une **clé** (`factor.attack`, …),
      traduite côté client (8 entrées EN/FR + `factorLabel`, repli sur le nom
      brut) — les facteurs sont traduits pour la première fois. Détail et
      répartition des 22 features dans `ml/REFACTOR_PLAN.md` §S4.
      🐛 Corrigé au passage : `MLPredictionCard` rendait `{f.feature}` au lieu de
      `{f.name}` dans la mise en page « standard » — libellé vide à l'écran.
- [x] **`confidence` depuis |λ_dom − λ_ext| — livrée le 2026-08-25.** Déciles
      mesurés sur l'entraînement par `train_score` → `score_report.json` ; le
      service place le match à son **rang** dedans. Bornes, multiplicateur de
      marché et clamp final **inchangés** : seule la source du signal change.
      Repli sur l'ancienne formule si le rapport n'a pas de calibration lisible.
      Sans effet sur le tri des paris — vérifié, `bestBets` et `ml.routes`
      dérivent leur propre libellé de la probabilité. Détail dans
      `ml/REFACTOR_PLAN.md` §S4.
- [x] **`base_prob = dist.p_home_win()` pour les marchés non dérivables —
      livré le 2026-08-25.** Portée réelle : **six marchés**
      (`last_team_score`, `period{1,2,3}_winner`, `winning_margin`,
      `double_chance`) ; tout le reste est déjà pricé par la distribution avant
      que `base_prob` soit lu. +1,5 à +3,1 points selon le marché. `model_type`
      et `model_version` suivent (`score-nhl-v1.0`, corrigé le 2026-08-26).
      **Vérifié en navigateur le 2026-08-26**, chiffres reproduits hors ligne à
      l'unité près — détail dans `ml/REFACTOR_PLAN.md` §S4.
- [x] **Les deux estimateurs exposés côte à côte — livré le 2026-08-25.**
      `probability_score_model` et `probability_classifier` dans `MLResponse`
      (optionnels, rétrocompatibles), relayés par `mlApiClient.ts` et affichés
      avec leur Δ dans `DevMLDashboard`. **Coût zéro en calcul :** depuis ④ le
      classifieur tourne toujours et son résultat était jeté.
- [ ] **⑤ Suppression du classifieur — REPORTÉE À APRÈS LE LANCEMENT**, et
      alors en « option 1 » : classifieur rétrogradé en **repli pur**, `_blend_w`
      et le chemin nominal supprimés, `game_model.json` gardé **une release de
      plus**. Réversible ; suppression définitive au déploiement suivant si rien
      n'a bougé. Raisons détaillées dans `ml/REFACTOR_PLAN.md` §S4.
- [x] **2 bogues corrigés à la première vérification navigateur (2026-08-25).**
      ① `_read_confidence_deciles` était définie sous `_try_load_models()`, qui
      tourne au chargement du module → `NameError` avalé par son `except`, et
      **tout le modèle de score désactivé en silence** (②③④ d'un coup). Bloc
      remonté + test structurel `ast` qui verrouille la classe de bogue.
      ② `DevMLDashboard`, onglet Backtest : `markets.puckline_diagnostics` est
      un objet parmi des tableaux depuis le run A2 → filtre `Array.isArray`.
      Ajouté : un menu **Marché** dans le panneau de test, sans quoi ④ n'était
      pas vérifiable en un clic (le bouton envoyait `moneyline` en dur, un
      marché dérivable où ④ n'a aucun effet).
- [x] ⚠️ **Diagramme de fiabilité des DEUX modèles — MESURÉ le 2026-08-26.**
      `python backtest.py --reliability` (nouveau mode, sans cotes : il tourne
      là où le mode ROI ne peut pas), rapport dans
      `../models/reliability_report.json`. **C'est le classifieur qui a raison
      dans les extrêmes.** Sur ses PROPRES bins — le seul test inattaquable,
      chacun conditionné sur sa propre probabilité — le modèle de score sort de
      l'IC là où ça compte : bin **0,7-0,8**, il annonce **0,726**, l'observé
      est **0,821** sur 240 matchs (IC [0,767 ; 0,864]). Le classifieur, lui,
      est dans l'IC dans **tous** ses bins d'effectif suffisant, jusqu'à 0,8-0,9
      (annonce 0,826, observé 0,837, n = 86). Sur COL-SJS, 77 % était donc le
      bon chiffre, pas 66 %.
      **La compression est symétrique et mécanique** : écart-type des
      probabilités 0,095 contre 0,120, maximum 0,804 contre 0,877, 242 matchs
      au-dessus de 0,70 contre 435. ECE 0,0200 contre 0,0110 ; MCE 0,0953 contre
      0,0369.
      **Ce qui ne se conclut PAS** : la log-loss globale reste à parité (Δ
      apparié score − classifieur **−0,00111 ± 0,00186**, l'IC contient 0 ;
      0,66421 contre 0,66532, qui reproduisent à l'unité près les rapports
      existants). Le modèle de score n'est pas moins bon — il est **mal
      calibré**, ce qui est un autre défaut, et lui est réparable.
      ⚠️ **Conséquence directe sur ④** : les six marchés basculés sur
      `base_prob = dist.p_home_win()` sortent une probabilité de favori trop
      basse de ~6 à 10 points sur les affiches tranchées, donc une EV faussée
      dans le sens qui pousse vers l'outsider. **Ne pas miser dessus** tant que
      le poste suivant n'est pas fait.
- [x] **Prolongation dépendante de l'affiche — CODE LIVRÉ le 2026-08-26.**
      Cause mesurée, pas déduite : sur les 951 matchs de test allés en
      prolongation, quand le modèle fait du domicile un favori ≥ 0,65 il gagne
      **61,7 %** de ses prolongations (n = 149, IC [0,537 ; 0,692]) — la
      constante 0,4996 est **hors de l'IC**. Les trois autres tranches sont
      compatibles.
      Où ça vit : `score_model.read_ot_model` / `p_ot_for` (le contrat partagé,
      pour que l'entraînement, le service et la mesure appliquent la **même**
      formule), `train_score.fit_ot_model` (l'ajustement, sur l'ENTRAÎNEMENT),
      `ml_service._p_ot_for` (la lecture, définie **au-dessus** du chargeur —
      cf. le bogue muet du 2026-08-25), et `backtest.py --reliability` qui lit
      désormais le même modèle, donc mesure ce qui est **servi**.
      Cinq garde-fous font retomber sur le scalaire sans bruit : effectif < 500,
      coefficients non finis, **pente ≤ 0** (les favoris perdraient plus souvent
      leurs prolongations : ajustement raté, pas découverte), **niveau moyen à
      plus de 0,02 de la constante** (c'est ce garde-fou qui aurait refusé
      l'ajustement sur la validation), et log-loss non améliorée.
- [x] **En service depuis ton run du 2026-08-26 07:00.** `score_report.json`
      porte `p_ot_model` = σ(+0,264466·Δλ −0,06097) sur 3 427 prolongations,
      avec `mean_fitted` **0,49956** — le niveau moyen égale la constante au
      chiffre près, le garde-fou a donc bien tenu. `backtest.py --reliability`
      relancé derrière prend le chemin « DÉJÀ EN SERVICE » et rend
      **exactement** les chiffres annoncés hors échantillon : log-loss 0,66368,
      ECE 0,02146, MCE 0,0723, pente **1,1045 ± 0,0753 — l'IC contient 1**.
      Le bloc `test` du rapport a bougé comme prévu (`logloss_moneyline`
      0,6642 → **0,6637**, `home_win_predicted` 0,5491 → 0,5496) : c'est
      `evaluate()` qui price désormais avec le p_ot servi.
- [x] **Service ML redéployé et confirmé au démarrage** — la bannière
      `[ML] ✅ Prolongation dépendante de l'affiche — σ(+0.2645·Δλ -0.0610)`
      a été vue en prod. Le poste est clos de bout en bout : mesure → cause →
      correctif → run → déploiement.
- [ ] **⚠️ Ça ne referme PAS la queue, et il faut le savoir avant de le faire.**
      Après correction, le bin 0,7-0,8 annonce 0,7295 pour un observé de 0,8018 :
      toujours hors de son IC. La prolongation n'explique que **~2 points sur
      les 9,5** — exactement ce que l'arithmétique donnait avant la mesure. Le
      reste est une compression de la distribution elle-même. **④ reste sous
      caution**, avec un biais ramené de ~9,5 à ~7 points sur les affiches
      tranchées, toujours dans le sens qui pousse vers l'outsider.
- [ ] **Étirer l'écart de λ (γ) — REPORTÉ, sciemment, après la saison 2026-27.**
      Le correctif de fond : `S = λ_dom + λ_ext` conservé, `δ = log λ_dom −
      log λ_ext` remplacé par `γ·δ`, un seul paramètre ajusté sur la validation.
      Les totaux sont intacts par construction (S conservé) et tous les marchés
      dérivés héritent de la correction de façon cohérente. **Pourquoi on
      attend :** après la correction de prolongation, la pente vaut 1,105 ±
      0,075 — elle n'est **plus** significativement > 1, alors que le bin de
      queue échoue encore. Les deux tests se contredisent faute de matchs
      au-dessus de 0,75 : il y en a 228. Poser γ sur cette base serait ajuster
      un paramètre sur du bruit. `backtest.py --reliability` mesure déjà tout ce
      qu'il faut pour trancher quand la saison sera dans le dataset.
- [x] **A2 n'est PAS biaisé par la calibration — vérifié le 2026-08-26.** La
      puck line −1.5 est calibrée dans tous ses bins d'effectif suffisant (ECE
      0,0071 contre 0,0200 pour le moneyline), et la règle A2 opère entre 0,15
      et 0,55, précisément la plage vérifiée. Nuance à ne pas perdre : la puck
      line n'a **aucune queue** (4 matchs au-dessus de 0,60, zéro au-dessus de
      0,70), donc ce contrôle ne peut pas détecter une compression des
      extrêmes — il blanchit A2, pas la distribution.
- [ ] **La mesure qui tranchera ⑤ — à faire quand la saison 2026-27 sera dans
      le dataset.** `python build_dataset.py`, puis `train.py` et
      `train_score.py` : la comparaison porte alors sur des matchs qu'**aucun
      des deux modèles n'a vus**, au lieu des 0,0011 de log-loss actuels qui
      sont dans le bruit. C'est la vraie raison de garder `game_model.json` une
      release de plus — la mesure a besoin des deux modèles. En attendant,
      `DevMLDashboard` montre l'écart match par match.

> ### 🔍 Le run du 2026-08-25 a renversé la prémisse de S4
>
> **Le blend ⊕ marché n'a jamais tourné en production.** `_blend_w` se lit dans
> `training_report.json → game_model.baselines.market.blend_weights` — clé
> **absente** du rapport. Cause : le découpage est chronologique et les cotes
> SBRO s'arrêtent en 2022-23, donc la tranche de **test (4 304 matchs,
> 2023-02-26 → 2026-04-16) ne contient AUCUNE cote**. `train.py` bute sur le
> même mur depuis toujours. **Aucun blend marché n'est ajustable tant qu'A1
> (backfill payant) ou A1bis (collecte accumulée) n'a pas comblé 2023-2026** —
> argument à porter au dossier A1 en §2.
>
> Conséquence : la crainte qui bloquait ④ et ⑤ portait sur un blend inexistant.
> Sur la même tranche de test, **modèle de score + τ 0.6642 contre classifieur +
> Platt 0.6653** — le modèle de score est déjà devant. S4 est une simplification
> **à parité**, pas un compromis. Détail chiffré dans `ml/REFACTOR_PLAN.md` §S4.
>
> ① reste écrit et juste : ses poids s'appliqueront par-dessus
> `dist.p_home_win()` le jour où il y aura des cotes à ajuster.

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
| 7 bis | **Décidé le 2026-08-24 : scale-to-zero.** À activer dans la console Neon ; accepter un cold start de quelques secondes après inactivité | maintenant | 30 min |
| U | RAM du service ML : 2 workers uvicorn à ~300-500 Mo RSS chacun ne tiennent pas dans 512 Mo | avant le premier pic réel | 15 min |
| I | TanStack Query côté client — `fetch` brut partout, aucune déduplication | quand la facture Railway devient visible | 2 j |
| T | Cache de prompts LLM identiques | quand l'usage LLM devient significatif | 4 h |
| V | Échantillonner les logs 2xx | à la première facture de logs | 1 h |
| W | Purge Tailwind — le CSS pèse 124 ko (le JS est déjà découpé par route) | — | 2 h |

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
      Reste à **supprimer le dossier à la main** dans l'Explorateur — le bridge
      n'a pas le droit de supprimer.
- [x] **Contrôle statique passé le 2026-08-25** : zéro référence vivante à
      `tennis`/`rapidapi` (il ne reste que 4 commentaires d'explication), zéro
      usage de `setSport`, `TennisLiveCard`, `TennisMatchRow`,
      `TENNIS_MARKET_DEFINITIONS`, `tennisLive`/`tennisUpcoming`, et sur les 194
      fichiers de `client/src` + `server/src` : 0 erreur de syntaxe, 0 import
      relatif cassé.
- [ ] `npm run build` **des deux côtés, sur Windows** — impossible depuis le
      bridge : chaque appel shell y est plafonné à 45 s **dans un namespace PID
      isolé**, donc un build lancé en arrière-plan est tué dès que l'appel rend
      la main. `vite build` et `tsc` dépassent tous les deux (et `git status` /
      `git diff` aussi, sur ce mount). À noter : `client` n'a **pas de
      `tsconfig.json`**, son build est `vite build` seul — il ne typecheck donc
      pas, et le contrôle statique ci-dessus couvre à peu près ce qu'il aurait
      attrapé. Le seul vrai typecheck du dépôt, c'est `server` → `npm run
      typecheck`.
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
