# Pistes tirées de la littérature (2026-10-15)

Six pistes issues des références de la section 2 du document technique, soumises
à la règle d'adoption du projet (log-loss z ≤ −2, apparié par match, et gain sur
≥ 70 % des saisons). **Aucune n'est adoptée** ; rien n'est servi par ces scripts.

| Script | Mesure |
|---|---|
| `prep_variants.py` | Colonnes de variantes : xG MoneyPuck « flurry » et « flurry + score + domicile », ELO avec terme d'autocorrélation (FiveThirtyEight). Contrôle d'abord que la recomputation reproduit `nhl_games_v4.csv`. |
| `run_variants.py` | Walk-forward 2012-2026 du modèle de score pour chaque variante (protocole de `--score-v2`, mêmes hyperparamètres par fold). Prédictions dans `out/preds/`. |
| `analyze.py` | Verdicts : moneyline, puck line, déviance, puis chaîne servie (couche C walk-forward). |
| `devig_calib.py` | Dévigage proportionnel / Shin / puissance sur la clôture ; calibration bêta et isotonique de la chaîne servie. |
| `decorrelation.py` | Couche C réajustée avec une pénalité de proximité au prix d'ouverture (Hubáček et al., 2019) ; CLV et ROI à edge ≥ 2 %. |

Ordre : `prep_variants` → `run_variants` → `analyze`, `devig_calib`, `decorrelation`
(tous depuis `ml/python`). Résultats consolidés : `ml/models/pistes_references_report.json`.
