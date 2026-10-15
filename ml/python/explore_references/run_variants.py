"""Walk-forward des variantes du modèle de score, protocole de run_score_v2.

Pour chaque saison S (>= 2012, au moins 800 matchs antérieurs) et chaque
variante : modèle de score entraîné sur les saisons < S (mêmes
hyperparamètres par fold que la référence, lus dans le cache), τ et
prolongation ajustés sur le passé, puis pertes par match sur S.

Les prédictions sont sauvegardées par (variante, saison) pour reprise et pour
les mesures suivantes (couche de correction, dévigage, calibration).
À lancer depuis ml/python : python explore_references/<script>.py.
"""
import os
import pickle
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, os.getcwd())
import backtest_walkforward as W  # noqa: E402
import train_score as TS  # noqa: E402

VAR_DIR = "explore_references/out/variants"
PRED_DIR = "explore_references/out/preds"
os.makedirs(PRED_DIR, exist_ok=True)
VARIANTS = sys.argv[1].split(",") if len(sys.argv) > 1 else ["ref", "xg_flurry", "xg_fsv", "elo_ac"]
SEARCH_TRIALS = 8

base_df = pd.read_csv(W.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
base_df["season"] = base_df["date"].map(W.season_of)


def variant_df(name: str) -> pd.DataFrame:
    if name == "ref":
        return base_df
    rep = pd.read_parquet(f"{VAR_DIR}/{name}.parquet").drop_duplicates("game_id", keep="last")
    d = base_df.copy()
    m = d[["game_id"]].merge(rep, on="game_id", how="left")
    for c in rep.columns:
        if c != "game_id":
            d[c] = m[c].values
    return d


need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
seasons = [s for s in sorted(base_df["season"].unique())
           if s >= 2012 and (base_df["season"] < s).sum() >= 800
           and base_df.loc[base_df["season"] == s, "home_reg_score"].notna().sum() >= 50]
print("saisons :", seasons, flush=True)
atk, dfn = list(TS.ATK_COLS), list(TS.DEF_COLS)
base = W.base_score_params(SEARCH_TRIALS)

for name in VARIANTS:
    df = variant_df(name)
    for s in seasons:
        path = f"{PRED_DIR}/{name}_{s}.pkl"
        if os.path.exists(path):
            continue
        t0 = time.time()
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        cut_p = int(len(prior) * 0.85)
        params = W.search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                      TS.stacked_features(atk, dfn), base, SEARCH_TRIALS,
                                      seed=42, season=s, use_cache=True, atk=atk, dfn=dfn)
        r = W._eval_v2(prior, cur, atk, dfn, params, use_gamma=False)
        keep = ["game_id", "date", "home_win", "home_score", "away_score",
                "home_reg_score", "away_reg_score", "source",
                "market_home_p_close", "market_home_p_open",
                "home_ml_close", "away_ml_close", "home_ml_open", "away_ml_open"]
        out = {"season": s, "pl": r["pl"], "ml": r["ml"], "dev": r["dev"],
               "p_ml": np.asarray(r["p_ml"], float),
               "X": W._correction_X(cur, W.CORRECTION_FEATURES),
               "meta": cur[[c for c in keep if c in cur.columns]].copy()}
        with open(path, "wb") as fh:
            pickle.dump(out, fh)
        print(f"{name:>10} {s}  n={len(cur):>5}  ml={r['ml'].mean():.5f}  "
              f"pl={r['pl'].mean():.5f}  dev={r['dev'].mean():.5f}  ({time.time() - t0:.0f}s)",
              flush=True)
print("FINI", flush=True)
