"""
dispersion.py — la dispersion k (binomiale négative) du modèle joueur, par
poste ou par profil, au lieu d'un k unique par statistique.

    python explore_players/level_wf.py      # d'abord (prédictions hors échantillon en cache)
    python explore_players/attempts.py      # (variables de tentatives, recalculées ici)
    python explore_players/dispersion.py    # écrit ../models/player_dispersion_report.json

La moyenne μ décide de « combien en moyenne » ; k décide de la largeur de la
loi autour, donc des seuils 2+ et 3+ (et 0). Aujourd'hui un k par stat (tirs
20, mises en échec et tirs bloqués 8-12, pénalités 0,3, Poisson pour buts,
passes, points, points en AN). Un attaquant et un défenseur, ou un gros et un
petit tireur, peuvent avoir des formes différentes.

Variantes (μ inchangés : prédictions hors échantillon du modèle SERVI, chaque
saison prédite avec ce qu'on savait avant elle) :
  U  un k par stat (référence, choisi sur 2023-24)
  P  un k par poste (attaquant / défenseur)
  M  un k par tiers de μ (petits, moyens, gros producteurs ; seuils fixés sur 2023-24)

Règle (posée avant le run, 2026-10-16) : chaque k est choisi sur 2023-24 ; une
variante remplace U si Δ log-vraisemblance > 0 sur 2024-25 → 2025-26
regroupées, z ≥ 2, et Δ > 0 dans chacune des deux saisons. Si P et M passent
tous deux, on garde celle au plus grand Δ. Information : calibration de
P(X ≥ 2) et P(X ≥ 3), prévu contre observé.
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
from retrain import BASE, TEST               # noqa: E402
import attempts as AT                        # noqa: E402

MODELS = TP.MODELS_DIR
OUT = os.path.join(HERE, "out")
GRID = [0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40, 60, 100, 1e5]
VAL, TST = 2023, (2024, 2025)


def zstat(d):
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def best_k(y, mu):
    return max(GRID, key=lambda k: TP.nb_ll(y, mu, k).mean())


def p_ge(n, mu, k):
    """P(X ≥ n) — binomiale négative (Poisson si k très grand)."""
    from scipy.stats import nbinom, poisson
    if k >= 1e4:
        return poisson.sf(n - 1, mu)
    return nbinom.sf(n - 1, k, k / (k + mu))


def main():
    t0 = time.time()
    df = AT.frame()
    TE = df[df.season.isin(TEST)].sort_values(["date", "gameId"]).reset_index(drop=True)
    yrs = TE.season.values
    MU = pd.read_pickle(os.path.join(OUT, "level_wf_mu.pkl"))
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    # Le cache est aligné sur le même tri (date, gameId) du même cadre de test.
    assert len(MU) == len(TE)
    # Tirs et tirs bloqués ont changé depuis le cache (tentatives) : on refait leurs μ.
    for s in AT.NEW:
        feats = rep["stats"][s]["features"]
        y = f"y_{s}"
        mono = {f"vs_lift_{x}": 1 for x in TP.STATS if f"vs_lift_{x}" in feats}
        p = dict(BASE, monotone_constraints=mono) if mono else BASE
        mu = np.zeros(len(TE))
        for S in TEST:
            tr, va, full = df[df.season <= S - 2], df[df.season == S - 1], df[df.season <= S - 1]
            dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
            b0 = xgb.train(p, xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats), 2000,
                           evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
            R = b0.best_iteration + 1
            b1 = xgb.train(p, xgb.DMatrix(full[feats], label=full[y], feature_names=feats), R, verbose_eval=False)
            rows = TE.index.values[yrs == S]
            mu[rows] = b1.predict(xgb.DMatrix(TE.loc[rows, feats], feature_names=feats))
        MU[f"mu_{s}"] = mu
        print(f"   {s:7s} μ recalculés avec les tentatives ({time.time()-t0:.0f}s)", flush=True)

    isD = (TE.pos == "D").values
    val, tst = yrs == VAL, np.isin(yrs, TST)
    out = {"generated": time.strftime("%Y-%m-%d"), "grid": GRID,
           "rule": "k choisis sur 2023-24 ; variante adoptée si Δ > 0 sur 2024-26, z ≥ 2, Δ > 0 en 2024-25 ET 2025-26",
           "stats": {}}
    for s in TP.STATS:
        y = TE[f"y_{s}"].values.astype(float)
        mu = np.clip(MU[f"mu_{s}"].values, 1e-6, None)
        kU = best_k(y[val], mu[val])
        llU = TP.nb_ll(y, mu, kU)
        # P : par poste
        kF, kD = best_k(y[val & ~isD], mu[val & ~isD]), best_k(y[val & isD], mu[val & isD])
        kP = np.where(isD, kD, kF)
        # M : par tiers de μ (seuils fixés sur 2023-24)
        q1, q2 = np.quantile(mu[val], [1 / 3, 2 / 3])
        tier = np.digitize(mu, [q1, q2])
        kT = [best_k(y[val & (tier == t)], mu[val & (tier == t)]) for t in range(3)]
        kM = np.array(kT, dtype=float)[tier]

        def ll_arr(karr):
            o = np.empty(len(y))
            for k in np.unique(karr):
                m = karr == k
                o[m] = TP.nb_ll(y[m], mu[m], k)
            return o
        r = {"k_U": kU, "k_P": {"F": kF, "D": kD}, "k_M": {"tiers_mu": [round(float(q1), 4), round(float(q2), 4)],
                                                            "k": kT}}
        for name, karr in (("P", kP), ("M", kM)):
            d = ll_arr(karr) - llU
            by = {int(se): float(d[yrs == se].mean()) for se in TST}
            dt = d[tst]
            r[name] = {"dll": round(float(dt.mean()), 7), "z": round(zstat(dt), 2) if dt.std() > 0 else 0.0,
                       "by_season": {k: round(v, 7) for k, v in by.items()},
                       "pass": bool(dt.mean() > 0 and dt.std() > 0 and zstat(dt) >= 2 and all(v > 0 for v in by.values()))}
        passed = [n for n in ("P", "M") if r[n]["pass"]]
        r["kept"] = max(passed, key=lambda n: r[n]["dll"]) if passed else "U"
        # Calibration des seuils sur 2024-26 : référence et variante retenue.
        karr = {"U": np.full(len(y), kU), "P": kP, "M": kM}[r["kept"]]
        cal = {}
        for n in (2, 3):
            pu = np.array([p_ge(n, m, kU) for m in [mu[tst]]][0])
            pk = np.concatenate([p_ge(n, mu[tst & (karr == k)], k) for k in np.unique(karr[tst])])
            ok = np.concatenate([(y[tst & (karr == k)] >= n) for k in np.unique(karr[tst])])
            cal[f"{n}+"] = {"obs": round(float((y[tst] >= n).mean()), 4), "U": round(float(pu.mean()), 4),
                            r["kept"]: round(float(pk.mean()), 4), "obs_check": round(float(ok.mean()), 4)}
        r["calibration_2024_26"] = cal
        out["stats"][s] = r
        print(f"   {s:9s} k={kU}  P(F {kF}, D {kD}) Δ {r['P']['dll']:+.6f} (z {r['P']['z']:+.1f})  "
              f"M({kT}) Δ {r['M']['dll']:+.6f} (z {r['M']['z']:+.1f}) → {r['kept']}   "
              f"2+ obs {cal['2+']['obs']} U {cal['2+']['U']}  3+ obs {cal['3+']['obs']} U {cal['3+']['U']}", flush=True)
    json.dump(out, open(os.path.join(MODELS, "player_dispersion_report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_dispersion_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
