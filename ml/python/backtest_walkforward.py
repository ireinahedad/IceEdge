"""
backtest_walkforward.py
=======================
Backtest ROI HONNÊTE, saison par saison, sur la période couverte par les cotes.

Le backtest.py standard échoue quand les cotes (gratuites → fin 2022-23) tombent
dans la période d'entraînement. Ici on fait du walk-forward :

  Pour chaque saison S ayant des cotes (et au moins 1 saison d'historique) :
    • entraîne un modèle sur TOUS les matchs des saisons < S
    • calibre (Platt) sur les 15 % finaux du train
    • prédit la saison S (jamais vue), blend avec le marché
    • parie en value betting → accumule le ROI

Aucun match n'est jamais prédit après avoir été vu à l'entraînement → ROI réaliste.

Usage :
    cd ml/python
    python backtest_walkforward.py                 # toutes les saisons avec cotes
    python backtest_walkforward.py --min-season 2015
    python backtest_walkforward.py --edge 0.04     # seuil d'edge unique détaillé
"""

import argparse
import json

import numpy as np
import pandas as pd
import xgboost as xgb

import train as T   # réutilise select_features, fit_logistic, _logit, métriques

DATA   = "../data/nhl_games_v4.csv"
MODELS = "../models"


def season_of(date_str: str) -> int:
    y, m = int(str(date_str)[:4]), int(str(date_str)[5:7])
    return y if m >= 8 else y - 1


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def fit_fold(train_df, feats, params):
    """Entraîne + calibre un modèle sur un fold. Retourne (booster, w_platt)."""
    n = len(train_df)
    cut = int(n * 0.85)
    tr, cal = train_df.iloc[:cut], train_df.iloc[cut:]

    def dm(d):
        return xgb.DMatrix(d[feats].values.astype(np.float32),
                           label=d["home_win"].values.astype(np.float32),
                           feature_names=feats, missing=np.nan)

    rounds = params.get("_rounds", 400)
    clean_params = {k: v for k, v in params.items() if not k.startswith("_")}
    booster = xgb.train(clean_params, dm(tr), num_boost_round=rounds,
                        evals=[(dm(cal), "cal")], early_stopping_rounds=40,
                        verbose_eval=False)
    p_cal = booster.predict(dm(cal))
    w = T.fit_logistic(T._logit(p_cal).reshape(-1, 1),
                       cal["home_win"].values.astype(np.float32))
    return booster, w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-season", type=int, default=2012)
    ap.add_argument("--edge", type=float, default=None,
                    help="Si fourni, détaille un seuil d'edge unique par saison")
    args = ap.parse_args()

    df = pd.read_csv(DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    if "market_home_p_close" not in df.columns:
        print("❌ Pas de colonne cotes — relance fetch odds + build_dataset."); return
    df["season"] = df["date"].map(season_of)

    feats = T.select_features(df, use_odds=True)
    # Params : ceux du dernier train.py si dispo, sinon défauts raisonnables
    try:
        rep = json.load(open(f"{MODELS}/training_report.json"))
        params = {k: v for k, v in rep["game_model"]["params"].items()}
    except Exception:
        params = {"max_depth": 4, "learning_rate": 0.03, "subsample": 0.8,
                  "colsample_bytree": 0.7, "min_child_weight": 5,
                  "reg_alpha": 0.1, "reg_lambda": 3.0}
    params.update({"objective": "binary:logistic", "eval_metric": "logloss",
                   "seed": 42, "_rounds": 400})

    odds_seasons = sorted(s for s in df["season"].unique()
                          if df.loc[df["season"] == s, "market_home_p_close"].notna().sum() >= 50)
    test_seasons = [s for s in odds_seasons if s >= args.min_season
                    and (df["season"] < s).sum() >= 800]
    if not test_seasons:
        print("❌ Aucune saison testable (pas assez d'historique + cotes)."); return

    print(f"📊 Walk-forward sur {len(test_seasons)} saisons : "
          f"{test_seasons[0]}-{str(test_seasons[0]+1)[2:]} → "
          f"{test_seasons[-1]}-{str(test_seasons[-1]+1)[2:]}")
    print(f"   {len(feats)} features (cotes incluses)\n")

    all_bets = []          # (p_model, dec, won) pour l'agrégat
    ll_model_all, ll_mkt_all, y_all = [], [], []

    print(f"   {'saison':>8} {'matchs':>7} {'ll_modèle':>10} {'ll_marché':>10}")
    for s in test_seasons:
        train_df = df[df["season"] < s]
        test_df  = df[(df["season"] == s) & df["market_home_p_close"].notna()].copy()
        if len(test_df) < 50:
            continue
        booster, w = fit_fold(train_df, feats, params)
        dtest = xgb.DMatrix(test_df[feats].values.astype(np.float32),
                            feature_names=feats, missing=np.nan)
        p_raw = booster.predict(dtest)
        p_cal = _sigmoid(w[0] * T._logit(p_raw) + w[1])
        p_mkt = test_df["market_home_p_close"].values
        # blend simple modèle+marché (fixé, pas ré-ajusté par saison → honnête)
        p_model = _sigmoid(0.55 * T._logit(p_cal) + 0.55 * T._logit(p_mkt))

        y = test_df["home_win"].values.astype(float)
        dec_h = test_df["home_ml_close"].values
        dec_a = test_df["away_ml_close"].values
        ll_m = T.log_loss_np(y, p_model)
        ll_k = T.log_loss_np(y, p_mkt)
        ll_model_all.append(ll_m * len(y)); ll_mkt_all.append(ll_k * len(y))
        y_all.append(len(y))
        print(f"   {s}-{str(s+1)[2:]:<2} {len(test_df):>7} {ll_m:>10.4f} {ll_k:>10.4f}")

        for i in range(len(test_df)):
            if not (np.isfinite(dec_h[i]) and np.isfinite(dec_a[i])):
                continue
            for p, dec, won in [(p_model[i], dec_h[i], y[i] == 1),
                                (1 - p_model[i], dec_a[i], y[i] == 0)]:
                if dec <= 1:
                    continue
                p_imp = (1 / dec) / (1 / dec_h[i] + 1 / dec_a[i])
                all_bets.append((p, dec, won, p - p_imp))

    tot = sum(y_all)
    print(f"\n   Log-loss agrégé : modèle {sum(ll_model_all)/tot:.4f}  "
          f"vs marché {sum(ll_mkt_all)/tot:.4f}  ({tot} matchs)")

    bets = np.array([(p, dec, won, edge) for p, dec, won, edge in all_bets])
    print(f"\n   ROI value betting (toutes saisons agrégées) :")
    print(f"   {'edge>':>6} {'paris':>6} {'hit%':>6} {'ROI flat':>9} {'ROI ¼Kelly':>11}")
    results = []
    thresholds = [args.edge] if args.edge is not None else [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]
    for edge in thresholds:
        sel = bets[bets[:, 3] >= edge]
        if len(sel) == 0:
            print(f"   {edge:>5.0%} {0:>6}"); continue
        p, dec, won = sel[:, 0], sel[:, 1], sel[:, 2]
        profit_flat = np.where(won == 1, dec - 1, -1).sum()
        b = dec - 1
        k = np.clip((p * b - (1 - p)) / b, 0, None) * 0.25
        profit_k = np.where(won == 1, k * b, -k).sum()
        stake_k = k.sum()
        roi_f = profit_flat / len(sel) * 100
        roi_k = profit_k / stake_k * 100 if stake_k > 0 else 0
        hit = won.mean() * 100
        results.append({"edge": edge, "n_bets": int(len(sel)), "hit_rate": round(hit, 2),
                        "roi_flat_pct": round(roi_f, 2), "roi_kelly_pct": round(roi_k, 2)})
        print(f"   {edge:>5.0%} {len(sel):>6} {hit:>5.1f}% {roi_f:>8.2f}% {roi_k:>10.2f}%")

    json.dump({"seasons": [int(s) for s in test_seasons],
               "n_games_with_odds": int(tot),
               "log_loss": {"model": round(sum(ll_model_all)/tot, 4),
                            "market": round(sum(ll_mkt_all)/tot, 4)},
               "roi": results},
              open(f"{MODELS}/backtest_walkforward_report.json", "w"), indent=2)
    print(f"\n✅ backtest_walkforward_report.json → {MODELS}/")
    print("   Un ROI flat > 0 avec plusieurs centaines de paris sur des cotes de "
          "clôture est un très bon signe (la clôture est le prix le plus dur à battre).")


if __name__ == "__main__":
    main()
