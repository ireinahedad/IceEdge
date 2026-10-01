"""
fetch_live_goals.py
===================
Buts HORODATÉS de chaque match de saison régulière, pour mesurer les effets de
score des prédictions en direct (`LIVE_PREDICTIONS_PLAN.md`, étape 5).

Source : les fichiers de tirs MoneyPuck (`shots_{saison}.zip`, ~20 Mo par
saison), qui listent chaque but avec le temps écoulé, le score AVANT le but,
le filet désert et le nombre de patineurs. Les fusillades n'y figurent pas, ce
qui tombe bien : seul le temps réglementaire est mesuré.

Contrôle : les buts réglementaires de chaque match doivent recoller au score
réglementaire de `nhl_games_v4.csv` (`home_reg_score`, `away_reg_score`). Un
match qui ne recolle pas est écarté et compté, jamais corrigé.

Sorties (ignorées par git, comme tout `ml/data/*.csv`) :
    ml/data/live_goals.csv   un but par ligne (temps réglementaire seulement)
    ml/data/live_games.csv   un match par ligne (matchs contrôlés, même sans but)

Usage :
    cd ml/python
    python fetch_live_goals.py                     # 2010-11 → 2025-26
    python fetch_live_goals.py --first 2015 --last 2024
    python fetch_live_goals.py --from-local        # zips déjà dans data/raw/shots
"""

import argparse
import io
import os
import sys
import zipfile

import pandas as pd

from fetch_data_v4 import DATA_DIR, http_get, norm_team

SHOTS_URL = "https://peter-tanner.com/moneypuck/downloads/shots_{season}.zip"
RAW_DIR   = os.path.join(DATA_DIR, "raw", "shots")
REG_END   = 3600   # fin du temps réglementaire, en secondes écoulées

COLS = ["game_id", "season", "isPlayoffGame", "period", "time", "event", "goal",
        "isHomeTeam", "homeTeamGoals", "awayTeamGoals", "shotOnEmptyNet",
        "homeSkatersOnIce", "awaySkatersOnIce", "homeTeamCode", "awayTeamCode",
        "shooterPlayerId"]


def load_season(season: int, from_local: bool) -> pd.DataFrame | None:
    path = os.path.join(RAW_DIR, f"shots_{season}.zip")
    if not os.path.exists(path):
        if from_local:
            print(f"  [WARN] {path} absent"); return None
        r = http_get(SHOTS_URL.format(season=season), timeout=600)
        if r is None:
            print(f"  [WARN] shots_{season}.zip introuvable"); return None
        os.makedirs(RAW_DIR, exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(r.content)
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        with z.open(name) as fh:
            df = pd.read_csv(io.TextIOWrapper(fh, encoding="utf-8"), usecols=COLS)
    df = df[df["isPlayoffGame"] == 0]
    # Identifiant NHL : 2023 + 02 + 0001 → 2023020001 (MoneyPuck garde 20001).
    df["nhl_id"] = df["season"].astype(int) * 1_000_000 + df["game_id"].astype(int)
    return df


def season_tables(df: pd.DataFrame, ref: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    games = (df.groupby("nhl_id")
               .agg(season=("season", "first"),
                    home_team=("homeTeamCode", "first"),
                    away_team=("awayTeamCode", "first"))
               .reset_index().rename(columns={"nhl_id": "game_id"}))
    games["home_team"] = games["home_team"].map(norm_team)
    games["away_team"] = games["away_team"].map(norm_team)

    g = df[(df["event"] == "GOAL") & (df["time"] < REG_END) & (df["period"] <= 3)].copy()
    goals = pd.DataFrame({
        "game_id":    g["nhl_id"].astype(int),
        "period":     g["period"].astype(int),
        "time":       g["time"].astype(int),
        "home_scored": g["isHomeTeam"].astype(int),
        "home_before": g["homeTeamGoals"].astype(int),
        "away_before": g["awayTeamGoals"].astype(int),
        "empty_net":  g["shotOnEmptyNet"].fillna(0).astype(int),
        "home_skaters": g["homeSkatersOnIce"].astype(int),
        "away_skaters": g["awaySkatersOnIce"].astype(int),
        "scorer_id":  g["shooterPlayerId"].fillna(0).astype("int64"),
    }).sort_values(["game_id", "time"], kind="stable")

    # Contrôle contre le score réglementaire officiel.
    cnt = (goals.groupby("game_id")["home_scored"]
                .agg(home_reg="sum", n="count").reset_index())
    cnt["away_reg"] = cnt["n"] - cnt["home_reg"]
    chk = games.merge(cnt[["game_id", "home_reg", "away_reg"]], on="game_id", how="left").fillna(
        {"home_reg": 0, "away_reg": 0})
    chk = chk.merge(ref, on="game_id", how="left", suffixes=("", "_ref"))
    unknown = chk["home_reg_score"].isna()
    ok = (~unknown
          & (chk["home_reg"] == chk["home_reg_score"]) & (chk["away_reg"] == chk["away_reg_score"])
          & (chk["home_team"] == chk["home_team_ref"]) & (chk["away_team"] == chk["away_team_ref"]))
    # Le score AVANT chaque but doit suivre le décompte : sinon la séquence est trouée.
    seq = goals.copy()
    seq["h_run"] = seq.groupby("game_id")["home_scored"].cumsum() - seq["home_scored"]
    seq["a_run"] = seq.groupby("game_id").cumcount() - seq["h_run"]
    bad_seq = set(seq.loc[(seq["h_run"] != seq["home_before"]) | (seq["a_run"] != seq["away_before"]),
                          "game_id"])
    ok &= ~chk["game_id"].isin(bad_seq)

    keep = chk[ok]
    stats = {"games": len(chk), "kept": int(ok.sum()), "unknown": int(unknown.sum()),
             "mismatch": int((~ok & ~unknown).sum())}
    out_games = keep[["game_id", "season", "date", "home_team", "away_team",
                      "home_reg_score", "away_reg_score", "home_score", "away_score",
                      "went_to_ot"]].astype({"home_reg_score": int, "away_reg_score": int,
                                             "home_score": int, "away_score": int,
                                             "went_to_ot": int})
    return out_games, goals[goals["game_id"].isin(set(keep["game_id"]))], stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--first", type=int, default=2010)
    p.add_argument("--last", type=int, default=2025)
    p.add_argument("--from-local", action="store_true")
    a = p.parse_args()

    ref_path = os.path.join(DATA_DIR, "nhl_games_v4.csv")
    if not os.path.exists(ref_path):
        print(f"❌ {ref_path} absent : lancer build_dataset.py d'abord"); sys.exit(1)
    ref = pd.read_csv(ref_path, usecols=["game_id", "date", "home_team", "away_team",
                                         "home_score", "away_score", "home_reg_score",
                                         "away_reg_score", "went_to_ot"])
    ref = ref.rename(columns={"home_team": "home_team_ref", "away_team": "away_team_ref"})
    ref["home_team_ref"] = ref["home_team_ref"].map(norm_team)
    ref["away_team_ref"] = ref["away_team_ref"].map(norm_team)

    all_games, all_goals = [], []
    for season in range(a.first, a.last + 1):
        df = load_season(season, a.from_local)
        if df is None or df.empty:
            continue
        games, goals, st = season_tables(df, ref)
        print(f"  {season}-{str(season + 1)[2:]} : {st['kept']}/{st['games']} matchs gardés "
              f"({st['mismatch']} ne recollent pas, {st['unknown']} absents de nhl_games_v4), "
              f"{len(goals)} buts")
        all_games.append(games); all_goals.append(goals)

    if not all_games:
        print("❌ aucune saison lue"); sys.exit(1)
    games = pd.concat(all_games, ignore_index=True)
    goals = pd.concat(all_goals, ignore_index=True)
    games.to_csv(os.path.join(DATA_DIR, "live_games.csv"), index=False)
    goals.to_csv(os.path.join(DATA_DIR, "live_goals.csv"), index=False)
    print(f"✅ {len(games)} matchs → data/live_games.csv, {len(goals)} buts → data/live_goals.csv")


if __name__ == "__main__":
    main()
