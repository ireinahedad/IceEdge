"""
ArakIce ML Service
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
    GET  /reports            Rapports d'entraînement/backtest + fraîcheur des artefacts

Accès : /predict/*, /features et /reports exigent l'en-tête `X-ML-Token` (= ML_API_TOKEN).
/health et /health/ready restent ouverts pour les sondes de la plateforme.
"""

from __future__ import annotations
import hmac
import json
import math
import os
from datetime import datetime, timezone
from typing import List, Optional

import numpy as np
import xgboost as xgb
from score_model import P_OT_HOME, ScoreDistribution, ScoreEnsemble
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

# ── Monitoring d'erreurs (Sentry) ─────────────────────────────────────────────
# No-op tant que SENTRY_DSN n'est pas défini → dev/CI restent silencieux.
# L'intégration FastAPI capture automatiquement les exceptions des endpoints.
#
# ÉCHANTILLONNAGE — même règle que côté Node (`server/src/instrument.ts`,
# audit ligne 10) : 1 % en production, 10 % ailleurs. Ce réglage ne concerne que
# le tracing de PERFORMANCE ; les exceptions partent à 100 % dans tous les cas.
# Ce service reçoit jusqu'à 30 appels par requête `best-bets` : c'est le point de
# la stack où un taux de traçage élevé coûte le plus cher pour l'information la
# plus redondante.
_SENTRY_DSN = os.environ.get("SENTRY_DSN")
_ENVIRONMENT = os.environ.get("ENVIRONMENT", "production")
if _SENTRY_DSN:
    import sentry_sdk
    _default_rate = "0.01" if _ENVIRONMENT == "production" else "0.1"
    sentry_sdk.init(
        dsn=_SENTRY_DSN,
        traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", _default_rate)),
        environment=_ENVIRONMENT,
    )

# ── Contrôle d'accès ──────────────────────────────────────────────────────────
# Ce service n'a aucune notion d'utilisateur : il ne doit être joignable que par
# le backend Node. Deux barrières indépendantes :
#   1. Réseau — déployé SANS domaine public, atteignable uniquement via le réseau
#      privé Railway (http://<service>.railway.internal:8000). Cf. DEPLOYMENT.md §3.
#   2. Token partagé — `ML_API_TOKEN`, envoyé dans l'en-tête `X-ML-Token`. Tient
#      même si un domaine public est généré un jour par inadvertance.
#
# En environnement déployé le token est obligatoire : sans lui le process refuse
# de démarrer plutôt que de servir des inférences XGBoost au monde entier
# (compute facturé à l'usage + exfiltration du modèle par requêtes répétées).
# `ML_AUTH_DISABLED=true` est l'échappatoire explicite pour un déploiement
# strictement privé — à ne poser qu'en connaissance de cause.

_ML_API_TOKEN  = os.environ.get("ML_API_TOKEN", "").strip()
_AUTH_DISABLED = os.environ.get("ML_AUTH_DISABLED", "").lower() == "true"
_IS_DEPLOYED   = (
    os.environ.get("ENVIRONMENT", "").lower() == "production"
    or bool(os.environ.get("RAILWAY_ENVIRONMENT"))
)

if _IS_DEPLOYED and not _ML_API_TOKEN and not _AUTH_DISABLED:
    raise RuntimeError(
        "ML_API_TOKEN manquant. Définir le même secret partagé côté backend Node, "
        "ou — si le service n'expose AUCUN domaine public — poser explicitement "
        "ML_AUTH_DISABLED=true."
    )

_AUTH_ENABLED = bool(_ML_API_TOKEN) and not _AUTH_DISABLED


def require_ml_token(
    x_ml_token: Optional[str] = Header(default=None, alias="X-ML-Token"),
) -> None:
    """Garde les endpoints d'inférence. `compare_digest` = comparaison à temps
    constant : le token ne peut pas être deviné octet par octet via le timing."""
    if not _AUTH_ENABLED:
        return
    # Comparaison sur des bytes : compare_digest lève TypeError sur une str
    # non-ASCII, et les en-têtes HTTP sont décodés en latin-1 par Starlette —
    # un octet > 127 dans le header donnerait un 500 au lieu d'un 401.
    if not x_ml_token or not hmac.compare_digest(
        x_ml_token.encode("utf-8", "ignore"), _ML_API_TOKEN.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


# Appliqué aux routes qui coûtent du CPU ou décrivent le modèle. /health et
# /health/ready restent ouverts : les sondes de la plateforme n'ont pas le token.
_PROTECTED = [Depends(require_ml_token)]

# Les docs interactives exposent tout le schéma de features (donc l'architecture
# du modèle). Inutiles en prod, où le seul client est le backend Node.
app = FastAPI(
    title="ArakIce ML Service",
    version="2.0.0",
    docs_url=None if _IS_DEPLOYED else "/docs",
    redoc_url=None,
    openapi_url=None if _IS_DEPLOYED else "/openapi.json",
)

# CORS : aucun navigateur n'appelle ce service directement (le backend Node fait
# proxy), donc aucune origine autorisée par défaut. `ML_CORS_ORIGINS` permet d'en
# déclarer explicitement (séparées par des virgules) — jamais "*".
_cors_origins = [o.strip() for o in os.environ.get("ML_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-ML-Token"],
    )

# ── Chargement des modèles entraînés (si disponibles) ─────────────────────────
#
# Après avoir lancé :  python fetch_data.py && python train.py
# les fichiers .pkl existent dans ml/models/ et sont chargés ici.
# Si absents, le service utilise les poids manuels comme fallback.

# En local, ml_service.py est dans ml/python/ → les modèles sont dans ../models.
# Dans l'image Docker le code est aplati à la racine de /app et les modèles sont
# dans /app/models : le chemin relatif pointerait alors sur /models (inexistant)
# et le service démarrerait en mode règles SANS erreur. D'où MODELS_DIR, posé
# explicitement par le Dockerfile.
MODELS_DIR = os.environ.get("MODELS_DIR") or os.path.join(
    os.path.dirname(__file__), "..", "models"
)

_xgb_game:   xgb.Booster | None = None
_game_importances:   list[dict] = []

# Il n'y a plus de modèle de totaux dédié (S2). Le repli `totals_model.json`
# appliquait un Poisson lisse sur un total espéré ponctuel — P2 l'a mesuré faux
# de 2.5 à 4.4 points par ligne. Le modèle de score price toute ligne depuis la
# distribution jointe complète et compte correctement le but de prolongation.
# Un repli qui, s'il se déclenchait, servirait un prix qu'on sait mauvais n'est
# pas un filet de sécurité : sans modèle de score, on retombe sur les
# heuristiques déclarées comme telles (`_apply_market`).

# Modèle de score (P2) — Poisson empilé équipe-match. Voir score_model.py.
# Une fois chargé, il price exactement moneyline, puck-line, totaux (toute
# ligne), totaux d'équipe et prolongation, en remplacement des heuristiques.
# Patineurs habillés par match — doit rester égal à LINEUP_DRESSED dans
# build_dataset.py, sinon la projection d'alignement servie n'est plus à la même
# échelle que celle vue à l'entraînement.
_LINEUP_DRESSED = 18

_xgb_score: xgb.Booster | None = None
_SCORE_FEAT_NAMES: list[str] = []
_score_tau: dict[int, float] | None = None
_score_p_ot: float = P_OT_HOME

# Ensemble bootstrap (P4) — mesure l'incertitude d'ESTIMATION du prix, pas le
# hasard du match. Optionnel : sans lui le service répond exactement comme
# avant, sans champ σ. Le prix servi reste toujours celui du modèle principal ;
# les membres ne servent qu'à mesurer la dispersion (cf. ScoreEnsemble).
_score_members: list[xgb.Booster] = []
_score_sigma_max: float | None = None

# ELO (écrit par train.py) — ratings par équipe pour l'inférence
_elo_ratings:  dict[str, float] = {}
_elo_base     = 1500.0
_elo_home_adv = 50.0

# Calibration de Platt (écrite par train.py dans training_report.json)
_platt_a: float | None = None
_platt_b: float | None = None

# v4 — état d'inférence (rolling MoneyPuck par équipe, gardiens, stars)
# écrit par build_dataset.py, et blend modèle ⊕ marché (training_report.json)
_inference_state: dict = {}
_blend_w: list[float] | None = None

# Features attendues par chaque modèle.
# Fallback statique (ancien modèle 18 features) — écrasé au chargement par
# training_report.json["features"], la source de vérité écrite par train.py.
_GAME_FEAT_NAMES = [
    "home_win_pct", "away_win_pct",
    "home_goals_for_pg", "away_goals_for_pg",
    "home_goals_against_pg", "away_goals_against_pg",
    "home_pp_pct", "away_pp_pct",
    "home_pk_pct", "away_pk_pct",
    "home_last10_win_pct", "away_last10_win_pct",
    "win_pct_diff", "gf_diff", "ga_diff", "pp_diff", "pk_diff", "form_diff",
]


def _load_score_ensemble(rep: dict) -> None:
    """Charge les membres bootstrap s'ils existent (P4).

    Entièrement facultatif : sans `score_ensemble/`, `_score_members` reste vide
    et le service se comporte exactement comme avant. On exige `sigma_max` en
    plus des membres, parce qu'un σ sans échelle de référence n'est pas
    interprétable — et cette échelle doit venir de l'entraînement, pas d'ici.
    """
    global _score_members, _score_sigma_max
    _score_members, _score_sigma_max = [], None

    meta = rep.get("ensemble") or {}
    ens_dir = os.path.join(MODELS_DIR, "score_ensemble")
    if not meta or not os.path.isdir(ens_dir):
        print("[ML] ℹ️  Pas d'ensemble bootstrap — σ non exposée")
        return
    try:
        files = sorted(f for f in os.listdir(ens_dir)
                       if f.startswith("member_") and f.endswith(".json"))
        members = []
        for fname in files:
            b = xgb.Booster()
            b.load_model(os.path.join(ens_dir, fname))
            members.append(b)
        sigma_max = meta.get("sigma_max")
        if len(members) < 2 or not sigma_max:
            raise ValueError(f"{len(members)} membre(s), sigma_max={sigma_max}")
        _score_members = members
        _score_sigma_max = float(sigma_max)
        verdict = ((meta.get("test") or {}).get("verdict")) or "verdict non consigné"
        print(f"[ML] ✅ ensemble bootstrap — {len(members)} membres, "
              f"σ_max={_score_sigma_max:.5f}")
        print(f"[ML]    {verdict}")
    except Exception as e:
        _score_members, _score_sigma_max = [], None
        print(f"[ML] ⚠️  ensemble bootstrap ignoré : {e} — σ non exposée")


def _try_load_models():
    global _xgb_game, _game_importances
    global _GAME_FEAT_NAMES
    global _elo_ratings, _elo_base, _elo_home_adv, _platt_a, _platt_b
    global _inference_state, _blend_w

    game_path   = os.path.join(MODELS_DIR, "game_model.json")
    gi_path     = os.path.join(MODELS_DIR, "feature_importance_game.json")
    report_path = os.path.join(MODELS_DIR, "training_report.json")
    elo_path    = os.path.join(MODELS_DIR, "elo_ratings.json")

    # Noms de features depuis le rapport d'entraînement (source de vérité)
    if os.path.exists(report_path):
        try:
            with open(report_path) as f:
                report = json.load(f)
            feats = report.get("features", {})
            if feats.get("game"):
                _GAME_FEAT_NAMES = feats["game"]
            cal = (report.get("game_model") or {}).get("calibration") or {}
            if cal.get("method") == "platt":
                _platt_a, _platt_b = float(cal["a"]), float(cal["b"])
                print(f"[ML] ✅ Calibration Platt chargée (a={_platt_a:.3f}, b={_platt_b:.3f})")
            blend = ((report.get("game_model") or {}).get("baselines") or {}) \
                        .get("market") or {}
            if blend.get("blend_weights"):
                _blend_w = [float(x) for x in blend["blend_weights"]]
                print(f"[ML] ✅ Blend modèle ⊕ marché chargé (w={_blend_w})")
            print(f"[ML] ✅ Features chargées depuis training_report.json "
                  f"(game: {len(_GAME_FEAT_NAMES)})")
        except Exception as e:
            print(f"[ML] ⚠️  training_report.json : {e} — fallback listes statiques")

    # État d'inférence v4 (rolling xG/gardiens/stars par équipe)
    state_path = os.path.join(MODELS_DIR, "inference_state.json")
    if os.path.exists(state_path):
        try:
            with open(state_path) as f:
                _inference_state = json.load(f)
            print(f"[ML] ✅ inference_state.json chargé "
                  f"({len(_inference_state.get('teams', {}))} équipes, "
                  f"as of {_inference_state.get('as_of', '?')})")
        except Exception as e:
            print(f"[ML] ⚠️  inference_state.json : {e}")

    # Ratings ELO (pour les features elo_* à l'inférence)
    if os.path.exists(elo_path):
        try:
            with open(elo_path) as f:
                elo = json.load(f)
            _elo_ratings  = {k.upper(): float(v) for k, v in (elo.get("ratings") or {}).items()}
            _elo_base     = float(elo.get("base", 1500.0))
            _elo_home_adv = float(elo.get("home_adv", 50.0))
            print(f"[ML] ✅ elo_ratings.json chargé ({len(_elo_ratings)} équipes, "
                  f"as of {elo.get('as_of_date', '?')})")
        except Exception as e:
            print(f"[ML] ⚠️  elo_ratings.json : {e}")

    if os.path.exists(game_path):
        try:
            _xgb_game = xgb.Booster()
            _xgb_game.load_model(game_path)
            print(f"[ML] ✅ game_model.json chargé (XGBoost)")
        except Exception as e:
            _xgb_game = None
            print(f"[ML] ⚠️  game_model.json : {e}")

    # ── Modèle de score (P2) ────────────────────────────────────────────────
    # Chargé indépendamment des autres : s'il manque, le service garde les
    # heuristiques historiques et continue de répondre normalement.
    global _xgb_score, _SCORE_FEAT_NAMES, _score_tau, _score_p_ot
    score_path  = os.path.join(MODELS_DIR, "score_model.json")
    score_rep   = os.path.join(MODELS_DIR, "score_report.json")
    if os.path.exists(score_path) and os.path.exists(score_rep):
        try:
            with open(score_rep) as fh:
                rep = json.load(fh)
            _SCORE_FEAT_NAMES = list(rep.get("features") or [])
            _score_tau = {int(k): float(v)
                          for k, v in (rep.get("tau_margin") or {}).items()}
            _score_p_ot = float(rep.get("p_ot_home", P_OT_HOME))
            if not _SCORE_FEAT_NAMES:
                raise ValueError("score_report.json sans liste de features")
            b = xgb.Booster()
            b.load_model(score_path)
            _xgb_score = b
            print(f"[ML] ✅ score_model.json chargé — {len(_SCORE_FEAT_NAMES)} features, "
                  f"τ sur {len(_score_tau)} écarts, P(dom en OT)={_score_p_ot:.4f}")
            _load_score_ensemble(rep)
        except Exception as e:
            _xgb_score, _SCORE_FEAT_NAMES, _score_tau = None, [], None
            print(f"[ML] ⚠️  score_model.json : {e} — heuristiques conservées")
    else:
        print("[ML] ℹ️  Pas de score_model.json — heuristiques de marchés dérivés")
        print("[ML]    Lance : python build_dataset.py && python train_score.py")

    if os.path.exists(gi_path):
        with open(gi_path) as f:
            _game_importances = json.load(f)

    if _xgb_game is None and _xgb_score is None:
        print("[ML] ℹ️  Aucun modèle .json — utilisation des poids manuels (fallback)")
        print("[ML]    Lance : python fetch_data.py && python train.py")

_try_load_models()

# Set once the model-load attempt has completed. The readiness probe gates on
# this so the orchestrator only routes traffic after init (models loaded, or
# fallback confirmed). Load is synchronous at import, so this is True by the
# time uvicorn accepts requests.
_startup_complete = True

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
    # ── P4 — incertitude d'estimation, en POINTS DE POURCENTAGE ──────────────
    # Écart-type de la probabilité entre les membres de l'ensemble bootstrap.
    # Absent (None) si l'ensemble n'est pas chargé ou si le marché n'est pas
    # dérivable du modèle de score : le champ est optionnel pour rester
    # rétro-compatible avec les clients existants.
    #
    # Attention à la lecture : c'est l'incertitude sur le PRIX, pas sur le
    # résultat du match. Un match parfaitement prévisible à 50/50 aura un σ
    # proche de 0. σ répond à « le modèle sait-il ce qu'il dit ? », pas à
    # « le match est-il serré ? ».
    probability_std: Optional[float] = None
    # σ / σ_max, borné à 1. C'est exactement la fraction de mise retirée par
    # `uncertainty_haircut` — exposée pour que le backend puisse dimensionner
    # sans recoder la règle ni connaître σ_max.
    uncertainty: Optional[float] = None

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
    # ── Nouvelles features (v2) — défauts neutres si le backend ne les envoie pas
    home_home_win_pct:     float = Field(0.54, ge=0, le=1)   # record à domicile
    away_road_win_pct:     float = Field(0.46, ge=0, le=1)   # record à l'extérieur
    home_streak:           float = Field(0.0,  ge=-20, le=20)  # série signée
    away_streak:           float = Field(0.0,  ge=-20, le=20)
    home_shots_for_pg:     float = Field(30.0, ge=0)
    away_shots_for_pg:     float = Field(30.0, ge=0)
    home_shots_against_pg: float = Field(30.0, ge=0)
    away_shots_against_pg: float = Field(30.0, ge=0)
    home_faceoff_pct:      float = Field(50.0, ge=0, le=100)
    away_faceoff_pct:      float = Field(50.0, ge=0, le=100)
    home_rest_days:        float = Field(2.0,  ge=0, le=7)
    away_rest_days:        float = Field(2.0,  ge=0, le=7)
    home_b2b:              int   = Field(0,    ge=0, le=1)   # back-to-back
    away_b2b:              int   = Field(0,    ge=0, le=1)
    home_3in4:             float = Field(0.0,  ge=0, le=4)   # matchs dans les 3 jours précédents
    away_3in4:             float = Field(0.0,  ge=0, le=4)
    # ── v5 — voyage / fuseaux / altitude / road-trip (miroir de build_dataset).
    #    Défauts neutres (0) si le backend ne les fournit pas → mêmes noms que
    #    les colonnes d'entraînement, XGBoost gère l'absence via missing=NaN.
    home_distance_km:   float = Field(0.0, ge=0)   # trajet depuis l'aréna précédent (km)
    away_distance_km:   float = Field(0.0, ge=0)
    home_tz_shift:      float = Field(0.0, ge=-4, le=4)  # fuseaux traversés (+ = est)
    away_tz_shift:      float = Field(0.0, ge=-4, le=4)
    home_days_away:     float = Field(0.0, ge=0)   # jours loin de la maison
    away_days_away:     float = Field(0.0, ge=0)
    home_road_trip_len: float = Field(0.0, ge=0)   # longueur du road trip en cours
    away_road_trip_len: float = Field(0.0, ge=0)
    home_road_game_num: float = Field(0.0, ge=0)   # rang du match dans le trip
    away_road_game_num: float = Field(0.0, ge=0)
    home_getaway:       int   = Field(0, ge=0, le=1)  # dernier match du road trip
    away_getaway:       int   = Field(0, ge=0, le=1)
    home_alt_gain:      float = Field(0.0)         # dénivelé vs aréna précédent (m)
    away_alt_gain:      float = Field(0.0)
    venue_altitude_m:   float = Field(0.0, ge=0)   # altitude du terrain (m)
    # ── ELO (v3) — abréviations d'équipes pour lookup dans elo_ratings.json.
    #    Le backend Node envoie home_team/away_team; le service résout les ratings.
    home_team: Optional[str] = None          # abréviation, ex. "TOR"
    away_team: Optional[str] = None
    home_elo:  Optional[float] = None        # override explicite (sinon lookup)
    away_elo:  Optional[float] = None
    market_type: str = Field("moneyline")    # "moneyline"|"puck_line"|"total_goals_over"|"total_goals_under"
    line: Optional[float] = None             # for total goals
    # ── v4 — cotes du marché (The Odds API, format DÉCIMAL, ex. 1.87) ────────
    home_odds_decimal: Optional[float] = Field(None, gt=1.0)
    away_odds_decimal: Optional[float] = Field(None, gt=1.0)
    total_line_market: Optional[float] = None    # ligne O/U du marché (ex. 6.0)
    # ── v4 — contexte lineup (optionnel; défauts raisonnables sinon) ─────────
    home_goalie: Optional[str] = None            # nom du gardien partant si connu
    away_goalie: Optional[str] = None
    home_stars_missing: int = Field(0, ge=0, le=5)   # legacy : nb de top-5 absents
    away_stars_missing: int = Field(0, ge=0, le=5)
    # Absents confirmés du soir (Daily Faceoff) — noms orthographe MoneyPuck.
    # Si fournis, le service dérive stars_missing/star_power des BONS joueurs et
    # calcule stars_out_weight (absence pondérée perf + position/trio).
    home_scratches: List[str] = Field(default_factory=list)
    away_scratches: List[str] = Field(default_factory=list)

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


def _apply_score_model(market: str, f: GameFeatures,
                       dist: "ScoreDistribution") -> "tuple[float, float, str] | None":
    """Prix exact issu du modèle de score (P2), quand le marché est dérivable.

    Là où les heuristiques historiques appliquaient des multiplicateurs arbitraires
    (puck-line = base_prob × 0.60, régulation = base_prob × 0.85 avec un taux de
    prolongation supposé de 15 % alors qu'il est de 23 %), on somme ici la vraie
    distribution jointe des scores. Calibration mesurée sur 3 762 matchs de test :

        nul réglementaire  prédit 0.2185  observé 0.2204
        domicile -1.5      prédit 0.3296  observé 0.3312

    Retourne None si le marché n'est pas dérivable — l'appelant retombe alors sur
    l'heuristique historique.
    """
    lh, la = dist.lam_home, dist.lam_away

    if market == "moneyline":
        p = dist.p_home_win()
        return p, 1.00, (f"Modèle de score λ={lh:.2f}/{la:.2f} → domicile "
                         f"{int(p * 100)}% (prolongation incluse).")

    if market == "puck_line":
        p = dist.p_home_cover_minus_15()
        return p, 0.92, (f"P(domicile gagne par ≥2) = {int(p * 100)}% — "
                         f"un match en prolongation se finit toujours à 1 but d'écart.")

    if market == "alt_puck_line":
        p = float(dist.M[dist._margin >= 3].sum())
        return p, 0.85, f"P(domicile gagne par ≥3) = {int(p * 100)}%."

    if market in ("total_goals", "total_goals_over"):
        line = f.line if f.line is not None else 5.5
        p = dist.p_over(line)
        return p, 0.88, (f"Distribution de score λ={lh:.2f}/{la:.2f}, total espéré "
                         f"{dist.expected_total():.2f} → OVER {line} : {int(p * 100)}%.")

    if market == "total_goals_under":
        line = f.line if f.line is not None else 5.5
        p = dist.p_under(line)
        return p, 0.88, (f"Distribution de score λ={lh:.2f}/{la:.2f}, total espéré "
                         f"{dist.expected_total():.2f} → UNDER {line} : {int(p * 100)}%.")

    if market == "team_total_goals":
        line = f.line if f.line is not None else 2.5
        p = dist.p_team_over("home", line)
        return p, 0.85, (f"Buts du domicile (λ={lh:.2f}, but de prolongation inclus) "
                         f"→ OVER {line} : {int(p * 100)}%.")

    if market == "regulation_result":
        p = float(dist.M[dist._margin > 0].sum())
        return p, 0.90, (f"Victoire du domicile en 60 minutes : {int(p * 100)}% "
                         f"(P(nul réglementaire) = {dist.p_regulation_tie():.0%}).")

    if market == "game_to_ot":
        p = dist.p_regulation_tie()
        return p, 0.90, f"P(nul après 60 minutes) = {int(p * 100)}%."

    return None


def _score_market_fn(market: str, f: GameFeatures):
    """`dist -> proba` pour le marché servi, ou None s'il n'est pas dérivable.

    Sert à mesurer σ sur EXACTEMENT la quantité qu'on price. Prendre σ sur λ ou
    sur le moneyline pour ensuite l'appliquer à un total serait faux : deux λ
    incertains mais dont la somme est stable donnent un moneyline très incertain
    et un total très sûr. Chaque marché a sa propre incertitude.

    Doit rester aligné sur `_apply_score_model` — même marché, même formule.
    """
    line = f.line
    if market == "moneyline":
        return lambda d: d.p_home_win()
    if market == "puck_line":
        return lambda d: d.p_home_cover_minus_15()
    if market == "alt_puck_line":
        return lambda d: float(d.M[d._margin >= 3].sum())
    if market in ("total_goals", "total_goals_over"):
        ln = line if line is not None else 5.5
        return lambda d: d.p_over(ln)
    if market == "total_goals_under":
        ln = line if line is not None else 5.5
        return lambda d: d.p_under(ln)
    if market == "team_total_goals":
        ln = line if line is not None else 2.5
        return lambda d: d.p_team_over("home", ln)
    if market == "regulation_result":
        return lambda d: float(d.M[d._margin > 0].sum())
    if market == "game_to_ot":
        return lambda d: d.p_regulation_tie()
    return None


def _apply_market(
    market: str,
    base_prob: float,
    f: GameFeatures,
    win_diff: float,
    lam_home: float,
    lam_away: float,
    model_label: str,
    dist: "ScoreDistribution | None" = None,
) -> "tuple[float, float, str]":
    """
    Derive market-specific probability from the base home-win probability.
    Returns (probability 0-1, confidence_multiplier 0-1, explanation string).
    base_prob = P(home team wins) from XGBoost or logistic regression.

    Si le modèle de score est chargé, les marchés dérivables sont pricés
    exactement par `_apply_score_model`; le reste garde les heuristiques.
    """
    if dist is not None:
        exact = _apply_score_model(market, f, dist)
        if exact is not None:
            p, conf, expl = exact
            return clamp(p, 0.02, 0.98), conf, expl

    total_lam = lam_home + lam_away
    line = f.line if f.line is not None else 5.5
    bp = int(base_prob * 100)

    if market == "moneyline":
        prob = base_prob
        conf = 1.00
        expl = f"{model_label}: équipe domicile à {int(prob*100)}%."

    elif market == "puck_line":
        prob = clamp(base_prob * 0.60 if base_prob > 0.5 else base_prob * 1.40, 0.05, 0.80)
        conf = 0.90
        expl = f"Home win {bp}% → gagne par ≥2 buts: {int(prob*100)}%."

    elif market == "alt_puck_line":
        prob = clamp(base_prob * 0.38 if base_prob > 0.5 else base_prob * 1.62, 0.05, 0.55)
        conf = 0.82
        expl = f"Ligne alternative ±2.5 buts (home {bp}%): {int(prob*100)}%."

    elif market in ("total_goals", "total_goals_over"):
        prob = clamp(poisson_over(line, total_lam), 0.05, 0.95)
        conf = 0.85
        expl = f"Poisson λ={total_lam:.1f} buts → OVER {line}: {int(prob*100)}%."

    elif market == "total_goals_under":
        prob = clamp(1.0 - poisson_over(line, total_lam), 0.05, 0.95)
        conf = 0.85
        expl = f"Poisson λ={total_lam:.1f} buts → UNDER {line}: {int(prob*100)}%."

    elif market == "team_total_goals":
        home_line = f.line if f.line is not None else 2.5
        prob = clamp(poisson_over(home_line, lam_home), 0.05, 0.95)
        conf = 0.80
        expl = f"Poisson λ={lam_home:.1f} buts/match domicile → OVER {home_line}: {int(prob*100)}%."

    elif market == "regulation_result":
        # ~85% of wins happen in regulation (15% go to OT/SO)
        prob = clamp(base_prob * 0.85, 0.05, 0.88)
        conf = 0.88
        expl = f"Victoire en 60 min: {int(prob*100)}% (home {bp}% × 0.85 car ~15% finissent en OT/SO)."

    elif market == "game_to_ot":
        # NHL OT rate ≈ 24%. Closer the matchup, higher the OT probability.
        closeness = max(0.0, 0.25 - abs(win_diff))
        prob = clamp(0.20 + closeness * 0.88, 0.08, 0.40)
        conf = 0.68
        expl = f"Écart win% = {win_diff:+.2f} → P(OT/SO) = {int(prob*100)}%. Moyenne NHL: ~24%."

    elif market == "ot_winner":
        # In OT: slight home advantage (52% base) + win% signal
        prob = clamp(0.52 + win_diff * 0.28, 0.28, 0.72)
        conf = 0.62
        expl = f"En OT: avantage domicile 52% + force relative → {int(prob*100)}%."

    elif market == "both_teams_score":
        # P(both score) = 1 − P(home shutout) − P(away shutout) + P(double shutout)
        p_home_shutout = math.exp(-lam_away)  # away team scores 0
        p_away_shutout = math.exp(-lam_home)  # home team scores 0
        prob = clamp(
            1.0 - p_home_shutout - p_away_shutout + p_home_shutout * p_away_shutout,
            0.40, 0.95
        )
        conf = 0.88
        expl = f"Poisson: λdom={lam_home:.1f}, λext={lam_away:.1f} → {int(prob*100)}% que les deux marquent."

    elif market == "first_team_score":
        # Who scores first: proportional to scoring rate
        prob = clamp(lam_home / (lam_home + lam_away + 0.001), 0.35, 0.65)
        conf = 0.78
        expl = f"Taux de marquage: dom {lam_home:.1f} vs ext {lam_away:.1f} → {int(prob*100)}% premier but domicile."

    elif market == "last_team_score":
        # Leading team tends to score last
        prob = clamp(0.50 + (base_prob - 0.50) * 0.65, 0.30, 0.70)
        conf = 0.72
        expl = f"L'équipe qui mène tend à marquer en dernier → {int(prob*100)}%."

    elif market == "period1_winner":
        prob = clamp(0.50 + (base_prob - 0.50) * 0.62, 0.22, 0.78)
        conf = 0.76
        expl = f"Win% P1 (signal atténué depuis moneyline) → {int(prob*100)}%."

    elif market == "period2_winner":
        prob = clamp(0.50 + (base_prob - 0.50) * 0.70, 0.22, 0.78)
        conf = 0.78
        expl = f"Win% P2 → {int(prob*100)}%."

    elif market == "period3_winner":
        prob = clamp(0.50 + (base_prob - 0.50) * 0.78, 0.22, 0.78)
        conf = 0.82
        expl = f"Win% P3 (plus corrélé avec résultat final) → {int(prob*100)}%."

    elif market == "highest_scoring_period":
        # P2 is NHL's highest-scoring period on average (~38%)
        prob = clamp(0.38 + (total_lam - 6.0) * 0.025, 0.26, 0.50)
        conf = 0.65
        expl = f"P2 est la plus productive en NHL (38% avg) → {int(prob*100)}%."

    elif market == "period1_total_goals":
        p1_line = f.line if f.line is not None else 1.5
        p1_lam = total_lam / 3.0 * 0.95
        prob = clamp(poisson_over(p1_line, p1_lam), 0.05, 0.95)
        conf = 0.74
        expl = f"Poisson P1 λ={p1_lam:.2f} → OVER {p1_line}: {int(prob*100)}%."

    elif market == "period2_total_goals":
        p2_line = f.line if f.line is not None else 1.5
        p2_lam = total_lam / 3.0 * 1.10   # P2 slightly higher scoring
        prob = clamp(poisson_over(p2_line, p2_lam), 0.05, 0.95)
        conf = 0.74
        expl = f"Poisson P2 λ={p2_lam:.2f} (+10% vs avg) → OVER {p2_line}: {int(prob*100)}%."

    elif market == "period3_total_goals":
        p3_line = f.line if f.line is not None else 1.5
        p3_lam = total_lam / 3.0 * 0.95
        prob = clamp(poisson_over(p3_line, p3_lam), 0.05, 0.95)
        conf = 0.72
        expl = f"Poisson P3 λ={p3_lam:.2f} → OVER {p3_line}: {int(prob*100)}%."

    elif market == "winning_margin":
        # P(home wins by exact margin): rough composite
        prob = clamp(base_prob * 0.40, 0.04, 0.48)
        conf = 0.58
        expl = f"Marge exacte difficile à prédire → ~{int(prob*100)}%."

    elif market == "double_chance":
        # Home wins in reg OR goes to OT and home wins OT
        ot_rate = clamp(0.20 + max(0.0, 0.25 - abs(win_diff)) * 0.88, 0.08, 0.40)
        ot_home = clamp(0.52 + win_diff * 0.28, 0.28, 0.72)
        prob = clamp(base_prob * 0.85 + ot_rate * ot_home, 0.35, 0.92)
        conf = 0.88
        expl = f"Double chance (gagne reg + OT): {int(prob*100)}%."

    elif market == "team_pp_goals":
        prob = clamp(0.40 + (f.home_pp_pct - 20.0) * 0.007, 0.18, 0.72)
        conf = 0.70
        expl = f"PP% domicile = {f.home_pp_pct:.1f}% → {int(prob*100)}% de marquer en avantage numérique."

    elif market == "clean_sheet":
        # P(away team scores 0) = Poisson CDF at k=0
        prob = clamp(math.exp(-lam_away), 0.03, 0.45)
        conf = 0.80
        expl = f"Poisson P(ext marque 0 | λ={lam_away:.1f}) = {int(prob*100)}%."

    elif market == "team_score_every_period":
        # P(score in all 3 periods) = P(score P1) × P(score P2) × P(score P3)
        p_per_period = 1.0 - math.exp(-lam_home / 3.0)
        prob = clamp(p_per_period ** 3, 0.04, 0.55)
        conf = 0.75
        expl = f"P(marquer en P1∩P2∩P3) = {p_per_period:.2f}³ = {int(prob*100)}%."

    elif market == "total_penalties":
        prob = 0.52
        conf = 0.52
        expl = "Pénalités difficiles à modéliser → ~52% (proche du hasard)."

    else:
        # Unknown market: fall back to base moneyline
        prob = base_prob
        conf = 0.68
        expl = f"{model_label}: {int(prob*100)}% (marché '{market}' → signal moneyline)."

    return clamp(prob, 0.05, 0.95), conf, expl


def _build_score_distribution(feat_values: dict, home_elo: float,
                              away_elo: float) -> "ScoreDistribution | None":
    """Construit la distribution de score du match à partir de `feat_values`.

    Le modèle est entraîné sur des lignes « équipe-match » : on l'interroge donc
    deux fois, une fois par équipe, en inversant les rôles attaque/défense.

    Les noms de features sont lus depuis `score_report.json` plutôt que codés en
    dur : le vecteur d'entrée reste ainsi aligné sur ce qui a réellement été
    entraîné, même si la liste change. Toute feature introuvable reste NaN —
    XGBoost la gère nativement.
    """
    if _xgb_score is None or not _SCORE_FEAT_NAMES:
        return None

    def row_for(atk: str, dfn: str, is_home: float, elo_signed: float) -> list[float]:
        out = []
        for name in _SCORE_FEAT_NAMES:
            if name == "is_home":
                out.append(is_home)
            elif name == "elo_atk_minus_def":
                out.append(elo_signed)
            elif name.startswith("atk_"):
                v = feat_values.get(f"{atk}_{name[4:]}")
                out.append(float(v) if isinstance(v, (int, float)) and v == v else np.nan)
            elif name.startswith("def_"):
                v = feat_values.get(f"{dfn}_{name[4:]}")
                out.append(float(v) if isinstance(v, (int, float)) and v == v else np.nan)
            else:
                v = feat_values.get(name)
                out.append(float(v) if isinstance(v, (int, float)) and v == v else np.nan)
        return out

    try:
        rows = np.array([
            row_for("home", "away", 1.0, home_elo - away_elo),
            row_for("away", "home", 0.0, away_elo - home_elo),
        ], dtype=np.float32)
        dmat = xgb.DMatrix(rows, feature_names=_SCORE_FEAT_NAMES, missing=np.nan)
        lam = _xgb_score.predict(dmat)
        lam_h, lam_a = float(lam[0]), float(lam[1])
        # Garde-fou : une intensité aberrante trahit un vecteur mal rempli.
        # Mieux vaut retomber sur l'heuristique que servir un prix absurde.
        if not (0.5 <= lam_h <= 8.0 and 0.5 <= lam_a <= 8.0):
            return None
        dist = ScoreDistribution(lam_h, lam_a, _score_p_ot, _score_tau)
        dist._dmatrix = dmat          # réutilisé par l'ensemble, cf. ci-dessous
        return dist
    except Exception as e:
        print(f"[ML] ⚠️  modèle de score indisponible pour ce match : {e}")
        return None


def _build_score_ensemble(dist: "ScoreDistribution | None") -> "ScoreEnsemble | None":
    """Rejoue les mêmes features sur les K membres bootstrap → dispersion.

    On réutilise la DMatrix déjà construite pour le modèle principal : σ doit
    mesurer le désaccord entre membres sur un vecteur d'entrée IDENTIQUE, sinon
    on mélangerait l'incertitude du modèle avec un écart de construction des
    features. Les membres aberrants sont écartés plutôt que de tirer σ vers le
    haut artificiellement.
    """
    if dist is None or not _score_members or _score_sigma_max is None:
        return None
    dmat = getattr(dist, "_dmatrix", None)
    if dmat is None:
        return None
    try:
        lambdas = []
        for mdl in _score_members:
            lam = mdl.predict(dmat)
            lh, la = float(lam[0]), float(lam[1])
            if 0.5 <= lh <= 8.0 and 0.5 <= la <= 8.0:
                lambdas.append((lh, la))
        if len(lambdas) < 2:
            return None
        return ScoreEnsemble(lambdas, _score_p_ot, _score_tau, point=dist)
    except Exception as e:
        print(f"[ML] ⚠️  ensemble indisponible pour ce match : {e}")
        return None


@app.post("/predict/game", response_model=MLResponse, dependencies=_PROTECTED)
def predict_game(f: GameFeatures) -> MLResponse:
    # 1. Corriger les valeurs manquantes (0 = pas de données NHL API)
    if f.home_pk_pct < 50: f.home_pk_pct = 80.0
    if f.away_pk_pct < 50: f.away_pk_pct = 80.0
    if f.home_pp_pct == 0: f.home_pp_pct = 20.0
    if f.away_pp_pct == 0: f.away_pp_pct = 20.0

    # 2. Features dérivées
    win_diff  = f.home_win_pct - f.away_win_pct
    gf_diff   = f.home_goals_for_pg - f.away_goals_for_pg
    ga_diff   = f.away_goals_against_pg - f.home_goals_against_pg
    form_diff = f.home_last10_win_pct - f.away_last10_win_pct
    pp_diff   = f.home_pp_pct - f.away_pp_pct
    pk_diff   = f.home_pk_pct - f.away_pk_pct
    lam_home  = f.home_goals_for_pg
    lam_away  = f.away_goals_for_pg

    # ELO : override explicite > lookup par abréviation > rating neutre
    def _resolve_elo(explicit: float | None, team: str | None) -> float:
        if explicit is not None:
            return explicit
        if team and team.upper() in _elo_ratings:
            return _elo_ratings[team.upper()]
        return _elo_base

    home_elo = _resolve_elo(f.home_elo, f.home_team)
    away_elo = _resolve_elo(f.away_elo, f.away_team)
    elo_expected = 1.0 / (1.0 + 10 ** (-((home_elo + _elo_home_adv) - away_elo) / 400.0))

    # Dict nom → valeur : les vecteurs sont construits d'après les noms de
    # features du modèle chargé (training_report.json) → jamais de désalignement
    feat_values = {
        **f.model_dump(exclude={"market_type", "line", "home_team", "away_team",
                                "home_elo", "away_elo", "home_odds_decimal",
                                "away_odds_decimal", "total_line_market",
                                "home_goalie", "away_goalie",
                                "home_stars_missing", "away_stars_missing",
                                "home_scratches", "away_scratches"}),
        "home_elo":     home_elo,
        "away_elo":     away_elo,
        "elo_diff":     home_elo - away_elo,
        "elo_expected": elo_expected,
        "win_pct_diff": win_diff,
        "gf_diff":      gf_diff,
        "ga_diff":      ga_diff,
        "pp_diff":      pp_diff,
        "pk_diff":      pk_diff,
        "form_diff":    form_diff,
        "shots_diff":   (f.home_shots_for_pg - f.home_shots_against_pg)
                      - (f.away_shots_for_pg - f.away_shots_against_pg),
        "faceoff_diff": f.home_faceoff_pct - f.away_faceoff_pct,
        "rest_diff":    f.home_rest_days   - f.away_rest_days,
        "streak_diff":  f.home_streak      - f.away_streak,
        # ── v5 — diffs voyage/calendrier (mêmes formules que build_dataset.py)
        "distance_km_diff":   f.home_distance_km   - f.away_distance_km,
        "tz_shift_diff":      f.home_tz_shift      - f.away_tz_shift,
        "days_away_diff":     f.home_days_away     - f.away_days_away,
        "alt_gain_diff":      f.home_alt_gain      - f.away_alt_gain,
        "road_trip_len_diff": f.home_road_trip_len - f.away_road_trip_len,
        "road_game_num_diff": f.home_road_game_num - f.away_road_game_num,
    }

    # ── v4 : features MoneyPuck/gardien/stars depuis inference_state.json ────
    # Les features inconnues restent NaN — XGBoost (missing=NaN) gère nativement.
    market_home_p: float | None = None
    if _inference_state:
        teams_st  = _inference_state.get("teams", {})
        goalie_st = _inference_state.get("goalies", {})
        stars_st  = _inference_state.get("stars", {})
        lineup_st = _inference_state.get("lineups", {})
        for side, team, goalie_name, stars_missing, scratches in [
            ("home", (f.home_team or "").upper(), f.home_goalie, f.home_stars_missing, f.home_scratches),
            ("away", (f.away_team or "").upper(), f.away_goalie, f.away_stars_missing, f.away_scratches),
        ]:
            for k, v in (teams_st.get(team) or {}).items():
                if isinstance(v, (int, float)):
                    feat_values[f"{side}_{k}"] = float(v)
            goalies = goalie_st.get(team) or []
            if goalies:
                # Gardien nommé si fourni, sinon mix pondéré par usage récent
                named = [g for g in goalies if goalie_name
                         and g["name"].lower() == goalie_name.lower()]
                if named:
                    g0 = named[0]
                    feat_values[f"{side}_goalie_gsax60"] = g0["gsax60"]
                    feat_values[f"{side}_goalie_svpct"]  = g0["svpct"]
                else:
                    tot = sum(g["recent_start_share"] for g in goalies) or 1.0
                    feat_values[f"{side}_goalie_gsax60"] = sum(
                        g["gsax60"] * g["recent_start_share"] for g in goalies) / tot
                    feat_values[f"{side}_goalie_svpct"] = sum(
                        g["svpct"] * g["recent_start_share"] for g in goalies) / tot
            st = stars_st.get(team) or {}
            scratch_set = {s.strip().lower() for s in (scratches or []) if s and s.strip()}
            if st.get("top5"):
                if scratch_set:
                    # Noms réels connus → on retire les BONS joueurs (pas "du haut")
                    present = [p["ppg"] for p in st["top5"]
                              if p["name"].strip().lower() not in scratch_set]
                    missing = len(st["top5"]) - len(present)
                else:
                    # Sans noms : legacy — on suppose que ce sont les meilleurs absents
                    missing = int(stars_missing or 0)
                    present = [p["ppg"] for p in st["top5"]][missing:]
                feat_values[f"{side}_star_power"] = float(sum(present[:3]))
                feat_values[f"{side}_stars_missing"] = float(missing)
            # Absence pondérée (perf + position/trio) — poids pré-calculés côté build
            keys = st.get("keys") or []
            if keys:
                feat_values[f"{side}_stars_out_weight"] = float(
                    sum(k["w"] for k in keys if k["name"].strip().lower() in scratch_set))

            # ── Projection bottom-up de l'alignement (P3) ────────────────────
            # Somme des contributions xG des patineurs effectivement disponibles.
            # Chaque absent retire exactement sa propre contribution, pondérée par
            # son temps de glace habituel — là où `stars_missing` ne comptait que
            # des têtes parmi un top-5 figé.
            roster = lineup_st.get(team) or []
            if roster:
                avail = [p for p in roster
                         if p.get("name", "").strip().lower() not in scratch_set]
                # Une équipe NHL habille 18 patineurs (12 attaquants, 6 défenseurs).
                # L'effectif stocké est plus profond pour absorber les absences ;
                # sommer tout le monde gonflerait la projection bien au-delà de
                # l'échelle vue à l'entraînement.
                #
                # Le tri se fait par TEMPS DE GLACE : c'est le proxy du rôle, et
                # c'est ainsi qu'un entraîneur compose son alignement. Trier par xG
                # reviendrait à habiller 18 marqueurs et surestimerait la
                # projection de ~19 %.
                dressed = sorted(avail, key=lambda p: -p.get("toi", 0.0))[:_LINEUP_DRESSED]
                feat_values[f"{side}_lineup_xg"] = float(
                    sum(p.get("xg", 0.0) for p in dressed))
                feat_values[f"{side}_lineup_pts"] = float(
                    sum(p.get("pts", 0.0) for p in dressed))
                feat_values[f"{side}_lineup_size"] = float(len(dressed))
        # Diffs v4 (mêmes formules que build_dataset.py)
        def _d(name):
            h, a = feat_values.get(f"home_{name}"), feat_values.get(f"away_{name}")
            if h is not None and a is not None:
                feat_values[f"{name}_diff"] = h - a
        for name in ("ev_xgf_pct_s", "ev_cf_pct_s", "ev_xgf_pct_l", "ev_cf_pct_l",
                     "goalie_gsax60", "goalie_svpct",
                     "star_power", "finishing_s", "win_s", "rest_days",
                     "b2b", "3in4"):
            _d(name)
        if feat_values.get("home_xgf60_s") is not None and \
           feat_values.get("away_xga60_s") is not None:
            feat_values["xg_matchup_home"] = feat_values["home_xgf60_s"] - feat_values["away_xga60_s"]
            feat_values["xg_matchup_away"] = feat_values["away_xgf60_s"] - feat_values["home_xga60_s"]
            feat_values["xg_matchup_diff"] = feat_values["xg_matchup_home"] \
                                           - feat_values["xg_matchup_away"]
        if "home_stars_missing" in feat_values or "away_stars_missing" in feat_values:
            feat_values["stars_missing_diff"] = feat_values.get("home_stars_missing", 0.0) \
                                              - feat_values.get("away_stars_missing", 0.0)
        if "home_stars_out_weight" in feat_values or "away_stars_out_weight" in feat_values:
            feat_values["stars_out_weight_diff"] = feat_values.get("home_stars_out_weight", 0.0) \
                                                 - feat_values.get("away_stars_out_weight", 0.0)

    # ── v4 : cotes du marché (probabilité implicite dévigée) ─────────────────
    if f.home_odds_decimal and f.away_odds_decimal:
        inv_h, inv_a = 1.0 / f.home_odds_decimal, 1.0 / f.away_odds_decimal
        market_home_p = inv_h / (inv_h + inv_a)
        feat_values["market_home_p_close"] = market_home_p
        feat_values["market_home_p_open"]  = market_home_p
    if f.total_line_market is not None:
        feat_values["total_close"] = f.total_line_market
        feat_values["total_open"]  = f.total_line_market

    # 3. Obtenir base_prob (P(home wins)) depuis XGBoost ou LR
    fi_list: list[FeatureImportance] = []
    model_type    = "Logistic Regression (fallback)"
    model_version = "lr-nhl-v1.1"

    if _xgb_game is not None:
        def _fv(n):
            v = feat_values.get(n)
            return float(v) if v is not None and v == v else np.nan
        row = np.array([[_fv(n) for n in _GAME_FEAT_NAMES]], dtype=np.float32)
        dmat = xgb.DMatrix(row, feature_names=_GAME_FEAT_NAMES, missing=np.nan)
        raw_prob  = float(_xgb_game.predict(dmat)[0])
        base_prob = raw_prob
        eps = 1e-7
        # Blend modèle ⊕ marché (si cotes fournies + blend entraîné) —
        # sinon calibration de Platt (rend les probabilités fiables pour l'EV)
        if _blend_w is not None and market_home_p is not None:
            zm = math.log(min(max(raw_prob, eps), 1 - eps) / (1 - min(max(raw_prob, eps), 1 - eps)))
            zk = math.log(market_home_p / (1 - market_home_p))
            base_prob = 1.0 / (1.0 + math.exp(-(_blend_w[0] * zm + _blend_w[1] * zk + _blend_w[2])))
            model_type    = "XGBoost ⊕ marché (blend)"
        elif _platt_a is not None and _platt_b is not None:
            p = min(max(base_prob, eps), 1 - eps)
            z = math.log(p / (1 - p))
            base_prob = 1.0 / (1.0 + math.exp(-(_platt_a * z + _platt_b)))
            model_type = "XGBoost (trained)"
        else:
            model_type = "XGBoost (trained)"
        model_version = "xgb-nhl-v4.0"
        for fi in (_game_importances[:6] if _game_importances else []):
            name = fi["name"]
            if "win" in name or "form" in name:
                direction = "positive" if win_diff > 0 else "negative"
            elif "gf" in name or "goals_for" in name:
                direction = "positive" if gf_diff > 0 else "negative"
            elif "ga" in name or "goals_against" in name:
                direction = "positive" if ga_diff > 0 else "negative"
            else:
                direction = "positive"
            fi_list.append(FeatureImportance(name=name, importance=fi["importance"], direction=direction))
    else:
        base_prob, _ = _game_moneyline(f)
        fi_list = sorted([
            FeatureImportance(name="Win% difference",    importance=round(abs(win_diff  * GAME_WEIGHTS["win_pct_diff"]), 3), direction="positive" if win_diff  > 0 else "negative"),
            FeatureImportance(name="Recent form (L10)",  importance=round(abs(form_diff * GAME_WEIGHTS["form_diff"]),    3), direction="positive" if form_diff > 0 else "negative"),
            FeatureImportance(name="Goals for/game",     importance=round(abs(gf_diff   * GAME_WEIGHTS["gf_diff"]),      3), direction="positive" if gf_diff   > 0 else "negative"),
            FeatureImportance(name="Goals against/game", importance=round(abs(ga_diff   * GAME_WEIGHTS["ga_diff"]),      3), direction="positive" if ga_diff   > 0 else "negative"),
            FeatureImportance(name="Power play %",       importance=round(abs(pp_diff   * GAME_WEIGHTS["pp_diff"]),      3), direction="positive" if pp_diff   > 0 else "negative"),
            FeatureImportance(name="Home ice",           importance=round(GAME_WEIGHTS["intercept"],                     3), direction="positive"),
        ], key=lambda x: x.importance, reverse=True)

    # 4. Appliquer la transformation propre au marché
    #    Le modèle de score price exactement les marchés dérivables ; les autres
    #    gardent les heuristiques. `None` = repli intégral sur l'existant.
    score_dist = _build_score_distribution(feat_values, home_elo, away_elo)
    prob, conf_mult, explanation = _apply_market(
        f.market_type, base_prob, f, win_diff, lam_home, lam_away, model_type,
        dist=score_dist,
    )
    if score_dist is not None:
        model_type = f"{model_type} + modèle de score"

    # 5. Incertitude d'estimation (P4) — σ sur le marché effectivement servi
    prob_std = uncertainty = None
    ens = _build_score_ensemble(score_dist)
    market_fn = _score_market_fn(f.market_type, f) if ens is not None else None
    if ens is not None and market_fn is not None:
        _, sd = ens.spread(market_fn)
        if np.isfinite(sd):
            prob_std = round(sd * 100.0, 2)      # en points de pourcentage
            uncertainty = round(min(1.0, sd / _score_sigma_max), 4)

    # 6. Confidence = signal des features × multiplicateur du marché
    #    Volontairement inchangé : ce champ est consommé par le backend
    #    (mlApiClient.ts, entier 40–95) et le rescaler sur σ changerait le
    #    comportement de tri des paris sans qu'on ait mesuré l'effet. σ est
    #    exposée à part, dans `probability_std` / `uncertainty`.
    magnitude  = abs(win_diff) * 2 + abs(gf_diff) / 3 + abs(form_diff)
    base_conf  = clamp(0.55 + magnitude * 0.25, 0.45, 0.92)
    confidence = int(clamp(base_conf * conf_mult, 0.38, 0.90) * 100)

    return MLResponse(
        probability=int(prob * 100),
        confidence=confidence,
        feature_importances=fi_list[:5],
        model_version=model_version,
        model_type=model_type,
        explanation=explanation,
        probability_std=prob_std,
        uncertainty=uncertainty,
    )

# ── Player prop model ─────────────────────────────────────────────────────────

@app.post("/predict/player", response_model=MLResponse, dependencies=_PROTECTED)
def predict_player(f: PlayerPropFeatures) -> MLResponse:
    rate_map = {
        "goals":    f.goals_per_game,
        "assists":  f.assists_per_game,
        "points":   f.points_per_game,
        "shots":    f.shots_per_game,
        "pp_point": f.goals_per_game * 0.35,   # rough PP-point proxy
        # Physical / goalie props — rate injected via shots_per_game by Node.js
        "hits":     f.shots_per_game,
        "blocks":   f.shots_per_game,
        "pim":      f.shots_per_game,
        "saves":    f.shots_per_game,
        "wins":     f.shots_per_game,
        "shutouts": f.shots_per_game,
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

@app.post("/predict/team", response_model=MLResponse, dependencies=_PROTECTED)
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
            # Les totaux sont pricés depuis la distribution du modèle de score
            # (S2 a retiré totals_model.json) ; sans lui, heuristique déclarée.
            "totals": "Modèle de score (Poisson empilé)" if _xgb_score is not None else "Poisson (fallback)",
            "player": "Poisson Distribution",
            "team":   "Bayesian Prior",
        },
        "trained_models_loaded": {
            "game_model":   _xgb_game   is not None,
            "score_model":  _xgb_score  is not None,
        },
        "uncertainty": {
            "ensemble_members": len(_score_members),
            "sigma_max":        _score_sigma_max,
        },
        "elo_teams_loaded": len(_elo_ratings),
        "calibrated":       _platt_a is not None,
        "tip": "Lance fetch_data.py puis train.py pour activer XGBoost (models/*.json).",
    }

@app.get("/health/ready")
def health_ready(response: Response):
    """Readiness probe — 200 once model-load has completed, 503 while starting.

    Liveness stays on /health (process is up). Readiness gates traffic on init
    so the LB/orchestrator holds requests until the service can actually serve.
    """
    if not _startup_complete:
        response.status_code = 503
        return {"status": "starting"}
    return {
        "status": "ready",
        "trained_models_loaded": {
            "game_model":   _xgb_game   is not None,
            "score_model":  _xgb_score  is not None,
        },
    }

@app.get("/features", dependencies=_PROTECTED)
def features():
    return {
        "game_features":   GameFeatures.model_json_schema(),
        "player_features": PlayerPropFeatures.model_json_schema(),
        "team_features":   TeamFuturesFeatures.model_json_schema(),
    }


# ── Rapports d'entraînement et de backtest ────────────────────────────────────
#
# POURQUOI ICI ET PAS CÔTÉ NODE — les rapports vivent dans MODELS_DIR, qui
# n'existe QUE dans cette image (le Dockerfile fait `COPY models ./models`). Le
# backend Node tourne dans un autre conteneur : un `fs.readFile('../ml/models')`
# y marcherait en local et renverrait ENOENT en production, c'est-à-dire
# exactement le genre de panne qui ne se voit qu'une fois déployée. Le service
# qui possède les fichiers est le seul à pouvoir les servir.
#
# Lecture seule, protégée par le même token que /features : ces chiffres
# décrivent la performance du modèle et n'ont rien à faire en public.
#
# Le poids compte : `inference_state.json` (165 ko), `score_ablation_cache.json`
# (112 ko) et les deux modèles XGBoost (0,8 Mo et 0,5 Mo) ne sont JAMAIS
# renvoyés entiers — seuls leur `as_of`, leurs compteurs et leur date de fichier
# le sont. La charge utile reste sous ~25 ko, donc rafraîchissable à la main
# sans y penser.

# Fichiers renvoyés intégralement : tous petits (< 10 ko) et entièrement utiles.
_REPORT_FILES = (
    "training_report",
    "score_report",
    "backtest_walkforward_report",
    "backtest_derived_report",
    "backtest_uncertainty_report",
    "feature_importance_game",
    "score_feature_selection",
)

# Fichiers dont on ne veut QUE la fraîcheur et la taille (trop gros à renvoyer).
_ARTIFACT_FILES = (
    "game_model",
    "score_model",
    "inference_state",
    "score_ablation_cache",
    "fold_params_cache",
)


def _file_meta(name: str) -> dict:
    """Âge et taille d'un artefact, sans le lire. `None` s'il manque."""
    path = os.path.join(MODELS_DIR, f"{name}.json")
    if not os.path.exists(path):
        return {"present": False, "modified_at": None, "bytes": None}
    st = os.stat(path)
    return {
        "present": True,
        # UTC explicite : le conteneur tourne en UTC, le navigateur non. Sans le
        # 'Z', le client parserait l'horodatage comme une heure locale et
        # afficherait un modèle « entraîné dans 5 heures ».
        "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
                               .isoformat().replace("+00:00", "Z"),
        "bytes": st.st_size,
    }


@app.get("/reports", dependencies=_PROTECTED)
def reports():
    loaded: dict = {}
    errors: dict = {}

    for name in _REPORT_FILES:
        path = os.path.join(MODELS_DIR, f"{name}.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                loaded[name] = json.load(f)
        except Exception as e:  # fichier tronqué / JSON invalide
            # On n'échoue pas la requête entière pour un rapport illisible :
            # le but du dashboard est justement de rendre ce genre d'incident
            # visible, pas de renvoyer un 500 opaque.
            errors[name] = str(e)

    # `training_report.game_model.feature_importances` peut être long ; on garde
    # les 25 premières (déjà triées par le script d'entraînement), le reste
    # n'est pas lisible dans un graphe de toute façon.
    gm = (loaded.get("training_report") or {}).get("game_model")
    if isinstance(gm, dict) and isinstance(gm.get("feature_importances"), list):
        gm["feature_importances"] = gm["feature_importances"][:25]

    # L'ensemble de score : présence + nombre de membres, pas les fichiers.
    ens_dir = os.path.join(MODELS_DIR, "score_ensemble")
    ensemble_members = (
        len([f for f in os.listdir(ens_dir) if f.endswith(".json")])
        if os.path.isdir(ens_dir) else 0
    )

    return {
        "models_dir": MODELS_DIR,
        "reports": loaded,
        "report_errors": errors,
        # Fraîcheur : à quand remonte le dernier entraînement, le dernier
        # rafraîchissement de l'état d'inférence ? C'est la question qui dit si
        # le pipeline est vivant, et aucun rapport ne la porte.
        "artifacts": {
            name: _file_meta(name) for name in (*_REPORT_FILES, *_ARTIFACT_FILES)
        },
        "runtime": {
            # Ce que le service a RÉELLEMENT chargé en mémoire — à comparer aux
            # fichiers présents sur disque. Les deux divergent quand un modèle a
            # été déposé après le démarrage du process : le disque dit « à
            # jour », l'inférence sert encore l'ancien.
            "game_model_loaded":  _xgb_game  is not None,
            "score_model_loaded": _xgb_score is not None,
            "calibrated":         _platt_a is not None,
            "blend_weights":      _blend_w,
            "elo_teams":          len(_elo_ratings),
            "inference_state_as_of": (_inference_state or {}).get("as_of"),
            "inference_state_teams": len((_inference_state or {}).get("teams", {})),
            "score_ensemble_members_loaded": len(_score_members),
            "score_ensemble_files_on_disk":  ensemble_members,
            "sigma_max": _score_sigma_max,
        },
    }


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("ml_service:app", host="0.0.0.0", port=8000, reload=True)
