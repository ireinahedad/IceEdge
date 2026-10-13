"""
measure_ref_props.py
====================
P5 (STATUS.md §3.5 P), 2026-10-12 — l'effet ARBITRE améliore-t-il les props
« minutes de pénalité » (pim) et « points en avantage numérique » (ppPoints)
du modèle joueur ?

Constat de départ (`measure_lines_refs.py`) : l'effet d'un arbitre sur le nombre
de pénalités (corr. saisons paires/impaires 0.82) et sur le temps en AN (0.81)
est réel et stable, mais nul sur les buts totaux.

Variables arbitre, PRÉ-MATCH et sans fuite (les arbitres sont publiés le jour
du match) :
  ref_pen = Σ (2 arbitres) de l'écart moyen des pénalités de leurs matchs
            PRÉCÉDENTS à la moyenne glissante de la ligue (1 000 matchs
            précédents), rétréci : Σ écarts / (n + 40) ;
  ref_pp  = idem pour les minutes à 5 c. 4 (les deux équipes).

Protocole = celui du face-à-face (`train_player.py`, `player_vs_report.json`) :
mêmes données, mêmes features que le modèle SERVI pour la stat (pim : base +
face-à-face ; ppPoints : base), mêmes hyperparamètres, entraînement ≤ 2021-22,
arrêt précoce et k sur 2022-23, test 2023-24 → 2025-26.
Règle fixée AVANT le run : garder si Δ log-vraisemblance > 0 en validation ET
en test, avec z ≥ 2 en test.

Hors production : n'écrit aucun modèle, seulement ../models/ref_props_report.json.

Usage : cd ml/python && python measure_ref_props.py      (~15-30 min, comme train_player)
"""
from __future__ import annotations

import json
import os
import time

import numpy as np
import pandas as pd
import xgboost as xgb

import train_player as TP

REF_FEATS = ["ref_pen", "ref_pp"]
REF_SHRINK = 40
LEAGUE_WINDOW = 1000
TARGET_STATS = ["pim", "ppPoints"]
REPORT = os.path.join(TP.MODELS_DIR, "ref_props_report.json")


def ref_features() -> pd.DataFrame:
    """game_id → ref_pen, ref_pp (pré-match, matchs PRÉCÉDENTS des arbitres)."""
    off = pd.read_csv(os.path.join(TP.DATA_DIR, "officials.csv"))
    t = pd.read_csv(os.path.join(TP.DATA_DIR, "mp_team_games.csv"),
                    usecols=["gameId", "situation", "iceTime", "penaltiesFor"])
    pen = t[t.situation == "all"].groupby("gameId")["penaltiesFor"].sum().rename("pen")
    pp = (t[t.situation == "5on4"].groupby("gameId")["iceTime"].sum() / 60).rename("pp")
    g = off.merge(pen, left_on="game_id", right_index=True) \
           .merge(pp, left_on="game_id", right_index=True)
    g = g[(g.ref1.fillna("") != "") & (g.ref2.fillna("") != "")]
    g = g.sort_values(["date", "game_id"]).reset_index(drop=True)
    out = g[["game_id"]].copy()
    for col, name in (("pen", "ref_pen"), ("pp", "ref_pp")):
        base = g[col].shift(1).rolling(LEAGUE_WINDOW, min_periods=200).mean()
        g["dev"] = g[col] - base
        long = pd.concat([g[["game_id", "date", "ref1", "dev"]].rename(columns={"ref1": "ref"}),
                          g[["game_id", "date", "ref2", "dev"]].rename(columns={"ref2": "ref"})])
        long = long.sort_values(["ref", "date", "game_id"])
        grp = long.groupby("ref")["dev"]
        # Matchs PRÉCÉDENTS seulement : cumul décalé d'un match par arbitre.
        long["cum"] = grp.transform(lambda s: s.fillna(0).cumsum().shift(1).fillna(0))
        long["n"] = grp.transform(lambda s: s.notna().astype(int).cumsum().shift(1).fillna(0))
        long["eff"] = long["cum"] / (long["n"] + REF_SHRINK)
        out[name] = out["game_id"].map(long.groupby("game_id")["eff"].sum())
    return out


def main():
    t0 = time.time()
    rf = ref_features()
    print(f"🦓 variables arbitre : {len(rf)} matchs ({time.time() - t0:.0f}s)", flush=True)

    print("⛸️  lecture des patineurs MoneyPuck …", flush=True)
    pg = TP.per_game(TP.load_skaters(os.path.join(TP.DATA_DIR, "raw")))
    pre = TP.rolling_features(pg, shift=1)
    df = pd.concat([pg, pre, TP.vs_features(pg, pre, shift=1)], axis=1)
    games = pd.read_csv(os.path.join(TP.DATA_DIR, "nhl_games_v4.csv"), low_memory=False)
    df = TP.game_context(df, games)
    df = df.merge(rf, left_on="gameId", right_on="game_id", how="left", suffixes=("", "_ref"))
    df = df[df.season >= 2010]
    tr, va, te = df[df.season <= 2021], df[df.season == 2022], df[df.season >= 2023]
    cov = {k: round(float(x[REF_FEATS[0]].notna().mean()), 3) for k, x in (("train", tr), ("val", va), ("test", te))}
    print(f"   {len(tr)} / {len(va)} / {len(te)} lignes ; couverture arbitre {cov}", flush=True)

    # Contrôle au niveau du match : la variable pré-match annonce-t-elle les pénalités du soir ?
    gl = df[df.season >= 2023].drop_duplicates("gameId")
    tm = pd.read_csv(os.path.join(TP.DATA_DIR, "mp_team_games.csv"), usecols=["gameId", "situation", "penaltiesFor"])
    gp = tm[tm.situation == "all"].groupby("gameId")["penaltiesFor"].sum()
    gl = gl.assign(pen=gl.gameId.map(gp)).dropna(subset=["pen", "ref_pen"])
    game_check = {"n_matchs_test": int(len(gl)),
                  "corr_ref_pen_vs_penalites_du_match": round(float(np.corrcoef(gl.ref_pen, gl.pen)[0, 1]), 3),
                  "penalites_quintile_haut": round(float(gl.pen[gl.ref_pen >= gl.ref_pen.quantile(.8)].mean()), 3),
                  "penalites_quintile_bas": round(float(gl.pen[gl.ref_pen <= gl.ref_pen.quantile(.2)].mean()), 3)}
    print("   contrôle match :", game_check, flush=True)

    served = json.load(open(os.path.join(TP.MODELS_DIR, "player_report.json")))["stats"]
    params = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50,
                  subsample=0.8, colsample_bytree=0.8, eval_metric="poisson-nloglik",
                  max_delta_step=0.7, nthread=os.cpu_count() or 2, seed=7)

    def fit(feats, y):
        p = dict(params)
        mono = {f: 1 for f in feats if f.startswith("vs_lift_")}
        if mono:
            p["monotone_constraints"] = mono
        dtr = xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats)
        dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
        bst = xgb.train(p, dtr, 2000, evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        it = (0, bst.best_iteration + 1)
        mva = bst.predict(dva, iteration_range=it)
        k = TP.fit_k(va[y].values, mva)
        mte = bst.predict(xgb.DMatrix(te[feats], feature_names=feats), iteration_range=it)
        return k, mva, mte, it[1]

    report = {"protocole": "train ≤ 2021-22, val 2022-23, test 2023-26 ; features du modèle servi (+ REF_FEATS)",
              "regle": "garder si Δ log-vraisemblance > 0 en validation ET en test, z ≥ 2 en test",
              "ref_feats": REF_FEATS, "shrink": REF_SHRINK, "couverture": cov, "controle_match": game_check,
              "stats": {}}
    yrs = te.season.values
    for s in TARGET_STATS:
        y = f"y_{s}"
        base_feats = served[s]["features"]
        k0, mva0, mte0, r0 = fit(base_feats, y)
        k1, mva1, mte1, r1 = fit(base_feats + REF_FEATS, y)
        yv, yt = va[y].values, te[y].values
        d_va = TP.nb_ll(yv, mva1, k1) - TP.nb_ll(yv, mva0, k0)
        d_te = TP.nb_ll(yt, mte1, k1) - TP.nb_ll(yt, mte0, k0)
        z = float(d_te.mean() / (d_te.std(ddof=1) / np.sqrt(len(d_te))))
        keep = bool(d_va.mean() > 0 and d_te.mean() > 0 and z >= 2)
        rp = te["ref_pen"].values
        hi, lo = rp >= np.nanquantile(rp, .8), rp <= np.nanquantile(rp, .2)
        report["stats"][s] = {
            "keep": keep, "z_test": round(z, 2),
            "dll_val": round(float(d_va.mean()), 6), "dll_test": round(float(d_te.mean()), 6),
            "dll_test_by_season": {int(ss): round(float(d_te[yrs == ss].mean()), 6) for ss in np.unique(yrs)},
            "loglik_servi": round(float(TP.nb_ll(yt, mte0, k0).mean()), 5),
            "loglik_avec_arbitre": round(float(TP.nb_ll(yt, mte1, k1).mean()), 5),
            "obs_sur_servi_quintile_arbitre_haut": round(float(yt[hi].sum() / mte0[hi].sum()), 4),
            "obs_sur_servi_quintile_arbitre_bas": round(float(yt[lo].sum() / mte0[lo].sum()), 4),
            "pred_ratio_quintile_haut": round(float((mte1[hi] / np.maximum(mte0[hi], 1e-6)).mean()), 4),
            "pred_ratio_quintile_bas": round(float((mte1[lo] / np.maximum(mte0[lo], 1e-6)).mean()), 4),
            "arbres": [r0, r1], "k": [k0, k1],
        }
        print(f"   {s:9s} {report['stats'][s]}  ({time.time() - t0:.0f}s)", flush=True)

    report["generated"] = time.strftime("%Y-%m-%d")
    json.dump(report, open(REPORT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"✅ {os.path.relpath(REPORT)}")


if __name__ == "__main__":
    main()
