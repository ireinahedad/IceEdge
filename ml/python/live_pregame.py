"""
live_pregame.py
===============
Chiffres d'AVANT-MATCH hors échantillon pour chaque match, point de départ des
prédictions en direct (`LIVE_PREDICTIONS_PLAN.md`, étapes 6 et 7).

Ce sont les trois entrées que le chemin ML en direct lit dans le paquet du
modèle (`gameMlBundle.applyLive`) : victoire du domicile (`moneyline`),
P(nul après 60 minutes) (`game_to_ot`) et λ domicile + visiteur. Elles viennent
du modèle de score walk-forward de `backtest_walkforward.py` : pour la saison
S, entraîné sur les saisons < S seulement (mêmes hyperparamètres par fold, même
τ, même P(dom en OT) ajustés sur le train du fold). Aucun match n'est donc
chiffré par un modèle qui l'a vu.

Écart connu avec la production : le partage de la prolongation est la
constante du fold, pas la logistique `p_ot_for` (le rejeu ne note que le
vainqueur à 60 minutes et le total, pas qui gagne la prolongation… sauf le
moneyline, où l'effet est de l'ordre du dixième de point).

Sortie (ignorée par git) : ml/data/live_pregame.csv

Usage :
    cd ml/python
    python live_pregame.py                    # saisons 2012-13 → 2025-26
    python live_pregame.py --min-season 2015
"""

import argparse
import os

import pandas as pd

import train_score as TS
from backtest_walkforward import (DATA, base_score_params, fit_score_fold, season_of)
from score_model import ScoreDistribution

OUT = "../data/live_pregame.csv"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-season", type=int, default=2012)
    ap.add_argument("--search-trials", type=int, default=8)
    a = ap.parse_args()

    df = pd.read_csv(DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(season_of)
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    feats = TS.stacked_features()
    params = base_score_params(a.search_trials)

    rows = []
    for s in sorted(df["season"].unique()):
        if s < a.min_season:
            continue
        train_df = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        test_df = df[df["season"] == s].reset_index(drop=True)
        if len(train_df) < 800 or len(test_df) < 50:
            continue
        main_m, _, tau, p_ot = fit_score_fold(train_df, feats, params, 0,
                                              search_trials=a.search_trials, season=s)
        lam_h, lam_a = TS.lambdas_for(main_m, feats, TS.stack(test_df), len(test_df))
        for j in range(len(test_df)):
            d = ScoreDistribution(float(lam_h[j]), float(lam_a[j]), p_ot, tau)
            rows.append({"game_id": int(test_df.at[j, "game_id"]), "season": int(s),
                         "lam_home": round(float(lam_h[j]), 5),
                         "lam_away": round(float(lam_a[j]), 5),
                         "p_home_win": round(d.p_home_win(), 6),
                         "p_reg_tie": round(d.p_regulation_tie(), 6),
                         "p_ot_home": round(float(p_ot), 6)})
        print(f"  {s}-{str(s + 1)[2:]} : {len(test_df)} matchs (train {len(train_df)})")

    out = pd.DataFrame(rows)
    out.to_csv(OUT, index=False)
    print(f"✅ {len(out)} matchs → {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
