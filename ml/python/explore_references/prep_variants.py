"""Prépare les colonnes de variantes (xG ajustés, ELO avec autocorrélation).

À lancer depuis ml/python : python explore_references/<script>.py (chemins relatifs ../data). Écrit des fichiers
parquet de colonnes de remplacement dans explore_references/out/variants/, indexés par game_id.
Contrôle d'abord que la recomputation « référence » reproduit le dataset.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.getcwd())
import build_dataset as B  # noqa: E402

OUT = "explore_references/out/variants"
os.makedirs(OUT, exist_ok=True)

df = pd.read_csv("../data/nhl_games_v4.csv", low_memory=False)
print("dataset", df.shape)

# ── 1. Features d'équipe ─────────────────────────────────────────────────────
_orig_read = pd.read_csv


def team_feats_with(xg_for: str | None, xg_against: str | None):
    def patched(path, *a, **k):
        d = _orig_read(path, *a, **k)
        if str(path).endswith("mp_team_games.csv") and xg_for:
            d["xGoalsFor"] = d[xg_for]
            d["xGoalsAgainst"] = d[xg_against]
        return d
    B.pd.read_csv = patched
    try:
        tf, _ = B.build_team_features()
    finally:
        B.pd.read_csv = _orig_read
    return tf


def merged_cols(tf: pd.DataFrame) -> pd.DataFrame:
    """Colonnes home_*/away_* que build_dataset.main produirait, par game_id."""
    base = df[["game_id", "date", "home_team", "away_team"]].copy()
    out = base.copy()
    for side in ("home", "away"):
        f = tf.drop(columns=["gameId"], errors="ignore")
        f = f.rename(columns={c: f"{side}_{c}" for c in f.columns if c not in ("team", "date")})
        f = f.drop_duplicates(subset=["team", "date"], keep="last")
        m = base.merge(f, left_on=[f"{side}_team", "date"], right_on=["team", "date"],
                       how="left").drop(columns=["team"])
        for c in m.columns:
            if c.startswith(f"{side}_") and c not in ("home_team", "away_team"):
                out[c] = m[c].values
    return out


def add_diffs(d: pd.DataFrame) -> pd.DataFrame:
    d = d.copy()
    d["xg_matchup_home"] = d["home_xgf60_s"] - d["away_xga60_s"]
    d["xg_matchup_away"] = d["away_xgf60_s"] - d["home_xga60_s"]
    d["xg_matchup_diff"] = d["xg_matchup_home"] - d["xg_matchup_away"]
    for c in ("ev_xgf_pct_s", "ev_xgf_pct_l", "ev_cf_pct_s", "ev_cf_pct_l", "finishing_s"):
        d[f"{c}_diff"] = d[f"home_{c}"] - d[f"away_{c}"]
    return d


ref = add_diffs(merged_cols(team_feats_with(None, None)))
team_cols = [c for c in ref.columns if c not in ("game_id", "date", "home_team", "away_team")]
# Contrôle : la recomputation reproduit le dataset
bad = []
for c in team_cols:
    if c in df.columns:
        a, b = df[c].to_numpy(float), ref[c].to_numpy(float)
        ok = np.isclose(a, b, rtol=1e-6, atol=1e-9, equal_nan=True).mean()
        if ok < 0.999:
            bad.append((c, round(float(ok), 4)))
print("contrôle features équipe — colonnes divergentes :", bad[:10] or "aucune")

for name, (f, a) in {"xg_flurry": ("flurryAdjustedxGoalsFor", "flurryAdjustedxGoalsAgainst"),
                     "xg_fsv": ("flurryScoreVenueAdjustedxGoalsFor",
                                "flurryScoreVenueAdjustedxGoalsAgainst")}.items():
    v = add_diffs(merged_cols(team_feats_with(f, a)))
    # La « finition » (buts − xG) reste calculée sur l'xG brut : on ne remplace
    # que la mesure de la qualité des occasions.
    keep = [c for c in team_cols if c in df.columns and "finishing" not in c]
    v[["game_id"] + keep].to_parquet(f"{OUT}/{name}.parquet", index=False)
    print(name, "écrit,", len(keep), "colonnes")

# ── 2. ELO avec terme d'autocorrélation (FiveThirtyEight / Paine) ─────────────
spine = pd.read_csv("../data/games_spine.csv")
spine["home_team"] = spine["home_team"].map(B.norm_team)
spine["away_team"] = spine["away_team"].map(B.norm_team)
spine = spine.sort_values(["date", "game_id"]).reset_index(drop=True)


def elo(sp: pd.DataFrame, autocorr: bool) -> pd.DataFrame:
    ratings, prev = {}, None
    rows = []
    dates = pd.to_datetime(sp["date"])
    for i, r in sp.iterrows():
        d = dates.iloc[i]
        if prev is not None and (d - prev).days > 60:
            for t in ratings:
                ratings[t] += B.ELO_SEASON_REGRESS * (B.ELO_BASE - ratings[t])
        prev = d
        h, a = r["home_team"], r["away_team"]
        rh, ra = ratings.get(h, B.ELO_BASE), ratings.get(a, B.ELO_BASE)
        exp = B.elo_expected_home(rh, ra)
        rows.append((r["game_id"], rh, ra, rh - ra, exp))
        if pd.isna(r["home_score"]) or pd.isna(r["away_score"]):
            continue
        margin = abs(int(r["home_score"]) - int(r["away_score"])) or 1
        mov = 0.6686 * np.log(margin) + 0.8048
        home_won = r["home_score"] > r["away_score"]
        if autocorr:
            # Écart d'ELO du gagnant, avantage de la glace inclus (FiveThirtyEight)
            diff = (rh + B.ELO_HOME_ADV) - ra
            w_diff = diff if home_won else -diff
            mov *= 2.05 / (w_diff * 0.001 + 2.05)
        delta = B.ELO_K * mov * ((1.0 if home_won else 0.0) - exp)
        ratings[h], ratings[a] = rh + delta, ra - delta
    return pd.DataFrame(rows, columns=["game_id", "home_elo", "away_elo", "elo_diff", "elo_expected"])


e0 = elo(spine, False).drop_duplicates("game_id", keep="last")
chk = df[["game_id", "home_elo"]].merge(e0, on="game_id", suffixes=("", "_re"))
print("contrôle ELO — part identique :",
      round(float(np.isclose(chk["home_elo"], chk["home_elo_re"]).mean()), 4))
e1 = elo(spine, True).drop_duplicates("game_id", keep="last")
e1.to_parquet(f"{OUT}/elo_ac.parquet", index=False)
print("elo_ac écrit")
