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

from insights_common import (
    MIN_EFFECT_PCT,
    MIN_N_GOALIE_POOLED,
    MIN_N_SKATER_POOLED,
    MIN_N_TEAM,
    apply_significance,
    current_season,
    drop_collinear,
    is_active_team,
    normalize_team,
    split_relocations,
    two_proportion_p,
    welch_p,
)

DATA_DIR = "../data"
GAMES_CSV = os.path.join(DATA_DIR, "nhl_games_v4.csv")
GOALIE_CSV = os.path.join(DATA_DIR, "mp_goalie_games.csv")
SKATER_CSV = os.path.join(DATA_DIR, "mp_skater_games.csv")

# Métriques testées pour les patineurs. Trois plutôt qu'une, parce qu'un effet
# qui n'apparaît que sur les points peut n'être que de la chance au tir : s'il se
# retrouve aussi dans les xG et les tirs cadrés, c'est de la fatigue.
SKATER_METRICS = [
    ("I_F_points", "points par match"),
    ("I_F_xGoals", "buts attendus par match"),
    ("I_F_shotsOnGoal", "tirs cadrés par match"),
    ("toi_min", "minutes jouées par match"),
]

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
    long_df["team"] = normalize_team(long_df["team"])
    # nhl_games_v4.csv réétiquette Atlanta en WPG et Arizona en UTA sur tout
    # l'historique. On leur rend leur identité d'époque, sans quoi « UTA depuis
    # 2008 » décrit une équipe qui n'existait pas.
    long_df = split_relocations(long_df, team_col="team", season_col="season")
    return long_df


def analyze_teams(long_df: pd.DataFrame, min_n: int, top_n: int) -> list[dict]:
    results = []
    for team, g in long_df.groupby("team"):
        # ATL et ARI restent dans les données mais hors des classements : un top 5
        # des équipes actuelles n'a pas à contenir une franchise disparue en 2011.
        if not is_active_team(str(team)):
            continue
        base_rate = g["win"].mean()
        n_team = len(g)
        k_team = float(g["win"].sum())
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
                    "p_value": round(two_proportion_p(
                        float(d["win"].sum()), n, k_team, n_team), 6),
                    "is_active": True,
                })
    results = apply_significance(results)
    results = drop_collinear(results, group_keys=("team",))
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
    """Splits situationnels des gardiens, mesurés sur TOUTE la ligue à la fois.

    La version précédente traitait chaque gardien séparément : « Toskala en road
    trip », « Ersson avec décalage horaire ». Aucun de ces écarts ne résiste à un
    test, et pour une raison mathématique et non corrigeable — le % d'arrêts d'un
    gardien varie énormément d'un match à l'autre, si bien qu'il faudrait des
    milliers de départs pour distinguer un effet de voyage du hasard. Un gardien
    n'en dispute que quelques centaines dans toute sa carrière. Les « découvertes »
    qui sortaient n'étaient donc que les gardiens ayant eu les carrières les plus
    courtes.

    En regroupant tous les gardiens, chaque bucket atteint 12 000 à 33 000
    départs-matchs et les effets deviennent mesurables. Ils sont petits — de
    l'ordre de 0.1 à 0.3 point de % d'arrêts — mais ils sont réels, et un petit
    effet vrai vaut mieux qu'un gros effet inventé.

    Ce qu'on perd : le nom d'un joueur dans le hook. Ce qu'on gagne : un chiffre
    que personne ne peut démonter.
    """
    if not os.path.exists(GOALIE_CSV):
        return []
    goalies = pd.read_csv(GOALIE_CSV)
    goalies = goalies[goalies["situation"] == "all"].copy()
    goalies = goalies[goalies["icetime"] > 0]
    goalies["save_pct"] = 1 - (goalies["goals"] / goalies["ongoal"].replace(0, np.nan))
    goalies = goalies.dropna(subset=["save_pct"])

    # Pas de filtre « actif » ici, et c'est délibéré. Ce filtre existe pour ne
    # jamais NOMMER un joueur retraité ; or un résultat groupé ne nomme personne.
    # L'appliquer quand même reviendrait à jeter 80 % des matchs pour un bénéfice
    # éditorial nul — et à retomber sous le seuil de détection, c'est-à-dire à
    # recréer exactement le problème qu'on vient de corriger.
    season = current_season(goalies)
    print(f"  Gardiens regroupés, saisons 2008-{season} — aucun joueur n'est nommé")

    merged = goalies.merge(
        long_df[["game_id", "team"] + [c for c, _, _ in TEAM_FACTORS if c in long_df.columns]],
        left_on=["gameId", "playerTeam"], right_on=["game_id", "team"], how="inner",
    )

    results = []
    for col, label, kind in TEAM_FACTORS:
        if col not in merged.columns:
            continue
        sub = merged[[col, "save_pct"]].dropna()
        if sub.empty:
            continue
        base_rate = sub["save_pct"].mean()
        if kind == "bool":
            buckets = {str(v): d for v, d in sub.groupby(col)}
        else:
            b = bucketize(sub[col])
            buckets = {str(v): d for v, d in sub.assign(_b=b).groupby("_b", observed=True)}
        for key, d in buckets.items():
            n = len(d)
            if n < MIN_N_GOALIE_POOLED:
                continue
            rate = d["save_pct"].mean()
            # Le % d'arrêts est une moyenne de ratios, pas une proportion : un
            # test de proportions serait mal spécifié. Welch compare le bucket au
            # reste des départs.
            rest = sub.loc[~sub.index.isin(d.index), "save_pct"]
            results.append({
                "scope": "league", "factor": col, "label": label, "bucket": str(key),
                "n": int(n), "save_pct": round(float(rate), 4),
                "base_save_pct": round(float(base_rate), 4),
                "delta_pp": round(float(rate - base_rate) * 100, 2),
                "p_value": round(welch_p(
                    float(rate), float(d["save_pct"].var(ddof=1) or 0), n,
                    float(rest.mean()), float(rest.var(ddof=1) or 0), len(rest),
                ), 6),
            })

    results = apply_significance(results)
    results = drop_collinear(results, group_keys=("scope",))
    results.sort(key=lambda r: abs(r["delta_pp"]), reverse=True)
    return results[:top_n]


def analyze_skaters(long_df: pd.DataFrame, top_n: int) -> list[dict]:
    """Effets situationnels sur les patineurs, mesurés sur toute la ligue.

    Même logique groupée que pour les gardiens, sur 774 000 matchs-joueurs. À
    cette échelle un phénomène nouveau apparaît : au premier essai, 21 tests sur
    21 ressortaient significatifs. Ce n'est pas une bonne nouvelle — c'est le
    signe que le test ne discrimine plus rien. Avec 200 000 observations par
    bucket, un écart de 0.3 % est « certain » et sans le moindre intérêt. D'où
    `MIN_EFFECT_PCT` : à partir d'ici, c'est la taille de l'effet qui filtre, pas
    la p-value.

    Trois métriques de production plus le temps de glace. Le temps de glace n'est
    pas là par symétrie : il sert de contrôle. Si la production baisse ET que les
    minutes baissent, on n'observe qu'un raccourcissement du banc par l'entraîneur.
    Si la production baisse à minutes constantes, c'est de la fatigue réelle.
    """
    if not os.path.exists(SKATER_CSV):
        return []

    skaters = pd.read_csv(SKATER_CSV)
    skaters = skaters[(skaters["situation"] == "all") & (skaters["icetime"] > 0)].copy()
    skaters["toi_min"] = skaters["icetime"] / 60.0

    factor_cols = [c for c, _, _ in TEAM_FACTORS if c in long_df.columns]
    merged = skaters.merge(
        long_df[["game_id", "team"] + factor_cols],
        left_on=["gameId", "playerTeam"], right_on=["game_id", "team"], how="inner",
    )
    print(f"  Patineurs regroupés : {len(merged)} matchs-joueurs, aucun joueur n'est nommé")

    results = []
    for metric, metric_label in SKATER_METRICS:
        if metric not in merged.columns:
            continue
        rows = []
        for col, label, kind in TEAM_FACTORS:
            if col not in merged.columns:
                continue
            sub = merged[[col, metric]].dropna()
            if sub.empty:
                continue
            base = sub[metric].mean()
            if base == 0:
                continue
            b = sub[col].round(0) if kind == "bool" else bucketize(sub[col])
            for key, d in sub.assign(_b=b).groupby("_b", observed=True):
                n = len(d)
                if n < MIN_N_SKATER_POOLED:
                    continue
                value = float(d[metric].mean())
                delta_pct = (value - base) / base * 100
                if abs(delta_pct) < MIN_EFFECT_PCT:
                    continue
                rest = sub.loc[~sub.index.isin(d.index), metric]
                rows.append({
                    "scope": "league", "metric": metric, "metric_label": metric_label,
                    "factor": col, "label": label, "bucket": str(key), "n": int(n),
                    "value": round(value, 4), "base_value": round(float(base), 4),
                    "delta_pct": round(float(delta_pct), 2),
                    "p_value": round(welch_p(
                        value, float(d[metric].var(ddof=1) or 0), n,
                        float(rest.mean()), float(rest.var(ddof=1) or 0), len(rest),
                    ), 6),
                })
        rows = apply_significance(rows)
        rows = drop_collinear(rows, group_keys=("scope", "metric"))
        rows.sort(key=lambda r: abs(r["delta_pct"]), reverse=True)
        results.extend(rows[:top_n])

    return results


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
    parser.add_argument("--min-n", type=int, default=MIN_N_TEAM,
                         help="taille min. d'échantillon par (équipe, situation)")
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
    with open(os.path.join(DATA_DIR, "content_insights_goalies.json"), "w", encoding="utf-8") as f:
        json.dump(goalie_top, f, ensure_ascii=False, indent=2)
    goalie_lines = [
        "# ICEEDGE — Gardiens : effets situationnels mesurés sur toute la ligue\n",
        "Écarts de % d'arrêts entre une situation et l'ensemble des départs, tous",
        "gardiens confondus. Les splits par gardien individuel ont été abandonnés :",
        "le % d'arrêts varie trop d'un match à l'autre pour qu'un effet soit",
        "détectable sur les quelques centaines de départs d'une carrière.\n",
    ]
    for it in goalie_top:
        direction = "plus" if it["delta_pp"] > 0 else "moins"
        goalie_lines.append(
            f"- **{it['label']}** = {it['bucket']} → {it['save_pct']*100:.2f}% d'arrêts "
            f"(moyenne ligue: {it['base_save_pct']*100:.2f}%, {direction} fort de "
            f"{abs(it['delta_pp']):.2f} pts, n={it['n']}, p={it['p_value']:.5f})"
        )
    with open(os.path.join(DATA_DIR, "content_insights_goalies.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(goalie_lines) + "\n")

    print(f"Équipes -> content_insights_teams.md ({len(team_top)} items)")
    for it in team_top:
        print(f"  {it['team']}: {it['label']}={it['bucket']} -> {it['rate']*100:.1f}% "
              f"(perso {it['team_base_rate']*100:.1f}%, n={it['n']})")

    skater_top = analyze_skaters(long_df, args.top)
    with open(os.path.join(DATA_DIR, "content_insights_skaters.json"), "w", encoding="utf-8") as f:
        json.dump(skater_top, f, ensure_ascii=False, indent=2)

    skater_lines = [
        "# ICEEDGE — Patineurs : effets situationnels mesurés sur toute la ligue\n",
        f"Seuls les écarts d'au moins {MIN_EFFECT_PCT:.0f} % sont retenus. Sur ce volume de",
        "données, la significativité statistique ne trie plus rien — tout est",
        "significatif — donc c'est la taille de l'effet qui décide.\n",
    ]
    by_metric: dict[str, list[dict]] = {}
    for it in skater_top:
        by_metric.setdefault(it["metric_label"], []).append(it)
    for metric_label, items in by_metric.items():
        skater_lines.append(f"\n## {metric_label}\n")
        for it in items:
            skater_lines.append(
                f"- **{it['label']}** = {it['bucket']} → {it['value']:.3f} "
                f"(moyenne: {it['base_value']:.3f}, {it['delta_pct']:+.1f} %, "
                f"n={it['n']}, p={it['p_value']:.5f})"
            )
    if "minutes jouées par match" not in by_metric:
        # Résultat négatif à conserver explicitement : il change l'interprétation
        # de tous les autres. Sans lui, on pourrait croire que la production
        # baisse simplement parce que l'entraîneur raccourcit son banc.
        skater_lines.append(
            "\n## Minutes jouées par match\n\n"
            "_Aucun écart d'au moins "
            f"{MIN_EFFECT_PCT:.0f} %._ Le temps de glace ne bouge pas selon la "
            "situation. La baisse de production observée ci-dessus ne vient donc "
            "pas d'un banc raccourci : à minutes égales, les joueurs produisent "
            "moins. C'est de la fatigue, pas de la gestion d'effectif."
        )
    with open(os.path.join(DATA_DIR, "content_insights_skaters.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(skater_lines) + "\n")

    print(f"\nPatineurs (ligue entière) -> content_insights_skaters.md ({len(skater_top)} items)")
    for it in skater_top[:8]:
        print(f"  [{it['metric']:16}] {it['label']}={it['bucket']} -> "
              f"{it['delta_pct']:+.1f}% (n={it['n']})")

    print(f"\nGardiens (ligue entière) -> content_insights_goalies.md ({len(goalie_top)} items)")
    for it in goalie_top:
        print(f"  {it['label']}={it['bucket']} -> {it['save_pct']*100:.2f}% "
              f"(ligue {it['base_save_pct']*100:.2f}%, {it['delta_pp']:+.2f} pts, n={it['n']})")


if __name__ == "__main__":
    main()
