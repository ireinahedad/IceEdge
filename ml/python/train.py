"""
train.py (v4)
=============
Entraînement XGBoost sur le dataset v4 (MoneyPuck + gardiens + stars + cotes).
Aucune dépendance scikit-learn — fonctionne sur Python 3.14+.

Nouveautés v4 :
  • Features auto-détectées depuis nhl_games_v4.csv (xG, gardiens, stars, cotes…)
  • Recherche aléatoire d'hyperparamètres sur le set de VALIDATION (log-loss)
  • Le modèle apprend AVEC les cotes en feature (NaN si absentes — XGBoost gère)
  • Blend final modèle ⊕ marché (régression logistique 2D ajustée sur val)
  • Baselines honnêtes : domicile, constant, ELO seul, MARCHÉ seul
  • Rétro-compatible : si nhl_games_v4.csv absent, retombe sur nhl_games.csv (v3)

Usage :
    cd ml/python
    python fetch_data_v4.py && python build_dataset.py    # d'abord
    python train.py [--trials 40] [--no-odds-features]
"""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

DATA_V4    = "../data/nhl_games_v4.csv"
DATA_V3    = "../data/nhl_games.csv"
MODELS_DIR = "../models"

RNG = np.random.default_rng(42)

# ── Métriques (sans scikit-learn) ────────────────────────────────────────────

def log_loss_np(y, p, eps=1e-7):
    p = np.clip(p, eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))

def brier(y, p):
    return float(np.mean((p - y) ** 2))

def accuracy(y, p, t=0.5):
    return float(np.mean((p >= t).astype(int) == y))

def mae(y, p):
    return float(np.mean(np.abs(p - y)))

def rmse(y, p):
    return float(np.sqrt(np.mean((p - y) ** 2)))


# ── Calibration de Platt + blend marché ──────────────────────────────────────

def _logit(p, eps=1e-7):
    p = np.clip(p, eps, 1 - eps)
    return np.log(p / (1 - p))

def fit_logistic(X: np.ndarray, y: np.ndarray, lr=0.1, iters=4000) -> np.ndarray:
    """Régression logistique par descente de gradient. X: (n, k). Retourne (k+1,) [w..., b]."""
    n, k = X.shape
    w = np.zeros(k + 1)
    Xb = np.hstack([X, np.ones((n, 1))])
    for _ in range(iters):
        q = 1.0 / (1.0 + np.exp(-(Xb @ w)))
        w -= lr * (Xb.T @ (q - y)) / n
    return w

def apply_logistic(X: np.ndarray, w: np.ndarray) -> np.ndarray:
    Xb = np.hstack([X, np.ones((X.shape[0], 1))])
    return 1.0 / (1.0 + np.exp(-(Xb @ w)))


# ── Sélection des features ───────────────────────────────────────────────────

META = {"game_id", "season", "date", "home_team", "away_team", "home_score",
        "away_score", "home_win", "total_goals",
        "home_ml_open", "away_ml_open", "home_ml_close", "away_ml_close",
        "total_open", "total_close"}

ODDS_FEATURES = ["market_home_p_open", "market_home_p_close"]

def select_features(df: pd.DataFrame, use_odds: bool) -> list[str]:
    feats = []
    for c in df.columns:
        if c in META:
            continue
        if c in ODDS_FEATURES:
            if use_odds:
                feats.append(c)
            continue
        if df[c].dtype.kind not in "fib":
            continue
        if df[c].notna().mean() < 0.30:      # features quasi vides
            continue
        if df[c].std(skipna=True) < 1e-9:    # variance nulle
            continue
        feats.append(c)
    return feats

TOTALS_KEYWORDS = ("gf", "ga", "xgf", "xga", "hdxg", "sog", "finishing", "goalie",
                   "pp_", "pk_", "rest", "b2b", "3in4", "total_close", "total_open",
                   # ── voyage / calendrier / altitude (impact fatigue + scoring)
                   "distance", "tz_shift", "days_away", "road_trip", "road_game",
                   "getaway", "altitude", "alt_gain")

def select_totals_features(feats: list[str], df: pd.DataFrame) -> list[str]:
    out = [f for f in feats if any(k in f for k in TOTALS_KEYWORDS)]
    for extra in ("total_close", "total_open"):
        if extra in df.columns and extra not in out:
            out.append(extra)
    return out


# ── Split temporel ───────────────────────────────────────────────────────────

def split(df: pd.DataFrame, val=0.15, test=0.2):
    df = df.sort_values("date").reset_index(drop=True)
    n = len(df)
    cut_t = int(n * (1 - test))
    cut_v = int(cut_t * (1 - val))
    return df.iloc[:cut_v].copy(), df.iloc[cut_v:cut_t].copy(), df.iloc[cut_t:].copy()


# ── Recherche d'hyperparamètres ──────────────────────────────────────────────

SEARCH_SPACE = {
    "max_depth":        [3, 4, 5, 6],
    "learning_rate":    [0.02, 0.03, 0.05, 0.08],
    "subsample":        [0.7, 0.8, 0.9],
    "colsample_bytree": [0.5, 0.7, 0.9],
    "min_child_weight": [1, 3, 5, 10],
    "gamma":            [0, 0.1, 0.5],
    "reg_alpha":        [0, 0.1, 1.0],
    "reg_lambda":       [1.0, 3.0, 10.0],
}

def random_search(dtrain, dval, y_val, base_params: dict, trials: int,
                  metric_fn=log_loss_np) -> tuple[dict, float]:
    best_params, best_score = None, np.inf
    for i in range(trials):
        p = dict(base_params)
        for k, choices in SEARCH_SPACE.items():
            p[k] = choices[RNG.integers(len(choices))]
        model = xgb.train(p, dtrain, num_boost_round=800,
                          evals=[(dval, "eval")], early_stopping_rounds=50,
                          verbose_eval=False)
        score = metric_fn(y_val, model.predict(dval))
        if score < best_score:
            best_params, best_score = p, score
            print(f"   essai {i + 1}/{trials} : {metric_fn.__name__}={score:.4f} ★")
    return best_params, best_score


# ── Modèle moneyline ─────────────────────────────────────────────────────────

def train_game(train_df, val_df, test_df, features, trials: int):
    print(f"\n🏒 Modèle moneyline — {len(features)} features")
    def dm(d):
        return xgb.DMatrix(d[features].values.astype(np.float32),
                           label=d["home_win"].values.astype(np.float32),
                           feature_names=features, missing=np.nan)
    dtrain, dval, dtest = dm(train_df), dm(val_df), dm(test_df)
    y_val  = val_df["home_win"].values.astype(np.float32)
    y_test = test_df["home_win"].values.astype(np.float32)

    base = {"objective": "binary:logistic", "eval_metric": "logloss", "seed": 42}
    print(f"   Recherche d'hyperparamètres ({trials} essais) …")
    params, val_ll = random_search(dtrain, dval, y_val, base, trials)
    model = xgb.train(params, dtrain, num_boost_round=800,
                      evals=[(dval, "eval")], early_stopping_rounds=50, verbose_eval=False)

    # Calibration de Platt sur val
    p_val = model.predict(dval)
    w_cal = fit_logistic(_logit(p_val).reshape(-1, 1), y_val)
    p_test_raw = model.predict(dtest)
    p_test = apply_logistic(_logit(p_test_raw).reshape(-1, 1), w_cal)

    # ── Blend modèle ⊕ marché (si cotes dispo) ───────────────────────────────
    blend_w, p_blend_test, market_metrics = None, None, {}
    if "market_home_p_close" in val_df.columns:
        vmask = val_df["market_home_p_close"].notna().values
        tmask = test_df["market_home_p_close"].notna().values
        if vmask.sum() > 200 and tmask.sum() > 100:
            Xv = np.column_stack([_logit(p_val[vmask]),
                                  _logit(val_df["market_home_p_close"].values[vmask])])
            blend_w = fit_logistic(Xv, y_val[vmask])
            Xt = np.column_stack([_logit(p_test_raw[tmask]),
                                  _logit(test_df["market_home_p_close"].values[tmask])])
            p_blend = apply_logistic(Xt, blend_w)
            p_mkt   = test_df["market_home_p_close"].values[tmask]
            yt      = y_test[tmask]
            market_metrics = {
                "n_with_odds":     int(tmask.sum()),
                "market_accuracy": round(accuracy(yt, p_mkt), 4),
                "market_log_loss": round(log_loss_np(yt, p_mkt), 4),
                "market_brier":    round(brier(yt, p_mkt), 4),
                "blend_accuracy":  round(accuracy(yt, p_blend), 4),
                "blend_log_loss":  round(log_loss_np(yt, p_blend), 4),
                "blend_brier":     round(brier(yt, p_blend), 4),
                "blend_weights":   [round(float(x), 4) for x in blend_w],
            }

    # ── Baselines ────────────────────────────────────────────────────────────
    y_train = train_df["home_win"].values.astype(np.float32)
    const = np.full(len(y_test), y_train.mean())
    elo_m = {}
    if "elo_expected" in test_df.columns:
        pe = test_df["elo_expected"].values.astype(np.float32)
        elo_m = {"accuracy": round(accuracy(y_test, pe), 4),
                 "log_loss": round(log_loss_np(y_test, pe), 4),
                 "brier": round(brier(y_test, pe), 4)}

    acc, br, ll = accuracy(y_test, p_test), brier(y_test, p_test), log_loss_np(y_test, p_test)
    skill = 1 - br / brier(y_test, const)
    print(f"\n   ── Test ({len(y_test)} matchs) ──")
    print(f"   Accuracy    : {acc:.4f}  (domicile: {y_test.mean():.4f})")
    print(f"   Log-loss    : {ll:.4f}  (constant: {log_loss_np(y_test, const):.4f})")
    print(f"   Brier       : {br:.4f}   Skill: {skill:+.4f}")
    if elo_m:
        print(f"   ELO seul    : acc {elo_m['accuracy']:.4f}, ll {elo_m['log_loss']:.4f}")
    if market_metrics:
        print(f"   Marché seul : acc {market_metrics['market_accuracy']:.4f}, "
              f"ll {market_metrics['market_log_loss']:.4f}  (n={market_metrics['n_with_odds']})")
        print(f"   Blend ⊕     : acc {market_metrics['blend_accuracy']:.4f}, "
              f"ll {market_metrics['blend_log_loss']:.4f}")

    scores = model.get_score(importance_type="gain")
    total = sum(scores.values()) or 1
    fi = sorted([{"name": k, "importance": round(v / total, 4)} for k, v in scores.items()],
                key=lambda x: -x["importance"])
    print("\n   Top features :")
    for f in fi[:10]:
        print(f"   {f['name']:<32} {f['importance']:.4f}  {'█' * int(f['importance'] * 200)}")

    report = {
        "model": "XGBoost binary:logistic (v4)",
        "best_iteration": int(model.best_iteration),
        "params": {k: v for k, v in params.items() if k in SEARCH_SPACE},
        "n_train": len(train_df), "n_val": len(val_df), "n_test": len(test_df),
        "accuracy": round(acc, 4), "brier_score": round(br, 4), "log_loss": round(ll, 4),
        "skill_score": round(skill, 4),
        "val_log_loss": round(val_ll, 4),
        "home_win_rate": round(float(y_train.mean()), 4),
        "baselines": {
            "home_always_accuracy": round(float(y_test.mean()), 4),
            "constant_log_loss": round(log_loss_np(y_test, const), 4),
            "elo_only": elo_m,
            "market": market_metrics,
        },
        "calibration": {"method": "platt", "a": round(float(w_cal[0]), 6),
                        "b": round(float(w_cal[1]), 6)},
        "blend": {"weights": [round(float(x), 6) for x in blend_w]} if blend_w is not None else None,
        "feature_importances": fi,
    }
    return model, report, fi


# ── Modèle totaux ────────────────────────────────────────────────────────────

def train_totals(train_df, val_df, test_df, features, trials: int):
    print(f"\n🎯 Modèle totaux — {len(features)} features")
    def dm(d):
        return xgb.DMatrix(d[features].values.astype(np.float32),
                           label=d["total_goals"].values.astype(np.float32),
                           feature_names=features, missing=np.nan)
    dtrain, dval, dtest = dm(train_df), dm(val_df), dm(test_df)
    y_val  = val_df["total_goals"].values.astype(np.float32)
    y_test = test_df["total_goals"].values.astype(np.float32)
    y_train = train_df["total_goals"].values.astype(np.float32)

    base = {"objective": "reg:squarederror", "eval_metric": "rmse", "seed": 42}
    def rmse_metric(y, p):
        return rmse(y, p)
    params, _ = random_search(dtrain, dval, y_val, base, max(trials // 2, 10),
                              metric_fn=rmse_metric)
    model = xgb.train(params, dtrain, num_boost_round=800,
                      evals=[(dval, "eval")], early_stopping_rounds=50, verbose_eval=False)

    preds = model.predict(dtest)
    m, r = mae(y_test, preds), rmse(y_test, preds)
    base_mae = mae(y_test, np.full(len(y_test), y_train.mean()))
    print(f"   MAE {m:.3f} (baseline {base_mae:.3f})   RMSE {r:.3f}")

    mkt = {}
    if "total_close" in test_df.columns:
        tm = test_df["total_close"].notna().values
        if tm.sum() > 100:
            mkt = {"n": int(tm.sum()),
                   "market_mae": round(mae(y_test[tm], test_df["total_close"].values[tm]), 4),
                   "model_mae_same_subset": round(mae(y_test[tm], preds[tm]), 4)}
            print(f"   Marché (ligne clôture) : MAE {mkt['market_mae']:.3f} vs modèle "
                  f"{mkt['model_mae_same_subset']:.3f} (n={mkt['n']})")

    scores = model.get_score(importance_type="gain")
    total = sum(scores.values()) or 1
    fi = sorted([{"name": k, "importance": round(v / total, 4)} for k, v in scores.items()],
                key=lambda x: -x["importance"])
    report = {"model": "XGBoost reg:squarederror (v4)",
              "best_iteration": int(model.best_iteration),
              "params": {k: v for k, v in params.items() if k in SEARCH_SPACE},
              "n_train": len(train_df), "n_test": len(test_df),
              "mae_goals": round(m, 4), "rmse_goals": round(r, 4),
              "baseline_mae": round(base_mae, 4),
              "mean_total": round(float(y_train.mean()), 4),
              "market": mkt, "feature_importances": fi}
    return model, report, fi


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=40)
    ap.add_argument("--no-odds-features", action="store_true",
                    help="Exclut les cotes des features (modèle 'pur')")
    args = ap.parse_args()

    path = DATA_V4 if os.path.exists(DATA_V4) else DATA_V3
    version = "v4" if path == DATA_V4 else "v3 (fallback)"
    print(f"📂 Dataset {version} : {path}")
    df = pd.read_csv(path, low_memory=False)
    df = df.dropna(subset=["home_win", "total_goals", "date"])
    print(f"   {len(df)} matchs")

    feats = select_features(df, use_odds=not args.no_odds_features)
    tot_feats = select_totals_features(feats, df)
    train_df, val_df, test_df = split(df)
    print(f"   Split : {len(train_df)} / {len(val_df)} / {len(test_df)}  "
          f"(test dès {test_df['date'].min()})")

    gm, gr, gfi = train_game(train_df, val_df, test_df, feats, args.trials)
    tm, tr, tfi = train_totals(train_df, val_df, test_df, tot_feats, args.trials)

    os.makedirs(MODELS_DIR, exist_ok=True)
    gm.save_model(f"{MODELS_DIR}/game_model.json")
    tm.save_model(f"{MODELS_DIR}/totals_model.json")
    json.dump(gfi, open(f"{MODELS_DIR}/feature_importance_game.json", "w"), indent=2)
    json.dump(tfi, open(f"{MODELS_DIR}/feature_importance_totals.json", "w"), indent=2)
    json.dump({"game_model": gr, "totals_model": tr,
               "features": {"game": feats, "totals": tot_feats},
               "dataset": version},
              open(f"{MODELS_DIR}/training_report.json", "w"), indent=2)
    print(f"\n✅ Modèles + rapport sauvegardés dans {MODELS_DIR}/")
    print("🚀 Ensuite : python backtest.py  (ROI vs cotes)  puis relancer ml_service.py")


if __name__ == "__main__":
    main()
