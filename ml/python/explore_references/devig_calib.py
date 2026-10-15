"""Dévigage (proportionnel, Shin, puissance) et calibration de la chaîne servie.

1. Marché : log-loss de la cote de clôture selon la méthode de dévigage,
   par source, matchs 2012-2025 du walk-forward.
2. Chaîne servie (score + couche C) : variantes de calibration walk-forward
   — Cbeta (calibration bêta intégrée à la couche), C + isotonique.
À lancer depuis ml/python : python explore_references/<script>.py, après run_variants.py (variante ref).
"""
import json
import os
import sys

import numpy as np
from scipy.optimize import brentq

sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402
import backtest_walkforward as W  # noqa: E402


def shin_two(oh, oa):
    """Probabilité domicile selon Shin (1993), deux issues, cotes décimales."""
    pi = np.array([1 / oh, 1 / oa])
    B = pi.sum()
    if not np.isfinite(B) or B <= 1:
        return pi[0] / B

    def f(z):
        p = (np.sqrt(z * z + 4 * (1 - z) * pi * pi / B) - z) / (2 * (1 - z))
        return p.sum() - 1
    z = brentq(f, 0.0, 0.4)
    p = (np.sqrt(z * z + 4 * (1 - z) * pi * pi / B) - z) / (2 * (1 - z))
    return p[0]


def power_two(oh, oa):
    """Méthode de la puissance : p_i = pi_i^k, k tel que la somme vaut 1."""
    pi = np.array([1 / oh, 1 / oa])
    if pi.sum() <= 1:
        return pi[0] / pi.sum()
    k = brentq(lambda k: (pi ** k).sum() - 1, 1.0, 5.0)
    return pi[0] ** k


ref = A.load("ref")
seas = sorted(ref)
rows = []
for s in seas:
    m = ref[s]["meta"]
    for stage in ("close",):
        oh, oa = m[f"home_ml_{stage}"].to_numpy(float), m[f"away_ml_{stage}"].to_numpy(float)
        ok = np.isfinite(oh) & np.isfinite(oa) & (oh > 1) & (oa > 1)
        for i in np.where(ok)[0]:
            rows.append((s, str(m["source"].iloc[i]), m["home_win"].iloc[i],
                         (1 / oh[i]) / (1 / oh[i] + 1 / oa[i]),
                         shin_two(oh[i], oa[i]), power_two(oh[i], oa[i]),
                         1 / oh[i] + 1 / oa[i] - 1))
R = np.array([(r[0], r[2], r[3], r[4], r[5], r[6]) for r in rows], float)
src = np.array([r[1] if r[1] != "nan" else "sbro" for r in rows])
S, y, pprop, pshin, ppow, margin = R.T
out = {"market": {}}
print("== Marché à la clôture : log-loss selon le dévigage (NÉGATIF = mieux que proportionnel)")
for name in ["tout"] + sorted(set(src)):
    msk = np.ones(len(y), bool) if name == "tout" else src == name
    base = A.ll(y[msk], pprop[msk])
    res = {"n": int(msk.sum()), "ll_prop": round(float(base.mean()), 5),
           "marge_moy": round(float(margin[msk].mean()), 4)}
    for lab, p in (("shin", pshin), ("power", ppow)):
        d = A.ll(y[msk], p[msk]) - base
        by = {int(s): float(d[S[msk] == s].mean()) for s in np.unique(S[msk])}
        res[lab] = {**W._paired(d), "ll": round(float(A.ll(y[msk], p[msk]).mean()), 5),
                    "seasons_better": f"{sum(v < 0 for v in by.values())}/{len(by)}"}
    out["market"][name] = res
    print(f"   {name:>20} n={res['n']:>6} prop {res['ll_prop']:.5f} | shin {res['shin']['delta']:+.6f} "
          f"(z {res['shin']['z']:+.2f}, {res['shin']['seasons_better']}) | puissance "
          f"{res['power']['delta']:+.6f} (z {res['power']['z']:+.2f}, {res['power']['seasons_better']})")

# Biais favori-outsider : fréquence observée vs proba proportionnelle, par classe
print("\n== Calibration du marché (proportionnel), par classe de probabilité du favori domicile/extérieur")
fav = np.maximum(pprop, 1 - pprop)
yfav = np.where(pprop >= 0.5, y, 1 - y)
pshin_fav = np.where(pprop >= 0.5, pshin, 1 - pshin)
out["flb"] = []
for lo, hi in [(0.5, 0.55), (0.55, 0.6), (0.6, 0.65), (0.65, 0.7), (0.7, 0.8)]:
    m = (fav >= lo) & (fav < hi)
    row = {"classe": f"{lo:.2f}-{hi:.2f}", "n": int(m.sum()),
           "p_prop": round(float(fav[m].mean()), 4), "p_shin": round(float(pshin_fav[m].mean()), 4),
           "observe": round(float(yfav[m].mean()), 4)}
    out["flb"].append(row)
    print("   ", row)

# ── 2. Calibration de la chaîne servie ───────────────────────────────────────
print("\n== Chaîne servie : couche C contre variantes de calibration")
C = A.correction_preds(ref, mode="C")
CB = A.correction_preds(ref, mode="Cbeta")
from sklearn.isotonic import IsotonicRegression  # noqa: E402
ks = sorted(C)
ISO = {}
for i, s in enumerate(ks):
    past = ks[:i]
    if len(past) < 3:
        continue
    iso = IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4)
    iso.fit(np.concatenate([C[x] for x in past]),
            np.concatenate([ref[x]["meta"]["home_win"].to_numpy(float) for x in past]))
    ISO[s] = iso.predict(C[s])
yv = {s: ref[s]["meta"]["home_win"].to_numpy(float) for s in ks}
out["calibration"] = {
    "Cbeta_vs_C": A.verdict_block({s: A.ll(yv[s], CB[s]) - A.ll(yv[s], C[s]) for s in C}),
    "iso_vs_C": A.verdict_block({s: A.ll(yv[s], ISO[s]) - A.ll(yv[s], C[s]) for s in ISO}),
}
for k, v in out["calibration"].items():
    print(f"   {k:>12}: delta {v['delta']:+.5f}  z {v['z']:+.2f}  saisons {v['seasons_better']} -> {v['verdict']}")


def reliab(p, yy):
    res = []
    for lo in np.arange(0.2, 0.9, 0.1):
        m = (p >= lo) & (p < lo + 0.1)
        if m.sum() >= 15:
            res.append((f"{lo:.1f}-{lo + 0.1:.1f}", int(m.sum()), round(float(p[m].mean()), 3),
                        round(float(yy[m].mean()), 3)))
    return res


yall = np.concatenate([yv[s] for s in C])
for lab, D in (("C", C), ("Cbeta", CB)):
    pa = np.concatenate([D[s] for s in C])
    out[f"reliab_{lab}"] = reliab(pa, yall)
    print(f"\n   fiabilité {lab} (classe, n, prédit, observé) :")
    for r in out[f"reliab_{lab}"]:
        print("     ", r)
json.dump(out, open("explore_references/out/devig_calib.json", "w"), indent=2, default=str)
