# Comment le ML d'IceEdge calcule tout — explication complète

> **À qui s'adresse ce document ?** À n'importe qui : il n'y a besoin d'aucune
> connaissance en machine learning. Chaque terme technique est défini la
> première fois qu'il apparaît (et repris dans le lexique, §1). Les formules
> sont données telles que le code les applique, avec le fichier où les trouver.
>
> **Ce que décrit ce document :** l'état du code au 2026-10-02 (modèles
> entraînés présents dans `ml/models/`). Si un chiffre ici ne correspond plus
> au code, c'est le code qui a raison — et il faut mettre ce document à jour.
>
> Les incohérences repérées en écrivant ce document sont listées à part, dans
> [`INCOHERENCES_ML.md`](./INCOHERENCES_ML.md).

---

## Sommaire

0. [Le ML en une page](#0-le-ml-en-une-page)
1. [Lexique](#1-lexique)
2. [Les données brutes](#2-les-données-brutes)
3. [Les variables calculées avant chaque match (features)](#3-les-variables-calculées-avant-chaque-match-features)
4. [Les modèles entraînés](#4-les-modèles-entraînés)
5. [Des deux λ à chaque marché de paris](#5-des-deux-λ-à-chaque-marché-de-paris)
6. [Ce que fait le service ML quand on lui demande une prédiction](#6-ce-que-fait-le-service-ml-quand-on-lui-demande-une-prédiction)
7. [Ce que fait le serveur Node avec ces chiffres](#7-ce-que-fait-le-serveur-node-avec-ces-chiffres)
8. [Comment on sait si le modèle est bon (évaluation)](#8-comment-on-sait-si-le-modèle-est-bon-évaluation)
9. [Mise à jour : rafraîchir et réentraîner](#9-mise-à-jour--rafraîchir-et-réentraîner)
10. [Exemple complet chiffré](#10-exemple-complet-chiffré)
11. [Carte des fichiers](#11-carte-des-fichiers)

---

## 0. Le ML en une page

```
 ┌───────────────────────┐   fetch_data_v4.py / refresh_data.py
 │ DONNÉES BRUTES        │   • API NHL : calendrier + scores officiels
 │ (ml/data/*.csv)       │   • MoneyPuck : xG, tirs, gardiens, patineurs par match
 └──────────┬────────────┘   • Cotes historiques (SBRO, The Odds API)
            │
            ▼  build_dataset.py
 ┌───────────────────────┐   Une ligne par match, uniquement avec des infos
 │ DATASET + ÉTAT        │   connues AVANT le match (moyennes mobiles décalées).
 │ nhl_games_v4.csv      │   + inference_state.json : « l'état actuel » de chaque
 │ inference_state.json  │     équipe/gardien/joueur, pour prédire les prochains
 │ elo_ratings.json      │     matchs.
 └──────────┬────────────┘
            │
            ▼  train_score.py (+ train.py, train_player.py, backtest_walkforward.py)
 ┌───────────────────────┐
 │ MODÈLES               │   • MODÈLE DE SCORE (le cœur) : prédit λ_dom et λ_ext,
 │ (ml/models/*.json)    │     les buts attendus de chaque équipe en 60 minutes.
 │                       │   • Couche de correction : ajuste la victoire (moneyline).
 │                       │   • Classifieur moneyline : calculé, affiché, plus servi.
 │                       │   • Modèle joueur : buts/passes/tirs… attendus par joueur.
 └──────────┬────────────┘
            │
            ▼  ml_service.py (FastAPI, déployé sur Railway)
 ┌───────────────────────┐   λ_dom, λ_ext → matrice de TOUS les scores possibles
 │ SERVICE ML            │   (0-0, 1-0, 2-1, …) → probabilité de CHAQUE marché :
 │ /predict/game/bundle  │   victoire, puck line, totaux, BTTS, prolongation,
 └──────────┬────────────┘   score exact, écart, périodes…
            │
            ▼  server/src/services/*.ts
 ┌───────────────────────┐   • Construit les entrées (forme, repos, gardiens, absents)
 │ SERVEUR NODE          │   • Affiche les % sur les tuiles de la page match
 │                       │   • Compare au marché → « value bets »
 └───────────────────────┘   • En direct : combine l'avant-match + le score actuel
```

**L'idée centrale en une phrase :** le modèle ne prédit pas directement « qui
gagne ». Il prédit **combien de buts chaque équipe devrait marquer en temps
réglementaire** (deux nombres, λ_dom et λ_ext). À partir de ces deux nombres,
on peut calculer mathématiquement la probabilité de **n'importe quel** pari
(victoire, plus de 5,5 buts, gagne par 2, score exact 3-2…), et tous ces
chiffres sont automatiquement cohérents entre eux.

---

## 1. Lexique

| Terme | Signification simple |
|---|---|
| **Feature** | Une variable d'entrée du modèle (ex. « xG pour par 60 min de l'équipe à domicile, moyenne récente »). |
| **Pré-match / sans fuite** | Une feature n'utilise QUE des matchs joués AVANT celui qu'on prédit. Utiliser le résultat du match lui-même serait « tricher » (fuite / *leakage*). |
| **xG (expected goals)** | Buts attendus : chaque tir reçoit une probabilité de devenir un but (selon distance, angle, type…) ; la somme donne les xG. Calculés par MoneyPuck. |
| **xGF / xGA** | xG *pour* (créés par l'équipe) / *contre* (concédés). |
| **par 60** | Ramené à 60 minutes de jeu dans la situation (ex. xG créés à 5 contre 5 par 60 minutes à 5 contre 5). |
| **5on5, 5on4, 4on5** | Situations de jeu : forces égales, avantage numérique (AN), désavantage (PK). |
| **Corsi % (CF%)** | Part des tentatives de tir (cadrées, ratées, bloquées) qui sont celles de l'équipe. Mesure de possession. |
| **GSAx** | *Goals Saved Above Expected* : xG subis − buts encaissés. Positif = le gardien a arrêté plus que prévu. |
| **EWMA** | Moyenne mobile exponentielle : moyenne où les matchs récents pèsent plus. La **demi-vie** (hl) dit après combien de matchs un match pèse moitié moins. hl=6 → très récent ; hl=20 → plus long terme. |
| **ELO** | Note de force d'une équipe (base 1500) qui monte quand elle gagne, baisse quand elle perd, plus fortement si l'adversaire était fort / si l'écart était grand. |
| **λ (lambda)** | Nombre moyen de buts attendus. λ_dom = buts attendus du domicile en 60 min. |
| **Loi de Poisson** | Loi qui donne P(0 but), P(1 but), P(2 buts)… quand on connaît la moyenne λ. Ex. λ=3 → P(0)=5 %, P(3)=22 %. |
| **Matrice jointe M** | Tableau M[i][j] = probabilité que le domicile marque i buts et le visiteur j buts en 60 min. Tous les paris se lisent dedans. |
| **τ (tau)** | Correction de la matrice selon l'écart de score (voir §4.1.4) : corrige le fait que Poisson sous-estime les nuls et les écarts de 3 (filet désert). |
| **XGBoost** | Algorithme d'apprentissage qui empile des centaines de petits arbres de décision. `count:poisson` = il apprend à prédire un λ ; `binary:logistic` = il apprend une probabilité oui/non. |
| **Logit / sigmoïde** | logit(p) = ln(p/(1−p)) transforme une probabilité en nombre de −∞ à +∞ ; la sigmoïde σ(z) = 1/(1+e^−z) fait l'inverse. |
| **Régression logistique** | p = σ(a·x + b) : la formule la plus simple pour combiner des variables en probabilité. |
| **Calibration (Platt)** | Petite régression logistique posée sur la sortie d'un modèle pour que « 60 % » veuille vraiment dire « gagne 6 fois sur 10 ». |
| **Cote décimale** | Gain total pour 1 € misé (1,87 → on récupère 1,87 €). Probabilité implicite = 1/cote. |
| **Dévig (retirer la marge)** | Les probabilités implicites des deux côtés somment à plus de 100 % (la marge du bookmaker). On les normalise : p_dom = (1/c_dom) / (1/c_dom + 1/c_ext). |
| **Edge** | p_modèle − p_marché (dévigée). |
| **EV (espérance de gain)** | p_modèle × cote − 1. Positif = pari rentable *si* le modèle a raison. |
| **Log-loss** | Note d'erreur d'une probabilité (plus bas = mieux). Pile ou face constant = 0,693. Le marché fait ~0,664-0,682 selon les saisons. |
| **Walk-forward** | Test honnête : pour juger la saison S, on entraîne seulement sur les saisons avant S. |
| **CLV** | *Closing Line Value* : la cote prise bat-elle la cote de clôture ? Meilleur indicateur à long terme qu'un ROI bruité. |

---

## 2. Les données brutes

Produites par `ml/python/fetch_data_v4.py` (historique complet) et
`ml/python/refresh_data.py` (mise à jour hebdomadaire de la saison en cours).
Toutes dans `ml/data/` (les gros CSV ne sont pas versionnés dans git).

| Fichier | Source | Contenu |
|---|---|---|
| `games_spine.csv` | API NHL (`api.nhle.com/stats/rest/en/game`) | Tous les matchs de **saison régulière** terminés depuis 2008-09 : date, équipes, score final (fusillade incluse). C'est la « colonne vertébrale ». |
| `mp_team_games.csv` | MoneyPuck `all_teams.csv` | Par équipe et par match, pour chaque situation (`all`, `5on5`, `5on4`, `4on5`) : temps de glace, buts, xG, tentatives de tir, tirs cadrés, xG « haute dangerosité ». |
| `mp_goalie_games.csv` | MoneyPuck (zips par saison) | Par gardien et par match : temps de glace, xG subis, buts encaissés, tirs cadrés. |
| `mp_skater_games.csv` | MoneyPuck (zips par saison) | Par patineur et par match : temps de glace, xG individuel, points, buts, tirs, position. |
| `odds.csv` | SBRO (2007 → 2022-23, archive figée) + The Odds API / DraftKings (2023 →) | Cotes d'ouverture et de clôture moneyline, ligne et prix des totaux, puck line. **Payées, irremplaçables, jamais écrasées.** |
| `arenas.json` | Saisie | Latitude/longitude, fuseau, altitude de chaque aréna (+ déménagements datés). |

**Continuité des franchises.** Les abréviations historiques sont ramenées à la
franchise actuelle : ATL→WPG, PHX→ARI→UTA, etc. (`norm_team`). L'ELO et les
moyennes mobiles suivent donc la franchise, pas la ville.

---

## 3. Les variables calculées avant chaque match (features)

Tout est dans `ml/python/build_dataset.py`. **Règle d'or :** pour la ligne du
match N d'une équipe, on n'utilise que ses matchs 1 … N−1 (on « décale d'un
match » avec `shift(1)`). Le dataset final `nhl_games_v4.csv` a une ligne par
match avec, pour chaque variable, une version `home_…` et `away_…`.

### 3.1 Statistiques d'équipe (MoneyPuck) — `build_team_features`

Pour chaque équipe et chaque match, on calcule la valeur brute du match :

| Variable brute | Calcul (situation) |
|---|---|
| `gf`, `ga` | buts pour / contre (`all`) |
| `xgf60`, `xga60` | xG pour / contre ÷ heures de glace (`all`) |
| `sog_f`, `sog_a` | tirs cadrés pour / contre (`all`) |
| `finishing` | buts − xG (`all`) : « l'équipe marque-t-elle plus que ses occasions ? » |
| `win` | 1 si gf > ga, sinon 0 (une victoire en fusillade compte 0 : c'est un indicateur de forme, pas le résultat officiel) |
| `ev_xgf60`, `ev_xga60` | xG pour / contre par 60 à 5 contre 5 |
| `ev_hdxgf60`, `ev_hdxga60` | xG haute dangerosité par 60 à 5c5 |
| `ev_cf_pct` | tentatives pour ÷ (pour + contre) à 5c5 = Corsi % |
| `ev_xgf_pct` | xGF ÷ (xGF + xGA) à 5c5 |
| `pp_xgf60` | xG créés par 60 en avantage numérique (5on4) |
| `pk_xga60` | xG concédés par 60 en désavantage (4on5) |

Puis, pour chacune, **deux moyennes mobiles exponentielles décalées** :

```
valeur_s = EWMA(demi-vie 6 matchs)  des matchs précédents   (court terme, « forme »)
valeur_l = EWMA(demi-vie 20 matchs) des matchs précédents   (long terme, « niveau »)
```

Il faut au moins 3 matchs précédents (sinon la valeur est vide). Ces moyennes
**traversent les saisons** : au début d'octobre, elles reposent encore surtout
sur la saison précédente (choix assumé, identique à l'entraînement et au
service ; une variante « saison d'abord » existe pour mesure seulement).

**Pour le service** (`inference_state.json` → `teams`), on calcule la même
EWMA mais **en incluant le dernier match joué** : c'est l'état « avant le
prochain match ».

### 3.2 Gardien partant — `build_goalie_features`

- **Qui est le partant ?** Le gardien de l'équipe qui a le plus de temps de glace dans le match.
- **GSAx par 60, régressé vers 0** (le GSAx d'un gardien est très bruité, mesuré r = 0,04 d'un match à l'autre) :

  ```
  goalie_gsax60 = Σ GSAx de ses départs précédents  /  (Σ heures jouées + 50 heures)
  ```
  Les « 50 heures » sont un *a priori* : un gardien sans historique vaut 0 (la
  moyenne), un vétéran est jugé surtout sur sa carrière.
- **% d'arrêts régressé :**
  ```
  goalie_svpct = (moyenne des sv% passés × n + 0,906 × 50) / (n + 50)
  ```
  (0,906 = moyenne de ligue, 50 = départs « fictifs »).
- **`goalie_backup` (gardien de relève) :** 1 si ce partant a commencé **moins de 40 %** des 10 derniers matchs de son équipe (au moins 5 matchs d'historique), sinon 0. Très informatif (6e feature du modèle de score).
- **Pour le service :** pour chaque équipe, les 2 gardiens les plus utilisés sur les 15 derniers départs, avec leurs chiffres de carrière (même formule régressée), leur part d'utilisation récente et `share_last10`.

### 3.3 Projection de l'alignement (« bottom-up ») — `build_lineup_features`

Pour chaque patineur, en pré-match (EWMA demi-vie 20 de ses propres matchs, au moins 2) :

```
xg60_prior  = son xG individuel par 60 minutes
toi_prior   = son temps de glace habituel (secondes)
contrib     = xg60_prior × toi_prior / 3600      ← xG qu'il apporte par match
pts_prior   = ses points par match
```

Pour une équipe dans un match :

```
lineup_xg  = Σ contrib   des patineurs qui ont RÉELLEMENT joué
lineup_pts = Σ pts_prior des patineurs qui ont réellement joué
```

Contrôle d'échelle : en moyenne 2,84 xG par équipe-match (≈ 2,83 buts
réglementaires réels). Un absent fait baisser la projection exactement de sa
contribution habituelle.

**Pour le service**, deux listes :
- `lineups[équipe]` : les 26 joueurs vus sur les 25 derniers matchs de l'équipe, **triés par temps de glace** ; le service garde les 18 premiers (12 attaquants + 6 défenseurs) moins les absents ;
- `skater_pool` : tous les patineurs vus dans la ligue sur 550 jours, indexés par identifiant NHL — utilisé quand l'**alignement officiel** du soir est connu (le service additionne alors exactement les 18 habillés, y compris un joueur qui revient de blessure ou qui vient d'être échangé).

### 3.4 « Star power » et absences pondérées — `build_star_features`

Pour chaque joueur : `ppg` = points par match, EWMA demi-vie 15 (au moins 5 matchs), décalée.

Pour chaque équipe, avant chaque match, on regarde les joueurs **vus sur ses 10 derniers matchs** :

- **top-5** = les 5 meilleurs ppg.
- **`star_power`** = somme des ppg des 3 meilleurs **présents** parmi ce top-5.
- **`stars_missing`** = nombre de joueurs du top-5 qui ne jouent pas.
- **`stars_out_weight`** (absence pondérée) = somme des poids des joueurs-clés absents, sur un groupe de 6 meilleurs attaquants + 4 meilleurs défenseurs :
  ```
  poids = max(ppg, 0,15) × rang          pour un attaquant  (rang 1-2 : 1,0 ; 3-4 : 0,85 ; 5-6 : 0,70)
  poids = max(ppg, 0,15) × 1,6 × rang    pour un défenseur  (rang 1-2 : 1,0 ; 3-4 : 0,75)
  ```
  (le ×1,6 compense la valeur défensive d'un défenseur que les points ne voient pas).

**Pour le service :** le top-5 et la liste des joueurs-clés avec leur poids
précalculé ; le service retire les joueurs que le serveur déclare absents.

### 3.5 Calendrier — `add_schedule`

| Variable | Calcul |
|---|---|
| `rest_days` | jours depuis le match précédent de l'équipe, **plafonné à 7** (3 pour le tout premier match de l'historique) |
| `b2b` | 1 si `rest_days == 1` (dos-à-dos) |
| `3in4` | nombre de matchs joués dans les 3 jours précédents |

### 3.6 Voyage — `add_travel` (calculé, **non utilisé** par les modèles)

Distance depuis l'aréna précédent (formule de haversine), fuseaux traversés,
dénivelé, jours loin de la maison, longueur et rang dans le road-trip, dernier
match du road-trip. Ces colonnes existent dans le dataset mais **aucun modèle
entraîné ne les utilise** (le serveur ne les calcule même plus par défaut).

### 3.7 ELO — `add_elo`

En parcourant tous les matchs dans l'ordre chronologique :

```
attendu_dom = 1 / (1 + 10^(−((R_dom + 50) − R_ext) / 400))        (+50 = avantage de la glace)
marge       = |score_dom − score_ext|  (1 minimum)
multiplicateur = 0,6686 × ln(marge) + 0,8048                      (une victoire large compte plus)
Δ           = 6 × multiplicateur × (résultat − attendu_dom)       (résultat = 1 si le domicile gagne)
R_dom += Δ ;  R_ext −= Δ
```

Entre deux saisons (dès qu'il y a plus de 60 jours sans match), chaque note est
ramenée de 30 % vers 1500 : `R += 0,30 × (1500 − R)`. Les features sont la note
**avant** le match : `elo_diff = R_dom − R_ext` et `elo_expected = attendu_dom`.
Les notes finales partent dans `elo_ratings.json`.

### 3.8 Cotes — section « Cotes » de `main()`

Probabilité du marché dévigée : `market_home_p = (1/c_dom) / (1/c_dom + 1/c_ext)`,
à l'ouverture et à la clôture ; idem pour over/under et puck line. Les prix ne
sont **jamais** des features du modèle de score (seulement du classifieur, §4.2).

### 3.9 Les cibles (ce que le modèle apprend à prédire)

- `home_win` = 1 si score final domicile > visiteur.
- **Prolongation détectée** sans colonne dédiée : un match dont le temps de glace (`all`) dépasse 3 610 s est allé en prolongation (23 % des matchs).
- **Scores réglementaires** : un match allé en prolongation était à égalité après 60 minutes, donc `home_reg_score = away_reg_score = min(score_dom, score_ext)` ; sinon le score final. C'est exact, pas une approximation.

### 3.10 Les écarts (diff)

Pour la plupart des variables : `X_diff = home_X − away_X`. Et l'affrontement
attaque contre défense :

```
xg_matchup_home = home_xgf60_s − away_xga60_s
xg_matchup_away = away_xgf60_s − home_xga60_s
xg_matchup_diff = xg_matchup_home − xg_matchup_away
```

---

## 4. Les modèles entraînés

### 4.1 Le modèle de score — LE CŒUR (`train_score.py`, `score_model.py`)

C'est lui qui produit toutes les probabilités affichées (sauf la petite
retouche de la victoire, §4.3).

#### 4.1.1 Principe : deux lignes par match

Chaque match devient deux lignes « équipe qui attaque contre équipe qui défend » :

| ligne | cible | features `atk_*` | features `def_*` | `is_home` |
|---|---|---|---|---|
| 1 | buts réglementaires du domicile | domicile | visiteur | 1 |
| 2 | buts réglementaires du visiteur | visiteur | domicile | 0 |

plus `elo_atk_minus_def = ELO de l'attaquant − ELO du défenseur`.
Un seul modèle apprend « combien de buts une attaque marque contre une
défense », et `is_home` capte l'avantage de la glace.

#### 4.1.2 Les 26 features

| Côté attaque (`atk_`) | Côté défense (`def_`) |
|---|---|
| `xgf60_s`, `xgf60_l` (xG créés, court/long) | `xga60_s`, `xga60_l` (xG concédés) |
| `ev_xgf60_s` (xG créés à 5c5) | `ev_xga60_s` (xG concédés à 5c5) |
| `ev_xgf_pct_s`, `ev_xgf_pct_l` (part des xG à 5c5) | `ga_s` (buts concédés) |
| `gf_s` (buts marqués) | `pk_xga60_s` (xG concédés en désavantage) |
| `finishing_s` (buts − xG) | `goalie_gsax60`, `goalie_svpct` (gardien adverse) |
| `star_power`, `stars_out_weight` | `goalie_backup` (gardien adverse = relève ?) |
| `pp_xgf60_s` (avantage numérique) | `b2b`, `rest_days` (fatigue de l'équipe qui défend) |
| `rest_days`, `b2b` (fatigue de l'attaque) | |
| `lineup_xg`, `lineup_pts` (alignement du soir) | |

+ `is_home`, `elo_atk_minus_def`.

Les plus importantes (gain XGBoost) : `elo_atk_minus_def` 8,9 %, `is_home` 8,9 %,
`def_xga60_l` 6,3 %, `atk_lineup_pts` 5,8 %, `atk_lineup_xg` 5,7 %,
`def_goalie_backup` 5,5 %.

#### 4.1.3 Entraînement

- Matchs triés par date, découpage **chronologique** : les 20 % les plus récents = **test** (4 304 matchs, du 2023-02-26 au 2026-04-16) ; des 80 % restants, les 15 % les plus récents = **validation** (2 582 matchs) ; le reste = **entraînement** (14 631 matchs, 2008 → 2021).
- XGBoost `count:poisson` : la sortie est directement un λ (buts attendus).
- 30 essais aléatoires d'hyperparamètres, gardé celui qui minimise la *déviance de Poisson* sur la validation ; arrêt précoce sur la validation (meilleure itération : 459 arbres).
- Paramètres retenus : profondeur 4, taux d'apprentissage 0,02, sous-échantillonnage 0,7, colonnes 0,6, `min_child_weight` 20, `reg_lambda` 10.

#### 4.1.4 La correction de marge τ (filets déserts)

Deux lois de Poisson indépendantes se trompent sur les **écarts** de score.
Mesuré : trop peu de matchs nuls après 60 min, trop d'écarts de 1, pas assez
d'écarts de 3. La raison est mécanique : une équipe menée d'un but retire son
gardien → soit elle égalise (écart 1 → 0), soit elle encaisse dans le filet
vide (écart 1 → 2, écart 2 → 3).

On corrige chaque case de la matrice par un multiplicateur qui dépend de l'écart :

```
τ(écart) = fréquence réelle de cet écart / fréquence prédite par Poisson   (mesurée sur l'entraînement)
M'(i, j) = M(i, j) × τ(i − j),  puis on renormalise pour que la somme fasse 1
```

Valeurs actuelles (`score_report.json → tau_margin`) :

| écart (dom − ext) | 0 | ±1 | ±2 | ±3 | ±4 | ±5 | ±6 |
|---|---|---|---|---|---|---|---|
| τ | **1,363** | 0,73 / 0,71 | 0,92 / 0,91 | **1,43 / 1,39** | 1,02 / 0,93 | 0,85 / 0,75 | 0,83 / 0,65 |

Effet mesuré sur le test : nuls après 60 min prédits 15,8 % sans τ → **21,5 %**
avec τ (observé 22,1 %) ; domicile −1,5 : 31,2 % → **33,2 %** (observé 33,2 %).

#### 4.1.5 Qui gagne la prolongation ?

Si c'est nul après 60 minutes, le vainqueur de la prolongation/fusillade reçoit
un but. Probabilité que le domicile la gagne, ajustée sur 3 427 prolongations :

```
p_ot_dom = σ(0,2834 × (λ_dom − λ_ext) − 0,0640)
```

Pour deux équipes égales ≈ 48 % ; si le domicile a 1 but d'avance en λ ≈ 55 %.
(Garde-fous : pente > 0 et niveau moyen entre 35 et 65 %, sinon on utilise la
constante mesurée 0,4996.)

#### 4.1.6 Les autres réglages écrits dans `score_report.json`

- **`confidence.deciles`** : la distribution de |λ_dom − λ_ext| sur l'entraînement (sert à la jauge de confiance, §6.10).
- **`blend`** : un mélange « modèle de score ⊕ marché » est ajusté et mesuré, **mais le service ne l'applique pas** (sur le test : modèle seul 0,6847, marché seul 0,6822, mélange 0,6842).
- **`ensemble`** : vide. L'ensemble bootstrap (20 modèles pour mesurer l'incertitude σ) est désactivé par défaut (`--ensemble 0`) — la mesure a conclu que σ n'était pas exploitable.

### 4.2 Le classifieur moneyline (`train.py`) — encore calculé, plus servi

Historique : c'était le premier modèle. Aujourd'hui sa probabilité est
**calculée à chaque requête et renvoyée dans `probability_classifier`** pour
comparaison, mais la probabilité servie vient du modèle de score.

- XGBoost `binary:logistic` sur la cible `home_win`.
- **15 features** : `elo_diff`, `elo_expected`, `ev_xgf_pct_s_diff`, `ev_cf_pct_s_diff`, `ev_xgf_pct_l_diff`, `xg_matchup_diff`, `goalie_gsax60_diff`, `star_power_diff`, `stars_out_weight_diff`, `rest_days_diff`, `b2b_diff`, `finishing_s_diff`, `win_s_diff`, **`market_home_p_open`, `market_home_p_close`** (les cotes sont des features ; absentes = vide, XGBoost sait gérer).
- Même découpage 80/20 et validation 15 %, 40 essais d'hyperparamètres.
- **Calibration Platt** sur la validation : `p = σ(1,1009 × logit(p_brut) − 0,0781)`.
- **Mélange avec le marché** (si des cotes sont fournies) : `p = σ(0,564 × logit(p_brut) + 0,634 × logit(p_marché) − 0,0557)`.
- Résultats test : log-loss 0,6656 (ELO seul 0,6702 ; constante 0,69), précision 59,4 %.

### 4.3 La couche de correction du moneyline (`correction_layer.json`)

Une régression logistique posée **par-dessus** la victoire du modèle de score,
ajustée en walk-forward strict par `backtest_walkforward.py --correction` :

```
z = 0,0863 + 0,4667 × logit(p_score)
    + Σ coef_k × (x_k − moyenne_k) / écart-type_k
p_corrigée = σ(z)
```

| variable x_k | coef (par écart-type) |
|---|---|
| `b2b_diff` | −0,099 |
| `ev_xgf_pct_s_diff` | +0,086 |
| `ev_xgf_pct_l_diff` | +0,033 |
| `lineup_xg_diff` | +0,065 |
| `star_power_diff` | +0,046 |
| `xg_matchup_diff` | −0,011 |
| `elo_diff` | +0,132 |

Mesure qui a justifié son adoption : log-loss moneyline −0,0021 (z −3,2),
meilleure sur 10 saisons sur 11. Elle **ne modifie que le marché « moneyline »**
— tous les autres marchés sortent de la matrice des scores, non corrigée.
Une variable absente vaut sa moyenne (contribution nulle).

### 4.4 Le modèle joueur (`train_player.py`)

Un modèle XGBoost `count:poisson` **par statistique** : buts, passes, points,
tirs, mises en échec, tirs bloqués, minutes de pénalité, points en AN.

- **Features joueur (pré-match)** : temps de glace moyen sur 5/10/30 matchs, temps en AN sur 10 matchs, xG des coéquipiers sur la glace à 5c5 (20 matchs), xG individuel par 60 (20 matchs), nombre de matchs en carrière, production par 60 minutes sur 10, 30 matchs et carrière pour les 8 statistiques.
- **Contexte du match** : 13 statistiques de son équipe (`tm_…`) et de l'adversaire (`opp_…`) issues de `nhl_games_v4.csv` (buts, xG, tirs, AN/PK, gardien, forme), domicile, repos, dos-à-dos, défenseur ou non.
- Entraînement ≤ 2021-22, arrêt précoce sur 2022-23, test 2023-24 → 2025-26.
- **Dispersion k** (binomiale négative) ajustée par statistique : ≥ 10⁴ = Poisson (buts, passes, points, points AN), 20 (tirs), 8 (mises en échec, tirs bloqués), 0,3 (pénalités).
- Bat la règle actuelle du serveur sur les 8 statistiques (ex. buts : log-vraisemblance −0,4463 contre −0,4566).
- **Pour le service** : `player_state.json` = les features de chaque joueur après son dernier match ; le service les combine au contexte du match à venir.

---

## 5. Des deux λ à chaque marché de paris

Tout part de la matrice M (14 × 14, de 0 à 13 buts par équipe) :

```
M[i][j] = Poisson(i ; λ_dom) × Poisson(j ; λ_ext) × τ(i − j)   puis normalisée à 1
```

Notations : « nul » = case où i = j (égalité après 60 min) ; `p_ot` = probabilité
que le domicile gagne la prolongation (§4.1.5). Code : `ScoreDistribution`
(`score_model.py`) et `_apply_score_model` (`ml_service.py`).

| Marché (`market_type`) | Formule |
|---|---|
| `moneyline` (victoire, prolongation incluse) | Σ M[i>j] + Σ M[i=j] × p_ot, **puis couche de correction §4.3** |
| `regulation_result` (gagne en 60 min) | Σ M[i>j] |
| `game_to_ot` (va en prolongation) | Σ M[i=j] |
| `ot_so_winner` (gagne en prolongation/fusillade) | Σ M[i=j] × p_ot |
| `ot_winner` (gagne la prolongation, sachant qu'il y en a une) | p_ot |
| `puck_line` −1,5 | Σ M[i−j ≥ 2] (un match en prolongation finit toujours à 1 but d'écart) |
| `puck_line` autre ligne (−2,5, +1,5…) | sur la grille du **score final** F : Σ F[i−j + ligne > 0] |
| `alt_puck_line` | Σ M[i−j ≥ 3] |
| `total_goals_over` / `_under` (ligne L) | loi du total FINAL : un nul k–k devient 2k+1 buts ; P(total > L) / P(total < L) |
| `team_total_goals` | loi des buts FINAUX du sujet (il gagne +1 en prolongation avec p_ot) ; P(> L) |
| `both_teams_score` | 1 − P(dom = 0) − P(ext = 0) + P(0–0) ; pour « 2+ / 3+ » : Σ M[i>L, j>L] |
| `clean_sheet` (l'adversaire ne marque pas) | Σ M[·][0] |
| `winning_margin` (par 1 / par 2 / par 3+) | écart exact dans M ; « par 1 » reçoit en plus toute la masse des nuls × (p_ot ou 1−p_ot) |
| `correct_score` (ex. « 3-2 ») | case de la grille du score final F (les nuls k–k sont déplacés en k+1–k ou k–k+1) |
| `period1_winner`, `period2_winner` (mène après P1/P2, buts cumulés) | deux Poisson de moyennes λ × 0,305 (après P1) ou λ × 0,67 (après P2) → P(mène), P(égalité) |
| `period3_winner` | = gagne en 60 min (Σ M[i>j]) ; égalité = prolongation |
| `highest_scoring_period` | 3 périodes supposées égales (λ_total / 3 chacune) : P(cette période > les deux autres) |

**Toujours :** les probabilités sont bornées à [2 %, 98 %] (sauf le score exact,
borné à [0, 98 %]). La réponse porte l'entier d'affichage (`probability`) ET la
valeur exacte en 0–1 (`probability_exact`), qui sert à tous les calculs (edge, EV).

**Côté du sujet.** Toutes les formules sont écrites pour le domicile. Si la
question porte sur le visiteur, le service **transpose** la matrice (M → Mᵀ),
échange λ_dom/λ_ext et remplace p_ot par 1 − p_ot : les mêmes formules
répondent alors pour le visiteur.

**Côté « non ».** Pour un marché oui/non (BTTS, blanchissage, prolongation,
puck line, but en AN, désavantage, marque à chaque période), le côté « non »
vaut 100 − P(oui).

**Marchés qui ne sortent PAS de la matrice** (heuristiques déclarées, §6.11) :
`team_pp_goals`, `team_penalty_kill`, `team_score_every_period`,
`first_team_score`, `last_team_score`, `double_chance`, `period{1,2,3}_total_goals`.

---

## 6. Ce que fait le service ML quand on lui demande une prédiction

Fichier : `ml/python/ml_service.py`. Point d'entrée principal :
`POST /predict/game/bundle` (un match, ~95 marchés d'un coup). Le travail est
fait une fois par match dans `_game_context`, puis chaque marché est lu dans
`_price_game_market`.

### 6.1 Au démarrage

Chargement de `game_model.json` (classifieur), `training_report.json` (liste des
features, Platt, mélange), `score_model.json` + `score_report.json` (τ, p_ot,
déciles), `inference_state.json`, `elo_ratings.json`, `correction_layer.json`,
et du modèle joueur. Chaque pièce manquante désactive seulement ce qui en dépend.

**ELO vieilli :** si `elo_ratings.json` date d'une saison précédente, chaque
note est ramenée vers 1500 en gardant 2/3 de son écart par saison de retard.

### 6.2 Étape 0 — « sait-on quelque chose sur ce match ? »

Si **aucune** des deux équipes n'est connue (ni dans l'état d'inférence, ni dans
l'ELO), réponse **422 « no_estimate »** plutôt qu'un chiffre inventé.

### 6.3 Étape 1 — valeurs manquantes

PP% / PK% absents → 20 % / 80 % (moyennes de ligue). Seulement s'ils sont absents.

### 6.4 Étape 2 — ELO

Note explicite si fournie, sinon lue dans `elo_ratings.json`, sinon 1500.
`elo_diff`, `elo_expected` comme au §3.7.

### 6.5 Étape 3 — features depuis l'état d'inférence

Pour chaque côté :
1. **Stats d'équipe** : toutes les valeurs `…_s` / `…_l` de l'équipe.
2. **Gardien** : si le serveur désigne le partant et qu'il fait partie des 2 gardiens suivis — apparié par **identifiant NHL** d'abord (le serveur traduit le nom saisi via l'effectif), par nom ensuite (sans accents, casse, points ni espaces en trop, comme pour les absents) → ses chiffres ; sinon la moyenne des 2 pondérée par leur part de départs récente. `goalie_backup` : partant nommé et connu → son drapeau ; nommé mais inconnu → 1 (relève) ; non nommé → le drapeau du gardien le plus utilisé.
3. **Star power** : top-5 de l'état moins les absents nommés (ou, sans noms, on retire les N meilleurs) ; `stars_out_weight` = somme des poids des joueurs-clés nommés absents.
4. **Alignement** : si l'alignement officiel (≥ 18 joueurs) est fourni → somme des 18 habillés (bassin de toute la ligue) ; sinon effectif récent moins absents ; on garde toujours les 18 plus gros temps de glace. Si moins de 12 joueurs sont reconnus → retour à l'effectif récent.
5. **Écarts** recalculés avec les mêmes formules qu'à l'entraînement.
6. **Repos / dos-à-dos** : ce sont les valeurs envoyées par le serveur Node (§7.1).

### 6.6 Étape 4 — cotes

Si le serveur envoie les cotes décimales : `market_home_p` dévigée, utilisée
comme `market_home_p_open` ET `market_home_p_close` du classifieur. (Le modèle
de score n'utilise jamais les cotes.)

### 6.7 Étape 5 — classifieur (pour information)

Vecteur de 15 features → XGBoost → mélange avec le marché si cotes, sinon
Platt. Résultat gardé dans `probability_classifier`.

### 6.8 Étape 6 — modèle de score

Deux lignes (attaque domicile / attaque visiteur) → XGBoost → λ_dom, λ_ext.
Garde-fou : si un λ sort de [0,5 ; 8], le modèle de score est ignoré pour ce
match (retour aux heuristiques). Sinon on construit la matrice M avec τ et p_ot.

**Facteurs affichés** (« pourquoi ce pronostic ») : XGBoost donne la
contribution exacte de chaque feature à log λ. Pour chaque feature :
`effet = contribution(ligne dom) − contribution(ligne ext)` (positif = pousse
vers le domicile), regroupé en 7 familles (avantage de la glace, force d'équipe,
gardien, alignement, calendrier, défense adverse, attaque) et exprimé en part
du total.

### 6.9 Étape 7 — prix de chaque marché

Pour chaque marché demandé : vue du sujet (§5), formule du §5, bornes, côté
« non » si demandé. Pour le moneyline : la couche de correction remplace la
valeur (vue du sujet : p ou 1 − p).

### 6.10 La « confiance » (jauge 38-90)

Purement de l'affichage (aucun tri ni filtre ne l'utilise) :

```
rang       = position de |λ_dom − λ_ext| dans les déciles de l'entraînement (0 à 1)
base       = 0,45 + 0,47 × rang
confidence = borne(base × multiplicateur_du_marché, 0,38, 0,90) × 100
```

Multiplicateurs : 1,00 moneyline, 0,92 puck line, 0,90 nul/BTTS/victoire en 60 min,
0,88 totaux/blanchissage, 0,85 totaux d'équipe/autres lignes, 0,80 ot_so_winner,
0,78 écart, 0,74 périodes, 0,72 ot_winner, 0,70 score exact, 0,60 période la plus prolifique.

### 6.11 Les replis (heuristiques) — quand il n'y a pas de modèle de score

Si le modèle de score est absent ou rejeté pour ce match, `base_prob` vient du
classifieur (ou, sans classifieur, d'une régression logistique écrite à la
main sur win%, buts, PP/PK et forme L10), et chaque marché utilise une règle
simple : puck line = base × 0,60 (favori), totaux = Poisson sur
λ = buts pour/match des deux équipes, nul = 20 % + proximité des win%, etc.
Les marchés sans règle crédible (écart de victoire, pénalités, inconnus)
renvoient « pas d'estimation ».

Quelques marchés utilisent TOUJOURS une règle, même avec le modèle de score :

| Marché | Règle |
|---|---|
| `team_pp_goals` (marque en AN) | 1 − e^(−3,1 × PP%) (3,1 avantages par match en moyenne) |
| `team_penalty_kill` (tue toutes ses pénalités) | PK% ^ 3,1 |
| `team_score_every_period` | (1 − e^(−λ/3))³ |
| `first_team_score` | λ_sujet / (λ_sujet + λ_adv), borné [35 %, 65 %] |
| `last_team_score` | 50 % + (p_victoire − 50 %) × 0,65 |
| `double_chance` | p × 0,85 + P(nul) × p_ot |
| `period{1,2,3}_total_goals` | Poisson sur λ_total/3 × 0,95 / 1,10 / 0,95 |

### 6.12 Les autres routes

- **`/predict/player`** : PAS le modèle joueur entraîné. Une simple Poisson sur la moyenne de saison envoyée par le serveur (`P(X > ligne)`), bornée [5 %, 95 %]. Points en AN ≈ buts/match × 0,35 ; mises en échec, tirs bloqués, arrêts, victoires… passent par le champ `shots_per_game`.
- **`/predict/team`** (Coupe, finale de conférence, séries) : probabilité a priori selon le rang de conférence (table fixe) + petits ajustements selon win%, différentiel de buts, PP/PK.
- **`/predict/game`** : un seul marché (même calcul que le paquet).
- **Cadences joueur dans le paquet** : si le serveur envoie les identifiants des joueurs, le paquet renvoie aussi, pour chacun, la cadence par match des 8 statistiques du modèle joueur (§4.4), avec son k.

---

## 7. Ce que fait le serveur Node avec ces chiffres

### 7.1 Ce que le serveur envoie — `featureEngineering.ts → buildGameFeatures`

- Fiches d'équipe (win%, buts pour/contre, L10, séries, tirs, mises au jeu, PP/PK).
- **Repos** (`nhl/restTravel.ts`), mesuré à la **date du match** : jours depuis le match de saison régulière précédent (terminé, ou prévu entre aujourd'hui et la veille du match), plafonnés à 7 ; dos-à-dos si = 1 ; nombre de matchs dans les 3 jours précédents. Aucun match joué cette saison (calendrier publié) → 7 jours, comme le premier match de saison à l'entraînement ; calendrier vide ou API en panne → repli 2 jours.
- Cotes en direct (The Odds API) si disponibles.
- **Gardiens partants** (nom saisi + identifiant NHL résolu via l'effectif, `goalieIds.ts`) et **absents** saisis à la main (`/dev/saisie`, table `manual_data`).
- **Alignement officiel** (API NHL) quand il est publié.
- Abréviations des deux équipes (pour l'ELO et l'état d'inférence).

Seules les variables ci-dessus qui alimentent l'état d'inférence, le gardien,
les absents, l'alignement, le repos et les cotes changent réellement la
probabilité servie. Win%, buts/match, PP/PK… ne servent qu'aux replis.

### 7.2 Le paquet d'un match — `gameMlBundle.ts`

1. La liste des tuiles de la page match fournit les marchés à demander (+ quelques extras pour les pages équipe/joueur).
2. Les features sont construites **une fois**, côté domicile, à la **date du match** (repos, gardien saisi et absents de ce jour-là) ; chaque marché porte son côté (`subject_is_home`).
3. Un appel `/predict/game/bundle` ; résultat **mis en cache 10 minutes** par match.
4. Les tuiles « gagne en 60 min » (ml-home / ml-away) demandent `regulation_result`.

**En direct** (`applyLive`, cache 30 s) : le modèle reste d'avant-match. Le
serveur prend 3 chiffres du paquet — victoire domicile, P(prolongation), λ total
— et les injecte dans la grille « score actuel + buts restants » des règles
(`buildLiveModelMarkets`), avec des effets de score mesurés
(`calibrate_live.py` → `liveEffects.json`).

### 7.3 Les cadences joueur — `prediction/playerRates.ts`

Règle par défaut, pour chaque joueur et statistique :

```
λ = (total de la saison + m × a priori de poste) / (matchs joués + m)     (m = 4 à 12 matchs fictifs)
λ × facteur adversaire  (buts/points ∝ buts concédés par l'adversaire, tirs ∝ tirs concédés…, borné ±10-15 %)
```

Si le paquet ML porte des cadences du **modèle joueur**, elles **remplacent**
la règle pour ce joueur (sauf gardiens et recrues inconnues). Les seuils
« 1+, 2+, 3+ » sont ensuite lus côté client avec une binomiale négative de
paramètre k. Premier buteur : `(λ_buts du joueur / λ_buts du match) × (1 − e^(−λ_match))`.

### 7.4 Les value bets — `valueBets.service.ts`

Critère unique, partagé par l'accueil et l'alerte push :

1. Match **du jour** (heure de l'Est), **pas commencé**.
2. **Les deux gardiens partants saisis** à la main.
3. Probabilité du paquet ML **non arrondie** (`probability_exact`), seulement si le modèle de score a répondu.
4. Probabilité du marché dévigée chez le livre d'affichage (les deux prix du même livre).
5. Règles :
   - **moneyline** : edge entre **2 % et 6 %** ;
   - **puck line −1,5** (côté qui donne les buts) : edge ≥ **4 %** ;
   - et EV = p × cote − 1 ≥ 0.
   - Les totaux sont exclus (pas d'avantage mesuré).
6. **Cote minimale** affichée = 1 / p_modèle (seuil de rentabilité selon le modèle).
7. Chaque value bet est journalisé (`value_bet_log`) pour mesurer le CLV.

### 7.5 Les « best bets » — `bestBets.service.ts`

Différent des value bets : on construit des candidats (moneyline, totaux, puck
line, quelques props joueur), on les trie par score des **règles**, on enrichit
les 30 premiers avec le ML (`/predict/game` ou `/predict/player`), puis on trie
par probabilité affichée. C'est un classement des issues **les plus probables**,
pas des paris les plus rentables.

---

## 8. Comment on sait si le modèle est bon (évaluation)

| Mesure | Fichier | Chiffre clé |
|---|---|---|
| Modèle de score, test 2023-02 → 2026-04 | `score_report.json` | log-loss moneyline 0,6628 ; nuls prédits 21,5 % / observés 22,1 % ; −1,5 prédit 33,2 % / observé 33,2 % ; erreur moyenne sur le total 1,87 but (constante : 1,90) |
| Classifieur, même test | `training_report.json` | log-loss 0,6656 ; ELO seul 0,6702 |
| Contre le marché, saison 2025-26 (1 311 matchs cotés) | `training_report.json`, `score_report.json` | marché 0,6822 ; modèle de score 0,6847 ; classifieur ⊕ marché 0,6843 → **le marché reste légèrement meilleur** |
| Walk-forward moneyline (classifieur ⊕ marché, cotes de clôture) | `backtest_walkforward_report.json` | log-loss modèle 0,6689 vs marché 0,6677 ; ROI flat SBRO ≈ −0,5 à 0 % ; DraftKings 2025 +1 à +3 % sur 300-600 paris (non significatif) |
| CLV (ouverture vs clôture, DraftKings) | `backtest_clv_report.json` | les paris à edge ≥ 2 % prennent en moyenne +0,35 point de probabilité à la clôture (t ≈ 7,9), mais ROI à l'ouverture ≈ 0 ± 2,7 % |
| Couche de correction | `correction_report.json` | log-loss −0,0021, 10 saisons sur 11 meilleures |
| Modèle joueur, test 2023-26 | `player_report.json` | bat la règle sur les 8 statistiques |

**En clair :** le modèle est bien calibré (quand il dit 60 %, c'est ~60 %) et
nettement meilleur que des règles simples, mais **il ne bat pas encore la cote
de clôture** du marché sur le moneyline. Les value bets restent donc à
considérer comme un pari sur un petit avantage non prouvé.

---

## 9. Mise à jour : rafraîchir et réentraîner

| Quand | Commande | Ce que ça change |
|---|---|---|
| Chaque semaine (tâche planifiée Windows `ml/refresh-data.cmd`) | `python refresh_data.py` | Nouvelles données de la saison en cours → `inference_state.json`, `elo_ratings.json`. **Mêmes modèles.** Il faut ensuite committer ces 2 fichiers et pousser (le service embarque `ml/models/` dans son image). |
| Réentraînement (mensuel) | `python build_dataset.py && python train_score.py && python train.py && python train_player.py` | Nouveaux modèles + rapports. |
| Couche de correction | `python backtest_walkforward.py --correction --write-layer` | Réécrit `correction_layer.json` seulement si le verdict est « ADOPTER ». |
| Contrôles | `python backtest.py`, `python backtest_walkforward.py [--clv|--derived|--market-gap]` | Rapports dans `ml/models/*_report.json`. |

---

## 10. Exemple complet chiffré

Match fictif : le domicile a λ_dom = **3,30** buts attendus en 60 min, le
visiteur λ_ext = **2,70** (chiffres calculés avec les vrais τ et p_ot du rapport).

1. **Prolongation** : p_ot = σ(0,2834 × 0,60 − 0,0640) = **52,7 %**.
2. **Matrice** sans τ : nul après 60 min 16,2 %. **Avec τ : 21,9 %**.
3. **Victoire en 60 min** = Σ M[i>j] = 49,1 %.
4. **Victoire (moneyline)** = 49,1 % + 21,9 % × 52,7 % = **60,7 %**.
5. **Couche de correction** : avec toutes les autres variables à leur moyenne, z = 0,0863 + 0,4667 × logit(0,607) → **57,2 %** ; si en plus le domicile a +60 d'ELO, +0,04 de xGF% court terme, +0,3 xG d'alignement, +0,5 de star power, etc. → **62,9 %**. C'est ce chiffre qui est affiché sur « victoire ».
6. **Puck line −1,5** = Σ M[écart ≥ 2] = **37,3 %**.
7. **Plus de 5,5 buts** : total final espéré 6,23 → **56,0 %**.
8. **Les deux équipes marquent** : **89,8 %**.
9. **Domicile plus de 2,5 buts** (prolongation comprise) : **68,3 %**.
10. **Confiance** : |3,30 − 2,70| = 0,60 se situe au rang 0,73 des déciles → base 0,79 → moneyline 79/100.
11. **Value bet ?** Si un livre propose le domicile à 1,75 et le visiteur à 2,15 : marché dévigé = (1/1,75)/(1/1,75 + 1/2,15) = 55,1 %. Edge = 62,9 − 55,1 = 7,8 % → **au-dessus du plafond de 6 % → rejeté** (trop beau pour être vrai : plus probablement une info que le modèle n'a pas). Avec 1,85 / 2,02 : marché 52,2 %, edge 10,7 %… rejeté aussi. À 1,65 / 2,30 : marché 58,2 %, edge 4,7 %, EV = 0,629 × 1,65 − 1 = +3,8 % → **value bet**, cote minimale 1/0,629 = 1,59.

---

## 11. Carte des fichiers

### Python (`ml/python/`)

| Fichier | Rôle |
|---|---|
| `fetch_data_v4.py` | Téléchargement complet des données (API NHL, MoneyPuck, cotes). |
| `refresh_data.py` | Mise à jour hebdomadaire de la saison en cours, puis `build_dataset.py`. |
| `build_dataset.py` | Features pré-match, cibles, ELO, état d'inférence. |
| `train_score.py` | **Modèle de score** + τ + p_ot + déciles de confiance. |
| `score_model.py` | Mathématiques de la matrice des scores (partagé entraînement / service). |
| `train.py` | Classifieur moneyline (informatif). |
| `train_player.py` | Modèle joueur (8 statistiques). |
| `ml_service.py` | Service FastAPI (toutes les routes de prédiction). |
| `backtest.py` | Backtest sur le test + `--reliability` (calibration par tranches). |
| `backtest_walkforward.py` | Backtests saison par saison : ROI, CLV, marchés dérivés, incertitude, sélection de features, correction, écart au marché… |
| `calibrate_live.py`, `fetch_live_goals.py`, `live_pregame.py` | Effets de score pour le direct. |
| `measure_*.py`, `compare_*.py`, `probe_odds_books.py` | Études ponctuelles (face-à-face, retour de blessure, Corsi/Fenwick, sources de cotes). |
| `content_insights*.py` | Statistiques « contenu » pour les réseaux sociaux — sans lien avec les prédictions. |
| `fetch_data.py` | Ancienne collecte v3 (standings) — encore copiée dans l'image Docker. |

### Modèles et rapports (`ml/models/`)

| Fichier | Contenu |
|---|---|
| `score_model.json` / `score_report.json` | Modèle de score / ses réglages (features, τ, p_ot, déciles, métriques). |
| `game_model.json` / `training_report.json` / `feature_importance_game.json` | Classifieur / Platt, mélange, métriques. |
| `correction_layer.json` / `correction_report.json` | Couche de correction / sa mesure. |
| `player/*.json` / `player_report.json` / `player_state.json` | Modèle joueur / rapport / état des joueurs. |
| `inference_state.json` | État actuel des équipes, gardiens, alignements, étoiles. |
| `elo_ratings.json` | Notes ELO actuelles. |
| `*_report.json`, `live/` | Rapports de mesure. |

### Serveur (`server/src/services/`)

| Fichier | Rôle |
|---|---|
| `featureEngineering.ts` | Construit la requête envoyée au service ML. |
| `mlApiClient.ts` | Client HTTP (jeton, cache 5 min, disjoncteur après 5 échecs). |
| `gameMlBundle.ts` | Paquet de toutes les tuiles d'un match + direct. |
| `prediction/playerRates.ts` | Cadences joueur (règle ou modèle joueur). |
| `valueBets.service.ts` / `valueBetScan.service.ts` | Value bets et alertes push. |
| `bestBets.service.ts` | Liste « best bets ». |
| `nhlPredictions.ts`, `prediction/*.ts` | Moteur de RÈGLES (sans ML), utilisé en mode règles et comme grille du direct. |
| `nhl/restTravel.ts` | Repos, dos-à-dos, voyage. |
