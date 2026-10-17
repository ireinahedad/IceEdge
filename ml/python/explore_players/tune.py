"""
tune.py — réglage des paramètres XGBoost du modèle joueur, stat par stat.

    python explore_players/tune.py          # écrit ../models/player_tune_report.json

Tous les modèles joueur tournent avec les mêmes paramètres (profondeur 5,
min_child_weight 50, eta 0,05). Une stat rare (buts, points en AN) et une
stat fréquente et bruitée (mises en échec) n'ont pas forcément le même
réglage idéal.

Grille : profondeur {3, 5, 7} × min_child_weight {20, 200}, plus le réglage
servi (5, 50). Features : celles de la stat servie (player_report.json) ; pour
les pénalités, le modèle du NOMBRE de pénalités (penalty_count).

Étape 1 — choix (sans toucher au test) :
  stats « récentes » : entraînement ≤ 2022-23, arrêt précoce et choix sur 2023-24
  stats « figées » (buts, nombre de pénalités) : entraînement ≤ 2021-22, choix sur 2022-23
Étape 2 — confirmation, règle posée avant le run (2026-10-17) :
  récentes : validation « marchante » sur 2024-25 et 2025-26 (politique de
             retrain.py), réglage choisi contre réglage servi ; adopté si
             Δ log-vraisemblance > 0 regroupé, z ≥ 2, et Δ > 0 les deux saisons
  figées   : test 2023-24 → 2025-26 ; adopté si Δ > 0, z ≥ 2 et Δ > 0 dans
             au moins 2 saisons sur 3
Si le réglage choisi est le réglage servi, rien ne change.
"""
from __future__ import annotations
import json, os, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
sys.path.insert(0, HERE)
import train_player as TP                    # noqa: E402
from retrain import BASE                     # noqa: E402
import attempts as AT                        # noqa: E402
import penalties as PE                       # noqa: E402

MODELS = TP.MODELS_DIR
OUT = os.path.join(HERE, "out")
SERVED = (5, 50)
GRID = [SERVED] + [(d, m) for d in (3, 5, 7) for m in (20, 200)]
RECENT = ["assists", "points", "shots", "hits", "blocks", "ppPoints"]
FROZEN = ["goals", "pen_count"]


def zstat(d):
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def params(cfg, feats):
    d, m = cfg
    mono = {f"vs_lift_{x}": 1 for x in TP.STATS if f"vs_lift_{x}" in feats}
    p = dict(BASE, max_depth=d, min_child_weight=m)
    return dict(p, monotone_constraints=mono) if mono else p


def fit_es(p, feats, y, tr, va):
    dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
    b = xgb.train(p, xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats), 3000,
                  evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
    R = b.best_iteration + 1
    mu = b.predict(dva, iteration_range=(0, R))
    return b, R, mu


def ll_k(y, mu, ks):
    out = np.empty(len(y))
    for k in np.unique(ks):
        m = ks == k
        out[m] = TP.nb_ll(y[m], mu[m], k)
    return out


def main():
    t0 = time.time()
    cache = os.path.join(OUT, "tune_frame.pkl")
    if os.path.exists(cache):
        df = pd.read_pickle(cache)
    else:
        df = AT.frame()
        n0 = len(df)
        df = df.merge(PE.penalty_counts()[["playerId", "gameId", "n_pen"]], on=["playerId", "gameId"], how="left")
        assert len(df) == n0
        df["y_pen_count"] = df.n_pen.fillna(0).astype(int)
        df.to_pickle(cache)
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    print(f"⛸️  {len(df)} patineur-matchs ({time.time()-t0:.0f}s)", flush=True)
    out_path = os.path.join(MODELS, "player_tune_report.json")
    out = json.load(open(out_path)) if os.path.exists(out_path) else {}
    out.update({"generated": time.strftime("%Y-%m-%d"), "grid": GRID, "served": SERVED,
                "rule": ("récentes : choix sur 2023-24, confirmation 2024-25/2025-26 en validation marchante, "
                         "Δ > 0 regroupé, z ≥ 2, Δ > 0 les deux saisons ; figées : choix sur 2022-23, test 2023-26, "
                         "Δ > 0, z ≥ 2, Δ > 0 dans ≥ 2 saisons sur 3")})
    out.setdefault("stats", {})
    for s in RECENT + FROZEN:
        if s in out["stats"] and "verdict" in out["stats"][s]:
            continue
        y = f"y_{s}"
        feats = (rep["penalty_count"] if s == "pen_count" else rep["stats"][s])["features"]
        frozen = s in FROZEN
        tr = df[df.season <= (2021 if frozen else 2022)]
        va = df[df.season == (2022 if frozen else 2023)]
        # ── Étape 1 : choix ──────────────────────────────────────────────────
        scores = {}
        for cfg in GRID:
            _, R, mu = fit_es(params(cfg, feats), feats, y, tr, va)
            k = TP.fit_k(va[y].values, mu)
            scores[cfg] = (float(TP.nb_ll(va[y].values, mu, k).mean()), R, k)
            print(f"   {s:9s} profondeur {cfg[0]} mcw {cfg[1]:3d} : {scores[cfg][0]:.6f} ({R} arbres) "
                  f"({time.time()-t0:.0f}s)", flush=True)
        best = max(GRID, key=lambda c: scores[c][0])
        r = {"policy": "figé" if frozen else "récent",
             "selection": {f"{c[0]}/{c[1]}": {"ll": round(v[0], 6), "rounds": v[1], "k": v[2]} for c, v in scores.items()},
             "chosen": list(best)}
        # ── Étape 2 : confirmation ───────────────────────────────────────────
        if best == SERVED:
            r["verdict"] = "réglage servi déjà le meilleur"
            r["adopt"] = False
        else:
            if frozen:
                te = df[df.season >= 2023]
                yt, yrs = te[y].values.astype(float), te.season.values
                lls = {}
                for cfg in (SERVED, best):
                    b, R, mu = fit_es(params(cfg, feats), feats, y, tr, va)
                    k = TP.fit_k(va[y].values, mu)
                    mt = b.predict(xgb.DMatrix(te[feats], feature_names=feats), iteration_range=(0, R))
                    lls[cfg] = TP.nb_ll(yt, mt, k)
                need = 2
            else:
                te = df[df.season.isin([2024, 2025])]
                yt, yrs = te[y].values.astype(float), te.season.values
                lls = {}
                for cfg in (SERVED, best):
                    p = params(cfg, feats)
                    mu, ks = np.zeros(len(te)), np.zeros(len(te))
                    for S in (2024, 2025):
                        b, R, mv = fit_es(p, feats, y, df[df.season <= S - 2], df[df.season == S - 1])
                        k = TP.fit_k(df[df.season == S - 1][y].values, mv)
                        full = df[df.season <= S - 1]
                        b1 = xgb.train(p, xgb.DMatrix(full[feats], label=full[y], feature_names=feats), R,
                                       verbose_eval=False)
                        m = yrs == S
                        mu[m] = b1.predict(xgb.DMatrix(te.loc[m, feats], feature_names=feats))
                        ks[m] = k
                    lls[cfg] = ll_k(yt, mu, ks)
                need = 2
            d = lls[best] - lls[SERVED]
            by = {int(se): round(float(d[yrs == se].mean()), 7) for se in np.unique(yrs)}
            z = zstat(d)
            r.update({"dll": round(float(d.mean()), 7), "z": round(z, 2), "by_season": by})
            r["adopt"] = bool(d.mean() > 0 and z >= 2 and sum(v > 0 for v in by.values()) >= need)
            r["verdict"] = "adopté" if r["adopt"] else "rejeté"
        out["stats"][s] = r
        print(f"   {s:9s} → choisi {best}  {r['verdict']}  " +
              (f"Δ {r['dll']:+.6f} (z {r['z']:+.1f}) {r['by_season']}" if "dll" in r else "") +
              f"  ({time.time()-t0:.0f}s)", flush=True)
        json.dump(out, open(out_path, "w"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_tune_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
