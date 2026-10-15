"""Étape 3 — le moteur dynamique doit-il remplacer τ pour le MATCH ENTIER ?

Walk-forward 2013-2025 (13 saisons). Pour chaque saison S, τ et c sont ajustés
sur S-3..S-1 seulement ; λ hors échantillon (OOF pour les saisons
d'entraînement, modèle servi ensuite). Les deux concurrents :
  A. Poisson × τ glissant            (ce que sert l'étape 1)
  B. moteur dynamique, c glissant     (`game_dynamics.regulation_matrix`)

CRITÈRE, FIXÉ AVANT LE RUN — B remplace A seulement si les trois tiennent :
  1. score exact : Δ moyen < 0 avec z ≤ −2 ;
  2. au moins 9 saisons sur 13 améliorées sur le score exact ;
  3. aucun marché servi dégradé : moneyline, PL −1,5, nul 60', plus de 5,5,
     plus de 6,5 — tous avec z < +2.
Sinon on garde A (plus simple, déjà mesuré).
"""
import math, sys
import numpy as np, pandas as pd
from harness import *
sys.path.insert(0, str(HERE.parent))
import game_dynamics as GD
import s2_periode_filet_desert as S2

assert tuple(S2.EDGES) == GD.EDGES
X = S2.X
G = S2.G
seasons = list(range(2013, 2026))
res_A, res_B, Xs = [], [], []
for S in seasons:
    d = X[X.season == S].reset_index(drop=True)
    w = X[(X.season >= S - 3) & (X.season < S)]
    Mw = indep(w.lam_h.values, w.lam_a.values); m = (w.hr - w.ar).values
    tau = {k: float(np.clip((m == k).mean() / Mw[:, MARG == k].sum(1).mean(), .25, 4)) for k in range(-6, 7)}
    c = GD.fit_cells(w[w.ok_lg], G)[0]
    res_A.append(apply_tau(indep(d.lam_h.values, d.lam_a.values), tau))
    res_B.append(np.stack([GD.regulation_matrix(h, a, c) for h, a in zip(d.lam_h.values, d.lam_a.values)]))
    Xs.append(d)
XA = pd.concat(Xs, ignore_index=True)
MA, MB = np.concatenate(res_A), np.concatenate(res_B)
pgA, pgB = per_game(MA, XA), per_game(MB, XA)
rows = []
for k in pgA:
    dlt = pgB[k] - pgA[k]
    z = dlt.mean() / (dlt.std(ddof=1) / math.sqrt(len(dlt)))
    by = pd.Series(dlt).groupby(XA.season.values).mean()
    rows.append({"métrique": k, "A τ glissant": pgA[k].mean().round(5), "B dynamique": pgB[k].mean().round(5),
                 "Δ (B−A)": dlt.mean().round(5), "z": round(z, 2), "saisons B mieux": f"{(by < 0).sum()}/{len(by)}"})
T = pd.DataFrame(rows)
print(f"Walk-forward {seasons[0]}-{seasons[-1]}, {len(XA)} matchs")
print(T.to_string(index=False))
r = T.set_index("métrique")
c1 = r.loc["score_exact", "Δ (B−A)"] < 0 and r.loc["score_exact", "z"] <= -2
c2 = int(r.loc["score_exact", "saisons B mieux"].split("/")[0]) >= 9
c3 = all(r.loc[k, "z"] < 2 for k in ("moneyline", "PL_dom_-1.5", "nul_60", "over_5.5", "over_6.5"))
print(f"\nCritère : 1 {'OK' if c1 else 'NON'} · 2 {'OK' if c2 else 'NON'} · 3 {'OK' if c3 else 'NON'} → "
      + ("ADOPTER B pour le match entier" if (c1 and c2 and c3) else "GARDER A (τ glissant)"))
print("\nScore exact par saison (Δ B−A) :", pd.Series(pgB["score_exact"] - pgA["score_exact"]).groupby(XA.season.values).mean().round(4).to_dict())
