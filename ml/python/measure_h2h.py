"""
measure_h2h.py
==============
Les FACE-À-FACE apportent-ils quelque chose au modèle de score ?
(`LIVE_PREDICTIONS_PLAN.md`, étape 8 — mesure AVANT tout branchement.)

Variables, calculées comme `fetchHeadToHead` côté Node : les 10 derniers
matchs entre les deux équipes sur la saison en cours et la précédente, score
final, uniquement des matchs ANTÉRIEURS à la date du match (aucune fuite) :

    h2h_n       nombre de rencontres dans la fenêtre
    h2h_gf_pg   buts de l'attaquant par rencontre (NaN si aucune)
    h2h_ga_pg   buts encaissés par l'attaquant par rencontre
    h2h_win     part des rencontres gagnées par l'attaquant

Protocole : walk-forward saison par saison, comme `backtest_walkforward.py`.
Pour chaque saison S, deux modèles de score entraînés sur les saisons < S avec
les MÊMES hyperparamètres (ceux du fold de référence, `search_params_fold`) et
la même procédure — l'un avec les features de production, l'autre avec en plus
les quatre colonnes h2h. Notés sur la saison S : déviance de Poisson des buts
réglementaires, log-loss du moneyline et du total > 5.5 (via
`ScoreDistribution`, τ et P(dom en OT) du fold). Écarts appariés par match.

Règle (posée avant de lire le résultat) : les face-à-face ne sont gardés que si
la log-loss moneyline ET la déviance s'améliorent en moyenne, sur au moins
70 % des saisons. Sinon, rien n'est branché.

Rapport : ml/models/live/h2h_report.json

Usage :
    cd ml/python
    python measure_h2h.py                  # saisons 2015-16 → 2025-26
    python measure_h2h.py --min-season 2018
"""

import argparse
import json
import os
from collections import defaultdict, deque

import numpy as np
import pandas as pd
import xgboost as xgb

import train_score as TS
from backtest_walkforward import DATA, base_score_params, search_params_fold, season_of
from score_model import ScoreDistribution, fit_margin_correction

REPORT = "../models/live/h2h_report.json"
H2H_COLS = ["h2h_n", "h2h_gf_pg", "h2h_ga_pg", "h2h_win"]
WINDOW = 10


def add_h2h(df: pd.DataFrame) -> pd.DataFrame:
    """Colonnes h2h vues du domicile (`home_h2h_*`) et du visiteur (`away_h2h_*`)."""
    df = df.sort_values(["date", "game_id"]).reset_index(drop=True)
    hist: dict[tuple, deque] = defaultdict(lambda: deque(maxlen=64))
    out = {f"{side}_{c}": np.full(len(df), np.nan) for side in ("home", "away") for c in H2H_COLS}
    i = 0
    dates = df["date"].values
    while i < len(df):
        # Tous les matchs d'une même date voient le même passé (aucun ne voit l'autre).
        j = i
        while j < len(df) and dates[j] == dates[i]:
            j += 1
        for k in range(i, j):
            r = df.iloc[k]
            s = int(r["season"])
            pair = tuple(sorted((r["home_team"], r["away_team"])))
            past = [g for g in hist[pair] if g["season"] in (s, s - 1)][-WINDOW:]
            for side, team in (("home", r["home_team"]), ("away", r["away_team"])):
                n = len(past)
                out[f"{side}_h2h_n"][k] = n
                if n:
                    gf = np.mean([g["goals"][team] for g in past])
                    ga = np.mean([g["goals"][g["opp"][team]] for g in past])
                    out[f"{side}_h2h_gf_pg"][k] = gf
                    out[f"{side}_h2h_ga_pg"][k] = ga
                    out[f"{side}_h2h_win"][k] = np.mean([g["winner"] == team for g in past])
        for k in range(i, j):
            r = df.iloc[k]
            if pd.isna(r["home_score"]):
                continue
            h, a = r["home_team"], r["away_team"]
            pair = tuple(sorted((h, a)))
            hist[pair].append({"season": int(r["season"]),
                               "goals": {h: r["home_score"], a: r["away_score"]},
                               "opp": {h: a, a: h},
                               "winner": h if r["home_score"] > r["away_score"] else a})
        i = j
    for c, v in out.items():
        df[c] = v
    return df


def stack_h2h(df: pd.DataFrame) -> pd.DataFrame:
    s = TS.stack(df)
    rows, sides = s["_row"].values, s["_side"].values
    for c in H2H_COLS:
        s[c] = np.where(sides == "home", df[f"home_{c}"].values[rows], df[f"away_{c}"].values[rows])
    return s


def fit_predict(train_df, test_df, feats, params):
    cut = int(len(train_df) * 0.85)
    tr, cal = train_df.iloc[:cut].reset_index(drop=True), train_df.iloc[cut:].reset_index(drop=True)
    s_tr, s_cal = stack_h2h(tr), stack_h2h(cal)
    m = xgb.train(params, TS.dm(s_tr, feats), num_boost_round=700,
                  evals=[(TS.dm(s_cal, feats), "cal")], early_stopping_rounds=40, verbose_eval=False)
    s_full = stack_h2h(train_df)
    lh, la = TS.lambdas_for(m, feats, s_full, len(train_df))
    tau = fit_margin_correction((train_df["home_reg_score"] - train_df["away_reg_score"]).values,
                                TS.expected_margin_pmf(lh, la))
    ot = train_df[train_df["went_to_ot"] == 1]
    p_ot = float((ot["home_score"] > ot["away_score"]).mean()) if len(ot) else 0.5
    lh, la = TS.lambdas_for(m, feats, stack_h2h(test_df), len(test_df))
    return lh, la, tau, p_ot


def scores(test_df, lh, la, tau, p_ot):
    yh, ya = test_df["home_reg_score"].values, test_df["away_reg_score"].values

    def dev(y, mu):
        mu = np.clip(mu, 1e-6, None)
        return 2 * (np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0) - (y - mu))
    out = {"deviance": (dev(yh, lh) + dev(ya, la)) / 2, "ll_ml": [], "ll_o55": []}
    for j in range(len(test_df)):
        d = ScoreDistribution(float(lh[j]), float(la[j]), p_ot, tau)
        p = np.clip(d.p_home_win(), 1e-4, 1 - 1e-4)
        won = test_df["home_score"].values[j] > test_df["away_score"].values[j]
        out["ll_ml"].append(-np.log(p if won else 1 - p))
        po = np.clip(d.p_over(5.5), 1e-4, 1 - 1e-4)
        over = test_df["home_score"].values[j] + test_df["away_score"].values[j] > 5.5
        out["ll_o55"].append(-np.log(po if over else 1 - po))
    return {k: np.asarray(v, dtype=float) for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-season", type=int, default=2015)
    ap.add_argument("--search-trials", type=int, default=8)
    a = ap.parse_args()

    df = pd.read_csv(DATA, low_memory=False)
    df["season"] = df["date"].map(season_of)
    df = add_h2h(df)
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    base_feats = TS.stacked_features()
    feats_h2h = base_feats + H2H_COLS
    params0 = base_score_params(a.search_trials)

    seasons, per = [], {}
    print(f"   {'saison':>8} {'Δ déviance':>12} {'Δ ll ML':>10} {'Δ ll >5.5':>10}   (négatif = h2h meilleur)")
    for s in sorted(df["season"].unique()):
        if s < a.min_season:
            continue
        train_df = df[df["season"] < s].dropna(subset=need).sort_values("date").reset_index(drop=True)
        test_df = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(train_df) < 800 or len(test_df) < 50:
            continue
        cut = int(len(train_df) * 0.85)
        params = search_params_fold(train_df.iloc[:cut].reset_index(drop=True), base_feats, params0,
                                    a.search_trials, seed=42, season=s)
        base = scores(test_df, *fit_predict(train_df, test_df, base_feats, params))
        h2h = scores(test_df, *fit_predict(train_df, test_df, feats_h2h, params))
        row = {}
        for k in base:
            dlt = h2h[k] - base[k]
            row[k] = {"mean": float(dlt.mean()), "se": float(dlt.std(ddof=1) / np.sqrt(len(dlt))),
                      "base": float(base[k].mean()), "h2h": float(h2h[k].mean())}
        per[int(s)] = {"n": len(test_df), **row}
        seasons.append(int(s))
        print(f"   {s}-{str(s + 1)[2:]:>3} {row['deviance']['mean']:+12.5f} "
              f"{row['ll_ml']['mean']:+10.5f} {row['ll_o55']['mean']:+10.5f}")

    share = {k: float(np.mean([per[s][k]["mean"] < 0 for s in seasons])) for k in ("deviance", "ll_ml", "ll_o55")}
    mean = {k: float(np.mean([per[s][k]["mean"] for s in seasons])) for k in ("deviance", "ll_ml", "ll_o55")}
    keep = (mean["ll_ml"] < 0 and mean["deviance"] < 0
            and share["ll_ml"] >= 0.7 and share["deviance"] >= 0.7)
    print(f"\n   moyenne : déviance {mean['deviance']:+.5f}, ll ML {mean['ll_ml']:+.5f}, ll >5.5 {mean['ll_o55']:+.5f}")
    print(f"   saisons améliorées : déviance {share['deviance']:.0%}, ML {share['ll_ml']:.0%}, >5.5 {share['ll_o55']:.0%}")
    print(f"   verdict : {'GARDER les face-à-face' if keep else 'ne rien brancher'}")
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump({"window": WINDOW, "features": H2H_COLS, "seasons": per,
                   "mean_delta": mean, "share_improved": share, "keep": keep,
                   "rule": "garder si Δ ll moneyline < 0 ET Δ déviance < 0 en moyenne, "
                           "sur ≥ 70 % des saisons"}, fh, indent=2, ensure_ascii=False)
    print(f"✅ {os.path.relpath(REPORT)}")


if __name__ == "__main__":
    main()
