"""
lineup.py — chantier 3 de « ICEEDGE — Des prédictions joueurs plus justes » :
l'alignement du soir et le déploiement récent, comme variables du modèle joueur.

    python explore_players/lineup.py           # écrit ../models/player_lineup_report.json

Le modèle connaît le temps de glace MOYEN d'un joueur (5, 10, 30 matchs) mais
ne voit ni une promotion d'hier soir sur le 1er trio ou la 1re unité d'AN, ni
les absents de ce soir dont il hérite des minutes. Les trios de la saison
(data/raw/lines) ne sont que des cumuls de saison, et leur « synergie » ne tient
pas d'une saison à l'autre (r 0,02, measure_lines_refs.py) : on mesure donc
ce que l'alignement change au temps de glace, pas qui joue avec qui.

Variables ajoutées (toutes connues avant le match, l'alignement du soir étant
publié avant la mise en jeu) :
  toi_last1, toi_pp_last1   temps de glace (total, AN) au dernier match
  toi_pp_avg_3              temps d'AN moyen sur 3 matchs
  played_last5              matchs joués parmi les 5 derniers de son équipe (même saison)
  team_absent_toi           minutes des habitués absents ce soir (≥ 2 des 5 derniers
                            matchs de l'équipe, absents de l'alignement)
  team_absent_pp_toi        minutes d'AN de ces mêmes absents

Règle (posée avant le run, 2026-10-15) — celle des chantiers précédents : par
statistique, B (features servies + ces 6) remplace A (features servies) si
Δ log-vraisemblance > 0 en validation (2022-23) ET en test (2023-24 → 2025-26),
z ≥ 2 en test. Même découpage et paramètres que train_player.py.
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

MODELS = TP.MODELS_DIR
OUT = os.path.join(HERE, "out")
LINEUP_FEATS = ["toi_last1", "toi_pp_last1", "toi_pp_avg_3", "played_last5",
                "team_absent_toi", "team_absent_pp_toi"]
TEAM_WINDOW = 5
REGULAR_MIN = 2


def lineup_features(df: pd.DataFrame) -> pd.DataFrame:
    """Les 6 variables, alignées sur l'index de `df` (une ligne par patineur-match)."""
    d = df[["playerId", "gameId", "date", "season", "playerTeam", "toi", "toi_pp"]].copy()
    d["playerTeam"] = d.playerTeam.replace(TP.FRANCHISE)
    d = d.sort_values(["playerId", "date", "gameId"])
    g = d.groupby("playerId", sort=False)
    out = pd.DataFrame(index=d.index)
    out["toi_last1"] = g.toi.shift(1)
    out["toi_pp_last1"] = g.toi_pp.shift(1)
    out["toi_pp_avg_3"] = g.toi_pp.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean())
    out["played_last5"] = np.nan
    out["team_absent_toi"] = np.nan
    out["team_absent_pp_toi"] = np.nan
    for (team, season), t in d.groupby(["playerTeam", "season"], sort=False):
        games = t[["gameId", "date"]].drop_duplicates("gameId").sort_values(["date", "gameId"])
        gi = {gid: j for j, gid in enumerate(games.gameId.values)}
        pi = {pid: i for i, pid in enumerate(t.playerId.unique())}
        J, N = len(gi), len(pi)
        rj = t.gameId.map(gi).values
        ri = t.playerId.map(pi).values
        P = np.zeros((J + 1, N)); T = np.zeros((J + 1, N)); Q = np.zeros((J + 1, N))
        P[rj + 1, ri] = 1.0
        T[rj + 1, ri] = t.toi.values
        Q[rj + 1, ri] = t.toi_pp.values
        cP, cT, cQ = P.cumsum(0), T.cumsum(0), Q.cumsum(0)
        lo = np.maximum(np.arange(J) - TEAM_WINDOW, 0)            # fenêtre [j-5, j) des matchs d'équipe
        hi = np.arange(J)
        cnt = cP[hi] - cP[lo]                                      # J × N : matchs joués dans la fenêtre
        mt = (cT[hi] - cT[lo]) / np.maximum(cnt, 1)
        mq = (cQ[hi] - cQ[lo]) / np.maximum(cnt, 1)
        tonight = P[1:] > 0
        absent = (cnt >= REGULAR_MIN) & ~tonight
        ab_t = (mt * absent).sum(1)
        ab_q = (mq * absent).sum(1)
        out.loc[t.index, "played_last5"] = cnt[rj, ri]
        out.loc[t.index, "team_absent_toi"] = ab_t[rj]
        out.loc[t.index, "team_absent_pp_toi"] = ab_q[rj]
    return out.loc[df.index]


def main():
    t0 = time.time()
    df = pd.read_pickle(os.path.join(OUT, "retrain_frame.pkl"))
    df = pd.concat([df, lineup_features(df)], axis=1)
    print(f"⛸️  {len(df)} patineur-matchs ({time.time()-t0:.0f}s)", flush=True)
    te_ = df[df.season >= 2023]
    print("   moyennes test : " + "  ".join(f"{c} {te_[c].mean():.2f}" for c in LINEUP_FEATS), flush=True)
    tr, va, te = df[df.season <= 2021], df[df.season == 2022], df[df.season >= 2023]
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    base = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50, subsample=0.8,
                colsample_bytree=0.8, eval_metric="poisson-nloglik", max_delta_step=0.7,
                nthread=os.cpu_count() or 2, seed=7)
    mono = {f"vs_lift_{x}": 1 for x in TP.STATS}

    def fit(feats, y):
        m = {f: 1 for f in mono if f in feats}
        p = dict(base, monotone_constraints=m) if m else base
        dtr = xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats)
        dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
        bst = xgb.train(p, dtr, 2000, evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        it = (0, bst.best_iteration + 1)
        mva = bst.predict(dva, iteration_range=it)
        mte = bst.predict(xgb.DMatrix(te[feats], feature_names=feats), iteration_range=it)
        return TP.fit_k(va[y].values, mva), mva, mte, it[1], bst

    out = {"generated": time.strftime("%Y-%m-%d"), "features": LINEUP_FEATS, "team_window": TEAM_WINDOW,
           "regular_min": REGULAR_MIN,
           "rule": "B (features + alignement) remplace A si Δ log-vraisemblance > 0 en validation ET en test, z ≥ 2 en test",
           "stats": {}}
    yrs = te.season.values
    for s in TP.STATS:
        y = f"y_{s}"
        feats = rep["stats"][s]["features"]
        kA, mvA, mtA, rA, _ = fit(feats, y)
        kB, mvB, mtB, rB, bB = fit(feats + LINEUP_FEATS, y)
        dv = TP.nb_ll(va[y].values, mvB, kB) - TP.nb_ll(va[y].values, mvA, kA)
        dt = TP.nb_ll(te[y].values, mtB, kB) - TP.nb_ll(te[y].values, mtA, kA)
        z = float(dt.mean() / (dt.std(ddof=1) / np.sqrt(len(dt))))
        zv = float(dv.mean() / (dv.std(ddof=1) / np.sqrt(len(dv))))
        gain = bB.get_score(importance_type="total_gain")
        tot = sum(gain.values()) or 1.0
        # Effet concret : quand 15+ minutes d'habitués manquent, le modèle B monte-t-il, et l'observé ?
        hiab = (te.team_absent_toi >= 15).values
        r = {"k_A": kA, "k_B": kB, "rounds_A": rA, "rounds_B": rB,
             "dll_val": round(float(dv.mean()), 6), "z_val": round(zv, 2),
             "dll_test": round(float(dt.mean()), 6), "z_test": round(z, 2),
             "dll_test_by_season": {int(ss): round(float(dt[yrs == ss].mean()), 6) for ss in np.unique(yrs)},
             "gain_share": {f: round(gain.get(f, 0.0) / tot, 4) for f in LINEUP_FEATS},
             "absent15": {"n": int(hiab.sum()),
                          "obs_over_A": round(float(te[y].values[hiab].sum() / mtA[hiab].sum()), 4),
                          "B_over_A": round(float(mtB[hiab].sum() / mtA[hiab].sum()), 4)}}
        r["adopt"] = bool(r["dll_val"] > 0 and r["dll_test"] > 0 and r["z_test"] >= 2)
        out["stats"][s] = r
        print(f"   {s:9s} val Δ {r['dll_val']:+.6f} (z {zv:+.1f})  test Δ {r['dll_test']:+.6f} (z {z:+.1f}) "
              f"{r['dll_test_by_season']} → {'ADOPTER' if r['adopt'] else 'non'}  "
              f"absents≥15 obs/A {r['absent15']['obs_over_A']} B/A {r['absent15']['B_over_A']}  ({time.time()-t0:.0f}s)",
              flush=True)
        json.dump(out, open(os.path.join(MODELS, "player_lineup_report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_lineup_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
