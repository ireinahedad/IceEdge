import numpy as np, pandas as pd, json
from scipy.optimize import minimize_scalar
from scipy.special import gammaln, logsumexp
from harness import *
import sys as _sys; _sys.path.insert(0, str(HERE))
X = load()
tr, te = X[X.split == "train"].reset_index(drop=True), X[X.split == "test"].reset_index(drop=True)

# ---------- dispersion conditionnelle (sachant λ) ----------
for nm, d in (("train OOF", tr), ("test", te)):
    for s, y, l in (("dom", d.hr, d.lam_h), ("ext", d.ar, d.lam_a)):
        print(f"{nm:9s} {s}: E[(y-λ)²/λ] = {np.mean((y-l)**2/l):.4f}   moyenne y {y.mean():.3f} λ {l.mean():.3f}")

# ---------- COM-Poisson, paramétré par la moyenne ----------
def cmp_pmf_mean(mu, nu, grid=60):
    """COM-Poisson de moyenne mu (vecteur), dispersion nu (nu>1 = sous-dispersé)."""
    ks = np.arange(grid)
    mu = np.asarray(mu, float)
    # log-rate : partir de l'approx log(lam) = nu*log(mu + (nu-1)/(2nu)), puis Newton sur la moyenne
    loglam = nu * np.log(np.clip(mu + (nu - 1) / (2 * nu), 1e-3, None))
    for _ in range(30):
        lw = ks[None] * loglam[:, None] - nu * gammaln(ks + 1)[None]
        lw -= lw.max(1, keepdims=True)
        w = np.exp(lw); w /= w.sum(1, keepdims=True)
        m = (w * ks).sum(1); v = (w * ks**2).sum(1) - m**2
        loglam = loglam - (m - mu) / np.clip(v, 1e-6, None)   # dm/dloglam = var
    p = w[:, :K].copy(); p[:, -1] += w[:, K:].sum(1)
    return p

def fit_nu(y, mu):
    f = lambda nu: -np.log(cmp_pmf_mean(mu, nu)[np.arange(len(y)), y]).mean()
    r = minimize_scalar(f, bounds=(0.7, 1.4), method="bounded")
    return r.x, r.fun, f(1.0)
nu_h, a, b = fit_nu(tr.hr.values, tr.lam_h.values); print(f"ν dom = {nu_h:.4f}  (NLL {a:.5f} vs Poisson {b:.5f})")
nu_a, a, b = fit_nu(tr.ar.values, tr.lam_a.values); print(f"ν ext = {nu_a:.4f}  (NLL {a:.5f} vs Poisson {b:.5f})")

# ---------- Copule de Frank sur marges Poisson ----------
def frank_C(u, v, th):
    if abs(th) < 1e-8: return u * v
    num = np.expm1(-th * u) * np.expm1(-th * v)
    return -np.log1p(num / np.expm1(-th)) / th
def frank_matrix(ph, pa, th):
    Fh = np.concatenate([np.zeros((len(ph), 1)), np.cumsum(ph, 1)], 1).clip(0, 1)
    Fa = np.concatenate([np.zeros((len(pa), 1)), np.cumsum(pa, 1)], 1).clip(0, 1)
    C = frank_C(Fh[:, :, None], Fa[:, None, :], th)
    M = C[:, 1:, 1:] - C[:, :-1, 1:] - C[:, 1:, :-1] + C[:, :-1, :-1]
    M = np.clip(M, 1e-15, None)
    return M / M.sum((1, 2), keepdims=True)
ph_tr, pa_tr = pois_pmf(tr.lam_h), pois_pmf(tr.lam_a)
def nll_frank(th, tau=False):
    M = frank_matrix(ph_tr, pa_tr, th)
    if tau: M = apply_tau(M)
    return -np.log(M[np.arange(len(tr)), tr.hr, tr.ar]).mean()
r = minimize_scalar(nll_frank, bounds=(-3, 3), method="bounded"); th = r.x
print(f"θ Frank (sans τ) = {th:.4f}  NLL {r.fun:.5f} vs indép {nll_frank(0):.5f}")
# τ ré-estimé sur la matrice Frank pour la variante Frank+τ
def refit_tau(Mtr, d):
    margins = (d.hr - d.ar).values
    tau = {}
    for k in range(-6, 7):
        emp = (margins == k).mean(); ex = Mtr[:, MARG == k].sum(1).mean()
        tau[k] = float(np.clip(emp / ex, .25, 4)) if emp > 0 and ex > 1e-9 else 1.0
    return tau
Mf_tr = frank_matrix(ph_tr, pa_tr, th)
tau_f = refit_tau(Mf_tr, tr)
r2 = minimize_scalar(lambda t: -np.log(apply_tau(frank_matrix(ph_tr, pa_tr, t), tau_f)[np.arange(len(tr)), tr.hr, tr.ar]).mean(), bounds=(-3, 3), method="bounded")
print(f"θ Frank (avec τ ré-ajusté) = {r2.x:.4f}")
# corrélation implicite
for t in (th, r2.x):
    M = frank_matrix(pois_pmf([3.0]), pois_pmf([2.75]), t)[0]
    Eh = (M.sum(1) * IDX).sum(); Ea = (M.sum(0) * IDX).sum()
    cov = (M * IDX[:, None] * IDX[None]).sum() - Eh * Ea
    print(f"   θ={t:.3f} → corrélation implicite (λ 3.0/2.75) = {cov / np.sqrt(Eh * Ea):.4f}")
print("corr résiduelle observée (train, y-λ):", np.corrcoef(tr.hr - tr.lam_h, tr.ar - tr.lam_a)[0, 1].round(4),
      " test:", np.corrcoef(te.hr - te.lam_h, te.ar - te.lam_a)[0, 1].round(4))

# ---------- évaluation test ----------
ph, pa = pois_pmf(te.lam_h), pois_pmf(te.lam_a)
Mi = ph[:, :, None] * pa[:, None, :]
Mc = cmp_pmf_mean(te.lam_h.values, nu_h)[:, :, None] * cmp_pmf_mean(te.lam_a.values, nu_a)[:, None, :]
res = {
    "Poisson indép": Mi,
    "Poisson+τ": apply_tau(Mi),
    "Frank": frank_matrix(ph, pa, th),
    "Frank+τ": apply_tau(frank_matrix(ph, pa, r2.x), tau_f),
    "COM-Poisson": Mc,
}
# COM + τ : τ ré-ajusté sur les marges COM du train
Mc_tr = cmp_pmf_mean(tr.lam_h.values, nu_h)[:, :, None] * cmp_pmf_mean(tr.lam_a.values, nu_a)[:, None, :]
tau_c = refit_tau(Mc_tr, tr)
res["COM-Poisson+τ"] = apply_tau(Mc, tau_c)
np.save("res_s1.npy", {k: v.astype(np.float32) for k, v in res.items()}, allow_pickle=True)
json.dump({"nu_h": nu_h, "nu_a": nu_a, "theta_frank": th, "theta_frank_tau": r2.x,
           "tau_frank": tau_f, "tau_cmp": tau_c}, open("params_s1.json", "w"), indent=1)
tab, _ = compare(res, te)
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 50)
cols = ["méthode"] + [c for c in tab.columns if c.endswith(" Δ") or c.endswith(" z")]
print(tab[["méthode", "score_exact", "moneyline", "PL_dom_-1.5", "nul_60", "over_5.5"]].to_string())
print(tab[cols].T.to_string())
print(margin_table(res, te).to_string())
