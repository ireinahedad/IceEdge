"""
live_window_compare.py
======================
La table des effets de score doit-elle privilégier les saisons récentes ?
(`ml/EXPLICATION_ML.md` §10.3). Le §10.3 montre une dérive : les entraîneurs
retirent leur gardien plus tôt qu'en 2012.

Pour chaque saison de test S (2023-24 → 2025-26), plusieurs tables sont
ajustées sur les saisons < S SEULEMENT, puis notées par la log-vraisemblance
de Poisson des buts de S (même exposition que `calibrate_live.py`) :
  · servie         2012-2022, figée (la table en production) ;
  · croissante     2012 → S−1 ;
  · glissante k    S−k → S−1 (k = 3, 5, 7) ;
  · demi-vie h     2012 → S−1, saison s pondérée 0,5^((S−1−s)/h) (h = 3, 5).
Écart à la table servie : somme par match, erreur type appariée par match.

Écrit aussi les tables « demi-vie 3 » de chaque saison de test, pour le rejeu
des marchés (`server/scripts/replay-live-window.ts`).

Sorties : ml/models/live/live_window_report.json, ml/models/live/live_effects_recent.json
Usage :   cd ml/python && python live_window_compare.py
"""

import json

import numpy as np
import pandas as pd

import calibrate_live as C
from live_calibration_checks import per_game_tables

DATA = "../data"
TEST = [2023, 2024, 2025]


def main():
    fx = json.load(open(C.OUT_JSON, encoding="utf-8"))
    g = pd.read_csv(f"{DATA}/live_games.csv")
    goals = pd.read_csv(f"{DATA}/live_goals.csv")
    pre = pd.read_csv(f"{DATA}/live_pregame.csv")
    g = g.merge(pre[["game_id", "lam_home", "lam_away"]], on="game_id")
    g = g[g["season"] >= fx["trainSeasons"][0]].reset_index(drop=True)
    O, E = per_game_tables(g, goals)
    se = g["season"].values
    Os = {s: O[se == s].sum(0) for s in set(se)}
    Es = {s: E[se == s].sum(0) for s in set(se)}
    a = fx["shrink"]

    def fit(w: dict) -> np.ndarray:
        return C.shrunk(sum(w[s] * Os[s] for s in w), sum(w[s] * Es[s] for s in w), a)

    def per_game(m, S):
        # Log-vraisemblance par match, au terme O·log E près (identique pour
        # toutes les tables, il s'annule dans les écarts).
        return (O[se == S] * np.log(m) - m * E[se == S]).sum((1, 2))

    first, last = fx["trainSeasons"]
    served = np.array(fx["m"])
    variants = {
        "croissante": lambda S: {s: 1 for s in range(first, S)},
        **{f"glissante {k} ans": (lambda k: lambda S: {s: 1 for s in range(S - k, S)})(k) for k in (3, 5, 7)},
        **{f"demi-vie {h} ans": (lambda h: lambda S: {s: 0.5 ** ((S - 1 - s) / h) for s in range(first, S)})(h)
           for h in (3, 5)},
    }
    report = {"generatedAt": pd.Timestamp.today().date().isoformat(), "test": TEST, "shrink": a,
              "served_gain_vs_flat": {}, "variants": {}}
    for S in TEST:
        flat = per_game(np.ones_like(served), S).sum()
        report["served_gain_vs_flat"][str(S)] = round(float(per_game(served, S).sum() - flat), 1)
    print("   servie : gain contre m ≡ 1 par saison", report["served_gain_vs_flat"])
    for name, wf in variants.items():
        d = {S: per_game(fit(wf(S)), S) - per_game(served, S) for S in TEST}
        allv = np.concatenate(list(d.values()))
        z = allv.mean() / (allv.std(ddof=1) / np.sqrt(len(allv)))
        report["variants"][name] = {"delta_vs_served": {str(S): round(float(v.sum()), 1) for S, v in d.items()},
                                    "delta_total": round(float(allv.sum()), 1), "z": round(float(z), 2)}
        print(f"   {name:16s} Δ {allv.sum():+6.1f}  z {z:+.2f}  par saison",
              [round(float(v.sum()), 1) for v in d.values()])
    with open("../models/live/live_window_report.json", "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    tables = {}
    for S in TEST:
        m = fit(variants["demi-vie 3 ans"](S))
        tables[str(S)] = {**fx, "m": np.round(m, 4).tolist(), "trainSeasons": [first, S - 1],
                          "description": "Table récente (demi-vie 3 saisons) — MESURE, non servie."}
    with open("../models/live/live_effects_recent.json", "w", encoding="utf-8") as fh:
        json.dump({"description": "Tables demi-vie 3 saisons par saison de test (live_window_compare.py), "
                                  "pour replay-live-window.ts. Non servies.", "tables": tables},
                  fh, indent=2, ensure_ascii=False)
    print("✅ models/live/live_window_report.json, models/live/live_effects_recent.json")


if __name__ == "__main__":
    main()
