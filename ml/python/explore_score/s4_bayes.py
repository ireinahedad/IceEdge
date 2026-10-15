"""Piste 3 — modèle bayésien hiérarchique attaque/défense (PyMC), walk-forward.

Deux variantes, ré-ajustées tous les 14 jours sur le test avec uniquement les
matchs passés (fenêtre 400 j, poids de récence demi-vie 100 j, à la Dixon-Coles) :
  A « pur »    : log μ = α + dom·h + att[équipe] − def[adversaire]
  B « offset » : log μ = log λ_xgb + β + att[équipe] − def[adversaire]
                 → mesure s'il reste un signal d'équipe que XGBoost n'a pas vu.
att, def ~ N(0, σ), σ ~ HalfNormal(0.3) : le rétrécissement est appris.
Sortie : prédictive a posteriori (mélange de Poisson sur les tirages) + τ.
"""
import sys, time, json
import numpy as np, pandas as pd, pymc as pm, pytensor.tensor as pt
from harness import *
import sys as _sys; _sys.path.insert(0, str(HERE))

VARIANT = sys.argv[1] if len(sys.argv) > 1 else "A"
STEP, WIN, HL = 14, 400, 100.0
X = load(); X["date"] = pd.to_datetime(X.date)
teams = sorted(set(X.home_team) | set(X.away_team)); T = len(teams); tid = {t: i for i, t in enumerate(teams)}
X["hi"], X["ai"] = X.home_team.map(tid), X.away_team.map(tid)
te = X[X.split == "test"].reset_index(drop=True)

NMAX = 4000
with pm.Model() as model:
    h_i = pm.Data("h_i", np.zeros(NMAX, "int64")); a_i = pm.Data("a_i", np.zeros(NMAX, "int64"))
    yh = pm.Data("yh", np.zeros(NMAX)); ya = pm.Data("ya", np.zeros(NMAX))
    oh = pm.Data("oh", np.zeros(NMAX)); oa = pm.Data("oa", np.zeros(NMAX))   # offsets log λ (B) ou 0 (A)
    w = pm.Data("w", np.zeros(NMAX))
    s_att = pm.HalfNormal("s_att", 0.3); s_def = pm.HalfNormal("s_def", 0.3)
    att = pm.ZeroSumNormal("att", sigma=s_att, shape=T); dfn = pm.ZeroSumNormal("def", sigma=s_def, shape=T)
    if VARIANT == "A":
        alpha = pm.Normal("alpha", np.log(2.9), 0.5); home = pm.Normal("home", 0.05, 0.1)
        lmh = alpha + home + att[h_i] - dfn[a_i]; lma = alpha + att[a_i] - dfn[h_i]
    else:
        beta = pm.Normal("beta", 0.0, 0.2)
        lmh = oh + beta + att[h_i] - dfn[a_i]; lma = oa + beta + att[a_i] - dfn[h_i]
    ll_ = yh * lmh - pt.exp(lmh) + ya * lma - pt.exp(lma)
    pm.Potential("lik", (w * ll_).sum())

dates = pd.date_range(te.date.min(), te.date.max() + pd.Timedelta(days=1), freq=f"{STEP}D")
draws_h, draws_a = np.zeros((len(te), 400)), np.zeros((len(te), 400))
diag = []
t0 = time.time()
for k, d0 in enumerate(dates):
    d1 = d0 + pd.Timedelta(days=STEP)
    tgt = ((te.date >= d0) & (te.date < d1)).values
    if not tgt.any(): continue
    hist = X[(X.date < d0) & (X.date >= d0 - pd.Timedelta(days=WIN))].tail(NMAX)
    n = len(hist); age = (d0 - hist.date).dt.days.values
    pad = lambda v, dt=float: np.concatenate([v.astype(dt), np.zeros(NMAX - n, dt)])
    off_h = np.log(hist.lam_h.values) if VARIANT == "B" else np.zeros(n)
    off_a = np.log(hist.lam_a.values) if VARIANT == "B" else np.zeros(n)
    with model:
        pm.set_data({"h_i": pad(hist.hi.values, "int64"), "a_i": pad(hist.ai.values, "int64"),
                     "yh": pad(hist.hr.values), "ya": pad(hist.ar.values), "oh": pad(off_h), "oa": pad(off_a),
                     "w": pad(np.exp(-np.log(2) * age / HL))})
        tr_ = pm.sample(200, tune=400, chains=2, cores=2, progressbar=False, random_seed=k, compute_convergence_checks=False)
    post = tr_.posterior
    att_s = post["att"].values.reshape(-1, T); def_s = post["def"].values.reshape(-1, T)
    g = te[tgt]
    if VARIANT == "A":
        a_ = post["alpha"].values.ravel()[:, None]; hm = post["home"].values.ravel()[:, None]
        lh = np.exp(a_ + hm + att_s[:, g.hi] - def_s[:, g.ai]); la = np.exp(a_ + att_s[:, g.ai] - def_s[:, g.hi])
    else:
        b_ = post["beta"].values.ravel()[:, None]
        lh = g.lam_h.values[None] * np.exp(b_ + att_s[:, g.hi] - def_s[:, g.ai])
        la = g.lam_a.values[None] * np.exp(b_ + att_s[:, g.ai] - def_s[:, g.hi])
    draws_h[tgt], draws_a[tgt] = lh.T, la.T
    diag.append({"date": str(d0.date()), "n_hist": n, "s_att": float(post["s_att"].mean()), "s_def": float(post["s_def"].mean())})
    print(f"[{VARIANT}] {d0.date()} n={n} cible={tgt.sum()} σatt={diag[-1]['s_att']:.3f} σdef={diag[-1]['s_def']:.3f}  ({time.time()-t0:.0f}s)", flush=True)
np.savez_compressed(f"bayes_{VARIANT}.npz", draws_h=draws_h.astype(np.float32), draws_a=draws_a.astype(np.float32))
json.dump(diag, open(f"bayes_{VARIANT}_diag.json", "w"))
print("fini", time.time() - t0)
