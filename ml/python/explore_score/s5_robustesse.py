"""Robustesse : le test a un biais de niveau (λ +4 % vs observé). On refait la
comparaison clé avec des λ recalés au niveau observé (oracle, mêmes pour tous)
pour séparer l'effet « forme » de l'effet « niveau »."""
import numpy as np, pandas as pd
from harness import *
import sys as _sys; _sys.path.insert(0, str(HERE))
import s2_periode_filet_desert as S2
X = S2.X; te = X[X.split == "test"].reset_index(drop=True)
rh, ra = te.hr.mean() / te.lam_h.mean(), te.ar.mean() / te.lam_a.mean()
print(f"facteurs de niveau oracle : dom {rh:.4f}  ext {ra:.4f}")
lh, la = te.lam_h.values * rh, te.lam_a.values * ra
tr = X[(X.split == "train") & X.ok_lg].reset_index(drop=True)
c_tr = S2.fit_cells(tr, S2.G)[0]
M = indep(lh, la)
res = {"Poisson indép": M, "Poisson+τ": apply_tau(M), "Dyn. période+FD (train)": S2.dp(lh, la, c_tr)[0]}
# glissant : multiplicateurs relatifs (on renormalise c pour ôter le niveau appris sur la fenêtre)
Md = np.empty_like(M)
for S in sorted(te.season.unique()):
    i = (te.season == S).values
    w = X[(X.season >= S - 3) & (X.season < S) & X.ok_lg]
    c = S2.fit_cells(w, S2.G)[0]
    Mi = S2.dp(lh[i], la[i], c)[0]
    # recale le niveau total sur λ (même total attendu que les autres méthodes)
    Md[i] = Mi
res["Dyn. période+FD glissant"] = Md
tab, _ = compare(res, te)
print(tab.set_index("méthode")[[c for c in tab.columns if c.endswith(" Δ") or c.endswith(" z")]].T.to_string())
print({k: round(float((m * TOT).sum((1, 2)).mean()), 3) for k, m in res.items()}, "obs", round((te.hr + te.ar).mean(), 3))

# ── c « relatif » : on retire le niveau appris sur la fenêtre (Σ expo·c = Σ buts attendus par λ)
def fit_rel(w):
    c, gl, expo, en = S2.fit_cells(w, S2.G)
    return c * expo.sum() / (expo * c).sum()
c_tr_rel = fit_rel(tr)
res2 = {"Poisson+τ": res["Poisson+τ"], "Dyn. train relatif": S2.dp(lh, la, c_tr_rel)[0]}
Mr = np.empty_like(M); snaps = {1200: np.empty_like(M), 2400: np.empty_like(M)}; c_roll = {}
for S in sorted(te.season.unique()):
    i = (te.season == S).values
    c_roll[S] = fit_rel(X[(X.season >= S - 3) & (X.season < S) & X.ok_lg])
    Mr[i], sn = S2.dp(lh[i], la[i], c_roll[S])
    for k in sn: snaps[k][i] = sn[k]
res2["Dyn. glissant relatif"] = Mr
tab, _ = compare(res2, te)
print("\n=== niveau oracle, multiplicateurs relatifs ===")
print(tab.set_index("méthode")[[c for c in tab.columns if c.endswith(" Δ") or c.endswith(" z")]].T.to_string())
print({k: round(float((m * TOT).sum((1, 2)).mean()), 3) for k, m in res2.items()})
print(margin_table(res2, te).to_string())
np.save("res_s5.npy", {k: v.astype(np.float32) for k, v in res2.items()}, allow_pickle=True)

# marchés par période au niveau oracle
from scipy.stats import poisson
ok = te.ok_lg.values; tt = te[ok].reset_index(drop=True)
per = S2.G[S2.G.game_id.isin(tt.game_id)].groupby(["game_id", "period"]).size().unstack(fill_value=0)
yP = {p: tt.game_id.map(per[p]).fillna(0).values for p in (1, 2, 3)}
lh2, la2 = lh[ok], la[ok]; SH = {1: 0.305, 2: 0.365, 3: 0.330}
rows = []
for p, (t0, t1) in {1: (0, 1200), 2: (1200, 2400), 3: (2400, 3600)}.items():
    Pst = np.zeros((len(tt), K, K)); Pst[:, 0, 0] = 1
    if p > 1: Pst = snaps[t0][ok]
    dist = np.zeros((len(tt), 13))
    for S in sorted(tt.season.unique()):
        i = (tt.season == S).values
        dist[i] = S2.period_goal_dist(lh2[i], la2[i], c_roll[S], Pst[i], t0, t1)
    for L in (0.5, 1.5, 2.5):
        y = (yP[p] > L).astype(float)
        a = ll(y, 1 - poisson.cdf(L, (lh2 + la2) * SH[p])); b = ll(y, dist[:, int(L) + 1:].sum(1))
        dd = b - a
        rows.append({"marché": f"P{p} total > {L}", "obs": y.mean().round(3),
                     "préd heuristique": (1 - poisson.cdf(L, (lh2 + la2) * SH[p])).mean().round(3),
                     "préd dynamique": dist[:, int(L) + 1:].sum(1).mean().round(3),
                     "Δ log-loss": dd.mean().round(5), "z": (dd.mean() / (dd.std() / np.sqrt(len(dd)))).round(2)})
print("\n=== marchés par période, niveau oracle ===")
print(pd.DataFrame(rows).to_string())

# ── τ ré-ajusté sur une fenêtre glissante (3 saisons) : l'alternative bon marché
Mt = np.empty_like(M)
for S in sorted(te.season.unique()):
    i = (te.season == S).values; w = X[(X.season >= S - 3) & (X.season < S)]
    Mw = indep(w.lam_h.values, w.lam_a.values); m = (w.hr - w.ar).values
    tau = {k: float(np.clip((m == k).mean() / Mw[:, MARG == k].sum(1).mean(), .25, 4)) for k in range(-6, 7)}
    Mt[i] = apply_tau(M[i], tau)
res3 = {"Poisson+τ": res["Poisson+τ"], "Poisson+τ glissant": Mt, "Dyn. glissant relatif": res2["Dyn. glissant relatif"]}
tab, _ = compare(res3, te)
print("\n=== niveau oracle : τ glissant vs modèle dynamique glissant ===")
print(tab.set_index("méthode")[[c for c in tab.columns if c.endswith(" Δ") or c.endswith(" z")]].T.to_string())
