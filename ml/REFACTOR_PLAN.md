# Plan ML — ArakIce

> **Ce document ne raconte plus ce qui a été fait.** Il ne garde que deux
> choses : les conclusions qu'il ne faut pas re-tester, et ce qui reste à
> simplifier ou à améliorer. Réécrit le 2026-08-04, tenu à jour depuis.
>
> **État au 2026-08-08.** S1, S2, S3, S5 livrés — prédictions inchangées.
> **A2 mesuré** : la puck line n'est pas réfutée, mais tout tient sur 463 paris
> d'une seule jambe, et l'historique disponible ne permettra pas de trancher.
> Une règle falsifiable est figée ; **A3 (CLV) devient le chemin critique**.
> Reste le run A5, puis S4.

---

## Acquis — à ne PAS refaire

Ces résultats ont coûté cher à mesurer et sont solides. Les redécouvrir serait
du temps perdu ; les ignorer serait pire.

| Question | Réponse mesurée | Comment |
|---|---|---|
| Peut-on battre le moneyline ? | **Non.** La cote de clôture dévigée est le meilleur estimateur disponible. | 3 chemins indépendants : résidu de marché (arrêt précoce à 0-88 arbres), 117 features, dimensionnement Kelly. Walk-forward 7-9 saisons. |
| Plus de features aide-t-il ? | **Non.** 13 features (0.66819) battent 117 (0.67064), qui font moins bien qu'un ELO nu. | Sélection sans fuite, walk-forward 7 saisons. Les 104 supprimées coûtaient 0.00245 de log-loss en variance pure. |
| Le total de buts est-il prédictible ? | **Quasi pas.** MAE 1.86 contre 1.90 pour une constante. | Le gain de P2 n'était pas la précision mais la *calibration* des marchés dérivés. |
| Faut-il un Poisson bivarié ? | **Non.** Dispersion 1.013/0.991, corrélation dom↔ext **−0.048** — le bivarié standard ne modélise que du positif. | Mesuré sur 21 517 matchs. |
| La correction de marge τ est-elle nécessaire ? | **Oui.** Le Poisson brut sous-estime les nuls de 6 points ; τ ramène à 0.2 point. | Signature du filet désert : excès sur 0 et ±3, déficit sur ±1 et ±2. |
| σ (ensemble bootstrap) dit-elle où le modèle se trompe ? | **Non** en général. Elle dit où l'edge *sélectionné* est gonflé (malédiction du vainqueur, p ≈ 0.04). Non actionnable : l'edge corrigé est négatif partout. | 20 membres, σ_max calibré hors échantillon. |
| La forme d'un gardien est-elle prévisible ? | **Non.** r = +0.038 d'un match au suivant. Mais le *talent* est réel : 0.165 but/match entre Q1 et Q4, à xG subi plat. | 45 222 départs. |
| Les totaux sont-ils jouables ? | **Non.** ROI −2.75 % sur 8 833 paris à prix réels. (Le modèle récupère ~1.7 pt sur une marge de 4.4 % : du signal, pas assez.) | 9 saisons, prix de clôture SBRO. |
| La puck line est-elle jouable ? | **Non tranché, et la question a changé de forme.** Sans la fuite d'hyperparamètres : +2.10 % à edge ≥4 % (z 1.50). Mais **tout vient de la jambe −1.5** : 463 paris à +20.09 % (z 3.05), pendant que les 3 482 paris +1.5 font −0.30 %. | Walk-forward 9 saisons, prix de clôture réels, sélection par fold (2026-08-08). Voir A2. |

**Deux règles de méthode issues de ces mesures :**

- Comparer une valeur servie à la **saison courante**, jamais à la moyenne
  historique — la ligue marque 6.254 buts/match en 2025-26 contre 5.848 sur
  tout l'historique.
- Un ROI positif n'est crédible que **réparti** : dans le temps, à travers les
  cotes, à travers les équipes, et sans tenir à quelques gains. `dissect()`
  dans `backtest_walkforward.py` teste les quatre.

---

## Où en est le code

```
build_dataset.py   features + cibles réglementaires/prolongation
train_score.py     Poisson empilé équipe-match + τ + P(dom en OT)   ← le cœur
score_model.py     distribution → tous les marchés dérivables
train.py           classifieur moneyline seul                       ← redondant (S4)
ml_service.py      service FastAPI
backtest_walkforward.py   walk-forward, marchés dérivés, dissection
fetch_data_v4.py   spine + MoneyPuck + cotes (SBRO ≤2022-23, Odds API ≥2020)
```

**Mesures en attente sur ta machine** (le code est livré, rien n'est mesuré) :

```bash
cd ml/python
python train.py                              # S2/S3 : ne produit plus que game_model
python backtest_walkforward.py --derived     # P6 corrigé : fuite d'hyperparamètres
                                             # + dissection complète          → A2
python backtest_walkforward.py --select-score-features   # ablation features   → A5
```

Le premier passage de P6 était contaminé : les hyperparamètres venaient de
`score_report.json`, sélectionnés sur un split recouvrant des saisons de test.
La sélection se fait désormais par fold. **Attendu : le +3.60 % baisse.**

Le `train.py` ci-dessus n'est pas une reprise de mesure, c'est une
**vérification** : il doit tourner et réécrire `training_report.json` sans la
clé `totals_model`. Les métriques moneyline doivent être identiques à celles du
rapport actuel — le jeu de features n'a pas bougé, seul le mode `full` mort a
disparu. Un écart signalerait que `select_features` ne renvoie plus la même
liste, et c'est le seul risque de S3.

Côté service : après ces changements, `/health` ne porte plus
`trained_models_loaded.totals_model` et `models.totals` affiche
« Modèle de score (Poisson empilé) ». Rien dans `server/` ne lit ces champs
(vérifié), mais un tableau de bord externe qui les lirait le verrait changer.

---

## S — Simplifier

Rangé par rapport bénéfice/risque. Les trois premiers retirent du poids mort
sans rien changer aux prédictions.

> **S1, S2, S3, S5 sont livrés le 2026-08-07.** Aucun ne touche à ce que voit
> l'app : les prédictions servies sont identiques. Reste **S4**, le seul qui
> change les réponses, à faire en dernier. Ce qu'il reste à faire chez toi est
> regroupé plus bas, sous « Mesures en attente ».

### S1. Cesser d'embarquer l'ensemble bootstrap — 8.9 Mo pour rien ✅ LIVRÉ

`models/score_ensemble/` contient 20 membres (8.9 Mo) chargés par
`ml_service.py`, exposés en `probability_std` / `uncertainty`… et **consommés
par aucun code de mise**. C'est la conclusion assumée de P4 : σ reste un
diagnostic, la règle de réduction n'est pas branchée.

Le chargement est déjà entièrement facultatif (`_load_score_ensemble` tolère
l'absence du dossier). Il suffit donc de **ne plus le générer par défaut ni
l'embarquer dans l'image** — `--ensemble 20` reste disponible pour re-mesurer
σ hors ligne quand on en a besoin.

- Gain : −8.9 Mo d'image, un chargement en moins au démarrage
- Risque : nul, le champ devient simplement `null` comme sur `/predict/team`
- [x] `models/score_ensemble/` dans `ml/.dockerignore`
- [x] `train_score.py --ensemble` : défaut 20 → **0**, devient opt-in

Les 20 membres restent sur le disque local et dans Git — seule l'image cesse de
les embarquer. Si tu veux aussi les sortir du dépôt, c'est une décision à part
(`git rm -r --cached ml/models/score_ensemble`), pas faite ici.

### S2. Supprimer `totals_model.json` — repli qui ne peut plus se déclencher ✅ LIVRÉ

La branche totaux de `ml_service.py:1163` ne sert que si `_xgb_score is None`.
Or le modèle de score est chargé, price toute ligne depuis une distribution
complète, et compte correctement le but de prolongation — là où cette branche
applique un Poisson lisse sur un total ponctuel, ce que P2 a mesuré faux de
2.5 à 4.4 points par ligne.

Un repli qui, s'il se déclenchait, donnerait un prix qu'on sait mauvais, n'est
pas un filet de sécurité. Mieux vaut échouer visiblement.

- Gain : 436 Ko, une branche et un jeu de features en moins
- [x] `ml_service.py` : branche totaux, `_xgb_totals`, `_TOTALS_FEAT_NAMES`,
      `_totals_importances`, chargement de `feature_importance_totals.json`
- [x] `train.py` : `train_totals`, `select_totals_features`, `TOTALS_KEYWORDS`,
      helpers `mae`/`rmse` devenus orphelins
- [x] `/health` : `models.totals` reflète le modèle de score ;
      `totals_model` retiré de `trained_models_loaded` (non consommé côté serveur —
      vérifié, aucune occurrence dans `server/`)
- [ ] **Sur ta machine :** supprimer `ml/models/totals_model.json` et
      `ml/models/feature_importance_totals.json` (plus aucun producteur ni
      lecteur ; laissés en place ici pour que la suppression soit un commit à toi)

### S3. Supprimer le mode `--features full` — 117 features mortes ✅ LIVRÉ

P5 a tranché : 13 features battent 117. Le mode `full` et la machinerie de
sélection qui va avec ne sont plus qu'un piège — le jour où quelqu'un le
relance, il obtient un modèle moins bon sans s'en apercevoir.

- [x] `CORE_FEATURES` devient le seul jeu ; `--features` et le paramètre `mode`
      de `select_features()` disparaissent (appel mis à jour dans
      `backtest_walkforward.py`, seul autre consommateur)
- [x] `training_report.json` n'écrit plus `feature_mode` ni `features.totals`

### S4. Servir le moneyline depuis le modèle de score — supprimer `game_model.json`

**C'est le vrai ménage, et c'est aussi une amélioration.** Aujourd'hui le
moneyline servi vient du classifieur (`ml_service.py:1110`), alors que
`_apply_score_model` sait déjà le produire (`ml_service.py:581`) et le fait
**mieux** : log-loss **0.6664** contre **0.66819** pour le classifieur CŒUR.

On maintient donc deux modèles pour la même quantité, dont le moins bon est
celui qui répond.

Supprimer le classifieur retire d'un coup : `game_model.json` (820 Ko), la
calibration de Platt, le blend modèle ⊕ marché, la branche `_xgb_game`, et
toute la moitié « game » de `train.py`.

#### Ce que la lecture du code a corrigé (2026-08-08) — à ne pas re-chercher

**Trois points de cette section étaient faux ou incomplets.**

**a) ⚠️ Le blend marché est VIVANT, et c'est la vraie difficulté de S4.**
`featureEngineering.ts:238` passe `home_odds_decimal` / `away_odds_decimal` à
chaque appel, donc `market_home_p` est renseigné et `ml_service.py` sert
`blend(classifieur, marché)` — **pas** le classifieur nu. La comparaison
« 0.6664 contre 0.66819 » oppose donc deux modèles nus, alors que la valeur
servie est un troisième objet. Et P1 a mesuré le marché seul à **0.66399**,
meilleur que les deux. **Supprimer le classifieur supprime le blend, et il est
probable que ça dégrade ce qui est servi.** Le gain annoncé (« une prédiction
meilleure ») n'est pas établi ; il faut soit réajuster un blend
`score ⊕ marché` dans `train_score.py`, soit mesurer que s'en passer ne coûte
rien.

**b) `confidence` ne trie rien.** Vérifié : `bestBets.service.ts:221` ne lit que
`res.probability`, et `confidenceFor(score)` dérive son label de la probabilité,
pas du champ ML. Le champ entier 40-95 est **purement d'affichage** —
`MLPredictionCard.tsx` (jauge, seuils de couleur à 55 et 75) et
`DevMLDashboard.tsx`. Le risque de S4 sur ce point est donc cosmétique, pas
comportemental : on ne peut pas casser un ordre de tri qui n'existe pas.

**c) `base_prob` sert au-delà des marchés dérivables.** `last_team_score`,
`period{1,2,3}_winner`, `winning_margin`, `double_chance` le consomment sans
que `_apply_score_model` les couvre. Le remplacement est direct —
`base_prob = dist.p_home_win()` quand le modèle de score est chargé, sinon le
repli logistique `_game_moneyline` — mais il ne va pas de soi et doit être écrit.

#### Ce qu'il faut construire avant de supprimer

1. **`feature_importances` — décomposition λ.** Résolu : XGBoost expose
   `predict(..., pred_contribs=True)`, soit la contribution exacte de chaque
   feature à log-λ, par match. On l'obtient sur la ligne domicile et sur la
   ligne extérieur, puis
   `effet_net(f) = contrib(f, ligne dom) − contrib(f, ligne ext)` : positif =
   pousse vers le domicile. Regroupé en 7 concepts lisibles (attaque, défense
   adverse, gardien, alignement, calendrier, force d'équipe, glace) plutôt qu'en
   noms de colonnes bruts — plus lisible, et **stable si A5 élague** puisqu'une
   colonne retirée disparaît simplement de son groupe. Strictement meilleur que
   des gains XGBoost globaux : c'est par match, signé, et en unités de buts.
2. **`confidence`.** Ne trie rien (cf. b), donc la contrainte réelle est que la
   jauge ne saute pas à l'écran. `_apply_score_model` fournit déjà le
   multiplicateur par marché ; il manque la force du signal, aujourd'hui tirée
   de `win_diff`/`gf_diff`/`form_diff`. L'analogue naturel est |λ_dom − λ_ext|,
   la façon dont le modèle dit lui-même si l'affiche est tranchée. **À calibrer
   sur la distribution actuelle**, pas à poser au jugé.
3. **Le blend — tranché le 2026-08-08 : on le réajuste, on ne le perd pas.**
   `train_score.py` gagnera un blend logistique 2D `logit(p_score) ⊕
   logit(p_marché)`, ajusté sur la tranche de validation, sur le modèle exact de
   ce que `train.py:train_game` fait aujourd'hui pour le classifieur. Les poids
   iront dans `score_report.json` et `ml_service` les appliquera à
   `dist.p_home_win()`.

   La raison est celle de P1 : le marché est le meilleur estimateur connu
   (0.66399, contre 0.6664 pour le modèle de score nu). Jeter son apport pour
   simplifier le service reviendrait à payer une dégradation mesurable en
   échange d'une économie de lignes — mauvais échange. La simplification de S4
   vient de la suppression d'un *modèle* entier, pas de celle du blend.

- Gain : un modèle en moins, ~250 lignes de service
- Risque : **le seul changement de cette liste qui touche ce que voit l'app.**
  À vérifier route par route.
- [x] Sort du blend tranché : réajusté sur le modèle de score
- [ ] Blend `score ⊕ marché` dans `train_score.py` + poids dans `score_report.json`
- [ ] Décomposition λ pour `feature_importances` (`pred_contribs`, 7 groupes)
- [ ] `confidence` depuis λ, calibrée sur la distribution actuelle
- [ ] `base_prob` = `dist.p_home_win()` pour les marchés non dérivables
- [ ] Puis suppression du classifieur, route par route

> **Décision d'ordonnancement (2026-08-08) : rien de tout ceci ne démarre avant
> que les runs A2 et A5 aient tourné.** S4 ne dépend techniquement d'aucun des
> deux, mais c'est le seul chantier qui touche l'app : ouvrir un front sur le
> service pendant que le modèle de score peut encore changer de features (A5)
> obligerait à revérifier les routes deux fois.

### S5. Retirer le chargeur de CSV tiers ✅ LIVRÉ

`_load_local_odds_csv()` accepte n'importe quel CSV déposé dans
`data/raw/odds/`. Le principal candidat — le dataset Kaggle « NHL Full Game &
Betting Statistics » — a des colonnes de paris **factices** (chaque match de
2004 à 2018 : `favorite_moneyline -105`, `over_under 5.5`, `spread -1.5`). Un
chargeur tolérant qui avale silencieusement une source connue fausse est un
piège, pas une commodité.

**Supprimé plutôt que durci.** Un garde « refuse les colonnes constantes »
aurait gardé la surface d'un chemin d'import qui n'a jamais servi : le dossier
ne contient aujourd'hui que des `.htm` SBRO, aucun `.csv`. Les sources restantes
sont nommées et posent chacune leur valeur de `source` dans `odds.csv`.

- [x] `_load_local_odds_csv`, `_ODDS_COL_ALIASES`, `_to_decimal_series`,
      `_norm_any_team` retirés de `fetch_data_v4.py`
- [ ] **À décider :** `ml/data/raw/odds/download_dataset.py` et
      `build_dataset_extra.py` produisent précisément ce CSV factice
      (`nhl_data_extensive.csv`) et n'ont plus de lecteur. Les garder comme
      scraper ESPN de stats de match est défendable ; les garder *dans le
      dossier que le fetcher lisait* ne l'est pas.

---

## A — Améliorer

### A1. Comparer les deux sources de cotes ⛔ IMPOSSIBLE sans plan payant

**Constat, vérifié aux sources le 2026-08-04.** L'endpoint `/v4/historical/`
n'est **pas servi aux clés gratuites** — le plan Starter liste explicitement
« Historical Odds » barré. Le nombre de crédits n'y change rien : ce n'est pas
une question de quota mais d'offre. A1 tel qu'écrit ne peut pas démarrer, et
aucun bricolage ne le contournera.

Le fetch reste **prêt et borné** pour le jour où un plan sera pris :

```bash
export ODDS_API_KEY=...
python fetch_data_v4.py --only odds --odds-api-dry-run \
    --odds-api-from 2021-10-01 --odds-api-to 2022-06-30   # chiffre, ne dépense pas
python fetch_data_v4.py --only odds --odds-api-book draftkings \
    --odds-api-budget 300 \
    --odds-api-from 2021-11-01 --odds-api-to 2021-12-31   # plafond DUR
```

Trois barrières contre une dépense involontaire : le plafond `--odds-api-budget`
(arrêt avant l'appel qui dépasserait), le solde réel renvoyé par le fournisseur,
et le cache disque — rejouer une plage déjà récupérée coûte **zéro**. Un 403
arrête net au premier appel au lieu d'insister.

Ordre de grandeur : 30 crédits l'appel historique, ~33 000 la saison. Une
comparaison de sources n'a pas besoin d'une saison entière — **~300 crédits
(10 appels sur des soirées chargées) donnent 80 à 120 matchs**, largement assez
pour comparer marge et niveau de prix. C'est le backfill complet qui est cher,
pas la vérification.

- [ ] En attente d'un plan payant — rien à faire d'ici là

### A1bis. Collecter le manquant **gratuitement** ✅ LIVRÉ le 2026-08-04

**On ne peut pas acheter le passé, mais on peut accumuler le présent pour 0 €.**
L'endpoint *live* coûte **1 crédit par marché et par région** — pas 10 — et il
est servi aux clés gratuites. Avec 500 crédits/mois, la marge est réelle.

Le serveur appelle déjà cet endpoint toutes les 6 h
(`oddsLogger.service.ts`) et écrit dans la table `odds_log`. Mais il demande
`markets: 'h2h,totals'` et ne stocke que le moneyline et la **ligne** de total :
**ni prix over/under, ni puck line**. Autrement dit il jette exactement ce qui
manque à P6, A2 et A3.

Ajouter `spreads` fait passer l'appel de 2 à 3 crédits — soit **~360
crédits/mois** aux 4 passes quotidiennes actuelles, dans les 500 gratuits.

**Ce que ça débloque, et pourquoi c'est plus qu'un pansement :** la migration
027 a déjà la bonne structure — première passe du jour = ouverture, passes
suivantes = clôture. La ligne gagne donc le **mouvement de cote**, qui est
précisément la matière première d'A3 (CLV). En étendant aux marchés dérivés, la
saison 2026-27 construit toute seule le jeu de données que le projet cherche à
acheter.

**L'arbitrage du quota, qui est le vrai sujet.** Le proxy public et le
collecteur partagent une seule clé. À TTL fixe de 5 minutes, le proxy vaut à
lui seul ~288 appels/jour — un dimensionnement de plan payant, qui viderait
500 crédits en une journée. `oddsQuota.ts` arbitre, avec une asymétrie assumée :

| | peut descendre jusqu'à | pourquoi |
|---|---|---|
| Visiteur (proxy) | **0** | une page vide est une perte immédiate et visible |
| Collecteur (job) | `ODDS_USER_RESERVE` (150) | une journée manquée est regrettable, mais différée |

Le solde n'est **jamais estimé** : il est lu dans `x-requests-remaining` à
chaque réponse, y compris en erreur — un 429 porte l'information, et c'est le
moment où elle compte. Il est persisté en base, sans quoi chaque redéploiement
Railway ferait repartir le processus en croyant le quota intact.

Plutôt que de couper le proxy quand les crédits baissent, son TTL s'allonge
(5 min → 15 min → 1 h → 6 h → 24 h). Le visiteur voit des cotes un peu datées
au lieu d'une page vide, ce qui est exactement le compromis voulu.

**Deux pièges traités :**

1. **L'intersaison.** De juin à octobre, quatre passes quotidiennes ramèneraient
   une liste vide pour ~1 000 crédits sur un quota de 500. L'endpoint
   `/v4/sports` est **hors quota** et porte un booléen `active` par ligue : il
   sert de garde gratuit.
2. **Le blocage au démarrage à froid.** Solde inconnu → collecte suspendue par
   prudence → rien ne la débloque tant qu'aucun visiteur n'est passé. Sur un
   site peu fréquenté en début de saison, elle pourrait ne jamais démarrer. Une
   **sonde unique par processus** est concédée ; sa réponse renseigne le solde
   pour de bon.

Simulé sur 31 jours à 500 crédits : la collecte tourne 24 jours puis se
suspend, laissant 138 crédits aux visiteurs.

- [x] `ODDS_LOG_ENABLED=true` (déjà actif en local ; défaut passé à `true`)
- [x] Migration 028 : prix over/under, puck line, état du quota
- [x] `oddsClient` : `markets: 'h2h,spreads,totals'` (2 → 3 crédits l'appel)
- [x] `oddsQuota.ts` — arbitre partagé, réserve visiteur, TTL adaptatif
- [x] Garde intersaison gratuit + sonde de démarrage à froid
- [x] `exportOddsLogCsv` + `fetch_data_v4` : colonnes propagées, `source` posé
- [x] `oddsQuota.test.ts` — 10 cas dont la monotonie du TTL
- [ ] **Sur ta machine :** `npm test` puis appliquer la migration 028
- [ ] **En production :** `ODDS_LOG_ENABLED=true` et `ODDS_USER_RESERVE`

### A2. Trancher la puck line ✅ MESURÉ le 2026-08-08 — verdict : non réfuté, non confirmable ici

**La prédiction s'est réalisée.** Sans la fuite d'hyperparamètres, l'agrégat
puck line passe de +3.60 % à **+2.00 %** à edge ≥5 %, et culmine à **+2.10 %
(z 1.50)** à edge ≥4 %. Rien de significatif au niveau agrégé. Les totaux
restent condamnés (−3 % environ, z ≈ −3 à tous les seuils) : conclusion
inchangée.

**Le vrai résultat est ailleurs — la décomposition par jambe.** À edge ≥4 % :

| jambe | paris | ROI | z |
|---|---|---|---|
| +1.5 (reçoit les buts) | 3 482 | −0.30 % | −0.23 |
| **−1.5 (donne les buts)** | **463** | **+20.09 %** | **+3.05** |

Tout le profit vient d'un douzième des paris. La dissection de cette jambe passe
sur tous les axes pré-établis : 7/9 saisons positives ; jackknife sans la
meilleure saison +15.98 % ; positif dans les trois tranches de cote (10.8 /
24.3 / 25.0 %) et les trois tranches d'edge ; concentration par équipe non
significative (top-3 = 39 % du gain, témoin à étiquettes mélangées 35 %,
p = 0.270) ; bootstrap P(ROI > 0) = 1.000, IC 95 % [7.47 %, 32.95 %].

**Vérification faite en premier, et elle innocente le code.** L'hypothèse
naturelle devant un edge aussi asymétrique était une erreur de signe : traiter
le domicile comme toujours favori à −1.5, ce qui comparerait `p_home_cover_minus_15`
au prix d'un tout autre événement quand le domicile est négligé. `run_derived`
lit bien `puck_line_home` et bascule sur `p_home_cover_plus_15` quand la ligne
est positive. Ce n'est pas ça.

**Ce qui doit rendre méfiant malgré une dissection propre :**

1. **+20 % de ROI contre une marge de 4.43 %, ce n'est pas la taille d'un edge
   de hockey.** Les edges réels tiennent dans 1 à 3 %. Un chiffre de cet ordre
   ressemble davantage à une propriété de l'échantillon qu'à une inefficience de
   marché.
2. **463 paris, soit ~51 par saison.** La préoccupation d'origine (« 63 % du
   profit sur 300 paris ») ne s'est pas dissipée : elle s'est *concentrée*.
3. **La jambe a été choisie après coup**, comme celle qui portait le profit. Le
   bootstrap sur cette jambe ne corrige rien de cette sélection — c'est
   exactement la malédiction du vainqueur que P4 a mesurée. L'IC [7.47 %, 32.95 %]
   est conditionnel à un choix fait *en regardant les données*.
4. **La couverture 2022-23 s'effondre** : 342 lignes de puck line pour 1 312
   matchs (26 %). C'est la saison la plus récente et l'une des deux négatives de
   la jambe. Si ce sous-ensemble n'est pas aléatoire, il fausse les deux bouts.

En revanche, un reproche à ne PAS retenir : « retirer les 40 plus gros gains
annule le ROI ». À des cotes de 1.74 à 3.75, la queue haute porte
mécaniquement le rendement — ce test recalerait n'importe quelle stratégie à
cotes élevées, y compris une bonne. Le fait que retirer les 5 plus gros gains
laisse +17.54 % est le chiffre pertinent, et il est rassurant.

#### Ce que ça change : la question devient pré-enregistrable

Le mécanisme reste crédible et il est maintenant *spécifique* : les livres
convertissent approximativement le moneyline en puck line, alors que la
distribution des écarts est dentelée au seuil de 2 buts — l'erreur doit se voir
du côté qui **donne** les buts, et c'est ce qu'on observe.

D'où une règle falsifiable, **à figer maintenant, avant de voir la moindre
donnée 2026-27** :

> **Règle A2.** Miser la jambe qui donne les 1.5 buts, quand
> `p_modèle − p_marché ≥ 0.04`. Mise à plat. Aucun autre filtre, aucun autre
> seuil. Critère de succès : **ROI > 0**, pas « ROI ≈ 20 % » — attendre 20 %
> hors échantillon serait ignorer la sélection qui a produit ce chiffre.

**Mais elle ne peut pas être confirmée par le ROI en une saison.** ~51 paris par
an à des cotes ~2.7 : l'écart-type du ROI sur un tel échantillon dépasse
largement l'effet cherché. Il faudrait des années.

**C'est A3 qui devient la voie, et ce n'est plus une préférence méthodologique
mais une nécessité arithmétique.** Le CLV se mesure sur chaque pari comme un
écart de prix, pas comme un résultat binaire : il converge en quelques centaines
de paris là où le ROI en demande des milliers. La collecte A1bis engrange déjà
`spreads` depuis le 2026-08-04, donc le mouvement de ligne sur la puck line
existe. **La règle A2 ci-dessus est le premier client d'A3.**

- [x] Run `--derived` avec sélection par fold — le +3.60 % est tombé à +2.00 %
- [x] Dissection lue ; erreur de signe écartée par lecture du code
- [x] Règle A2 figée ci-dessus (pré-enregistrement)
- [ ] Vérifier pourquoi 2022-23 n'a que 26 % de couverture puck line
- [ ] Évaluer la règle A2 en **CLV** (cf. A3), pas en ROI
- [ ] Ne rien miser d'ici là. « Non réfuté » n'est pas « établi ».

### A3. Mesurer contre la ligne d'OUVERTURE, et mesurer le CLV ⭐⭐ PROMU

> **A2 a fait de ce poste le chemin critique du projet.** Ce n'était « que » la
> piste la plus prometteuse ; c'est désormais la **seule** façon d'évaluer la
> règle A2 dans un délai utile — ~51 paris par saison ne permettront jamais de
> conclure sur un ROI. Le premier client d'A3 est nommé et sa règle est figée.

**L'idée la plus prometteuse du plan, et elle n'était pas mesurable avant.**

Tout ce qui a été mesuré jusqu'ici l'a été contre la cote de **clôture** —
l'estimateur le plus dur qui existe, celui qui intègre toute l'information
jusqu'à la mise au jeu. Résultat : trois chemins indépendants disent qu'il n'y
a rien. C'est cohérent, et c'est peut-être surtout la mauvaise question.

**On ne parie jamais la clôture.** On parie ce qui est affiché au moment où on
mise. Les snapshots 5 minutes de The Odds API rendent enfin mesurables deux
choses distinctes :

1. **Le modèle bat-il la ligne d'ouverture ?** Repère bien plus faible que la
   clôture. S'il ne la bat pas non plus, le dossier moneyline est clos pour de
   bon et on arrête d'y penser.
2. **Le CLV — closing line value.** Les paris du modèle sont-ils du bon côté du
   mouvement de ligne ? C'est l'indicateur avancé standard d'un edge réel, et
   surtout **il converge beaucoup plus vite que le ROI** : on mesure un écart
   de prix sur chaque pari au lieu d'attendre un résultat binaire très bruité.

Ce second point attaque directement le problème qui bloque tout le projet —
« 300 paris, ce n'est pas assez pour conclure ». Un CLV positif et stable sur
quelques centaines de paris est un signal plus fort qu'un ROI positif sur le
même échantillon.

- [ ] Conserver plusieurs snapshots par match (ouverture, T−3 h, clôture)
      plutôt que la seule clôture — le fetcher les récupère déjà, il les jette
- [ ] Colonnes `*_open` réelles dans `odds.csv` (aujourd'hui volontairement
      vides : un snapshot pré-match n'est pas une ouverture)
- [ ] Mode `--clv` dans `backtest_walkforward.py`

### A4. La fenêtre de confirmation du gardien

P3 a établi que le talent du gardien est réel (0.165 but/match entre quartiles,
à xG subi plat) mais que sa **forme est imprévisible** (r = +0.038). On a donc
cherché au mauvais endroit : l'information exploitable n'est pas de prédire la
performance du partant, c'est de **savoir qui part avant que le marché ait fini
d'ajuster**.

Les partants sont confirmés 1 à 2 h avant la mise au jeu. Avec des snapshots à
5 minutes, on peut enfin mesurer : de combien la ligne bouge à la confirmation,
et en combien de temps. Si l'ajustement prend 20 minutes, la fenêtre existe ;
s'il est instantané, il n'y a rien et on le saura.

C'est une mesure préalable, pas une stratégie — elle dit s'il y a lieu de
construire quoi que ce soit.

- [ ] Extraire la trajectoire des lignes autour de l'heure de confirmation

### A5. Élaguer les features du modèle de score 🔵 outil livré, mesure à lancer

Incohérence de l'état actuel : P5 a élagué le **classifieur** (117 → 13) et
mesuré que l'excès de features coûtait 0.00245 de log-loss en variance pure.
Le **modèle de score** n'a jamais subi le même traitement — il garde 13 colonnes
d'attaque et 7 de défense sans qu'aucune n'ait été testée pour sa stabilité
inter-saisons.

Même méthode que P5 : gain par saison, on garde ce qui est positif sur ≥70 %
des saisons. Simplification et amélioration probable, à faible risque.

```bash
cd ml/python
python backtest_walkforward.py --select-score-features
```

**Comment c'est mesuré.** Pour chaque saison et chaque feature :

    gain = ll_puckline(feature permutée) − ll_puckline(tout intact)

Gain positif = détruire l'information dégrade le prix, donc la feature sert.

Trois décisions prises **avant** de regarder le résultat, parce qu'après il est
trop tard.

**1. La métrique de sélection est la log-loss de la puck line**, sur ses deux
jambes (`P(écart ≥ +2)` et `P(écart ≤ −2)`), τ ajusté par variante. La puck line
est la seule piste vivante du projet : élaguer le moteur de prix sur une métrique
qui ne la price pas optimiserait pour un usage qu'on n'a pas. τ est refait à
chaque variante parce que la correction de marge *est* une correction de la
distribution des écarts — sans elle on mesurerait le biais de P2, pas la feature.
Déviance de Poisson et log-loss moneyline restent affichées, mais ne
sélectionnent rien.

*Ce que ça coûte, mesuré et non supposé* — puissance simulée, 9 saisons de
1 300 matchs, seuil 7/9 :

| effet de la feature sur λ | puck line | déviance |
|---|---|---|
| 2 % (σ log-λ) | **53 %** | 77 % |
| 5 % | 92 % | 100 % |
| 10 % | 100 % | 100 % |

Une feature à petit effet a donc une chance sur deux de passer inaperçue. C'est
le prix de la pertinence : le tableau dira « je ne sais pas » plus souvent. Le
garde-fou contre un élagage excessif est l'étape de contrôle finale.

**2. L'ablation permute la colonne au lieu de la supprimer.** C'est ce qui durcit
les verdicts GARDER. En supprimant, la variante tournait avec une colonne de
moins que celle sur laquelle les hyperparamètres avaient été choisis : elle
partait handicapée par la dimension autant que privée d'information, le gain s'en
trouvait gonflé, et GARDER devenait trop facile. En permutant, elle garde le même
nombre de colonnes, la même structure, la même adéquation aux réglages — seule
l'information disparaît. La vraie suppression n'est pas perdue, elle devient
l'étape de confirmation. **Classement par permutation, confirmation par
suppression.**

**3. `is_home` est marqué structurel, `elo_atk_minus_def` ne l'est pas.** Les
deux lignes d'un match ne diffèrent que par l'orientation atk/def, le signe de
`elo_atk_minus_def` et `is_home` — c'est ce dernier qui porte l'avantage de la
glace, que rien d'autre ne peut exprimer. S'il ressortait RETIRER, ce serait une
preuve que l'instrument est cassé, pas une information. `elo_atk_minus_def` reste
testable : s'il ressort RETIRER, ça veut dire que l'xG glissant subsume l'ELO, et
c'est une information réelle et exploitable.

**Les sentinelles, qui étalonnent tout le reste.** Trois colonnes de bruit pur
sont injectées et subissent exactement la même ablation. Elles ne contiennent
rien : tout ce qu'elles décrochent est ce que la procédure donne gratuitement —
biais résiduel des hyperparamètres, non-déterminisme de XGBoost, hasard du
découpage. **Une feature ne décroche GARDER que si elle bat la meilleure
sentinelle** ; sinon elle est marquée `SOUS SENTINELLE`, c'est-à-dire « au-dessus
du seuil, mais pas au-dessus du bruit ». Plutôt que d'argumenter sur l'ampleur du
biais, on le fait courir dans le tuyau et on regarde ce qu'il produit.
`--sentinels 10` affine la barre.

Le repère théorique (9.0 % de chances d'atteindre 7/9 à pile ou face, donc ≈ 2
faux GARDER sur 21 candidates) reste imprimé en complément, avec l'avertissement
qui se déclenche si le nombre de gardés n'en est pas distinguable.

**Le mode n'élague rien tout seul.** Il écrit `score_feature_selection.json` et
un tableau ; `ATK_COLS` / `DEF_COLS` se modifient à la main après lecture. Un
élagage appliqué automatiquement sur un tableau qu'on n'a pas lu est une
sélection sur le bruit.

**Lire les sentinelles avant le tableau.** Leur **médiane** est le diagnostic de
la procédure : une colonne de bruit doit avoir un gain positif une fois sur
deux, donc une médiane près de 50 %. Si elle s'en écarte franchement, la
permutation n'a pas neutralisé le biais qu'elle visait et tout le tableau hérite
du décalage — le mode le signale. Leur **maximum** est la barre à battre ; s'il
atteint le seuil, c'est du bruit qui fixe la barre, elle devient sévère et une
feature recalée de justesse n'est pas condamnée pour autant. Plus de sentinelles
rend la barre moins bruitée mais **plus haute** : c'est un maximum, pas une
moyenne.

- [x] Mode `--select-score-features` dans `backtest_walkforward.py`
      (+ `--keep-share`, `--sentinels`, cache reprenable après interruption)
- [x] Rejoué de bout en bout sur données synthétiques avec un faux XGBoost —
      c'est ce qui a sorti le `KeyError` sur les sentinelles (la recherche
      d'hyperparamètres empile sans elles ; elle tourne désormais sur les
      features réelles seules, cf. le commentaire dans le code)
- [ ] **Sur ta machine :** lancer la mesure. Sur 14 saisons c'est **364
      entraînements**, compter quelques heures. Interruptible : le cache
      `score_ablation_cache.json` reprend là où ça s'est arrêté.
      `--min-season 2016` réduit à ~260 fits si besoin, au prix de puissance.
- [ ] Lire le tableau, décider de l'élagage, modifier `ATK_COLS`/`DEF_COLS`
- [ ] Contrôle : réentraîner en **supprimant réellement** les « RETIRER » et
      vérifier que la log-loss puck line **ne monte pas**. C'est ce qui rattrape
      la perte de puissance du point 1 : une simplification qui dégrade n'en est
      pas une.

### A6. Marchés que le modèle price déjà et qu'on ne vérifie pas

`score_model.py` produit team totals, prolongation, écarts alternatifs (±2.5) —
priçables mais jamais confrontés à des prix réels, faute de données. The Odds
API en couvre une partie. À regarder **après** A1 et A2, pas avant : ouvrir un
nouveau front avant d'avoir tranché la puck line multiplierait les tests sans
multiplier les données.

---

## Ordre

L'ordre a changé le 2026-08-04 : A1 devait tout conditionner, mais l'historique
est réservé aux plans payants. Ce qui ne coûte rien passe donc devant.

```
fait                    A1bis — collecte des marchés dérivés + arbitrage quota
                        → la saison 2026-27 se construit gratuitement
                        S1, S2, S3, S5 — ménage, prédictions inchangées (2026-08-07)

fait                    A2 — mesuré le 2026-08-08. Non réfuté sur la jambe −1.5,
                        non confirmable avec les données disponibles.
                        Règle figée, à évaluer en CLV.

maintenant              A5 (élaguer le modèle de score)     — run à lancer
                        A3 (CLV) — promu chemin critique par A2

ensuite                 S4 — blend score ⊕ marché réajusté, décomposition λ,
                        confidence, puis suppression du classifieur.
                        Conception faite, code non commencé (volontairement).

quand il y aura         A1 (comparaison des sources) → backfill 2023-2026
un plan payant          puis A2 avec +30 % de volume, A6

à la fin de la saison   A3 (CLV) et A4 (fenêtre gardien), une fois qu'il y a
                        assez de mouvements de cote collectés
```

A1bis débloque A3 et A4, mais pas tout de suite : il faut d'abord que la
collecte ait tourné. **Le compteur démarre maintenant** — chaque journée de
match non collectée est définitivement perdue, la cote de clôture d'hier
n'existant plus nulle part.

---

## ⚠️ Hors ML — clé API exposée

`DEPLOYMENT.md` (~ligne 334) contient une valeur littérale pour
`VITE_ODDS_API_KEY`. Si elle est réelle et que le dépôt a circulé, la
considérer comme compromise : révoquer, régénérer, remplacer par un
`<placeholder>`. À noter aussi que `VITE_*` est **exposé au navigateur** par
construction — d'où le proxy serveur (`odds.routes.ts`) qui garde la vraie clé
sous `ODDS_API_KEY`. Cette ligne contredit l'architecture et devrait
probablement disparaître.
