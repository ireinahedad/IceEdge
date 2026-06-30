"""
train.py
========
Pipeline d'entraînement XGBoost pour ICEEDGE.
Aucune dépendance scikit-learn — fonctionne sur Python 3.14+.

Usage :
    cd ml/python
    python fetch_data.py     # collecter les données d'abord
    python train.py

Sorties dans ml/models/ :
    game_model.json           (format natif XGBoost)
    totals_model.json
    feature_importance_game.json
    feature_importance_totals.json
    training_report.json
"""

import json
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

# ── Chemins ───────────────────────────────────────────────────────────────────

DATA_PATH  = "../data/nhl_games.csv"
MODELS_DIR = "../models"

# ── Features (miroir exact de featureEngineering.ts) ─────────────────────────

GAME_FEATURES = [
    "home_win_pct",
    "away_win_pct",
    "home_goals_for_pg",
    "away_goals_for_pg",
    "home_goals_against_pg",
    "away_goals_against_pg",
    "home_pp_pct",
    "away_pp_pct",
    "home_pk_pct",
    "away_pk_pct",
    "home_last10_win_pct",
    "away_last10_win_pct",
]

DIFF_FEATURES = [
    "win_pct_diff",
    "gf_diff",
    "ga_diff",
    "pp_diff",
    "pk_diff",
    "form_diff",
]

ALL_GAME_FEATURES = GAME_FEATURES + DIFF_FEATURES

TOTALS_FEATURES = [
    "home_goals_for_pg",
    "away_goals_for_pg",
    "home_goals_against_pg",
    "away_goals_against_pg",
    "home_pp_pct",
    "away_pp_pct",
    "home_pk_pct",
    "away_pk_pct",
    "gf_diff",
    "ga_diff",
]

# ── Helpers sans scikit-learn ─────────────────────────────────────────────────

def train_test_split_df(df: pd.DataFrame, test_size: float = 0.2, seed: int = 42):
    """Split reproductible par date (pas aléatoire — évite le data leakage temporel)."""
    df_sorted = df.sort_values("date").reset_index(drop=True)
    cut = int(len(df_sorted) * (1 - test_size))
    return df_sorted.iloc[:cut].copy(), df_sorted.iloc[cut:].copy()


def log_loss_np(y_true: np.ndarray, y_prob: np.ndarray, eps: float = 1e-7) -> float:
    y_prob = np.clip(y_prob, eps, 1 - eps)
    return float(-np.mean(y_true * np.log(y_prob) + (1 - y_true) * np.log(1 - y_prob)))


def brier_score(y_true: np.ndarray, y_prob: np.ndarray) -> float:
    return float(np.mean((y_prob - y_true) ** 2))


def accuracy(y_true: np.ndarray, y_prob: np.ndarray, threshold: float = 0.5) -> float:
    return float(np.mean((y_prob >= threshold).astype(int) == y_true))


def mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs(y_pred - y_true)))


def rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.sqrt(np.mean((y_pred - y_true) ** 2)))


# ── Ingénierie des features ───────────────────────────────────────────────────

def add_diff_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["win_pct_diff"] = df["home_win_pct"]          - df["away_win_pct"]
    df["gf_diff"]      = df["home_goals_for_pg"]     - df["away_goals_for_pg"]
    df["ga_diff"]      = df["away_goals_against_pg"] - df["home_goals_against_pg"]
    df["pp_diff"]      = df["home_pp_pct"]           - df["away_pp_pct"]
    df["pk_diff"]      = df["home_pk_pct"]           - df["away_pk_pct"]
    df["form_diff"]    = df["home_last10_win_pct"]   - df["away_last10_win_pct"]
    return df


# ── Modèle moneyline ──────────────────────────────────────────────────────────

def train_game_model(train_df: pd.DataFrame, test_df: pd.DataFrame) -> tuple:
    print("\n🏒 Modèle moneyline (qui gagne ?)")
    print(f"   Train : {len(train_df)} matchs  |  Test : {len(test_df)} matchs")

    X_train = train_df[ALL_GAME_FEATURES].values.astype(np.float32)
    y_train = train_df["home_win"].values.astype(np.float32)
    X_test  = test_df[ALL_GAME_FEATURES].values.astype(np.float32)
    y_test  = test_df["home_win"].values.astype(np.float32)

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=ALL_GAME_FEATURES)
    dtest  = xgb.DMatrix(X_test,  label=y_test,  feature_names=ALL_GAME_FEATURES)

    params = {
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

    evals_result: dict = {}
    model = xgb.train(
        params,
        dtrain,
        num_boost_round=500,
        evals=[(dtrain, "train"), (dtest, "eval")],
        early_stopping_rounds=40,
        evals_result=evals_result,
        verbose_eval=50,
    )

    probs = model.predict(dtest)
    baseline_brier = brier_score(y_test, np.full(len(y_test), y_train.mean()))

    acc_val    = accuracy(y_test, probs)
    brier_val  = brier_score(y_test, probs)
    ll_val     = log_loss_np(y_test, probs)
    skill      = 1 - brier_val / baseline_brier

    print(f"\n   Accuracy      : {acc_val:.3f}")
    print(f"   Brier score   : {brier_val:.4f}  (baseline {baseline_brier:.4f})")
    print(f"   Log-loss      : {ll_val:.4f}")
    print(f"   Skill score   : {skill:.3f}  (>0 = mieux que baseline)")

    # Feature importances (gain = contribution nette)
    scores = model.get_score(importance_type="gain")
    total  = sum(scores.values()) or 1
    importances_sorted = sorted(
        [{"name": k, "importance": round(v / total, 4)} for k, v in scores.items()],
        key=lambda x: x["importance"], reverse=True
    )

    print("\n   Feature importances (gain) :")
    for fi in importances_sorted[:8]:
        bar = "█" * int(fi["importance"] * 300)
        print(f"   {fi['name']:<30} {fi['importance']:.4f}  {bar}")

    report = {
        "model":         "XGBoost binary:logistic",
        "best_iteration": int(model.best_iteration),
        "n_train":       int(len(X_train)),
        "n_test":        int(len(X_test)),
        "accuracy":      round(acc_val,   4),
        "brier_score":   round(brier_val, 4),
        "log_loss":      round(ll_val,    4),
        "skill_score":   round(skill,     4),
        "home_win_rate": round(float(y_train.mean()), 4),
        "feature_importances": importances_sorted,
    }
    return model, report, importances_sorted


# ── Modèle totaux de buts ─────────────────────────────────────────────────────

def train_totals_model(train_df: pd.DataFrame, test_df: pd.DataFrame) -> tuple:
    print("\n🎯 Modèle total de buts")

    X_train = train_df[TOTALS_FEATURES].values.astype(np.float32)
    y_train = train_df["total_goals"].values.astype(np.float32)
    X_test  = test_df[TOTALS_FEATURES].values.astype(np.float32)
    y_test  = test_df["total_goals"].values.astype(np.float32)

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=TOTALS_FEATURES)
    dtest  = xgb.DMatrix(X_test,  label=y_test,  feature_names=TOTALS_FEATURES)

    params = {
        "objective":        "reg:squarederror",
        "eval_metric":      "rmse",
        "max_depth":        4,
        "learning_rate":    0.04,
        "subsample":        0.8,
        "colsample_bytree": 0.8,
        "min_child_weight": 3,
        "reg_alpha":        0.1,
        "reg_lambda":       1.0,
        "seed":             42,
    }

    evals_result: dict = {}
    model = xgb.train(
        params,
        dtrain,
        num_boost_round=400,
        evals=[(dtrain, "train"), (dtest, "eval")],
        early_stopping_rounds=30,
        evals_result=evals_result,
        verbose_eval=50,
    )

    preds         = model.predict(dtest)
    baseline_mae  = mae(y_test, np.full(len(y_test), y_train.mean()))
    mae_val       = mae(y_test, preds)
    rmse_val      = rmse(y_test, preds)

    print(f"\n   MAE   : {mae_val:.3f} buts  (baseline {baseline_mae:.3f})")
    print(f"   RMSE  : {rmse_val:.3f} buts")
    print(f"   Moy. totaux : {y_train.mean():.2f} buts")

    scores = model.get_score(importance_type="gain")
    total  = sum(scores.values()) or 1
    importances_sorted = sorted(
        [{"name": k, "importance": round(v / total, 4)} for k, v in scores.items()],
        key=lambda x: x["importance"], reverse=True
    )

    print("\n   Feature importances :")
    for fi in importances_sorted[:6]:
        bar = "█" * int(fi["importance"] * 300)
        print(f"   {fi['name']:<30} {fi['importance']:.4f}  {bar}")

    report = {
        "model":          "XGBoost reg:squarederror",
        "best_iteration": int(model.best_iteration),
        "n_train":        int(len(X_train)),
        "n_test":         int(len(X_test)),
        "mae_goals":      round(mae_val,  4),
        "rmse_goals":     round(rmse_val, 4),
        "mean_total":     round(float(y_train.mean()), 4),
        "feature_importances": importances_sorted,
    }
    return model, report, importances_sorted


# ── Sauvegarde ────────────────────────────────────────────────────────────────

def save_artifacts(game_model, game_report, game_fi,
                   totals_model, totals_report, totals_fi):
    os.makedirs(MODELS_DIR, exist_ok=True)

    # Format JSON natif XGBoost (pas de joblib/pickle — compatibilité Python 3.14)
    game_model.save_model(f"{MODELS_DIR}/game_model.json")
    totals_model.save_model(f"{MODELS_DIR}/totals_model.json")

    with open(f"{MODELS_DIR}/feature_importance_game.json", "w") as f:
        json.dump(game_fi, f, indent=2)

    with open(f"{MODELS_DIR}/feature_importance_totals.json", "w") as f:
        json.dump(totals_fi, f, indent=2)

    full_report = {
        "game_model":   game_report,
        "totals_model": totals_report,
        "features": {
            "game":   ALL_GAME_FEATURES,
            "totals": TOTALS_FEATURES,
        },
    }
    with open(f"{MODELS_DIR}/training_report.json", "w") as f:
        json.dump(full_report, f, indent=2)

    print(f"\n✅ Modèles sauvegardés dans {MODELS_DIR}/")
    print(f"   game_model.json   — moneyline/puck-line")
    print(f"   totals_model.json — total de buts (O/U)")
    print(f"   training_report.json")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(DATA_PATH):
        print(f"❌ Données introuvables : {DATA_PATH}")
        print("   Lance d'abord : python fetch_data.py")
        sys.exit(1)

    print(f"📂 Chargement de {DATA_PATH} …")
    df = pd.read_csv(DATA_PATH)
    print(f"   {len(df)} matchs chargés")

    # Nettoyer les NaN
    required = GAME_FEATURES + ["home_win", "total_goals", "date"]
    before = len(df)
    df = df.dropna(subset=required)
    if len(df) < before:
        print(f"   {before - len(df)} lignes supprimées (valeurs manquantes)")

    if len(df) < 200:
        print(f"⚠️  Seulement {len(df)} matchs — résultats peu fiables.")

    # Features différentielles
    df = add_diff_features(df)

    # Split temporel (pas aléatoire — évite le data leakage)
    train_df, test_df = train_test_split_df(df, test_size=0.2)
    print(f"   Split : {len(train_df)} train / {len(test_df)} test (par date)")

    # Entraînement
    game_model,   game_report,   game_fi   = train_game_model(train_df, test_df)
    totals_model, totals_report, totals_fi = train_totals_model(train_df, test_df)

    # Sauvegarde
    save_artifacts(game_model, game_report, game_fi,
                   totals_model, totals_report, totals_fi)

    print("\n🚀 Relance ml_service.py — il chargera les .json automatiquement")


if __name__ == "__main__":
    main()
