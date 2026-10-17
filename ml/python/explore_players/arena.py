"""
arena.py — le facteur de COMPTAGE de l'aréna (arena_effects.py) comme variable
du modèle joueur, pour les stats comptées à la main.

    python explore_players/arena.py

Pour chaque stat, deux modèles entraînés à l'identique (mêmes paramètres,
même découpage que train_player.py : entraînement ≤ 2021-22, arrêt précoce
2022-23, test 2023-24 → 2025-26) : A = les features actuelles de la stat
(player_report.json), B = A + le facteur d'aréna de cette stat, avec une
contrainte monotone + (une aréna qui compte plus ne peut que faire monter la
prédiction).

    mises en échec → arena_hits    tirs bloqués → arena_blocks    tirs → arena_sog

Règle (posée avant le run, 2026-10-15) : B remplace A si Δ log-vraisemblance
(binomiale négative, k ajusté en validation) > 0 en validation ET en test,
z ≥ 2 en test — celle des face-à-face et des arbitres.
"""
from __future__ import annotations
import json, os, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
import train_player as TP                    # noqa: E402
import referee_effects as RE                 # noqa: E402
import arena_effects as AE                   # noqa: E402

DATA, MODELS = TP.DATA_DIR, TP.MODELS_DIR
OUT = os.path.join(HERE, "out")
TRY = {"hits": "arena_hits", "blocks": "arena_blocks", "shots": "arena_sog"}


def frame() -> pd.DataFrame:
    pg = TP.per_game(TP.load_skaters(os.path.join(DATA, "raw")))
    pre = TP.rolling_features(pg, shift=1)
    df = pd.concat([pg, pre, TP.vs_features(pg, pre, shift=1)], axis=1)
    df = TP.game_context(df, pd.read_csv(os.path.join(DATA, "nhl_games_v4.csv"), low_memory=False))
    rg = RE.load_ref_games(DATA)
    if rg is not None:
        df = df.merge(RE.pregame_features(rg), left_on="gameId", right_on="game_id", how="left",
                      suffixes=("", "_ref"))
    ag = AE.load_games(DATA)
    df = df.merge(AE.pregame_features(ag).rename(columns={"game_id": "gid_arena"}),
                  left_on="gameId", right_on="gid_arena", how="left")
    for c in RE.REF_FEATS + AE.ARENA_FEATS:
        if c not in df:
            df[c] = np.nan
    return df[df.season >= 2010].reset_index(drop=True)


def main():
    t0 = time.time()
    df = frame()
    tr, va, te = df[df.season <= 2021], df[df.season == 2022], df[df.season >= 2023]
    print(f"⛸️  {len(tr)} / {len(va)} / {len(te)} ({time.time()-t0:.0f}s)")
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    base = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50, subsample=0.8,
                colsample_bytree=0.8, eval_metric="poisson-nloglik", max_delta_step=0.7,
                nthread=os.cpu_count() or 2, seed=7)

    def fit(feats, y, mono):
        p = dict(base, monotone_constraints={f: 1 for f in mono if f in feats}) if mono else base
        dtr = xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats)
        dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
        bst = xgb.train(p, dtr, 2000, evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        it = (0, bst.best_iteration + 1)
        mva = bst.predict(dva, iteration_range=it)
        mte = bst.predict(xgb.DMatrix(te[feats], feature_names=feats), iteration_range=it)
        return TP.fit_k(va[y].values, mva), mva, mte, it[1]

    out = {"generated": time.strftime("%Y-%m-%d"), "window": AE.WINDOW, "pseudo": AE.PSEUDO,
           "rule": "B (features + facteur d'aréna) remplace A si Δ log-vraisemblance > 0 en validation ET en test, z ≥ 2 en test",
           "stats": {}}
    yrs = te.season.values
    for s, af in TRY.items():
        y = f"y_{s}"
        feats = rep["stats"][s]["features"]
        mono = [f"vs_lift_{x}" for x in TP.STATS]
        kA, mvA, mtA, rA = fit(feats, y, mono)
        kB, mvB, mtB, rB = fit(feats + [af], y, mono + [af])
        dv = TP.nb_ll(va[y].values, mvB, kB) - TP.nb_ll(va[y].values, mvA, kA)
        dt = TP.nb_ll(te[y].values, mtB, kB) - TP.nb_ll(te[y].values, mtA, kA)
        z = float(dt.mean() / (dt.std(ddof=1) / np.sqrt(len(dt))))
        zv = float(dv.mean() / (dv.std(ddof=1) / np.sqrt(len(dv))))
        r = {"feature": af, "k_A": kA, "k_B": kB, "rounds_A": rA, "rounds_B": rB,
             "loglik_A_test": round(float(TP.nb_ll(te[y].values, mtA, kA).mean()), 6),
             "loglik_B_test": round(float(TP.nb_ll(te[y].values, mtB, kB).mean()), 6),
             "dll_val": round(float(dv.mean()), 6), "z_val": round(zv, 2),
             "dll_test": round(float(dt.mean()), 6), "z_test": round(z, 2),
             "dll_test_by_season": {int(ss): round(float(dt[yrs == ss].mean()), 6) for ss in np.unique(yrs)}}
        # Effet concret : rapport des prédictions B / A dans les arénas les plus « généreuses ».
        hi = (te[af] >= 1.15).values
        lo = (te[af] <= 0.85).values
        r["ratio_B_over_A_when_arena_ge_1.15"] = round(float(mtB[hi].mean() / mtA[hi].mean()), 4) if hi.any() else None
        r["ratio_B_over_A_when_arena_le_0.85"] = round(float(mtB[lo].mean() / mtA[lo].mean()), 4) if lo.any() else None
        r["obs_over_A_when_arena_ge_1.15"] = round(float(te[y].values[hi].sum() / mtA[hi].sum()), 4) if hi.any() else None
        r["obs_over_A_when_arena_le_0.85"] = round(float(te[y].values[lo].sum() / mtA[lo].sum()), 4) if lo.any() else None
        r["adopt"] = bool(r["dll_val"] > 0 and r["dll_test"] > 0 and r["z_test"] >= 2)
        out["stats"][s] = r
        print(f"   {s:7s} + {af:13s} val Δ {r['dll_val']:+.6f} (z {zv:+.1f})  test Δ {r['dll_test']:+.6f} "
              f"(z {z:+.1f})  → {'ADOPTER' if r['adopt'] else 'non'}   "
              f"obs/A aréna≥1,15 : {r['obs_over_A_when_arena_ge_1.15']}  ≤0,85 : {r['obs_over_A_when_arena_le_0.85']}"
              f"  ({time.time()-t0:.0f}s)", flush=True)
    json.dump(out, open(os.path.join(MODELS, "player_arena_report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_arena_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
