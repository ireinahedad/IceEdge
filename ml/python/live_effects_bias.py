"""
live_effects_bias.py
====================
Taille du biais connu de `calibrate_live.py` (`ml/EXPLICATION_ML.md` §10.4).

Le biais : une équipe plus forte que son λ d'avant-match mène plus souvent ;
mesurés avec ce λ, m(mène) est gonflé et m(menée) dégonflé. Le corriger « à la
main » avec un λ mis à jour en cours de match ne marche pas : les buts déjà
marqués mélangent la force réelle ET les effets de score qu'on cherche.

On le mesure donc par SIMULATION, où la vérité est connue :
  1. on rejoue les matchs d'entraînement (mêmes λ d'avant-match, R copies) avec
     la table servie comme VRAIE table m, pas de 10 s comme le moteur ;
  2. chaque équipe reçoit une force cachée u ~ Gamma(moyenne 1, écart type σ) :
     sa vraie cadence est λ × u, mais l'estimateur ne voit que λ ;
  3. on ré-estime m exactement comme `calibrate_live.py` (exposition, a = 2)
     et on compare à l'estimation obtenue sans force cachée (σ = 0).
σ = 0 vérifie aussi l'estimateur : il doit retrouver la table d'entrée.

Quel σ est plausible ? La dispersion des buts réglementaires autour de λ
(statistique (E[(G − μ)²] − E[μ]) / E[μ²], qui estime σ² pour des Poisson)
est calculée sur les VRAIS matchs et sur chaque simulation.

Une simulation (σ, graine) dure ~1 min ; elles sont mises en cache dans
ml/data/live_bias_sim/ (relancer reprend où on s'est arrêté).

Sortie : ml/models/live/live_effects_bias.json

Usage :
    cd ml/python
    python live_effects_bias.py                      # σ = 0, 0.15, 0.30 × 3 graines
    python live_effects_bias.py --sigma 0.15 --seed 11   # une seule simulation (cache)
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

import calibrate_live as C

DATA = "../data"
CACHE = "../data/live_bias_sim"
REPORT = "../models/live/live_effects_bias.json"
SIGMAS = [0.0, 0.15, 0.30]
SEEDS = [11, 12, 13]
REPS = 4
STEP = 10
KEY = {"mène de 1, 59-60'": (7, 4), "menée de 1, 59-60'": (7, 2), "égalité, 59-60'": (7, 3),
       "mène de 2, 58-59'": (6, 5), "menée de 1, 58-59'": (6, 2), "mène de 1, 1re": (0, 4),
       "menée de 1, 1re": (0, 2)}


def dispersion(G: np.ndarray, mu: np.ndarray) -> float:
    mu = mu * G.sum() / mu.sum()
    return float((np.mean((G - mu) ** 2) - np.mean(mu)) / np.mean(mu ** 2))


def load_train():
    fx = json.load(open(C.OUT_JSON, encoding="utf-8"))
    first, last = fx["trainSeasons"]
    g = pd.read_csv(f"{DATA}/live_games.csv")
    p = pd.read_csv(f"{DATA}/live_pregame.csv")
    g = g.merge(p[["game_id", "lam_home", "lam_away"]], on="game_id")
    return fx, g[g["season"].between(first, last)].reset_index(drop=True)


def simulate(M: np.ndarray, lam_h: np.ndarray, lam_a: np.ndarray, sigma: float, seed: int,
             shrink: float) -> tuple[np.ndarray, float]:
    rng = np.random.default_rng(seed)
    LH, LA = np.tile(lam_h, REPS), np.tile(lam_a, REPS)
    n = len(LH)
    if sigma > 0:
        uh, ua = rng.gamma(1 / sigma ** 2, sigma ** 2, n), rng.gamma(1 / sigma ** 2, sigma ** 2, n)
    else:
        uh = ua = np.ones(n)
    h, a = np.zeros(n, int), np.zeros(n, int)
    O, E = np.zeros(M.shape), np.zeros(M.shape)
    for t in range(0, 3600, STEP):
        s = C.slice_of(t)
        w = C.PERIOD_DIST[t // 1200] * STEP / 1200
        ch = np.clip(h - a, -3, 3) + 3
        ca = 6 - ch
        gh = rng.poisson(LH * uh * w * M[s, ch])
        ga = rng.poisson(LA * ua * w * M[s, ca])
        np.add.at(E[s], ch, LH * w); np.add.at(E[s], ca, LA * w)
        np.add.at(O[s], ch, gh); np.add.at(O[s], ca, ga)
        h += gh; a += ga
    return C.shrunk(O, E, shrink), dispersion(np.r_[h, a], np.r_[LH, LA])


def run_one(fx, g, sigma, seed):
    os.makedirs(CACHE, exist_ok=True)
    path = f"{CACHE}/sim_{sigma:.2f}_{seed}.npz"
    if os.path.exists(path):
        z = np.load(path)
        return z["m"], float(z["disp"])
    m, disp = simulate(C.single_table(), g["lam_home"].values, g["lam_away"].values,
                       sigma, seed, fx["shrink"])
    np.savez(path, m=m, disp=disp)
    print(f"   σ {sigma:.2f} graine {seed} : dispersion {disp:+.4f}", flush=True)
    return m, disp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sigma", type=float)
    ap.add_argument("--seed", type=int)
    args = ap.parse_args()
    fx, g = load_train()
    if args.sigma is not None:
        run_one(fx, g, args.sigma, args.seed if args.seed is not None else SEEDS[0])
        return

    M = C.single_table()
    O = np.array(json.load(open(C.REPORT, encoding="utf-8"))["observed"])
    obs_disp = dispersion(np.r_[g["home_reg_score"].values, g["away_reg_score"].values],
                          np.r_[g["lam_home"].values, g["lam_away"].values])
    res = {}
    for sg in SIGMAS:
        runs = [run_one(fx, g, sg, sd) for sd in SEEDS]
        res[sg] = (np.mean([r[0] for r in runs], 0), [round(r[1], 4) for r in runs])
    m0 = res[0.0][0]
    big = O >= 1000
    lead = [(i, j) for i in range(M.shape[0]) for j in (4, 5)]
    trail = [(i, j) for i in range(M.shape[0]) for j in (1, 2)]
    wavg = lambda cells, mm: float(np.average([mm[c] / m0[c] for c in cells], weights=[O[c] for c in cells]))
    out = {
        "generatedAt": pd.Timestamp.today().date().isoformat(),
        "games": len(g), "reps": REPS, "seeds": SEEDS, "step_sec": STEP,
        "observed_dispersion": round(obs_disp, 4),
        "simulated_dispersion": {f"{s:.2f}": res[s][1] for s in SIGMAS},
        "estimator_check": {
            "max_rel_err_cells_1000_goals": round(float(np.abs(m0 / M - 1)[big].max()), 4),
            "median_rel_err_cells_1000_goals": round(float(np.median(np.abs(m0 / M - 1)[big])), 4),
        },
        "bias_ratio": {f"{s:.2f}": {k: round(float(res[s][0][c] / m0[c]), 3) for k, c in KEY.items()}
                       for s in SIGMAS if s > 0},
        "bias_ratio_weighted": {f"{s:.2f}": {"mène (+1, +2)": round(wavg(lead, res[s][0]), 3),
                                             "menée (−1, −2)": round(wavg(trail, res[s][0]), 3)}
                                for s in SIGMAS if s > 0},
    }
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
