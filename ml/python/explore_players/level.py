"""
level.py — recalage de NIVEAU du modèle joueur dans la saison.

    python explore_players/level.py     # écrit ../models/player_level_report_frozen.json

Première mesure, sur le modèle FIGÉ. Remplacée pour le service par
level_wf.py (modèle réentraîné), qui écrit player_level_report.json.

Le modèle joueur (train_player.py, entraîné ≤ 2021-22) suit mal les dérives de
ligue : les tirs baissent depuis 2022-23, et il prévoit 1,63 tir par
patineur-match pour 1,61 observé en test (explore_shots/shots_players.py). Même
remède que pour les buts et les tirs d'équipe : par statistique, un k de la
saison en cours = Σ observé / Σ prévu sur les matchs DÉJÀ joués, rétréci vers 1

    k = 1 + w·(r − 1),  r = Σ obs / Σ μ,  w = n / (n + n0)   (n = matchs NHL joués)

Règle (posée avant le run, 2026-10-15) : pour chaque statistique, n0 est choisi
sur la VALIDATION (2022-23) dans {50, 100, 200, 400, 800, 1600} ; le recalage
est adopté si la log-vraisemblance (binomiale négative, k du rapport) monte en
validation ET en test (2023-24 → 2025-26), avec z ≥ 2 en test.
"""
from __future__ import annotations
import json, os, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
import train_player as TP                    # noqa: E402
import referee_effects as RE                 # noqa: E402
from score_model import level_k              # noqa: E402

ML = os.path.dirname(PY)
DATA, MODELS = os.path.join(ML, "data"), os.environ.get("MODELS_DIR") or os.path.join(ML, "models")
OUT = os.path.join(HERE, "out")
N0_GRID = [50, 100, 200, 400, 800, 1600]


def rows() -> pd.DataFrame:
    cache = os.path.join(OUT, "player_mu_all.pkl")
    if os.path.exists(cache):
        return pd.read_pickle(cache)
    pg = TP.per_game(TP.load_skaters(os.path.join(DATA, "raw")))
    pre = TP.rolling_features(pg, shift=1)
    df = pd.concat([pg, pre, TP.vs_features(pg, pre, shift=1)], axis=1)
    df = TP.game_context(df, pd.read_csv(os.path.join(DATA, "nhl_games_v4.csv"), low_memory=False))
    rg = RE.load_ref_games(DATA)
    if rg is not None:
        df = df.merge(RE.pregame_features(rg), left_on="gameId", right_on="game_id", how="left",
                      suffixes=("", "_ref"))
    for col in RE.REF_FEATS:
        if col not in df:
            df[col] = np.nan
    df = df[df.season >= 2022].copy()
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    for s in TP.STATS:
        feats = rep["stats"][s]["features"]
        b = xgb.Booster(); b.load_model(os.path.join(MODELS, "player", f"{s}.json"))
        df[f"mu_{s}"] = b.predict(xgb.DMatrix(df[feats], feature_names=feats))
    keep = ["playerId", "gameId", "season", "date"] + [f"y_{s}" for s in TP.STATS] + [f"mu_{s}" for s in TP.STATS]
    out = df[keep].reset_index(drop=True)
    out.to_pickle(cache)
    return out


def causal_k(D: pd.DataFrame, stat: str, n0: float) -> np.ndarray:
    """k de chaque ligne : Σ obs / Σ μ des jours PRÉCÉDENTS de la saison, n = matchs joués."""
    k = np.ones(len(D))
    for _, g in D.groupby("season", sort=False):
        day = g.groupby("date").agg(obs=(f"y_{stat}", "sum"), mu=(f"mu_{stat}", "sum"), n=("gameId", "nunique"))
        cum = day.cumsum().shift(1).fillna(0.0)
        kd = {d: (level_k(c.obs, c.mu, int(c.n), n0) if c.n > 0 else 1.0) for d, c in cum.iterrows()}
        k[g.index.values] = g.date.map(kd).values
    return k


def main():
    t0 = time.time()
    D = rows().sort_values(["date", "gameId"]).reset_index(drop=True)
    rep_p = json.load(open(os.path.join(MODELS, "player_report.json")))
    print(f"⛸️  {len(D)} patineur-matchs 2022-23 → 2025-26 ({time.time()-t0:.0f}s)")
    val, test = (D.season == 2022).values, (D.season >= 2023).values
    report = {"generated": time.strftime("%Y-%m-%d"), "n0_grid": N0_GRID,
              "rule": "n0 choisi en validation ; adopté si Δ log-vraisemblance > 0 en validation ET en test, z ≥ 2 en test",
              "stats": {}}
    for s in TP.STATS:
        kd = rep_p["stats"][s]["k"]
        y, mu = D[f"y_{s}"].values.astype(float), np.clip(D[f"mu_{s}"].values, 1e-6, None)
        base = TP.nb_ll(y, mu, kd)
        best = None
        for n0 in N0_GRID:
            k = causal_k(D, s, n0)
            d = TP.nb_ll(y, mu * k, kd) - base
            if best is None or d[val].mean() > best[1][val].mean():
                best = (n0, d, k)
        n0, d, k = best
        dv, dt = d[val], d[test]
        zt = float(dt.mean() / (dt.std(ddof=1) / np.sqrt(len(dt))))
        zv = float(dv.mean() / (dv.std(ddof=1) / np.sqrt(len(dv))))
        r = {"n0": n0, "dll_val": round(float(dv.mean()), 7), "z_val": round(zv, 2),
             "dll_test": round(float(dt.mean()), 7), "z_test": round(zt, 2),
             "by_season": {int(se): {"obs": round(float(y[D.season.values == se].mean()), 4),
                                     "model": round(float(mu[D.season.values == se].mean()), 4),
                                     "leveled": round(float((mu * k)[D.season.values == se].mean()), 4),
                                     "dll": round(float(d[D.season.values == se].mean()), 7)}
                           for se in sorted(D.season.unique())}}
        r["adopt"] = bool(r["dll_val"] > 0 and r["dll_test"] > 0 and r["z_test"] >= 2)
        report["stats"][s] = r
        print(f"   {s:9s} n0={n0:5d}  val Δ {r['dll_val']:+.6f} (z {zv:+.1f})  test Δ {r['dll_test']:+.6f} "
              f"(z {zt:+.1f})  → {'ADOPTER' if r['adopt'] else 'non'}   "
              + "  ".join(f"{se}: {v['obs']:.3f}/{v['model']:.3f}" for se, v in r["by_season"].items()), flush=True)
    # Historique : le service lit player_level_report.json, écrit par level_wf.py.
    with open(os.path.join(MODELS, "player_level_report_frozen.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1, ensure_ascii=False)
    print(f"✅ models/player_level_report_frozen.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
