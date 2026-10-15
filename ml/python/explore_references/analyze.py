"""Verdicts des variantes : modèle de score brut, puis chaîne servie (couche C).

Règle d'adoption (fixée avant lecture, celle du projet) : log-loss moneyline
OU puck line à z <= -2 (apparié par match) ET gain sur >= 70 % des saisons,
l'autre marché à z < +2. Saisons 2012-2025 (2026 en cours : 83 matchs, exclue).
"""
import glob
import json
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.getcwd())
import backtest_walkforward as W  # noqa: E402

PRED = "explore_references/out/preds"
SEASONS = list(range(2012, 2026))


def load(name):
    P = {}
    for s in SEASONS:
        f = f"{PRED}/{name}_{s}.pkl"
        if os.path.exists(f):
            P[s] = pickle.load(open(f, "rb"))
    return P


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def correction_preds(P, feature_idx=None, mode="C"):
    """Couche de correction walk-forward (variante C de run_correction).

    mode "C"     : logistique sur [logit p, features standardisées]
    mode "Cbeta" : calibration bêta intégrée : [ln p, -ln(1-p), features]
    Renvoie {saison: p corrigée} pour les saisons ayant >= 3 saisons passées.
    """
    ks = sorted(P)
    out = {}
    idx = list(range(len(W.CORRECTION_FEATURES))) if feature_idx is None else feature_idx
    for i, s in enumerate(ks):
        past = ks[:i]
        if len(past) < W.RECAL_MIN_SEASONS:
            continue
        y_tr = np.concatenate([P[x]["meta"]["home_win"].to_numpy(float) for x in past])
        p_tr = np.clip(np.concatenate([P[x]["p_ml"] for x in past]), 1e-6, 1 - 1e-6)
        X_tr = np.concatenate([P[x]["X"] for x in past])
        mu, sd = np.nanmean(X_tr, axis=0), np.nanstd(X_tr, axis=0)
        sd[sd == 0] = 1.0
        std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)[:, idx]
        p_te = np.clip(P[s]["p_ml"], 1e-6, 1 - 1e-6)

        def head(p):
            if mode == "Cbeta":
                return [np.log(p), -np.log(1 - p)]
            return [W._logit(p)]
        Xtr = np.column_stack(head(p_tr) + [std(X_tr)])
        Xte = np.column_stack(head(p_te) + [std(P[s]["X"])])
        b, _ = W._logistic_offset(y_tr, Xtr, np.zeros(len(y_tr)))
        out[s] = 1 / (1 + np.exp(-(b[0] + Xte @ b[1:])))
    return out


def verdict_block(d_by_season: dict, other_by_season: dict | None = None):
    seas = sorted(d_by_season)
    d = np.concatenate([d_by_season[s] for s in seas])
    pr = W._paired(d)
    better = [s for s in seas if d_by_season[s].mean() < 0]
    share = len(better) / len(seas)
    other_ok = True
    if other_by_season is not None:
        o = W._paired(np.concatenate([other_by_season[s] for s in seas]))
        other_ok = o["z"] is None or o["z"] < 2
    ok = pr["z"] is not None and pr["z"] <= -2 and share >= 0.70 and other_ok
    worse = pr["z"] is not None and pr["z"] >= 2
    return {**pr, "seasons_better": f"{len(better)}/{len(seas)}",
            "verdict": "ADOPTER" if ok else ("PIRE" if worse else "NON TRANCHABLE")}


if __name__ == "__main__":
    ref = load("ref")
    names = sys.argv[1].split(",") if len(sys.argv) > 1 else ["xg_flurry", "xg_fsv", "elo_ac"]
    report = {}
    for n in names:
        V = load(n)
        common = [s for s in SEASONS if s in V and s in ref]
        if len(common) < len(SEASONS):
            print(n, "incomplet", len(common)); continue
        r = {}
        for k in ("ml", "pl", "dev"):
            other = None
            if k == "ml":
                other = {s: V[s]["pl"] - ref[s]["pl"] for s in common}
            if k == "pl":
                other = {s: V[s]["ml"] - ref[s]["ml"] for s in common}
            r[k] = verdict_block({s: V[s][k] - ref[s][k] for s in common}, other)
        # chaîne servie : couche C propre à chaque variante
        cr, cv = correction_preds(ref), correction_preds(V)
        dc = {s: ll(V[s]["meta"]["home_win"].to_numpy(float), cv[s])
              - ll(ref[s]["meta"]["home_win"].to_numpy(float), cr[s]) for s in cr}
        r["ml_servi"] = verdict_block(dc)
        report[n] = r
        print(f"\n== {n}")
        for k, v in r.items():
            print(f"   {k:>9}: delta {v['delta']:+.5f}  z {v['z']:+.2f}  saisons {v['seasons_better']}  -> {v['verdict']}")
    json.dump(report, open("explore_references/out/verdicts_features.json", "w"), indent=2, default=str)
