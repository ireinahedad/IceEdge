# Incohérences repérées dans le ML — à corriger

> Repérées le 2026-10-02 en écrivant [`EXPLICATION_ML.md`](./EXPLICATION_ML.md).
> Rien n'a été modifié dans le code : ce document liste seulement les problèmes,
> pour que tu puisses les trier et les corriger.
>
> **Gravité**
> - 🔴 **Haute** : change les probabilités servies ou les value bets, dès aujourd'hui.
> - 🟠 **Moyenne** : décalage réel entre l'entraînement et le service, ou chiffres incohérents entre pages, à effet plus limité.
> - 🟡 **Basse** : commentaire faux, documentation périmée, petite divergence de constantes.
>
> Chaque point donne : **où**, **ce qui se passe**, **pourquoi c'est un problème**, **piste de correction**.
> Les points marqués « **à vérifier** » n'ont pas pu être confirmés sans les données (CSV non versionnés).

---

## Tableau récapitulatif

| # | Gravité | Sujet | Fichiers |
|---|---|---|---|
| 1 | ✅ | ~~Repos = 2 jours en début de saison, l'entraînement a appris 7~~ — corrigé le 2026-10-02 | `restTravel.ts`, `build_dataset.py` |
| 2 | ✅ | ~~Repos, gardiens et absents calculés pour AUJOURD'HUI, pas pour la date du match~~ — corrigé le 2026-10-02 | `restTravel.ts`, `featureEngineering.ts` |
| 3 | ✅ | ~~Noms de gardiens et d'absents comparés sans retirer les accents~~ — corrigé le 2026-10-02 | `ml_service.py` |
| 4 | ✅ | ~~Value bets : edge calculé sur une probabilité arrondie à l'entier~~ — corrigé le 2026-10-02 | `ml_service.py`, `valueBets.service.ts` |
| 5 | 🟠 | Value bets : la bande 2-6 % a été mesurée sur un autre modèle que celui servi — **mesure prête, à lancer** (`--served`) | `valueBets.service.ts`, `backtest_walkforward.py` |
| 6 | ✅ | ~~Couche de correction appliquée à la victoire seulement → tuiles qui ne s'additionnent plus~~ — corrigé le 2026-10-03 (voir la note puck line) | `ml_service.py`, `score_model.py` |
| 7 | 🟠 | Absences : définies différemment à l'entraînement et au service | `build_dataset.py`, `ml_service.py` |
| 8 | 🟠 | Le filtre « début de saison » (`MIN_GP`) ne filtre presque rien | `build_dataset.py` |
| 9 | 🟠 | τ, p_ot et déciles ajustés sur des λ que le code lui-même juge sur-ajustés | `train_score.py` |
| 10 | 🟠 | Classifieur : cotes d'ouverture ≠ clôture à l'entraînement, identiques au service ; commentaire « blend jamais actif » faux | `train.py`, `ml_service.py` |
| 11 | 🟠 | « Best bets » : classement par probabilité (pas par valeur), règles et ML mélangés, autre modèle joueur | `bestBets.service.ts` |
| 12 | ✅ | ~~`/predict/player` : points AN, victoires de gardien et mises en échec mal estimés~~ — corrigé le 2026-10-03 | `ml_service.py`, `featureEngineering.ts` |
| 13 | ✅ | ~~Premier buteur : cadence du modèle joueur ÷ buts de match des règles~~ — corrigé le 2026-10-03 | `playerRates.ts` |
| 14 | 🟠 | Modèle joueur : jointure par `gameId` alors que `build_dataset` dit que les identifiants diffèrent (**à vérifier**) | `train_player.py`, `build_dataset.py` |
| 15 | 🟠 | ELO entre deux saisons : 30 % de régression à l'entraînement, 33 % au service | `build_dataset.py`, `ml_service.py` |
| 16 | 🟡 | Trois découpages différents des buts par période dans le même service | `ml_service.py` |
| 17 | 🟡 | Périodes 1-2 sans correction τ, période 3 avec | `ml_service.py` |
| 18 | 🟡 | Blanchissage légèrement surestimé (nul 0-0 perdu en prolongation) | `ml_service.py` |
| 19 | 🟡 | Commentaires/documentation faux ou périmés | divers |

---

## ✅ 1. Repos = 2 jours en début de saison, alors que l'entraînement a appris 7

> **Corrigé le 2026-10-02.** Calendrier publié mais aucun match de saison régulière joué → `SEASON_START_REST` = `{ restDays: 7, b2b: 0, dense3in4: 0 }` (`restTravel.ts`). Calendrier vide ou API en panne → toujours le repli de 2 jours (on ne sait pas). Verrouillé par `server/src/services/nhl/restTravel.test.ts`. Reste ouvert : renvoyer « inconnu » (NaN) plutôt que 2 en cas de panne, ce qui demande de rendre `home_rest_days` optionnel dans `GameFeatures` côté Python.

**Où**
- `server/src/services/nhl/restTravel.ts:75` (`fallback = { restDays: 2, … }`, utilisé quand aucun match n'a encore été joué cette saison) et `featureEngineering.ts:231-233`.
- `ml/python/build_dataset.py:593` (`min((d - last[team]).days, 7)`).

**Ce qui se passe.** À l'entraînement, le premier match d'une saison a `rest_days = 7` (des mois depuis le dernier match, plafonnés à 7). En production, `fetchTeamRestInfo` ne lit que le calendrier de la saison EN COURS : tant qu'une équipe n'a pas joué, il renvoie le repli **2 jours**.

**Pourquoi c'est un problème.** `rest_days` est une feature du modèle de score des deux côtés (`atk_rest_days`, `def_rest_days`), du classifieur (`rest_days_diff`) et du modèle joueur (`days_rest`). Le premier match de chaque équipe (c'est-à-dire **maintenant**, début octobre) est prédit comme si elle avait 2 jours de repos — une situation que le modèle n'a jamais vue pour un match d'ouverture. Le même repli s'applique aussi si l'API NHL tombe en panne.

**Correction.** Si aucun match n'a été joué cette saison, renvoyer `restDays: 7, b2b: 0, dense3in4: 0` (exactement ce que l'entraînement voit). Garder 2 jours seulement pour une vraie panne — ou mieux, renvoyer « inconnu » et laisser le service mettre NaN.

---

## ✅ 2. Repos, gardiens et absents calculés pour AUJOURD'HUI, pas pour la date du match

> **Corrigé le 2026-10-02.** `buildGameFeatures` accepte `gameDate` (le
> `gameDate` NHL, heure de l'Est) et lit à cette date le repos, le gardien
> partant saisi et les absents. `fetchTeamRestInfo(abbr, gameDate)` compte les
> matchs terminés avant aujourd'hui et les matchs PRÉVUS d'aujourd'hui à la
> veille du match (hors reportés/annulés) : pour un match de demain, celui de
> ce soir compte, donc le dos-à-dos est détecté. La date est passée par le
> paquet ML (`gameMlBundle.ts`), les best bets et le moteur de règles
> (`nhlPredictions.ts`, `getManualFactors`). Reste à la date du jour : la route
> tuile par tuile `POST /api/predict/ml`, qui ne reçoit pas de date (les pages
> match passent par le paquet).

**Où**
- `server/src/services/nhl/restTravel.ts:78` (`const today = todayET()` : le repos = jours entre **aujourd'hui** et le dernier match joué).
- `server/src/services/featureEngineering.ts:221-222` : `getStartingGoalies()` et `getLineupDay()` appelés sans date → la saisie **du jour**.

**Ce qui se passe.** `buildGameFeatures` ne connaît pas la date du match. Pour un match de demain (page d'un match à venir, paquet ML, « best bets » sur 2 jours) :
- le repos est faux d'un jour (et le dos-à-dos de demain n'est pas détecté, puisque le match de ce soir n'est pas encore « terminé ») ;
- le gardien partant et les absents utilisés sont **ceux saisis pour aujourd'hui** — pour une équipe qui joue deux soirs de suite, c'est le gardien de ce soir qui est appliqué à demain.

Les value bets ne sont pas touchés (ils ne regardent que les matchs du jour), mais toutes les tuiles des matchs futurs le sont, et le paquet est mis en cache 10 minutes.

**Correction.** Passer la date du match (heure de l'Est) à `buildGameFeatures`, puis à `fetchTeamRestInfo(abbr, date)`, `getStartingGoalies(date)` et `getLineupDay(date)` ; calculer le repos par rapport à cette date.

---

## ✅ 3. Noms de gardiens et d'absents comparés sans retirer les accents

> **Corrigé le 2026-10-02.** Toutes les comparaisons de noms de `ml_service.py`
> (gardien partant, drapeau de relève, absents pour `star_power`,
> `stars_out_weight` et la projection d'alignement) passent par `_name_key` :
> sans accents, sans points, espaces réduits, minuscules. Un gardien partant
> nommé mais introuvable est signalé une fois dans les logs du service
> (« introuvable dans l'état d'inférence »). Mesuré avant/après sur ANA avec
> les vrais modèles : « Lukáš Dostál » + absent « Jöhn Carlson » donnait
> relève = 1, absence ignorée, λ adverse 3,39 et victoire 45,3 % ; maintenant
> exactement comme l'orthographe MoneyPuck (relève = 0, λ adverse 3,18,
> victoire 47,7 %).
>
> **Complété le 2026-10-02 : appariement par identifiant NHL.** Le serveur
> traduit le nom saisi en identifiant via l'effectif NHL (`goalieIds.ts`,
> `fetchTeamGoalies`, une requête en cache 6 h) et envoie `home_goalie_id` /
> `away_goalie_id` ; le service apparie l'identifiant d'abord, le nom ensuite
> (`_find_goalie`). `build_dataset.py` écrit désormais `id` pour chaque gardien
> de l'état d'inférence. ⚠️ L'état actuellement versionné n'a pas encore ces
> identifiants (l'API NHL n'est pas joignable depuis l'environnement où la
> correction a été faite) : ils apparaîtront au prochain `refresh_data.py`.
> D'ici là, le nom normalisé sert de repli — comportement identique à avant.

**Où** — `ml/python/ml_service.py`
- l.1888 et l.2036 : gardien partant, `g["name"].lower() == goalie_name.lower()` ;
- l.2050 : absents, `scratch_set = {s.strip().lower() …}` puis comparaison exacte aux noms MoneyPuck (l.2061, 2073, 2100, 2104).

Alors que, dans le même fichier, `_name_key` (l.1901) retire bien les accents pour l'alignement officiel.

**Ce qui se passe.** Les noms de l'état d'inférence sont ceux de MoneyPuck (sans accents : « Juraj Slafkovsky »). Mais :
- les **absents officiels** et les blessés viennent de l'API NHL, **avec** accents (« Juraj Slafkovský ») — voir `scratches.ts` ;
- le gardien partant est **tapé à la main** dans `/dev/saisie`.

**Pourquoi c'est un problème.**
- **Absent accentué → ignoré en silence** : il reste compté dans `star_power`, `stars_out_weight` ne le voit pas, et (sans alignement officiel) il reste dans la projection d'alignement.
- **Gardien mal orthographié ou accentué → considéré comme gardien de RELÈVE** : `_goalie_backup_flag` renvoie 1.0 pour un nom inconnu (l.1891), et ses chiffres sont remplacés par la moyenne des deux gardiens habituels. `def_goalie_backup` est la 6e feature la plus importante du modèle de score : une faute de frappe sur le titulaire fait monter les λ de l'adversaire. Comme **les value bets exigent que les deux gardiens soient saisis**, ce chemin est emprunté à chaque value bet.

**Correction.** Comparer partout avec `_name_key` (sans accents, minuscules) ; idéalement apparier par identifiant NHL quand il est connu. Journaliser (ou renvoyer dans la réponse) tout gardien ou absent nommé qui n'a pas été reconnu, pour que l'erreur de saisie se voie.

---

## ✅ 4. Value bets : l'edge est calculé sur une probabilité arrondie à l'entier

> **Corrigé le 2026-10-02.** Le service renvoie `probability_exact` (0–1, non
> arrondie) avec chaque réponse ; `valueBets.service.ts` l'utilise pour l'edge,
> l'EV, la cote minimale et le journal CLV (repli sur l'entier face à un
> service ML plus ancien). En direct, le chiffre recalculé porte
> `probability_exact: null`. Test : un 52 % affiché à 51,6 % exact n'est plus
> retenu à tort (edge 1,6 % < 2 %). Reste hors périmètre : les combinés
> (`parlay.ts`, `slip.service.ts`, `ml.routes.ts`) multiplient des
> pourcentages entiers de jambes — erreur d'arrondi d'affichage, sans effet
> sur les value bets.

**Où**
- `ml/python/ml_service.py:2366` : `probability=round(prob * 100)` (entier) ;
- `server/src/services/valueBets.service.ts:172` : `modelProb = r.probability / 100`.

**Ce qui se passe.** Le modèle calcule par ex. 57,4 %, renvoie 57, et le serveur calcule l'edge avec 0,57.

**Pourquoi c'est un problème.** L'erreur d'arrondi va jusqu'à ±0,5 point, sur une règle dont la bande fait 2 à 6 points (et ≥ 4 points pour la puck line) : un pari à 1,6 % d'edge réel peut passer, un à 2,4 % peut être rejeté, et l'edge, l'EV et la cote minimale affichés sont imprécis. Le journal CLV (`value_bet_log.first_model_prob`) stocke aussi la valeur arrondie.

**Correction.** Ajouter à `MLResponse` un champ non arrondi (par ex. `probability_exact: float` en 0-1) et l'utiliser dans `valueBets.service.ts` (et dans le journal).

---

## 🔴 5. Value bets : la bande « 2 % – 6 % » a été mesurée sur un autre modèle que celui servi

**Où**
- `server/src/services/valueBets.service.ts:25-33` (« Probabilité du MODÈLE DE SCORE » ; « edge ∈ [2 %, 6 %] — bande du backtest walk-forward ») ;
- `ml/python/backtest_walkforward.py` mode par défaut (l.~4090-4130) : il évalue le **classifieur calibré puis mélangé avec la cote de clôture** (`fit_fold` → `w_blend`), et mesure l'edge contre la **clôture**.

**Ce qui se passe.** En production, la probabilité utilisée est celle du **modèle de score + couche de correction** (le marché `moneyline` du paquet passe par `_apply_correction`, l.2333-2338), sans mélange avec le marché, comparée à la cote **du moment** (souvent bien avant la clôture). Le commentaire parle du « modèle de score », alors que c'est la valeur corrigée.

**Pourquoi c'est un problème.** Un mélange avec le marché a des edges beaucoup plus petits et différemment répartis qu'un modèle seul : un edge de 5 % n'a pas le même sens dans les deux cas. Le plafond de 6 % (« au-delà, info manquée ») et le plancher de 2 % ne sont donc pas validés pour le modèle effectivement servi. Le rapport CLV (`backtest_clv_report.json`) est plus proche de l'usage réel (prix d'ouverture) — à vérifier quel modèle il utilise exactement.

**Correction.** Rejouer le walk-forward ROI/CLV avec exactement la chaîne servie (modèle de score walk-forward → couche de correction walk-forward → edge contre le prix d'ouverture/du moment, même livre), puis refixer la bande à partir de ce résultat. Corriger le commentaire de `valueBets.service.ts`.

> **Mesure préparée le 2026-10-03 : `python backtest_walkforward.py --served`**
> (dans `ml/python`, avec les CSV de `ml/data/` et `odds_snapshots_hist.csv`).
> Elle rejoue la chaîne servie saison par saison, sans regarder l'avenir :
> modèle de score du fold → couche de correction walk-forward (variante C) →
> λ recalés (#6) → edge contre le prix du MATIN (ouverture SBRO, ou premier
> snapshot API de 15:25Z), règle en service (moneyline 2-6 %, puck line −1.5
> ≥ 4 %, EV ≥ 0). Elle mesure ROI, CLV vers la clôture et CLV net du placebo,
> pour le modèle servi et pour le modèle brut. Rapport :
> `ml/models/served_value_bets_report.json`.
>
> **Critère fixé avant le run** (par marché et par source, modèle servi) :
> moins de 200 paris moneyline / 100 puck line → NON TRANCHABLE ;
> ROI z ≤ −2 ou CLV net z < 0 → REJETÉE ; CLV net z ≥ 2 → CONFIRMÉE ;
> sinon NON TRANCHABLE. La source qui décide est The Odds API (les prix de
> production) ; SBRO sert de contexte. La « meilleure bande » de la grille est
> choisie sur les mêmes données : c'est une piste à confirmer sur la saison
> 2026-27, pas une règle à adopter sur ce seul run.
>
> Testé sur un jeu synthétique (le mode tourne de bout en bout et écrit son
> rapport) ; pas encore lancé sur les vraies données, qui ne sont que sur le
> poste local. Durée attendue : quelques minutes avec le cache
> d'hyperparamètres (`fold_params_cache.json`), plus long s'il est invalidé.


---

## ✅ 6. La couche de correction ne touche que la victoire → les tuiles ne s'additionnent plus

> **Corrigé le 2026-10-03** (option 1 ci-dessous). La victoire corrigée est
> traduite en distribution : somme des λ conservée, partage choisi pour que la
> matrice donne exactement la victoire corrigée (`score_model.lambdas_for_home_win`,
> `ml_service._align_distribution`). Mesuré sur 142 affiches avec les vrais
> modèles : |60 min + prolongation − victoire| passe de 2,15 pt en moyenne
> (max 9,7) à 0 ; la somme des scores exacts gagnants aussi. Moneyline
> inchangé, totaux quasi inchangés (0,03 pt), victoire en 60 min −/+ 2,0 pt en
> moyenne (max 7,9), **puck line ±1,8 pt en moyenne (max 6,4)**. Le direct
> reçoit désormais victoire, prolongation et λ de la même matrice.
>
> ⚠️ **Conséquence sur les value bets puck line** : la règle A2 (edge ≥ 4 %)
> a été pré-enregistrée et mesurée sur la puck line du modèle BRUT ; elle
> s'applique maintenant à la puck line recalée, qui n'a pas été mesurée —
> **choix assumé le 2026-10-03** (cohérence d'abord). À rejouer dans le
> walk-forward (`--derived`, en y appliquant le recalage), avec le point #5.

**Où** — `ml/python/ml_service.py:2333-2338` (correction appliquée seulement si `market_type == "moneyline"`) ; `server/src/services/gameMlBundle.ts` (`applyLive`).

**Ce qui se passe.** Exemple réel du §10 de l'explication : la matrice des scores donne victoire **60,7 %** (= 49,1 % en 60 min + 11,6 % en prolongation), la correction affiche **57,2 %** ou **62,9 %** selon les autres variables. Mais « gagne en 60 min », « gagne en prolongation », « puck line », « score exact », « écart de victoire », « mène après la 3e »… restent calculés sur la matrice non corrigée.

**Pourquoi c'est un problème.**
- Sur la page d'un match, « gagne en 60 min » + « gagne en prolongation/fusillade » ≠ « gagne », et la somme des scores exacts gagnants ≠ la victoire affichée.
- En direct, `applyLive` mélange la victoire **corrigée** (`preHome`) avec la prolongation et les λ **non corrigés**.
- Un coupon combiné (parlay) sur un même match peut être calculé sur deux visions différentes du match.

**Correction (au choix).**
1. Traduire la correction en un ajustement des λ (par ex. ajuster l'écart λ_dom/λ_ext en gardant la somme, comme `stretch_lambdas`) pour que la victoire de la matrice égale la victoire corrigée → tous les marchés restent cohérents ;
2. ou, a minima, documenter dans l'interface que la victoire est corrigée et pas le reste, et utiliser la victoire non corrigée dans `applyLive`.

---

## 🟠 7. Les absences sont définies différemment à l'entraînement et au service

**Où** — `ml/python/build_dataset.py:534-558` (entraînement) ; `ml/python/ml_service.py:2051-2073` (service).

**Ce qui se passe.**
- **Entraînement** : `stars_missing` / `stars_out_weight` comptent **tout** joueur du top-5 / du groupe clé vu sur les 10 derniers matchs de l'équipe qui ne joue pas ce soir — y compris un joueur **échangé** ou parti (il reste « absent » de son ancienne équipe pendant 10 matchs) et un blessé longue durée (pendant 10 matchs, puis il disparaît).
- **Service** : seuls les joueurs que le serveur **nomme** comme absents comptent (le commentaire l.2052-2056 explique pourquoi les échangés sont exclus).

**Pourquoi c'est un problème.** Le modèle a appris sur une variable plus « bruyante » (avec de faux absents) que celle qu'il reçoit en production : la valeur d'une absence n'est pas la même dans les deux cas.

**Correction.** À l'entraînement, ne compter comme absent qu'un joueur qui a joué pour l'équipe à son match précédent ET qui n'a pas joué ce soir pour une autre équipe (exclure les changements d'équipe) ; puis réentraîner.

---

## 🟠 8. Le filtre « début de saison » (`MIN_GP`) ne filtre presque rien

**Où** — `ml/python/build_dataset.py:237` (`"team_gp": np.arange(len(g))`) et l.906-909.

**Ce qui se passe.** `team_gp` compte les matchs de l'équipe **depuis 2008**, toutes saisons confondues. La condition `team_gp >= 5` n'écarte donc que les 5 tout premiers matchs de l'historique de chaque franchise (2008, VGK 2017, SEA 2021), pas les 5 premiers matchs de chaque saison comme le dit le commentaire « Filtre début de saison ».

**Pourquoi c'est un problème.** Ce n'est pas forcément mauvais (le service, lui, doit prédire les débuts de saison, donc les garder est cohérent), mais le code ne fait pas ce que son commentaire annonce, et quelqu'un pourrait se fier à ce filtre.

**Correction.** Choisir : soit corriger le commentaire (« ne filtre que le début de l'historique »), soit compter par saison et assumer que le modèle ne voit plus les matchs d'ouverture (déconseillé, puisqu'il doit les prédire).

---

## 🟠 9. τ, p_ot et les déciles de confiance sont ajustés sur des λ « sur-ajustés »

**Où** — `ml/python/train_score.py:670-699` (τ, `p_ot_home`, `fit_ot_model`, `confidence_calibration` sur `lam_h_tr, lam_a_tr`, les λ de l'**entraînement**) vs le commentaire de `fit_gamma` l.417-419 : « sur l'entraînement, les λ sont déjà sur-ajustés — trop dispersés ».

**Ce qui se passe.** Le code dit lui-même que les λ prédits sur les matchs d'entraînement sont trop dispersés (le modèle les a vus), puis utilise ces mêmes λ pour ajuster τ (via la distribution des écarts attendue), la pente de la prolongation et les déciles de confiance.

**Pourquoi c'est un problème.** Biais possible de τ et de la pente p_ot (les écarts « attendus » sont trop larges sur l'entraînement). La calibration du test reste bonne (nuls 21,5 % prédits / 22,1 % observés), donc l'effet est probablement petit — mais la justification est contradictoire.

**Correction.** Ajuster ces trois réglages sur des λ hors échantillon : la validation, ou mieux des λ « out-of-fold » (validation croisée temporelle sur l'entraînement).

---

## 🟠 10. Classifieur : cotes d'ouverture ≠ clôture à l'entraînement, identiques au service ; « blend jamais actif » est faux

**Où**
- `ml/python/train.py:95` : `ODDS_FEATURES = ["market_home_p_open", "market_home_p_close"]` ;
- `ml/python/ml_service.py:2150-2151` : les deux reçoivent la même cote du moment ;
- `ml/python/ml_service.py:2234-2240` : commentaire « Ce blend n'a **jamais été actif** … cette clé est absente du rapport » ;
- `server/src/services/featureEngineering.ts:24` : « Mettre à false pour obtenir la proba PURE du modèle (détection de value) ».

**Ce qui se passe.**
- Le classifieur a appris avec deux cotes différentes (ouverture et clôture, l'écart entre les deux porte de l'information) et reçoit au service deux fois la même valeur.
- `training_report.json` contient **maintenant** `blend_weights` ([0,564 ; 0,634 ; −0,056]) : le mélange modèle ⊕ marché **est** actif dès qu'il y a des cotes. `probability_classifier` n'est donc plus « le classifieur » mais « classifieur ⊕ marché » — la comparaison score/classifieur affichée est biaisée vers le marché.
- La probabilité servie vient du modèle de score, qui n'utilise jamais les cotes : `includeOdds: false` ne change plus rien à la « proba pure ».

**Pourquoi c'est un problème.** Uniquement de l'affichage et de la comparaison aujourd'hui, mais trompeur pour qui lit le code ou compare les deux modèles.

**Correction.** Renvoyer dans `probability_classifier` la valeur Platt (sans marché) ; mettre à jour les deux commentaires. Si le classifieur doit être gardé : l'entraîner avec une seule colonne de cote (celle disponible au moment de la prédiction), ou le supprimer comme prévu (S4 ⑤).

---

## 🟠 11. « Best bets » : classement par probabilité, règles et ML mélangés, autre modèle joueur

**Où** — `server/src/services/bestBets.service.ts:390-420`, `mlScore` l.235-252.

**Ce qui se passe.**
1. Les paris sont triés par **probabilité** (`score`), pas par edge ou EV : les « meilleurs paris » sont les issues les plus probables (gros favoris, « moins de 0,5 tir »…), quel que soit leur prix.
2. Les candidats sont d'abord triés par score des **règles**, seuls les 30 premiers reçoivent un score ML, puis tout est retrié : la liste finale compare des scores ML et des scores de règles comme s'ils étaient sur la même échelle.
3. Les props joueur passent par `/predict/player` (Poisson sur la moyenne de saison), **pas** par le modèle joueur entraîné utilisé sur la page match : le même joueur a deux probabilités différentes selon la page.

**Correction.** Selon l'intention : renommer la section (« issues les plus probables ») ou trier par edge/EV quand un prix existe ; enrichir tous les candidats avec la même source ; utiliser les cadences du paquet ML (`player_rates`) pour les props joueur.

---

## ✅ 12. `/predict/player` : points en AN, victoires de gardien et mises en échec mal estimés

> **Corrigé le 2026-10-03.** Le serveur envoie les cadences MESURÉES sur le
> joueur, que sa fiche portait déjà : points en AN (nouveau champ
> `pp_points_per_game`), mises en échec, tirs bloqués, victoires et
> blanchissages du gardien (par match joué). Le service lit `wins` /
> `shutouts` comme une probabilité oui/non (0,50 → 50 %, et non plus 39 %) ;
> `pp_point` sans mesure → pas d'estimation (fini `buts × 0,35`). Replis de
> ligue alignés sur les mesures : 1,2 mise en échec, 0,84 tir bloqué par
> match. Exemple : un passeur à 0,40 point en AN par match passe de 5 % à 33 %.

**Où** — `ml/python/ml_service.py:2501-2527` ; `server/src/services/featureEngineering.ts:372-380`.

**Ce qui se passe.**
- **Points en avantage numérique** : `rate = buts par match × 0,35`. Les points en AN sont surtout des **passes** ; un passeur de premier plan obtient une cadence quasi nulle. Le modèle joueur (et `playerRates.ts`) ont une vraie statistique `ppPoints`.
- **Victoires / blanchissages de gardien** : la « cadence » 0,50 passe dans une Poisson : P(au moins 1 victoire) = 1 − e^−0,5 = **39 %**, et non 50 %. Une victoire est un événement oui/non, pas un comptage.
- **Mises en échec** : moyenne de ligue **2,1** par match pour tout le monde, alors que les autres parties du code mesurent ~1,1-1,2 (`playerRates.ts` PRIOR = 1,1 ; `player_report.json` moyenne observée 1,197).

**Correction.** Pour `pp_point`, envoyer la vraie cadence de points en AN ; pour `wins`/`shutouts`, traiter la cadence comme une probabilité directe (pas de Poisson) ; aligner la moyenne de mises en échec sur 1,2 — ou mieux, faire passer ces props par les cadences du modèle joueur.

---

## ✅ 13. Premier buteur : cadence du modèle joueur ÷ buts de match des règles

> **Corrigé le 2026-10-03.** Quand le paquet ML porte λ domicile et visiteur,
> `gameGoals` = λ_dom + λ_ext (modèle de score, recalés sur la victoire servie)
> pour TOUS les joueurs du match, modèle joueur ou règle : leurs probabilités
> de premier buteur sont sur la même échelle. Sans λ (service ML en panne),
> les buts de match de la règle, comme avant.

**Où** — `server/src/services/prediction/playerRates.ts:162-165` (`lamGame` = buts pour × buts contre / moyenne, depuis les fiches d'équipe) et l.218-219.

**Ce qui se passe.** Quand le modèle joueur est disponible, `firstGoal = (cadence de buts du MODÈLE) / lamGame (des RÈGLES) × (1 − e^−lamGame)`. Le paquet ML contient pourtant les λ du modèle de score (`lambdaHome`, `lambdaAway`).

**Pourquoi c'est un problème.** Le numérateur et le dénominateur viennent de deux modèles différents ; la somme des probabilités « premier buteur » sur les deux effectifs n'est plus garantie de valoir P(au moins un but).

**Correction.** Utiliser `bundle.lambdaHome + bundle.lambdaAway` (+ le but de prolongation) comme `gameGoals` quand le paquet est disponible.

---

## 🟠 14. Modèle joueur : jointure par identifiant de match (**à vérifier**)

**Où** — `ml/python/train_player.py:152` (`merge(ctx, left_on=["gameId", …], right_on=["game_id", …])`) vs `ml/python/build_dataset.py:825` (« gameId MoneyPuck ≠ game_id NHL » — d'où une jointure par équipe + date).

**Ce qui se passe.** Les deux fichiers font une hypothèse contraire. Si `build_dataset.py` a raison, **toutes** les features de contexte du modèle joueur (`tm_*`, `opp_*`, `b2b`, `days_rest`) sont vides à l'entraînement, alors qu'elles sont remplies au service → le modèle reçoit en production des valeurs qu'il n'a jamais vues. Si `train_player.py` a raison (les identifiants MoneyPuck récents ont bien le format NHL `2023020001`), c'est juste le commentaire de `build_dataset.py` qui est faux.

**Vérification (2 minutes).** Dans `train_player.py`, après `game_context(...)`, afficher `df["tm_xgf60_s"].notna().mean()`. Proche de 1 → seul le commentaire est à corriger. Proche de 0 → joindre par (équipe, date) et réentraîner.

---

## 🟠 15. ELO entre deux saisons : 30 % à l'entraînement, 33 % au service

**Où** — `ml/python/build_dataset.py:103` (`ELO_SEASON_REGRESS = 0.30` : on garde 70 % de l'écart à 1500) ; `ml/python/ml_service.py:391` (`ELO_CARRYOVER = 2/3` : on garde 66,7 %).

**Ce qui se passe.** Si `elo_ratings.json` date de la saison précédente (pas encore rafraîchi), le service régresse de 33 % ; l'entraînement a appris avec 30 %. Si le fichier a été rafraîchi après le premier match de la nouvelle saison, la régression de 30 % est déjà dans le fichier et le service n'ajoute rien (cas actuel). Deux chemins, deux valeurs.

**Correction.** Utiliser la même constante (0,30) des deux côtés, idéalement écrite dans `elo_ratings.json` par `build_dataset.py` et relue par le service.

---

## 🟡 16. Trois découpages différents des buts par période dans le même service

**Où** — `ml/python/ml_service.py` :
- l.1035 `_PERIOD_CUM = {1: 0.305, 2: 0.67}` → P1 30,5 %, P2 36,5 %, P3 33 % (qui mène après P1/P2) ;
- l.1571-1585 totaux par période : P1 31,7 %, P2 36,7 %, P3 31,7 % ;
- l.1127 « période la plus prolifique » : trois tiers égaux (33,3 % chacune), avec un commentaire qui dit ne pas avoir de données par période.

**Correction.** Une seule constante partagée, mesurée sur `fetch_live_goals.py` (les buts horodatés existent), utilisée par les trois marchés.

## 🟡 17. Périodes 1-2 sans correction τ, période 3 avec

**Où** — `ml/python/ml_service.py:1262-1275`. P(mène / égalité après P1, P2) utilise deux Poisson indépendantes (`_skellam_lead`) ; après P3, la matrice corrigée par τ. Les trois cartes de période ne sortent donc pas du même modèle (l'égalité après P2 peut sembler incohérente avec l'égalité après P3). Effet faible.

## 🟡 18. Blanchissage légèrement surestimé

**Où** — `ml/python/ml_service.py:1349` : `clean_sheet = Σ M[:, 0]` (l'adversaire à 0 après 60 min). Un 0-0 après 60 minutes que l'adversaire gagne en prolongation n'est plus un blanchissage → surestimation de P(0-0) × (1 − p_ot), environ 0,1-0,2 point. Conséquence : blanchissage domicile + blanchissage visiteur ≠ 1 − « les deux marquent ». Correction : soustraire `M[0,0] × (1 − p_ot)` (selon la règle de règlement des fusillades chez le livre).

## 🟡 19. Commentaires et documentation faux ou périmés

| Où | Problème |
|---|---|
| `ml_service.py:976-980` (`_p_both_score`) | Dit que les buts sont **sur**-dispersés (« Poisson donne 5 % de blanchissages, la NHL ~8,5 % »). Les mesures du projet disent le contraire : ratio variance/moyenne ≈ 1 (`score_model.py`) et 4,98 % de blanchissages (`prediction/scoreModel.ts`). Le code est juste, le commentaire faux. |
| `ml/python/README.md` | Périmé : `cd server/python`, « remplacer les coefficients logistiques à la main », ne mentionne ni le modèle de score ni `/predict/game/bundle`. |
| `ml_service.py:2615` (`/health`) | Annonce `"player": "Poisson Distribution"` même quand le modèle joueur entraîné est chargé. |
| `ml_service.py:720` (`MLResponse`) | « probability: 5–95 » alors que les bornes réelles sont [2, 98] (et [0, 98] pour le score exact). |
| `startingGoalies.ts` (en-tête) | « ne sert qu'aux EXCEPTIONS » alors que les value bets exigent les deux gardiens saisis pour chaque match. |
| `featureEngineering.ts:24` | « includeOdds: false → proba PURE du modèle » : faux depuis que la probabilité servie vient du modèle de score (cf. #10). |
| Taux de prolongation | 23,01 % (`score_model.py`), 22,04 % (`LEAGUE_OT_RATE`, `prediction/scoreModel.ts`), 22,1 % (test du modèle de score) : échantillons différents, à unifier ou à dater. |
| `correction_layer.json` | 7 features mais 8 valeurs dans `z` (probablement `logit p` en tête) : à étiqueter. |
| Voyage | Calculé dans le dataset et accepté par l'API mais utilisé par **aucun** modèle — à documenter comme tel dans `GameFeatures` ou à retirer. |

---

## Ordre de correction suggéré

1. ~~#1, #2, #3 et #4~~ : faits le 2026-10-02.
2. **#4** (arrondi) : un champ à ajouter, protège les value bets.
3. **#2** (date du match) : un paramètre à faire descendre dans trois fonctions.
4. **#14** : la vérification de 2 minutes, puis décider.
5. **#5** et **#6** : demandent une mesure (walk-forward) avant de trancher.
6. Le reste au fil de l'eau.
