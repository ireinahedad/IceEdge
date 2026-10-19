"""Ablation PAR FAMILLE du modèle de score (26 features servies), walk-forward.

Question (document technique, §4.1) : combien de log-loss perd-on quand on
retire chaque famille de variables, le reste du modèle étant réentraîné ?

Différence avec `--select-score-features` (score_feature_selection.json) :
celui-là permutait UNE variable à la fois, sur l'ancien jeu de 22. Ici on
RETIRE une famille entière et on réentraîne, sur le jeu servi de 26. Le
retrait d'une famille mesure ce qu'elle apporte que les autres ne remplacent
pas — la somme des gains par variable ne le donne pas (variables corrélées).

Protocole (fixé avant le run) :
- 14 saisons testées (2012-13 à 2025-26), chacune prédite par un modèle
  entraîné sur les saisons antérieures seulement.
- Chaque variante passe par `_eval_v2`, la chaîne servie (τ + prolongation
  dépendante de l'affiche ajustés sur le train du fold, λ out-of-fold), avec
  sa PROPRE recherche d'hyperparamètres par fold (8 essais, cache indexé sur
  les features) : une variante n'hérite pas des réglages du modèle complet.
- Gain d'une famille = log-loss SANS elle − log-loss du modèle complet, par
  match. Positif = la famille aide. Test apparié par match (z = moyenne /
  erreur-type) et nombre de saisons où le retrait dégrade.
- Aucun verdict d'adoption : c'est une mesure descriptive. |z| >= 2 est lu
  comme « résolu », en deçà « non résolu ».
- Contrôle : la variante complète doit reproduire `ll_raw` de
  correction_report.json (même chaîne, mêmes paramètres en cache).

Lancer depuis ml/python :  python ablation_familles.py
Sortie : ../models/score_family_ablation.json
"""
from __future__ import annotations

import json
import os
import pickle
import sys
import time

import numpy as np
import pandas as pd
import xgboost as xgb

import backtest_walkforward as BW
import train_score as TS
from score_model import ScoreDistribution, fit_margin_correction, stretch_lambdas

OUT = f"{BW.MODELS}/score_family_ablation.json"
CKPT = f"{BW.MODELS}/score_family_ablation_ckpt.pkl"
SEARCH_TRIALS = 8

# Les 26 features servies, réparties en familles disjointes (is_home reste :
# variable structurelle, sans elle les deux lignes d'un match sont confondues).
FAMILIES = {
    "socle": {"label": "Stats d'équipe (xG, Corsi, buts, unités spéciales)",
              "atk": ["xgf60_s", "xgf60_l", "ev_xgf60_s", "ev_xgf_pct_s", "ev_xgf_pct_l",
                      "gf_s", "finishing_s", "pp_xgf60_s"],
              "def": ["xga60_s", "xga60_l", "ev_xga60_s", "ga_s", "pk_xga60_s"],
              "extra": []},
    "gardien": {"label": "Gardien partant (adverse)",
                "atk": [], "def": ["goalie_gsax60", "goalie_svpct", "goalie_backup"],
                "extra": []},
    "alignement": {"label": "Alignement du soir",
                   "atk": ["lineup_xg", "lineup_pts"], "def": [], "extra": []},
    "joueurs_cles": {"label": "Joueurs-clés",
                     "atk": ["star_power", "stars_out_weight"], "def": [], "extra": []},
    "calendrier": {"label": "Calendrier (repos, dos-à-dos)",
                   "atk": ["rest_days", "b2b"], "def": ["rest_days", "b2b"], "extra": []},
    "elo": {"label": "ELO", "atk": [], "def": [], "extra": ["elo_atk_minus_def"]},
}


def check_partition():
    atk_all = set(TS.ATK_COLS)
    def_all = set(TS.DEF_COLS)
    a = [c for f in FAMILIES.values() for c in f["atk"]]
    d = [c for f in FAMILIES.values() for c in f["def"]]
    assert len(a) == len(set(a)) and set(a) == atk_all, (sorted(atk_all ^ set(a)))
    assert len(d) == len(set(d)) and set(d) == def_all, (sorted(def_all ^ set(d)))
    assert len(TS.stacked_features()) == 26, len(TS.stacked_features())


def eval_variant(train_df, test_df, atk, dfn, drop_extra, params) -> dict:
    """Copie de `BW._eval_v2` (use_gamma=False) avec une liste de features
    filtrée — `stacked_features` ajoute toujours is_home et l'ELO."""
    feats = [f for f in TS.stacked_features(atk, dfn) if f not in drop_extra]
    cut = int(len(train_df) * 0.85)
    tr, cal = train_df.iloc[:cut].reset_index(drop=True), train_df.iloc[cut:].reset_index(drop=True)
    s_tr, s_cal = TS.stack(tr, atk, dfn), TS.stack(cal, atk, dfn)
    m = xgb.train(params, TS.dm(s_tr, feats), num_boost_round=700,
                  evals=[(TS.dm(s_cal, feats), "cal")],
                  early_stopping_rounds=40, verbose_eval=False)
    ot = train_df[train_df["went_to_ot"] == 1]
    p_ot_home = float((ot["home_score"] > ot["away_score"]).mean()) if len(ot) else 0.5
    lh_tr, la_tr = TS.oof_lambdas(train_df, feats, params, int(m.best_iteration) + 1,
                                  atk_cols=atk, def_cols=dfn)
    lh_tr, la_tr = stretch_lambdas(lh_tr, la_tr, 1.0)
    tau = fit_margin_correction(
        (train_df["home_reg_score"] - train_df["away_reg_score"]).to_numpy(),
        TS.expected_margin_pmf(lh_tr, la_tr))
    ot_model = TS.fit_ot_model(train_df.reset_index(drop=True), lh_tr, la_tr, p_ot_home)

    s_te = TS.stack(test_df.reset_index(drop=True), atk, dfn)
    lh, la = TS.lambdas_for(m, feats, s_te, len(test_df))
    p_ot = TS.p_ot_series(ot_model, lh, la, p_ot_home)
    p_ot = np.broadcast_to(np.asarray(p_ot, float), (len(lh),))
    dists = [ScoreDistribution(h, a, po, tau) for h, a, po in zip(lh, la, p_ot)]

    def ll(yv, p):
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return -(yv * np.log(p) + (1 - yv) * np.log(1 - p))

    def dev(y, mu):
        mu = np.clip(mu, 1e-6, None)
        with np.errstate(divide="ignore", invalid="ignore"):
            return 2.0 * (np.where(y > 0, y * np.log(y / mu), 0.0) - (y - mu))

    margin = (test_df["home_score"] - test_df["away_score"]).to_numpy(float)
    p_hc = np.array([d.p_home_cover_minus_15() for d in dists])
    p_ac = 1.0 - np.array([d.p_home_cover_plus_15() for d in dists])
    p_ml = np.array([d.p_home_win() for d in dists])
    yh, ya = test_df["home_reg_score"].to_numpy(float), test_df["away_reg_score"].to_numpy(float)
    return {"pl": 0.5 * (ll((margin >= 2).astype(float), p_hc)
                         + ll((margin <= -2).astype(float), p_ac)),
            "ml": ll(test_df["home_win"].to_numpy(float), p_ml),
            "dev": (dev(yh, lh) + dev(ya, la)) / 2.0,
            "n_feats": len(feats), "n_rounds": int(m.best_iteration) + 1}


def main():
    check_partition()
    only = sys.argv[1:]  # ex. `python ablation_familles.py complet` pour le contrôle
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(BW.season_of)
    seasons = [s for s in sorted(df["season"].unique())
               # 2012-13 à 2025-26 : la saison en cours est partielle, exclue
               # (même fenêtre que score_feature_selection.json).
               if 2012 <= s <= 2025 and (df["season"] < s).sum() >= 800
               and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    base = BW.base_score_params(SEARCH_TRIALS)
    variants = {"complet": ([], [], [])}
    for k, f in FAMILIES.items():
        variants[k] = (f["atk"], f["def"], f["extra"])
    if only:
        variants = {k: v for k, v in variants.items() if k in only}

    res = {}
    if os.path.exists(CKPT):
        res = pickle.load(open(CKPT, "rb"))
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        for name, (ra, rd, rx) in variants.items():
            if (s, name) in res:
                continue
            t0 = time.time()
            atk = [c for c in TS.ATK_COLS if c not in ra]
            dfn = [c for c in TS.DEF_COLS if c not in rd]
            feats = [f for f in TS.stacked_features(atk, dfn) if f not in rx]
            params = BW.search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                           feats, base, SEARCH_TRIALS, seed=42, season=s,
                                           use_cache=True, atk=atk, dfn=dfn)
            r = eval_variant(prior, cur, atk, dfn, rx, params)
            r["n_games"] = len(cur)
            res[(s, name)] = r
            pickle.dump(res, open(CKPT, "wb"))
            print(f"   {s}-{str(s + 1)[2:]} {name:>13} {r['n_feats']:>2} feats  "
                  f"ML {r['ml'].mean():.5f}  PL {r['pl'].mean():.5f}  "
                  f"DEV {r['dev'].mean():.5f}  ({time.time() - t0:.0f} s)", flush=True)

    names = ["complet"] + list(FAMILIES)
    seas = [s for s in seasons if all((s, n) in res for n in names)]
    if len(seas) < len(seasons):
        print(f"   incomplet : {len(seas)}/{len(seasons)} saisons — pas de rapport")
        return
    cat = {n: {k: np.concatenate([res[(s, n)][k] for s in seas]) for k in ("ml", "pl", "dev")}
           for n in names}
    season_lab = np.concatenate([np.full(res[(s, "complet")]["n_games"], s) for s in seas])
    ref = cat["complet"]
    out = {"protocol": {
               "method": "retrait d'une famille + réentraînement, walk-forward, chaîne servie (_eval_v2, sans gamma)",
               "gain": "log-loss sans la famille − log-loss du modèle complet, par match ; POSITIF = la famille aide",
               "test": "apparié par match, z = moyenne / erreur-type ; |z| >= 2 lu comme résolu",
               "search_trials_per_fold": SEARCH_TRIALS,
               "seasons": [int(s) for s in seas],
               "n_games": int(len(season_lab)),
               "control": "variante complète vs ll_raw de correction_report.json"},
           "families": {k: {"label": f["label"],
                            "features": [f"atk_{c}" for c in f["atk"]] + [f"def_{c}" for c in f["def"]] + f["extra"]}
                        for k, f in FAMILIES.items()},
           "baseline": {k: round(float(ref[k].mean()), 6) for k in ("ml", "pl", "dev")},
           "baseline_by_season": {int(s): {k: round(float(res[(s, "complet")][k].mean()), 5)
                                           for k in ("ml", "pl", "dev")} for s in seas},
           "ablation": {}}
    print(f"\n   {'famille':>13} {'gain ML':>9} {'z':>6} {'s+':>6} {'gain PL':>9} {'z':>6} "
          f"{'s+':>6} {'gain DEV':>9} {'z':>6}")
    for n in FAMILIES:
        row = {}
        for k in ("ml", "pl", "dev"):
            d = cat[n][k] - ref[k]
            p = BW._paired(d)
            worse = [int(s) for s in seas if d[season_lab == s].mean() > 0]
            row[k] = {**p, "seasons_worse_without": len(worse), "of": len(seas),
                      "by_season": {int(s): round(float(d[season_lab == s].mean()), 6) for s in seas}}
        out["ablation"][n] = row
        print(f"   {n:>13} {row['ml']['delta']:>+9.5f} {row['ml']['z']:>+6.2f} "
              f"{row['ml']['seasons_worse_without']:>3}/{len(seas):<2} "
              f"{row['pl']['delta']:>+9.5f} {row['pl']['z']:>+6.2f} "
              f"{row['pl']['seasons_worse_without']:>3}/{len(seas):<2} "
              f"{row['dev']['delta']:>+9.5f} {row['dev']['z']:>+6.2f}")
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(f"\nOK {OUT}")


if __name__ == "__main__":
    main()
