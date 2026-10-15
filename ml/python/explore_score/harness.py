"""Banc d'essai commun : chaque méthode rend, par match, une matrice M[i,j] de
score réglementaire (14×14). Mêmes λ, mêmes métriques, différences appariées."""
import json, math
from pathlib import Path as _P
import os as _os
HERE = _P(__file__).resolve().parent
ML = HERE.parents[1]
DATA, MODELS, OUT = ML / "data", ML / "models", HERE / "out"
OUT.mkdir(exist_ok=True)
_os.chdir(OUT)          # toutes les sorties intermédiaires vont dans explore_score/out/
import numpy as np, pandas as pd
from scipy.special import gammaln, expit

K = 14
IDX = np.arange(K)
MARG = IDX[:, None] - IDX[None, :]
TOT = IDX[:, None] + IDX[None, :]
REP = json.load(open(str(MODELS) + "/score_report.json"))
TAU = {int(k): v for k, v in REP["tau_margin"].items()}
W_OT = REP["p_ot_model"]["w"]

def load():
    X = pd.read_csv(str(OUT / "lambdas.csv"))
    X["hr"] = X.home_reg_score.astype(int).clip(0, K - 1)
    X["ar"] = X.away_reg_score.astype(int).clip(0, K - 1)
    return X

def pois_pmf(lam):
    lam = np.asarray(lam, float)[:, None]
    p = np.exp(-lam + IDX * np.log(lam) - gammaln(IDX + 1))
    p[:, -1] += np.clip(1 - p.sum(1), 0, None)
    return p / p.sum(1, keepdims=True)

def indep(lh, la):
    return pois_pmf(lh)[:, :, None] * pois_pmf(la)[:, None, :]

def tau_mult(tau=TAU):
    m = np.ones((K, K))
    for d, t in tau.items():
        m[MARG == d] = t
    return m

def apply_tau(M, tau=TAU):
    M = M * tau_mult(tau)[None]
    return M / M.sum((1, 2), keepdims=True)

def p_ot(lh, la):
    return expit(W_OT[0] * (lh - la) + W_OT[1])

def ll(y, p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))

def per_game(M, X):
    """Pertes par match (vecteurs) pour chaque métrique."""
    n = len(X)
    hr, ar = X.hr.values, X.ar.values
    po = p_ot(X.lam_h.values, X.lam_a.values)
    p_tie = M[:, MARG == 0].sum(1)
    p_regw = M[:, MARG > 0].sum(1)
    p_pl = M[:, MARG >= 2].sum(1)
    p_ml = p_regw + p_tie * po
    # total FINAL : nul k-k -> 2k+1
    tot_final = np.where(MARG == 0, TOT + 1, TOT)
    p_o55 = M[:, tot_final > 5.5].sum(1)
    p_o65 = M[:, tot_final > 6.5].sum(1)
    p_btts = M[:, 1:, 1:].sum((1, 2))
    y_final_tot = X.home_score.values + X.away_score.values
    y_final_tot = np.where(X.went_to_ot.values == 1, X.home_reg_score.values + X.away_reg_score.values + 1, y_final_tot)
    out = {
        "score_exact": -np.log(np.clip(M[np.arange(n), hr, ar], 1e-12, None)),
        "écart_exact": -np.log(np.clip(np.stack([M[i][MARG == (hr[i] - ar[i])].sum() for i in range(n)]), 1e-12, None)),
        "total_exact": -np.log(np.clip(np.stack([M[i][TOT == (hr[i] + ar[i])].sum() for i in range(n)]), 1e-12, None)),
        "nul_60": ll((hr == ar).astype(float), p_tie),
        "PL_dom_-1.5": ll((hr - ar >= 2).astype(float), p_pl),
        "moneyline": ll(X.home_win.values.astype(float), p_ml),
        "over_5.5": ll((y_final_tot > 5.5).astype(float), p_o55),
        "over_6.5": ll((y_final_tot > 6.5).astype(float), p_o65),
        "BTTS": ll(((hr > 0) & (ar > 0)).astype(float), p_btts),
    }
    return out

def compare(results, X, base="Poisson+τ"):
    """results: {nom: M}. Tableau des pertes moyennes + Δ vs base avec z apparié."""
    pg = {k: per_game(M, X) for k, M in results.items()}
    rows = []
    b = pg[base]
    for k, d in pg.items():
        r = {"méthode": k}
        for m, v in d.items():
            diff = v - b[m]
            se = diff.std(ddof=1) / math.sqrt(len(diff))
            r[m] = round(v.mean(), 5)
            r[m + " Δ"] = round(diff.mean(), 5)
            r[m + " z"] = round(diff.mean() / se, 2) if se > 0 else 0.0
        rows.append(r)
    return pd.DataFrame(rows), pg

def margin_table(results, X):
    obs = (X.hr - X.ar).clip(-4, 4).value_counts(normalize=True).sort_index()
    rows = {"observé": obs}
    for k, M in results.items():
        rows[k] = pd.Series({d: M[:, (np.clip(MARG, -4, 4) == d)].sum(1).mean() for d in range(-4, 5)})
    return pd.DataFrame(rows).round(4)
