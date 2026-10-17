"""
level_wf.py — le recalage de niveau dans la saison (level.py), re-mesuré sur les
modèles joueur SERVIS après les chantiers 2 et 3 (réentraînement récent,
déploiement récent).

    python explore_players/retrain.py       # d'abord
    python explore_players/recency_wf.py    # d'abord
    python explore_players/level_wf.py      # écrit ../models/player_level_report.json

level.py a mesuré le recalage sur le modèle figé (≤ 2021-22), qui surestimait
les tirs et les mises en échec des dernières saisons. Le modèle servi a changé :
6 stats sont réentraînées chaque été, et certaines ont les variables de
déploiement récent. Le recalage doit être jugé sur CE modèle-là.

Prédictions hors échantillon : pour chaque saison S ∈ {2023-24, 2024-25,
2025-26}, la configuration servie de la stat (retrain.py : « récent » ou
« figé » ; recency_wf.py : + 3 variables de déploiement ou non) entraînée avec
ce qu'on savait avant S. Puis k = 1 + w·(r − 1), r = Σ obs / Σ μ des jours
précédents de la saison, w = n / (n + n0), n = matchs NHL joués (level.py).

Règle (posée avant le run, 2026-10-15) — celle de level.py, sur ces saisons :
n0 choisi sur 2023-24 dans {50, 100, 200, 400, 800, 1600} ; recalage adopté si
Δ log-vraisemblance > 0 sur 2023-24 ET sur 2024-25 → 2025-26 regroupées, avec
z ≥ 2 sur 2024-25 → 2025-26. Le rapport remplace player_level_report.json
(lu par train_player.refresh_player_level : n0 et verdict par stat) ;
l'ancien est gardé sous player_level_report_frozen.json.
"""
from __future__ import annotations
import json, os, shutil, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
sys.path.insert(0, HERE)
import train_player as TP                    # noqa: E402
from retrain import BASE, TEST, causal_k     # noqa: E402
from recency_wf import RECENCY               # noqa: E402

MODELS = TP.MODELS_DIR
OUT = os.path.join(HERE, "out")
N0_GRID = [50, 100, 200, 400, 800, 1600]
VAL, TST = 2023, (2024, 2025)


def zstat(d):
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def main():
    t0 = time.time()
    df = pd.read_pickle(os.path.join(OUT, "retrain_frame.pkl"))
    df = pd.concat([df, pd.read_pickle(os.path.join(OUT, "lineup_feats.pkl"))[RECENCY]], axis=1)
    TE = df[df.season.isin(TEST)].sort_values(["date", "gameId"]).reset_index(drop=True)
    yrs = TE.season.values
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    retr = json.load(open(os.path.join(MODELS, "player_retrain_report.json")))["stats"]
    rec = json.load(open(os.path.join(MODELS, "player_recency_report.json")))["stats"]
    print(f"⛸️  {len(TE)} patineur-matchs de test ({time.time()-t0:.0f}s)", flush=True)

    cache = os.path.join(OUT, "level_wf_mu.pkl")
    MU = pd.read_pickle(cache) if os.path.exists(cache) else pd.DataFrame(index=TE.index)
    cfg = {}
    for s in TP.STATS:
        frozen = retr[s]["kept"] == "A"
        recency = bool(rec.get(s, {}).get("pass"))
        feats = rep["stats"][s]["features"] + (RECENCY if recency else [])
        cfg[s] = {"policy": "figé" if frozen else "récent", "recency": recency}
        if f"mu_{s}" in MU:
            continue
        y = f"y_{s}"
        mono = {f"vs_lift_{x}": 1 for x in TP.STATS if f"vs_lift_{x}" in feats}
        p = dict(BASE, monotone_constraints=mono) if mono else BASE
        mu, ks = np.zeros(len(TE)), np.zeros(len(TE))
        for S in ([TEST[0]] if frozen else TEST):
            tr, va = (df[df.season <= 2021], df[df.season == 2022]) if frozen else \
                     (df[df.season <= S - 2], df[df.season == S - 1])
            dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
            b0 = xgb.train(p, xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats), 2000,
                           evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
            R = b0.best_iteration + 1
            k = TP.fit_k(va[y].values, b0.predict(dva, iteration_range=(0, R)))
            if frozen:
                b1, rows = b0[:R], TE.index.values
            else:
                full = df[df.season <= S - 1]
                b1 = xgb.train(p, xgb.DMatrix(full[feats], label=full[y], feature_names=feats), R,
                               verbose_eval=False)
                rows = TE.index.values[yrs == S]
            mu[rows] = b1.predict(xgb.DMatrix(TE.loc[rows, feats], feature_names=feats))
            ks[rows] = k
        MU[f"mu_{s}"], MU[f"k_{s}"] = mu, ks
        MU.to_pickle(cache)
        print(f"   {s:9s} prédictions {cfg[s]} ({time.time()-t0:.0f}s)", flush=True)

    report = {"generated": time.strftime("%Y-%m-%d"), "n0_grid": N0_GRID,
              "model": "modèle servi après réentraînement récent et déploiement récent (hors échantillon)",
              "rule": "n0 choisi sur 2023-24 ; adopté si Δ log-vraisemblance > 0 sur 2023-24 ET sur 2024-26, z ≥ 2 sur 2024-26",
              "stats": {}}
    val, tst = yrs == VAL, np.isin(yrs, TST)
    for s in TP.STATS:
        y = TE[f"y_{s}"].values.astype(float)
        mu = np.clip(MU[f"mu_{s}"].values, 1e-6, None)
        ks = MU[f"k_{s}"].values

        def ll(m):
            out = np.empty(len(y))
            for k in np.unique(ks):
                w = ks == k
                out[w] = TP.nb_ll(y[w], m[w], k)
            return out
        base = ll(mu)
        best = None
        for n0 in N0_GRID:
            kk = causal_k(TE, y, mu, n0)
            d = ll(mu * kk) - base
            if best is None or d[val].mean() > best[1][val].mean():
                best = (n0, d, kk)
        n0, d, kk = best
        r = {**cfg[s], "n0": n0,
             "dll_val": round(float(d[val].mean()), 7), "z_val": round(zstat(d[val]), 2),
             "dll_test": round(float(d[tst].mean()), 7), "z_test": round(zstat(d[tst]), 2),
             "by_season": {int(se): {"obs": round(float(y[yrs == se].mean()), 4),
                                     "model": round(float(mu[yrs == se].mean()), 4),
                                     "leveled": round(float((mu * kk)[yrs == se].mean()), 4),
                                     "dll": round(float(d[yrs == se].mean()), 7)} for se in TEST}}
        r["adopt"] = bool(r["dll_val"] > 0 and r["dll_test"] > 0 and r["z_test"] >= 2)
        report["stats"][s] = r
        print(f"   {s:9s} n0={n0:5d}  2023 Δ {r['dll_val']:+.6f} (z {r['z_val']:+.1f})  2024-26 Δ {r['dll_test']:+.6f} "
              f"(z {r['z_test']:+.1f}) → {'ADOPTER' if r['adopt'] else 'non'}   "
              + "  ".join(f"{se}: {v['obs']:.3f}/{v['model']:.3f}" for se, v in r["by_season"].items()), flush=True)
    dst = os.path.join(MODELS, "player_level_report.json")
    old = os.path.join(MODELS, "player_level_report_frozen.json")
    if os.path.exists(dst) and not os.path.exists(old):
        shutil.copy(dst, old)
    json.dump(report, open(dst, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_level_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
