# Plan ML — ArakIce

> **Ne reste ici que ce qui est ouvert**, plus les conclusions à ne pas re-tester
> (« Acquis »). Les parties terminées ont été retirées le 2026-10-05 — S1, S2, S3, S5,
> A1bis, A5, la décision de payer A1, les bogues corrigés. Version complète :
> `git show 0916b52:ml/REFACTOR_PLAN.md`.

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

---

## S — Simplifier

Rangé par rapport bénéfice/risque. Les trois premiers retirent du poids mort
sans rien changer aux prédictions.

> S1, S2, S3, S5 sont livrés (2026-08-07). Reste **S4**, le seul qui change les
> réponses, à faire en dernier.

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

> **⚠️ Le même oubli subsiste à `backtest_walkforward.py:1556`** — et il n'est
> **pas** corrigé, délibérément. C'est le chemin d'ablation d'A5, une mesure
> **close** (14 saisons, 364 entraînements) : changer le calcul rendrait ses
> chiffres non comparables à ceux déjà publiés. Pire, cette fonction est
> mémoïsée par `_ablation_cache_key`, dont le suffixe `|v2` ne dépend pas du
> code de scoring : corriger sans bumper la clé **mélangerait silencieusement
> anciens et nouveaux résultats dans le même cache**. Si A5 devait un jour
> rouvrir, il faudrait corriger la ligne ET passer la clé en `|v3`. Les trois
> autres `ScoreDistribution` de ce fichier passent bien `p_ot`.

      🐛 **Corrigé au passage :** la mise en page « standard » de
      `MLPredictionCard` (cartes dépliées de `NHLPredictionsPage`) rendait
      `{f.feature}` alors que le champ s'appelle `name` — le libellé du facteur
      était donc **vide à l'écran** à cet endroit. `client` n'ayant pas de
      `tsconfig.json` et son build étant `vite build` seul, rien ne l'avait
      signalé.

      **Ce qui rend le changement sûr, vérifié le 2026-08-25 :** `confidence`
      est un champ d'AFFICHAGE et rien d'autre. `bestBets.service` calcule son
      propre libellé depuis la PROBABILITÉ (`confidenceFor(pct)`), `mlScore()`
      ne lit que `res.probability`, et `ml.routes.ts` fait de même sur sa route
      « single ». Aucun tri, aucun filtre, aucun seuil de mise ne dépend de ce
      champ. Le vieux commentaire de l'étape 6 qui redoutait un effet sur le tri
      visait σ, pas ce signal — il est corrigé.
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

## A — Améliorer

### A1. Backfill payant The Odds API 🔄 EN COURS — 2 saisons sur 4 faites, plan 20K

#### État et calendrier au 2026-10-04

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

### A5. Élaguer les features du modèle de score — clos, non concluant (2026-08-23)

Mesuré, testé, annulé : 14 saisons ne départagent pas ces features (effet ≈ 0,0002). Le jeu
d'origine est conservé. Un seul contrôle reste ouvert :

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

```
maintenant → févr. 27   A1 — 2023-24 (nov., déc.) puis fin 2022-23 (janv., févr.),
                        une plage par mois, ≤ 10 000 crédits, réserve 6 000.
                        Ensuite --clv / --derived sur 4 saisons modernes.

ensuite                 A2 avec le volume du backfill, puis A6.
                        A3 (CLV puck line) dès que les données existent.

après la saison 2026-27 S4 — γ, puis ⑤ (suppression du classifieur).
                        A4 (fenêtre gardien) avec une saison de snapshots.
```

---
