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
> Les incohérences repérées en écrivant ce document (21 points, toutes corrigées
> au 2026-10-05) étaient listées dans `INCOHERENCES_ML.md`, supprimé depuis :
> `git show ad0eba9:ml/INCOHERENCES_ML.md`.

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
 │                       │   • Recalage de niveau : total de buts × k (saison en cours).
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
| **τ (tau)** | Correction de la matrice selon l'écart de score (voir §4.1.4) : corrige le fait que Poisson sous-estime les nuls et les écarts de 3 (filet désert). Depuis le 2026-10-15, repli seulement : la matrice vient du moteur de match. |
| **Moteur de match / c** | Le match joué par tranches de temps (§4.1.4 bis) : chaque équipe marque à λ/3600 par seconde × c(son avance, la minute). `c` est mesuré sur les buts horodatés ; le filet désert y est explicite. Donne la matrice M et tous les marchés de période. |
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
| `odds.csv` | SBRO (2007 → 27 nov. 2022, archive figée) + The Odds API / DraftKings (2024-25 et 2025-26 faites ; 2023-24 et fin 2022-23 de nov. 2026 à févr. 2027, `REFACTOR_PLAN.md` §A1) | Cotes d'ouverture et de clôture moneyline, ligne et prix des totaux, puck line. **Payées, irremplaçables, jamais écrasées.** |
| `odds_snapshots_hist.csv` | The Odds API (backfill payé, DraftKings, mêmes saisons que ci-dessus) | Série horodatée des cotes (plusieurs observations par match) : ouverture du matin et clôture, pour le CLV. |
| `odds_snapshots_live.csv` | Collecte du serveur (`npm run odds:export-snapshots`) | Même format, depuis la table `odds_snapshots` : le livre de collecte (DraftKings, prolonge la série) **et les livres collectés en parallèle** (BET99 depuis le 2026-10-04), chacun avec sa `source`. |
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

**Ce τ est périmé (mesuré le 2026-10-15).** Il est ajusté sur 2008-2021, or les
gardiens sortent plus tôt et plus souvent : écarts de ±1 après 60 min 23,2 %
(2010-14) → 17,9 % (2023-25), écarts de ±3 19,8 % → 23,6 %, buts en filet désert
3,8 % → 6,0 %. Il reste écrit dans `score_report.json` comme dernier repli ; le
service sert le moteur ci-dessous (ou, à défaut, un τ ré-ajusté sur les 3
dernières saisons, `game_dynamics.json → tau_margin`).

#### 4.1.4 bis Le moteur de match (`game_dynamics.py`, 2026-10-15)

Plutôt que de corriger après coup deux Poisson indépendantes, on **joue le
match**. Chaque équipe marque, à chaque seconde, avec une intensité

```
r(t) = λ_équipe / 3600 × c(avance de l'équipe, tranche de temps)
```

- **Tranches** : P1, P2, P3 0-10', P3 10-15', puis minute par minute de 55' à 60'.
- **Avance** de l'équipe bornée à ±3.
- **c** = buts observés dans la case ÷ (secondes passées dans la case × λ/3600),
  sur `live_goals.csv` (buts horodatés), 3 dernières saisons complètes, avec les
  λ du modèle servi. Rendu **relatif** (il ne change pas le nombre total de buts
  attendus — le niveau reste l'affaire de λ et du recalage §4.3 bis).

Le filet désert y est explicite (fenêtre 2023-2025) :

| avance de l'équipe | 57-58' | 58-59' | 59-60' |
|---|---|---|---|
| −1 (gardien sorti) | ×0,95 | ×1,66 | **×2,60** |
| 0 | ×0,70 | ×0,67 | ×0,67 |
| +1 (vise le filet vide) | ×1,31 | ×4,26 | **×7,69** |
| +2 | ×4,37 | ×5,73 | ×6,55 |

La loi du score est calculée **exactement** (chaîne de Markov à temps continu,
uniformisation) : ≈ 1 ms par matrice. Deux usages :

1. **La matrice M du match entier** (§5). Walk-forward 2013-2025, critère fixé
   avant le run, contre Poisson × τ ré-ajusté sur les mêmes 3 saisons : score
   exact −0,0032 de log-loss (z −4,0, 11 saisons sur 13), moneyline, puck line,
   nul après 60', plus de 5,5 / 6,5 tous |z| < 1. Adopté.
2. **Les marchés de période** (§5), sur l'état (avance, buts P1, buts P2, buts
   P3). L'ancienne règle (Poisson de part fixe 30,5 / 36,5 / 33 %) ignorait
   que la 3e période dépend du score à 40'. Test 2023-26 (4 201 matchs, niveau
   recalé) : période la plus prolifique z −5,1 ; P3 plus de 0,5 / 1,5 / 2,5
   z −4,7 / −5,5 / −4,0 ; P2 plus de 2,5 z −4,2 ; mène après P1 / P2 neutre.

**Le moneyline servi ne change pas.** La couche de correction (§4.3) a été
ajustée sur la victoire de Poisson × τ ; le service lui donne toujours cette
entrée-là (`_p_home_layer_input`), puis recale la matrice du moteur sur la
victoire corrigée. Le moteur ne fait que répartir cette victoire entre les
scores. (Sa propre victoire domicile est ~1 point plus basse, uniformément, à
log-loss égale.)

`game_dynamics.json` est réécrit par `refresh_data.py` (chaque lundi) et à la
fin de `train_score.py`. Retour arrière sans redéployer de modèle : variable
d'environnement `SCORE_SHAPE=tau_window` (Poisson × τ glissant) ou `tau_train`
(Poisson × τ 2008-2021). Exploration complète et pistes écartées (copule de
Frank, Conway-Maxwell-Poisson, bayésien hiérarchique, simulation tir par tir) :
`ml/EXPLORATION_SCORE.md`.

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
comparaison — sans les cotes en entrée et calibrée Platt —, mais la probabilité
servie vient du modèle de score. Le mélange avec le marché ne sert que de repli
quand le modèle de score ne répond pas.

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
meilleure sur 10 saisons sur 11. Une variable absente vaut sa moyenne
(contribution nulle).

**Comment elle s'applique à tous les marchés** (depuis le 2026-10-03). La
victoire corrigée est traduite en une distribution : on garde la somme
λ_dom + λ_ext (les totaux de buts ne bougent pas) et on choisit le partage
entre les deux équipes pour que la victoire domicile de la matrice — τ et
prolongation compris — égale la victoire corrigée (`lambdas_for_home_win`,
`score_model.py`, par bissection). Tous les marchés se lisent ensuite sur
cette matrice recalée : « gagne en 60 min » + « gagne en prolongation » =
« gagne », les scores exacts gagnants somment à la victoire. Les λ affichés
(paquet ML, direct) sont les λ recalés ; `probability_score_model` reste la
victoire du modèle brut, avant correction.

### 4.3 bis Le recalage de niveau des buts (`level_layer.json`, 2026-10-04)

**Le défaut corrigé.** Le modèle de score se trompe de niveau selon les
saisons. Buts réglementaires observés / λ (walk-forward, `live_pregame.csv`) :
1,02-1,03 sur 2017-21, **0,965 · 0,961 · 0,955 · 0,969** sur 2022-23 → 2025-26.
Le modèle servi montre le même écart sur ces saisons hors de son entraînement.
Conséquence : « plus de 5,5 » annoncé à 58,4 % sur 2023-26 pour 56,0 % observé.

**Le recalage.** Un seul nombre k par saison, le rapport buts observés / buts
prévus des matchs déjà joués de la saison en cours, rétréci vers 1 :

```
k = 1 + w × (Σ obs / Σ λ − 1),   w = n / (n + 200)
```

n = matchs joués de la saison ; 200 = force du rétrécissement, choisie par
saison laissée de côté (`measure_level.py`). En début de saison k = 1, puis k
rejoint le rapport de la saison à mesure que les matchs s'accumulent (k ≈ 0,97
à la fin de 2025-26). Borné à [0,85 ; 1,15].

**Comment il s'applique.** Le service multiplie la SOMME λ_dom + λ_ext par k
puis rechoisit le partage pour garder la victoire domicile exacte
(`lambdas_for_home_win`, la même bissection que la couche de correction, §4.3).
Donc **le moneyline ne bouge pas** ; totaux, totaux d'équipe, puck line, score
exact, BTTS, périodes et le direct (le paquet renvoie les λ recalés) se lisent
sur la matrice recalée. Les cadences joueur (modèle séparé) ne sont pas
touchées.

**La mesure** (`level_report.json`, règle fixée avant le run, 11 saisons
2015-16 → 2025-26, k gelé chaque lundi comme en production) : déviance du
total 0,96566 → 0,96247 (z −3,2), meilleure sur 8 saisons sur 11, P(> 5,5)
sur 2023-26 58,4 % → 55,8 % pour 56,0 % observé → **ADOPTÉ**.

**Qui le calcule.** `refresh_data.py`, chaque lundi : le modèle de score SERVI
chiffre les matchs déjà joués de la saison (ils sont toujours hors de son
entraînement, cf. le découpage 80/20) et écrit `level_layer.json`. Le service
refuse un fichier d'une autre saison, dont le k ne se recalcule pas à partir
de ses propres comptes, ou dont la mesure n'est pas « ADOPTER » → k = 1.

### 4.4 Le modèle joueur (`train_player.py`)

Un modèle XGBoost `count:poisson` **par statistique** : buts, passes, points,
tirs, mises en échec, tirs bloqués, minutes de pénalité, points en AN.

- **Features joueur (pré-match)** : temps de glace moyen sur 5/10/30 matchs, temps en AN sur 10 matchs, xG des coéquipiers sur la glace à 5c5 (20 matchs), xG individuel par 60 (20 matchs), nombre de matchs en carrière, production par 60 minutes sur 10, 30 matchs et carrière pour les 8 statistiques.
- **Contexte du match** : 13 statistiques de son équipe (`tm_…`) et de l'adversaire (`opp_…`) issues de `nhl_games_v4.csv` (buts, xG, tirs, AN/PK, gardien, forme), domicile, repos, dos-à-dos, défenseur ou non.
- Entraînement ≤ 2021-22, arrêt précoce sur 2022-23, test 2023-24 → 2025-26.
- **Dispersion k** (binomiale négative) ajustée par statistique : ≥ 10⁴ = Poisson (buts, passes, points, points AN), 20 (tirs), 8 (mises en échec, tirs bloqués), 0,3 (pénalités).
- Bat la règle actuelle du serveur sur les 8 statistiques (ex. buts : log-vraisemblance −0,4463 contre −0,4566).
- **Face-à-face joueur vs adversaire** (2026-10-06, `player_vs_report.json`) : sur ses 10 derniers matchs contre l'adversaire du soir, le joueur a-t-il produit plus ou moins que son niveau du moment ? `vs_lift_<stat>` = réel / attendu (chaque rencontre jugée avec sa cadence pré-match sur 30 matchs × son temps de glace), rétréci vers 1 par un pseudo-compte (`VS_PSEUDO`), plus `vs_gp` (nombre de rencontres). Contrainte monotone +1 sur les lifts : un lift plus haut ne peut que faire monter la prédiction. Essayé pour chaque stat, gardé seulement si la log-vraisemblance s'améliore en validation (2022-23) ET en test (2023-26) avec z ≥ 2.
  - **Gardé** : mises en échec (z 4,3, les 3 saisons ; lift ≥ 1,2 → +7,8 % observé vs modèle sans face-à-face) et pénalités (z 2,5).
  - **Rejeté (bruit)** : buts, passes, points, tirs, tirs bloqués, points en AN. Un joueur qui « marque toujours » ou « tire toujours » contre une équipe ne le refait pas plus que d'habitude (tirs : −0,3 % observé pour lift ≥ 1,2). Fenêtre de 20 rencontres testée aussi : même conclusion (seules les pénalités y passent la règle).
  - Les features sont donc **par statistique** : `player_report.json → stats[s].features`.
  - Face-à-face **équipe vs équipe** : déjà mesuré et rejeté pour le modèle de score (`live/h2h_report.json`, `keep: false`).
- **Arbitres** (2026-10-12, `referee_effects.py`, `player_ref_report.json`) : `ref_pen` / `ref_pp` = somme, pour les 2 arbitres du match, de leur écart moyen (rétréci, `/ (n + 40)`) aux pénalités / minutes à 5 c. 4 de la ligue, sur leurs matchs PRÉCÉDENTS. Essayé pour pénalités et points en AN avec la règle du face-à-face : **gardé pour les pénalités** (z 2.46), pas pour les points en AN (z 1.68). En service, Node envoie les noms des arbitres du soir (`refereeStore`, Scouting the Refs) ; la table `ref_effects.json` (rafraîchie chaque lundi) donne leurs effets ; inconnus → 0. Les arbitres n'ont AUCUN effet mesurable sur les buts : ils ne touchent ni le modèle de score ni les totaux.
- **Pour le service** : `player_state.json` = les features de chaque joueur après son dernier match, plus `vs` = { joueur: { adversaire: [vs_gp, lifts…] } } (ordre : `vs_features`) ; le service les combine au contexte du match à venir. Sans rencontre passée ou sans équipe nommée : `vs_gp` 0 et lifts 1, comme à l'entraînement.
- **Répartir la grille entre les joueurs (« top-down », 2026-10-15, `explore_players/`)** : chaque but de l'équipe revient au joueur avec sa part s = μ_buts / Σ_équipe μ_buts, sur la loi des buts comptables du moteur (but de prolongation compris, fusillade non). Mesuré sur 189 000 joueur-matchs hors échantillon (2022-23 → 2025-26), avec une règle posée avant le run :
  - **Marginales — non adopté** : aucun gain sur les buts (Δ log-vraisemblance +0,00004, z 0,5), légère perte sur les passes et les points. Les chiffres affichés restent ceux du modèle joueur.
  - **Combinés d'un même match — adopté** : la grille bat le produit des probabilités pour « X marque + son équipe gagne » (z 26 en test ; observé 1,33 × le produit, la grille dit 1,30), « 1+ point + gagne » (z 37), « marque + plus de 5,5 » (z 22), « marque + gagne par 2 » (z 24), « marque + l'adversaire gagne » (z 26). Deux coéquipiers qui marquent : rien à gagner (lift observé 1,02), ils restent au produit. Branché dans le coupon (§7.6).

---

- **Recalage de niveau dans la saison** (2026-10-15, `explore_players/level.py` → `player_level_report.json`) : entraîné ≤ 2021-22, le modèle suit mal les dérives de ligue. Par statistique, k de la saison en cours = Σ observé / Σ prévu sur les matchs déjà joués, rétréci vers 1 (`level_k`, n0 choisi en validation). Règle posée avant le run (mieux en validation 2022-23 ET en test 2023-26, z ≥ 2) : **adopté** pour tirs bloqués (z 6,5), mises en échec (z 5,0) et points (z 2,2) ; pas pour buts, passes, tirs (z 1,7), pénalités, points en AN. `train_player.refresh_player_level` écrit `player_level_layer.json` ; `ml_service` multiplie les cadences servies par k (fichier d'une autre saison → k = 1).
- **État rafraîchi chaque semaine** (2026-10-15) : `refresh_data.py` garde le zip COMPLET des patineurs de la saison en cours (`data/raw/skaters_<saison>_current.zip`) et relance `train_player.refresh_state()` (état + recalage). Avant, l'état restait figé à la fin de la saison précédente (16 avril 2026) : aucun match de la saison en cours n'entrait dans les features du modèle joueur.

### 4.5 Le modèle de tirs (`train_shots.py`, 2026-10-15)

Deuxième quantité d'équipe à côté des buts : **λ_tirs**, les tirs cadrés
attendus de chaque équipe sur le match entier (prolongation comprise).

- **Forme** : XGBoost `count:poisson` sur les lignes équipe-match, comme le modèle de score. Côté attaque : tirs pour, xG, possession (`ev_cf_pct`), AN, buts, forme, repos, xG de l'alignement. Côté défense : tirs contre, xG contre, possession, PK, forme, repos, gardien. Plus domicile et écart d'ELO. Même découpage que `train_score.split`.
- **Recalage de niveau** : les tirs baissent depuis 2022-23 (31,3 → 26,9 par équipe-match). λ_tirs est donc recalé dans la saison, exactement comme les buts (`level_k`, 200 matchs fictifs). Le fichier `shots_level_layer.json` est rafraîchi par `refresh_data.py` (étape 5ter).
- **À quoi il sert : les arrêts du gardien.** μ_arrêts = λ_tirs(adversaire) × % d'arrêts du gardien (état d'inférence) × 0,970. Ce coefficient, ajusté sur la validation, couvre le partant qui ne finit pas le match. La dispersion est une binomiale négative avec k = 50. Le paquet renvoie μ pour chaque gardien suivi des deux équipes, au cas où il partirait.
- **Mesure** (règle posée avant le run, test de mars 2023 à octobre 2026) :
  - Tirs d'équipe contre la règle « tirs pour × tirs contre / ligue » : Δ log-vraisemblance +0,036, z 9,3.
  - Arrêts contre la règle de `playerRates.ts` : Δ +0,061, z 11,8. Pour « plus de 24,5 arrêts », la règle prévoyait 43 %, le modèle 54 %, et on observe 53 % (de même 29 / 37 / 37 % à 27,5 et 22 / 26 / 27 % à 29,5).
  - Tirs d'un patineur tirés de λ_tirs (part du joueur) : **rejeté** (z −5,1, `explore_shots/`). Le modèle joueur reste leur source.
- Mises en échec et tirs bloqués ne sont pas dérivés de λ_tirs : aucune mesure ne l'a justifié.

## 5. Des deux λ à chaque marché de paris

Tout part de la matrice M (14 × 14, de 0 à 13 buts par équipe) :

```
M[i][j] = P(le moteur de match finit à i–j après 60 min | λ_dom, λ_ext, c)      (§4.1.4 bis)
repli :  Poisson(i ; λ_dom) × Poisson(j ; λ_ext) × τ(i − j), normalisée à 1      (§4.1.4)
```

Notations : « nul » = case où i = j (égalité après 60 min) ; `p_ot` = probabilité
que le domicile gagne la prolongation (§4.1.5). Code : `ScoreDistribution`
(`score_model.py`) et `_apply_score_model` (`ml_service.py`).

| Marché (`market_type`) | Formule |
|---|---|
| `moneyline` (victoire, prolongation incluse) | Σ M[i>j] + Σ M[i=j] × p_ot, sur la matrice **recalée** par la couche de correction (§4.3) |
| `regulation_result` (gagne en 60 min) | Σ M[i>j] |
| `game_to_ot` (va en prolongation) | Σ M[i=j] |
| `ot_so_winner` (gagne en prolongation/fusillade) | Σ M[i=j] × p_ot |
| `ot_winner` (gagne la prolongation, sachant qu'il y en a une) | p_ot |
| `puck_line` −1,5 | Σ M[i−j ≥ 2] (un match en prolongation finit toujours à 1 but d'écart) |
| `puck_line` autre ligne (−2,5, +1,5…) | sur la grille du **score final** F : Σ F[i−j + ligne > 0] |
| `alt_puck_line` | Σ M[i−j ≥ 3] |
| `total_goals_over` / `_under` (ligne L) | loi du total FINAL : un nul k–k devient 2k+1 buts ; P(total > L) / P(total < L) |
| `team_total_goals` | loi des buts FINAUX du sujet (il gagne +1 en prolongation avec p_ot) ; P(> L), et 1 − P(> L) pour la sélection « under » |
| `both_teams_score` | 1 − P(dom = 0) − P(ext = 0) + P(0–0) ; pour « 2+ / 3+ » : Σ M[i>L, j>L] |
| `clean_sheet` (l'adversaire ne marque pas) | score FINAL : Σ M[·][0] − M[0][0] × (1 − p_ot) — un 0-0 perdu en prolongation n'est pas un blanchissage |
| `winning_margin` (par 1 / par 2 / par 3+) | écart exact dans M ; « par 1 » reçoit en plus toute la masse des nuls × (p_ot ou 1−p_ot) |
| `correct_score` (ex. « 3-2 ») | case de la grille du score final F (les nuls k–k sont déplacés en k+1–k ou k–k+1) |
| `period1_winner`, `period2_winner` (mène après P1/P2, buts cumulés) | moteur de match : loi de l'avance à 20' / 40' → P(mène), P(égalité). Repli sans `game_dynamics.json` : deux Poisson de moyennes λ × 0,305 ou λ × 0,67 |
| `period{1,2,3}_total_goals` | moteur de match : loi des buts DANS la période (la 3e dépend du score à 40') ; P(> L). Repli : Poisson de moyenne (λ_dom + λ_ext) × 30,5 % / 36,5 % / 33,0 % |
| `period3_winner` | = gagne en 60 min (Σ M[i>j]) ; égalité = prolongation |
| `highest_scoring_period` | moteur de match : loi jointe (buts P1, P2, P3) → P(cette période a strictement le plus de buts), égalité en tête = issue `tie`. Repli : parts fixes 30,5 / 36,5 / 33,0 % |

**Toujours :** les probabilités sont bornées à [2 %, 98 %] (sauf le score exact,
borné à [0, 98 %]). La réponse porte l'entier d'affichage (`probability`) ET la
valeur exacte en 0–1 (`probability_exact`), qui sert à tous les calculs (edge, EV).

**Côté du sujet.** Toutes les formules sont écrites pour le domicile. Si la
question porte sur le visiteur, le service **transpose** la matrice (M → Mᵀ),
échange λ_dom/λ_ext et remplace p_ot par 1 − p_ot : les mêmes formules
répondent alors pour le visiteur.

**Côté « non » / « moins ».** Pour un marché oui/non (BTTS, blanchissage,
prolongation, puck line, but en AN, désavantage, marque à chaque période), le
côté « non » vaut 100 − P(oui). Pour un plus/moins dont le côté est dans la
sélection (total d'équipe, totaux par période), « moins » vaut 100 − P(plus).

**Marchés qui ne sortent PAS de la matrice** (heuristiques déclarées, §6.11) :
`team_pp_goals`, `team_penalty_kill`, `team_score_every_period`,
`first_team_score`, `last_team_score`, `double_chance`.

---

## 6. Ce que fait le service ML quand on lui demande une prédiction

Fichier : `ml/python/ml_service.py`. Point d'entrée principal :
`POST /predict/game/bundle` (un match, ~95 marchés d'un coup). Le travail est
fait une fois par match dans `_game_context`, puis chaque marché est lu dans
`_price_game_market`.

### 6.1 Au démarrage

Chargement de `game_model.json` (classifieur), `training_report.json` (liste des
features, Platt, mélange), `score_model.json` + `score_report.json` (τ, p_ot,
déciles), `game_dynamics.json` (moteur de match, §4.1.4 bis — remplace le τ du
rapport), `inference_state.json`, `elo_ratings.json`, `correction_layer.json`,
`level_layer.json` (recalage de niveau, §4.3 bis) et du modèle joueur. Chaque pièce manquante désactive seulement ce qui en dépend.

**ELO vieilli :** si `elo_ratings.json` date d'une saison précédente, chaque
note est ramenée vers 1500 en gardant 70 % de son écart par saison de retard —
la même régression qu'à l'entraînement (`season_regress`, écrit dans le fichier).

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

Vecteur de 15 features → XGBoost. Deux sorties : avec les cotes puis mélangé au
marché (repli si le modèle de score ne répond pas), et sans les cotes + Platt
(`probability_classifier`, pour comparaison).

### 6.8 Étape 6 — modèle de score

Deux lignes (attaque domicile / attaque visiteur) → XGBoost → λ_dom, λ_ext.
Garde-fou : si un λ sort de [0,5 ; 8], le modèle de score est ignoré pour ce
match (retour aux heuristiques). Sinon on construit la matrice M (moteur de
match, §4.1.4 bis) et p_ot, puis on la recale : victoire sur la couche de correction (§4.3), total de buts
sur le niveau de la saison (§4.3 bis).

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

### 6.12 Les autres routes

- **`/predict/player`** : PAS le modèle joueur entraîné. Une simple Poisson sur la moyenne de saison envoyée par le serveur (`P(X > ligne)`), bornée [5 %, 95 %] ; mises en échec, tirs bloqués, arrêts, victoires… passent par le champ `shots_per_game`. **Depuis le 2026-10-15, ce n'est plus qu'un repli** : un pari joueur demandé à l'unité (`POST /api/predict/ml`, type `player`) est d'abord chiffré par le serveur Node sur la cadence du modèle joueur du paquet du match (`server/src/services/prediction/playerModelPrediction.ts` : match fourni ou prochain match du joueur, binomiale négative avec le k du modèle, plafond 97 comme les grilles). La Poisson ne sert plus que pour les gardiens, les recrues absentes de l'état, un joueur sans match dans les 14 jours, un match en cours ou un service ML en panne.
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
la règle pour ce joueur (sauf recrues inconnues). Les **arrêts d'un gardien**
viennent du **modèle de tirs** (§4.5) quand le paquet en porte pour lui
(`goalieSaves`, k `savesDispersion`) ; sinon la règle. Les seuils
« 1+, 2+, 3+ » sont ensuite lus côté client avec une binomiale négative de
paramètre k. Premier buteur : `(λ_buts du joueur / λ_buts du match) × (1 − e^(−λ_match))`, où λ_match = λ_dom + λ_ext du modèle de score quand le paquet ML est disponible (sinon l'estimation des règles).

### 7.4 Les value bets — `valueBets.service.ts`

Critère unique, partagé par l'accueil et l'alerte push :

1. Match **du jour** (heure de l'Est), **pas commencé**.
2. **Les deux gardiens partants saisis** à la main.
3. Probabilité du paquet ML **non arrondie** (`probability_exact`), seulement si le modèle de score a répondu.
4. Probabilité du marché dévigée chez le **livre d'affichage** (`ODDS_BOOKMAKERS`, défaut BetRivers ; liste par ordre de préférence, par ex. `bet99_ca_on,betrivers`), les deux prix du même livre.
5. Règles :
   - **moneyline** : edge entre **2 % et 6 %** ;
   - **puck line −1,5** (côté qui donne les buts) : edge ≥ **4 %** ;
   - et EV = p × cote − 1 ≥ 0.
   - Les totaux sont exclus (pas d'avantage mesuré).
6. **Cote minimale** affichée = 1 / p_modèle (seuil de rentabilité selon le modèle).
7. Chaque value bet est journalisé (`value_bet_log`) pour mesurer le CLV.

### 7.5 Les « best bets » — `bestBets.service.ts`

Différent des value bets : on construit des candidats (moneyline, totaux, puck
line, quelques props joueur) et on les chiffre TOUS avec le paquet ML de leur
match — le même que la page du match (paris joueur : cadences du modèle joueur,
P(X ≥ k)). Un joueur inconnu du modèle n'a pas de score ML. On trie ensuite par
probabilité : c'est un classement des issues **les plus probables**, pas des
paris les plus rentables ; l'EV au prix du livre (`ev`) est donnée pour
information quand un prix existe.


### 7.5 bis Premier but, dernier but, marque à chaque période, double chance (2026-10-15)

- **Premier but, dernier but, marque à chaque période** : joués par le moteur de match (`game_dynamics.team_events`, états augmentés de qui a marqué en premier / en dernier et de qui a marqué dans chaque période ; but de prolongation compté dans 64,9 % des prolongations, fusillade exclue comme au règlement). Mesuré contre les formules qu'ils remplacent (`explore_score/s8_marches_equipe.py`) : jamais moins bons, gain sous le seuil (z 0,2 / 1,9 / 1,7) — servis pour la cohérence avec le reste de la grille ; formules en repli sans `game_dynamics.json`.
- **Double chance (60 minutes)** : nouveau marché `double_chance`. Sélection = une équipe (« elle gagne en 60 OU égalité après 60 ») ou `no_draw` (« l'une des deux gagne en 60 »). Service ML : lu sur la grille (1X = 1 − « l'adversaire gagne en 60 », 12 = 1 − P(nul à 60')). Page match : groupe « Double Chance » recombiné depuis les tuiles finales de Match Betting. Coupon : trois options dans le sélecteur. Règlement : sur le score après 60 minutes. Non branché dans les corrélations du coupon (multiplié, signalé).

### 7.6 Le coupon d'un même match — `parlayProbability.ts`, `prediction/gameParlay.ts`

Les jambes lisibles sur le score final (vainqueur, totaux, handicap…) sont
combinées sur la loi jointe des scores : le facteur P(toutes) / ∏ P(chacune),
lu sur la grille, multiplie le produit des chiffres affichés. Depuis le
2026-10-15, **une** jambe joueur par match y entre aussi — « marque » (ligne 0,5)
ou « 1+ point » : sachant que son équipe a marqué n buts comptables, elle passe
avec 1 − (1 − s)^n, où s = cadence / buts comptables attendus de son équipe
(cadence tirée du chiffre affiché, μ = −ln(1 − p)). Les prolongations sont
tranchées par un but dans 64,9 % des cas (sinon fusillade, qui ne compte pour
aucun joueur). Le résultat ne dépasse jamais la jambe la moins probable. Les
autres props joueur (2+ buts, tirs…) et une seconde jambe joueur du même match
restent au produit, et `assumesIndependence` le signale. Mesure : §4.4,
`explore_players/README.md`.
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
| Recalage de niveau des buts | `level_report.json` | déviance du total −0,0032 (z −3,2), 8 saisons sur 11 ; P(> 5,5) 2023-26 58,4 % → 55,8 % (observé 56,0 %) |
| Modèle joueur, test 2023-26 | `player_report.json` | bat la règle sur les 8 statistiques |

**En clair :** le modèle est bien calibré (quand il dit 60 %, c'est ~60 %) et
nettement meilleur que des règles simples, mais **il ne bat pas encore la cote
de clôture** du marché sur le moneyline. Les value bets restent donc à
considérer comme un pari sur un petit avantage non prouvé.

---

## 9. Mise à jour : rafraîchir et réentraîner

| Quand | Commande | Ce que ça change |
|---|---|---|
| Avant un backtest sur les cotes récentes | `npm run odds:export-snapshots` (dans `server/`, avec la `DATABASE_URL` de production) | Écrit `ml/data/odds_snapshots_live.csv` : la collecte live, tous livres. Le backtest la lit en plus du backfill et juge chaque livre séparément (BET99 aura sa propre ligne dans `--served` quand il aura assez de matchs). |
| Chaque semaine (tâche planifiée Windows `ml/refresh-data.cmd`) | `python refresh_data.py` | Nouvelles données de la saison en cours → `inference_state.json`, `elo_ratings.json`, le recalage de niveau de la saison → `level_layer.json`, et le moteur de match → `game_dynamics.json`. **Mêmes modèles.** Il faut ensuite committer ces 4 fichiers et pousser (le service embarque `ml/models/` dans son image). |
| Moteur de match seul | `python game_dynamics.py` (`--check` pour contrôler le fichier en place) | Réécrit `game_dynamics.json` : τ glissant + table c sur les 3 dernières saisons complètes. Aussi lancé à la fin de `train_score.py`. |
| Réentraînement (mensuel) | `python build_dataset.py && python train_score.py && python train.py && python train_player.py && python train_shots.py` | Nouveaux modèles + rapports. |
| Couche de correction | `python backtest_walkforward.py --correction --write-layer` | Réécrit `correction_layer.json` seulement si le verdict est « ADOPTER ». |
| Recalage de niveau (re-mesure) | `python live_pregame.py && python measure_level.py` | Réécrit `level_report.json` (verdict, force n0). `refresh_data.py` le lit : verdict « REJETER » → k = 1. |
| Contrôles | `python backtest.py`, `python backtest_walkforward.py [--clv|--derived|--market-gap]` | Rapports dans `ml/models/*_report.json`. |
| Règles des value bets | `python backtest_walkforward.py --served` | Rejoue la chaîne servie (modèle de score + correction + λ recalés) contre le prix du matin, avec la règle en service : ROI, CLV, placebo, verdict sur la règle et grille de bandes → `served_value_bets_report.json`. |

---

## 10. Exemple complet chiffré

Match fictif : le domicile a λ_dom = **3,30** buts attendus en 60 min, le
visiteur λ_ext = **2,70** (chiffres calculés avec les vrais τ et p_ot du rapport —
la matrice Poisson × τ servie jusqu'au 2026-10-15. Avec le moteur de match :
nul après 60 min 21,9 %, puck line −1,5 38,5 %, plus de 5,5 buts 55,8 % ; 3e
période plus de 1,5 buts 63,8 % au lieu de 58,9 % avec la part fixe).

1. **Prolongation** : p_ot = σ(0,2834 × 0,60 − 0,0640) = **52,7 %**.
2. **Matrice** sans τ : nul après 60 min 16,2 %. **Avec τ : 21,9 %**.
3. **Victoire en 60 min** = Σ M[i>j] = 49,1 %.
4. **Victoire (moneyline)** = 49,1 % + 21,9 % × 52,7 % = **60,7 %**.
5. **Couche de correction** : avec toutes les autres variables à leur moyenne, z = 0,0863 + 0,4667 × logit(0,607) → **57,2 %** ; si en plus le domicile a +60 d'ELO, +0,04 de xGF% court terme, +0,3 xG d'alignement, +0,5 de star power, etc. → **62,9 %**. Le service recale alors les λ (somme 6,00 conservée) pour que la matrice donne exactement 62,9 %, et **les étapes 3, 4, 6-9 se refont sur cette matrice recalée** — les chiffres ci-dessous sont ceux de la matrice brute, pour suivre le calcul pas à pas.
6. **Puck line −1,5** = Σ M[écart ≥ 2] = **37,3 %**.
7. **Plus de 5,5 buts** : total final espéré 6,23 → **56,0 %**. Avec le recalage de niveau de fin 2025-26 (k = 0,9735, §4.3 bis), la somme des λ passe de 6,00 à 5,84 (3,22 / 2,62), la victoire reste **60,7 %**, le « plus de 5,5 » descend à **53,4 %** et la puck line −1,5 à 37,0 %.
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
| `game_dynamics.py` | **Moteur de match** (§4.1.4 bis) : ajustement de τ glissant et de la table c → `game_dynamics.json` ; matrice du match et marchés de période (partagé ajustement / service). |
| `train.py` | Classifieur moneyline (informatif). |
| `train_player.py` | Modèle joueur (8 statistiques). |
| `train_shots.py` | Modèle de tirs d'équipe → arrêts du gardien ; recalage hebdomadaire des tirs (`refresh_shots_level`). |
| `ml_service.py` | Service FastAPI (toutes les routes de prédiction). |
| `backtest.py` | Backtest sur le test + `--reliability` (calibration par tranches). |
| `backtest_walkforward.py` | Backtests saison par saison : ROI, CLV, marchés dérivés, incertitude, sélection de features, correction, écart au marché… |
| `calibrate_live.py`, `fetch_live_goals.py`, `live_pregame.py` | Effets de score pour le direct. |
| `measure_level.py` | Mesure du recalage de niveau des buts (§4.3 bis) → `level_report.json`. |
| `measure_*.py`, `compare_*.py`, `probe_odds_books.py` | Études ponctuelles (face-à-face, retour de blessure, Corsi/Fenwick, sources de cotes). |
| `content_insights*.py` | Statistiques « contenu » pour les réseaux sociaux — sans lien avec les prédictions. |
| `fetch_data.py` | Ancienne collecte v3 (standings) — encore copiée dans l'image Docker. |

### Modèles et rapports (`ml/models/`)

| Fichier | Contenu |
|---|---|
| `score_model.json` / `score_report.json` | Modèle de score / ses réglages (features, τ, p_ot, déciles, métriques). |
| `game_dynamics.json` | Moteur de match : table c (avance × tranche), τ glissant, fenêtre de saisons, diagnostics. |
| `game_model.json` / `training_report.json` / `feature_importance_game.json` | Classifieur / Platt, mélange, métriques. |
| `correction_layer.json` / `correction_report.json` | Couche de correction / sa mesure. |
| `level_layer.json` / `level_report.json` | Recalage de niveau de la saison en cours (k, comptes) / sa mesure et sa règle. |
| `player/*.json` / `player_report.json` / `player_state.json` | Modèle joueur / rapport / état des joueurs (+ face-à-face par adversaire). |
| `shots_model.json` / `shots_report.json` / `shots_level_layer.json` | Modèle de tirs / rapport (mesures, k, coefficient du partant) / recalage des tirs de la saison. |
| `player_vs_report.json` | Mesure du face-à-face joueur vs adversaire, stat par stat (verdict `keep`). |
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
| `oddsClient.ts` / `oddsLogger.service.ts` | Cotes : livre d'**affichage** (`ODDS_BOOKMAKERS`, value bets), livre de **collecte** (`ODDS_COLLECT_BOOKMAKERS`, DraftKings, série du CLV et `odds_log`) et livres **parallèles** (`ODDS_SHADOW_BOOKMAKERS`, défaut `bet99_ca_on`, archivés dans `odds_snapshots` seulement ; `none` désactive). Six passes par jour, même coût avec ou sans livres parallèles (≤ 10 livres = une région). |
