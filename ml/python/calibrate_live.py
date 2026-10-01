"""
calibrate_live.py
=================
Effets de score MESURÉS pour les prédictions en direct
(`LIVE_PREDICTIONS_PLAN.md`, étape 6).

── Ce qui est mesuré ────────────────────────────────────────────────────────

La phase 1 fait marquer chaque équipe à cadence constante λ × (part du temps
qui reste) quel que soit le score. Or une équipe menée en fin de match pousse,
retire son gardien, et l'équipe qui mène marque dans le filet désert. On
mesure donc, pour chaque ÉTAT — écart au score (du point de vue de l'équipe,
−3…+3) × tranche de temps (P1, P2, puis des tranches de plus en plus fines en
fin de 3e) — un multiplicateur m de la cadence :

    cadence(t) = λ_avant-match × w(t) × m(écart, tranche)

w(t) est le profil de temps du moteur (`PERIOD_DIST` / 1200 par seconde, la
même répartition que `nhlPredictions.ts`), λ le chiffre d'avant-match
hors échantillon du modèle de score (`live_pregame.py`).

── Maximum de vraisemblance d'exposition ────────────────────────────────────

Le temps réglementaire de chaque match est découpé aux buts et aux bornes des
tranches. Sur chaque morceau, chaque équipe a une exposition E = λ × ∫w(t)dt
dans la case de son état, et marque 0 ou 1 but. La vraisemblance d'un
processus de comptage dont la cadence dépend de l'histoire passée est
Π cadence(tᵢ) × exp(−∫cadence) ; son maximum, case par case, est
m = buts observés / exposition. C'est ce qui capte le gardien retiré SANS le
modéliser : ses buts (pour et contre) tombent dans les cases « −1 / +1, fin
de 3e ».

Cases rares : m = (O + a) / (E + a), rétréci vers 1. La force a est CHOISIE
par validation croisée saison par saison (log-vraisemblance de Poisson de la
saison laissée de côté), pas fixée à la main.

Biais connu, dans le sens prudent : une équipe plus forte que son λ d'avant-
match mène plus souvent, ce qui gonfle un peu m(mène) et dégonfle m(menée).
Les effets mesurés sont donc plutôt SOUS-estimés. Le rejeu tranche.

Sortie : server/src/services/prediction/liveEffects.json (lu par le moteur
`evolveLiveScore`). Rapport : ml/models/live/calibrate_live_report.json.

Usage :
    cd ml/python
    python fetch_live_goals.py && python live_pregame.py   # d'abord
    python calibrate_live.py                     # train ≤ 2022-23
    python calibrate_live.py --last-train 2022
"""

import argparse
import datetime as dt
import json
import os

import numpy as np
import pandas as pd

DATA = "../data"
OUT_JSON = "../../server/src/services/prediction/liveEffects.json"
REPORT = "../models/live/calibrate_live_report.json"

PERIOD_DIST = (0.305, 0.365, 0.330)      # ⚠️ jumeau de PERIOD_DIST (nhlPredictions.ts)
# Tranches en SECONDES ÉCOULÉES. Fines en fin de 3e : c'est là que le gardien
# sort (en général à 2–3 minutes de la fin pour un but d'écart).
SLICES = [(0, 1200), (1200, 2400), (2400, 3000), (3000, 3300), (3300, 3420),
          (3420, 3480), (3480, 3540), (3540, 3600)]
DIFFS = list(range(-3, 4))               # écart du point de vue de l'équipe, borné à ±3
SHRINK_GRID = [0, 2, 5, 10, 20, 40, 80, 160]


def w_integral(t0: float, t1: float) -> float:
    """∫ w(t) dt sur [t0, t1) : part des buts d'un match attendue dans l'intervalle."""
    s = 0.0
    for p in range(3):
        a, b = max(t0, p * 1200), min(t1, (p + 1) * 1200)
        if b > a:
            s += PERIOD_DIST[p] * (b - a) / 1200
    return s


def slice_of(t: float) -> int:
    for i, (a, b) in enumerate(SLICES):
        if a <= t < b:
            return i
    return len(SLICES) - 1


def cell(d: int) -> int:
    return max(-3, min(3, d)) + 3


def exposure_tables(games: pd.DataFrame, goals: pd.DataFrame) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """Par saison : (O, E), tableaux tranche × écart."""
    by_game = {gid: g for gid, g in goals.groupby("game_id")}
    bounds = sorted({b for s in SLICES for b in s})
    out: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for r in games.itertuples(index=False):
        O, E = out.setdefault(int(r.season), (np.zeros((len(SLICES), 7)), np.zeros((len(SLICES), 7))))
        g = by_game.get(r.game_id)
        events = [] if g is None else list(zip(g["time"].values, g["home_scored"].values))
        cuts = sorted(set(bounds) | {float(t) for t, _ in events})
        h = a = 0
        ev_i = 0
        for t0, t1 in zip(cuts[:-1], cuts[1:]):
            if t1 <= t0:
                continue
            sl = slice_of(t0)
            W = w_integral(t0, t1)
            E[sl, cell(h - a)] += r.lam_home * W
            E[sl, cell(a - h)] += r.lam_away * W
            # Buts tombant exactement en t1 : comptés dans l'état AVANT le but,
            # dans la tranche du but (celle de t1, pas celle de t0).
            while ev_i < len(events) and events[ev_i][0] <= t1:
                t, home = events[ev_i]
                if t == t1:
                    sg = slice_of(t)
                    if home:
                        O[sg, cell(h - a)] += 1; h += 1
                    else:
                        O[sg, cell(a - h)] += 1; a += 1
                ev_i += 1
        # Buts à t = 0 (aucun en pratique) ou hors découpage : ignorés.
    return out


def shrunk(O: np.ndarray, E: np.ndarray, a: float) -> np.ndarray:
    return (O + a) / np.maximum(E + a, 1e-12)


def poisson_ll(O: np.ndarray, E: np.ndarray, m: np.ndarray) -> float:
    mu = np.maximum(m * E, 1e-12)
    return float((O * np.log(mu) - mu).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-train", type=int, default=2012)
    ap.add_argument("--last-train", type=int, default=2022)
    a = ap.parse_args()

    games = pd.read_csv(f"{DATA}/live_games.csv")
    goals = pd.read_csv(f"{DATA}/live_goals.csv")
    pre = pd.read_csv(f"{DATA}/live_pregame.csv")
    games = games.merge(pre[["game_id", "lam_home", "lam_away"]], on="game_id", how="inner")
    games = games[(games["season"] >= a.first_train)]
    print(f"   {len(games)} matchs avec λ d'avant-match")

    tables = exposure_tables(games, goals)
    train = [s for s in sorted(tables) if s <= a.last_train]
    test = [s for s in sorted(tables) if s > a.last_train]
    O = sum(tables[s][0] for s in train); E = sum(tables[s][1] for s in train)

    # Force du rétrécissement : saison laissée de côté.
    cv = {}
    for k in SHRINK_GRID:
        ll = 0.0
        for s in train:
            Os, Es = tables[s]
            m = shrunk(O - Os, E - Es, k)
            ll += poisson_ll(Os, Es, m)
        cv[k] = ll
    best = max(cv, key=cv.get)
    base_ll = sum(poisson_ll(*tables[s], np.ones_like(O)) for s in train)
    print(f"   rétrécissement choisi a = {best} (log-vrais. CV {cv[best]:.1f}, "
          f"sans effet {base_ll:.1f}, gain {cv[best] - base_ll:+.1f})")
    m = shrunk(O, E, best)

    # Hors échantillon : saisons de test, m figé sur le train.
    test_rows = {}
    for s in test:
        Os, Es = tables[s]
        test_rows[s] = {"ll_effects": poisson_ll(Os, Es, m),
                        "ll_flat": poisson_ll(Os, Es, np.ones_like(m)),
                        "goals": int(Os.sum()), "expected_flat": round(float(Es.sum()), 1)}
        g = test_rows[s]
        print(f"   test {s}-{str(s + 1)[2:]} : gain log-vrais. {g['ll_effects'] - g['ll_flat']:+.1f} "
              f"({g['goals']} buts, {g['expected_flat']} attendus sans effet)")

    labels = [f"{a_ // 60:02d}:{a_ % 60:02d}–{b // 60:02d}:{b % 60:02d}" for a_, b in SLICES]
    print("\n   m (lignes = tranche de temps écoulé, colonnes = écart −3…+3)")
    print("   " + " " * 13 + "".join(f"{d:>7}" for d in DIFFS))
    for i, lab in enumerate(labels):
        print(f"   {lab:>13}" + "".join(f"{m[i, j]:7.2f}" for j in range(7))
              + f"   (buts {int(O[i].sum())})")

    out = {
        "version": 1,
        "description": ("Multiplicateur de la cadence de buts d'une équipe selon son écart au "
                        "score et le moment du match. Mesuré par calibrate_live.py (maximum de "
                        "vraisemblance d'exposition), ne pas éditer à la main."),
        "generatedAt": dt.date.today().isoformat(),
        "trainSeasons": [train[0], train[-1]],
        "periodDist": list(PERIOD_DIST),
        "slices": [list(s) for s in SLICES],
        "diffs": DIFFS,
        "shrink": best,
        # λ moyen d'une équipe sur les saisons d'entraînement : sert au facteur
        # d'équipe des paris joueur (`boxscoreLiveInfo`), qui n'a pas le λ du match.
        "leagueLambda": round(float(np.mean(np.concatenate([
            games.loc[games["season"].between(train[0], train[-1]), c].values
            for c in ("lam_home", "lam_away")]))), 4),
        "m": [[round(float(x), 4) for x in row] for row in m],
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump({"cv_loglik": {str(k): round(v, 2) for k, v in cv.items()},
                   "flat_loglik_train": round(base_ll, 2),
                   "test": {str(s): v for s, v in test_rows.items()},
                   "observed": O.astype(int).tolist(),
                   "expected": np.round(E, 2).tolist(), **out}, fh, indent=2, ensure_ascii=False)
    print(f"\n✅ {os.path.relpath(OUT_JSON)}  ·  rapport {os.path.relpath(REPORT)}")


if __name__ == "__main__":
    main()
