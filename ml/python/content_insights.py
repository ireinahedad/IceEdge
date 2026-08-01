"""
content_insights.py
====================
Mine ml/data/nhl_games_v4.csv for "insider" situational stats — the kind of
counter-intuitive, surprising deviations that make good short-form content
(TikTok/Reels): "team X wins only Y% of the time when Z".

Does NOT touch or reveal the ponderation/weighting logic used by the actual
prediction models (game_model.json / totals_model.json / feature_importance_*).
This only computes raw historical win-rate / over-rate deviations per
situational bucket, from data that is already in the CSV.

Usage:
    cd ml/python
    python content_insights.py [--min-n 40] [--top 15]

Outputs:
    ml/data/content_insights.json   (structured, for reuse/automation)
    ml/data/content_insights.md     (human-readable, ready to paste into a script)
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

from insights_common import (
    MIN_N_LEAGUE,
    apply_significance,
    drop_collinear,
    two_proportion_p,
)

DATA_DIR = "../data"
INPUT_CSV = os.path.join(DATA_DIR, "nhl_games_v4.csv")
OUT_JSON = os.path.join(DATA_DIR, "content_insights.json")
OUT_MD = os.path.join(DATA_DIR, "content_insights.md")

# ── Situational factors worth mining for surprising splits ──────────────────
# Each entry: (column, label, kind)
#   kind "bucket"  -> discretize into quantile/fixed buckets, report home_win rate
#   kind "bool"    -> column is already 0/1, report home_win rate for 1 vs 0
FACTORS = [
    ("home_tz_shift", "décalage horaire (domicile)", "bucket"),
    ("away_tz_shift", "décalage horaire (visiteur)", "bucket"),
    ("tz_shift_diff", "écart de décalage horaire", "bucket"),
    ("home_b2b", "back-to-back (domicile)", "bool"),
    ("away_b2b", "back-to-back (visiteur)", "bool"),
    ("home_3in4", "3 matchs en 4 soirs (domicile)", "bool"),
    ("away_3in4", "3 matchs en 4 soirs (visiteur)", "bool"),
    ("home_rest_days", "jours de repos (domicile)", "bucket"),
    ("away_rest_days", "jours de repos (visiteur)", "bucket"),
    ("rest_days_diff", "écart de repos", "bucket"),
    ("home_distance_km", "distance parcourue (domicile)", "bucket"),
    ("away_distance_km", "distance parcourue (visiteur)", "bucket"),
    ("distance_km_diff", "écart de distance parcourue", "bucket"),
    ("home_road_trip_len", "longueur du road trip (domicile)", "bucket"),
    ("away_road_trip_len", "longueur du road trip (visiteur)", "bucket"),
    ("home_road_game_num", "n-ième match du road trip (domicile)", "bucket"),
    ("away_road_game_num", "n-ième match du road trip (visiteur)", "bucket"),
    ("home_days_away", "jours loin de la maison (domicile)", "bucket"),
    ("away_days_away", "jours loin de la maison (visiteur)", "bucket"),
    ("home_alt_gain", "gain d'altitude (domicile)", "bucket"),
    ("away_alt_gain", "gain d'altitude (visiteur)", "bucket"),
    ("venue_altitude_m", "altitude de l'aréna", "bucket"),
    ("home_getaway", "getaway game (domicile)", "bool"),
    ("away_getaway", "getaway game (visiteur)", "bool"),
]

# Extra target: totals (over/under), reuses same factor list
TOTAL_FACTORS = [f for f in FACTORS]


def bucketize(series: pd.Series, n_buckets: int = 5) -> pd.Series:
    """Quantile-bucket a numeric series; falls back to unique-value buckets
    if there isn't enough spread (e.g. small integer ranges like rest_days)."""
    nunique = series.nunique(dropna=True)
    if nunique <= n_buckets:
        return series.round(0)
    try:
        return pd.qcut(series, q=n_buckets, duplicates="drop")
    except ValueError:
        return series.round(0)


def analyze_factor(df: pd.DataFrame, col: str, label: str, kind: str,
                    target: str, min_n: int) -> list[dict]:
    if col not in df.columns:
        return []
    sub = df[[col, target]].dropna()
    if sub.empty:
        return []

    base_rate = sub[target].mean()
    # Totaux du facteur : servent à tester chaque bucket contre son complément
    # plutôt que contre une moyenne dont il fait lui-même partie.
    n_total = len(sub)
    k_total = float(sub[target].sum())
    results = []

    groups: dict[str, pd.DataFrame] = {}
    if kind == "bool":
        for v, g in sub.groupby(col):
            groups[str(v)] = g[[target]]
    else:
        bucketed = bucketize(sub[col])
        sub2 = sub.assign(_b=bucketed)
        for v, g in sub2.groupby("_b", observed=True):
            groups[str(v)] = g[[target]]

    for key, g in groups.items():
        n = len(g)
        if n < min_n:
            continue
        rate = g[target].mean()
        delta = rate - base_rate
        p_value = two_proportion_p(float(g[target].sum()), n, k_total, n_total)
        results.append({
            "factor": col,
            "label": label,
            "bucket": str(key),
            "n": int(n),
            "rate": round(float(rate), 4),
            "base_rate": round(float(base_rate), 4),
            "delta_pp": round(float(delta) * 100, 1),
            "target": target,
            "p_value": round(float(p_value), 6),
        })
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-n", type=int, default=MIN_N_LEAGUE,
                         help="taille min. d'échantillon par bucket")
    parser.add_argument("--top", type=int, default=15,
                         help="how many top insights to keep per target")
    args = parser.parse_args()

    df = pd.read_csv(INPUT_CSV)

    # Targets: home_win (moneyline angle) and an "over" flag derived from
    # total_goals vs the closing total line, when available (totals angle).
    df["home_win"] = df["home_win"].astype(float)
    targets = ["home_win"]
    if "total_close" in df.columns and "total_goals" in df.columns:
        mask = df["total_close"].notna()
        df.loc[mask, "over_hit"] = (df.loc[mask, "total_goals"] > df.loc[mask, "total_close"]).astype(float)
        targets.append("over_hit")

    all_results = []
    for col, label, kind in FACTORS:
        for target in targets:
            all_results.extend(analyze_factor(df, col, label, kind, target, args.min_n))

    if not all_results:
        print("Aucun résultat — vérifie que nhl_games_v4.csv contient bien les colonnes attendues.")
        return

    # Signification AVANT tri : trier par écart absolu puis couper au top 15
    # revient à sélectionner les plus petits échantillons, puisque ce sont eux
    # qui produisent les écarts extrêmes. Le filtre passe donc en premier.
    top_per_target = {}
    rejected = []
    for target in targets:
        rows = [r for r in all_results if r["target"] == target]
        kept = apply_significance(rows)
        kept_ids = {(r["factor"], r["bucket"]) for r in kept}
        rejected.extend([
            {**r, "reason": "écart non significatif après correction Benjamini-Hochberg"}
            for r in rows if (r["factor"], r["bucket"]) not in kept_ids
        ])

        before_dedupe = {(r["factor"], r["bucket"]) for r in kept}
        kept = drop_collinear(kept, group_keys=("target",))
        after_dedupe = {(r["factor"], r["bucket"]) for r in kept}
        rejected.extend([
            {**r, "reason": "facteur colinéaire — même découpage qu'un facteur plus lisible"}
            for r in rows if (r["factor"], r["bucket"]) in before_dedupe - after_dedupe
        ])

        kept.sort(key=lambda r: abs(r["delta_pp"]), reverse=True)
        top_per_target[target] = kept[:args.top]

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(top_per_target, f, ensure_ascii=False, indent=2)

    # Les recalés sont conservés : c'est le seul moyen de vérifier que le filtre
    # ne jette pas de bonnes histoires en même temps que le bruit.
    rejected.sort(key=lambda r: abs(r["delta_pp"]), reverse=True)
    with open(os.path.join(DATA_DIR, "content_insights_rejected.json"), "w", encoding="utf-8") as f:
        json.dump(rejected[:60], f, ensure_ascii=False, indent=2)

    # Human-readable digest
    lines = ["# ICEEDGE — Stats insider pour contenu (généré automatiquement)\n"]
    label_map = {"home_win": "Victoire domicile", "over_hit": "Total dépassé (over)"}
    for target, items in top_per_target.items():
        lines.append(f"\n## {label_map.get(target, target)}\n")
        if not items:
            # Cas observé sur over_hit : le meilleur p-value du groupe était de
            # 0.0104, insuffisant face au nombre de comparaisons. Une section vide
            # est un résultat, pas une panne — elle dit qu'aucun facteur de
            # voyage ou de repos ne prédit les totaux de façon détectable, et
            # elle évite de bâtir une vidéo sur un écart qui n'existe pas.
            lines.append(
                "_Aucun écart ne survit à la correction pour comparaisons multiples._\n\n"
                "Ce n'est pas une erreur d'exécution : sur cette cible, les écarts "
                "observés sont compatibles avec le hasard une fois pris en compte "
                "le nombre de facteurs testés. Les candidats recalés, avec leur "
                "p-value, sont dans `content_insights_rejected.json`.\n"
            )
        for it in items:
            direction = "plus" if it["delta_pp"] > 0 else "moins"
            lines.append(
                f"- **{it['label']}** = {it['bucket']} → taux de {it['rate']*100:.1f}% "
                f"(moyenne: {it['base_rate']*100:.1f}%, {direction} fort de {abs(it['delta_pp']):.1f} pts, "
                f"n={it['n']}, p={it['p_value']:.4f})"
            )
    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Écrit: {OUT_JSON}")
    print(f"Écrit: {OUT_MD}")
    print(f"\nTop 5 aperçu ({targets[0]}):")
    for it in top_per_target[targets[0]][:5]:
        print(f"  {it['label']} = {it['bucket']}: {it['rate']*100:.1f}% (base {it['base_rate']*100:.1f}%, n={it['n']})")


if __name__ == "__main__":
    main()
