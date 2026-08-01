"""
content_insights_advanced.py
=============================
Extension "au-delà des moyennes" de content_insights*.py :
  1. Synergie équipe/gardien : team_record_with_goalie, goal_support_for_goalie,
     xgf_with_goalie
  2. Constance : std_xgf_last10, std_goal_diff_last10 (équipes), std_goalie_gsax
     (gardiens) — qui est "boom or bust" vs "métronome"
  3. Extrêmes historiques : plus gros blowouts, plus grosses surprises (upsets
     vs probabilité du modèle Elo/marché), meilleures perfs de gardien en carrière
     — chacun avec la date exacte
  4. Par équipe : ses 3 meilleures et 3 pires games de l'histoire (date, adversaire,
     score)

Ne touche pas aux modèles de prédiction ni à leur pondération — uniquement des
statistiques descriptives brutes à partir des données réelles déjà collectées
(nhl_games_v4.csv, mp_team_games.csv, mp_goalie_games.csv).

Usage:
    cd ml/python
    python content_insights_advanced.py [--min-starts 15] [--top 5]

Sorties: ml/data/content_insights_advanced.json / .md
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

from insights_common import (
    MIN_GOALIE_STARTS,
    MIN_SYNERGY_STARTS,
    MIN_TEAM_SEASONS,
    active_names,
    apply_significance,
    current_season,
    is_active_team,
    normalize_team,
    split_relocations,
    two_proportion_p,
    welch_p,
)

DATA_DIR = "../data"
GAMES_CSV = os.path.join(DATA_DIR, "nhl_games_v4.csv")
TEAM_CSV = os.path.join(DATA_DIR, "mp_team_games.csv")
GOALIE_CSV = os.path.join(DATA_DIR, "mp_goalie_games.csv")
OUT_JSON = os.path.join(DATA_DIR, "content_insights_advanced.json")
OUT_MD = os.path.join(DATA_DIR, "content_insights_advanced.md")


def load_games():
    df = pd.read_csv(GAMES_CSV)
    df["home_win"] = df["home_win"].astype(float)
    df["date"] = pd.to_datetime(df["date"])
    # Un blowout de 2009 attribué à « UTA » serait faux : la franchise s'appelait
    # Arizona. Même logique pour Atlanta avant 2011.
    df = split_relocations(df, team_col="home_team", season_col="season")
    df = split_relocations(df, team_col="away_team", season_col="season")
    return df


def load_team_games():
    t = pd.read_csv(TEAM_CSV)
    t = t[t["situation"] == "all"].copy()
    t["gameDate"] = pd.to_datetime(t["gameDate"], format="%Y%m%d", errors="coerce")
    t["goal_diff"] = t["goalsFor"] - t["goalsAgainst"]
    # MoneyPuck utilise "L.A" jusqu'en 2020 puis "LAK" : sans normalisation, la
    # même franchise apparaît en tête des plus volatiles ET des plus constantes.
    t["playerTeam"] = normalize_team(t["playerTeam"])
    t = split_relocations(t, team_col="playerTeam", season_col="season")
    return t[["gameId", "playerTeam", "season", "gameDate", "goalsFor", "goalsAgainst",
              "xGoalsFor", "xGoalsAgainst", "goal_diff"]]


def load_goalie_starts():
    g = pd.read_csv(GOALIE_CSV)
    g = g[g["situation"] == "all"].copy()
    g = g[g["icetime"] > 0]
    g["gsax"] = g["xGoals"] - g["goals"]  # buts évités vs attendu (plus = meilleur)
    g["playerTeam"] = normalize_team(g["playerTeam"])
    g = split_relocations(g, team_col="playerTeam", season_col="season")
    # starter = plus gros temps de glace de l'équipe ce match-là
    idx = g.groupby(["gameId", "playerTeam"])["icetime"].idxmax()
    starters = g.loc[idx, ["gameId", "playerTeam", "season", "name", "icetime", "goals",
                           "xGoals", "gsax", "ongoal"]].rename(columns={"name": "goalie"})
    # `is_active` accompagne chaque gardien plutôt que de filtrer d'emblée : les
    # sections « record de tous les temps » doivent pouvoir garder un joueur
    # retraité — un record filtré sur les actifs n'est plus un record.
    active = active_names(starters, name_col="goalie", season_col="season")
    starters["is_active"] = starters["goalie"].isin(active)
    return starters


# ── 1. Synergie équipe / gardien ─────────────────────────────────────────────
def goalie_synergy(team_games: pd.DataFrame, starters: pd.DataFrame,
                    long_results: pd.DataFrame, min_starts: int, top_n: int) -> dict:
    merged = starters.merge(team_games, on=["gameId", "playerTeam"], how="inner")
    merged = merged.merge(
        long_results[["game_id", "team", "win"]],
        left_on=["gameId", "playerTeam"], right_on=["game_id", "team"], how="inner",
    )

    # La synergie décrit un duo en activité : un couple équipe/gardien dissous
    # depuis dix ans ne peut alimenter aucun contenu.
    merged = merged[merged["is_active"]]

    records, support, xgf = [], [], []
    for (team, goalie), g in merged.groupby(["playerTeam", "goalie"]):
        n = len(g)
        if n < max(min_starts, MIN_SYNERGY_STARTS):
            continue
        if not is_active_team(str(team)):
            continue
        team_all = merged[merged["playerTeam"] == team]
        base_win = team_all["win"].mean()
        base_gf = team_all["goalsFor"].mean()
        base_xgf = team_all["xGoalsFor"].mean()

        win_rate = g["win"].mean()
        gf = g["goalsFor"].mean()
        xgf_val = g["xGoalsFor"].mean()

        # Chaque duo est comparé au reste des départs de SON équipe, pas à la
        # moyenne d'équipe qui l'englobe.
        rest = team_all[team_all["goalie"] != goalie]

        records.append({"team": team, "goalie": goalie, "n": int(n),
                         "win_rate_with_goalie": round(float(win_rate), 4),
                         "team_base_win_rate": round(float(base_win), 4),
                         "delta_pp": round(float(win_rate - base_win) * 100, 1),
                         "p_value": round(two_proportion_p(
                             float(g["win"].sum()), n,
                             float(team_all["win"].sum()), len(team_all)), 6)})
        support.append({"team": team, "goalie": goalie, "n": int(n),
                         "goal_support": round(float(gf), 2),
                         "team_base_goal_support": round(float(base_gf), 2),
                         "delta": round(float(gf - base_gf), 2),
                         "p_value": round(welch_p(
                             float(gf), float(g["goalsFor"].var(ddof=1) or 0), n,
                             float(rest["goalsFor"].mean()),
                             float(rest["goalsFor"].var(ddof=1) or 0), len(rest)), 6)})
        xgf.append({"team": team, "goalie": goalie, "n": int(n),
                     "xgf_with_goalie": round(float(xgf_val), 3),
                     "team_base_xgf": round(float(base_xgf), 3),
                     "delta": round(float(xgf_val - base_xgf), 3),
                     "p_value": round(welch_p(
                         float(xgf_val), float(g["xGoalsFor"].var(ddof=1) or 0), n,
                         float(rest["xGoalsFor"].mean()),
                         float(rest["xGoalsFor"].var(ddof=1) or 0), len(rest)), 6)})

    records = apply_significance(records)
    support = apply_significance(support)
    xgf = apply_significance(xgf)

    records.sort(key=lambda r: abs(r["delta_pp"]), reverse=True)
    support.sort(key=lambda r: abs(r["delta"]), reverse=True)
    xgf.sort(key=lambda r: abs(r["delta"]), reverse=True)

    return {
        "team_record_with_goalie": records[:top_n],
        "goal_support_for_goalie": support[:top_n],
        "xgf_with_goalie": xgf[:top_n],
    }


# ── 2. Constance ─────────────────────────────────────────────────────────────
def team_consistency(team_games: pd.DataFrame, top_n: int) -> dict:
    """Fenêtres roulantes de 10 matchs calculées PAR SAISON (jamais à cheval sur
    l'intersaison) — sinon une fenêtre peut mélanger la fin d'une saison et le
    début de la suivante, ce qui fausse la lecture d'un "stretch" réel."""
    out_xgf, out_gd, wildest = [], [], []
    for team, g_team in team_games.groupby("playerTeam"):
        xgf_stds, gd_stds = [], []
        team_wildest = None

        for season, g in g_team.groupby("season"):
            g = g.sort_values("gameDate")
            if len(g) < 10:
                continue
            roll_xgf = g["xGoalsFor"].rolling(10).std()
            roll_gd = g["goal_diff"].rolling(10).std()

            xgf_stds.append(roll_xgf.dropna())
            gd_stds.append(roll_gd.dropna())

            peak_idx = roll_gd.idxmax()
            if pd.notna(peak_idx):
                peak_val = roll_gd.loc[peak_idx]
                if team_wildest is None or peak_val > team_wildest["val"]:
                    end_date = g.loc[peak_idx, "gameDate"]
                    window = g.loc[:peak_idx].tail(10)
                    team_wildest = {
                        "val": peak_val,
                        "season": int(season),
                        "window_end_date": str(end_date.date()) if pd.notna(end_date) else None,
                        "window_start_date": str(window["gameDate"].min().date()) if len(window) else None,
                    }

        # Deux exclusions, pour des raisons distinctes. Une franchise disparue
        # (ATL, ARI) n'a pas sa place dans un classement d'équipes actuelles. Et
        # une équipe suivie sur trois saisons n'est pas comparable à une suivie
        # sur dix-huit : sans plancher, c'est la brièveté de l'historique qui
        # décide du classement, pas la constance du jeu.
        if not is_active_team(str(team)) or len(xgf_stds) < MIN_TEAM_SEASONS:
            continue
        out_xgf.append({"team": team, "seasons": len(xgf_stds),
                        "std_xgf_last10_avg": round(float(pd.concat(xgf_stds).mean()), 3)})
        out_gd.append({"team": team, "seasons": len(gd_stds),
                       "std_goal_diff_last10_avg": round(float(pd.concat(gd_stds).mean()), 3)})

        if team_wildest is not None:
            wildest.append({
                "team": team,
                "std_goal_diff_10games": round(float(team_wildest["val"]), 3),
                "season": team_wildest["season"],
                "window_start_date": team_wildest["window_start_date"],
                "window_end_date": team_wildest["window_end_date"],
            })

    out_xgf.sort(key=lambda r: r["std_xgf_last10_avg"], reverse=True)
    out_gd.sort(key=lambda r: r["std_goal_diff_last10_avg"], reverse=True)
    wildest.sort(key=lambda r: r["std_goal_diff_10games"], reverse=True)

    return {
        "most_volatile_xgf": out_xgf[:top_n],
        "most_consistent_xgf": list(reversed(out_xgf))[:top_n],
        "most_volatile_goal_diff": out_gd[:top_n],
        "most_consistent_goal_diff": list(reversed(out_gd))[:top_n],
        "wildest_10game_stretch_ever": wildest[:top_n],
    }


def goalie_consistency(starters: pd.DataFrame, min_starts: int, top_n: int) -> dict:
    # Constance = comment un gardien se comporte AUJOURD'HUI. Les listes étaient
    # remplies de Tellqvist, Legace et Mazanec, retraités et vus sur 16 à 46
    # départs : deux problèmes à la fois, plus actifs et trop peu de matchs.
    active_only = starters[starters["is_active"]]

    results = []
    for goalie, g in active_only.groupby("goalie"):
        n = len(g)
        if n < max(min_starts, MIN_GOALIE_STARTS):
            continue
        results.append({
            "goalie": goalie, "n": int(n),
            "avg_gsax": round(float(g["gsax"].mean()), 3),
            "std_goalie_gsax": round(float(g["gsax"].std()), 3),
            "is_active": True,
        })
    most_volatile = sorted(results, key=lambda r: r["std_goalie_gsax"], reverse=True)[:top_n]
    most_steady = sorted(results, key=lambda r: r["std_goalie_gsax"])[:top_n]
    return {"most_volatile_goalies": most_volatile, "most_steady_goalies": most_steady}


# ── 3. Extrêmes historiques ───────────────────────────────────────────────────
def historical_extremes(games: pd.DataFrame, starters: pd.DataFrame, top_n: int) -> dict:
    g = games.copy()
    g["goal_diff_abs"] = (g["home_score"] - g["away_score"]).abs()
    blowouts = g.sort_values("goal_diff_abs", ascending=False).head(top_n)
    blowout_list = [{
        "date": str(r["date"].date()), "home": r["home_team"], "away": r["away_team"],
        "score": f"{int(r['home_score'])}-{int(r['away_score'])}",
        "goal_diff": int(r["goal_diff_abs"]),
    } for _, r in blowouts.iterrows()]

    upsets = []
    if "elo_expected" in g.columns:
        gg = g.dropna(subset=["elo_expected"]).copy()
        gg["upset_magnitude"] = (gg["home_win"] - gg["elo_expected"]).abs()
        # only keep actual upsets: underdog (elo_expected far from 0.5) that won
        gg["underdog_won"] = (
            ((gg["elo_expected"] < 0.4) & (gg["home_win"] == 1)) |
            ((gg["elo_expected"] > 0.6) & (gg["home_win"] == 0))
        )
        top_upsets = gg[gg["underdog_won"]].sort_values("upset_magnitude", ascending=False).head(top_n)
        upsets = [{
            "date": str(r["date"].date()), "home": r["home_team"], "away": r["away_team"],
            "score": f"{int(r['home_score'])}-{int(r['away_score'])}",
            "home_win_probability_pre_game": round(float(r["elo_expected"]), 3),
            "winner": r["home_team"] if r["home_win"] == 1 else r["away_team"],
        } for _, r in top_upsets.iterrows()]

    best_goalie_games = starters.merge(
        games[["game_id", "date", "home_team", "away_team"]],
        left_on="gameId", right_on="game_id", how="inner"
    ).sort_values("gsax", ascending=False).head(top_n)
    best_goalie_list = [{
        "date": str(r["date"].date()), "goalie": r["goalie"], "team": r["playerTeam"],
        "gsax": round(float(r["gsax"]), 2), "goals_allowed": int(r["goals"]),
        "shots_faced": round(float(r["ongoal"]), 1),
        "opponent": r["away_team"] if r["playerTeam"] == r["home_team"] else r["home_team"],
        # Pas de filtre ici — c'est un record de tous les temps. Le drapeau laisse
        # l'étape éditoriale préférer un joueur actif quand elle a le choix.
        "is_active": bool(r["is_active"]),
    } for _, r in best_goalie_games.iterrows()]

    return {
        "biggest_blowouts_ever": blowout_list,
        "biggest_upsets_ever": upsets,
        "best_single_game_goalie_performances_ever": best_goalie_list,
    }


def per_team_best_worst_games(games: pd.DataFrame, n_each: int = 3) -> dict:
    g = games.copy()
    home = g[["game_id", "date", "home_team", "away_team", "home_score", "away_score"]].rename(
        columns={"home_team": "team", "away_team": "opponent", "home_score": "gf", "away_score": "ga"})
    away = g[["game_id", "date", "away_team", "home_team", "away_score", "home_score"]].rename(
        columns={"away_team": "team", "home_team": "opponent", "away_score": "gf", "home_score": "ga"})
    long_g = pd.concat([home, away], ignore_index=True)
    long_g["goal_diff"] = long_g["gf"] - long_g["ga"]

    out = {}
    for team, grp in long_g.groupby("team"):
        best = grp.sort_values("goal_diff", ascending=False).head(n_each)
        worst = grp.sort_values("goal_diff", ascending=True).head(n_each)
        out[team] = {
            "best_games": [{"date": str(r["date"].date()), "opponent": r["opponent"],
                             "score": f"{int(r['gf'])}-{int(r['ga'])}"} for _, r in best.iterrows()],
            "worst_games": [{"date": str(r["date"].date()), "opponent": r["opponent"],
                              "score": f"{int(r['gf'])}-{int(r['ga'])}"} for _, r in worst.iterrows()],
        }
    return out


def to_long_results(games: pd.DataFrame) -> pd.DataFrame:
    home = games[["game_id", "home_team", "home_win"]].rename(
        columns={"home_team": "team", "home_win": "win"})
    away = games[["game_id", "away_team", "home_win"]].rename(columns={"away_team": "team"})
    away["win"] = 1 - games["home_win"]
    return pd.concat([home, away], ignore_index=True)


def write_md(data: dict, path: str):
    lines = ["# ICEEDGE — Insights avancés (au-delà des moyennes)\n"]

    lines.append("\n## Synergie équipe / gardien\n")
    lines.append("### Écart de taux de victoire selon le gardien titulaire")
    for r in data["goalie_synergy"]["team_record_with_goalie"]:
        lines.append(f"- **{r['team']} avec {r['goalie']}** : {r['win_rate_with_goalie']*100:.1f}% de victoires "
                      f"(moyenne équipe: {r['team_base_win_rate']*100:.1f}%, écart {r['delta_pp']:+.1f} pts, n={r['n']})")
    lines.append("\n### Soutien offensif reçu selon le gardien (buts marqués par l'équipe)")
    for r in data["goalie_synergy"]["goal_support_for_goalie"]:
        lines.append(f"- **{r['team']} devant {r['goalie']}** : {r['goal_support']:.2f} buts/match "
                      f"(moyenne équipe: {r['team_base_goal_support']:.2f}, écart {r['delta']:+.2f}, n={r['n']})")
    lines.append("\n### xG offensif généré selon le gardien en poste")
    for r in data["goalie_synergy"]["xgf_with_goalie"]:
        lines.append(f"- **{r['team']} devant {r['goalie']}** : {r['xgf_with_goalie']:.3f} xG/match "
                      f"(moyenne équipe: {r['team_base_xgf']:.3f}, écart {r['delta']:+.3f}, n={r['n']})")

    lines.append("\n## Constance des équipes\n")
    lines.append("### Équipes les plus \"boom or bust\" (écart-type xG offensif sur 10 matchs)")
    for r in data["team_consistency"]["most_volatile_xgf"]:
        lines.append(f"- {r['team']} : écart-type {r['std_xgf_last10_avg']}")
    lines.append("\n### Équipes les plus \"métronome\" (xG offensif le plus stable)")
    for r in data["team_consistency"]["most_consistent_xgf"]:
        lines.append(f"- {r['team']} : écart-type {r['std_xgf_last10_avg']}")
    lines.append("\n### Le stretch de 10 matchs le plus chaotique de l'histoire de chaque équipe (différentiel de buts, sans chevauchement de saison)")
    for r in data["team_consistency"]["wildest_10game_stretch_ever"]:
        lines.append(f"- **{r['team']}** (saison {r['season']}) : écart-type {r['std_goal_diff_10games']} entre "
                      f"{r['window_start_date']} et {r['window_end_date']}")

    lines.append("\n## Constance des gardiens (GSAx = buts évités vs attendu)\n")
    lines.append("### Gardiens les plus imprévisibles")
    for r in data["goalie_consistency"]["most_volatile_goalies"]:
        lines.append(f"- {r['goalie']} : écart-type GSAx {r['std_goalie_gsax']} (moyenne {r['avg_gsax']}, n={r['n']})")
    lines.append("\n### Gardiens les plus réguliers")
    for r in data["goalie_consistency"]["most_steady_goalies"]:
        lines.append(f"- {r['goalie']} : écart-type GSAx {r['std_goalie_gsax']} (moyenne {r['avg_gsax']}, n={r['n']})")

    lines.append("\n## Extrêmes historiques\n")
    lines.append("### Plus gros blowouts de l'historique")
    for r in data["historical_extremes"]["biggest_blowouts_ever"]:
        lines.append(f"- {r['date']} : {r['home']} {r['score']} {r['away']} (écart {r['goal_diff']} buts)")
    lines.append("\n### Plus grosses surprises vs le modèle Elo")
    for r in data["historical_extremes"]["biggest_upsets_ever"]:
        lines.append(f"- {r['date']} : {r['home']} {r['score']} {r['away']} — "
                      f"{r['winner']} gagne alors que sa proba pré-match était de "
                      f"{r['home_win_probability_pre_game']*100:.1f}% (côté domicile)")
    lines.append("\n### Meilleures performances de gardien (une seule game) de l'historique")
    for r in data["historical_extremes"]["best_single_game_goalie_performances_ever"]:
        lines.append(f"- {r['date']} : {r['goalie']} ({r['team']} vs {r['opponent']}) — "
                      f"GSAx {r['gsax']:+.2f}, {r['goals_allowed']} but(s) sur {r['shots_faced']:.0f} tirs")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-starts", type=int, default=15)
    parser.add_argument("--top", type=int, default=5)
    args = parser.parse_args()

    games = load_games()
    team_games = load_team_games()
    starters = load_goalie_starts()
    long_results = to_long_results(games)

    data = {
        "goalie_synergy": goalie_synergy(team_games, starters, long_results, args.min_starts, args.top),
        "team_consistency": team_consistency(team_games, args.top),
        "goalie_consistency": goalie_consistency(starters, args.min_starts, args.top),
        "historical_extremes": historical_extremes(games, starters, args.top),
    }
    per_team = per_team_best_worst_games(games, n_each=3)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DATA_DIR, "content_insights_per_team_games.json"), "w", encoding="utf-8") as f:
        json.dump(per_team, f, ensure_ascii=False, indent=2)
    write_md(data, OUT_MD)

    print(f"Écrit: {OUT_JSON}")
    print(f"Écrit: {OUT_MD}")
    print(f"Écrit: content_insights_per_team_games.json ({len(per_team)} équipes)")


if __name__ == "__main__":
    main()
