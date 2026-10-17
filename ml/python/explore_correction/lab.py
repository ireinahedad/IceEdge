"""Banc d'essai de la couche de correction du moneyline.

Lit les prédictions hors échantillon de `build_oos.py`, construit toutes les
variables candidates (les 23 de `--market-gap` + celles des pistes 4-5) et
rejoue la couche en walk-forward STRICT : pour chaque saison S, ajustée sur les
saisons < S (au moins 3), appliquée à S — exactement le protocole de
`backtest_walkforward.run_correction`.
"""
import glob, json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))
import backtest_walkforward as BW

OUT = os.path.join(HERE, "out")
C7 = ["b2b_diff", "ev_xgf_pct_s_diff", "ev_xgf_pct_l_diff", "lineup_xg_diff",
      "star_power_diff", "xg_matchup_diff", "elo_diff"]
GAP23 = ["elo_diff", "goalie_gsax60_diff", "goalie_svpct_diff", "goalie_starts_logdiff",
         "backup_diff", "stars_out_weight_diff", "star_power_diff", "lineup_xg_diff",
         "b2b_diff", "rest_days_diff", "tz_shift_diff", "distance_km_diff",
         "ev_xgf_pct_s_diff", "ev_xgf_pct_l_diff", "xg_matchup_diff", "win_s_diff",
         "finishing_s_diff", "gp_min_f",
         "pp_time_diff", "discipline_diff", "st_xg_edge", "pp_eff_diff", "pk_eff_diff"]
MIN_PAST = BW.RECAL_MIN_SEASONS


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def load() -> pd.DataFrame:
    cache = os.path.join(OUT, "frame.pkl")
    if os.path.exists(cache):
        return pd.read_pickle(cache)
    oos = pd.concat([pd.read_csv(f) for f in sorted(glob.glob(os.path.join(OUT, "oos_*.csv")))])
    df = pd.read_csv(BW.DATA, low_memory=False)
    G = df.merge(oos.drop(columns=["season", "date"]), on="game_id", how="inner")
    G = G[G["season"] <= 2025]  # 2026-27 : 83 matchs, saison en cours
    G = G.sort_values(["date", "game_id"]).reset_index(drop=True)
    # ── variables de --market-gap, même construction ─────────────────────────
    full = pd.concat([pd.DataFrame({"season": df["season"], "date": df["date"],
                                    "team": df[f"{s}_team"]}) for s in ("home", "away")])
    full = full.sort_values(["season", "team", "date"]).drop_duplicates(["season", "team", "date"])
    full["gp"] = full.groupby(["season", "team"]).cumcount()
    for s in ("home", "away"):
        G = G.merge(full.rename(columns={"team": f"{s}_team", "gp": f"{s}_gp_s"}),
                    on=["season", f"{s}_team", "date"], how="left")
    G["gp_min_f"] = np.minimum(G["home_gp_s"], G["away_gp_s"]).astype(float)
    bk = BW._goalie_backup_flags()
    for s in ("home", "away"):
        G = G.merge(bk.rename(columns={"team": f"{s}_team", "backup": f"{s}_backup"}),
                    on=[f"{s}_team", "date"], how="left")
    G["lineup_xg_diff"] = G["home_lineup_xg"] - G["away_lineup_xg"]
    G["goalie_starts_logdiff"] = np.log1p(G["home_goalie_starts"]) - np.log1p(G["away_goalie_starts"])
    G["backup_diff"] = (G["home_backup"] == 1).astype(float) - (G["away_backup"] == 1).astype(float)
    stf = BW._special_teams_features()
    for s in ("home", "away"):
        G = G.merge(stf.rename(columns={"team": f"{s}_team", "pp_min": f"{s}_pp_min",
                                        "pk_min": f"{s}_pk_min"}), on=[f"{s}_team", "date"], how="left")
    eh = (G["home_pp_min"] + G["away_pk_min"]) / 2
    ea = (G["away_pp_min"] + G["home_pk_min"]) / 2
    G["pp_time_diff"] = eh - ea
    G["discipline_diff"] = G["home_pk_min"] - G["away_pk_min"]
    G["st_xg_edge"] = (eh / 60 * (G["home_pp_xgf60_s"] + G["away_pk_xga60_s"]) / 2
                       - ea / 60 * (G["away_pp_xgf60_s"] + G["home_pk_xga60_s"]) / 2)
    G["pp_eff_diff"] = G["home_pp_xgf60_s"] - G["away_pp_xgf60_s"]
    G["pk_eff_diff"] = G["home_pk_xga60_s"] - G["away_pk_xga60_s"]
    G["y"] = G["home_win"].astype(float)
    G["lp"] = BW._logit(G["p_ml"].to_numpy())
    G.to_pickle(cache)
    return G


def _std(Xtr, Xte):
    mu, sd = np.nanmean(Xtr, axis=0), np.nanstd(Xtr, axis=0)
    sd[~np.isfinite(sd) | (sd == 0)] = 1.0
    mu[~np.isfinite(mu)] = 0.0
    f = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
    return f(Xtr), f(Xte)


def design(G, feats, idx, basis="lin"):
    """Colonnes : base sur logit p (+ non-linéarité), puis les variables brutes."""
    lp = G["lp"].to_numpy()[idx]
    cols = [lp]
    if basis == "abs":           # logit · |logit| : étire ou comprime les queues
        cols.append(lp * np.abs(lp))
    elif basis == "cube":
        cols.append(lp ** 3)
    elif basis.startswith("hinge"):  # pente à part au-delà de |logit| > k (queues)
        k = float(basis[5:] or 0.6)
        cols += [np.maximum(lp - k, 0), np.minimum(lp + k, 0)]
    raw = G[feats].astype(float).to_numpy()[idx] if feats else np.zeros((len(idx), 0))
    return np.column_stack(cols), raw


def walk_forward(G, feats=None, select=None, basis="lin", weight=None, name="",
                 extra_X=None, keep_p=True):
    """Rend {season: (idx, p)} ; `feats` fixe ou `select(G_past) -> feats`."""
    seasons = sorted(G["season"].unique())
    y = G["y"].to_numpy()
    out, chosen = {}, {}
    for i, s in enumerate(seasons):
        past = seasons[:i]
        if len(past) < MIN_PAST:
            continue
        tr = np.flatnonzero(G["season"].isin(past).to_numpy())
        te = np.flatnonzero((G["season"] == s).to_numpy())
        f = select(G.iloc[tr]) if select else (feats or [])
        chosen[int(s)] = list(f)
        Btr, Rtr = design(G, f, tr, basis)
        Bte, Rte = design(G, f, te, basis)
        Rtr, Rte = _std(Rtr, Rte)
        Xtr, Xte = np.column_stack([Btr, Rtr]), np.column_stack([Bte, Rte])
        if weight is not None:
            w = weight(G.iloc[tr], s)
            b = _wlogistic(y[tr], Xtr, w)
        else:
            b, _ = BW._logistic_offset(y[tr], Xtr, np.zeros(len(tr)))
        out[int(s)] = (te, 1 / (1 + np.exp(-(b[0] + Xte @ b[1:]))))
    return {"name": name, "pred": out, "chosen": chosen}


def _wlogistic(y, X, w, iters=50):
    X1 = np.column_stack([np.ones(len(y)), X])
    b = np.zeros(X1.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X1 @ b)))
        W = w * p * (1 - p)
        H = X1.T @ (X1 * W[:, None]) + 1e-9 * np.eye(len(b))
        step = np.linalg.solve(H, X1.T @ (w * (y - p)))
        b += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return b


def as_vector(G, res):
    p = np.full(len(G), np.nan)
    for s, (idx, ps) in res["pred"].items():
        p[idx] = ps
    return p


def compare(G, p_new, p_ref, label="", mask=None):
    """Δ log-loss apparié (nouveau − référence), z par match et par saison, part de saisons."""
    y = G["y"].to_numpy()
    m = np.isfinite(p_new) & np.isfinite(p_ref)
    if mask is not None:
        m &= mask
    d = ll(y[m], p_new[m]) - ll(y[m], p_ref[m])
    S = G["season"].to_numpy()[m]
    us = np.unique(S)
    means = np.array([d[S == s].mean() for s in us])
    pr = BW._paired(d)
    se_s = means.std(ddof=1) / np.sqrt(len(us))
    better = int((means < 0).sum())
    return {"label": label, **pr, "z_seasons": round(float(d.mean() / se_s), 2),
            "seasons_better": better, "n_seasons": int(len(us)),
            "share": round(better / len(us), 3),
            "by_season": {int(s): round(float(x), 5) for s, x in zip(us, means)}}


def verdict(c, z=-2.0, share=0.70):
    return "ADOPTER" if c["z"] is not None and c["z"] <= z and c["share"] >= share else (
        "PIRE" if c["z"] is not None and c["z"] >= 2 else "NON TRANCHABLE")


def reliability(G, p, edges=(0, .3, .4, .5, .6, .7, .8, 1.0), mask=None):
    """Calibration par tranche de p prédit (côté domicile) + ECE."""
    y = G["y"].to_numpy()
    m = np.isfinite(p) if mask is None else (np.isfinite(p) & mask)
    rows, ece, n = [], 0.0, m.sum()
    for a, b in zip(edges[:-1], edges[1:]):
        k = m & (p >= a) & (p < b)
        if k.sum() < 30:
            continue
        o, e = float(y[k].mean()), float(p[k].mean())
        se = np.sqrt(e * (1 - e) / k.sum())
        rows.append({"bin": f"{a:.2f}-{b:.2f}", "n": int(k.sum()), "pred": round(e, 4),
                     "obs": round(o, 4), "z": round((o - e) / se, 2)})
        ece += k.sum() / n * abs(o - e)
    return {"ece": round(ece, 4), "bins": rows}


def fav_tail(G, p, thr=0.65, mask=None):
    """Côté FAVORI (domicile ou extérieur) : matchs où le favori prédit ≥ thr."""
    y = G["y"].to_numpy()
    pf = np.maximum(p, 1 - p)
    yf = np.where(p >= 0.5, y, 1 - y)
    m = np.isfinite(p) & (pf >= thr)
    if mask is not None:
        m &= mask
    return {"n": int(m.sum()), "pred": round(float(pf[m].mean()), 4),
            "obs": round(float(yf[m].mean()), 4)}


def dump(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False)
