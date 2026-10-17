"""
retrain.py — chantier 2 de « ICEEDGE — Des prédictions joueurs plus justes » :
réentraîner le modèle joueur sur les saisons récentes, contre le modèle figé.

    python explore_players/retrain.py          # écrit ../models/player_retrain_report.json

Le modèle servi (A) est entraîné jusqu'en 2021-22, arrêté sur 2022-23, et
n'a jamais vu le jeu de 2023 → 2026 (moins de tirs, plus de tirs bloqués).
Validation « marchante » : pour chaque saison de test S ∈ {2023-24, 2024-25,
2025-26}, on rejoue la politique « réentraîner chaque été » avec ce qu'on
savait avant S :

  1. entraîner sur 2010 → S−2, arrêt précoce sur S−1 → nombre d'arbres R, k ;
  2. réentraîner sur 2010 → S−1 avec R arbres ;
  3. prédire S.

Variantes (mêmes features et paramètres que la stat servie) :
  A  modèle servi, figé (models/player/<stat>.json)
  B  réentraîné chaque été, toutes les saisons pèsent pareil
  C  B avec un poids qui décroît avec l'âge de la saison (demi-vie 3 saisons)
  D  C + le facteur d'aréna (mises en échec, tirs bloqués, tirs seulement)

Règle (posée avant le run, 2026-10-15). Δ = log-vraisemblance binomiale
négative par joueur-match, regroupée sur les trois saisons de test :
  • B remplace A si Δ(B − A) > 0, z ≥ 2, et Δ > 0 dans au moins 2 saisons sur 3 ;
  • C remplace le retenu (A ou B) s'il le bat selon la même règle ;
  • D (aréna) n'est retenu que s'il bat C ET le retenu selon la même règle.
Information seulement : le même écart après le recalage de niveau dans la
saison (points, mises en échec, tirs bloqués — ceux où il est servi), appliqué
aux deux modèles.
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
from arena import frame as arena_frame       # noqa: E402
from score_model import level_k              # noqa: E402

MODELS = TP.MODELS_DIR
OUT = os.path.join(HERE, "out")
TEST = (2023, 2024, 2025)
HALF_LIFE = 3.0
ARENA = {"hits": "arena_hits", "blocks": "arena_blocks", "shots": "arena_sog"}
BASE = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50, subsample=0.8,
            colsample_bytree=0.8, eval_metric="poisson-nloglik", max_delta_step=0.7,
            nthread=os.cpu_count() or 2, seed=7)


def zstat(d):
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def verdict(d, yrs):
    by = {int(s): float(d[yrs == s].mean()) for s in TEST}
    z = zstat(d)
    ok = bool(d.mean() > 0 and z >= 2 and sum(v > 0 for v in by.values()) >= 2)
    return {"dll": round(float(d.mean()), 6), "z": round(z, 2),
            "by_season": {k: round(v, 6) for k, v in by.items()}, "pass": ok}


def frame() -> pd.DataFrame:
    cache = os.path.join(OUT, "retrain_frame.pkl")
    if os.path.exists(cache):
        return pd.read_pickle(cache)
    df = arena_frame()
    df = df[df.season <= max(TEST)].reset_index(drop=True)
    df.to_pickle(cache)
    return df


def causal_k(D: pd.DataFrame, y: np.ndarray, mu: np.ndarray, n0: float) -> np.ndarray:
    """k de chaque ligne : Σ obs / Σ μ des jours précédents de la saison (level.py)."""
    k = np.ones(len(D))
    T = pd.DataFrame({"season": D.season.values, "date": D.date.values, "gameId": D.gameId.values,
                      "obs": y, "mu": mu})
    for _, g in T.groupby("season", sort=False):
        day = g.groupby("date").agg(obs=("obs", "sum"), mu=("mu", "sum"), n=("gameId", "nunique"))
        cum = day.cumsum().shift(1).fillna(0.0)
        kd = {d: (level_k(c.obs, c.mu, int(c.n), n0) if c.n > 0 else 1.0) for d, c in cum.iterrows()}
        k[g.index.values] = g.date.map(kd).values
    return k


def main():
    t0 = time.time()
    df = frame()
    print(f"⛸️  {len(df)} patineur-matchs 2010 → 2025-26 ({time.time()-t0:.0f}s)", flush=True)
    rep_p = json.load(open(os.path.join(MODELS, "player_report.json")))
    lvl = json.load(open(os.path.join(MODELS, "player_level_report.json")))["stats"]
    te_mask = df.season.isin(TEST).values
    TE = df[te_mask].reset_index(drop=True).sort_values(["date", "gameId"])
    TE = TE.reset_index(drop=True)
    yrs = TE.season.values

    def fit_fold(S, feats, y, mono, weighted):
        tr, va, full = df[df.season <= S - 2], df[df.season == S - 1], df[df.season <= S - 1]
        p = dict(BASE, monotone_constraints={f: 1 for f in mono if f in feats}) if mono else BASE

        def w(d, last):
            return 0.5 ** ((last - d.season.values) / HALF_LIFE) if weighted else None
        dtr = xgb.DMatrix(tr[feats], label=tr[y], weight=w(tr, S - 2), feature_names=feats)
        dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
        b0 = xgb.train(p, dtr, 2000, evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        R = b0.best_iteration + 1
        k = TP.fit_k(va[y].values, b0.predict(dva, iteration_range=(0, R)))
        dfull = xgb.DMatrix(full[feats], label=full[y], weight=w(full, S - 1), feature_names=feats)
        b1 = xgb.train(p, dfull, R, verbose_eval=False)
        ts = TE[TE.season == S]
        return ts.index.values, b1.predict(xgb.DMatrix(ts[feats], feature_names=feats)), k, R

    def variant(feats, y, mono, weighted):
        mu, ks, info = np.zeros(len(TE)), np.zeros(len(TE)), {}
        for S in TEST:
            idx, m, k, R = fit_fold(S, feats, y, mono, weighted)
            mu[idx], ks[idx] = m, k
            info[S] = {"rounds": R, "k": k}
        return mu, ks, info

    def ll(y, mu, ks):
        out = np.empty(len(y))
        for k in np.unique(ks):
            m = ks == k
            out[m] = TP.nb_ll(y[m], mu[m], k)
        return out

    out = {"generated": time.strftime("%Y-%m-%d"), "test_seasons": list(TEST), "half_life": HALF_LIFE,
           "rule": ("B remplace A si Δ > 0, z ≥ 2 et Δ > 0 dans ≥ 2 saisons sur 3 ; C remplace le retenu "
                    "selon la même règle ; D (aréna) seulement s'il bat C ET le retenu"),
           "stats": {}}
    for s in TP.STATS:
        y = f"y_{s}"
        yt = TE[y].values.astype(float)
        feats = rep_p["stats"][s]["features"]
        mono = [f"vs_lift_{x}" for x in TP.STATS]
        bA = xgb.Booster(); bA.load_model(os.path.join(MODELS, "player", f"{s}.json"))
        muA = bA.predict(xgb.DMatrix(TE[feats], feature_names=feats))
        kA = rep_p["stats"][s]["k"]
        llA = TP.nb_ll(yt, muA, kA)
        muB, kB, iB = variant(feats, y, mono, False)
        llB = ll(yt, muB, kB)
        print(f"   {s:9s} B fait ({time.time()-t0:.0f}s)", flush=True)
        muC, kC, iC = variant(feats, y, mono, True)
        llC = ll(yt, muC, kC)
        r = {"features": len(feats), "k_A": kA, "folds_B": iB, "folds_C": iC,
             "mean": {"obs": {int(S): round(float(yt[yrs == S].mean()), 4) for S in TEST},
                      "A": {int(S): round(float(muA[yrs == S].mean()), 4) for S in TEST},
                      "B": {int(S): round(float(muB[yrs == S].mean()), 4) for S in TEST},
                      "C": {int(S): round(float(muC[yrs == S].mean()), 4) for S in TEST}},
             "B_vs_A": verdict(llB - llA, yrs)}
        kAs = np.full(len(yt), float(kA))
        kept, llK, muK, kK = ("B", llB, muB, kB) if r["B_vs_A"]["pass"] else ("A", llA, muA, kAs)
        r["C_vs_" + kept] = verdict(llC - llK, yrs)
        if kept != "B":
            r["C_vs_B"] = verdict(llC - llB, yrs)
        if r["C_vs_" + kept]["pass"]:
            kept, llK, muK, kK = "C", llC, muC, kC
        r["C_vs_A"] = verdict(llC - llA, yrs)
        if s in ARENA:
            muD, kD, iD = variant(feats + [ARENA[s]], y, mono + [ARENA[s]], True)
            llD = ll(yt, muD, kD)
            r["folds_D"] = iD
            r["mean"]["D"] = {int(S): round(float(muD[yrs == S].mean()), 4) for S in TEST}
            r["D_vs_C"] = verdict(llD - llC, yrs)
            if kept != "C":
                r["D_vs_" + kept] = verdict(llD - llK, yrs)
            if r["D_vs_C"]["pass"] and (kept == "C" or r["D_vs_" + kept]["pass"]):
                kept, llK, muK, kK = "D", llD, muD, kD
        r["kept"] = kept
        # Information : l'écart après le recalage de niveau servi, appliqué aux deux.
        if lvl.get(s, {}).get("adopt") and kept != "A":
            n0 = lvl[s]["n0"]
            kAl, kKl = causal_k(TE, yt, muA, n0), causal_k(TE, yt, muK, n0)
            r["leveled_" + kept + "_vs_A"] = verdict(ll(yt, muK * kKl, kK) - TP.nb_ll(yt, muA * kAl, kA), yrs)
        out["stats"][s] = r
        print(f"   {s:9s} B−A {r['B_vs_A']['dll']:+.6f} (z {r['B_vs_A']['z']:+.1f}) {r['B_vs_A']['by_season']}  "
              f"C−A {r['C_vs_A']['dll']:+.6f} (z {r['C_vs_A']['z']:+.1f})"
              + (f"  D−C {r['D_vs_C']['dll']:+.6f} (z {r['D_vs_C']['z']:+.1f})" if "D_vs_C" in r else "")
              + f"  → {kept}   ({time.time()-t0:.0f}s)", flush=True)
        json.dump(out, open(os.path.join(MODELS, "player_retrain_report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_retrain_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
