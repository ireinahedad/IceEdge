import numpy as np, pandas as pd, json
from harness import *
import sys as _sys; _sys.path.insert(0, str(HERE))
X = load(); te = X[X.split == "test"].reset_index(drop=True)
def mixture(dh, da, chunk=200):
    out = np.zeros((len(dh), K, K))
    for s in range(0, len(dh), chunk):
        h, a = dh[s:s+chunk], da[s:s+chunk]
        ph = pois_pmf(h.ravel()).reshape(h.shape + (K,)); pa = pois_pmf(a.ravel()).reshape(a.shape + (K,))
        out[s:s+chunk] = np.einsum("gdi,gdj->gij", ph, pa) / h.shape[1]
    return out
res = {"Poisson+τ": apply_tau(indep(te.lam_h.values, te.lam_a.values))}
info = {}
for v in ("A", "B"):
    z = np.load(f"bayes_{v}.npz"); dh, da = z["draws_h"].astype(float), z["draws_a"].astype(float)
    res[f"Bayes {v} plug-in+τ"] = apply_tau(indep(dh.mean(1), da.mean(1)))
    res[f"Bayes {v} prédictive+τ"] = apply_tau(mixture(dh, da))
    info[v] = (dh, da)
dh, da = info["A"]
gh, ga = np.sqrt(te.lam_h.values * dh.mean(1)), np.sqrt(te.lam_a.values * da.mean(1))
res["Moyenne géom. XGB ⊕ Bayes A +τ"] = apply_tau(indep(gh, ga))
tab, pg = compare(res, te)
print(tab.set_index("méthode")[[c for c in tab.columns if c.endswith(" Δ") or c.endswith(" z")]].T.to_string())
print("\nλ moyens test : xgb", te.lam_h.mean().round(3), te.lam_a.mean().round(3), "| Bayes A", dh.mean().round(3), da.mean().round(3),
      "| obs", te.hr.mean().round(3), te.ar.mean().round(3))
print("corr(λ_xgb, λ_bayesA) dom/ext :", np.corrcoef(te.lam_h, dh.mean(1))[0,1].round(3), np.corrcoef(te.lam_a, da.mean(1))[0,1].round(3))
print("sd(log λh−log λa) : xgb", np.std(np.log(te.lam_h/te.lam_a)).round(4), " Bayes A", np.std(np.log(dh.mean(1)/da.mean(1))).round(4))
# Incertitude : l'écart-type a posteriori dit-il quelque chose ?
sd = np.log(dh / da).std(1)
q = pd.qcut(sd, 4, labels=["Q1 faible", "Q2", "Q3", "Q4 forte"])
d = pd.DataFrame({"q": q, "ll_bayes": pg["Bayes A prédictive+τ"]["moneyline"], "ll_xgb": pg["Poisson+τ"]["moneyline"],
                  "sd": sd})
print("\nÉcart-type a posteriori de log(λh/λa) par quartile → log-loss moneyline")
print(d.groupby("q", observed=True).agg(n=("sd", "size"), sd=("sd", "mean"), ll_bayes=("ll_bayes", "mean"), ll_xgb=("ll_xgb", "mean")).round(4).to_string())
np.save("res_s4.npy", {k: v.astype(np.float32) for k, v in res.items() if k != "Poisson+τ"}, allow_pickle=True)
