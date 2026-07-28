"""
content_insights_team_player.py
================================
Extension de content_insights.py : au lieu d'un écart de taux au niveau ligue,
calcule pour chaque ÉQUIPE (et chaque GARDIEN) l'écart de taux de victoire /
% arrêts entre une situation (back-to-back, repos, décalage horaire, altitude,
road trip) et SA PROPRE moyenne — puis classe les 5 plus gros écarts.

Ne touche pas aux modèles de prédiction (game_model.json, totals_model.json,
feature_importance_*.json) : uniquement des statistiques descriptives brutes.

Usage:
    cd ml/python
    python content_insights_team_player.py [--min-n 15] [--top 5]

Sorties:
    ml/data/content_insights_teams.json / .md
    ml/data/content_insights_goalies.json / .md
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

DATA_DIR = "../data"
GAMES_CSV = os.path.join(DATA_DIR, "nhl_games_v4.csv")
GOALIE_CSV = os.path.join(DATA_DIR, "mp_goalie_games.csv")

TEAM_FACTORS = [
    ("b2b", "back-to-back", "bool"),
    ("3in4", "3 matchs en 4 soirs", "bool"),
    ("rest_days", "jours de repos", "bucket"),
    ("tz_shift", "décalage horaire", "bucket"),
    ("distance_km", "distance parcourue", "bucket"),
    ("alt_gain", "gain d'altitude", "bucket"),
    ("road_trip_len", "longueur du road trip", "bucket"),
    ("days_away", "jours loin de la maison", "bucket"),
    ("getaway", "getaway game", "bool"),
]


def bucketize(series: pd.Series, n_buckets: int = 3) -> pd.Series:
    nunique = series.nunique(dropna=True)
    if nunique <= n_buckets:
        return series.round(0)
    try:
        return pd.qcut(series, q=n_buckets, duplicates="drop")
    except ValueError:
        return series.round(0)


def to_long(games: pd.DataFrame) -> pd.DataFrame:
    """Reshape home/away game rows into one row per (team, game)."""
    home_cols = {c: c.replace("home_", "") for c in games.columns if c.startswith("home_")}
    away_cols = {c: c.replace("away_", "") for c in games.columns if c.startswith("away_")}
    common = ["game_id", "season", "date"]

    home = games[common + list(home_cols)].rename(columns=home_cols)
    home["team"] = games["home_team"]
    home["is_home"] = 1
    home["win"] = games["home_win"]

    away = games[common + list(away_cols)].rename(columns=away_cols)
    away["team"] = games["away_team"]
    away["is_home"] = 0
    away["win"] = 1 - games["home_win"]

    long_df = pd.concat([home, away], ignore_index=True, sort=False)
    return long_df


def analyze_teams(long_df: pd.DataFrame, min_n: int, top_n: int) -> list[dict]:
    results = []
    for team, g in long_df.groupby("team"):
        base_rate = g["win"].mean()
        for col, label, kind in TEAM_FACTORS:
            if col not in g.columns:
                continue
            sub = g[[col, "win"]].dropna()
            if sub.empty:
                continue
            if kind == "bool":
                buckets = {str(v): d for v, d in sub.groupby(col)}
            else:
                b = bucketize(sub[col])
                buckets = {str(v): d for v, d in sub.assign(_b=b).groupby("_b", observed=True)}
                buckets = {k: v[["win"]] for k, v in buckets.items()}
            for key, d in buckets.items():
                n = len(d)
                if n < min_n:
                    continue
                rate = d["win"].mean()
                delta = (rate - base_rate) * 100
                results.append({
                    "team": team, "factor": col, "label": label, "bucket": key,
                    "n": int(n), "rate": round(float(rate), 4),
                    "team_base_rate": round(float(base_rate), 4),
                    "delta_pp": round(float(delta), 1),
                })
    results.sort(key=lambda r: abs(r["delta_pp"]), reverse=True)
    # keep only the single biggest split per (team, factor) to avoid repeats
    seen = set()
    deduped = []
    for r in results:
        key = (r["team"], r["factor"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped[:top_n]


def analyze_goalies(long_df: pd.DataFrame, min_n: int, top_n: int) -> list[dict]:
    if not os.path.exists(GOALIE_CSV):
        return []
    goalies = pd.read_csv(GOALIE_CSV)
    goalies = goalies[goalies["situation"] == "all"].copy()
    goalies = goalies[goalies["icetime"] > 0]
    goalies["save_pct"] = 1 - (goalies["goals"] / goalies["ongoal"].replace(0, np.nan))
    goalies = goalies.dropna(subset=["save_pct"])

    merged = goalies.merge(
        long_df[["game_id", "team"] + [c for c, _, _ in TEAM_FACTORS if c in long_df.columns]],
        left_on=["gameId", "playerTeam"], right_on=["game_id", "team"], how="inner",
    )

    results = []
    for name, g in merged.groupby("name"):
        if len(g) < min_n * 2:  # need enough starts overall to split meaningfully
            continue
        base_rate = g["save_pct"].mean()
        for col, label, kind in TEAM_FACTORS:
            if col not in g.columns:
                continue
            sub = g[[col, "save_pct"]].dropna()
            if sub.empty:
                continue
            if kind == "bool":
                buckets = {str(v): d for v, d in sub.groupby(col)}
            else:
                b = bucketize(sub[col])
                buckets = {str(v): d for v, d in sub.assign(_b=b).groupby("_b", observed=True)}
                buckets = {k: v[["save_pct"]] for k, v in buckets.items()}
            for key, d in buckets.items():
                n = len(d)
                if n < min_n:
                    continue
                rate = d["save_pct"].mean()
                delta = (rate - base_rate) * 100
                results.append({
                    "goalie": name, "factor": col, "label": label, "bucket": key,
                    "n": int(n), "save_pct": round(float(rate), 4),
                    "goalie_base_save_pct": round(float(base_rate), 4),
                    "delta_pp": round(float(delta), 2),
                })
    results.sort(key=lambda r: abs(r["delta_pp"]), reverse=True)
    seen = set()
    deduped = []
    for r in results:
        key = (r["goalie"], r["factor"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped[:top_n]


def write_outputs(items: list[dict], json_path: str, md_path: str, title: str,
                   entity_key: str, rate_key: str, base_key: str, rate_label: str):
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    lines = [f"# {title}\n"]
    for it in items:
        direction = "plus" if it["delta_pp"] > 0 else "moins"
        lines.append(
            f"- **{it[entity_key]}** — {it['label']} = {it['bucket']} → "
            f"{rate_label} de {it[rate_key]*100:.1f}% "
            f"(moyenne perso: {it[base_key]*100:.1f}%, {direction} fort de "
            f"{abs(it['delta_pp']):.1f} pts, n={it['n']})"
        )
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-n", type=int, default=15,
                         help="taille min. d'échantillon par (équipe/gardien, situation)")
    parser.add_argument("--top", type=int, default=5)
    args = parser.parse_args()

    games = pd.read_csv(GAMES_CSV)
    games["home_win"] = games["home_win"].astype(float)
    long_df = to_long(games)

    team_top = analyze_teams(long_df, args.min_n, args.top)
    write_outputs(
        team_top,
        os.path.join(DATA_DIR, "content_insights_teams.json"),
        os.path.join(DATA_DIR, "content_insights_teams.md"),
        "ICEEDGE — Top équipes par écart de taux de victoire (vs leur propre moyenne)",
        entity_key="team", rate_key="rate", base_key="team_base_rate",
        rate_label="taux de victoire",
    )

    goalie_top = analyze_goalies(long_df, args.min_n, args.top)
    write_outputs(
        goalie_top,
        os.path.join(DATA_DIR, "content_insights_goalies.json"),
        os.path.join(DATA_DIR, "content_insights_goalies.md"),
        "ICEEDGE — Top gardiens par écart de % d'arrêts (vs leur propre moyenne)",
        entity_key="goalie", rate_key="save_pct", base_key="goalie_base_save_pct",
        rate_label="% d'arrêts",
    )

    print(f"Équipes -> content_insights_teams.md ({len(team_top)} items)")
    for it in team_top:
        print(f"  {it['team']}: {it['label']}={it['bucket']} -> {it['rate']*100:.1f}% "
              f"(perso {it['team_base_rate']*100:.1f}%, n={it['n']})")

    print(f"\nGardiens -> content_insights_goalies.md ({len(goalie_top)} items)")
    for it in goalie_top:
        print(f"  {it['goalie']}: {it['label']}={it['bucket']} -> {it['save_pct']*100:.1f}% "
              f"(perso {it['goalie_base_save_pct']*100:.1f}%, n={it['n']})")


if __name__ == "__main__":
    main()
