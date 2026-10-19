"""
live_dispersion.py
==================
Pourquoi les buts réglementaires sont-ils MOINS dispersés autour de λ qu'une
Poisson (`ml/EXPLICATION_ML.md` §10.4) ?

Statistique : Var(G − μ) / E[μ], μ = λ d'avant-match ramené au total observé
(1 = Poisson exacte ; > 1 = sur-dispersion, par exemple une force cachée ;
< 1 = sous-dispersion). Matchs d'entraînement 2012-2022.

  1. Par période, comparée à une simulation SANS force cachée (table m servie,
     pas de 10 s, 4 copies × 3 graines) : l'écart observé − simulé est ce que
     la table m n'explique pas.
  2. Par situation du but (feuille MoneyPuck) : égalité numérique (EV),
     avantage (PP), infériorité (SH), filet désert (EN), avec la corrélation
     entre les buts des deux équipes.

Sortie : ml/models/live/live_dispersion_report.json
Usage  : cd ml/python && python live_dispersion.py
"""

import json

import numpy as np
import pandas as pd

import calibrate_live as C

DATA = "../data"
PARTS = [("1re période", 0, 1200, 0.305), ("2e période", 1200, 2400, 0.365),
         ("3e, 40-57'", 2400, 3420, 0.33 * 17 / 20), ("3e, 57-60'", 3420, 3600, 0.33 * 3 / 20)]


def ratio(G, mu):
    mu = mu * G.sum() / mu.sum()
    return float(np.mean((G - mu) ** 2) / np.mean(mu))


def by_part(cnt, lh, la):
    mu = np.r_[lh, la]
    out = {lab: ratio(np.r_[cnt[:, 0, k], cnt[:, 1, k]], mu * sh) for k, (lab, *_r, sh) in enumerate(PARTS)}
    out["60 min, par équipe"] = ratio(np.r_[cnt.sum(2)[:, 0], cnt.sum(2)[:, 1]], mu)
    out["60 min, total du match"] = ratio(cnt.sum((1, 2)), lh + la)
    return out


def part_of(t):
    for k, (_, a, b, _s) in enumerate(PARTS):
        if a <= t < b:
            return k
    return len(PARTS) - 1


def simulate(M, LH, LA, seed, reps=4):
    rng = np.random.default_rng(seed)
    lh, la = np.tile(LH, reps), np.tile(LA, reps)
    n = len(lh)
    h, a = np.zeros(n, int), np.zeros(n, int)
    cnt = np.zeros((n, 2, len(PARTS)))
    for t in range(0, 3600, 10):
        s, w, k = C.slice_of(t), C.PERIOD_DIST[t // 1200] * 10 / 1200, part_of(t)
        ch = np.clip(h - a, -3, 3) + 3
        gh, ga = rng.poisson(lh * w * M[s, ch]), rng.poisson(la * w * M[s, 6 - ch])
        cnt[:, 0, k] += gh; cnt[:, 1, k] += ga
        h += gh; a += ga
    return by_part(cnt, lh, la)


def main():
    fx = json.load(open(C.OUT_JSON, encoding="utf-8"))
    first, last = fx["trainSeasons"]
    g = pd.read_csv(f"{DATA}/live_games.csv")
    pre = pd.read_csv(f"{DATA}/live_pregame.csv")
    goals = pd.read_csv(f"{DATA}/live_goals.csv")
    g = g.merge(pre[["game_id", "lam_home", "lam_away"]], on="game_id")
    g = g[g["season"].between(first, last)].reset_index(drop=True)
    goals = goals[goals["game_id"].isin(set(g["game_id"]))].copy()
    gi = {gid: i for i, gid in enumerate(g["game_id"])}
    LH, LA = g["lam_home"].values, g["lam_away"].values

    cnt = np.zeros((len(g), 2, len(PARTS)))
    for gid, t, hs in zip(goals["game_id"], goals["time"], goals["home_scored"]):
        cnt[gi[gid], 0 if hs else 1, part_of(t)] += 1
    obs = by_part(cnt, LH, LA)
    sims = [simulate(np.array(fx["m"]), LH, LA, sd) for sd in (11, 12, 13)]
    periods = {k: {"observed": round(obs[k], 4), "simulated_no_hidden_strength": round(float(np.mean([s[k] for s in sims])), 4)}
               for k in obs}

    own = np.where(goals["home_scored"] == 1, goals["home_skaters"], goals["away_skaters"])
    opp = np.where(goals["home_scored"] == 1, goals["away_skaters"], goals["home_skaters"])
    goals["cat"] = np.where(goals["empty_net"] == 1, "EN", np.where(own > opp, "PP", np.where(own < opp, "SH", "EV")))
    mu = np.r_[LH, LA]
    strength = {}
    for c in ["EV", "PP", "SH", "EN"]:
        sub = goals[goals["cat"] == c]
        H, A = np.zeros(len(g)), np.zeros(len(g))
        for gid, hs in zip(sub["game_id"], sub["home_scored"]):
            (H if hs else A)[gi[gid]] += 1
        rh = H - LH * H.sum() / LH.sum()
        ra = A - LA * A.sum() / LA.sum()
        strength[c] = {"share": round(len(sub) / len(goals), 3), "ratio": round(ratio(np.r_[H, A], mu), 4),
                       "corr_home_away": round(float(np.corrcoef(rh, ra)[0, 1]), 4)}

    out = {"generatedAt": pd.Timestamp.today().date().isoformat(), "games": len(g),
           "trainSeasons": [first, last], "by_period": periods, "by_strength": strength}
    with open("../models/live/live_dispersion_report.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
