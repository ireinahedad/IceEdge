"""
shots_players.py — piste 3, mesure 3 : les tirs d'un patineur tirés des tirs
de son équipe (« top-down ») contre le modèle joueur seul.

    python train_shots.py                   # d'abord : shots_model.json (entraîné ≤ 2021-04)
    python explore_shots/shots_players.py

  A : X ~ BN(μ_tirs, k) — modèle joueur servi (k du rapport, 20).
  B : S ~ BN(λ_tirs équipe, k_S), X | S ~ Binom(S, s), s = μ_tirs / Σ_équipe μ_tirs.
  C : BN(s · λ_tirs, k) — le niveau de B sans sa forme.
Règle (posée avant le run) : B remplace A si Δ log-vraisemblance > 0 en
validation ET en test, z ≥ 2 en test. Sinon le modèle joueur reste.
Plus la loi jointe « X plus de 2,5 tirs » × « son équipe plus de 30,5 tirs »
n'est PAS mesurée : aucun marché de tirs d'équipe n'existe dans l'app.
"""
from __future__ import annotations
import json, os, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import binom, nbinom

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
sys.path.insert(0, HERE)
import train_player as TP     # noqa: E402
import train_score as TS      # noqa: E402
import train_shots as SH      # noqa: E402
from train_shots import nb_ll, zstat   # noqa: E402

DATA, MODELS = SH.DATA_DIR, SH.MODELS_DIR
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

SMAX = 90


def player_shots() -> pd.DataFrame:
    cache = os.path.join(OUT, "player_mu_shots.pkl")
    if os.path.exists(cache):
        return pd.read_pickle(cache)
    pg = TP.per_game(TP.load_skaters(os.path.join(DATA, "raw")))
    pre = TP.rolling_features(pg, shift=1)
    df = pd.concat([pg, pre, TP.vs_features(pg, pre, shift=1)], axis=1)
    games = pd.read_csv(os.path.join(DATA, "nhl_games_v4.csv"), low_memory=False)
    df = TP.game_context(df, games)
    df = df[df.season >= 2020].copy()
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    feats = rep["stats"]["shots"]["features"]
    b = xgb.Booster(); b.load_model(os.path.join(MODELS, "player", "shots.json"))
    df["mu_shots"] = b.predict(xgb.DMatrix(df[feats], feature_names=feats))
    out = df[["playerId", "gameId", "season", "team_side", "y_shots", "mu_shots"]].reset_index(drop=True)
    out.to_pickle(cache)
    return out


def main():
    t0 = time.time()
    rep_s = json.load(open(os.path.join(MODELS, "shots_report.json")))
    kS = rep_s["k_team"]
    kA = json.load(open(os.path.join(MODELS, "player_report.json")))["stats"]["shots"]["k"]
    # λ_tirs hors échantillon : shots_model.json est entraîné sur la tranche
    # d'entraînement de train_score.split ; validation et test ne l'ont pas vu.
    df = pd.read_csv(os.path.join(DATA, "nhl_games_v4.csv"), low_memory=False)
    df = df.dropna(subset=["home_reg_score", "away_reg_score", "went_to_ot", "total_goals", "home_win", "date"])
    df = SH.attach_shots(df, os.path.join(DATA, "mp_team_games.csv")).dropna(subset=["home_shots", "away_shots"])
    _, va, te = TS.split(df.reset_index(drop=True))
    bst = xgb.Booster(); bst.load_model(os.path.join(MODELS, "shots_model.json"))
    parts = []
    for name, d in (("val", va), ("test", te)):
        r = SH.team_rows(d)
        raw = bst.predict(SH.dmatrix(r, False))
        r["mu"] = raw * SH.causal_level(r, raw)
        r["split"] = name
        parts.append(r)
    T = pd.concat(parts, ignore_index=True)
    T["team_side"] = T.side.str.upper()
    P = player_shots()
    D = P.merge(T[["game_id", "team_side", "mu", "split", "y"]].rename(columns={"y": "team_y", "mu": "lam"}),
                left_on=["gameId", "team_side"], right_on=["game_id", "team_side"], how="inner")
    D["share"] = (D.mu_shots / D.groupby(["gameId", "team_side"]).mu_shots.transform("sum")).clip(1e-6, 0.99)
    print(f"   {len(D)} joueur-matchs ({(D.split=='val').sum()} validation) ({time.time()-t0:.0f}s)")

    y = D.y_shots.values.astype(int)
    mu = np.clip(D.mu_shots.values, 1e-6, None)
    llA = nb_ll(y, mu, kA)
    # B : mélange sur S (tirs de l'équipe).
    S = np.arange(SMAX + 1)
    out = np.empty(len(D))
    for i0 in range(0, len(D), 20000):
        sl = slice(i0, i0 + 20000)
        lam = D.lam.values[sl][:, None]
        pS = nbinom.pmf(S[None, :], kS, kS / (kS + lam))
        pS /= pS.sum(1, keepdims=True)
        pX = binom.pmf(y[sl][:, None], S[None, :], D.share.values[sl][:, None])
        out[sl] = np.log(np.clip((pS * pX).sum(1), 1e-300, None))
    llB = out
    llC = nb_ll(y, D.share.values * D.lam.values, kA)
    rep = {"generated": time.strftime("%Y-%m-%d"), "k_player": kA, "k_team": kS,
           "rule": "B remplace A si Δ > 0 en validation ET en test, z ≥ 2 en test"}
    for sp in ("val", "test"):
        m = (D.split == sp).values
        dB, dC = llB[m] - llA[m], llC[m] - llA[m]
        rep[sp] = {"n": int(m.sum()), "dll_B": round(float(dB.mean()), 6), "z_B": round(zstat(dB), 2),
                   "dll_C": round(float(dC.mean()), 6), "z_C": round(zstat(dC), 2),
                   "mean_obs": round(float(y[m].mean()), 4), "mean_A": round(float(mu[m].mean()), 4),
                   "mean_B": round(float((D.share.values * D.lam.values)[m].mean()), 4)}
    rep["adopt_B"] = bool(rep["val"]["dll_B"] > 0 and rep["test"]["dll_B"] > 0 and rep["test"]["z_B"] >= 2)
    print(f"   tirs patineur : val ΔB {rep['val']['dll_B']:+.5f} (z {rep['val']['z_B']:+.1f})  "
          f"test ΔB {rep['test']['dll_B']:+.5f} (z {rep['test']['z_B']:+.1f})  "
          f"ΔC test {rep['test']['dll_C']:+.5f} (z {rep['test']['z_C']:+.1f}) → "
          f"{'ADOPTER' if rep['adopt_B'] else 'garder le modèle joueur'}")
    json.dump(rep, open(os.path.join(OUT, "shots_players_report.json"), "w"), indent=1)
    print(f"✅ explore_shots/out/shots_players_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
