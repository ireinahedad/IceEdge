"""
ICEEDGE ML Service
==================
Standalone FastAPI service providing probabilistic predictions for NHL betting markets.
Node.js backend calls this via POST /predict/* and forwards results to the frontend.

Start with:
    python ml_service.py
or:
    uvicorn ml_service:app --reload --port 8000

Endpoints:
    POST /predict/game       Game outcome: moneyline, puck-line, total goals
    POST /predict/player     Player prop: goals, assists, points, shots
    POST /predict/team       Team futures: cup, conference, playoff
    GET  /health             Health check + model info
    GET  /features           Feature schema reference
"""

from __future__ import annotations
import json
import math
import os
from typing import List, Optional

import numpy as np
import xgboost as xgb
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

app = FastAPI(title="ICEEDGE ML Service", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Chargement des modèles entraînés (si disponibles) ─────────────────────────
#
# Après avoir lancé :  python fetch_data.py && python train.py
# les fichiers .pkl existent dans ml/models/ et sont chargés ici.
# Si absents, le service utilise les poids manuels comme fallback.

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")

_xgb_game:   xgb.Booster | None = None
_xgb_totals: xgb.Booster | None = None
_game_importances:   list[dict] = []
_totals_importances: list[dict] = []

# Features attendues par chaque modèle (ordre identique à train.py)
_GAME_FEAT_NAMES = [
    "home_win_pct", "away_win_pct",
    "home_goals_for_pg", "away_goals_for_pg",
    "home_goals_against_pg", "away_goals_against_pg",
    "home_pp_pct", "away_pp_pct",
    "home_pk_pct", "away_pk_pct",
    "home_last10_win_pct", "away_last10_win_pct",
    "win_pct_diff", "gf_diff", "ga_diff", "pp_diff", "pk_diff", "form_diff",
]
_TOTALS_FEAT_NAMES = [
    "home_goals_for_pg", "away_goals_for_pg",
    "home_goals_against_pg", "away_goals_against_pg",
    "home_pp_pct", "away_pp_pct",
    "home_pk_pct", "away_pk_pct",
    "gf_diff", "ga_diff",
]


def _try_load_models():
    global _xgb_game, _xgb_totals, _game_importances, _totals_importances

    game_path   = os.path.join(MODELS_DIR, "game_model.json")
    totals_path = os.path.join(MODELS_DIR, "totals_model.json")
    gi_path     = os.path.join(MODELS_DIR, "feature_importance_game.json")
    ti_path     = os.path.join(MODELS_DIR, "feature_importance_totals.json")

    if os.path.exists(game_path):
        try:
            _xgb_game = xgb.Booster()
            _xgb_game.load_model(game_path)
            print(f"[ML] ✅ game_model.json chargé (XGBoost)")
        except Exception as e:
            _xgb_game = None
            print(f"[ML] ⚠️  game_model.json : {e}")

    if os.path.exists(totals_path):
        try:
            _xgb_totals = xgb.Booster()
            _xgb_totals.load_model(totals_path)
            print(f"[ML] ✅ totals_model.json chargé (XGBoost)")
        except Exception as e:
            _xgb_totals = None
            print(f"[ML] ⚠️  totals_model.json : {e}")

    if os.path.exists(gi_path):
        with open(gi_path) as f:
            _game_importances = json.load(f)

    if os.path.exists(ti_path):
        with open(ti_path) as f:
            _totals_importances = json.load(f)

    if _xgb_game is None and _xgb_totals is None:
        print("[ML] ℹ️  Aucun modèle .json — utilisation des poids manuels (fallback)")
        print("[ML]    Lance : python fetch_data.py && python train.py")

_try_load_models()

# ── Math helpers ──────────────────────────────────────────────────────────────

def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))

def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))

def poisson_cdf(k: int, lam: float) -> float:
    """P(X <= k) for Poisson(lam)"""
    if lam <= 0:
        return 1.0
    cdf = 0.0
    term = math.exp(-lam)
    for i in range(k + 1):
        cdf += term
        term *= lam / (i + 1)
    return min(cdf, 1.0)

def poisson_over(line: float, lam: float) -> float:
    """P(X > line) — supports half-integer lines (e.g. 2.5)"""
    return 1.0 - poisson_cdf(math.floor(line), lam)

# ── Pydantic models ───────────────────────────────────────────────────────────

class FeatureImportance(BaseModel):
    name: str
    importance: float
    direction: str   # "positive" | "negative"

class MLResponse(BaseModel):
    probability: int                          # 5–95, integer percent
    confidence: int                           # 40–95, integer percent
    feature_importances: List[FeatureImportance]
    model_version: str
    model_type: str
    explanation: str

# ── Game features ─────────────────────────────────────────────────────────────

class GameFeatures(BaseModel):
    home_win_pct: float = Field(..., ge=0, le=1, description="Home team win % (0–1)")
    away_win_pct: float = Field(..., ge=0, le=1)
    home_goals_for_pg: float = Field(3.0, ge=0)
    away_goals_for_pg: float = Field(3.0, ge=0)
    home_goals_against_pg: float = Field(3.0, ge=0)
    away_goals_against_pg: float = Field(3.0, ge=0)
    home_pp_pct: float = Field(20.0, ge=0, le=100)   # power play %
    away_pp_pct: float = Field(20.0, ge=0, le=100)
    home_pk_pct: float = Field(80.0, ge=0, le=100)   # penalty kill % (0 = données manquantes → corrigé en Python)
    away_pk_pct: float = Field(80.0, ge=0, le=100)
    home_last10_win_pct: float = Field(0.5, ge=0, le=1)
    away_last10_win_pct: float = Field(0.5, ge=0, le=1)
    market_type: str = Field("moneyline")    # "moneyline"|"puck_line"|"total_goals_over"|"total_goals_under"
    line: Optional[float] = None             # for total goals

# ── Player prop features ──────────────────────────────────────────────────────

class PlayerPropFeatures(BaseModel):
    goals_per_game: float = Field(0.25, ge=0)
    assists_per_game: float = Field(0.30, ge=0)
    points_per_game: float = Field(0.55, ge=0)
    shots_per_game: float = Field(2.5, ge=0)
    games_played: int = Field(40, ge=1)
    line: float = Field(0.5, ge=0)
    prop_type: str = Field("goals")   # "goals"|"assists"|"points"|"shots"|"pp_point"
    selection: str = Field("over")    # "over"|"under"

# ── Team futures features ─────────────────────────────────────────────────────

class TeamFuturesFeatures(BaseModel):
    win_pct: float = Field(50.0, ge=0, le=100)
    goals_for_pg: float = Field(3.0, ge=0)
    goals_against_pg: float = Field(3.0, ge=0)
    pp_pct: float = Field(20.0, ge=0, le=100)
    pk_pct: float = Field(80.0, ge=0, le=100)
    conference_rank: int = Field(8, ge=1, le=16)
    prop_type: str = Field("playoff")  # "cup"|"conf"|"playoff"

# ── Game prediction model ─────────────────────────────────────────────────────
#
# Hand-calibrated logistic regression weights derived from published NHL
# statistical research (Schuckers & Curro, 2013; Thomas, 2006).
# Coefficients represent approximate log-odds contributions per unit.

GAME_WEIGHTS = {
    "intercept":      0.10,   # home-ice baseline: ~52.5% vs 50%
    "win_pct_diff":   3.40,   # biggest predictor; scale 0–1 → log-odds
    "gf_diff":        0.55,   # goals-for/pg difference
    "ga_diff":        0.50,   # goals-against/pg (positive = home is tighter)
    "pp_diff":        0.035,  # PP% difference
    "pk_diff":        0.025,  # PK% difference
    "form_diff":      1.20,   # recent-form (L10) difference
}

def _game_moneyline(f: GameFeatures) -> tuple[float, float]:
    """Returns (probability 0–1, confidence 0–1)"""
    win_diff  = f.home_win_pct - f.away_win_pct
    gf_diff   = f.home_goals_for_pg - f.away_goals_for_pg
    ga_diff   = f.away_goals_against_pg - f.home_goals_against_pg  # positive = home advantage
    pp_diff   = f.home_pp_pct - f.away_pp_pct
    pk_diff   = f.home_pk_pct - f.away_pk_pct
    form_diff = f.home_last10_win_pct - f.away_last10_win_pct

    logit = (
        GAME_WEIGHTS["intercept"]
        + GAME_WEIGHTS["win_pct_diff"] * win_diff
        + GAME_WEIGHTS["gf_diff"]      * gf_diff
        + GAME_WEIGHTS["ga_diff"]      * ga_diff
        + GAME_WEIGHTS["pp_diff"]      * pp_diff
        + GAME_WEIGHTS["pk_diff"]      * pk_diff
        + GAME_WEIGHTS["form_diff"]    * form_diff
    )
    prob = sigmoid(logit)
    # Confidence: higher when features strongly agree
    magnitude = (abs(win_diff) * 2 + abs(gf_diff) / 3 + abs(form_diff))
    confidence = clamp(0.50 + magnitude * 0.25, 0.40, 0.92)
    return prob, confidence


@app.post("/predict/game", response_model=MLResponse)
def predict_game(f: GameFeatures) -> MLResponse:
    # Corriger les valeurs manquantes (0 = pas de données NHL API)
    if f.home_pk_pct < 50: f.home_pk_pct = 80.0
    if f.away_pk_pct < 50: f.away_pk_pct = 80.0
    if f.home_pp_pct == 0: f.home_pp_pct = 20.0
    if f.away_pp_pct == 0: f.away_pp_pct = 20.0

    win_diff  = f.home_win_pct - f.away_win_pct
    gf_diff   = f.home_goals_for_pg - f.away_goals_for_pg
    ga_diff   = f.away_goals_against_pg - f.home_goals_against_pg
    form_diff = f.home_last10_win_pct - f.away_last10_win_pct
    pp_diff   = f.home_pp_pct - f.away_pp_pct
    pk_diff   = f.home_pk_pct - f.away_pk_pct

    # ── Branche XGBoost moneyline (modèle entraîné) ───────────────────────────
    if _xgb_game is not None and f.market_type not in ("total_goals_over", "total_goals_under"):
        row = np.array([[
            f.home_win_pct, f.away_win_pct,
            f.home_goals_for_pg, f.away_goals_for_pg,
            f.home_goals_against_pg, f.away_goals_against_pg,
            f.home_pp_pct, f.away_pp_pct,
            f.home_pk_pct, f.away_pk_pct,
            f.home_last10_win_pct, f.away_last10_win_pct,
            win_diff, gf_diff, ga_diff, pp_diff, pk_diff, form_diff,
        ]], dtype=np.float32)
        dmat = xgb.DMatrix(row, feature_names=_GAME_FEAT_NAMES)
        base_prob = float(_xgb_game.predict(dmat)[0])

        if f.market_type == "puck_line":
            prob = clamp(base_prob * 0.62 if base_prob > 0.5 else base_prob * 1.38, 0.05, 0.95)
        else:
            prob = clamp(base_prob, 0.05, 0.95)

        fi_list = []
        for fi in (_game_importances[:6] if _game_importances else []):
            name = fi["name"]
            direction = "positive"
            if "win" in name or "form" in name:
                direction = "positive" if win_diff > 0 else "negative"
            elif "gf" in name or "goals_for" in name:
                direction = "positive" if gf_diff > 0 else "negative"
            elif "ga" in name or "goals_against" in name:
                direction = "positive" if ga_diff > 0 else "negative"
            fi_list.append(FeatureImportance(name=name, importance=fi["importance"], direction=direction))

        magnitude  = abs(win_diff) * 2 + abs(gf_diff) / 3 + abs(form_diff)
        confidence = clamp(0.55 + magnitude * 0.25, 0.45, 0.92)
        direction  = "home team" if prob >= 0.5 else "away team"

        return MLResponse(
            probability=int(prob * 100),
            confidence=int(confidence * 100),
            feature_importances=fi_list[:5],
            model_version="xgb-nhl-v1.0",
            model_type="XGBoost (trained)",
            explanation=f"XGBoost (3 saisons NHL) favours {direction} at {int(prob*100)}%.",
        )

    # ── Branche XGBoost totaux ────────────────────────────────────────────────
    if _xgb_totals is not None and f.market_type in ("total_goals_over", "total_goals_under"):
        row_tot = np.array([[
            f.home_goals_for_pg, f.away_goals_for_pg,
            f.home_goals_against_pg, f.away_goals_against_pg,
            f.home_pp_pct, f.away_pp_pct,
            f.home_pk_pct, f.away_pk_pct,
            gf_diff, ga_diff,
        ]], dtype=np.float32)
        dmat_tot = xgb.DMatrix(row_tot, feature_names=_TOTALS_FEAT_NAMES)
        lam  = float(_xgb_totals.predict(dmat_tot)[0])
        line = f.line if f.line is not None else 5.5
        raw_over = poisson_over(line, lam)
        prob = clamp(raw_over if f.market_type == "total_goals_over" else 1.0 - raw_over, 0.05, 0.95)

        fi_list = [
            FeatureImportance(name=fi["name"], importance=fi["importance"], direction="positive")
            for fi in (_totals_importances[:5] if _totals_importances else [])
        ]
        ou_label = "OVER" if f.market_type == "total_goals_over" else "UNDER"
        return MLResponse(
            probability=int(prob * 100),
            confidence=65,
            feature_importances=fi_list,
            model_version="xgb-totals-v1.0",
            model_type="XGBoost + Poisson (trained)",
            explanation=f"XGBoost prédit λ={lam:.2f} buts → {ou_label} {line}: {int(prob*100)}%.",
        )

    # ── Fallback : poids manuels ──────────────────────────────────────────────
    base_prob, confidence = _game_moneyline(f)

    if f.market_type == "puck_line":
        prob = clamp(base_prob * 0.62 if base_prob > 0.5 else base_prob * 1.38, 0.05, 0.95)
    elif f.market_type == "total_goals_over":
        lam  = f.home_goals_for_pg + f.away_goals_for_pg
        line = f.line if f.line is not None else 5.5
        prob = clamp(poisson_over(line, lam), 0.05, 0.95)
        confidence = 0.65
    elif f.market_type == "total_goals_under":
        lam  = f.home_goals_for_pg + f.away_goals_for_pg
        line = f.line if f.line is not None else 5.5
        prob = clamp(1.0 - poisson_over(line, lam), 0.05, 0.95)
        confidence = 0.65
    else:
        prob = clamp(base_prob, 0.05, 0.95)

    importances = sorted([
        FeatureImportance(name="Win% difference",    importance=round(abs(win_diff  * GAME_WEIGHTS["win_pct_diff"]), 3), direction="positive" if win_diff  > 0 else "negative"),
        FeatureImportance(name="Recent form (L10)",  importance=round(abs(form_diff * GAME_WEIGHTS["form_diff"]),    3), direction="positive" if form_diff > 0 else "negative"),
        FeatureImportance(name="Goals for/game",     importance=round(abs(gf_diff   * GAME_WEIGHTS["gf_diff"]),      3), direction="positive" if gf_diff   > 0 else "negative"),
        FeatureImportance(name="Goals against/game", importance=round(abs(ga_diff   * GAME_WEIGHTS["ga_diff"]),      3), direction="positive" if ga_diff   > 0 else "negative"),
        FeatureImportance(name="Power play %",       importance=round(abs(pp_diff   * GAME_WEIGHTS["pp_diff"]),      3), direction="positive" if pp_diff   > 0 else "negative"),
        FeatureImportance(name="Home ice",           importance=round(abs(GAME_WEIGHTS["intercept"]),                3), direction="positive"),
    ], key=lambda x: x.importance, reverse=True)

    direction = "home team" if prob >= 0.5 else "away team"
    return MLResponse(
        probability=int(prob * 100),
        confidence=int(confidence * 100),
        feature_importances=importances[:5],
        model_version="lr-nhl-v1.1",
        model_type="Logistic Regression (fallback)",
        explanation=f"Fallback — lance train.py pour activer XGBoost. Favours {direction}.",
    )

# ── Player prop model ─────────────────────────────────────────────────────────

@app.post("/predict/player", response_model=MLResponse)
def predict_player(f: PlayerPropFeatures) -> MLResponse:
    rate_map = {
        "goals":    f.goals_per_game,
        "assists":  f.assists_per_game,
        "points":   f.points_per_game,
        "shots":    f.shots_per_game,
        "pp_point": f.goals_per_game * 0.35,   # rough PP-point proxy
    }
    rate = rate_map.get(f.prop_type, f.goals_per_game)

    raw_over = poisson_over(f.line, rate)
    prob = raw_over if f.selection == "over" else 1.0 - raw_over
    prob = clamp(prob, 0.05, 0.95)

    # Confidence: grows with games played (sample size)
    confidence = clamp(0.40 + f.games_played / 82 * 0.50, 0.42, 0.88)

    pace_vs_line = (rate - f.line) / max(f.line, 0.1)

    importances = sorted([
        FeatureImportance(name=f"{f.prop_type.capitalize()} rate/game", importance=round(rate, 3),           direction="positive" if rate > f.line else "negative"),
        FeatureImportance(name="Sample size (GP)",                       importance=round(f.games_played / 82, 3), direction="positive"),
        FeatureImportance(name="Pace vs line",                           importance=round(abs(pace_vs_line), 3),   direction="positive" if pace_vs_line > 0 else "negative"),
        FeatureImportance(name="Points/game",                            importance=round(f.points_per_game, 3),   direction="positive" if f.points_per_game > 0.5 else "negative"),
        FeatureImportance(name="Shots/game",                             importance=round(f.shots_per_game / 5, 3), direction="positive" if f.shots_per_game > 2.5 else "negative"),
    ], key=lambda x: x.importance, reverse=True)

    over_under = f.selection.upper()
    return MLResponse(
        probability=int(prob * 100),
        confidence=int(confidence * 100),
        feature_importances=importances[:5],
        model_version="poisson-v1.0",
        model_type="Poisson Distribution",
        explanation=f"Poisson model: player averages {rate:.2f} {f.prop_type}/game; {over_under} {f.line} implied at {int(prob*100)}%.",
    )

# ── Team futures model ────────────────────────────────────────────────────────

RANK_PRIORS: dict[str, list[float]] = {
    "cup":     [.28,.20,.15,.11,.08,.06,.04,.03,.02,.01,.01,.01,.005,.005,.003,.002],
    "conf":    [.38,.30,.23,.18,.13,.09,.07,.05,.04,.03,.02,.01,.01,.01,.005,.003],
    "playoff": [.97,.95,.91,.85,.77,.68,.56,.43,.30,.20,.12,.07,.04,.02,.01,.005],
}

@app.post("/predict/team", response_model=MLResponse)
def predict_team(f: TeamFuturesFeatures) -> MLResponse:
    if f.pk_pct < 50: f.pk_pct = 80.0
    if f.pp_pct == 0: f.pp_pct = 20.0
    rank_idx = max(0, min(f.conference_rank - 1, 15))
    priors = RANK_PRIORS.get(f.prop_type, RANK_PRIORS["playoff"])
    base = priors[rank_idx]

    gf_diff    = f.goals_for_pg - f.goals_against_pg
    quality    = (f.win_pct / 100 - 0.5) * 0.12 + gf_diff * 0.025
    sp_quality = (f.pp_pct - 20) * 0.003 + (f.pk_pct - 80) * 0.002
    prob = clamp(base + quality + sp_quality, 0.02, 0.95)
    confidence = 60

    importances = sorted([
        FeatureImportance(name="Conference rank",   importance=round(base, 3),                    direction="positive" if rank_idx < 8 else "negative"),
        FeatureImportance(name="Win percentage",    importance=round(abs(f.win_pct/100 - 0.5), 3), direction="positive" if f.win_pct > 50 else "negative"),
        FeatureImportance(name="Goal differential", importance=round(abs(gf_diff) * 0.025, 3),    direction="positive" if gf_diff > 0 else "negative"),
        FeatureImportance(name="Power play %",      importance=round(abs(f.pp_pct - 20) * 0.003, 3), direction="positive" if f.pp_pct > 20 else "negative"),
        FeatureImportance(name="Penalty kill %",    importance=round(abs(f.pk_pct - 80) * 0.002, 3), direction="positive" if f.pk_pct > 80 else "negative"),
    ], key=lambda x: x.importance, reverse=True)

    prop_label = {"cup": "Stanley Cup", "conf": "Conference Final", "playoff": "Playoff berth"}.get(f.prop_type, f.prop_type)
    return MLResponse(
        probability=int(prob * 100),
        confidence=confidence,
        feature_importances=importances[:5],
        model_version="rank-bayes-v1.0",
        model_type="Bayesian Prior",
        explanation=f"Conference-rank prior ({f.prop_type}={f.conference_rank}) adjusted for goal differential and special teams.",
    )

# ── Health / info ─────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "models": {
            "game":   "XGBoost (trained)" if _xgb_game   is not None else "Logistic Regression (fallback)",
            "totals": "XGBoost + Poisson (trained)" if _xgb_totals is not None else "Poisson (fallback)",
            "player": "Poisson Distribution",
            "team":   "Bayesian Prior",
        },
        "trained_models_loaded": {
            "game_model":   _xgb_game   is not None,
            "totals_model": _xgb_totals is not None,
        },
        "tip": "Lance fetch_data.py puis train.py pour activer XGBoost (models/*.json).",
    }

@app.get("/features")
def features():
    return {
        "game_features":   GameFeatures.model_json_schema(),
        "player_features": PlayerPropFeatures.model_json_schema(),
        "team_features":   TeamFuturesFeatures.model_json_schema(),
    }

# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("ml_service:app", host="0.0.0.0", port=8000, reload=True)
