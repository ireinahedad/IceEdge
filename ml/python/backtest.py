"""
backtest.py
===========
Backtest walk-forward par saison — le test d'honnêteté du modèle.

Pour chaque saison N (à partir de la 2e) :
  - entraîne UNIQUEMENT sur les saisons < N (early stopping sur les 15 % finaux du train)
  - prédit la saison N entière (jamais vue, y compris pour l'ELO et la calibration)
  - compare aux baselines : domicile-toujours, constante, ELO seul

Usage :
    cd ml/python
    python backtest.py
"""

import numpy as np
import pandas as pd
import xgboost as xgb

from train import (
    DATA_PATH, GAME_FEATURES, ALL_GAME_FEATURES,
    add_diff_features, add_elo_features,
    fit_platt, apply_platt,
    log_loss_np, brier_score, accuracy,
)

PARAMS = {
    "objective":        "binary:logistic",
    "eval_metric":      "logloss",
    "max_depth":        4,
    "learning_rate":    0.04,
    "subsample":        0.8,
    "colsample_bytree": 0.8,
    "min_child_weight": 3,
    "gamma":            0.1,
    "reg_alpha":        0.1,
    "reg_lambda":       1.0,
    "seed":             42,
}


def season_labels(dates: pd.Series) -> np.ndarray:
    """Numérote les saisons via les trous > 60 jours dans le calendrier."""
    d = pd.to_datetime(dates).reset_index(drop=True)
    labels = np.zeros(len(d), dtype=int)
    season = 0
    for i in range(1, len(d)):
        if (d[i] - d[i - 1]).days > 60:
            season += 1
        labels[i] = season
    return labels


def evaluate(name: str, y: np.ndarray, p: np.ndarray) -> dict:
    return {
        "name":     name,
        "accuracy": accuracy(y, p),
        "log_loss": log_loss_np(y, p),
        "brier":    brier_score(y, p),
    }


def main():
    df = pd.read_csv(DATA_PATH)
    base_available = [f for f in GAME_FEATURES if f in df.columns]
    df = df.dropna(subset=base_available + ["home_win", "date"]).copy()
    df = add_diff_features(df)
    df, _ = add_elo_features(df)          # séquentiel → toujours pré-match
    df = df.sort_values("date").reset_index(drop=True)
    df["season"] = season_labels(df["date"])

    features = [f for f in ALL_GAME_FEATURES if f in df.columns]
    n_seasons = df["season"].max() + 1
    print(f"{len(df)} matchs, {n_seasons} saisons, {len(features)} features\n")

    rows = []
    for s in range(1, n_seasons):
        train = df[df["season"] < s]
        test  = df[df["season"] == s]
        if len(train) < 400 or len(test) < 100:
            continue

        # 15 % finaux du train = validation (early stopping + calibration)
        cut  = int(len(train) * 0.85)
        tr, val = train.iloc[:cut], train.iloc[cut:]

        Xtr  = tr[features].values.astype(np.float32)
        ytr  = tr["home_win"].values.astype(np.float32)
        Xv   = val[features].values.astype(np.float32)
        yv   = val["home_win"].values.astype(np.float32)
        Xte  = test[features].values.astype(np.float32)
        yte  = test["home_win"].values.astype(np.float32)

        dtr = xgb.DMatrix(Xtr, label=ytr, feature_names=features)
        dv  = xgb.DMatrix(Xv,  label=yv,  feature_names=features)
        dte = xgb.DMatrix(Xte, label=yte, feature_names=features)

        model = xgb.train(PARAMS, dtr, num_boost_round=500,
                          evals=[(dv, "val")], early_stopping_rounds=40,
                          verbose_eval=False)

        p_raw = model.predict(dte)
        a, b  = fit_platt(model.predict(dv), yv)
        p_cal = apply_platt(p_raw, a, b)

        results = [
            evaluate("XGBoost brut",     yte, p_raw),
            evaluate("XGBoost calibré",  yte, p_cal),
            evaluate("ELO seul",         yte, test["elo_expected"].values.astype(np.float32)),
            evaluate("Constante (taux domicile train)", yte, np.full(len(yte), ytr.mean(), dtype=np.float32)),
        ]
        home_acc = float(yte.mean())  # accuracy de « domicile gagne toujours »

        print(f"── Saison {s + 1} ({test['date'].min()} → {test['date'].max()}, "
              f"{len(test)} matchs) — entraîné sur {len(train)}")
        print(f"   {'Baseline domicile-toujours':<34} acc {home_acc:.3f}")
        for r in results:
            edge = r["accuracy"] - home_acc
            print(f"   {r['name']:<34} acc {r['accuracy']:.3f} ({edge:+.3f})  "
                  f"log-loss {r['log_loss']:.4f}  brier {r['brier']:.4f}")
        print()
        for r in results:
            rows.append({"season": s + 1, **r, "home_acc": home_acc, "n": len(test)})

    # Agrégat pondéré par le nombre de matchs
    agg = pd.DataFrame(rows)
    if agg.empty:
        print("Pas assez de données pour un backtest.")
        return
    print("═══ AGRÉGAT (pondéré par saison) ═══")
    home = float(np.average(agg.groupby("season")["home_acc"].first(),
                            weights=agg.groupby("season")["n"].first()))
    print(f"   {'Baseline domicile-toujours':<34} acc {home:.3f}")
    for name, g in agg.groupby("name", sort=False):
        acc = float(np.average(g["accuracy"], weights=g["n"]))
        ll  = float(np.average(g["log_loss"], weights=g["n"]))
        br  = float(np.average(g["brier"],    weights=g["n"]))
        print(f"   {name:<34} acc {acc:.3f} ({acc - home:+.3f})  "
              f"log-loss {ll:.4f}  brier {br:.4f}")
    print("\nLecture : le modèle est utile si « XGBoost calibré » bat à la fois")
    print("la baseline domicile ET la constante en log-loss, sur PLUSIEURS saisons.")


if __name__ == "__main__":
    main()
