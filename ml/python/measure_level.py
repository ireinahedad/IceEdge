"""
measure_level.py
================
Recalage de NIVEAU des buts dans la saison : est-ce qu'il améliore les totaux,
et avec quelle force de rétrécissement ? (STATUS.md §3.5, « Pre-game score
model level drift », trouvé le 2026-10-01.)

Constat de départ : buts réglementaires observés / λ = 1,02-1,03 sur 2017-21,
0,955-0,969 sur 2022-26. Le modèle d'avant-match annonçait ~58 % pour « plus de
5,5 » quand le résultat réel était 56 %.

Entrée : `ml/data/live_pregame.csv` (λ d'avant-match HORS ÉCHANTILLON, modèle
de score walk-forward, saison S chiffrée par un modèle entraîné sur < S, cf.
`live_pregame.py`) joint à `ml/data/live_games.csv` (scores réglementaires).
Aucun xgboost nécessaire : la mesure porte sur un nombre posé par-dessus λ.

Le recalage (contrat partagé : `score_model.level_k`) :
    k = 1 + w·(r − 1),  r = Σ obs / Σ λ sur les matchs déjà joués de la saison,
    w = n / (n + n0).
    λ_total servi = k × λ_total ; P(victoire) inchangée (cf. score_model).

Fidèle au calendrier de production : `refresh_data.py` tourne le LUNDI à 9 h
(heure de Bali, soit dimanche soir à l'Est). Un match daté d ne voit donc que
les matchs datés au plus tard du SAMEDI précédant le lundi de sa semaine.
Pas de k au jour le jour, qui serait meilleur que ce que le service sert.

Règle d'adoption (posée le 2026-10-04 avant ce run ; une exploration rapide sur
une grille de n0, sans gel hebdomadaire ni saison laissée de côté, l'a
précédée — c'est elle qui a fait fixer le prior à k = 1 plutôt qu'au rapport
de la saison précédente, qui corrigeait trop) :
  1. n0 choisi par saison laissée de côté sur la grille N0_GRID : pour chaque
     saison S, le n0 qui minimise la déviance sur les AUTRES saisons notées ;
     S est notée avec ce n0. Le chiffre rapporté est donc hors échantillon
     pour n0 aussi.
  2. ADOPTER si la déviance de Poisson du total réglementaire baisse en
     moyenne avec z ≤ −2 (bootstrap apparié par match, 2 000 tirages, graine
     42) ET sur au moins 70 % des saisons notées ET si l'écart |P(> 5,5)
     prédit − observé| sur 2023-26 ne grandit pas.
  Sinon REJETER : `refresh_data` écrit alors k = 1 et rien ne bouge.

La force servie en production est le n0 choisi sur TOUTES les saisons notées.

Rapport : ml/models/level_report.json

Usage :
    cd ml/python
    python measure_level.py                  # saisons notées 2015-16 → 2025-26
    python measure_level.py --min-season 2017
"""

import argparse
import json
import math
import os
from datetime import date, timedelta

import numpy as np
import pandas as pd

from score_model import level_k

DATA_DIR = "../data"
REPORT = "../models/level_report.json"
N0_GRID = [25, 50, 100, 200, 400, 800, 1600]
LINE = 5.5


def refresh_cutoff(d: date) -> date:
    """Dernière date de match connue du recalage en service le jour `d` :
    le samedi qui précède le lundi de la semaine de `d`."""
    monday = d - timedelta(days=d.weekday())
    return monday - timedelta(days=2)


def load() -> pd.DataFrame:
    p = pd.read_csv(f"{DATA_DIR}/live_pregame.csv")
    g = pd.read_csv(f"{DATA_DIR}/live_games.csv")
    d = p.merge(g[["game_id", "date", "home_reg_score", "away_reg_score"]], on="game_id")
    d = d.dropna(subset=["lam_home", "lam_away", "home_reg_score", "away_reg_score"])
    d["lam"] = d["lam_home"] + d["lam_away"]
    d["obs"] = d["home_reg_score"] + d["away_reg_score"]
    d["day"] = pd.to_datetime(d["date"]).dt.date
    return d.sort_values(["date", "game_id"]).reset_index(drop=True)


def season_counts(s: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pour chaque match de la saison `s` : (Σ obs, Σ λ, n) des matchs que le
    recalage en service connaissait ce jour-là (cf. `refresh_cutoff`)."""
    days = np.array(s["day"].values)
    order = np.argsort(days, kind="stable")
    d_sorted = days[order]
    cum_o = np.concatenate([[0.0], np.cumsum(s["obs"].values[order])])
    cum_l = np.concatenate([[0.0], np.cumsum(s["lam"].values[order])])
    cut = np.array([refresh_cutoff(x) for x in days])
    idx = np.searchsorted(d_sorted, cut, side="right")   # matchs datés ≤ cutoff
    return cum_o[idx], cum_l[idx], idx


def k_series(d: pd.DataFrame, n0: float) -> np.ndarray:
    k = np.ones(len(d))
    for _, s in d.groupby("season"):
        so, sl, n = season_counts(s)
        k[s.index.values] = [level_k(a, b, int(c), n0) for a, b, c in zip(so, sl, n)]
    return k


def deviance(y: np.ndarray, mu: np.ndarray) -> np.ndarray:
    """Déviance de Poisson PAR MATCH (moyenne = déviance usuelle)."""
    mu = np.clip(mu, 1e-6, None)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(y > 0, y * np.log(np.where(y > 0, y, 1.0) / mu), 0.0)
    return 2.0 * (t - (y - mu))


def p_over(mu: np.ndarray, line: float = LINE) -> np.ndarray:
    """P(total réglementaire > line) sous Poisson. Pour 5,5 c'est aussi le
    « plus de 5,5 » final : un nul réglementaire a un total pair, la
    prolongation n'ajoute qu'un but, 2-2 → 5 reste « moins »."""
    kmax = int(math.floor(line))
    cdf = sum(np.exp(-mu) * mu ** j / math.factorial(j) for j in range(kmax + 1))
    return 1.0 - cdf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-season", type=int, default=2015)
    a = ap.parse_args()

    d = load()
    scored = sorted(s for s in d["season"].unique() if s >= a.min_season)
    print(f"📂 {len(d)} matchs, saisons {d['season'].min()}-{d['season'].max()} ; "
          f"notées : {scored[0]}-{scored[-1]} ({len(scored)})")

    y, lam = d["obs"].values.astype(float), d["lam"].values.astype(float)
    base_dev = deviance(y, lam)
    ks = {n0: k_series(d, n0) for n0 in N0_GRID}
    devs = {n0: deviance(y, lam * ks[n0]) for n0 in N0_GRID}
    by_season = {s: (d["season"] == s).values for s in scored}

    def mean_dev(n0, seasons):
        m = np.zeros(len(d), bool)
        for s in seasons:
            m |= by_season[s]
        return float(devs[n0][m].mean())

    # 1. n0 par saison laissée de côté
    chosen, k_loso = {}, np.ones(len(d))
    for s in scored:
        others = [t for t in scored if t != s]
        chosen[s] = min(N0_GRID, key=lambda n0: mean_dev(n0, others))
        k_loso[by_season[s]] = ks[chosen[s]][by_season[s]]
    n0_served = min(N0_GRID, key=lambda n0: mean_dev(n0, scored))

    mask = np.zeros(len(d), bool)
    for s in scored:
        mask |= by_season[s]
    diff = deviance(y, lam * k_loso)[mask] - base_dev[mask]
    rng = np.random.default_rng(42)
    boot = np.array([diff[rng.integers(0, len(diff), len(diff))].mean() for _ in range(2000)])
    z = float(diff.mean() / boot.std(ddof=1))

    seasons = []
    for s in scored:
        m = by_season[s]
        seasons.append({
            "season": int(s), "n": int(m.sum()), "n0": chosen[s],
            "ratio_obs_lam": round(float(y[m].sum() / lam[m].sum()), 4),
            "k_end": round(float(k_loso[m][-1]), 4),
            "dev_raw": round(float(base_dev[m].mean()), 5),
            "dev_level": round(float(deviance(y[m], lam[m] * k_loso[m]).mean()), 5),
        })
    better = sum(r["dev_level"] < r["dev_raw"] for r in seasons)

    recent = mask & (d["season"] >= 2023).values
    obs_over = float((y[recent] > LINE).mean())
    pred_raw = float(p_over(lam[recent]).mean())
    pred_lvl = float(p_over(lam[recent] * k_loso[recent]).mean())

    ok_z = z <= -2.0
    ok_seasons = better >= math.ceil(0.7 * len(scored))
    ok_over = abs(pred_lvl - obs_over) <= abs(pred_raw - obs_over)
    verdict = "ADOPTER" if (ok_z and ok_seasons and ok_over) else "REJETER"

    print(f"\n   Déviance moyenne {base_dev[mask].mean():.5f} → "
          f"{base_dev[mask].mean() + diff.mean():.5f}  (Δ {diff.mean():+.5f}, z {z:+.2f})")
    print(f"   Meilleure sur {better}/{len(scored)} saisons")
    print(f"   P(> {LINE}) 2023-26 : prédit {pred_raw:.3f} → {pred_lvl:.3f}, observé {obs_over:.3f}")
    print(f"   n0 par saison laissée de côté : {sorted(set(chosen.values()))} ; servi : {n0_served}")
    for r in seasons:
        print(f"     {r['season']}-{str(r['season'] + 1)[2:]}  obs/λ {r['ratio_obs_lam']:.3f}  "
              f"k fin {r['k_end']:.3f}  déviance {r['dev_raw']:.5f} → {r['dev_level']:.5f}")
    print(f"\n   ⇒ {verdict}  (z ≤ −2 : {ok_z} · ≥ 70 % des saisons : {ok_seasons} · "
          f"P(> {LINE}) pas pire : {ok_over})")

    report = {
        "generated": date.today().isoformat(),
        "verdict": verdict,
        "prior_games": n0_served,
        "rule": "z <= -2 (bootstrap apparié par match) ET >= 70 % des saisons ET |P(>5.5) - obs| 2023-26 pas pire ; n0 par saison laissée de côté",
        "refresh_timing": "k gelé chaque lundi sur les matchs datés jusqu'au samedi précédent",
        "scored_seasons": [int(scored[0]), int(scored[-1])],
        "n_games": int(mask.sum()),
        "deviance_raw": round(float(base_dev[mask].mean()), 6),
        "deviance_level": round(float(base_dev[mask].mean() + diff.mean()), 6),
        "delta": round(float(diff.mean()), 6), "z": round(z, 3),
        "seasons_better": better, "seasons_total": len(scored),
        "over_5_5_2023_26": {"observed": round(obs_over, 4), "pred_raw": round(pred_raw, 4),
                             "pred_level": round(pred_lvl, 4)},
        "n0_grid": N0_GRID, "n0_by_held_out_season": {str(k): v for k, v in chosen.items()},
        "seasons": seasons,
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"\n💾 {REPORT}")


if __name__ == "__main__":
    main()
