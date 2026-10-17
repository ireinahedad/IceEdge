"""
penalties.py — les pénalités en NOMBRE de pénalités (mineures, doubles,
majeures) plutôt qu'en minutes.

    python explore_players/level_wf.py      # d'abord (μ hors échantillon du modèle servi)
    python explore_players/penalties.py     # écrit ../models/player_penalties_report.json

Le modèle servi prédit des MINUTES de pénalité avec une binomiale négative
(k 0,3). Or les minutes tombent par blocs : 2 (mineure), 4 (double mineure ou
deux mineures), 5 (majeure), 7 (5 + 2)… La loi en minutes met de la masse sur
1 et 3 minutes, impossibles, et sous-estime « 2 minutes ou plus » : 9 % prévu
pour 16,5 % observé en 2024-26 (dispersion.py).

Modèle composé :
  N  ~ BN(μ_N, k_N)    nombre de pénalités du joueur, XGBoost sur `penalties`,
                       mêmes features et même découpage que le modèle servi
                       (entraînement ≤ 2021-22, arrêt sur 2022-23)
  D  durée de chaque pénalité, tirée d'une loi {2, 4, 5, 10}
  PIM = D₁ + … + D_N

  A  loi des durées de la ligue (matchs à une pénalité, saisons d'entraînement)
  B  loi propre au joueur : sa part de pénalités « non mineures » (majeures,
     doubles), rétrécie vers la ligue (pseudo 20 pénalités), sur ses matchs
     PRÉCÉDENTS

Règle (posée avant le run, 2026-10-16). Référence S = le modèle servi (BN en
minutes). Δ = log-vraisemblance par joueur-match des minutes observées, test
2023-24 → 2025-26. A remplace S si Δ > 0, z ≥ 2 et Δ > 0 dans au moins 2
saisons sur 3. B remplace A par la même règle. Information : P(PIM ≥ 2) et
P(PIM ≥ 3), donc « plus de 0,5 / 1,5 » et « plus de 2,5 », prévu contre
observé, et leur Brier.
"""
from __future__ import annotations
import glob, json, os, sys, time, zipfile
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import nbinom

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
sys.path.insert(0, HERE)
import train_player as TP                    # noqa: E402
from retrain import BASE, TEST               # noqa: E402
import attempts as AT                        # noqa: E402

MODELS, DATA = TP.MODELS_DIR, TP.DATA_DIR
OUT = os.path.join(HERE, "out")
DUR = np.array([2, 4, 5, 10])
NMAX, PMAX = 8, 60
PSEUDO = 20.0


def zstat(d):
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def penalty_counts() -> pd.DataFrame:
    cols = ["playerId", "gameId", "gameDate", "situation", "position", "icetime", "penalties", "penalityMinutes"]
    frames = []
    for zp in sorted(glob.glob(os.path.join(DATA, "raw", "skaters*.zip"))):
        z = zipfile.ZipFile(zp)
        for name in z.namelist():
            with z.open(name) as f:
                for ch in pd.read_csv(f, usecols=cols, chunksize=500_000, low_memory=False):
                    frames.append(ch[(ch.situation == "all") & (ch.position != "G")])
    r = pd.concat(frames, ignore_index=True).drop_duplicates(["playerId", "gameId"], keep="last")
    r = r[r.icetime > 0].copy()
    r["date"] = pd.to_datetime(r.gameDate.astype(str), format="%Y%m%d")
    r = r.sort_values(["playerId", "date", "gameId"]).reset_index(drop=True)
    r["n_pen"] = r.penalties.fillna(0).clip(0, NMAX).astype(int)
    # Pénalités « non mineures » d'un match (double mineure +2, majeure +3,
    # inconduite +8 minutes au-delà de 2 par pénalité) : estimation du compte.
    extra = (r.penalityMinutes.fillna(0) - 2 * r.n_pen).clip(lower=0)
    r["n_big"] = np.minimum(r.n_pen, np.where(extra > 0, np.maximum(1, (extra / 3).round()), 0)).astype(int)
    g = r.groupby("playerId", sort=False)
    r["pen_prev"] = g.n_pen.transform(lambda s: s.shift(1).cumsum()).fillna(0)
    r["big_prev"] = g.n_big.transform(lambda s: s.shift(1).cumsum()).fillna(0)
    return r[["playerId", "gameId", "n_pen", "pen_prev", "big_prev"]]


def duration_mix(pim_one: np.ndarray) -> np.ndarray:
    """Loi de D sur DUR, depuis les minutes des matchs à UNE pénalité."""
    c = np.array([(pim_one == d).sum() for d in DUR], dtype=float)
    c[0] += ((pim_one != 2) & ~np.isin(pim_one, DUR)).sum()      # cas rares → mineure
    return c / c.sum()


def pim_pmf_table(mix: np.ndarray) -> np.ndarray:
    """T[n, m] = P(somme de n durées = m minutes), n ≤ NMAX, m ≤ PMAX."""
    one = np.zeros(PMAX + 1)
    one[DUR] = mix
    T = np.zeros((NMAX + 1, PMAX + 1))
    T[0, 0] = 1.0
    for n in range(1, NMAX + 1):
        T[n] = np.convolve(T[n - 1], one)[:PMAX + 1]
    return T


def main():
    t0 = time.time()
    df = AT.frame()
    pc = penalty_counts()
    n0 = len(df)
    df = df.merge(pc, on=["playerId", "gameId"], how="left")
    assert len(df) == n0
    df["n_pen"] = df.n_pen.fillna(0).astype(int)
    TE = df[df.season.isin(TEST)].sort_values(["date", "gameId"]).reset_index(drop=True)
    yrs = TE.season.values
    pim = TE.y_pim.values.astype(float)
    print(f"⛸️  {len(df)} patineur-matchs ({time.time()-t0:.0f}s)", flush=True)

    # ── Référence S : modèle servi (BN en minutes), μ hors échantillon ───────
    MU = pd.read_pickle(os.path.join(OUT, "level_wf_mu.pkl"))
    assert len(MU) == len(TE)
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    muS, kS = np.clip(MU["mu_pim"].values, 1e-6, None), rep["stats"]["pim"]["k"]
    llS = TP.nb_ll(pim, muS, kS)

    # ── N : nombre de pénalités, mêmes features / découpage que le servi ─────
    feats = rep["stats"]["pim"]["features"]
    mono = {f"vs_lift_{x}": 1 for x in TP.STATS if f"vs_lift_{x}" in feats}
    p = dict(BASE, monotone_constraints=mono) if mono else BASE
    tr, va = df[df.season <= 2021], df[df.season == 2022]
    dva = xgb.DMatrix(va[feats], label=va.n_pen, feature_names=feats)
    bst = xgb.train(p, xgb.DMatrix(tr[feats], label=tr.n_pen, feature_names=feats), 2000,
                    evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
    R = bst.best_iteration + 1
    kN = TP.fit_k(va.n_pen.values, bst.predict(dva, iteration_range=(0, R)))
    muN = np.clip(bst.predict(xgb.DMatrix(TE[feats], feature_names=feats), iteration_range=(0, R)), 1e-6, None)
    print(f"   N : {R} arbres, k {kN}, moyenne test {muN.mean():.4f} pour {TE.n_pen.mean():.4f} observé "
          f"({time.time()-t0:.0f}s)", flush=True)
    n_ax = np.arange(NMAX + 1)
    if kN >= 1e4:
        from scipy.stats import poisson
        PN = poisson.pmf(n_ax[None, :], muN[:, None])
    else:
        PN = nbinom.pmf(n_ax[None, :], kN, (kN / (kN + muN))[:, None])
    PN[:, -1] += 1 - PN.sum(1)                                   # queue → NMAX

    # ── A : loi des durées de la ligue ───────────────────────────────────────
    one = tr[tr.n_pen == 1].y_pim.values
    mixA = duration_mix(one)
    TA = pim_pmf_table(mixA)
    pim_i = np.clip(pim.round().astype(int), 0, PMAX)
    PA = PN @ TA                                                  # lignes × minutes
    llA = np.log(np.clip(PA[np.arange(len(pim_i)), pim_i], 1e-12, None))

    # ── B : part de pénalités « non mineures » propre au joueur ─────────────
    big_share = mixA[1:].sum()
    sh = ((TE.big_prev.fillna(0) + PSEUDO * big_share) / (TE.pen_prev.fillna(0) + PSEUDO)).values
    # Mélange du joueur : mêmes proportions relatives entre 4, 5 et 10 que la ligue.
    rel = mixA[1:] / mixA[1:].sum()
    llB = np.empty(len(TE))
    PB2 = np.empty(len(TE))
    PB3 = np.empty(len(TE))
    bins = np.quantile(sh, np.linspace(0, 1, 41))
    idx = np.clip(np.digitize(sh, bins[1:-1]), 0, 39)
    for b in range(40):
        m = idx == b
        if not m.any():
            continue
        s = float(sh[m].mean())
        T = pim_pmf_table(np.concatenate([[1 - s], s * rel]))
        P = PN[m] @ T
        llB[m] = np.log(np.clip(P[np.arange(m.sum()), pim_i[m]], 1e-12, None))
        PB2[m] = P[:, 2:].sum(1)
        PB3[m] = P[:, 3:].sum(1)

    def nb_sf(x):
        return nbinom.sf(x - 1, kS, kS / (kS + muS))

    def verdict(d):
        by = {int(s): float(d[yrs == s].mean()) for s in TEST}
        z = zstat(d)
        return {"dll": round(float(d.mean()), 6), "z": round(z, 2), "by_season": {k: round(v, 6) for k, v in by.items()},
                "pass": bool(d.mean() > 0 and z >= 2 and sum(v > 0 for v in by.values()) >= 2)}
    out = {"generated": time.strftime("%Y-%m-%d"), "durations": DUR.tolist(), "mix_league": [round(float(x), 4) for x in mixA],
           "k_N": kN, "rounds_N": R, "pseudo_player_mix": PSEUDO,
           "rule": "A remplace le servi si Δ log-vraisemblance (minutes) > 0, z ≥ 2, Δ > 0 dans ≥ 2 saisons sur 3 ; B remplace A par la même règle",
           "A_vs_served": verdict(llA - llS), "B_vs_A": verdict(llB - llA)}
    out["kept"] = ("B" if out["B_vs_A"]["pass"] else "A") if out["A_vs_served"]["pass"] else "served"
    cal = {}
    for th, lab in ((2, "over 0.5 / 1.5 (≥ 2 min)"), (3, "over 2.5 (≥ 3 min)"), (5, "over 4.5 (≥ 5 min)")):
        obs = (pim >= th).astype(float)
        pS = nb_sf(th)
        pA = PA[:, th:].sum(1)
        pB = PB2 if th == 2 else PB3 if th == 3 else None
        c = {"obs": round(float(obs.mean()), 4), "served": round(float(pS.mean()), 4), "A": round(float(pA.mean()), 4),
             "brier_served": round(float(((pS - obs) ** 2).mean()), 5), "brier_A": round(float(((pA - obs) ** 2).mean()), 5)}
        if pB is not None:
            c.update({"B": round(float(pB.mean()), 4), "brier_B": round(float(((pB - obs) ** 2).mean()), 5)})
        cal[lab] = c
    out["calibration_test"] = cal
    # Déciles de P(≥ 2) du modèle retenu contre l'observé.
    pk = PA[:, 2:].sum(1) if out["kept"] != "B" else PB2
    q = pd.qcut(pk, 10, labels=False, duplicates="drop")
    out["deciles_ge2"] = [{"pred": round(float(pk[q == i].mean()), 4), "obs": round(float((pim[q == i] >= 2).mean()), 4),
                           "served": round(float(nb_sf(2)[q == i].mean()), 4)} for i in range(int(q.max()) + 1)]
    json.dump(out, open(os.path.join(MODELS, "player_penalties_report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"   ligue : durées {dict(zip(DUR.tolist(), out['mix_league']))}")
    print(f"   A vs servi : {out['A_vs_served']}")
    print(f"   B vs A     : {out['B_vs_A']}")
    for k, v in cal.items():
        print(f"   {k:28s} {v}")
    print(f"   → {out['kept']}")
    print(f"✅ models/player_penalties_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
