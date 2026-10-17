# explore_correction — améliorer la couche de correction du moneyline (2026-10-17)

Document de référence : `ml/EXPLICATION_ML.md` §4.3.

## Reproduire

    cd ml/python
    python explore_correction/build_oos.py     # λ et victoire hors échantillon, 2012 → 2026 (~2 min)
    python explore_correction/s0_check.py      # contrôle : reproduit correction_report.json (v1, 7 variables)
    python explore_correction/s1_nested.py     # piste 1 — sélection imbriquée
    python explore_correction/s2_tail.py       # piste 2 — queue des gros favoris
    python explore_correction/s3_variants.py   # pistes 3-6 — élagage, B, fatigue, période, dérive
    python explore_correction/s4_engine.py     # piste 7 — couche ajustée sur le moteur de match

`lab.py` : banc commun (variables candidates, walk-forward strict, comparaisons appariées,
calibration). Protocole identique à `backtest_walkforward.py --correction` : pour chaque
saison S ≥ 2015, couche ajustée sur les saisons < S (au moins 3), appliquée à S. Le contrôle
`s0_check.py` retrouve le rapport d'origine (C : −0,00219, z −3,20 contre −0,00215, z −3,18).
Chaque script porte en en-tête sa règle de décision, fixée avant le run. Rapports dans `out/`.

## Résultats

Δ = log-loss moneyline (négatif = mieux), apparié par match, 11 saisons 2015-2025.

| Piste | Variante | Δ | z | Saisons | Verdict |
|---|---|---|---|---|---|
| 1. Sélection imbriquée | N (choix des variables sur < S seulement) vs brut | −0,00171 | −2,60 | 10/11 | **gain confirmé**, optimisme de la sélection ≈ 0,0005 |
| 2. Queue | + logit·\|logit\|, logit³, pentes de queue | +0,0002 à +0,0016 vs C | jusqu'à +2,2 | ≤ 6/11 | rejeté : C corrige déjà la queue |
| 3. Élagage | C5 = C − `xg_matchup_diff` − `ev_xgf_pct_l_diff` vs C | −0,00035 | −2,15 | 8/11 | **adopté** |
| 3. B vs C | sans `elo_diff` vs C | +0,00039 | +1,25 | 3/11 | rejeté |
| 4. Fatigue | voyage, 3 en 4 soirs, repos, dos-à-dos × relève | −0,00003 à +0,00011 | \|z\| < 2,5 | — | rejeté |
| 5. Période | ELO et xG × début de saison | +0,00013 | +0,93 | 3/11 | rejeté |
| 6. Dérive | demi-vie 3 / 5 saisons, fenêtre 6 saisons | +0,00003 à +0,00026 | < +1,7 | — | rejeté |
| 7. Moteur | couche ajustée sur la victoire du moteur vs Poisson × τ | +0,00005 | +1,30 | 3/11 | rejeté : on garde `_p_home_layer_input` |

**Servi depuis le 2026-10-17** : couche à 5 variables (`CORRECTION_FEATURES` dans
`backtest_walkforward.py`), réécrite par `backtest_walkforward.py --correction --write-layer` :
−0,00256 contre le brut (z −3,85, 12 saisons sur 12 avec 2026-27), −0,0008 contre la cote de
clôture (z −1,0). L'ancienne couche : `models/correction_layer_v1_7var.json` (retour arrière =
la recopier sur `correction_layer.json`).

Points notables :
- **Queue** : sur les 692 matchs où le marché donne ≥ 70 % au favori, il gagne 74,1 % ; le modèle
  brut dit 69,2 %, le marché 73,4 %, la couche 73,9 %. L'écart de queue diagnostiqué par
  `--market-gap` venait du modèle brut ; ELO et xG dans la couche le corrigent déjà.
- **Instabilité** : `xg_matchup_diff` passe de −0,11 (fold 2015) à +0,01 / −0,02 ;
  `ev_xgf_pct_l_diff` change de signe (−0,07 → +0,07). Les 5 restantes sont stables.
- **Dos-à-dos** : l'effet au-delà du modèle est négatif dans 11 saisons sur 14, sans dérive
  nette — d'où l'échec de la pondération des saisons récentes.
