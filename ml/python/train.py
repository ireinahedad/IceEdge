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
    # Nouvelles features (fetch_data.py v2)
    "home_home_win_pct",       # record à domicile de l'équipe locale
    "away_road_win_pct",       # record à l'extérieur des visiteurs
    "home_streak",             # série signée (+3 = 3 victoires, -2 = 2 défaites)
    "away_streak",
    "home_shots_for_pg",
    "away_shots_for_pg",
    "home_shots_against_pg",
    "away_shots_against_pg",
    "home_faceoff_pct",
    "away_faceoff_pct",
    "home_rest_days",
    "away_rest_days",
    "home_b2b",                # back-to-back (2e match en 2 soirs)
    "away_b2b",
]

DIFF_FEATURES = [
    "win_pct_diff",
    "gf_diff",
    "ga_diff",
    "pp_diff",
    "pk_diff",
    "form_diff",
    # Nouveaux diffs
    "shots_diff",              # volume de tirs net
    "faceoff_diff",
    "rest_diff",               # avantage repos
    "streak_diff",
]

# Features ELO — calculées séquentiellement depuis les résultats (add_elo_features)
ELO_FEATURES = [
    "home_elo",        # rating pré-match équipe domicile
    "away_elo",
    "elo_diff",        # home_elo - away_elo
    "elo_expected",    # P(domicile gagne) selon ELO (avantage glace inclus)
]

ALL_GAME_FEATURES = GAME_FEATURES + DIFF_FEATURES + ELO_FEATURES

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
    # Nouvelles features totaux
    "home_shots_for_pg",
    "away_shots_for_pg",
    "home_shots_against_pg",
    "away_shots_against_pg",
    "home_rest_days",
    "away_rest_days",
]

# ── Helpers sans scikit-learn ─────────────────────────────────────────────────

def train_val_test_split_df(df: pd.DataFrame, val_size: float = 0.15, test_size: float = 0.2):
    """
    Split temporel 3 voies (pas aléatoire — évite le data leakage) :
      train  → apprentissage
      val    → early stopping + calibration (le test reste vierge)
      test   → métriques finales uniquement
    """
    df_sorted = df.sort_values("date").reset_index(drop=True)
    n = len(df_sorted)
    cut_test = int(n * (1 - test_size))
    cut_val  = int(cut_test * (1 - val_size))
    return (df_sorted.iloc[:cut_val].copy(),
            df_sorted.iloc[cut_val:cut_test].copy(),
            df_sorted.iloc[cut_test:].copy())


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


# ── ELO ───────────────────────────────────────────────────────────────────────
#
# Rating séquentiel calculé match par match depuis les scores — aucune donnée
# externe. Conventions type FiveThirtyEight NHL :
#   base 1500, K=6, avantage glace ~50 pts ELO,
#   multiplicateur marge de victoire, régression 30% vers la moyenne
#   entre les saisons (détectée par un trou > 60 jours).
# Le rating utilisé pour un match est TOUJOURS le rating pré-match → pas de leakage.

ELO_BASE     = 1500.0
ELO_K        = 6.0
ELO_HOME_ADV = 50.0
ELO_SEASON_REGRESS = 0.30   # 30% vers la moyenne à chaque nouvelle saison


def elo_expected_home(home_elo: float, away_elo: float) -> float:
    return 1.0 / (1.0 + 10 ** (-((home_elo + ELO_HOME_ADV) - away_elo) / 400.0))


def add_elo_features(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, float]]:
    """
    Ajoute home_elo / away_elo / elo_diff / elo_expected (valeurs pré-match).
    Retourne aussi les ratings finaux {abbr: elo} pour l'inférence (ml_service).
    """
    df = df.sort_values("date").reset_index(drop=True)
    ratings: dict[str, float] = {}
    prev_date: pd.Timestamp | None = None

    h_elo, a_elo, e_diff, e_exp = [], [], [], []
    dates = pd.to_datetime(df["date"])

    for i, row in df.iterrows():
        d = dates.iloc[i]
        # Nouvelle saison (trou > 60 jours) → régression vers la moyenne
        if prev_date is not None and (d - prev_date).days > 60:
            for t in ratings:
                ratings[t] = ratings[t] + ELO_SEASON_REGRESS * (ELO_BASE - ratings[t])
        prev_date = d

        h, a = row["home_team"], row["away_team"]
        rh = ratings.get(h, ELO_BASE)
        ra = ratings.get(a, ELO_BASE)

        exp_home = elo_expected_home(rh, ra)
        h_elo.append(rh)
        a_elo.append(ra)
        e_diff.append(rh - ra)
        e_exp.append(exp_home)

        # Mise à jour post-match (marge de victoire → K amplifié)
        goal_diff = abs(int(row["home_score"]) - int(row["away_score"])) or 1
        mov_mult  = 0.6686 * np.log(goal_diff) + 0.8048
        outcome   = 1.0 if row["home_score"] > row["away_score"] else 0.0
        delta     = ELO_K * mov_mult * (outcome - exp_home)
        ratings[h] = rh + delta
        ratings[a] = ra - delta

    df["home_elo"]     = h_elo
    df["away_elo"]     = a_elo
    df["elo_diff"]     = e_diff
    df["elo_expected"] = e_exp
    return df, ratings


# ── Calibration de Platt (sans scikit-learn) ─────────────────────────────────
#
# Ajuste sigmoid(a·logit(p) + b) sur le set de VALIDATION pour rendre les
# probabilités fiables (utilisables pour le calcul d'EV). Descente de gradient
# simple sur la log-loss — équivalent à une régression logistique 1D.

def fit_platt(p_val: np.ndarray, y_val: np.ndarray,
              lr: float = 0.1, iters: int = 3000) -> tuple[float, float]:
    eps = 1e-7
    z = np.log(np.clip(p_val, eps, 1 - eps) / np.clip(1 - p_val, eps, 1 - eps))
    a, b = 1.0, 0.0
    n = len(z)
    for _ in range(iters):
        q = 1.0 / (1.0 + np.exp(-(a * z + b)))
        grad_a = float(np.mean((q - y_val) * z))
        grad_b = float(np.mean(q - y_val))
        a -= lr * grad_a
        b -= lr * grad_b
    return float(a), float(b)


def apply_platt(p: np.ndarray, a: float, b: float) -> np.ndarray:
    eps = 1e-7
    z = np.log(np.clip(p, eps, 1 - eps) / np.clip(1 - p, eps, 1 - eps))
    return 1.0 / (1.0 + np.exp(-(a * z + b)))


# ── Ingénierie des features ───────────────────────────────────────────────────

def add_diff_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["win_pct_diff"] = df["home_win_pct"]          - df["away_win_pct"]
    df["gf_diff"]      = df["home_goals_for_pg"]     - df["away_goals_for_pg"]
    df["ga_diff"]      = df["away_goals_against_pg"] - df["home_goals_against_pg"]
    df["pp_diff"]      = df["home_pp_pct"]           - df["away_pp_pct"]
    df["pk_diff"]      = df["home_pk_pct"]           - df["away_pk_pct"]
    df["form_diff"]    = df["home_last10_win_pct"]   - df["away_last10_win_pct"]
    # Nouveaux diffs (colonnes présentes seulement avec fetch_data.py v2)
    if "home_shots_for_pg" in df.columns:
        df["shots_diff"]   = (df["home_shots_for_pg"] - df["home_shots_against_pg"]) \
                           - (df["away_shots_for_pg"] - df["away_shots_against_pg"])
    if "home_faceoff_pct" in df.columns:
        df["faceoff_diff"] = df["home_faceoff_pct"] - df["away_faceoff_pct"]
    if "home_rest_days" in df.columns:
        df["rest_diff"]    = df["home_rest_days"]   - df["away_rest_days"]
    if "home_streak" in df.columns:
        df["streak_diff"]  = df["home_streak"]      - df["away_streak"]
    return df


def filter_available(features: list[str], df: pd.DataFrame, label: str) -> list[str]:
    """Rétro-compatibilité : n'utilise que les features présentes dans le CSV."""
    available = [f for f in features if f in df.columns]
    missing   = [f for f in features if f not in df.columns]
    if missing:
        print(f"⚠️  [{label}] {len(missing)} features absentes du CSV "
              f"(ancien fetch_data.py ?) : {missing}")
        print(f"   → Relance 'python fetch_data.py' pour le dataset complet.")
    return available


# ── Modèle moneyline ──────────────────────────────────────────────────────────

def train_game_model(train_df: pd.DataFrame, val_df: pd.DataFrame,
                     test_df: pd.DataFrame, features: list[str]) -> tuple:
    print("\n🏒 Modèle moneyline (qui gagne ?)")
    print(f"   Train : {len(train_df)}  |  Val : {len(val_df)}  |  Test : {len(test_df)}")
    print(f"   Features : {len(features)}")

    X_train = train_df[features].values.astype(np.float32)
    y_train = train_df["home_win"].values.astype(np.float32)
    X_val   = val_df[features].values.astype(np.float32)
    y_val   = val_df["home_win"].values.astype(np.float32)
    X_test  = test_df[features].values.astype(np.float32)
    y_test  = test_df["home_win"].values.astype(np.float32)

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=features)
    dval   = xgb.DMatrix(X_val,   label=y_val,   feature_names=features)
    dtest  = xgb.DMatrix(X_test,  label=y_test,  feature_names=features)

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
        # Early stopping sur VAL (jamais sur test → le test reste une éval honnête)
        evals=[(dtrain, "train"), (dval, "eval")],
        early_stopping_rounds=40,
        evals_result=evals_result,
        verbose_eval=50,
    )

    # ── Calibration de Platt sur le set de validation ─────────────────────────
    probs_val = model.predict(dval)
    platt_a, platt_b = fit_platt(probs_val, y_val)
    print(f"\n   Calibration Platt : a={platt_a:.3f}, b={platt_b:.3f} (fit sur val)")

    # ── Évaluation finale sur le test (brut + calibré) ───────────────────────
    probs_raw = model.predict(dtest)
    probs     = apply_platt(probs_raw, platt_a, platt_b)

    baseline_brier = brier_score(y_test, np.full(len(y_test), y_train.mean()))
    baseline_ll    = log_loss_np(y_test, np.full(len(y_test), y_train.mean()))

    # Baseline ELO seul (sanity check : le modèle doit au moins battre ça)
    elo_metrics = {}
    if "elo_expected" in features:
        p_elo = test_df["elo_expected"].values.astype(np.float32)
        elo_metrics = {
            "accuracy": round(accuracy(y_test, p_elo), 4),
            "log_loss": round(log_loss_np(y_test, p_elo), 4),
            "brier":    round(brier_score(y_test, p_elo), 4),
        }

    acc_val    = accuracy(y_test, probs)
    brier_val  = brier_score(y_test, probs)
    ll_val     = log_loss_np(y_test, probs)
    skill      = 1 - brier_val / baseline_brier

    print(f"\n   ── Test set ({len(y_test)} matchs, jamais vu) ──")
    print(f"   Accuracy      : {acc_val:.3f}   (baseline domicile: {y_test.mean():.3f})")
    print(f"   Brier score   : {brier_val:.4f}  (baseline {baseline_brier:.4f})")
    print(f"   Log-loss      : {ll_val:.4f}  (baseline {baseline_ll:.4f})")
    print(f"   Skill score   : {skill:.3f}  (>0 = mieux que baseline)")
    print(f"   Avant calibration : brier {brier_score(y_test, probs_raw):.4f}, "
          f"log-loss {log_loss_np(y_test, probs_raw):.4f}")
    if elo_metrics:
        print(f"   Baseline ELO seul : acc {elo_metrics['accuracy']:.3f}, "
              f"log-loss {elo_metrics['log_loss']:.4f}")

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
        "n_val":         int(len(X_val)),
        "n_test":        int(len(X_test)),
        "accuracy":      round(acc_val,   4),
        "brier_score":   round(brier_val, 4),
        "log_loss":      round(ll_val,    4),
        "skill_score":   round(skill,     4),
        "home_win_rate": round(float(y_train.mean()), 4),
        "baselines": {
            "home_always_accuracy": round(float(y_test.mean()), 4),
            "constant_brier":       round(baseline_brier, 4),
            "constant_log_loss":    round(baseline_ll, 4),
            "elo_only":             elo_metrics,
        },
        "uncalibrated": {
            "brier_score": round(brier_score(y_test, probs_raw), 4),
            "log_loss":    round(log_loss_np(y_test, probs_raw), 4),
        },
        "calibration": {"method": "platt", "a": round(platt_a, 6), "b": round(platt_b, 6)},
        "feature_importances": importances_sorted,
    }
    return model, report, importances_sorted


# ── Modèle totaux de buts ─────────────────────────────────────────────────────

def train_totals_model(train_df: pd.DataFrame, val_df: pd.DataFrame,
                       test_df: pd.DataFrame, features: list[str]) -> tuple:
    print("\n🎯 Modèle total de buts")
    print(f"   Features : {len(features)}")

    X_train = train_df[features].values.astype(np.float32)
    y_train = train_df["total_goals"].values.astype(np.float32)
    X_val   = val_df[features].values.astype(np.float32)
    y_val   = val_df["total_goals"].values.astype(np.float32)
    X_test  = test_df[features].values.astype(np.float32)
    y_test  = test_df["total_goals"].values.astype(np.float32)

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=features)
    dval   = xgb.DMatrix(X_val,   label=y_val,   feature_names=features)
    dtest  = xgb.DMatrix(X_test,  label=y_test,  feature_names=features)

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
        evals=[(dtrain, "train"), (dval, "eval")],
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
                   totals_model, totals_report, totals_fi,
                   game_features, totals_features):
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
            "game":   game_features,
            "totals": totals_features,
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

    # Rétro-compatibilité : ne garder que les features réellement présentes
    base_available = [f for f in GAME_FEATURES if f in df.columns]

    # Nettoyer les NaN
    required = base_available + ["home_win", "total_goals", "date"]
    before = len(df)
    df = df.dropna(subset=required)
    if len(df) < before:
        print(f"   {before - len(df)} lignes supprimées (valeurs manquantes)")

    if len(df) < 200:
        print(f"⚠️  Seulement {len(df)} matchs — résultats peu fiables.")

    # Sanity check anti-features mortes (bug PP/PK historique)
    dead = [f for f in base_available if df[f].std() < 1e-9]
    if dead:
        print(f"⚠️  Features à variance nulle (exclues) : {dead}")

    # Features différentielles + ELO (séquentiel, pré-match → pas de leakage)
    df = add_diff_features(df)
    df, final_elo = add_elo_features(df)
    print(f"   ELO calculé — top 5 : "
          f"{sorted(final_elo.items(), key=lambda x: -x[1])[:5]}")

    game_features   = [f for f in filter_available(ALL_GAME_FEATURES, df, "game")
                       if f not in dead]
    totals_features = [f for f in filter_available(TOTALS_FEATURES,   df, "totals")
                       if f not in dead]

    # Split temporel 3 voies (pas aléatoire — évite le data leakage)
    train_df, val_df, test_df = train_val_test_split_df(df)
    print(f"   Split : {len(train_df)} train / {len(val_df)} val / {len(test_df)} test (par date)")

    # Entraînement
    game_model,   game_report,   game_fi   = train_game_model(train_df, val_df, test_df, game_features)
    totals_model, totals_report, totals_fi = train_totals_model(train_df, val_df, test_df, totals_features)

    # Sauvegarde
    save_artifacts(game_model, game_report, game_fi,
                   totals_model, totals_report, totals_fi,
                   game_features, totals_features)

    # Ratings ELO finaux → utilisés par ml_service.py à l'inférence
    with open(f"{MODELS_DIR}/elo_ratings.json", "w") as f:
        json.dump({
            "base":       ELO_BASE,
            "home_adv":   ELO_HOME_ADV,
            "as_of_date": str(df["date"].max()),
            "ratings":    {k: round(v, 1) for k, v in sorted(final_elo.items())},
        }, f, indent=2)
    print(f"   elo_ratings.json  — ratings ELO pour l'inférence")

    print("\n🚀 Relance ml_service.py — il chargera les .json automatiquement")


if __name__ == "__main__":
    main()
