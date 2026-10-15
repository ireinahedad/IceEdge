# explore_players — piste 2 : les joueurs tirés du match simulé

Document de référence : « ICEEDGE — Des buts attendus à tous les paris » (Claude Docs), piste 2.

## Ce qui a été mesuré

Données hors échantillon : 189 000 joueur-matchs, validation 2022-23 et test 2023-24 → 2025-26.
- λ : `score_model.json` sur les matchs de validation et de test de `train_score.py`, recalés en niveau comme le service.
- μ : les boosters de `train_player.py` (entraînés jusqu'en 2021-22).

Il faut d'abord produire les λ avec `python explore_score/s0_lambdas.py`, puis :

    python explore_players/topdown.py   # marginales : répartir la grille vs modèle joueur
    python explore_players/joint.py     # combinés d'un même match : facteur de la grille vs produit
    GRID=poisson SHARE=EN python explore_players/joint.py   # robustesse : la grille Poisson du coupon Node

Les règles de décision ont été posées avant chaque run (voir l'en-tête des scripts).

## Résultats

**Marginales (`topdown_report.json`) — non adopté.** Répartir les buts de la grille entre les joueurs (part s = μ / Σ μ de l'équipe) ne prédit pas mieux les buts, passes et points que le modèle joueur seul.

| Stat | Δ log-vraisemblance en test | z |
|---|---|---|
| Buts | +0,00004 | +0,5 |
| Passes | −0,00012 | −1,1 |
| Points | −0,00006 | −0,4 |

Le modèle joueur reste la source des chiffres affichés.

**Combinés (`joint_report.json`) — adopté.** Le facteur de la grille fait nettement mieux que le produit des deux probabilités (log-perte sur 4 issues, en test) :

| Couple | z en test | Lift observé | Lift prévu par la grille |
|---|---|---|---|
| X marque + son équipe gagne | +26 | 1,33 | 1,30 |
| X a 1+ point + son équipe gagne | +37 | 1,27 | 1,26 |
| X marque + plus de 5,5 buts | +22 | 1,24 | 1,24 |
| X marque + son équipe gagne par 2+ | +24 | 1,50 | 1,45 |
| X marque + l'adversaire gagne | +26 | 0,67 | 0,69 |
| Deux coéquipiers marquent | +0,1 | 1,02 | 1,01 |

Pour deux coéquipiers, il n'y a rien à gagner : ces paris restent au produit.

Le résultat tient avec la grille Poisson simple et la part μ / E[N] (`joint_report_poisson_EN.json`, z de 22 à 39) : c'est ce qui est branché dans `server/src/services/prediction/gameParlay.ts`.

Part des prolongations tranchées par un but (et non en fusillade) : q = 0,649, mesurée sur 1 849 prolongations de 2015-16 à 2021-22.

## Limite connue

La table c du moteur (`game_dynamics.json`) a été ajustée sur une fenêtre récente qui recoupe le test. Cela fait une légère fuite sur la forme du match, mais pas sur les niveaux. La variante Poisson, qui n'utilise pas cette table, donne le même verdict.
