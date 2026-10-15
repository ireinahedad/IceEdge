"""Décorrélation du marché (Hubáček, Šourek et Železný 2019 ; Hubáček et Šír 2023).

La couche de correction C est réajustée avec la perte
    L(w) = Σ CE(σ(Xw), y)  −  α · Σ (σ(Xw) − p_ouverture)²
qui récompense les écarts au prix d'ouverture (celui contre lequel on parie).
α = 0 redonne la couche C servie. Walk-forward strict : ajustement sur les
saisons < S (au moins 3), application à S. Paris : edge ≥ 2 % contre
l'ouverture dévigée, mise fixe, CLV = proba de clôture − proba d'ouverture du
côté choisi. À lancer depuis ml/python : python explore_references/<script>.py, après run_variants.py.
"""
import json
import os
import sys

import numpy as np
from scipy.optimize import minimize

sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402
import backtest_walkforward as W  # noqa: E402

ref = A.load("ref")
ks = sorted(ref)
ALPHAS = [0.0, 0.25, 0.5, 1.0]
EDGE = 0.02


def fit(X, y, pm, alpha):
    has = np.isfinite(pm)
    pm0 = np.where(has, pm, 0.0)

    def obj(w):
        z = X @ w
        p = 1 / (1 + np.exp(-z))
        p = np.clip(p, 1e-9, 1 - 1e-9)
        ce = -(y * np.log(p) + (1 - y) * np.log(1 - p))
        dec = np.where(has, (p - pm0) ** 2, 0.0)
        g_ce = X.T @ (p - y)
        g_dec = X.T @ (np.where(has, 2 * (p - pm0), 0.0) * p * (1 - p))
        return ce.sum() - alpha * dec.sum(), g_ce - alpha * g_dec
    w0 = np.zeros(X.shape[1])
    return minimize(obj, w0, jac=True, method="L-BFGS-B").x


res = {}
for alpha in ALPHAS:
    bets = []
    lls = []
    for i, s in enumerate(ks):
        past = ks[:i]
        if len(past) < W.RECAL_MIN_SEASONS:
            continue
        cat = lambda key: np.concatenate([ref[x][key] for x in past])
        y_tr = np.concatenate([ref[x]["meta"]["home_win"].to_numpy(float) for x in past])
        p_tr = np.clip(cat("p_ml"), 1e-6, 1 - 1e-6)
        X_tr = cat("X")
        pm_tr = np.concatenate([ref[x]["meta"]["market_home_p_open"].to_numpy(float) for x in past])
        mu, sd = np.nanmean(X_tr, axis=0), np.nanstd(X_tr, axis=0)
        sd[sd == 0] = 1.0
        std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
        D_tr = np.column_stack([np.ones(len(y_tr)), W._logit(p_tr), std(X_tr)])
        w = fit(D_tr, y_tr, pm_tr, alpha)
        m = ref[s]["meta"]
        p_te = np.clip(ref[s]["p_ml"], 1e-6, 1 - 1e-6)
        D_te = np.column_stack([np.ones(len(p_te)), W._logit(p_te), std(ref[s]["X"])])
        p = 1 / (1 + np.exp(-(D_te @ w)))
        y = m["home_win"].to_numpy(float)
        lls.append(A.ll(y, p))
        po, pc = m["market_home_p_open"].to_numpy(float), m["market_home_p_close"].to_numpy(float)
        oh, oa = m["home_ml_open"].to_numpy(float), m["away_ml_open"].to_numpy(float)
        for j in range(len(p)):
            if not (np.isfinite(po[j]) and np.isfinite(pc[j]) and np.isfinite(oh[j]) and np.isfinite(oa[j])):
                continue
            src = str(m["source"].iloc[j])
            if p[j] - po[j] >= EDGE:
                bets.append((s, src, pc[j] - po[j], (oh[j] - 1) if y[j] == 1 else -1.0))
            elif (1 - p[j]) - (1 - po[j]) >= EDGE:
                bets.append((s, src, po[j] - pc[j], (oa[j] - 1) if y[j] == 0 else -1.0))
    b = np.array([(x[0], x[2], x[3]) for x in bets], float)
    srcs = np.array([x[1] for x in bets])
    llall = np.concatenate(lls)
    r = {"logloss": round(float(llall.mean()), 5), "n_bets": int(len(b))}
    for name in ["tout", "sbro", "oddsapi:draftkings"]:
        msk = np.ones(len(b), bool) if name == "tout" else srcs == name
        if msk.sum() < 30:
            continue
        clv, roi = b[msk, 1], b[msk, 2]
        r[name] = {"n": int(msk.sum()),
                   "clv_moy_pts": round(100 * float(clv.mean()), 3),
                   "clv_t": round(float(clv.mean() / (clv.std(ddof=1) / np.sqrt(len(clv)))), 2),
                   "roi_pct": round(100 * float(roi.mean()), 2),
                   "roi_t": round(float(roi.mean() / (roi.std(ddof=1) / np.sqrt(len(roi)))), 2)}
    res[str(alpha)] = r
    print(f"alpha={alpha}: LL {r['logloss']}  " + "  ".join(
        f"{k}: n={v['n']} CLV {v['clv_moy_pts']:+.3f} pt (t {v['clv_t']:+.1f}) ROI {v['roi_pct']:+.2f} % (t {v['roi_t']:+.1f})"
        for k, v in r.items() if isinstance(v, dict)), flush=True)
json.dump(res, open("explore_references/out/decorrelation.json", "w"), indent=2)
