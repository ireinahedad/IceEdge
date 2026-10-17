"""
attempts.py — les tentatives de tir comme variables du modèle joueur.

    python explore_players/retrain.py       # d'abord (cache du cadre)
    python explore_players/lineup.py        # d'abord (variables de déploiement récent)
    python explore_players/attempts.py      # écrit ../models/player_attempts_report.json

Deux idées, chacune pour une stat :

  TIRS — un tir cadré, c'est une tentative qui n'a été ni bloquée ni ratée.
  Le volume de tentatives (cadrées, ratées, bloquées) mesure l'intention de
  tirer avec plus de signal que les seuls tirs cadrés :
      att_p60_10, att_p60_30, att_p60_career   tentatives du joueur par 60 min

  TIRS BLOQUÉS — on ne bloque que ce que l'adversaire tente :
      oia_p60_20    tentatives adverses par 60 quand le joueur est sur la glace (20 matchs)
      opp_att_f20   tentatives par match de l'adversaire (20 derniers matchs)
      tm_att_a20    tentatives concédées par match par son équipe (20 derniers matchs)

Tout est calculé avant le match (fenêtres décalées d'un match).

Mesure : validation « marchante » 2023-24 → 2025-26, contre la configuration
SERVIE de la stat (réentraînée chaque été + déploiement récent, retrain.py et
recency_wf.py). Règle (posée avant le run, 2026-10-16) : la variante remplace
le modèle servi si Δ log-vraisemblance > 0 sur les trois saisons regroupées,
z ≥ 2, et Δ > 0 dans au moins 2 saisons sur 3.
"""
from __future__ import annotations
import glob, json, os, sys, time, zipfile
import numpy as np
import pandas as pd
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
sys.path.insert(0, HERE)
import train_player as TP                    # noqa: E402
from retrain import verdict, BASE, TEST      # noqa: E402

MODELS, DATA = TP.MODELS_DIR, TP.DATA_DIR
OUT = os.path.join(HERE, "out")
RECENCY = ["toi_last1", "toi_pp_last1", "toi_pp_avg_3"]
NEW = {"shots": ["att_p60_10", "att_p60_30", "att_p60_career"],
       "blocks": ["oia_p60_20", "opp_att_f20", "tm_att_a20"]}
TEAM_WINDOW = 20


def player_attempts() -> pd.DataFrame:
    """playerId, gameId → tentatives du joueur et tentatives adverses sur la glace, pré-match."""
    cols = ["playerId", "gameId", "gameDate", "situation", "position", "icetime",
            "I_F_shotAttempts", "OnIce_A_shotAttempts"]
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
    g = r.groupby("playerId", sort=False)
    toi = r.icetime / 60.0

    def rs(x, w):
        return x.groupby(r.playerId, sort=False).transform(lambda s: s.shift(1).rolling(w, min_periods=1).sum())

    def cs(x):
        return x.groupby(r.playerId, sort=False).transform(lambda s: s.shift(1).cumsum())
    out = pd.DataFrame({"playerId": r.playerId, "gameId": r.gameId})
    for w in (10, 30):
        out[f"att_p60_{w}"] = rs(r.I_F_shotAttempts, w) / rs(toi, w) * 60
    out["att_p60_career"] = cs(r.I_F_shotAttempts) / cs(toi) * 60
    out["oia_p60_20"] = rs(r.OnIce_A_shotAttempts, 20) / rs(toi, 20) * 60
    return out.replace([np.inf, -np.inf], np.nan)


def team_attempts() -> pd.DataFrame:
    """gameId, côté (HOME/AWAY) → tentatives pour et contre de l'équipe, moyenne des 20 matchs précédents."""
    t = pd.read_csv(os.path.join(DATA, "mp_team_games.csv"),
                    usecols=["gameId", "gameDate", "playerTeam", "home_or_away", "situation",
                             "shotAttemptsFor", "shotAttemptsAgainst"], low_memory=False)
    t = t[t.situation == "all"].drop_duplicates(["gameId", "playerTeam"])
    t["date"] = pd.to_datetime(t.gameDate.astype(str), format="%Y%m%d")
    t = t.sort_values(["playerTeam", "date", "gameId"]).reset_index(drop=True)
    g = t.groupby("playerTeam", sort=False)
    t["att_f20"] = g.shotAttemptsFor.transform(lambda s: s.shift(1).rolling(TEAM_WINDOW, min_periods=5).mean())
    t["att_a20"] = g.shotAttemptsAgainst.transform(lambda s: s.shift(1).rolling(TEAM_WINDOW, min_periods=5).mean())
    # Quelques matchs apparaissent deux fois du même côté (changement de sigle) : un seul.
    return t[["gameId", "home_or_away", "att_f20", "att_a20"]].drop_duplicates(["gameId", "home_or_away"])


def frame() -> pd.DataFrame:
    df = pd.read_pickle(os.path.join(OUT, "retrain_frame.pkl"))
    n0 = len(df)
    df = pd.concat([df, pd.read_pickle(os.path.join(OUT, "lineup_feats.pkl"))[RECENCY]], axis=1)
    pa = player_attempts()
    df = df.merge(pa, on=["playerId", "gameId"], how="left")
    ta = team_attempts()
    side = df.home_or_away.str.upper()
    tm = ta.rename(columns={"att_f20": "tm_att_f20", "att_a20": "tm_att_a20"})
    df["_side"], df["_other"] = side, np.where(side == "HOME", "AWAY", "HOME")
    df = df.merge(tm, left_on=["gameId", "_side"], right_on=["gameId", "home_or_away"], how="left",
                  suffixes=("", "_tm"))
    op = ta.rename(columns={"att_f20": "opp_att_f20", "att_a20": "opp_att_a20", "home_or_away": "hoa_opp"})
    df = df.merge(op, left_on=["gameId", "_other"], right_on=["gameId", "hoa_opp"], how="left")
    assert len(df) == n0, f"jointure : {len(df)} lignes pour {n0}"
    return df


def main():
    t0 = time.time()
    df = frame()
    TE = df[df.season.isin(TEST)].sort_values(["date", "gameId"]).reset_index(drop=True)
    yrs = TE.season.values
    print(f"⛸️  {len(df)} patineur-matchs ({time.time()-t0:.0f}s)", flush=True)
    for c in sum(NEW.values(), []):
        print(f"   {c:15s} couverture test {TE[c].notna().mean():.1%}  moyenne {TE[c].mean():.2f}", flush=True)
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))

    def walk(feats, y):
        mono = {f"vs_lift_{x}": 1 for x in TP.STATS if f"vs_lift_{x}" in feats}
        p = dict(BASE, monotone_constraints=mono) if mono else BASE
        mu, ks = np.zeros(len(TE)), np.zeros(len(TE))
        for S in TEST:
            tr, va, full = df[df.season <= S - 2], df[df.season == S - 1], df[df.season <= S - 1]
            dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
            b0 = xgb.train(p, xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats), 2000,
                           evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
            R = b0.best_iteration + 1
            k = TP.fit_k(va[y].values, b0.predict(dva, iteration_range=(0, R)))
            b1 = xgb.train(p, xgb.DMatrix(full[feats], label=full[y], feature_names=feats), R, verbose_eval=False)
            rows = TE.index.values[yrs == S]
            mu[rows] = b1.predict(xgb.DMatrix(TE.loc[rows, feats], feature_names=feats))
            ks[rows] = k
        yt = TE[y].values.astype(float)
        ll = np.empty(len(TE))
        for k in np.unique(ks):
            m = ks == k
            ll[m] = TP.nb_ll(yt[m], mu[m], k)
        return ll, mu

    out = {"generated": time.strftime("%Y-%m-%d"), "features": NEW, "team_window": TEAM_WINDOW,
           "rule": "la variante remplace le modèle servi si Δ > 0, z ≥ 2 et Δ > 0 dans ≥ 2 saisons sur 3",
           "stats": {}}
    for s, new in NEW.items():
        y = f"y_{s}"
        served = rep["stats"][s]["features"]          # déjà avec le déploiement récent
        llS, muS = walk(served, y)
        llN, muN = walk(served + new, y)
        r = verdict(llN - llS, yrs)
        r["mean"] = {int(S): {"obs": round(float(TE[y].values[yrs == S].mean()), 4),
                              "served": round(float(muS[yrs == S].mean()), 4),
                              "variant": round(float(muN[yrs == S].mean()), 4)} for S in TEST}
        out["stats"][s] = r
        print(f"   {s:7s} + {', '.join(new)} : Δ {r['dll']:+.6f} (z {r['z']:+.1f}) {r['by_season']} → "
              f"{'ADOPTER' if r['pass'] else 'non'}  ({time.time()-t0:.0f}s)", flush=True)
        json.dump(out, open(os.path.join(MODELS, "player_attempts_report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_attempts_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
