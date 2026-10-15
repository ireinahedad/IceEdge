# Exploration — alternatives à « Poisson indépendant + τ »

*2026-10-15 · scripts : `ml/python/explore_score/` · suites branchées le même jour : `ml/python/game_dynamics.py`*

Cinq pistes testées contre le modèle servi (`score_model.json` + `tau_margin`).
Elles changent toutes la **forme** de la distribution jointe des scores ; aucune
ne change le XGBoost qui produit λ_dom et λ_ext (sauf la piste 3, qui le
concurrence).

## Protocole

- **Mêmes λ pour tout le monde** : ceux du `score_model.json` servi, sur le test
  hors échantillon (4 320 matchs, 2023-03-07 → 2026-10-10). Les paramètres de
  chaque piste sont ajustés sur l'entraînement avec des λ *out-of-fold* (comme
  τ), ou sur les seules saisons **précédentes** (variantes « glissantes »).
- Chaque méthode rend une matrice 14×14 du score réglementaire. Métriques :
  log-vraisemblance du **score exact** (la plus complète), de l'**écart** et du
  **total** exacts, puis log-loss des marchés servis (nul après 60', puck line
  dom −1,5, moneyline avec `p_ot_model`, plus de 5,5 / 6,5, BTTS).
- **Δ apparié** contre Poisson+τ, match par match, avec z = Δ / erreur-type.
  Négatif = mieux. Je ne retiens que |z| ≥ 2 **et** un effet qui survit au
  contrôle de niveau ci-dessous.

### Deux constats avant de lire les tableaux

**1. τ est périmé.** Il est ajusté sur 2008-2021, or le jeu de fin de match
a changé : les gardiens sortent plus tôt et plus souvent.

| | 2010-14 | 2015-19 | 2020-22 | 2023-25 |
|---|---|---|---|---|
| écart ±1 après 60' | 23,2 % | 21,1 % | 18,3 % | **17,9 %** |
| écart ±3 après 60' | 19,8 % | 22,3 % | 23,5 % | **23,6 %** |
| part des buts en filet désert | 3,8 % | 5,0 % | 5,6 % | **6,0 %** |

Sur le test, Poisson+τ prédit encore ≈ 21 % d'écarts ±1 pour 17,9 % observés.

**2. Le test a un biais de niveau.** λ moyen 6,22 buts contre 5,98 observés
(+4 %). Tout ce qui recale le niveau gagne « gratuitement » sur les totaux et le
score exact, sans rien à voir avec la forme. Les conclusions ci-dessous sont
donc vérifiées une seconde fois avec des λ **recalés au niveau observé**
(facteur oracle 0,953 dom / 0,971 ext, identique pour toutes les méthodes —
`s5_robustesse.py`). C'est ce contrôle qui a démonté deux faux positifs.

## Verdicts

| Piste | Score exact (z) | ML / PL / nul | Verdict |
|---|---|---|---|
| 1. Modèle dynamique par période + filet désert | **−2,3** (niveau oracle) | neutres | **À adopter pour les marchés de période**, au choix pour le match entier |
| 2. Copule de Frank | +0,6 (Frank+τ) | neutres | Abandonner |
| 3. Bayésien hiérarchique att/déf (PyMC) | +4,0 (pur) / −3,2 (offset, = niveau) | ML **+4,8** (pur) | Abandonner |
| 4. Simulation tir par tir (xG) | **+5,5** | neutres | Abandonner en avant-match |
| 5. Conway-Maxwell-Poisson | +0,1 (COM+τ) | neutres | Abandonner |
| *bonus* : τ ré-ajusté sur 3 saisons glissantes | **−2,6** (niveau oracle) | neutres | **Correctif minimal à faire tout de suite** |

---

### 1. Modèle dynamique par période, filet désert explicite — `s2_periode_filet_desert.py`

**Principe.** Au lieu de corriger la matrice finale par τ, on fait jouer le
match. Intensité de but par seconde de chaque équipe :

```
r(t) = λ_équipe / 3600 × c(avance de l'équipe, tranche de temps)
```

`c` est mesuré sur `live_goals.csv` (106 000 buts horodatés, 2010-2025) :
buts observés dans la case ÷ exposition en secondes × λ/3600. Tranches : P1,
P2, P3 0-10', 10-15', puis minute par minute de 55' à 60' ; avance bornée à ±3.
La distribution finale vient d'une programmation dynamique exacte (pas de 5 s,
grille 14×14) — pas de simulation, pas de τ. 35 s pour tout le test.

Le filet désert apparaît tel quel dans `c` (entraînement 2010-2020) :

| avance de l'équipe | 57-58' | 58-59' | 59-60' | part FD à 59-60' |
|---|---|---|---|---|
| −1 (gardien sorti, 6 c. 5) | 1,01 | 1,49 | **2,45** | — |
| +1 (vise le filet vide) | 0,87 | 2,69 | **7,10** | 97 % |
| +2 | 2,43 | 4,60 | **6,08** | 93 % |
| 0 (on joue la prolongation) | 0,69 | 0,74 | **0,57** | — |

Fenêtre 2023-2025 : le +1 à 58-59' passe de 2,69 à **4,09** — c'est la dérive
du tableau précédent, que le modèle absorbe en se ré-ajustant.

**Match entier** (niveau oracle, multiplicateurs « relatifs » qui n'apprennent
pas le niveau) :

| | score exact | écart exact | nul 60' | PL −1,5 | ML |
|---|---|---|---|---|---|
| Dynamique, train | −0,0029 (z −2,3) | z −0,6 | z +0,4 | z +1,8 | z +0,6 |
| Dynamique, glissant | −0,0049 (z −2,3) | z −1,4 | z +2,2 | z +0,3 | z +0,6 |
| τ glissant | −0,0052 (z −2,6) | z −2,6 | z +1,1 | z +1,4 | z +1,0 |

Distribution des écarts sur le test (dynamique glissant) : nul 22,1 % / ±1
18,4 % / ±3 25,4 % pour 22,1 / 17,9 / 23,5 observés — bien meilleur que
Poisson+τ (21,9 / 21,2 / 21,3). Mais **ni le moneyline ni la puck line ne
bougent**, et la version glissante dégrade un peu le marché « nul 60' » (z +2,2) : la forme fine se paie sur le score exact, pas sur les marchés
binaires principaux. Un τ ré-ajusté sur 3 saisons fait aussi bien pour le
match entier, en 10 lignes.

**Marchés de période** (là où il gagne vraiment). L'heuristique actuelle
(`period{1,2,3}_total_goals` : Poisson de part fixe 30,5 / 36,5 / 33 %) contre
le modèle dynamique glissant, niveau oracle, 4 201 matchs horodatés :

| marché | observé | heuristique | dynamique | Δ log-loss | z |
|---|---|---|---|---|---|
| P2 total > 2,5 | 33,0 % | 37,2 % | 34,8 % | −0,0032 | **−4,2** |
| P3 total > 0,5 | 89,4 % | 86,0 % | 88,4 % | −0,0047 | **−4,7** |
| P3 total > 1,5 | 65,0 % | 58,6 % | 63,2 % | −0,0079 | **−5,5** |
| P3 total > 2,5 | 36,6 % | 31,6 % | 35,8 % | −0,0057 | **−4,0** |
| P1 (toutes lignes) | | | | | \|z\| ≤ 1 |

La 3e période n'est pas « 33 % de λ » : son nombre de buts dépend du score
à 40' (filet désert, poussée de l'équipe menée), d'où une loi plus étalée que
Poisson. Le modèle dynamique le capte, l'heuristique non — ce sont aujourd'hui
nos lignes P3 les plus fausses (−6 points sur P3 > 1,5).

**Bonus non mesurés** (le même moteur les donne) : `last_team_score`, but en
filet désert oui/non, but dans les 2 dernières minutes — aujourd'hui des
heuristiques (§6.11 de `EXPLICATION_ML.md`) — et une distribution à partir de
n'importe quel état en cours de match (base possible pour le live).

### 2. Copule de Frank — `s1_copule_compoisson.py`

θ ajusté sur l'entraînement : **−0,13** (sans τ), soit une corrélation
implicite de −0,02. La corrélation résiduelle observée est −0,016 (train).
Frank seule ≈ indépendance (score exact z +13 contre Poisson+τ) ; Frank+τ
(θ ré-ajusté −0,09, τ ré-ajusté) = Poisson+τ (z +0,6).

**Pourquoi ça ne peut pas marcher** : la dépendance du hockey n'est pas une
corrélation globale. C'est un transfert de masse **±1 → 0 et ±2 → ±3** en fin de
match. Une copule à un paramètre, symétrique et monotone, ne sait pas déplacer
de la masse vers deux écarts à la fois. La « corrélation négative » mesurée est
la trace de ce mécanisme, pas sa cause — τ (ou le modèle dynamique) le modélise
directement.

### 3. Bayésien hiérarchique attaque/défense (PyMC) — `s4_bayes.py`, `s4_eval.py`

Walk-forward : ré-ajusté tous les 14 jours (≈ 50 fois) avec les seuls matchs
passés, fenêtre 400 jours, poids de récence demi-vie 100 jours, NUTS
(2 × 200 tirages), att/déf `ZeroSumNormal` avec σ appris.

- **A « pur »** (α + domicile + att − déf) : moneyline +0,011 (**z +4,8**),
  PL +0,013 (z +5,2). Corrélation avec λ_xgb 0,61 seulement, écart-type de
  log(λdom/λext) 0,093 contre 0,207 : il ne voit que les résultats, pas les
  gardiens, l'alignement, la fatigue. Moyenne géométrique XGB ⊕ A : encore pire
  sur ML (z +2,2).
- **B « offset »** (log λ_xgb + β + att − déf) : score exact z −3,2, ML neutre.
  Mais les résidus d'équipe sont minuscules (σ ≈ 0,01-0,03, écart-type de
  log(B/XGB) 0,014) : le gain vient de **β = recalage de niveau**. XGB recalé au
  niveau oracle fait mieux (z −3,9). Rien d'équipe n'échappe à XGBoost.
- **Incertitude a posteriori** : prédictive (mélange sur tirages) = plug-in à
  10⁻⁴ près. Et l'écart-type a posteriori ne signale pas les matchs où l'on se
  trompe — le quartile le plus incertain a le *meilleur* log-loss (0,651 contre
  0,688). (Chiffres d'un run MCMC ; un nouveau run bouge les z de ±0,2.) Même conclusion que P4 pour l'ensemble bootstrap : σ n'est pas
  actionnable.

### 4. Simulation tir par tir à partir des xG — `s3_tirs_xg.py`

**A. Sachant les tirs réels** (224 000 tirs non bloqués, 2021-22) : les buts
sont *plus* variables que Σ Bernoulli(xG) — Var(G − Σp) = 1,12 × la variance
Poisson-binomiale — et les xG régressent vers la moyenne (quintile haut :
4,62 xG → 4,01 buts ; bas : 1,78 → 2,04). Utile pour le live, pas un défaut.

**B. Avant-match**, il faut simuler le nombre de tirs N. Mesuré sans fuite
(moyennes glissantes 30 matchs) : VMR conditionnelle de N = 1,62, xG/tir 0,072,
qualité de tir commune au match (écart-type réel 0,011 après retrait du bruit
d'échantillonnage). La loi des buts d'une simulation tir par tir est alors une
binomiale négative de dispersion **D ≈ 1,12** (exact : thinning d'un N
sur-dispersé). Or les buts, sachant λ, sont **sous-dispersés** (E[(y−λ)²/λ] =
0,98 dom / 0,93 ext sur le train). La simulation part dans le mauvais sens :
score exact z +5,5 avec τ.

Les gains apparents sur plus de 5,5 / 6,5 (z −2,9 / −4,4) sont un artefact du
biais de niveau : à λ trop haut, élargir la loi rapproche P(plus) de 50 %.

### 5. Conway-Maxwell-Poisson — `s1_copule_compoisson.py`

ν ajusté par équipe-côté sur l'entraînement (paramétrisation par la moyenne) :
**1,022 dom, 1,078 ext** — la sous-dispersion conditionnelle est réelle, et plus
forte que ne le laissait croire le ratio marginal (0,991). Mais COM+τ = Poisson+τ
sur le score exact (z +0,1) ; il gagne un peu sur l'écart (z −2,5) et perd sur
les plus/moins (z +4,5 / +5,5). Rien de net : τ absorbe déjà l'essentiel de la
forme, et la sous-dispersion qui reste est probablement elle-même un effet de
fin de match (une équipe qui mène ralentit).

---

## Recommandations — et ce qui en a été fait (2026-10-15)

1. **τ ré-ajusté sur les 3 dernières saisons — FAIT.** `game_dynamics.py`
   l'écrit dans `game_dynamics.json → tau_margin` (fenêtre 2023-2025 : ±1 →
   0,60 / 0,63 contre 0,70 / 0,73 avant). Le service s'en sert si le moteur
   ci-dessous est refusé, ou avec `SCORE_SHAPE=tau_window`.
2. **Moteur dynamique pour les marchés de période — FAIT.** Revalidé avec le
   code servi (`s7_marches_periode.py`, 4 201 matchs, niveau recalé) : période
   la plus prolifique z −5,1 ; P3 > 0,5 / 1,5 / 2,5 z −4,7 / −5,5 / −4,0 ;
   P2 > 2,5 z −4,2 ; mène après P1 / P2 neutre (|z| < 1). Branché sur
   `period{1,2}_winner`, `period{1,2,3}_total_goals`, `highest_scoring_period`.
3. **Moteur pour le match entier — VALIDÉ puis FAIT.** Walk-forward 2013-2025
   (`s6_walkforward_match.py`, 15 962 matchs, τ et c sur les 3 saisons
   précédentes, critère fixé avant le run) contre Poisson × τ glissant :

   | métrique | Δ (moteur − τ glissant) | z | saisons meilleures |
   |---|---|---|---|
   | score exact | −0,0032 | **−4,0** | 11/13 |
   | écart exact | −0,0006 | −0,8 | 7/13 |
   | nul 60' | +0,0001 | +1,0 | 4/13 |
   | puck line −1,5 | −0,0001 | −0,5 | 9/13 |
   | moneyline | −0,0000 | −0,3 | 8/13 |
   | plus de 5,5 / 6,5 | −0,0001 / +0,0000 | −0,9 / +0,9 | 6/13 |

   Les trois conditions tiennent → adopté. Le moneyline servi est gardé
   identique : la couche de correction reçoit toujours la victoire de
   Poisson × τ (sur laquelle elle a été ajustée), puis la matrice du moteur
   est recalée dessus. La victoire « brute » du moteur est ~1 point plus basse
   que celle de Poisson × τ, uniformément, à log-loss égale (z −0,7).
4. **Ne pas poursuivre** : Frank, COM-Poisson, simulation xG avant-match,
   bayésien comme modèle de λ. Le biais de niveau du test (+4 %) est bien
   celui que corrige `level_layer.json` en service (k = 0,976 au 2026-10-10).

## Reproduire

```
cd ml/python/explore_score
python s0_lambdas.py              # λ du modèle servi : test + OOF train (≈ 10 s)
python s1_copule_compoisson.py    # pistes 2 et 5
python s2_periode_filet_desert.py # piste 1 (≈ 35 s)
python s3_tirs_xg.py              # piste 4 (lit raw/shots/shots_2021-2022.zip)
python s4_bayes.py A ; python s4_bayes.py B ; python s4_eval.py   # piste 3, pip install pymc (≈ 5 min chacun)
python s5_robustesse.py           # contrôle de niveau + τ glissant
python s6_walkforward_match.py    # étape 3 : moteur vs τ glissant, walk-forward 2013-2025
python s7_marches_periode.py      # étape 2 : marchés de période avec le code servi (≈ 7 min)
```

Sorties intermédiaires dans `explore_score/out/` (ignoré par git).
