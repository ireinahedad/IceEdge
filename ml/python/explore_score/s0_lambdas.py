"""Reproduit les λ du modèle servi : test (hors échantillon) + OOF train + val."""
import json, sys
from pathlib import Path as _P
import os as _os
HERE = _P(__file__).resolve().parent
ML = HERE.parents[1]
DATA, MODELS, OUT = ML / "data", ML / "models", HERE / "out"
OUT.mkdir(exist_ok=True)
_os.chdir(OUT)          # toutes les sorties intermédiaires vont dans explore_score/out/
sys.path.insert(0, str(HERE.parent))
import numpy as np, pandas as pd, xgboost as xgb
import train_score as T
df = pd.read_csv(str(DATA) + "/nhl_games_v4.csv", low_memory=False)
df = df.dropna(subset=["home_reg_score","away_reg_score","went_to_ot","total_goals","home_win","date"]).reset_index(drop=True)
tr, va, te = T.split(df)
rep = json.load(open(str(MODELS) + "/score_report.json"))
feats = rep["features"]
m = xgb.Booster(); m.load_model(str(MODELS) + "/score_model.json")
params = {"objective":"count:poisson","eval_metric":"poisson-nloglik","seed":42, **rep["params"]}
out = []
for name, d in (("train", tr), ("val", va), ("test", te)):
    s = T.stack(d)
    lh, la = T.lambdas_for(m, feats, s, len(d))
    x = d[["game_id","season","date","home_team","away_team","home_reg_score","away_reg_score","home_score","away_score","went_to_ot","home_win"] + ([T.MARKET_COL] if T.MARKET_COL in d else [])].copy()
    x["lam_h"], x["lam_a"], x["split"] = lh, la, name
    if name == "train":
        oh, oa = T.oof_lambdas(d, feats, params, rep["best_iteration"] + 1)
        x["lam_h"], x["lam_a"] = oh, oa   # OOF, comme pour τ
    out.append(x)
X = pd.concat(out, ignore_index=True)
X.to_csv(str(OUT / "lambdas.csv"), index=False)
print(X.groupby("split")[["lam_h","lam_a","home_reg_score","away_reg_score"]].mean())
print(len(X), X.groupby("split").size())
