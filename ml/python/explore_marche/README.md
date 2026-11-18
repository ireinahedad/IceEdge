# explore_marche — deux questions posées le 2026-11-16

Relecture du document technique (sections 7.2, 7.8, 7.9). Deux affirmations du
document n'avaient jamais été testées. Elles le sont ici, chacune avec un
critère fixé avant la mesure.

## m1_melange.py — le mélange modèle ⊕ marché bat-il la clôture ?

La section 7.2 donnait 0,6641 pour le mélange contre 0,6649 pour la clôture, sur
la seule tranche de test, avec des poids ajustés sur une validation, et notait
que l'écart « n'a pas été testé par paires ». Ici : walk-forward strict, poids
ajustés sur les seules saisons passées, test apparié par match.

Critère fixé avant le run : z ≤ −2 (apparié, par match) ET gain sur ≥ 70 % des
saisons.

Résultat (8 886 matchs cotés, 9 saisons, 2018-19 → 2026-27 début) :

| comparaison | écart de log-loss | z (match) | z (saison) | saisons | verdict |
| --- | --- | --- | --- | --- | --- |
| mélange − marché | −0,00091 | −1,54 | −0,71 | 6/9 | non tranchable |
| chaîne servie − marché | −0,00063 | −0,72 | −0,37 | 5/9 | non tranchable |
| mélange − chaîne servie | −0,00028 | −0,77 | −0,63 | 5/9 | non tranchable |
| moyenne 50/50 des logits − marché | −0,00119 | −2,70 | −1,34 | 8/9 | passe le critère |
| modèle brut − marché | +0,00193 | +1,84 | +1,77 | 2/9 | non tranchable |

Contrôle de la manip : les lignes « chaîne servie » (−0,0006, z −0,7) et
« modèle brut » (+0,0019, z +1,8) reproduisent `correction_report.json`
(−0,0006 z −0,8 ; +0,0017 z +2,0).

Lecture. Le mélange ajusté ne passe pas le critère : le document ne peut pas
affirmer que le mélange bat la clôture. La moyenne 50/50, qui n'ajuste rien, le
passe — mais c'est une variante parmi cinq testées, et son z par saison n'est
que de −1,34. Par source : SBRO −0,0015 (z −1,96), DraftKings −0,0002 (z −0,22).
Le mélange lit la clôture : ce n'est pas une stratégie de pari, c'est un test
d'information résiduelle.

## m2_clv_matin.py — la CLV survit-elle sans le gardien ni l'alignement ?

Le backtest donne au modèle le gardien qui a réellement commencé et les 18
patineurs réellement habillés. L'« ouverture » DraftKings est le premier
instantané du jour, à 15:25Z (10 h 25 à l'Est), avant la confirmation de
l'alignement. Les 7 variables inconnues à cette heure sont retirées du modèle de
score (`star_power`, `stars_out_weight`, `lineup_xg`, `lineup_pts`,
`goalie_gsax60`, `goalie_svpct`, `goalie_backup`), hyperparamètres re-cherchés
par fold. Même protocole CLV (`run_clv`), même placebo.

Moneyline, edge ≥ 2 % :

| source | variante | paris | ROI ouverture | CLV | t | placebo | CLV nette | z net |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DraftKings | complet | 2 630 | −0,73 % | +0,00321 | 9,24 | −0,00154 | +0,00475 | +11,45 |
| DraftKings | matin | 2 504 | −4,49 % | −0,00121 | −3,30 | −0,00157 | +0,00036 | +0,89 |
| SBRO | complet | 6 653 | +2,05 % | +0,01114 | 28,83 | +0,00028 | +0,01086 | +24,93 |
| SBRO | matin | 6 526 | −1,66 % | +0,00641 | 15,82 | +0,00019 | +0,00622 | +12,95 |

Règle A2 (puck line −1,5, DraftKings) : CLV nette +0,00368 (z +3,41) en complet,
−0,00057 (z −0,50) en matin.

Contrôle de la manip : la variante complète reproduit `backtest_clv_report.json`
du 1er novembre (2 630 paris contre 2 639 ; CLV 0,00321 contre 0,00322 ;
t 9,24 contre 9,29 ; nette 0,00475 contre 0,00475).

Lecture, fixée avant le run. CLV nette sous z = 2 en matin → ce que mesure la
section 7.8 est d'abord la valeur de l'information d'alignement. C'est le cas sur
DraftKings : la CLV passe de +0,32 à −0,12 point et devient négative, le marché
bouge CONTRE les paris du modèle du matin. Sur SBRO, dont l'ouverture précède de
plusieurs jours, 58 % de la CLV survit (t 15,8) : là, le modèle anticipe
réellement le marché sans rien savoir de l'alignement.

« matin » est un plancher, pas le modèle du matin : un vrai modèle du matin
utiliserait l'alignement attendu (gardien probable, absences annoncées).

## m3_precision.py — ce que ces 7 variables valent en précision pure

Rejoue les mêmes folds, sans entraînement, et compare les log-loss sur les mêmes
matchs. Retirer les 7 variables coûte +0,00304 de log-loss (z +5,04, 14 866
matchs) : 0,66699 → 0,67003, quand la clôture est à 0,66553. Les deux
probabilités restent corrélées à 0,895.

Deux conséquences. 1) Une perte de précision de 0,3 % suffit à effacer un signal
à 9 σ : la CLV de 7.8 ne venait pas de la qualité générale du modèle. 2) Prises
ensemble, les familles gardien et alignement sont nettement résolues (z +5,0),
alors que la section 4.1 les donne séparément sous deux erreurs-types (z 1,3 et
1,7).

## m4_desaccord_roi.py — les désaccords de 5 à 10 points sont-ils rentables ?

La section 7.3 montrait un côté préféré qui gagne 56,7 % quand la clôture dit
52,7 %, et la section 7.4 un rendement nul. Les deux se réconcilient en séparant
ce qui sélectionne et le prix auquel on mise. Chaîne servie, mise à plat, cotes
décimales réelles.

| Bande de désaccord | Clôture → mise à la clôture | Ouverture → mise à l'ouverture |
| --- | --- | --- |
| 0-2 points | −3,0 % (4 706) | −0,4 % (2 877) |
| 2-5 points | −0,8 % (5 056) | +0,4 % (3 218) |
| 5-10 points | +4,2 % (2 651 ; z +2,3) | +6,2 % (2 169 ; z +2,9) |
| plus de 10 points | +25,6 % (198 ; z +3,6) | +36,9 % (330 ; z +4,6) |

Sélectionner sur le désaccord avec la clôture n'est pas exécutable (il faut
connaître la clôture). Un seuil d'edge, comme en 7.4, mélange les bandes hautes
avec celles où le modèle n'a aucun avantage : c'est ce qui noyait le gain.

Les chiffres de la section 7.4 (−1,5 % à +0,03 %, 6 713 à 482 paris) sont
antérieurs à l'import des cotes DraftKings et ne portaient pas sur la chaîne
servie. La mesure du jour donne, sur l'ouverture SBRO, +0,1 % au seuil de 1 % à
+6,4 % au seuil de 5 %.

## m5_bandes_matin.py — ce gain survit-il sans l'alignement ?

Mêmes bandes, modèle brut des deux côtés, prix d'ouverture. Les colonnes
DraftKings sont vides : les colonnes `*_open` du jeu de données ne sont remplies
que pour SBRO (les ouvertures API vivent dans la série horodatée, que `run_clv`
lit à part) — ce script ne mesure donc que SBRO.

| Bande | complet | matin | complet, prix suspects écartés | matin, idem |
| --- | --- | --- | --- | --- |
| 0-2 points | −6,6 % | −4,2 % | −6,6 % | −4,3 % |
| 2-5 points | −1,7 % | −3,2 % | −1,7 % | −3,3 % |
| 5-10 points | +2,4 % | −3,5 % | +2,4 % | −3,5 % |
| plus de 10 points | +25,3 % | +20,6 % | +16,1 % | +9,6 % (z +1,4) |

Prix suspect = |ouverture − clôture| supérieur à 15 points. Lecture : sous
10 points de désaccord, le modèle brut ne gagne rien sans l'alignement. Au-delà,
le gain tient à la fois à l'information tardive et à quelques prix douteux.

Descriptif : aucune règle de mise n'a été figée avant ces mesures.

## m6_echantillons.py — un seul jeu d'échantillons pour la section 7

La section 7 donnait la taille du test comme 4 305, 4 197, 4 331, 4 320, 4 304 ou
4 201 matchs selon le tableau. Deux causes, qu'il fallait séparer : deux
évaluations différentes, jamais nommées, et des générations mélangées (un tableau
d'avant le réentraînement du 1er novembre, une coupure de date ad hoc dans
`test_paires_71.py`, des sous-ensembles variables).

**Échantillon 1 — tranche de test** (20 % finaux par date, modèles servis
appliqués tels quels ; 4 331 matchs, 12 mars 2023 → 17 octobre 2026, 4 018 cotés,
tous DraftKings) :

| Modèle | Log-loss | Brier | Bons choix | Apparié contre le score |
| --- | --- | --- | --- | --- |
| Probabilité constante | 0,68966 | 0,2483 | 54,2 % | −0,0273 (z −8,98 ; saison −3,12) |
| Toujours le domicile | — | — | 54,2 % | — |
| ELO seul | 0,67031 | 0,2390 | 57,6 % | −0,0079 (z −4,61 ; saison −1,64) |
| Classifieur (cotes masquées) | 0,66557 | 0,2367 | 59,1 % | −0,0032 (z −1,67 ; saison −1,16) |
| Modèle de score (brut) | 0,66236 | 0,2352 | 59,3 % | — |

Sur les 4 018 matchs cotés : marché 0,66492, modèle 0,66483 (z −0,06), ELO
0,67399 (z +4,61).

**Échantillon 2 — walk-forward coté** (8 886 matchs, 2018-19 → 2026-27 début ;
couche de correction et poids du mélange ajustés sur les seules saisons passées) :

| Modèle | Log-loss | Brier | Bons choix | Écart au marché (z) |
| --- | --- | --- | --- | --- |
| Modèle brut | 0,66542 | 0,2365 | 59,4 % | +0,00193 (+1,84) |
| Chaîne servie | 0,66286 | 0,2354 | 59,5 % | −0,00063 (−0,72) |
| Marché (clôture dévigée) | 0,66349 | 0,2356 | 58,8 % | — |
| Mélange servi ⊕ marché | 0,66258 | 0,2352 | 59,9 % | −0,00091 (−1,54) |

Par source : SBRO 4 868 matchs (servi 0,66083 contre 0,66231, z −1,26) ;
DraftKings 4 016 matchs (servi 0,66528 contre 0,66491, z +0,28).

Deux corrections au passage. La ligne « Modèle de score (servi) » de 7.1 ne
mesurait pas la chaîne servie mais le modèle **brut** : `backtest._p_score`
n'applique pas la couche de correction. Et la chaîne servie ne peut pas être
mesurée honnêtement sur la tranche de test, parce que la couche servie a été
ajustée sur les prédictions hors échantillon de toutes les saisons, celles du
test comprises — elle se juge en walk-forward.

## m7_totaux.py — les totaux contre le marché

Le modèle prédit des buts et la section 7 ne comparait jamais les totaux au
marché. Attente : le moneyline sort d'un écart entre deux λ, le total de leur
somme, que l'objectif de Poisson optimise directement — ce devait être le point
fort. C'est l'inverse.

Log-loss plus/moins, à la ligne du marché, 9 072 lignes SBRO (2014-15 →
2022-23), 750 poussées écartées : **modèle 0,70167 contre 0,69085 pour la
clôture**, soit +0,01083 (z +6,35 par match, +4,60 par saison, 1 saison gagnée
sur 9). Dix-sept fois l'écart du moneyline, et dans l'autre sens.

Le niveau n'est pas en cause (total prédit 6,006 contre 5,971 observé ;
P(plus de 5,5) 52,0 % contre 52,3 %). C'est la variation entre matchs :

| Classe de P(plus) | Matchs | Prédit | Observé | Écart |
| --- | --- | --- | --- | --- |
| 30-40 % | 1 804 | 37,3 % | 48,9 % | +11,6 pts |
| 40-50 % | 5 631 | 44,8 % | 49,4 % | +4,6 pts |
| 50-60 % | 1 516 | 53,1 % | 54,4 % | +1,3 pt |
| 60-70 % | 85 | 62,9 % | 54,1 % | −8,8 pts |

ECE 5,5 points contre 2,1 sur le moneyline. Le marché reste entre 48 % et 50 %
dans toutes les bandes de désaccord, et l'observé lui donne raison : les écarts
du modèle autour de sa ligne sont surtout du bruit. Miser à la clôture perd dans
les quatre bandes (−5,4 % à −1,8 %), et au-delà de 10 points de désaccord le côté
préféré est le « moins » dans 96 % des cas : le modèle tasse la variation entre
affiches.

**Le point de méthode.** Sur ces mêmes totaux, la CLV nette du placebo vaut
+0,26 point (8 127 paris, z +6,7) et la moitié survit sans l'alignement
(+0,13 point, z +3,5). La ligne bouge donc vers le côté choisi par le modèle,
vers une probabilité qui reste meilleure que la sienne. Une CLV positive ne
valide pas un marché : le critère complet est CLV nette du placebo ET log-loss au
moins à égalité avec la clôture.

Limite : les totaux ne sont cotés que par SBRO, qui s'arrête en novembre 2022.
Rien n'est mesuré sur les lignes récentes.

## Reprendre les calculs

`out/` garde les folds (`fold_*.pkl`), les probabilités (`pml_*.npz`) et les
prédictions hors échantillon (`oos_*.npz`) : les rejouer ne demande aucun
entraînement. Les supprimer force le réentraînement.

```
python explore_marche/m1_melange.py                 # à relancer jusqu'au rapport
python explore_marche/m2_clv_matin.py fit           # à relancer jusqu'à « COMPLET »
python explore_marche/m2_clv_matin.py clv complet
python explore_marche/m2_clv_matin.py clv matin
python explore_marche/m2_clv_matin.py compare
python explore_marche/m3_precision.py pml complet
python explore_marche/m3_precision.py pml matin
python explore_marche/m3_precision.py compare
python explore_marche/m4_desaccord_roi.py
python explore_marche/m5_bandes_matin.py
python explore_marche/m6_echantillons.py
python explore_marche/m7_totaux.py pov
python explore_marche/m7_totaux.py compare
```

Rapports : `ml/models/melange_marche_report.json`, `clv_matin_report.json`,
`clv_matin_precision.json`, `desaccord_roi_report.json`,
`bandes_matin_report.json`, `echantillons_report.json`, `totaux_report.json`, et les
rapports CLV complets dans `out/`.
