# Plan ML — ArakIce

> **Ce document ne raconte plus ce qui a été fait.** Il ne garde que deux
> choses : les conclusions qu'il ne faut pas re-tester, et ce qui reste à
> simplifier ou à améliorer. Réécrit le 2026-08-04, tenu à jour depuis.
>
> **État au 2026-08-08.** S1, S2, S3, S5 livrés — prédictions inchangées.
> **A2 mesuré** : la puck line n'est pas réfutée, mais tout tient sur 463 paris
> d'une seule jambe, et l'historique disponible ne permettra pas de trancher.
> Une règle falsifiable est figée ; **A3 (CLV) devient le chemin critique**.
> **A5 est clos (2026-08-23)** : l'élagage a été mesuré, testé et annulé — 14
> saisons ne départagent pas ces features.
>
> **État au 2026-08-23.** L'outillage A3 est livré et **la mesure moneyline est
> faite** : le CLV est réel (placebo à +0,0002) mais il annule tout juste la
> marge au lieu de la battre. Le CLV de la **puck line**, seule piste vivante,
> reste **impossible** sur l'historique. **Une seule décision est ouverte :
> payer ou non un mois de The Odds API — dossier complet en A1.**

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
| Peut-on élaguer les 22 features du modèle de score ? | **Non tranchable.** Retirer les 12 features au niveau du hasard coûte +0.00019 de log-loss puck line, pour une erreur-type de 0.00024. Il faudrait ≈ 154 saisons. | Ablation par permutation 14 saisons + contrôle par suppression réelle (2026-08-23). Voir A5. |
| La puck line est-elle jouable ? | **Non tranché, et la question a changé de forme.** Sans la fuite d'hyperparamètres : +2.10 % à edge ≥4 % (z 1.50). Mais **tout vient de la jambe −1.5** : 463 paris à +20.09 % (z 3.05), pendant que les 3 482 paris +1.5 font −0.30 %. | Walk-forward 9 saisons, prix de clôture réels, sélection par fold (2026-08-08). Voir A2. |

| Bat-on la ligne d'OUVERTURE au moneyline ? | **Presque, et c'est nouveau.** Le CLV est réel (net du placebo +0.0133 à edge ≥4 %, placebo +0.0002), mais la clôture ne valorise ces paris qu'à **−0.25 %** à edge ≥4 % et **+0.44 %** à ≥5 % : le modèle bat l'ouverture d'environ une marge, pas plus. Le +4.30 % réalisé dépasse cela de 1.6-2.3 σ et la dissection l'attribue à la queue (tercile d'edge 1.60/0.36/**10.93 %**, 44 paris sur 3 751 le renversent). | `--clv`, 9 saisons, 19 644 paris aux prix d'ouverture (2026-08-23). Voir A3. |
| Le CLV des TOTAUX vaut-il quelque chose ? | **Non, et c'est un artefact.** Son CLV net est **inférieur à son propre placebo** à tous les seuils (+0.0020 contre +0.0030) : entièrement de la régression vers la moyenne. La clôture les valorise à −3.2 % constant. | Même run. Le placebo est ce qui l'a révélé. |

> **Sur 2022-23, à savoir avant d'interpréter A2.** Cette saison ne compte que
> 342 matchs dans `odds.csv`, et ce n'est pas un trou de couverture de la puck
> line : l'archive SBRO **s'arrête au 2022-11-27**, toutes colonnes confondues.
> C'est l'une des deux saisons négatives d'A2, et elle ne pèse que sept semaines
> de début de saison — la période où les fenêtres glissantes de forme sont à
> peine remplies. Ce n'est pas une saison, c'est un octobre-novembre.
> (Vérifié le 2026-08-23 ; question ouverte depuis A2, close.)

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
python backtest_walkforward.py --confirm-score-features  # contrôle élagage   → A5
python backtest_walkforward.py --clv         # ROI à l'ouverture + CLV        → A3
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

- [x] **Sortis du dépôt le 2026-08-10** — `git rm -r --cached ml/models/score_ensemble`
      + entrée `.gitignore`. Les 20 membres **restent sur le disque local** et
      `ml_service.py` les chargera si le dossier est là ; régénérables par
      `python train_score.py --ensemble 20`.

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
- [x] `ml/models/totals_model.json` et `ml/models/feature_importance_totals.json`
      supprimés du disque (constaté le 2026-08-10 — plus aucun producteur ni lecteur)

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
- [x] **Blend `score ⊕ marché` dans `train_score.py` + poids dans `score_report.json`
      — écrit le 2026-08-25, pas encore exécuté.** `fit_market_blend()` ajuste
      `logit(p_score) ⊕ logit(market_home_p_close)` sur la VALIDATION et mesure
      sur le TEST (seuils 200/100 repris de `train.py:train_game`) ; les poids
      partent dans `score_report.json` sous la clé `blend`, `None` si la
      couverture est insuffisante. `logit`/`fit_logistic`/`apply_logistic` sont
      posées dans **`score_model.py`** — le seul module importé à la fois par
      l'entraînement et par `ml_service`, et qui survivra à la suppression de
      `train.py`. Contrôles ajoutés à `score_model.sanity_check()` (le fit
      retrouve une relation logistique connue à ±0,25). ⚠️ Les poids sont
      ajustés sur des prix de **clôture** alors que le service verra un prix
      antérieur : le poids du marché mesuré est un plafond. `odds_snapshots`
      (A3) permettra un jour de réajuster à T−N heures.
      **Reste à faire : `python train_score.py` sur ta machine, puis lire la
      table log-loss du rapport avant de brancher quoi que ce soit.**
- [x] **`evaluate()` évaluait un autre modèle que celui servi — corrigé le
      2026-08-25.** Elle construisait ses `ScoreDistribution` avec `tau=tau`
      seul, donc avec la constante `P_OT_HOME` de `score_model` (0.5051) et non
      le `p_ot_home` mesuré sur l'entraînement — celui qui part dans
      `score_report.json` et que `ml_service` relit au démarrage
      (`ml_service.py:326`). La table imprimée et le bloc `test` du rapport ne
      décrivaient donc pas tout à fait le modèle servi. `evaluate()` prend
      désormais `p_ot_home` en paramètre.
      **Conséquence à connaître : les chiffres du bloc `test` bougeront
      légèrement au prochain run.** Ce n'est pas une régression. Mesuré sur
      lambdas constantes : P(dom) passe de 0.5169 à 0.5682 quand `p_ot_home` va
      de 0.35 à 0.65 — l'effet réel sera bien plus petit, la valeur mesurée
      étant proche de 0.5051. Les métriques de temps réglementaire (nul,
      dom −1.5) et le MAE du total sont **inchangés** : seuls les marchés qui
      dépendent de la prolongation bougent.

> **⚠️ Le même oubli subsiste à `backtest_walkforward.py:1556`** — et il n'est
> **pas** corrigé, délibérément. C'est le chemin d'ablation d'A5, une mesure
> **close** (14 saisons, 364 entraînements) : changer le calcul rendrait ses
> chiffres non comparables à ceux déjà publiés. Pire, cette fonction est
> mémoïsée par `_ablation_cache_key`, dont le suffixe `|v2` ne dépend pas du
> code de scoring : corriger sans bumper la clé **mélangerait silencieusement
> anciens et nouveaux résultats dans le même cache**. Si A5 devait un jour
> rouvrir, il faudrait corriger la ligne ET passer la clé en `|v3`. Les trois
> autres `ScoreDistribution` de ce fichier passent bien `p_ot`.
- [x] **Décomposition λ pour `feature_importances` — livrée le 2026-08-25.**
      `ml_service._lambda_factor_importances()` lit
      `predict(dmat, pred_contribs=True)` sur la DMatrix à deux lignes déjà
      construite pour le match (donc **zéro prédiction supplémentaire**), fait
      `contrib(ligne dom) − contrib(ligne ext)`, agrège en 7 concepts et
      normalise en parts. `is_home` et `elo_atk_minus_def` se décomposent sans
      traitement spécial : les deux lignes portent des valeurs opposées, l'écart
      des contributions EST l'avantage de la glace et l'écart de force.
      Le regroupement (`_factor_of`) est **par règles et non par table** : une
      colonne ajoutée à `ATK_COLS`/`DEF_COLS` tombe dans le bon groupe sans
      qu'on y touche. Les 22 features actuelles se répartissent en attaque 7 ·
      défense adverse 5 · alignement 4 · gardien 2 · calendrier 2 · glace 1 ·
      force d'équipe 1, et **rien** dans le filet `factor.other`.
      Ça remplace les gains GLOBAUX du classifieur — les mêmes six colonnes pour
      tous les matchs de la saison, avec une `direction` devinée par
      correspondance de chaînes sur le nom de la feature. Le classifieur ne
      reste qu'en repli si le modèle de score ne répond pas ; toute sortie vide
      (booster absent, exception, forme inattendue, total nul) laisse ce repli
      en place — `feature_importances` est de l'affichage, il ne doit jamais
      faire échouer une prédiction.
      **Côté client :** le service envoie une CLÉ (`factor.attack`, …), pas un
      libellé ; 8 entrées EN/FR ajoutées à `i18n`, et `factorLabel()` traduit
      dans les deux endroits qui affichent, en retombant sur la chaîne brute si
      elle n'est pas une clé connue — donc le repli classifieur reste
      affichable tel quel. **Les facteurs sont traduits pour la première fois.**
      `DevMLDashboard` affiche volontairement la clé brute : c'est un outil de
      dev, la clé y est plus informative que le libellé.

      🐛 **Corrigé au passage :** la mise en page « standard » de
      `MLPredictionCard` (cartes dépliées de `NHLPredictionsPage`) rendait
      `{f.feature}` alors que le champ s'appelle `name` — le libellé du facteur
      était donc **vide à l'écran** à cet endroit. `client` n'ayant pas de
      `tsconfig.json` et son build étant `vite build` seul, rien ne l'avait
      signalé.
- [x] **`confidence` depuis λ, calibrée sur la distribution actuelle — livrée le
      2026-08-25.** `train_score.confidence_calibration()` mesure les onze
      déciles de |λ_dom − λ_ext| sur l'ENTRAÎNEMENT (même tranche que τ et
      `p_ot_home`, les trois constantes que le service relit) et les écrit dans
      `score_report.json` sous `confidence`.
      `ml_service._confidence_from_lambdas()` place le match à son **rang** dans
      cette distribution (interpolation entre déciles) et le projette sur
      `[0.45, 0.92]` — exactement les bornes que l'ancienne formule produisait.
      Le multiplicateur de marché s'applique après comme avant, le clamp final
      reste `[0.38, 0.90]` : **seule la SOURCE du signal change.** Un rang plutôt
      qu'un seuil, parce qu'un seuil posé au jugé ferait sauter la jauge et
      deviendrait faux au moindre changement d'échelle du modèle ; là, un écart
      médian donne une confiance médiane par construction.
      Repli intégral sur `|win_diff|·2 + |gf_diff|/3 + |form_diff|` si le rapport
      n'a pas de calibration lisible (rapport d'avant cette date, longueur ou
      signal inattendus, déciles non strictement croissants, NaN) ou si le
      modèle de score ne répond pas pour ce match.

      **Ce qui rend le changement sûr, vérifié le 2026-08-25 :** `confidence`
      est un champ d'AFFICHAGE et rien d'autre. `bestBets.service` calcule son
      propre libellé depuis la PROBABILITÉ (`confidenceFor(pct)`), `mlScore()`
      ne lit que `res.probability`, et `ml.routes.ts` fait de même sur sa route
      « single ». Aucun tri, aucun filtre, aucun seuil de mise ne dépend de ce
      champ. Le vieux commentaire de l'étape 6 qui redoutait un effet sur le tri
      visait σ, pas ce signal — il est corrigé.
- [x] **`base_prob` = `dist.p_home_win()` pour les marchés non dérivables —
      livré le 2026-08-25.** Une fois `score_dist` construit, `base_prob` vient
      du modèle de score. Portée réelle **exactement six marchés**, ceux qui
      retombent sur les heuristiques : `last_team_score`,
      `period{1,2,3}_winner`, `winning_margin`, `double_chance`. Tout le reste
      est déjà pricé par `_apply_score_model` AVANT que `base_prob` soit lu —
      vérifié, `moneyline`, `puck_line`, `total_goals` et `both_teams_score`
      rendent une valeur strictement identique quel que soit `base_prob`.
      Effet mesuré sur une affiche λ 3.35/2.55 : +1,5 à +3,1 points de
      pourcentage selon le marché. `model_type` devient « Modèle de score
      (Poisson empilé) » ; le suffixe « + modèle de score », qui aurait fait
      doublon, est retiré. **`model_version` suit** depuis le 2026-08-26 :
      `score-nhl-v1.0` au lieu de `xgb-nhl-v4.0`, qui identifiait
      l'entraînement du classifieur — l'UI affichant les deux côte à côte,
      « v xgb-nhl-v4.0 · Modèle de score (Poisson empilé) » annonçait la version
      d'un modèle qui ne produit plus cette probabilité. Champ purement
      d'affichage, vérifié : aucun usage fonctionnel serveur ni client.
- [x] **Les deux estimateurs exposés côte à côte — livré le 2026-08-25.**
      `probability_score_model` et `probability_classifier` dans `MLResponse`,
      relayés par `mlApiClient.ts`, affichés avec leur Δ dans `DevMLDashboard`
      (et nulle part ailleurs : c'est un outil de dev, pas une information pour
      le parieur). Les deux sont **toujours P(victoire domicile)** — donc
      comparables entre eux, et surtout **pas** à `probability`, qui est la
      probabilité du marché demandé après transformation.
      **Coût zéro en calcul :** depuis ④ le classifieur prédit toujours à chaque
      requête et son résultat était simplement jeté ; on le garde avant de
      l'écraser. Un test structurel (`ast`) verrouille l'ordre des affectations :
      inversé, le champ renverrait silencieusement la valeur du modèle de score.
- [ ] **⑤ Suppression du classifieur — REPORTÉE À APRÈS LE LANCEMENT.**

> ### Pourquoi ⑤ attend, et sous quelle forme il se fera
>
> **1. Il n'y a pas de résultat, il y a une parité.** 0.6642 contre 0.6653 sur
> 4 304 matchs, soit 0.0011 — largement dans le bruit. A5 a coûté 364
> entraînements pour établir exactement ça : qu'un effet de cette taille n'est
> pas résoluble sur l'historique disponible. « Équivalents » justifie ⑤ comme
> simplification **gratuite** ; mais gratuit n'est sans risque que si on est sûr.
>
> **2. ⑤ supprimerait la seule chose qui permettra de trancher.** Les deux
> modèles tournant sur la même requête forment un oracle de comparaison, et
> depuis ④ il ne coûte rien. Surtout : la mesure rigoureuse **hors échantillon**
> viendra toute seule — quand la saison 2026-27 entrera dans
> `nhl_games_v4.csv`, il suffira de relancer `build_dataset.py` puis les deux
> entraînements pour comparer sur des matchs qu'aucun des deux n'a vus. **Ça ne
> marche que si les deux modèles existent encore.** C'est la vraie raison de
> garder `game_model.json` une release de plus, plus que le journal live.
>
> **3. Le gain est de la maintenance, pas de la précision.** `game_model.json`
> pèse 838 Ko dans un service dont le problème RAM documenté (§3 ligne U) se
> compte en centaines de mégaoctets. Réel, mais pas urgent.
>
> **4. Le moment est mauvais.** ④ vient de déplacer six marchés de 1,5 à 3,1
> points et personne ne l'a vu dans un navigateur. Ce qui bloque réellement le
> lancement est de la vérification (§1). Empiler la suppression du seul filet
> par-dessus des changements non vérifiés, c'est garantir de ne plus savoir d'où
> vient un problème.
>
> **Forme retenue (« option 1 »), quand ce sera le moment :** classifieur
> rétrogradé en **repli pur** — `_blend_w` et le chemin nominal supprimés, le
> modèle gardé une release. Réversible, et supprimable pour de bon au
> déploiement suivant si rien n'a bougé.
>
> **⚠️ Option écartée, et à ne pas re-proposer :** « durcir
> `_build_score_distribution` pour qu'il ne rende jamais `None` ». Ça revient à
> retirer le garde-fou `0,5 ≤ λ ≤ 8,0`, qui attrape un vecteur de features mal
> rempli. Ce serait choisir de servir un prix absurde avec assurance plutôt
> qu'une heuristique médiocre.
>
> À traiter avec ⑤ : `double_chance` estime la prolongation avec deux
> heuristiques sur `win_diff` (`ot_rate`, `ot_home`) alors que la distribution
> donne `dist.p_regulation_tie()` et `_score_p_ot` exactement.

#### ✅ Vérification navigateur du 2026-08-26 — ②③④ confirmés, et une question ouverte

Test manuel `/dev/ml` → Service → Run Test, deux affiches.

**Ce qui est prouvé.** `model_type` sert « Modèle de score (Poisson empilé) ».
Les facteurs sortent en clés (`factor.*`) avec des directions contrastées —
`factor.goalie` négatif pendant que `factor.home_ice` est positif — donc la
décomposition est bien propre au match et non figée. Sur COL-SJS
(λ 3.98/2.91), les trois nombres se reproduisent **exactement** hors ligne :

    p_home_win(τ, p_ot mesuré) = 0.6607        → probability 66 ✓
    |λ_dom − λ_ext| = 1.070 → rang 0.918
      → base_conf 0.8813 → confidence 88       → confidence 88 ✓

Le rang 0.918 vient des déciles écrits dans `score_report.json` : ③ est donc
vivant et calibré à l'unité près. Et `probability` (66) suit
`probability_score_model` (66), pas `probability_classifier` (77) — le contrôle
sur marché dérivable passe.

**⚠️ La question ouverte : les deux modèles divergent de 11 points sur une
affiche déséquilibrée.**

| affiche | modèle de score | classifieur | écart |
|---|---|---|---|
| BOS-NYR (équilibrée) | 56 % | 56 % | 0 |
| COL-SJS (déséquilibrée) | 66 % | 77 % | **11 pt** |

Le modèle de score est nettement **plus conservateur dans les extrêmes**. Ce
n'est pas rassurant ni inquiétant en soi — c'est **non mesuré**. Le rapport ne
dit rien là-dessus : `home_win_predicted 0.5491 / observé 0.5400` est une
moyenne, et une moyenne juste est compatible avec des queues fausses dans les
deux sens.

Or c'est exactement là que ça compte : les affiches déséquilibrées sont celles
où un edge se détecte et où une mise se pose. ④ vient de déplacer six marchés
vers l'estimateur le plus prudent des deux, sans qu'on sache lequel a raison
dans les queues.

**La mesure qui répond, et elle est bon marché :** un diagramme de fiabilité sur
les 4 304 matchs de test — regrouper les prédictions par bin de probabilité et
comparer prédit contre observé, pour les DEUX modèles. Les données existent, les
deux modèles existent, ça tourne hors ligne. **Faite le 2026-08-26, section
suivante.**

#### ✅ La réponse — diagramme de fiabilité, 2026-08-26 : c'est le classifieur qui a raison

`python backtest.py --reliability` (mode ajouté ce jour-là ; rapport complet
dans `../models/reliability_report.json`). Il n'a besoin d'**aucune cote** — il
tourne donc là où le mode ROI de ce même fichier s'arrête faute de prix sur la
tranche de test.

**Ce qu'il fait, et pourquoi c'est construit comme ça.**

1. Il reconstruit les DEUX tranches de test — celle de `train.py` (`dropna` sur
   3 colonnes) et celle de `train_score.py` (sur 6) — et vérifie qu'elles
   portent sur les **mêmes matchs**, sur `game_id` et jamais sur la position :
   le tri par date de pandas n'est pas stable, donc à date égale l'ordre peut
   différer d'un frame à l'autre. Si un `dropna` bouge un jour, le mode refuse
   de comparer au lieu de comparer faux.
2. Les probabilités passent par les fonctions d'entraînement elles-mêmes
   (`train_score.stack` / `lambdas_for` / `p_home_from_lambdas`, Platt lu dans
   `training_report.json`) — pas de réimplémentation qui pourrait diverger en
   silence. **Contrôle de validité** : les log-loss retombent sur **0,66421** et
   **0,66532**, soit les 0,6642 / 0,6653 déjà écrits dans `score_report.json` et
   `training_report.json`.

**Le résultat, sur les PROPRES bins de chaque modèle** — le seul test
inattaquable, puisque chacun y est conditionné sur sa propre probabilité :

| modèle | bin | n | annonce | observé | IC 95 % | |
|---|---|---|---|---|---|---|
| score | 0,3-0,4 | 200 | 0,374 | 0,310 | [0,250 ; 0,377] | ✓ |
| score | **0,7-0,8** | **240** | **0,726** | **0,821** | **[0,767 ; 0,864]** | **✗** |
| classifieur | 0,7-0,8 | 349 | 0,743 | 0,719 | [0,670 ; 0,764] | ✓ |
| classifieur | 0,8-0,9 | 86 | 0,826 | 0,837 | [0,745 ; 0,900] | ✓ |

Le classifieur est **dans l'IC dans tous ses bins d'effectif suffisant**. Le
modèle de score en sort dans un seul — et c'est celui des gros favoris. Sur
COL-SJS, **77 % était le bon chiffre, pas 66 %**.

**La compression est symétrique, donc mécanique.** Écart-type des probabilités
0,095 contre 0,120 ; maximum 0,804 contre 0,877 ; 242 matchs au-dessus de 0,70
contre 435. En bas il annonce 0,374 quand l'observé est 0,310, en haut 0,726
quand l'observé est 0,821 : **le même écrasement vers 50 %, dans les deux
queues**. ECE 0,0200 contre 0,0110 ; MCE 0,0953 contre 0,0369.

**Ce qui ne se conclut PAS.** La log-loss globale reste à parité : Δ **apparié**
(score − classifieur) **−0,00111 ± 0,00186**, l'IC contient 0 ; et dans les
extrêmes (n = 937) −0,00172 ± 0,00476, dans le bruit aussi. Le modèle de score
n'est donc pas « moins bon » — il est **mal calibré**, ce qui est un défaut
différent, et lui est réparable. La conclusion de la section précédente (S4 est
une simplification **à parité**) tient toujours ; ce qui change, c'est qu'elle
ne vaut qu'après calibration.

> **Un piège de lecture, laissé exprès dans la sortie.** La table « les extrêmes,
> orientés côté favori » sélectionne sur `p_classifieur`. C'est donc un test de
> calibration pour le CLASSIFIEUR (`E[y | p_c] = p_c`, sa définition même) et
> seulement une **comparaison** pour le modèle de score : rien ne garantit
> `E[y | p_c ∈ S] = E[p_s | p_c ∈ S]` si `p_s` n'est calibré que
> conditionnellement à lui-même. Elle est là pour répondre à « lequel colle à
> l'observé sur les affiches où l'un annonce un gros favori », pas pour décerner
> un brevet de calibration. La preuve, c'est la table des bins propres.

**⚠️ Conséquence directe sur ④.** Les six marchés basculés sur
`base_prob = dist.p_home_win()` (`last_team_score`, `period{1,2,3}_winner`,
`winning_margin`, `double_chance`) sortent une probabilité de favori **trop
basse de ~6 à 10 points** sur les affiches tranchées — donc une EV faussée dans
le sens qui pousse vers l'outsider. Ne pas miser dessus tant que le poste
ci-dessous n'est pas fait. Sur les affiches équilibrées, rien à signaler : bin
0,5-0,6, annonce 0,550, observé 0,550.

#### ✅ La cause isolée, 2026-08-26 (2ᵉ passe) : la prolongation, mais pas seule

Le mode `--reliability` a été étendu pour répondre à « où est la compression ».
Quatre mesures, dans l'ordre où elles se contraignent.

**1. La puck line −1.5, lue dans la même matrice jointe.** Le moyen de savoir si
le défaut appartient à la distribution ou au seul moneyline : un match allé en
prolongation finit forcément à un but d'écart, donc `p_ot_home` **n'entre pas**
dans le prix de la puck line. Résultat : calibrée partout où l'effectif suffit,
ECE **0,0071** contre 0,0200 pour le moneyline.

> ⚠️ **Ce que ce contrôle ne peut pas faire.** La puck line n'a **aucune
> queue** : 4 matchs au-dessus de 0,60, zéro au-dessus de 0,70. Elle est
> calibrée sur 0,15–0,55 — la plage où le moneyline l'est aussi. Ce test est
> donc structurellement incapable de détecter une compression des extrêmes. Il
> ne blanchit pas la distribution ; il dit où elle est saine.
>
> **Ce qu'il tranche pour de bon, en revanche : A2 n'est pas biaisé.** La règle
> opère sur la jambe −1.5 entre 0,15 et 0,55, exactement la plage vérifiée.

**2. La pente de recalibration `a` de `y ~ σ(a·logit(p) + b)`** — la compression
en un nombre, comparable d'un marché à l'autre. Ajustée sur la validation,
re-mesurée sur le test :

| | a (validation) | a (test) |
|---|---|---|
| moneyline — modèle de score | 1,3460 ± 0,0999 | **1,2106 ± 0,0825** |
| puck line −1.5 — modèle de score | 1,0955 ± 0,0948 | 1,0575 ± 0,0793 |
| moneyline — classifieur + Platt | 1,0000 ± 0,0728 | 0,9055 ± 0,0642 |

**3. Le test qui sépare vraiment, et la faute qu'il corrige.** Conclure « le
moneyline sort, la puck line non, donc c'est le moneyline » est le sophisme
classique : « non significatif » n'est pas « nul », et l'IC de la puck line
**contient** la valeur ponctuelle du moneyline. Le seul test honnête porte sur
l'écart, par bootstrap **apparié** sur les matchs (les deux pentes sont
fortement corrélées — même modèle, mêmes affiches) :

    moneyline − puck line : +0,156 ± 0,074, IC 95 % [+0,020 ; +0,303]

Significatif. Le moneyline est bien plus comprimé que la puck line.

**4. La cause, mesurée en face.** Sur les 951 matchs de test allés en
prolongation, le taux de victoire à domicile **par tranche** :

| P(dom) moneyline | n | observé en OT | IC 95 % | vs la constante 0,4996 |
|---|---|---|---|---|
| < 0,45 | 147 | 0,469 | [0,391 ; 0,550] | compatible |
| 0,45–0,55 | 336 | 0,503 | [0,450 ; 0,556] | compatible |
| 0,55–0,65 | 319 | 0,492 | [0,438 ; 0,547] | compatible |
| **≥ 0,65** | **149** | **0,617** | [0,537 ; 0,692] | **✗ hors IC** |

La prolongation n'est pas un pile ou face uniforme : les favoris y gagnent
61,7 %. `p_ot_home` servi comme un scalaire est bien un défaut réel.

#### ✅ Livré le 2026-08-26 : `p_ot_home` dépendant de l'affiche

**Où chaque morceau vit, et pourquoi là.**

| morceau | fichier | pourquoi |
|---|---|---|
| `read_ot_model` · `p_ot_for` | `score_model.py` | Le **contrat partagé**. Trois modules l'appliquent — entraînement, service, mesure ; une formule dupliquée aurait fini par diverger en silence, et la mesure aurait cessé de décrire le service. |
| `fit_ot_model` | `train_score.py` | L'ajustement, à côté de `confidence_calibration` : les deux produisent une constante du rapport, sur la même tranche. |
| `_p_ot_for` | `ml_service.py` | Un délégué de deux lignes, **défini au-dessus du chargeur** — la classe de bogue du 2026-08-25, où un nom défini trop bas devenait une panne muette. |
| lecture du modèle | `backtest.py` | `--reliability` lit désormais `p_ot_model` : il mesure ce qui est **servi**, pas ce qui l'était avant. Et la simulation « ce que la correction donnerait » **se désactive toute seule** quand le modèle est en service, sinon elle empilerait une seconde correction sur la première. |

**Les cinq garde-fous**, tous vers le même repli silencieux (le scalaire) :
effectif < 500 prolongations · coefficients non finis · **pente ≤ 0** (les
favoris perdraient plus souvent leurs prolongations : signe d'un ajustement
raté, pas d'une découverte) · **niveau moyen à plus de 0,02 de la constante** ·
log-loss non améliorée. Côté lecture s'ajoute la validation du rapport lui-même
(signal attendu, `w` de longueur 2, convertible, ordonnée donnant un p_ot entre
0,35 et 0,65).

> Le garde-fou de niveau n'est pas décoratif : c'est **exactement** lui qui
> aurait refusé l'ajustement sur la validation, dont l'ordonnée portait le
> niveau à 0,5226. Un garde-fou écrit d'après une erreur réellement commise.

**Ce qui a été vérifié, et comment.** Tout tourne dans le bac à sable cloud
(xgboost + fastapi installés, cf. la recette) :

1. `fit_ot_model` reproduit à **4 × 10⁻⁶** près les coefficients que
   `backtest.py` avait ajustés indépendamment (+0,2645 / −0,0610) — deux
   chemins de code, même résultat.
2. Le **niveau est conservé au chiffre près** : `mean_fitted` = 0,49956 contre
   une constante de 0,49956.
3. Rapport patché avec `p_ot_model`, `--reliability` relancé : il reproduit
   **exactement** les chiffres que la simulation annonçait — log-loss 0,66368,
   ECE 0,02146, MCE 0,0723, pente 1,1045. Le chemin servi et le chemin simulé
   sont donc le même.
4. `ml_service` importé pour de vrai : `[ML] ✅ Prolongation dépendante de
   l'affiche — σ(+0,2645·Δλ −0,0610)`. Sur COL-SJS (λ 3,98/2,91) le prix passe
   de **0,6607 à 0,6715** (+1,08 pt) ; sur une affiche équilibrée il bouge de
   −0,26 pt. C'est le comportement voulu : corriger les affiches tranchées,
   laisser les autres tranquilles.
5. Les six formes de rapport invalides rendent bien `None`, et sans la clé le
   service écrit `[ML] ℹ️ Prolongation : constante 0.4996`.
6. `python train_score.py --trials 1` de bout en bout : la clé part dans le
   rapport, `evaluate()` price avec le p_ot servi.

**⚠️ Rien n'est actif tant que `train_score.py` n'a pas été relancé** — le
rapport n'a pas encore la clé, et c'est le comportement voulu. Le bloc `test`
du rapport bougera légèrement à ce moment-là : `evaluate()` price désormais avec
le p_ot servi, comme la correction du 2026-08-25 l'avait déjà fait pour le
scalaire.

#### ⏸️ γ — étirer l'écart de λ : reporté après la saison 2026-27

Le correctif de fond, s'il faut y venir : `S = λ_dom + λ_ext` **conservé**,
`δ = log λ_dom − log λ_ext` remplacé par `γ·δ`, un seul paramètre ajusté sur la
validation. Les totaux restent intacts par construction et tous les marchés
dérivés héritent de la correction de façon cohérente.

**Pourquoi on n'y va pas maintenant.** Après la correction de prolongation, la
pente vaut 1,105 ± 0,075 : elle **n'est plus** significativement > 1, alors que
le bin de queue échoue encore. Les deux tests se contredisent, et la raison est
l'effectif — 228 matchs au-dessus de 0,75. Ajuster γ là-dessus, c'est ajuster un
paramètre sur du bruit, exactement ce qu'A5 a conclu pour l'élagage. Le mode
`--reliability` mesure déjà tout ce qu'il faudra pour trancher quand la saison
2026-27 sera dans le dataset ; et il faudra alors vérifier que γ ne dégrade pas
la puck line, aujourd'hui saine.

#### 🐛 Deux bogues attrapés à la première vérification navigateur (2026-08-25)

**1. `ml_service` — ordre de définition, panne silencieuse.**
`_read_confidence_deciles` était définie **plus bas** que l'appel
`_try_load_models()`, qui s'exécute au **chargement du module**. Résultat :
`NameError`, avalé par le `except` du chargeur, qui affichait
`⚠️ score_model.json : name '_read_confidence_deciles' is not defined —
heuristiques conservées` et **désactivait tout le modèle de score** — donc ②,
③ et ④ d'un coup, sans que rien d'autre ne le signale.

Le bloc S4 ③ est remonté au-dessus du chargeur, avec un commentaire qui dit
pourquoi il ne doit pas redescendre. Et un test structurel (`ast`) parcourt
maintenant tout ce que le chargeur appelle, transitivement, et vérifie que
chaque fonction est définie **au-dessus de la ligne d'appel** — c'est la classe
de bogue entière qui est verrouillée, pas ce cas-là.

Leçon générale : le `try/except` du chargeur est là pour qu'un artefact manquant
ne tue pas le service, mais il transforme aussi **n'importe quelle** erreur de
programmation en dégradation muette. Toute fonction appelée depuis
`_try_load_models` doit être définie avant lui.

**2. `DevMLDashboard` — l'onglet Backtest ne s'ouvrait plus.**
`(rows ?? []).map is not a function` : `backtest_derived_report.json` contient
`markets.puckline_diagnostics`, un **objet** (`threshold`, `by_season`,
`by_leg`, `dissection`) ajouté par le run A2, à côté des tableaux `total` et
`puckline`. `Object.entries(...).map` le passait à `roiRows`. Antérieur à S4,
révélé seulement parce que personne n'avait rouvert l'onglet depuis A2.
Corrigé par un **filtre sur `Array.isArray`** plutôt qu'une liste de clés
connues : un diagnostic ajouté plus tard sera ignoré au lieu de casser la page.

**Ajouté dans la foulée :** un menu **Marché** dans le panneau de test (onglet
Service), groupé en « dérivable (distribution) » et « heuristique (base_prob →
S4 ④) ». Sans lui, le bouton envoyait `moneyline` en dur — un marché dérivable,
sur lequel ④ n'a par construction aucun effet : la vérification passait par un
copier-comme-fetch dans les devtools. Un test croise le menu avec le vrai
`_apply_market` et vérifie que **chaque marché se comporte comme son groupe
l'annonce**.

> ### 🔍 Ce que le run du 2026-08-25 a renversé
>
> **`blend` est `null` dans `score_report.json` — et celui du classifieur l'est
> aussi, depuis toujours.** Le blend ⊕ marché n'a **jamais tourné en
> production** : `_blend_w` se lit dans `training_report.json →
> game_model.baselines.market.blend_weights`, et cette clé est **absente** du
> rapport sur disque. `base_prob` a toujours valu le classifieur calibré Platt.
> Le `model_type` servi le confirme : « XGBoost (trained) », jamais
> « XGBoost ⊕ marché (blend) ».
>
> **La cause, chiffrée.** Le découpage est chronologique et les cotes SBRO
> s'arrêtent en pleine saison 2022-23 :
>
> | tranche | n | période | matchs cotés |
> |---|---|---|---|
> | train | 14 631 | 2008-10-19 → 2021-03-30 | 7 843 (53,6 %) |
> | val | 2 582 | 2021-03-30 → 2023-02-26 | 1 980 (76,7 %) |
> | **test** | **4 304** | 2023-02-26 → 2026-04-16 | **0 (0,0 %)** |
>
> Le seuil `tmask > 100` ne peut pas être atteint. Ce n'est pas un défaut de
> `fit_market_blend` : `train.py` bute sur exactement le même mur depuis
> toujours. **Aucun blend marché n'est ajustable tant que les cotes n'atteignent
> pas la tranche de test** — c'est-à-dire tant qu'A1 (backfill payant) ou A1bis
> (collecte accumulée) n'a pas comblé 2023-2026. À porter au dossier A1.
>
> **Ce que ça change pour S4.** La crainte qui retenait ④ et ⑤ — « supprimer le
> classifieur supprimerait le blend et dégraderait le servi » — portait sur un
> blend inexistant. Sur la **même** tranche de test (4 304 matchs, mêmes
> `n_train`/`n_val`/`n_test` des deux côtés) :
>
> | | log-loss moneyline |
> |---|---|
> | modèle de score, sans correction | 0.6640 |
> | modèle de score + τ *(ce qui est servi)* | 0.6642 |
> | classifieur + Platt *(ce qui était servi)* | 0.6653 |
>
> Le modèle de score est **déjà devant**, de peu. S4 est donc une simplification
> à parité, pas un compromis : un modèle entier en moins sans rien payer.
> ① reste écrit et juste — ses poids s'appliqueront par-dessus
> `dist.p_home_win()` le jour où il y aura des cotes à ajuster.
>
> **Calibration du modèle servi**, à garder en tête : τ améliore le nul (0,2136
> prédit contre 0,2210 observé) et la puck line (0,3329 contre 0,3320), mais
> pousse le moneyline à 0,5491 contre 0,5400 observé — +0,9 point de biais
> domicile. Sans τ : 0,5428, mieux calibré, mais nul à 0,1575 contre 0,2210.
> Le compromis actuel privilégie les marchés dérivables ; c'est le bon choix
> tant que ce sont eux qui portent les paris.
>
> Repéré, à traiter avec ⑤ : `double_chance` estime la prolongation avec deux
> heuristiques sur `win_diff` (`ot_rate`, `ot_home`) alors que la distribution
> donne `dist.p_regulation_tie()` et `_score_p_ot` exactement.

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
- [x] **Tranché le 2026-08-10 : supprimés.** `ml/data/raw/odds/download_dataset.py`
      et `build_dataset_extra.py` produisaient précisément ce CSV factice
      (`nhl_data_extensive.csv`) et n'avaient plus de lecteur. Le dossier ne
      contient plus que les `.htm` SBRO.

---

## A — Améliorer

### A1. Backfill payant The Odds API 🔄 EN COURS — 2 saisons sur 4 faites, plan 20K

#### État et calendrier au 2026-10-04 (remplace le dossier ci-dessous)

**Décision du user (2026-09-27) :** plan 20K (20 000 crédits/mois, remis à zéro
le 1er), backfill étalé, livre **DraftKings** (`--odds-api-book draftkings`,
marchés `h2h,spreads` — les totaux sont clos par A3). **Décision du 2026-10-04 :**
ajouter la fin de **2022-23**, qu'aucune source ne couvre (SBRO s'arrête au
2022-11-27 : 342 matchs sur 1 312), et **ne jamais risquer de vider le quota** —
la clé est partagée avec l'app.

| Saison | État | Appels | Crédits |
|---|---|---|---|
| 2025-26 | ✅ 2026-09-27 — 1 339 matchs, 3,9 relevés/match | 950 | 19 000 |
| 2024-25 | ✅ 2026-10-01 — 1 312 matchs, 2,9 relevés/match | 672 | 13 440 |
| 2023-24 | ⏳ 1er nov. + 1er déc. | ~920 | ~18 400 (prudent) |
| 2022-23 (28 nov. → 14 avr.) | ⏳ 1er janv. + 1er févr. | ~670 | ~13 500 (prudent) |

**Comment le coût est chiffré** (le `--odds-api-dry-run` ne donne qu'une borne
haute) : appels réellement payés, comptés dans le cache
`data/raw/odds/oddsapi/` des deux saisons faites, par nombre de matchs de la
soirée (`games_spine.csv`), en gardant pour chaque taille de soirée le PLUS
CHER des deux taux (2025-26 coûtait davantage : plus d'heures de début
distinctes, et 40 jours sans match pendant la pause olympique). 20 crédits
l'appel (`h2h,spreads`, un livre). Taux moyens : 2023-24 ~16 000, fin 2022-23
~11 700. Plages arrêtées au dernier jour de la saison régulière : les séries ne
servent à rien (`build_dataset.py` ne joint que la saison régulière).

**Ce que l'app consomme sur la même clé, chaque mois :** proxy d'affichage
(3 crédits par rafraîchissement, TTL 30 min, jusqu'à ~4 300/mois si le trafic
est continu), collecte live (~300/mois, livres parallèles compris), marchés
supplémentaires si `ODDS_EXTRA_MARKETS` est posé. D'où **~10 000 crédits de
backfill par mois au plus**, et une réserve de compte de **6 000**.

**Deux plafonds durs par run :** `--odds-api-budget 10000` (ce que le run
dépense) et `--odds-api-keep 6000` (nouveau le 2026-10-04 : le run s'arrête
dès que le SOLDE DU COMPTE, lu dans `x-requests-remaining`, descendrait sous ce
seuil — défaut 6 000). Arrêté par l'un ou l'autre : relancer **la même
commande** le mois suivant, le cache rend gratuits les appels déjà payés. Au
passage, corrigé : l'arrêt sur solde se déclenchait APRÈS un appel payé et
jetait sa réponse ; il se déclenche maintenant avant l'appel suivant.

**Les commandes, une par mois, le 1er** (depuis `ml/python`, `ODDS_API_KEY`
posée) :

```bash
# 1er novembre 2026 — 2023-24, partie A (~670 matchs, ~9 300 crédits prudents)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2023-10-10 --odds-api-to 2024-01-14 \
    --odds-api-budget 10000 --odds-api-keep 6000
# 1er décembre 2026 — 2023-24, partie B (~640 matchs, ~9 000)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2024-01-15 --odds-api-to 2024-04-18 \
    --odds-api-budget 10000 --odds-api-keep 6000
# 1er janvier 2027 — 2022-23, partie A (~500 matchs, ~7 200)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2022-11-28 --odds-api-to 2023-02-12 \
    --odds-api-budget 10000 --odds-api-keep 6000
# 1er février 2027 — 2022-23, partie B (~470 matchs, ~6 300)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2023-02-13 --odds-api-to 2023-04-14 \
    --odds-api-budget 10000 --odds-api-keep 6000
```

Après chaque run : vérifier dans le journal la ligne de crédits restants, puis
`python build_dataset.py`. Après le dernier : `backtest_walkforward.py --clv`
(et `--derived`) sur 2022-23 → 2025-26, **quatre** saisons modernes au lieu de
deux — c'est ce qui permettra de trancher le CLV. ⚠️ 2022-23 aura deux sources
dans la même saison (SBRO jusqu'au 27 nov., DraftKings ensuite) : la colonne
`source` d'`odds.csv` permet de les séparer, et le contrôle de recouvrement
SBRO ↔ Odds API (P7, 20 appels faits en janvier 2022) s'applique.

---

#### Historique : le dossier d'avant le paiement (2026-08)


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

#### Le dossier : faut-il payer ? — ouvert, à trancher

**Statut : rien n'est payé, la décision est ouverte.** Ce qui suit est le
dossier, chiffres des deux côtés, pour pouvoir trancher sans le refaire.

#### L'argument pour, en un calcul

Le mode `--clv` imprime lui-même le rapport qui fonde tout ce poste :

```
écart-type du rendement par pari : 1,1542
écart-type du CLV par pari       : 0,0317
paris pour détecter 2 % de ROI   : ~13 321
paris pour détecter 0,5 % de CLV : ~160        → rapport 83×
```

Le CLV converge **83 fois plus vite** que le ROI. Mais le CLV de la **puck
line** — la seule piste vivante — **n'est pas mesurable sur SBRO**, qui ne donne
qu'un prix par match. Le levier existe et ne s'applique pas là où il servirait.

Or A2 produit **463 paris sur 9 saisons, ~51 par saison** sur la jambe −1.5 :

| Chemin | Paris disponibles | Verdict CLV possible en |
|---|---|---|
| **Backfill payant** (2023-24 → 2025-26) | ~154 | **une semaine** |
| Collecte live seule (démarre en octobre) | ~51/an | **~2029** |

**Un mois à 59 $ achète précisément l'échantillon qui rend A2 décidable** —
~154 paris contre les ~160 nécessaires — et maintenant plutôt qu'en 2029. C'est
la seule chose que cet argent achète et qu'on ne peut obtenir autrement :
l'archive SBRO est close, le site est injoignable, l'endpoint historique n'est
pas servi aux clés gratuites.

Le mois donne aussi, sans coût supplémentaire : **~3 900 matchs vraiment hors
échantillon** (il n'en existe aujourd'hui aucun — SBRO s'arrête au 2022-11-27),
**+30 % de volume sur A2 en ROI**, et **A4 enfin mesurable** grâce aux snapshots
à 5 minutes. Le jeu de données reste sur le disque après résiliation.

#### L'argument contre, et il est sérieux

- **Le résultat moneyline du 2026-08-23 est un avant-goût du verdict probable.**
  CLV réel, mais qui annule tout juste la marge : la clôture valorise ces paris
  à −0,25 % (edge ≥4 %) et +0,44 % (≥5 %). Si la puck line se comporte pareil,
  le mois achète un **résultat négatif** — utile pour arrêter de chercher, pas
  pour gagner.
- **Les ~160 paris sont empruntés au moneyline** (écart-type du CLV 0,0317).
  Celui de la puck line est inconnu et pourrait être plus grand, auquel cas
  154 paris ne suffiraient pas.
- **La collecte live est gratuite** et démarre dans cinq semaines. L'attente
  coûte du temps, pas de l'argent.
- **Rien ne se perd en attendant** : la NHL est inactive en août, aucune donnée
  ne file entre les doigts avant la pré-saison.

**Ce qui n'est PAS un argument pour payer :** espérer que les saisons neuves
fassent réapparaître le +4,30 %. La dissection dit qu'il tient à 44 paris et que
l'edge n'y trie pas le rendement. S'il revient, ce sera une surprise.

> **En une phrase :** 59 $ compriment une attente de trois ans en une semaine,
> sur la seule piste encore vivante — et le résultat le plus probable est un
> « non » propre plutôt qu'un « oui ».

**Tarifs revérifiés à la source le 2026-08-23** (ceux du plan dataient du
2026-08-04 et étaient incomplets) :

| Plan | Prix | Crédits/mois | Historique |
|---|---|---|---|
| Starter | gratuit | 500 | ❌ |
| 20K | 30 $ | 20 000 | ✅ |
| **100K** | **59 $** | **100 000** | ✅ |
| 5M | 119 $ | 5 000 000 | ✅ |

**Le plan à 30 $ inclut l'historique** — ce que le relevé précédent ne disait
pas. Il ne suffit pourtant pas : voir le calcul.

**Budget recalculé** (l'ancien « ~33 000 crédits la saison » était faux) :

```
coût d'un appel historique = 10 × marchés × régions
h2h + spreads + totals × 1 région          = 30 crédits
~4 appels par jour de match                = 120 crédits/jour
~186 jours de match par saison             ≈ 22 000 crédits/saison
2023-24 + 2024-25 + 2025-26                ≈ 67 000 crédits
```

→ **le plan 100K à 59 $ couvre les trois saisons avec ~33 % de marge** ; celui à
20 000 crédits ne couvre que ~0,9 saison. Un seul mois suffit, puis résiliation.

#### 🐛 Le fetcher jetait la moitié de ce qu'il payait — corrigé le 2026-08-23

**Exactement le même défaut que côté serveur, et il aurait gâché le mois payé.**
`fetch_odds_api` visite déjà ~4 snapshots par journée de match (un de
reconnaissance à 15:30Z, puis un juste avant chaque heure de coup d'envoi) et
**ne gardait que le dernier**. Les autres étaient téléchargés, facturés, puis
jetés — c'est-à-dire précisément la série temporelle que le CLV réclame.

Un backfill lancé tel quel aurait rendu des **clôtures seules**, donc aucun CLV,
donc aucune confirmation possible du résultat qui motive la dépense.

- [x] Tous les snapshots sont conservés dans **`odds_snapshots_hist.csv`**,
      au schéma de la table `odds_snapshots` (migration 031) : collecte live et
      backfill historique produisent désormais la même forme. **Aucun crédit
      supplémentaire** — ces appels ont lieu de toute façon.
- [x] Fusion idempotente sur (match, horodatage) : une reprise après un arrêt
      sur budget n'efface pas la passe précédente.

> **La décision sur `*_open` est maintenue, pas contournée.** Le commentaire de
> `_oddsapi_row` a raison : « le prix à 15:30Z » n'est pas « la cote
> d'ouverture » de SBRO, et les mélanger dans une même colonne fabriquerait un
> CLV qui compare deux choses différentes selon la source de la ligne, sans que
> rien ne le signale. D'où un fichier séparé où **chaque enregistrement porte
> son horodatage** : la sémantique est dans la donnée, pas dans une convention
> implicite.

- [ ] **Avant de payer :** `--odds-api-dry-run` sur la plage visée. Ne dépense
      rien, chiffre tout.
- [ ] **Étape 1, ~300 crédits :** une plage de recouvrement (2021-22, couverte
      par les deux sources) pour comparer marge et niveau de prix SBRO ↔ Odds
      API. Un ROI qui n'apparaîtrait que d'un côté de la jointure serait un
      artefact de source — c'est le contrôle que le plan exige depuis P7.
- [ ] **Étape 2 :** backfill 2023-10-01 → 2026-06-30, `--odds-api-budget` posé.
- [ ] **Étape 3 :** `build_dataset.py`, puis `--clv` et `--derived` sur des
      saisons que le modèle n'a jamais vues.
- [ ] **Résilier** une fois le backfill en cache — le cache disque rend toute
      reprise gratuite.

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
- [x] **Sur ta machine :** `npm test` et migrations appliquées (2026-08-10)
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

**La collecte est livrée le 2026-08-23.** Ce qui bloquait n'était pas le
stockage mais le quota : un appel ramène déjà tous les matchs du jour, donc
garder chaque passage ne coûte rien de plus. En revanche le budget était dépassé
(4 passes × 3 crédits = 360/mois pour 350 disponibles) et la phase des passes
dépendait de l'heure du dernier déploiement Railway — le dernier prix avant un
match de 19 h ET pouvait dater de six heures. Une « clôture » à T−5 h n'en est
pas une, et le biais va dans le sens optimiste.

Le levier : The Odds API facture **un crédit par marché**, donc une passe
`spreads` seule coûte 1 au lieu de 3. Deux passes complètes (11 h, 17 h ET) plus
quatre passes `spreads` (18 h 45, 19 h 45, 21 h 45, 22 h 45 ET) font
**10 crédits/jour = 300/mois** — six observations pour moins cher que quatre.
Ce qu'on abandonne : le moneyline et les totaux n'ont plus de clôture stricte.
Aucune stratégie vivante ne les price (A2), et ils gardent leur ouverture.

- [x] Conserver plusieurs snapshots par match — table `odds_snapshots`
      (migration **031**). `observed_at` identique pour toute une passe,
      `commence_time` stockée parce que le « T−3 h » est propre à chaque match
      (les soirées s'étalent de 19 h à 22 h 30 ET). `odds_log` est inchangé :
      il reste le contrat de `fetch_data_v4.py`, le logger écrit les deux.
- [x] Calendrier calé sur l'heure de l'Est, chaque créneau se replanifiant après
      coup (`SLOTS` dans `oddsLogger.service.ts`).
- [x] Deux bogues corrigés au passage : la passe lancée 20 s après *chaque*
      démarrage (3 crédits par redéploiement, désormais opt-in via
      `ODDS_LOG_RUN_AT_BOOT`) et les colonnes `*_open` jamais rattrapées — un
      marché non affiché à la première passe gardait une ouverture nulle pour
      toujours.
- [ ] **Mise en service** : migrations 028 + 031 en local, puis
      `ODDS_LOG_ENABLED=true` en prod. La NHL est inactive en août et
      `isSeasonActive()` est hors quota : activer maintenant ne coûte rien.
      Échéance réelle = la pré-saison, fin septembre.
- [x] ~~Colonnes `*_open` réelles dans `odds.csv`~~ — **la case était fausse.**
      Elles ne sont pas vides : `home_ml_open`, `away_ml_open`, `total_open` et
      les prix over/under d'ouverture sont remplis à **100 %** sur les 10 591
      lignes du fichier. La remarque « un snapshot pré-match n'est pas une
      ouverture » ne valait que pour le chemin The Odds API
      (`fetch_data_v4.py:723`) et s'est propagée ici comme si elle valait pour
      tout le fichier. `_parse_sbro_html` lit les colonnes d'ouverture des pages
      SBRO, et `build_dataset.py` en dérive `market_home_p_open` et
      `market_over_p_open`, dévigées. Couverture : **2014-15 → 2021-22
      complètes**, 2022-23 partielle. ~9 800 matchs.
- [x] **Mode `--clv` livré le 2026-08-23.** Sépare les deux questions de ce
      poste : le **ROI aux prix d'ouverture** et le **CLV** proprement dit.
      Imprime en plus la comparaison d'écarts-types qui justifie le poste — sur
      les mêmes paris, combien il en faudrait pour conclure sur un ROI contre
      combien pour conclure sur un CLV.

> **La puck line est absente de ce mode, et c'est la limite qui compte.**
> L'archive SBRO ne donne **qu'un seul prix de puck line par match**
> (`pl_price`), pas une paire ouverture/clôture — contrairement au moneyline et
> aux totaux. **Le CLV de la règle A2 n'est pas mesurable sur l'historique** ; il
> attend `odds_snapshots`. Le mode l'affiche au lieu d'omettre le marché en
> silence.
>
> Ce qui reste utile aujourd'hui : la question 1 ci-dessus (si le modèle ne bat
> pas non plus l'ouverture, le dossier moneyline est clos pour de bon), et le
> rodage de l'outil sur de vraies données **avant** la saison. Découvrir un bogue
> de mesure en janvier, sur trois mois de collecte irremplaçable, serait le pire
> moment possible.

> **Piège traité, qu'une version naïve raterait.** La ligne de total bouge dans
> **17,7 %** des matchs. Quand elle bouge, `market_over_p_open` et
> `market_over_p_close` ne décrivent pas le même pari : leur différence est un
> changement de marché, pas un CLV. Ces paris comptent dans le ROI, pas dans le
> CLV, et le nombre écarté est imprimé — pas de troncature silencieuse.

**Premier run le 2026-08-23.** ROI à l'ouverture : −0,93 % (edge ≥ 2 %),
**+4,30 % à edge ≥ 4 %** (z 2,16, 3 751 paris), +4,30 % à 5 % (z 1,80). Totaux
négatifs partout. CLV brut de +0,0085 à +0,0153 selon le seuil, avec des t
au-dessus de 20.

**La contradiction apparente n'en est pas une.** Le CLV se mesure sur des
probabilités **dévigées**, le ROI paie la **marge de 4,43 %**. Un CLV de
+1,03 point sur un pari à ~45 % vaut ≈ +2,3 % de mise brute ; moins la marge,
≈ −2,1 %. Observé −0,93 % ± 1,4 %. Cohérent. **La barre n'est donc pas
« CLV > 0 » mais « CLV > la marge ».**

**Mais le CLV brut ne mesure pas ce qu'il prétend.** On sélectionne sur
`p_modèle − p_ouverture` puis on mesure `p_clôture − p_ouverture` : les deux
partagent `p_ouverture`, qui porte du bruit. La sélection retient
préférentiellement les matchs dont l'ouverture est trop basse — **y compris par
pur hasard** — et la clôture y remonte mécaniquement. Un modèle **sans aucune
information** produit un CLV positif et massivement significatif. Le CLV qui
monte avec le seuil d'edge est la signature de cette régression vers la moyenne…
et aussi celle d'une vraie compétence. Indiscernables dans la sortie brute.

- [x] **Placebo du CLV, livré le 2026-08-23** — même principe que les
      sentinelles d'A5 : plutôt que d'argumenter sur l'ampleur du biais, on le
      fait courir dans le tuyau. Les probabilités du modèle sont permutées
      **entre les matchs** d'une même saison, et la même sélection est refaite
      **à effectif égal** (pas à seuil égal : un modèle permuté est décorrélé du
      marché, donc ses edges sont plus dispersés). Deux détails sans lesquels le
      placebo serait faux : la permutation est **par match** — les deux côtés
      doivent rester complémentaires — et l'égalisation porte sur le **nombre de
      paris**.
      Validé sur données simulées : modèle sans information → CLV brut +0,0040,
      placebo +0,0041, **net −0,0001** ; modèle parfait → +0,0539 contre +0,0085,
      **net +0,0454**.
- [x] **Dissection du ROI à l'ouverture** branchée sur `dissect()`, le même
      outil qu'A2. Le seuil de 4 % est le **meilleur de cinq testés** : le
      choisir après coup gonfle le z, et c'est exactement ce que la dissection
      est là pour contrôler.

- [x] **Mesuré le 2026-08-23** — 9 saisons, 19 644 paris moneyline. Résultat
      dans le tableau des acquis en tête de document, détail dans
      `../models/backtest_clv_report.json` et `STATUS.md` §3.5.
      Trois enseignements : le CLV moneyline est **réel** (placebo +0,0002) ;
      il **annule tout juste la marge** (la clôture valorise ces paris à −0,25 %
      à edge ≥4 %, +0,44 % à ≥5 %) ; et le +4,30 % réalisé est **au-dessus de ce
      que la clôture justifie de 1,6-2,3 σ**, avec une dissection qui l'attribue
      à la queue. Les totaux sont définitivement clos — leur CLV est **sous leur
      propre placebo**.

- [ ] **Le CLV de la puck line reste à mesurer**, et il faut pour ça des données
      que SBRO n'a pas. Deux chemins, un seul à choisir : le backfill payant
      (A1, dossier chiffré) ou la collecte live (A1bis, gratuite, verdict
      ~2029).

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

### A5. Élaguer les features du modèle de score ✅ CLOS — mesuré, testé, non concluant

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
- [x] **Sur ta machine :** mesure faite le 2026-08-09 — 364 entraînements, les
      14 saisons 2012-2025. L'écriture du rapport a été coupée en route (fichier
      de 356 octets), mais le cache était complet : `score_feature_selection.json`
      a été **reconstruit depuis `score_ablation_cache.json`** le 2026-08-18,
      par différences exactes de valeurs mises en cache, sans réentraîner.
      Seul `n_games` par saison manque, il n'était pas mis en cache.
- [x] **Sentinelles lues en premier** : 50 % / 57,1 % / 64,3 %. Médiane 57,1 %
      → procédure saine, biais résiduel faible. Barre à battre = **64,3 %**.
      Six features passent le seuil de 70 % : `elo_atk_minus_def` (92,9 %),
      `def_ev_xga60_s` (85,7 %), `atk_lineup_pts` (78,6 %), `atk_ev_xgf_pct_s`,
      `atk_stars_out_weight`, `def_goalie_svpct` (71,4 %). `is_home` sort à
      57,1 % mais est structurelle, donc gardée sans vote — et `elo` ressort
      premier, donc l'xG glissant ne subsume pas l'ELO. Le repère théorique
      annonçait ≈ 1,89 faux GARDER sur 21 : **6 gardées se distinguent du
      hasard, mais ~2 d'entre elles sont probablement chanceuses.**
      Tableau complet : `STATUS.md` §3.5.
- [x] **Élagage en deux paliers, 2026-08-23.** Parce que l'ablation est
      marginale et l'élagage collectif : les trois mesures de tir attaquant
      corrélées se partagent le crédit et sortent faibles ensemble, et
      `atk_star_power` / `atk_lineup_xg`, documentées comme complémentaires dans
      `train_score.py`, tombent toutes les deux. Retirer en bloc n'est pas ce
      qui a été mesuré, alors on coupe en deux fois.
      **Palier 1 appliqué** : les 12 features à ≤ 57,1 % — le niveau du hasard
      tel que les sentinelles le mesurent — sortent de `ATK_COLS` / `DEF_COLS`.
      22 → 10 features. **Palier 2 en attente** : les trois à 64,3 % pile
      (`atk_finishing_s`, `def_goalie_gsax60`, `atk_ev_xgf60_s`), à trancher une
      fois le palier 1 confirmé.
- [x] **Mode `--confirm-score-features`** — le contrôle par suppression réelle,
      1 entraînement par saison au lieu de 26. Il compare le jeu tel qu'il est
      écrit dans `train_score.py` aux références par saison du rapport de
      sélection. Sentinelles gardées en même nombre (seule l'information retirée
      change, pas le protocole) ; hyperparamètres re-cherchés pour le jeu réduit
      (les comparer à des réglages taillés pour 22 colonnes mesurerait
      l'inadéquation des réglages, pas l'élagage) ; critère écrit dans le code
      avant le run, avec la bande d'indifférence fixée au bruit des sentinelles.
- [x] **Contrôle lancé le 2026-08-23 — verdict `DÉGRADE`, élagage ANNULÉ.**
      Retirer les 12 features à ≤ 57,1 % donne
      `Δ ll_puckline = +0,00019 ± 0,00024` (erreur-type sur 14 saisons, t = 0,82,
      8 saisons dégradées sur 14 — ce que le pile ou face donne 39,5 % du temps).
      **L'écart est plus petit que sa barre d'erreur.** L'écart-type
      inter-saisons vaut 0,00089 : ≈ 154 saisons seraient nécessaires pour
      résoudre un effet de cette taille. Le critère pré-enregistré tranche sur le
      compte des signes et on s'y tient — mais la conséquence qui compte est que
      **aucun sous-groupe ne serait plus résoluble**, un effet plus petit
      demandant encore plus de saisons. Poursuivre par sous-groupes aurait été un
      tapis roulant. `train_score.py` est revenu à ses 13 + 7 colonnes, avec la
      conclusion écrite en tête du fichier.
- [x] **Pourquoi la puck line reste muette, et ce n'est pas un défaut de mesure.**
      Métriques secondaires, chacune contre son propre bruit de sentinelle :
      déviance **+0,00089** (±0,00037, nettement pire), log-loss moneyline
      **−0,00054** (±0,00015, nettement mieux). Les 12 colonnes retirées portent
      le **niveau** de λ, pas l'**écart** entre les deux équipes. La puck line
      dépend de l'écart : elle tombe entre les deux et ne peut pas trancher.
      C'est le coût annoncé au point 1 (puissance 53 % contre 77 %), payé pour de
      bon.
- [x] **Trois défauts corrigés dans l'outil**, tous révélés par le run : le crash
      JSON (`season` était un `numpy.int64`) ; le bruit de référence désormais
      calculé **par métrique** — juger un écart de déviance (échelle ~1,09)
      contre un seuil calibré sur la log-loss (~0,57) criait au désaccord pour
      rien ; et l'erreur-type + le test des signes affichés à côté du verdict,
      avec un avertissement explicite quand `|Δ| < erreur-type`.

> **Ce que ça coûte de garder les 22 features.** P5 avait mesuré 0.00245 de
> log-loss pour 104 features en trop sur le classifieur. Ici il s'agit de 12,
> dont l'effet mesuré vaut 0.0002. Négligeable — et c'est la raison de ne pas y
> revenir. `score_model.json` reste valide, aucun réentraînement n'est requis.
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

fait                    A5 — mesuré, testé, ANNULÉ (2026-08-23). 14 saisons ne
                        départagent pas ces features. Jeu d'origine conservé.

fait                    A3 — outillage complet (mode --clv, placebo, dissection,
                        odds_snapshots, backfill corrigé) et mesure moneyline :
                        CLV réel mais qui annule tout juste la marge.
                        Le CLV puck line reste impossible sur SBRO.

fait (2026-09/10)       DÉCISION A1 — plan 20K payé, 2025-26 et 2024-25 en
                        cache. Recalage de niveau des buts servi (2026-10-04).

maintenant → févr. 27   A1 — 2023-24 (nov., déc.) puis fin 2022-23 (janv.,
                        févr.), une plage par mois, ≤ 10 000 crédits, réserve
                        de compte 6 000. Ensuite --clv sur 4 saisons modernes.

                        A1bis — mise en service de la collecte live, à faire
                        quelle que soit la décision. Échéance : pré-saison,
                        fin septembre.
                        A3 (CLV) — promu chemin critique par A2

ensuite                 S4 — blend score ⊕ marché réajusté, décomposition λ,
                        confidence, puis suppression du classifieur.
                        Conception faite, code non commencé (volontairement).
                        Plus bloqué par A5 : le jeu de features est figé.

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

- [x] **Le littéral a été retiré de `DEPLOYMENT.md` le 2026-08-10**, remplacé par
      un `<placeholder>` et la note expliquant pourquoi `VITE_*` est public par
      construction — d'où le proxy serveur (`odds.routes.ts`) qui garde la vraie
      clé sous `ODDS_API_KEY`.
- [ ] **Reste à faire hors dépôt :** si cette clé était réelle et que le dépôt a
      circulé, la considérer comme compromise → révoquer et régénérer.
