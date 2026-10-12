"""
live_pregame.py
===============
Chiffres d'AVANT-MATCH hors échantillon pour chaque match, point de départ des
prédictions en direct (`LIVE_PREDICTIONS_PLAN.md`, étapes 6 et 7).

Ce sont les trois entrées que le chemin ML en direct lit dans le paquet du
modèle (`gameMlBundle.applyLive`) : victoire du domicile (`moneyline`),
P(nul après 60 minutes) (`game_to_ot`) et λ domicile + visiteur. Elles viennent
du modèle de score walk-forward de `backtest_walkforward.py` : pour la saison
S, entraîné sur les saisons < S seulement (mêmes hyperparamètres par fold, même
τ, même P(dom en OT) ajustés sur le train du fold). Aucun match n'est donc
chiffré par un modèle qui l'a vu.

Écart connu avec la production : le partage de la prolongation est la
constante du fold, pas la logistique `p_ot_for` (le rejeu ne note que le
vainqueur à 60 minutes et le total, pas qui gagne la prolongation… sauf le
moneyline, où l'effet est de l'ordre du dixième de point).

Sortie (ignorée par git) : ml/data/live_pregame.csv

── --served : la chaîne SERVIE rejouée (2026-10-12, STATUS.md §3.5 P1) ──────
Base de référence de `discover_patterns.py` : un pattern se juge contre ce que
le service annonçait avant le match, pas contre le modèle brut — sinon on
« redécouvre » ce que la couche de correction et le recalage corrigent déjà
(c'est ce qu'a fait le pilote : 33 patterns sur 33 étaient l'ELO et le b2b).
Pour chaque saison S, sans jamais regarder l'avenir :
  1. modèle de score du fold (saisons < S), τ et prolongation LOGISTIQUE
     ajustés sur des λ out-of-fold — `backtest_walkforward._served_fold`, la
     même procédure que `--served` ;
  2. couche de correction (variante C, `CORRECTION_FEATURES`) ajustée sur les
     prédictions hors échantillon des saisons < S (au moins RECAL_MIN_SEASONS,
     donc à partir de 2015-16 avec --min-season 2012) ; avant : vide, p servie
     = p brute ; λ recalés pour donner la victoire corrigée
     (`lambdas_for_home_win`, comme `ml_service._align_distribution`) ;
  3. recalage de niveau : k de la saison S calculé sur les matchs de S datés au
     plus tard du samedi précédant le lundi de la semaine (gel hebdomadaire de
     `refresh_data.py`, `measure_level.refresh_cutoff`), n0 et verdict lus dans
     `level_report.json` ; la somme des λ est multipliée par k et la victoire
     conservée (`ml_service._apply_level`).
Écart connu avec la production : la couche servie est ajustée sur TOUTES les
saisons (`correction_layer.json`) ; ici chaque saison a la sienne, ajustée sur
son passé — c'est le but.

Sortie (ignorée par git) : ml/data/served_pregame.csv
  game_id, season, date,
  lam_home_raw, lam_away_raw, p_home_raw       modèle de score du fold
  p_home_corr                                  après correction (vide si pas de couche)
  level_k                                      k gelé le lundi
  lam_home, lam_away, p_home_win, p_reg_tie,   chaîne servie (correction + niveau)
  p_home_m15, p_over_55, exp_total

Usage :
    cd ml/python
    python live_pregame.py                    # saisons 2012-13 → 2025-26
    python live_pregame.py --min-season 2015
    python live_pregame.py --served           # chaîne servie → served_pregame.csv
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

import train_score as TS
from backtest_walkforward import (DATA, base_score_params, fit_score_fold, season_of)
from score_model import ScoreDistribution

OUT = "../data/live_pregame.csv"
OUT_SERVED = "../data/served_pregame.csv"
LEVEL_REPORT = "../models/level_report.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-season", type=int, default=2012)
    ap.add_argument("--search-trials", type=int, default=8)
    ap.add_argument("--served", action="store_true",
                    help="rejoue la chaîne servie (correction + niveau) → served_pregame.csv")
    ap.add_argument("--no-param-cache", action="store_true")
    a = ap.parse_args()

    df = pd.read_csv(DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(season_of)
    if a.served:
        return run_served_pregame(df, a.min_season, a.search_trials, not a.no_param_cache)
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    feats = TS.stacked_features()
    params = base_score_params(a.search_trials)

    rows = []
    for s in sorted(df["season"].unique()):
        if s < a.min_season:
            continue
        train_df = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        test_df = df[df["season"] == s].reset_index(drop=True)
        if len(train_df) < 800 or len(test_df) < 50:
            continue
        main_m, _, tau, p_ot = fit_score_fold(train_df, feats, params, 0,
                                              search_trials=a.search_trials, season=s)
        lam_h, lam_a = TS.lambdas_for(main_m, feats, TS.stack(test_df), len(test_df))
        for j in range(len(test_df)):
            d = ScoreDistribution(float(lam_h[j]), float(lam_a[j]), p_ot, tau)
            rows.append({"game_id": int(test_df.at[j, "game_id"]), "season": int(s),
                         "lam_home": round(float(lam_h[j]), 5),
                         "lam_away": round(float(lam_a[j]), 5),
                         "p_home_win": round(d.p_home_win(), 6),
                         "p_reg_tie": round(d.p_regulation_tie(), 6),
                         "p_ot_home": round(float(p_ot), 6)})
        print(f"  {s}-{str(s + 1)[2:]} : {len(test_df)} matchs (train {len(train_df)})")

    out = pd.DataFrame(rows)
    out.to_csv(OUT, index=False)
    print(f"✅ {len(out)} matchs → {os.path.relpath(OUT)}")


# ── --served ─────────────────────────────────────────────────────────────────

def _level_prior() -> float | None:
    """n0 du recalage de niveau, ou None si la mesure n'est pas adoptée (k = 1,
    comme `refresh_data.refresh_level`)."""
    try:
        with open(LEVEL_REPORT, encoding="utf-8") as fh:
            rep = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    return float(rep["prior_games"]) if rep.get("verdict") == "ADOPTER" else None


def _level_ks(cur: pd.DataFrame, lam_sum: np.ndarray, n0: float | None) -> np.ndarray:
    """k de chaque match de la saison, gelé comme en production : seuls comptent
    les matchs datés au plus tard du samedi précédant le lundi de sa semaine.
    Mêmes garde-fous que `refresh_level` (λ entre 0,5 et 8)."""
    from measure_level import refresh_cutoff
    from score_model import level_k

    if n0 is None:
        return np.ones(len(cur))
    days = pd.to_datetime(cur["date"]).dt.date.to_numpy()
    obs = (cur["home_reg_score"] + cur["away_reg_score"]).to_numpy(float)
    ok = np.isfinite(lam_sum) & np.isfinite(obs)
    order = np.argsort(days, kind="stable")
    d_sorted = days[order]
    cum_o = np.concatenate([[0.0], np.cumsum(np.where(ok, obs, 0.0)[order])])
    cum_l = np.concatenate([[0.0], np.cumsum(np.where(ok, lam_sum, 0.0)[order])])
    cum_n = np.concatenate([[0], np.cumsum(ok[order].astype(int))])
    idx = np.searchsorted(d_sorted, np.array([refresh_cutoff(x) for x in days]), side="right")
    return np.array([level_k(round(cum_o[i], 6), round(cum_l[i], 6), int(cum_n[i]), n0)
                     for i in idx])


def run_served_pregame(df: pd.DataFrame, min_season: int, search_trials: int, use_cache: bool):
    import backtest_walkforward as BW
    from score_model import lambdas_for_home_win

    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    atk, dfn = list(TS.ATK_COLS), list(TS.DEF_COLS)
    base = base_score_params(search_trials)
    n0 = _level_prior()
    print(f"📂 chaîne servie walk-forward — recalage de niveau : "
          + (f"n0 = {n0:g}" if n0 is not None else "non adopté (k = 1)"))

    # 1. Modèle de score du fold, saison par saison (même procédure que --served)
    F = {}
    for s in sorted(df["season"].unique()):
        if s < min_season:
            continue
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = BW.search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                       TS.stacked_features(atk, dfn), base, search_trials,
                                       seed=42, season=s, use_cache=use_cache, atk=atk, dfn=dfn)
        fold = BW._served_fold(prior, cur, atk, dfn, params)
        raw = [ScoreDistribution(h, a_, fold["p_ot_fn"](h, a_), fold["tau"])
               for h, a_ in zip(fold["lh"], fold["la"])]
        F[s] = {**fold, "cur": cur, "raw": raw,
                "p": np.array([d.p_home_win() for d in raw]),
                "y": cur["home_win"].to_numpy(float),
                "X": BW._correction_X(cur, BW.CORRECTION_FEATURES)}
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(cur):>6} matchs prédits (train {len(prior)})")

    # 2. Correction walk-forward (variante C) + 3. niveau gelé le lundi
    ks = sorted(F)
    rows = []
    print("\n   correction + recalage de niveau (≈ 2-5 min, bissections) :", flush=True)
    for i, s in enumerate(ks):
        print(f"   {s}-{str(s + 1)[2:]:<2} …", flush=True)
        f = F[s]
        past = ks[:i]
        p_corr = np.full(len(f["p"]), np.nan)
        if len(past) >= BW.RECAL_MIN_SEASONS:
            y_tr = np.concatenate([F[x]["y"] for x in past])
            lp_tr = BW._logit(np.concatenate([F[x]["p"] for x in past]))
            X_tr = np.concatenate([F[x]["X"] for x in past])
            mu, sd = np.nanmean(X_tr, axis=0), np.nanstd(X_tr, axis=0)
            sd[sd == 0] = 1.0
            std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
            b, _ = BW._logistic_offset(y_tr, np.column_stack([lp_tr, std(X_tr)]), np.zeros(len(y_tr)))
            p_corr = 1 / (1 + np.exp(-(b[0] + np.column_stack([BW._logit(f["p"]), std(f["X"])]) @ b[1:])))
        lam_raw = f["lh"] + f["la"]
        guard = (f["lh"] >= 0.5) & (f["lh"] <= 8.0) & (f["la"] >= 0.5) & (f["la"] <= 8.0)
        k = _level_ks(f["cur"], np.where(guard, lam_raw, np.nan), n0)
        tau, p_ot_fn = f["tau"], f["p_ot_fn"]
        for j, d0 in enumerate(f["raw"]):
            lh, la = float(f["lh"][j]), float(f["la"][j])
            p_target = d0.p_home_win()
            if np.isfinite(p_corr[j]):
                p_target = float(p_corr[j])
                lh, la = lambdas_for_home_win(lh + la, p_target, p_ot_fn, tau)
            if k[j] != 1.0:
                lh, la = lambdas_for_home_win(k[j] * (lh + la), p_target, p_ot_fn, tau)
            d = ScoreDistribution(lh, la, p_ot_fn(lh, la), tau)
            r = f["cur"].iloc[j]
            rows.append({"game_id": int(r["game_id"]), "season": int(s), "date": str(r["date"]),
                         "lam_home_raw": round(float(f["lh"][j]), 5),
                         "lam_away_raw": round(float(f["la"][j]), 5),
                         "p_home_raw": round(d0.p_home_win(), 6),
                         "p_home_corr": round(float(p_corr[j]), 6) if np.isfinite(p_corr[j]) else np.nan,
                         "level_k": round(float(k[j]), 6),
                         "lam_home": round(lh, 5), "lam_away": round(la, 5),
                         "p_home_win": round(d.p_home_win(), 6),
                         "p_reg_tie": round(d.p_regulation_tie(), 6),
                         "p_home_m15": round(d.p_home_cover_minus_15(), 6),
                         "p_over_55": round(d.p_over(5.5), 6),
                         "exp_total": round(d.expected_total(), 5)})

    out = pd.DataFrame(rows)
    out.to_csv(OUT_SERVED, index=False)
    _report_served(out, df)
    print(f"✅ {len(out)} matchs → {os.path.relpath(OUT_SERVED)}")


def _report_served(out: pd.DataFrame, df: pd.DataFrame):
    """Contrôle : log-loss moneyline brut / servi / marché et déviance du total,
    par saison. Le servi doit battre le brut (correction_report, level_report)."""
    m = out.merge(df[["game_id", "home_win", "home_reg_score", "away_reg_score",
                      "market_home_p_close"]], on="game_id")
    ll = lambda y, p: -(y * np.log(np.clip(p, 1e-6, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-6, 1)))

    def dev(y, mu):
        mu = np.clip(mu, 1e-6, None)
        t = np.where(y > 0, y * np.log(np.where(y > 0, y, 1.0) / mu), 0.0)
        return 2.0 * (t - (y - mu))

    obs = (m["home_reg_score"] + m["away_reg_score"]).to_numpy(float)
    print(f"\n   {'saison':<8}{'n':>6}{'LL brut':>10}{'LL servi':>10}{'LL marché':>11}"
          f"{'dév. brut':>11}{'dév. servi':>11}{'k fin':>8}")
    for s, g in m.groupby("season"):
        y = g["home_win"].to_numpy(float)
        o = (g["home_reg_score"] + g["away_reg_score"]).to_numpy(float)
        mk = g["market_home_p_close"].notna().to_numpy()
        llm = f"{ll(y[mk], g['market_home_p_close'].to_numpy()[mk]).mean():.5f}" if mk.any() else "—"
        # total réglementaire servi : λ recalés (la correction garde la somme)
        print(f"   {s:<8}{len(g):>6}{ll(y, g['p_home_raw']).mean():>10.5f}"
              f"{ll(y, g['p_home_win']).mean():>10.5f}{llm:>11}"
              f"{dev(o, g['lam_home_raw'] + g['lam_away_raw']).mean():>11.5f}"
              f"{dev(o, g['lam_home'] + g['lam_away']).mean():>11.5f}{g['level_k'].iloc[-1]:>8.4f}")
    c = m[m["p_home_corr"].notna()]
    y = c["home_win"].to_numpy(float)
    d = ll(y, c["p_home_win"]) - ll(y, c["p_home_raw"])
    o = (c["home_reg_score"] + c["away_reg_score"]).to_numpy(float)
    dd = dev(o, c["lam_home"] + c["lam_away"]) - dev(o, c["lam_home_raw"] + c["lam_away_raw"])
    print(f"\n   saisons corrigées ({c['season'].min()}-{c['season'].max()}, {len(c)} matchs) : "
          f"Δ log-loss servi − brut {d.mean():+.5f} (z {d.mean() / (d.std(ddof=1) / np.sqrt(len(d))):+.2f}), "
          f"Δ déviance du total {dd.mean():+.5f} (z {dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd))):+.2f})")


if __name__ == "__main__":
    main()
