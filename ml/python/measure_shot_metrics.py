"""
measure_shot_metrics.py — tirs cadrés, Corsi ou Fenwick ? (2026-10-02)
=====================================================================

Question posée : « remplacer les tirs par le Corsi/Fenwick dans le ML ».
Deux endroits utilisent un volume de tirs, mesurés séparément.

1. Classifieur moneyline XGBoost (train.py). Il n'utilise PAS les tirs cadrés :
   sa variable de possession est déjà le Corsi % à 5 c. 5 (`ev_cf_pct_s_diff`).
   On teste Fenwick, Corsi/Fenwick ajustés au score, tirs cadrés, et des ajouts.
   Walk-forward saison par saison (train < S, test S, 2012 → 2025),
   hyperparamètres FIXÉS (training_report.json) pour que seule la variable
   change, sans cotes (la couverture des cotes ne doit pas se mêler à l'effet).

2. Moteur de règles (nhlPredictions.ts). Son λ prend « tirs cadrés / match »
   en signal secondaire, et les facteurs « Rythme de tirs » / « Volume de
   tirs » convertissent ce volume en buts. Moyennes de SAISON À DATE, comme
   l'API NHL qu'il lit (≥ 5 matchs) :
   a. régression de Poisson hors échantillon — quelle mesure porte le plus
      d'information au-delà des buts pour/contre ?
   b. le λ TEL QU'ÉCRIT dans nhlPredictions.ts, tirs contre Fenwick.

Résultat (14 saisons) :
   1. aucune variante ne bouge le classifieur (|z| < 1,2) → inchangé ;
   2a. Fenwick toutes situations bat les tirs : log-loss −0,00096 (z −3,6,
       12/14) ; Corsi mieux que les tirs, moins bien que le Fenwick ; les
       versions 5 c. 5 seules ne battent pas les tirs ;
   2b. le λ du moteur avec le Fenwick : log-loss −0,00030 ± 0,00007 (12/14),
       déviance neutre → branché (MoneyPuck teams.csv côté serveur).

Usage :
    cd ml/python
    python measure_shot_metrics.py        # ~3 min → ../models/shot_metrics_report.json
"""
import json
import sys

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.optimize import minimize
from scipy.stats import poisson

import train as T
from build_dataset import norm_team

DATA = "../data"
MODELS = "../models"
SHORT_HL, LONG_HL = 6, 20
FIRST_TEST_SEASON = 2012

mp = pd.read_csv(f"{DATA}/mp_team_games.csv", low_memory=False)
mp["team"] = mp["playerTeam"].map(norm_team)


def seasons_of(values):
    return sorted(int(s) for s in pd.unique(values) if s >= FIRST_TEST_SEASON)


def delta_stats(per_variant: dict, per_base: dict, seasons: list) -> dict:
    """Écart moyen (par match) et erreur-type sur les moyennes de saison."""
    ds = np.array([per_variant[s].mean() - per_base[s].mean() for s in seasons])
    delta = float(np.concatenate([per_variant[s] - per_base[s] for s in seasons]).mean())
    se = float(ds.std(ddof=1) / np.sqrt(len(ds)))
    return {"delta": round(delta, 6), "se": round(se, 6), "z": round(delta / se, 2),
            "seasons_better": int((ds < 0).sum()), "n_seasons": len(ds)}


def logloss(y, p):
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


# ══════════════════════════════════════════════════════════════════════════════
# 1. Classifieur moneyline
# ══════════════════════════════════════════════════════════════════════════════

def part1() -> dict:
    print("1. Classifieur moneyline (walk-forward, hyperparamètres fixés)")

    def share(sit, cols):
        d = mp[mp["situation"] == sit]
        out = d[["team", "gameId", "gameDate"]].copy()
        for name, (f, a) in cols.items():
            out[name] = d[f] / (d[f] + d[a]).replace(0, np.nan)
        return out

    tg = share("5on5", {
        "ev_ff_pct": ("unblockedShotAttemptsFor", "unblockedShotAttemptsAgainst"),
        "ev_cf_pct": ("shotAttemptsFor", "shotAttemptsAgainst"),
        "ev_sf_pct": ("shotsOnGoalFor", "shotsOnGoalAgainst"),
        "ev_sacf_pct": ("scoreAdjustedShotsAttemptsFor", "scoreAdjustedShotsAttemptsAgainst"),
        "ev_saff_pct": ("scoreAdjustedUnblockedShotAttemptsFor", "scoreAdjustedUnblockedShotAttemptsAgainst"),
    }).sort_values(["team", "gameDate", "gameId"]).reset_index(drop=True)
    raw = [c for c in tg.columns if c.endswith("_pct")]
    cols = {}
    for c in raw:     # mêmes EWMA décalées que build_dataset.py
        g = tg.groupby("team")[c].shift(1).groupby(tg["team"])
        cols[f"{c}_s"] = g.transform(lambda x: x.ewm(halflife=SHORT_HL, min_periods=3).mean())
        cols[f"{c}_l"] = g.transform(lambda x: x.ewm(halflife=LONG_HL, min_periods=3).mean())
    tg = pd.concat([tg, pd.DataFrame(cols)], axis=1)

    df = pd.read_csv(f"{DATA}/nhl_games_v4.csv", low_memory=False)
    fc = list(cols)
    for side in ("home", "away"):
        m = tg[["team", "gameId"] + fc].rename(columns={"team": f"{side}_team", "gameId": "game_id",
                                                        **{c: f"{side}_{c}_x" for c in fc}})
        df = df.merge(m, on=[f"{side}_team", "game_id"], how="left")
    df = pd.concat([df, pd.DataFrame({f"{c}_diff_x": df[f"home_{c}_x"] - df[f"away_{c}_x"] for c in fc})], axis=1)
    parity = float((df["ev_cf_pct_s_diff_x"] - df["ev_cf_pct_s_diff"]).abs().max())
    print(f"   parité ev_cf_pct_s_diff (reconstruit vs dataset) : écart max {parity:.1e}")
    assert parity < 1e-9, "la reconstruction ne retombe pas sur la colonne du dataset"

    P = dict(json.load(open(f"{MODELS}/training_report.json", encoding="utf-8"))["game_model"]["params"])
    P.update({"objective": "binary:logistic", "eval_metric": "logloss", "seed": 42, "tree_method": "hist"})
    base = list(T.CORE_FEATURES)

    def swap(new):
        f = list(base)
        f[f.index("ev_cf_pct_s_diff")] = new
        return f

    variants = {
        "base (Corsi % 5c5)": base,
        "Fenwick au lieu de Corsi": swap("ev_ff_pct_s_diff_x"),
        "tirs cadrés au lieu de Corsi": swap("ev_sf_pct_s_diff_x"),
        "Corsi ajusté au score": swap("ev_sacf_pct_s_diff_x"),
        "Fenwick ajusté au score": swap("ev_saff_pct_s_diff_x"),
        "+ Fenwick (Corsi gardé)": base + ["ev_ff_pct_s_diff_x"],
        "+ Corsi long (hl=20)": base + ["ev_cf_pct_l_diff_x"],
        "+ Fenwick court et long": base + ["ev_ff_pct_s_diff_x", "ev_ff_pct_l_diff_x"],
    }
    df = df.sort_values(["date", "game_id"]).reset_index(drop=True)
    y = df["home_win"].astype(float).values
    seasons = seasons_of(df["season"])
    res = {}
    for name, feats in variants.items():
        per = {}
        for S in seasons:
            tr, te = df.index[df["season"] < S], df.index[df["season"] == S]
            n_fit = int(len(tr) * 0.85)
            mk = lambda idx: xgb.DMatrix(df.loc[idx, feats].astype(float), label=y[idx], missing=np.nan)
            b = xgb.train(P, mk(tr[:n_fit]), 2000, evals=[(mk(tr[n_fit:]), "v")],
                          early_stopping_rounds=60, verbose_eval=False)
            per[S] = logloss(y[te], b.predict(mk(te), iteration_range=(0, b.best_iteration + 1)))
        res[name] = per
        print(f"   {name:30s} log-loss {np.concatenate(list(per.values())).mean():.5f}", flush=True)
    ref = res["base (Corsi % 5c5)"]
    out = {"seasons": seasons, "base_log_loss": round(float(np.concatenate(list(ref.values())).mean()), 5),
           "variants": {}}
    for name, per in res.items():
        if per is not ref:
            out["variants"][name] = d = delta_stats(per, ref, seasons)
            print(f"   Δ {name:30s} {d['delta']:+.5f} ± {d['se']:.5f}  z {d['z']:+.2f}  "
                  f"mieux {d['seasons_better']}/{d['n_seasons']}")
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 2. Moteur de règles
# ══════════════════════════════════════════════════════════════════════════════

def season_to_date() -> pd.DataFrame:
    """Une ligne par équipe-match de saison régulière, moyennes de saison AVANT
    le match (≥ 5 matchs), côté équipe et côté adversaire."""
    m = mp[mp["playoffGame"] == 0].copy()
    m["opp"] = m["opposingTeam"].map(norm_team)
    a = m[m["situation"] == "all"][["team", "opp", "gameId", "gameDate", "season", "home_or_away",
                                    "goalsFor", "goalsAgainst", "shotsOnGoalFor", "shotsOnGoalAgainst",
                                    "shotAttemptsFor", "shotAttemptsAgainst",
                                    "unblockedShotAttemptsFor", "unblockedShotAttemptsAgainst"]]
    e = m[m["situation"] == "5on5"][["team", "gameId", "shotAttemptsFor", "shotAttemptsAgainst",
                                     "unblockedShotAttemptsFor", "unblockedShotAttemptsAgainst"]] \
        .rename(columns={"shotAttemptsFor": "cf5", "shotAttemptsAgainst": "ca5",
                         "unblockedShotAttemptsFor": "ff5", "unblockedShotAttemptsAgainst": "fa5"})
    t = a.merge(e, on=["team", "gameId"]).rename(columns={
        "goalsFor": "gf", "goalsAgainst": "ga", "shotsOnGoalFor": "sf", "shotsOnGoalAgainst": "sa",
        "shotAttemptsFor": "cf", "shotAttemptsAgainst": "ca",
        "unblockedShotAttemptsFor": "ff", "unblockedShotAttemptsAgainst": "fa"})
    t = t.sort_values(["team", "gameDate", "gameId"]).reset_index(drop=True)
    stat = ["gf", "ga", "sf", "sa", "cf", "ca", "ff", "fa", "cf5", "ca5", "ff5", "fa5"]
    g = t.groupby(["team", "season"])
    n_prev = g.cumcount()
    t = pd.concat([t, pd.DataFrame({f"{c}_pg": (g[c].cumsum() - t[c]) / n_prev.replace(0, np.nan)
                                    for c in stat})], axis=1)
    t["n_prev"] = n_prev
    opp = t[["team", "gameId", "n_prev"] + [f"{c}_pg" for c in stat]].rename(
        columns={"team": "opp", "n_prev": "o_n_prev", **{f"{c}_pg": f"o_{c}_pg" for c in stat}})
    d = t.merge(opp, on=["opp", "gameId"])
    d = d[(d["n_prev"] >= 5) & (d["o_n_prev"] >= 5)].copy()
    d["home"] = (d["home_or_away"] == "HOME").astype(float)
    return d


def win_logloss(d: pd.DataFrame, mu: np.ndarray) -> pd.Series:
    """Log-loss de la victoire en temps réglementaire (Skellam des deux λ),
    nuls écartés, par match — indexée par saison."""
    x = d[["gameId", "team", "gf", "ga", "season"]].copy()
    x["mu"] = mu
    m = x.merge(x[["gameId", "team", "mu"]].rename(columns={"team": "o", "mu": "mu_o"}), on="gameId")
    m = m[(m["team"] != m["o"]) & (m["gf"] != m["ga"])]
    k = np.arange(15)
    ph = poisson.pmf(k[None, :], m["mu"].values[:, None])
    pa = poisson.pmf(k[None, :], m["mu_o"].values[:, None])
    p_win = (ph[:, 1:] * np.cumsum(pa, axis=1)[:, :-1]).sum(1)
    p = np.clip(p_win / (1 - (ph * pa).sum(1)), 1e-6, 1 - 1e-6)
    return pd.Series(logloss((m["gf"] > m["ga"]).astype(float).values, p), index=m["season"].values)


def deviance(y, mu):
    with np.errstate(divide="ignore", invalid="ignore"):
        return 2 * (np.where(y > 0, y * np.log(np.where(y > 0, y, 1) / mu), 0.0) - (y - mu))


def part2(d: pd.DataFrame) -> dict:
    print("2a. Règles — régression de Poisson hors échantillon (saison à date)")
    variants = {"aucun volume": None, "tirs cadrés (actuel)": ("sf", "sa"),
                "Corsi toutes sit.": ("cf", "ca"), "Fenwick toutes sit.": ("ff", "fa"),
                "Corsi 5c5": ("cf5", "ca5"), "Fenwick 5c5": ("ff5", "fa5")}

    def design(x, v):
        cols = [np.log(x["gf_pg"].clip(0.5)), np.log(x["o_ga_pg"].clip(0.5)), x["home"]]
        if v:
            cols += [np.log(x[f"{v[0]}_pg"]), np.log(x[f"o_{v[1]}_pg"])]
        return np.column_stack(cols + [np.ones(len(x))])

    def fit(X, y):
        b0 = np.zeros(X.shape[1]); b0[-1] = np.log(y.mean())
        return minimize(lambda b: np.sum(np.exp(X @ b) - y * (X @ b)), b0,
                        jac=lambda b: X.T @ (np.exp(X @ b) - y), method="L-BFGS-B").x

    seasons = seasons_of(d["season"])
    res = {}
    for name, v in variants.items():
        dev, ll = {}, {}
        for S in seasons:
            tr, te = d[d["season"] < S], d[d["season"] == S]
            mu = np.exp(design(te, v) @ fit(design(tr, v), tr["gf"].values.astype(float)))
            dev[S] = deviance(te["gf"].values.astype(float), mu)
            ll[S] = win_logloss(te, mu).values
        res[name] = (dev, ll)
        print(f"   {name:22s} déviance {np.concatenate(list(dev.values())).mean():.5f}  "
              f"log-loss {np.concatenate(list(ll.values())).mean():.5f}", flush=True)
    ref = res["tirs cadrés (actuel)"]
    out = {"reference": "tirs cadrés (actuel)", "variants": {}}
    for name, (dev, ll) in res.items():
        if name == out["reference"]:
            continue
        out["variants"][name] = {"deviance": delta_stats(dev, ref[0], seasons),
                                 "logloss": delta_stats(ll, ref[1], seasons)}
        r = out["variants"][name]
        print(f"   Δ {name:22s} log-loss {r['logloss']['delta']:+.5f} (z {r['logloss']['z']:+.2f}, "
              f"{r['logloss']['seasons_better']}/{len(seasons)})  déviance {r['deviance']['delta']:+.5f}")
    return out


def part3(d: pd.DataFrame) -> dict:
    print("2b. Règles — le λ tel qu'écrit dans nhlPredictions.ts")
    L_GPG, L_SOG, L_FF = 3.05, 30.0, 42.7
    clamp = lambda x, lo, hi: np.minimum(hi, np.maximum(lo, x))
    seasons = seasons_of(d["season"])
    d = d[d["season"].isin(seasons)]

    def lam(mode):
        base = (d["gf_pg"] / L_GPG) * (d["o_ga_pg"] / L_GPG) * L_GPG
        if mode == "tirs":
            adj = clamp(1 + 0.12 * (d["sf_pg"] / L_SOG - 1), 0.9, 1.1)
        else:      # Fenwick : moyenne de son volume pour et du volume concédé par l'adversaire
            adj = clamp(1 + 0.12 * ((d["ff_pg"] + d["o_fa_pg"]) / 2 / L_FF - 1), 0.9, 1.1)
        return clamp(base * adj * np.where(d["home"] == 1, 1.02, 0.99), 1.5, 5.0).values

    res = {}
    for mode in ("tirs", "fenwick"):
        mu = lam(mode)
        ll = win_logloss(d, mu)
        dv = pd.Series(deviance(d["gf"].values.astype(float), mu), index=d["season"].values)
        res[mode] = ({S: ll[S].values for S in seasons}, {S: dv[S].values for S in seasons})
    out = {"logloss": delta_stats(res["fenwick"][0], res["tirs"][0], seasons),
           "deviance": delta_stats(res["fenwick"][1], res["tirs"][1], seasons)}
    print(f"   Fenwick − tirs : log-loss {out['logloss']['delta']:+.5f} ± {out['logloss']['se']:.5f} "
          f"({out['logloss']['seasons_better']}/{len(seasons)}), déviance {out['deviance']['delta']:+.5f}")
    return out


if __name__ == "__main__":
    report = {"classifier": part1()}
    std = season_to_date()
    report["rules_glm"] = part2(std)
    report["rules_formula"] = part3(std)
    path = f"{MODELS}/shot_metrics_report.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)       # ASCII échappé (cf. piège cp1252 sous Windows)
    print(f"✅ {path}")
    sys.exit(0)
