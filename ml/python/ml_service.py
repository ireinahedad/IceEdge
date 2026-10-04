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
import copy
import re
import hmac
import unicodedata
import json
import math
import os
from datetime import datetime, timezone
from typing import List, Optional

import numpy as np
import xgboost as xgb
from score_model import (P_OT_HOME, ScoreDistribution, ScoreEnsemble,
                         lambdas_for_home_win, p_ot_for, read_level_layer, read_ot_model)
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
# La sonde imprime SA REUSSITE, pas seulement ses echecs : sans elle, une DSN mal
# collee et une DSN absente se ressemblent — les deux ne disent rien. Et l'import
# est protege : le monitoring ne doit jamais empecher de demarrer le service qu'il
# surveille (sans ce garde-fou, poser SENTRY_DSN sur une image ou sentry-sdk
# manquerait tuerait le process au lieu de le laisser tourner sans Sentry).
if _SENTRY_DSN:
    _default_rate = "0.01" if _ENVIRONMENT == "production" else "0.1"
    _rate_raw = os.environ.get("SENTRY_TRACES_SAMPLE_RATE", _default_rate)
    try:
        _rate = float(_rate_raw)
    except (TypeError, ValueError):
        _rate = float(_default_rate)
        print(f"[ML] ⚠️  SENTRY_TRACES_SAMPLE_RATE={_rate_raw!r} illisible — "
              f"repli sur {_rate}")
    try:
        import sentry_sdk
        sentry_sdk.init(
            dsn=_SENTRY_DSN,
            traces_sample_rate=_rate,
            environment=_ENVIRONMENT,
        )
        print(f"[ML] ✅ Sentry armé — environment={_ENVIRONMENT}, "
              f"traces_sample_rate={_rate}")
    except Exception as e:
        print(f"[ML] ⚠️  Sentry non armé : {e} — le service démarre sans")
else:
    print("[ML] ℹ️  Sentry inactif — SENTRY_DSN non définie")

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
# Remplaçant du scalaire ci-dessus : [pente, ordonnée] d'une logistique sur
# (λ_dom − λ_ext). None → on sert le scalaire, comportement d'avant.
_score_p_ot_model: list[float] | None = None
# Déciles de |λ_dom − λ_ext| mesurés à l'entraînement (S4 ③). None = pas de
# calibration lisible dans le rapport → l'ancienne heuristique de confiance.
_score_conf_deciles: list[float] | None = None

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


# Features de cote du classifieur — mises à NaN pour sa version « seule »
# (`probability_classifier`). Même liste que `train.py:ODDS_FEATURES`.
_ODDS_FEATURES = {"market_home_p_open", "market_home_p_close"}


def _platt(p_raw: float) -> float:
    """Calibration de Platt du classifieur (identité si elle manque)."""
    if _platt_a is None or _platt_b is None:
        return p_raw
    p = min(max(p_raw, 1e-7), 1 - 1e-7)
    return 1.0 / (1.0 + math.exp(-(_platt_a * math.log(p / (1 - p)) + _platt_b)))


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


# ⚠️ CE BLOC DOIT RESTER AU-DESSUS DE `_try_load_models()`.
# Ce dernier est appelé au CHARGEMENT DU MODULE (plus bas, hors de toute
# fonction) et appelle `_read_confidence_deciles`. Défini plus bas, le nom
# n'existe pas encore à ce moment : `NameError`, avalé par le `except` du
# chargeur, qui rend alors « score_model.json : name ... is not defined » et
# désactive tout le modèle de score en silence. Vécu le 2026-08-25.
# ── S4 ③ — jauge de confiance calibrée sur |λ_dom − λ_ext| ──────────────────
#
# CE QUE CE CHAMP EST, ET N'EST PAS. `confidence` (entier 40-95) est un élément
# d'AFFICHAGE : il colore la jauge de `MLPredictionCard` (seuils 55/75) et rien
# d'autre. Vérifié le 2026-08-25 côté serveur — `bestBets.service` calcule son
# propre libellé de confiance à partir de la PROBABILITÉ (`confidenceFor(pct)`)
# et `mlScore()` ne lit que `res.probability` ; `ml.routes.ts` fait de même sur
# sa route « single ». Aucun tri, aucun filtre, aucun seuil de mise ne dépend de
# ce champ. C'est ce qui rend ce changement sûr.
#
# CE QUI CHANGE. La force du signal venait de
# `|win_diff|·2 + |gf_diff|/3 + |form_diff|` — trois écarts de statistiques
# d'équipe sans rapport avec le modèle qui produit réellement la probabilité
# affichée. On prend désormais l'écart entre les deux intensités du modèle de
# score : la façon dont il dit lui-même si l'affiche est tranchée.
#
# POURQUOI UN RANG ET PAS UN SEUIL. Un seuil posé au jugé sur |Δλ| ferait sauter
# la jauge et deviendrait faux au moindre changement d'échelle du modèle. On
# place donc le match à son RANG dans la distribution mesurée à l'entraînement
# (déciles dans `score_report.json`, interpolés entre eux) : un écart médian
# donne une confiance médiane, par construction, quel que soit le modèle.
#
# CE QUI NE CHANGE PAS. Les bornes. `base_conf` couvre exactement le même
# [0.45, 0.92] qu'avant, le multiplicateur de marché s'applique après comme
# avant, et le clamp final reste [0.38, 0.90]. Seule la SOURCE du signal change.
# Sans calibration lisible dans le rapport, ou sans modèle de score pour ce
# match, l'ancienne formule reprend la main telle quelle.

_CONF_MIN, _CONF_MAX = 0.45, 0.92
_CONF_DECILE_RANKS = tuple(i / 10 for i in range(11))


def _read_confidence_deciles(rep: dict) -> list[float] | None:
    """Déciles de |λ_dom − λ_ext| lus dans `score_report.json`, ou None.

    Tout est vérifié plutôt que supposé — le rapport peut venir d'un
    entraînement antérieur à S4 ③, ou d'une version future : signal attendu,
    longueur, convertibilité, stricte croissance (sans laquelle l'interpolation
    serait ambiguë). Au moindre doute on rend None, et la jauge garde son
    ancien comportement au lieu de se coller à une valeur.
    """
    cal = rep.get("confidence")
    if not isinstance(cal, dict) or cal.get("signal") != "abs_lambda_diff":
        return None
    raw = cal.get("deciles")
    if not isinstance(raw, list) or len(raw) != len(_CONF_DECILE_RANKS):
        return None
    try:
        q = [float(v) for v in raw]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in q):
        return None
    if not all(b > a for a, b in zip(q, q[1:])):
        return None
    return q


# ── S4 — prolongation dépendante de l'affiche ───────────────────────────────
#
# `p_home_win = p_reg + p_tie × p_ot_home`. Le troisième facteur était une
# CONSTANTE : un gros favori qui va en prolongation était traité comme un pile
# ou face. Mesuré le 2026-08-26 sur les 951 prolongations de la tranche de test
# — favori ≥ 0.65 selon le modèle : 61.7 % de victoires en prolongation
# (n = 149, IC 95 % [0.537 ; 0.692]), la constante 0.4996 est hors de l'IC.
# `python backtest.py --reliability` rejoue la mesure.
#
# ⚠️ Ça ne corrige qu'une PART de la compression des queues (~2 points sur 9.5) :
# le reste vient de la distribution elle-même. Cf. `REFACTOR_PLAN.md` §S4.
#
# Comme pour ③, tout est vérifié plutôt que supposé : un rapport antérieur à ce
# changement n'a pas la clé, un rapport futur peut avoir un autre signal.

def _p_ot_for(lam_home: float, lam_away: float) -> float:
    """P(le domicile gagne la prolongation) pour CE match — scalaire si pas de modèle.

    Le calcul lui-même est dans `score_model`, partagé avec `train_score` et
    `backtest.py --reliability` : les trois doivent appliquer exactement la même
    formule, sans quoi la mesure ne décrirait pas le service.
    """
    return p_ot_for(_score_p_ot_model, lam_home, lam_away, _score_p_ot)


def _confidence_from_lambdas(dist: "ScoreDistribution | None") -> float | None:
    """Force du signal pour ce match, dans [_CONF_MIN, _CONF_MAX]. None = repli."""
    if dist is None or _score_conf_deciles is None:
        return None
    diff = abs(dist.lam_home - dist.lam_away)
    if not math.isfinite(diff):
        return None
    # `np.interp` borne aux extrémités : un écart hors de la plage observée à
    # l'entraînement reçoit le rang 0 ou 1, jamais une extrapolation.
    rank = float(np.interp(diff, _score_conf_deciles, _CONF_DECILE_RANKS))
    return _CONF_MIN + (_CONF_MAX - _CONF_MIN) * rank


# Part du écart à la moyenne qu'un rating ELO conserve d'une saison à l'autre.
#
# POURQUOI ELLE EXISTE. `elo_ratings.json` est produit par un script hors ligne
# et porte une date (`as_of_date`). Rien ne le régénère en cours de saison, et
# rien ne le corrigeait entre deux saisons : les notes finales de l'an dernier
# servaient telles quelles pour la suivante. Une équipe à 1600 restait à 1600
# en septembre, quels que soient les départs, les arrivées et les blessures.
#
# La pratique établie en Elo sportif est de ramener les notes vers la moyenne
# entre deux saisons : l'effectif a changé, une partie du signal ne vaut plus.
# Appliquée une fois par saison de retard, donc composée si le fichier a deux ans.
#
# LA MÊME RÉGRESSION QU'À L'ENTRAÎNEMENT. `build_dataset.add_elo` ramène chaque
# note de 30 % vers la moyenne entre deux saisons (`ELO_SEASON_REGRESS`) ; ce
# service en appliquait 1/3 (2/3 conservés) — le modèle aurait vu en octobre
# des notes plus resserrées que celles de son entraînement
# (ml/INCOHERENCES_ML.md §15). La valeur est désormais écrite par build_dataset
# dans `elo_ratings.json` (`season_regress`) et relue ici ; ce défaut ne sert
# qu'aux fichiers produits avant le 2026-10-03, et vaut la même chose.
#
# Ce n'est PAS un substitut à la régénération du fichier : c'est le garde-fou
# qui empêche des notes périmées d'être servies comme si elles étaient fraîches.
ELO_SEASON_REGRESS_DEFAULT = 0.30


def _season_start_year(d: "datetime | None" = None) -> int:
    """Année de début de la saison NHL contenant `d` (saison à cheval oct.–juin)."""
    d = d or datetime.now(timezone.utc)
    return d.year if d.month >= 8 else d.year - 1


def _seasons_elapsed_since(as_of_date: str) -> int:
    """Nombre de saisons complètes entre `as_of_date` (AAAA-MM-JJ) et aujourd'hui."""
    try:
        d = datetime.strptime(as_of_date[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return 0
    return max(0, _season_start_year() - _season_start_year(d))


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
            as_of         = str(elo.get("as_of_date") or "")
            seasons_old   = _seasons_elapsed_since(as_of)
            if seasons_old > 0 and _elo_ratings:
                regress = float(elo.get("season_regress", ELO_SEASON_REGRESS_DEFAULT))
                if not 0.0 <= regress < 1.0:
                    regress = ELO_SEASON_REGRESS_DEFAULT
                keep = (1.0 - regress) ** seasons_old
                _elo_ratings = {k: _elo_base + (v - _elo_base) * keep
                                for k, v in _elo_ratings.items()}
                spread = max(_elo_ratings.values()) - min(_elo_ratings.values())
                print(f"[ML] ✅ elo_ratings.json chargé ({len(_elo_ratings)} équipes, "
                      f"as of {as_of}) — {seasons_old} saison(s) de retard, "
                      f"régression vers {_elo_base:.0f} à {keep:.0%} "
                      f"(étendue ramenée à {spread:.0f} points)")
            else:
                print(f"[ML] ✅ elo_ratings.json chargé ({len(_elo_ratings)} équipes, "
                      f"as of {as_of or '?'})")
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
    global _score_conf_deciles, _score_p_ot_model
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
            _score_conf_deciles = _read_confidence_deciles(rep)
            _score_p_ot_model = read_ot_model(rep)
            if not _SCORE_FEAT_NAMES:
                raise ValueError("score_report.json sans liste de features")
            b = xgb.Booster()
            b.load_model(score_path)
            _xgb_score = b
            print(f"[ML] ✅ score_model.json chargé — {len(_SCORE_FEAT_NAMES)} features, "
                  f"τ sur {len(_score_tau)} écarts, P(dom en OT)={_score_p_ot:.4f}")
            # Dit à voix haute si la jauge de confiance est calibrée (S4 ③) ou
            # si elle reste sur l'ancienne heuristique : sans cette ligne, les
            # deux cas se ressemblent exactement au démarrage.
            # Dit à voix haute lequel des deux traitements de la prolongation
            # tourne : sans cette ligne les deux cas se ressemblent au démarrage.
            if _score_p_ot_model:
                a, b = _score_p_ot_model
                print(f"[ML] ✅ Prolongation dépendante de l'affiche — "
                      f"σ({a:+.4f}·Δλ {b:+.4f}), soit "
                      f"{_p_ot_for(4.0, 3.0):.3f} pour Δλ=1.0 contre "
                      f"{_score_p_ot:.3f} en constante")
            else:
                print(f"[ML] ℹ️  Prolongation : constante {_score_p_ot:.4f} "
                      "(relance train_score.py pour le remplaçant)")
            if _score_conf_deciles:
                print(f"[ML] ✅ Confiance calibrée sur |λ_dom − λ_ext| — "
                      f"médiane {_score_conf_deciles[5]:.3f}, "
                      f"étendue {_score_conf_deciles[0]:.3f}–{_score_conf_deciles[10]:.3f}")
            else:
                print("[ML] ℹ️  Pas de calibration de confiance dans le rapport — "
                      "ancienne heuristique (relance train_score.py pour l'obtenir)")
            _load_score_ensemble(rep)
        except Exception as e:
            _xgb_score, _SCORE_FEAT_NAMES, _score_tau = None, [], None
            _score_conf_deciles = None
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


# ── Modèle JOUEUR (train_player.py) ───────────────────────────────────────────
#
# Un booster `count:poisson` par statistique de patineur, et l'état de chaque
# joueur après son dernier match (`player_state.json`). Absents = le service
# ne renvoie simplement pas de cadences joueur, et Node garde sa règle.
_player_models: dict[str, "xgb.Booster"] = {}
_player_feats: list[str] = []
_player_k: dict[str, float | None] = {}
_player_state: dict = {}
_PLAYER_TEAM_COLS = ["gf_s", "ga_s", "xgf60_s", "xga60_s", "sog_f_s", "sog_a_s", "ev_xgf60_s",
                     "ev_xga60_s", "pp_xgf60_s", "pk_xga60_s", "goalie_svpct", "goalie_gsax60", "win_s"]


def _load_player_model() -> None:
    global _player_models, _player_feats, _player_k, _player_state
    rep_path = os.path.join(MODELS_DIR, "player_report.json")
    st_path = os.path.join(MODELS_DIR, "player_state.json")
    if not (os.path.exists(rep_path) and os.path.exists(st_path)):
        print("[ML] ℹ️  Pas de modèle joueur — lance : python train_player.py")
        return
    try:
        with open(rep_path) as fh:
            rep = json.load(fh)
        models = {}
        for stat in rep["stats"]:
            b = xgb.Booster()
            b.load_model(os.path.join(MODELS_DIR, "player", f"{stat}.json"))
            models[stat] = b
        with open(st_path) as fh:
            state = json.load(fh)
        _player_models, _player_feats, _player_state = models, list(rep["features"]), state
        # k « infini » (≥ 1e4) = Poisson : `None` côté API.
        _player_k = {s: (None if v["k"] >= 1e4 else float(v["k"])) for s, v in rep["stats"].items()}
        print(f"[ML] ✅ modèle joueur : {len(models)} stats, "
              f"{len(state.get('players', {}))} joueurs (état au {state.get('as_of')})")
    except Exception as e:
        _player_models, _player_feats, _player_k, _player_state = {}, [], {}, {}
        print(f"[ML] ⚠️  modèle joueur illisible : {e} — cadences joueur désactivées")


_load_player_model()


# ── Couche de correction du moneyline (2026-10-02) ───────────────────────────
#
# Une régression logistique posée SUR la victoire du modèle de score :
#     logit p' = c0 + c1·logit p + Σ coef_i · (x_i − moyenne_i) / écart-type_i
# avec x = b2b_diff, ev_xgf_pct_s/l_diff, lineup_xg_diff, star_power_diff,
# xg_matchup_diff, elo_diff — ce que le marché exploitait mieux que le modèle
# (`backtest_walkforward.py --market-gap`). Mesurée en walk-forward STRICT
# (`--correction`, ajustée sur les saisons passées seulement, 11 saisons) :
# log-loss moneyline −0,0021 (z −3,2, meilleure sur 10 saisons sur 11), écart à
# la cote de clôture ramené de +0,0014 à −0,0004. Critère fixé avant le run.
# Écrite par `--correction --write-layer` seulement si le verdict est ADOPTER.
#
# Elle ne touche QUE la victoire (marché `moneyline`). Puck line, totaux et le
# reste sortent de la distribution des buts, qu'elle ne modifie pas.
# Absente ou illisible → la victoire du modèle de score, comme avant.
_corr_layer: dict | None = None


def _load_correction_layer() -> None:
    global _corr_layer
    path = os.path.join(MODELS_DIR, "correction_layer.json")
    if not os.path.exists(path):
        print("[ML] ℹ️  Pas de couche de correction du moneyline")
        return
    try:
        with open(path, encoding="utf-8") as fh:
            layer = json.load(fh)
        n = len(layer["features"])
        if not (len(layer["mean"]) == len(layer["std"]) == len(layer["coef"]) == n):
            raise ValueError("dimensions incohérentes")
        if not all(math.isfinite(float(x)) for x in
                   [layer["intercept"], layer["coef_logit_p"], *layer["coef"], *layer["mean"], *layer["std"]]):
            raise ValueError("coefficients non finis")
        _corr_layer = layer
        print(f"[ML] ✅ Couche de correction du moneyline — {n} features, "
              f"logit p ×{float(layer['coef_logit_p']):.3f}")
    except Exception as e:
        _corr_layer = None
        print(f"[ML] ⚠️  correction_layer.json illisible : {e} — victoire du modèle de score servie")


def _apply_correction(p_home: float, feat_values: dict) -> float | None:
    """P(victoire domicile) corrigée, ou None sans couche. Une feature absente
    vaut sa moyenne (contribution nulle), comme à l'ajustement (NaN → 0)."""
    if _corr_layer is None or p_home is None:
        return None
    p = min(max(float(p_home), 1e-6), 1 - 1e-6)
    z = float(_corr_layer["intercept"]) + float(_corr_layer["coef_logit_p"]) * math.log(p / (1 - p))
    for name, mu, sd, c in zip(_corr_layer["features"], _corr_layer["mean"],
                               _corr_layer["std"], _corr_layer["coef"]):
        x = feat_values.get(name)
        if x is None or not math.isfinite(float(x)) or not sd:
            continue
        z += float(c) * (float(x) - float(mu)) / float(sd)
    return 1.0 / (1.0 + math.exp(-z))


_load_correction_layer()


def _align_distribution(dist: "ScoreDistribution | None",
                        p_home: float | None) -> "ScoreDistribution | None":
    """La distribution du match, recalée pour que sa victoire domicile vaille
    `p_home` (la victoire corrigée). None = pas de recalage possible.

    POURQUOI (ml/INCOHERENCES_ML.md §6). Servie seule sur le marché
    `moneyline`, la correction laissait tous les autres marchés sur la matrice
    non corrigée : « gagne en 60 min » + « gagne en prolongation » ≠ « gagne »,
    le score exact ne sommait plus à la victoire, et le direct mélangeait les
    deux. Ici la correction devient une distribution : même total d'intensités
    (les totaux de buts ne bougent pas), partage domicile/visiteur choisi pour
    que P(victoire domicile) — τ et prolongation compris — égale la cible.
    Tous les marchés se lisent ensuite sur la même matrice.

    Les contributions des features (`_dmatrix`) restent celles du modèle brut :
    la décomposition affichée explique λ avant correction.
    """
    if dist is None or p_home is None or not math.isfinite(float(p_home)):
        return None
    try:
        lh, la = lambdas_for_home_win(dist.lam_home + dist.lam_away, float(p_home),
                                      _p_ot_for, _score_tau)
        aligned = ScoreDistribution(lh, la, _p_ot_for(lh, la), _score_tau)
    except Exception as e:
        print(f"[ML] ⚠️  recalage sur la victoire corrigée impossible : {e}")
        return None
    aligned._dmatrix = getattr(dist, "_dmatrix", None)
    aligned.raw_lambdas = (dist.lam_home, dist.lam_away)
    return aligned


# ── Recalage de NIVEAU des buts dans la saison (2026-10-04) ──────────────────
#
# Le modèle de score surestimait le nombre de buts de ~4 % depuis 2022
# (buts réglementaires observés / λ = 0,955-0,969 en walk-forward). Mesuré par
# `measure_level.py` (rapport `level_report.json`, règle fixée avant le run) :
# un k par saison — rapport observés / prévus des matchs déjà joués, rétréci
# vers 1 avec n0 = 200 matchs fictifs — fait baisser la déviance du total de
# 0,0032 (z −3,2, 8 saisons sur 11) et ramène P(> 5,5) sur 2023-26 de 58,4 % à
# 55,8 % pour 56,0 % observé. ADOPTÉ.
#
# k est calculé chaque lundi par `refresh_data.py` et lu dans
# `level_layer.json` ; le contrat (formule, bornes, refus d'un fichier d'une
# autre saison) est `score_model.level_k` / `read_level_layer`. Il est relu à
# chaque match contre la saison du jour : un fichier d'avril servi en octobre
# vaut 1.
#
# Il multiplie le TOTAL λ_dom + λ_ext et garde P(victoire domicile) — couche de
# correction comprise — exactement : le moneyline servi ne bouge pas. Totaux,
# puck line, score exact, deux équipes marquent, périodes, direct (le paquet
# renvoie les λ recalés à Node) se lisent sur la matrice recalée. Les cadences
# joueur (modèle séparé) ne sont pas touchées.
_level_layer: dict | None = None


def _load_level_layer() -> None:
    global _level_layer
    path = os.path.join(MODELS_DIR, "level_layer.json")
    if not os.path.exists(path):
        print("[ML] ℹ️  Pas de recalage de niveau (level_layer.json absent) — k = 1")
        return
    try:
        with open(path, encoding="utf-8") as fh:
            _level_layer = json.load(fh)
        k = read_level_layer(_level_layer, _season_start_year())
        if k != 1.0:
            print(f"[ML] ✅ Recalage de niveau des buts — k = {k:.4f} "
                  f"({_level_layer.get('n_games')} matchs au {_level_layer.get('as_of')})")
        else:
            print(f"[ML] ℹ️  Recalage de niveau inactif (k = 1 : verdict "
                  f"{_level_layer.get('verdict')}, saison {_level_layer.get('season')}, "
                  f"{_level_layer.get('n_games')} matchs)")
    except Exception as e:
        _level_layer = None
        print(f"[ML] ⚠️  level_layer.json illisible : {e} — k = 1")


def _level_k_now() -> float:
    return read_level_layer(_level_layer, _season_start_year())


def _apply_level(dist: "ScoreDistribution | None") -> "ScoreDistribution | None":
    """La distribution recalée en niveau, ou None si rien à faire (k = 1,
    pas de distribution, recalage impossible)."""
    k = _level_k_now()
    if dist is None or k == 1.0:
        return None
    try:
        p_home = dist.p_home_win()
        lh, la = lambdas_for_home_win(k * (dist.lam_home + dist.lam_away), p_home,
                                      _p_ot_for, _score_tau)
        out = ScoreDistribution(lh, la, _p_ot_for(lh, la), _score_tau)
    except Exception as e:
        print(f"[ML] ⚠️  recalage de niveau impossible : {e}")
        return None
    out._dmatrix = getattr(dist, "_dmatrix", None)
    # `raw_lambdas` signale « la couche de correction est dans la matrice »
    # (explication du moneyline) : on le propage, on ne le crée pas.
    if hasattr(dist, "raw_lambdas"):
        out.raw_lambdas = dist.raw_lambdas
    out.level_k = k
    return out


_load_level_layer()

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

# Moyennes de ligue des unités spéciales — servies UNIQUEMENT quand le backend
# dit ne pas savoir (champ absent), jamais pour corriger une valeur mesurée.
LEAGUE_PP_PCT = 20.0
LEAGUE_PK_PCT = 80.0

# Avantages numériques obtenus par une équipe sur un match, en moyenne NHL.
# Même valeur que `predictionEngine.ts` et `nhlPredictions.ts`.
PP_OPPORTUNITIES = 3.1


class _NoEstimate(Exception):
    """Le service ne sait pas pricer ce marché avec ce qu'on lui a donné.

    C'est une réponse valide, pas un plantage : la route la traduit en 422 et
    le client affiche un état « indisponible ». Un chiffre faux qui a l'air
    juste est pire que pas de chiffre du tout — c'est la règle que
    `predictionApiService.ts` applique déjà côté client.
    """

    def __init__(self, market: str):
        super().__init__(f"no estimate available for market '{market}'")
        self.market = market


def poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


def poisson_over(line: float, lam: float) -> float:
    """P(X > line) — supports half-integer lines (e.g. 2.5)"""
    return 1.0 - poisson_cdf(math.floor(line), lam)

# ── Pydantic models ───────────────────────────────────────────────────────────

class FeatureImportance(BaseModel):
    name: str
    importance: float
    direction: str   # "positive" | "negative"

class MLResponse(BaseModel):
    probability: int                          # pour-cent entier (borné 2–98 ; 0–98 score exact)
    # La même probabilité, NON arrondie, en 0–1. `probability` est un entier
    # d'affichage : calculer un edge dessus ajoutait jusqu'à ±0,5 point
    # d'erreur, sur une règle de value bet large de 2 à 6 points
    # (ml/INCOHERENCES_ML.md §4). Tout calcul (edge, EV, cote minimale,
    # journal CLV) doit lire ce champ. Optionnel pour les anciens clients.
    probability_exact: Optional[float] = None
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
    # ── S4 ⑤ — les deux estimateurs de P(victoire domicile), côte à côte ─────
    #
    # POURQUOI. Depuis S4 ④, le moneyline servi vient du modèle de score, mais
    # le classifieur tourne toujours à chaque requête : son résultat était
    # simplement jeté. L'exposer ne coûte donc AUCUN calcul et rend visible,
    # match par match, l'écart entre les deux — la seule chose qui reste à
    # trancher avant de supprimer le classifieur (S4 ⑤, après le lancement).
    #
    # À NE PAS CONFONDRE AVEC `probability`, qui est la probabilité du MARCHÉ
    # demandé, après transformation. Ces deux champs-ci sont toujours
    # P(victoire domicile), donc directement comparables entre eux et à rien
    # d'autre.
    #
    # Optionnels : `probability_score_model` est absent si le modèle de score
    # n'a pas répondu pour ce match, `probability_classifier` si le classifieur
    # n'est pas chargé (auquel cas la base vient du repli logistique).
    probability_score_model: Optional[int] = None
    probability_classifier: Optional[int] = None

# ── Game features ─────────────────────────────────────────────────────────────

class GameFeatures(BaseModel):
    home_win_pct: float = Field(..., ge=0, le=1, description="Home team win % (0–1)")
    away_win_pct: float = Field(..., ge=0, le=1)
    home_goals_for_pg: float = Field(3.0, ge=0)
    away_goals_for_pg: float = Field(3.0, ge=0)
    home_goals_against_pg: float = Field(3.0, ge=0)
    away_goals_against_pg: float = Field(3.0, ge=0)
    # `None` = le backend n'a AUCUNE donnée. Une valeur, même très basse, est
    # une mesure et doit être prise telle quelle.
    #
    # Ces champs étaient des flottants par défaut (20 / 80) et le service
    # réécrivait ensuite « tout PK sous 50 % » en 80 %. Comme le backend
    # remplissait DÉJÀ 20/80 quand il ne savait pas, ce seuil ne pouvait plus
    # frapper que des valeurs réelles : une équipe à 1 pénalité tuée sur 3 en
    # octobre (33 %) se retrouvait promue à la moyenne de ligue, en silence.
    home_pp_pct: Optional[float] = Field(None, ge=0, le=100)   # power play %
    away_pp_pct: Optional[float] = Field(None, ge=0, le=100)
    home_pk_pct: Optional[float] = Field(None, ge=0, le=100)   # penalty kill %
    away_pk_pct: Optional[float] = Field(None, ge=0, le=100)
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
    #    ⚠️ AUCUN modèle entraîné ne lit ces champs (ni le modèle de score, ni
    #    le classifieur, ni le modèle joueur) : ils sont acceptés pour
    #    compatibilité, sans effet sur les probabilités. Le serveur ne les
    #    calcule plus par défaut (`includeTravel`).
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
    # Côté d'un marché BINAIRE servi sous un seul `market_type` : "yes" | "no".
    # Le service price toujours le côté « oui » ; `_is_negative_side` prend le
    # complément quand ce champ dit « non ». Sans ce champ, les deux tuiles d'un
    # marché Oui/Non recevaient le MÊME pourcentage — c'est le bug BTTS
    # 90 % / 90 % (Blues–Stars, 19 septembre 2026).
    selection: Optional[str] = None
    # Le SUJET de la question est-il l'équipe à domicile ?
    #
    # `home_team`/`away_team` décrivent le MATCH (qui reçoit, d'où l'avantage de
    # la glace, le voyage, l'altitude de l'aréna). Ce champ dit de quel côté se
    # place la question posée. Sans lui, le backend passait le sujet en premier
    # argument de `buildGameFeatures`, donc la tuile « extérieur » demandait
    # « P(l'équipe visiteuse gagne CHEZ ELLE) » : les deux tuiles moneyline d'un
    # même match recevaient toutes deux l'avantage de la glace et totalisaient
    # 109–112 % au lieu de 100 %.
    subject_is_home: bool = True
    line: Optional[float] = None             # for total goals
    # ── v4 — cotes du marché (The Odds API, format DÉCIMAL, ex. 1.87) ────────
    home_odds_decimal: Optional[float] = Field(None, gt=1.0)
    away_odds_decimal: Optional[float] = Field(None, gt=1.0)
    total_line_market: Optional[float] = None    # ligne O/U du marché (ex. 6.0)
    # ── v4 — contexte lineup (optionnel; défauts raisonnables sinon) ─────────
    home_goalie: Optional[str] = None            # nom du gardien partant si connu
    away_goalie: Optional[str] = None
    # Identifiant NHL du partant (= identifiant MoneyPuck de l'état
    # d'inférence). Apparié AVANT le nom : l'orthographe ne compte plus. Le nom
    # reste le repli pour un état d'inférence sans identifiants de gardiens.
    home_goalie_id: Optional[int] = Field(None, gt=0)
    away_goalie_id: Optional[int] = Field(None, gt=0)
    home_stars_missing: int = Field(0, ge=0, le=5)   # legacy : nb de top-5 absents
    away_stars_missing: int = Field(0, ge=0, le=5)
    # Absents confirmés du soir (Daily Faceoff) — noms orthographe MoneyPuck.
    # Si fournis, le service dérive stars_missing/star_power des BONS joueurs et
    # calcule stars_out_weight (absence pondérée perf + position/trio).
    home_scratches: List[str] = Field(default_factory=list)
    away_scratches: List[str] = Field(default_factory=list)
    # Alignement OFFICIEL du soir (API NHL, publié peu avant la mise au jeu) :
    # les joueurs habillés, identifiants NHL et noms. Vide = inconnu, et le
    # service retombe sur l'effectif récent moins les absents ci-dessus. Connu,
    # il remplace les deux : la projection additionne exactement les habillés,
    # joueur de retour de blessure compris (cf. `skater_pool`, build_dataset.py).
    home_dressed_ids: List[int] = Field(default_factory=list, max_length=40)
    away_dressed_ids: List[int] = Field(default_factory=list, max_length=40)
    home_dressed: List[str] = Field(default_factory=list, max_length=40)
    away_dressed: List[str] = Field(default_factory=list, max_length=40)

# ── Player prop features ──────────────────────────────────────────────────────

class PlayerPropFeatures(BaseModel):
    goals_per_game: float = Field(0.25, ge=0)
    assists_per_game: float = Field(0.30, ge=0)
    points_per_game: float = Field(0.55, ge=0)
    shots_per_game: float = Field(2.5, ge=0)
    # Points en avantage numérique par match, mesurés sur le joueur. Absent →
    # pas d'estimation pour `pp_point` (l'ancien repli `buts × 0,35` ignorait
    # que ces points sont surtout des passes).
    pp_points_per_game: Optional[float] = Field(None, ge=0)
    games_played: int = Field(40, ge=1)
    line: float = Field(0.5, ge=0)
    prop_type: str = Field("goals")   # "goals"|"assists"|"points"|"shots"|"pp_point"
    selection: str = Field("over")    # "over"|"under"
    # La cadence reçue est-elle une MOYENNE DE LIGUE plutôt qu'une mesure sur ce
    # joueur ? Le backend le sait (il n'a pas de source par joueur pour les
    # mises en échec ni les tirs bloqués) ; sans ce drapeau, l'explication
    # affirmait « player averages 2.10 hits/game » pour n'importe qui.
    rate_is_league_average: bool = False

# ── Team futures features ─────────────────────────────────────────────────────

class TeamFuturesFeatures(BaseModel):
    win_pct: float = Field(50.0, ge=0, le=100)
    goals_for_pg: float = Field(3.0, ge=0)
    goals_against_pg: float = Field(3.0, ge=0)
    pp_pct: Optional[float] = Field(None, ge=0, le=100)
    pk_pct: Optional[float] = Field(None, ge=0, le=100)
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


# ── Marchés binaires ─────────────────────────────────────────────────────────
#
# Ces marchés ont DEUX issues complémentaires mais un seul `market_type` : le
# prix calculé est toujours celui du côté « oui ». `selection` dit lequel des
# deux est demandé, et le côté « non » est pris par complément — aucun de ces
# marchés n'admet de push, donc P(non) = 1 − P(oui) exactement.
#
# `total_goals_over` / `total_goals_under` n'y figurent PAS : leur côté est déjà
# dans le nom du marché, les inscrire ici les inverserait deux fois.
_BINARY_MARKETS = {
    "both_teams_score",
    "clean_sheet",
    "game_to_ot",
    "puck_line",
    "team_pp_goals",
    "team_penalty_kill",
    "team_score_every_period",
}
_NEGATIVE_SELECTIONS = {"no", "non", "false", "0"}


# Marchés « plus / moins » dont le côté voyage dans `selection` et non dans le
# nom (contrairement à `total_goals_over` / `total_goals_under`). Le service
# price toujours « plus » ; « moins » est son complément (lignes en .5, pas de
# push). Sans ce traitement, la tuile « Under 2.5 » d'un total d'équipe
# affichait le MÊME pourcentage que « Over 2.5 » — trouvé le 2026-10-03 en
# corrigeant ml/INCOHERENCES_ML.md §16 (79 % / 79 % sur COL–SJS).
_OVER_UNDER_MARKETS = {"team_total_goals", "total_goals",
                       "period1_total_goals", "period2_total_goals", "period3_total_goals"}
_UNDER_SELECTIONS = {"under", "u", "moins"}


def _is_negative_side(f: GameFeatures) -> bool:
    """Vrai si l'appelant demande le côté « non » d'un marché binaire, ou le
    côté « moins » d'un marché plus/moins sans côté dans son nom."""
    sel = (f.selection or "").strip().lower()
    if f.market_type in _BINARY_MARKETS:
        return sel in _NEGATIVE_SELECTIONS
    if f.market_type in _OVER_UNDER_MARKETS:
        return sel in _UNDER_SELECTIONS
    return False


def _p_both_score(dist: "ScoreDistribution", line: float = 0.5) -> float:
    """P(les deux équipes marquent ≥1), lue sur la matrice jointe des scores.

    Inclusion-exclusion sur la première ligne et la première colonne de `M`
    (ligne i = buts du domicile, colonne j = buts du visiteur) :

        P(les deux marquent) = 1 − P(dom = 0) − P(ext = 0) + P(0–0)

    Pourquoi passer par `M` plutôt que par deux Poisson indépendantes sur les
    buts/match des fiches d'équipe : `M` porte les λ DU MATCH (attaque contre
    défense, gardien, alignement…) et la correction de marge τ ajustée à
    l'entraînement. L'ancienne heuristique donnait ~90 % à tous les matchs.

    (Ce commentaire invoquait aussi une « sur-dispersion » — ~8,5 % de
    blanchissages contre 5 % en Poisson. Les mesures du projet disent le
    contraire : variance/moyenne ≈ 1 sur 40 604 matchs (`score_model.py`) et
    4,98 % de blanchissages par équipe-match (`prediction/scoreModel.ts`).
    Corrigé le 2026-10-03, ml/INCOHERENCES_ML.md §19.)

    La prolongation ne change rien : un 0–0 après 60 minutes se termine 1–0,
    donc une équipe reste blanchie de toute façon. La formule vaut pour le
    match complet telle quelle.
    """
    M = dist.M
    if line > 0.5:
        # « Les deux marquent 2+ / 3+ » : les deux indices au-dessus de la
        # ligne. Même remarque pour la prolongation : un nul k–k finit
        # (k+1)–k, le perdant reste à k — le verdict ne change pas.
        idx = np.arange(M.shape[0])
        return float(M[np.ix_(idx > line, idx > line)].sum())
    p_home_blank = float(M[0, :].sum())
    p_away_blank = float(M[:, 0].sum())
    return float(1.0 - p_home_blank - p_away_blank + float(M[0, 0]))


def _final_grid(dist: "ScoreDistribution") -> np.ndarray:
    """Loi du score FINAL vue du sujet : chaque nul k–k après 60 minutes
    devient (k+1)–k ou k–(k+1) selon qui gagne la prolongation. C'est le score
    que règle `game.homeTeam.score`."""
    M = dist.M
    n = M.shape[0]
    F = np.zeros((n + 1, n + 1))
    F[:n, :n] = np.where(dist._tie, 0.0, M)
    p = dist.p_ot_home
    for k in range(n):
        F[k + 1, k] += M[k, k] * p
        F[k, k + 1] += M[k, k] * (1.0 - p)
    return F


def _p_cover(dist: "ScoreDistribution", handicap: float) -> float:
    """P(sujet + handicap > adversaire), score final — puck line à toute ligne."""
    F = _final_grid(dist)
    idx = np.arange(F.shape[0])
    margin = idx[:, None] - idx[None, :]
    return float(F[margin + handicap > 0].sum())


def _skellam_lead(lam_s: float, lam_o: float) -> tuple[float, float]:
    """(P(le sujet mène), P(égalité)) pour deux Poisson indépendantes."""
    ps = [poisson_pmf(k, lam_s) for k in range(16)]
    po = [poisson_pmf(k, lam_o) for k in range(16)]
    lead = draw = 0.0
    for i, a in enumerate(ps):
        for j, b in enumerate(po):
            if i > j:    lead += a * b
            elif i == j: draw += a * b
    return lead, draw


# Part CUMULÉE des buts d'un match à la fin de chaque période (moyennes NHL,
# mêmes constantes que `PERIOD_DIST` côté Node).
# Part des buts RÉGLEMENTAIRES marqués dans chaque période — UNE source pour
# tous les marchés de période (ml/INCOHERENCES_ML.md §16). Ce service en
# avait trois : 0,305 / 0,365 / 0,33 pour « qui mène », 0,317 / 0,367 / 0,317
# (λ/3 × 0,95 / 1,10 / 0,95) pour les totaux par période, et trois tiers égaux
# pour « période la plus prolifique ». Valeurs NHL de `PERIOD_DIST`
# (`nhlPredictions.ts`), les mêmes côté Node : la 2e période marque le plus
# (changement long), la 3e un peu moins (fermeture du jeu, compensée en partie
# par les filets déserts).
_PERIOD_SHARE = (0.305, 0.365, 0.330)
_PERIOD_CUM = {1: _PERIOD_SHARE[0], 2: _PERIOD_SHARE[0] + _PERIOD_SHARE[1]}


# ── Écart de victoire / période la plus prolifique ────────────────────────────
#
# Ces deux marchés n'avaient AUCUN moyen de savoir ce qu'on leur demandait :
# `GameFeatures` ne portait ni le seau d'écart ni la période. `winning_margin`
# renvoyait donc `base_prob * 0.40` — le même 34 % pour les six tuiles — et
# `highest_scoring_period` price ait toujours la 2e période, quelle que soit
# celle demandée (P1, P2 et P3 sortaient toutes à 38 %, soit 114 % pour trois
# issues qui s'excluent). Le côté demandé arrive maintenant dans `selection`.

_NEGATIVE_MARGIN_SIZES = {"1": 1, "by_1": 1, "exactly_1": 1,
                          "2": 2, "by_2": 2, "exactly_2": 2}


def _parse_margin_bucket(selection: str | None, subject_is_home: bool) -> str | None:
    """Seau d'écart demandé, exprimé DU POINT DE VUE DU SUJET.

    Deux vocabulaires côté client, qui doivent tomber au même endroit :
      - `gameMarkets.tsx` envoie la taille seule ("1", "2", "3+"), le côté étant
        porté par le sujet de la requête ;
      - `betMarkets.ts` envoie un couple explicite ("home_1", "away_2plus").
    """
    s = (selection or "").strip().lower().replace(" ", "_").replace("-", "_")
    if not s:
        return None

    subject_wins = True
    if s.startswith("home_") or s.startswith("away_"):
        side_is_home = s.startswith("home_")
        subject_wins = (side_is_home == subject_is_home)
        s = s.split("_", 1)[1]

    if s in ("2plus", "2+"):
        return "win_2plus" if subject_wins else "lose_2plus"
    if s in ("3", "3+", "3plus", "by_3", "3_plus"):
        return "win_3plus" if subject_wins else "lose_3plus"
    size = _NEGATIVE_MARGIN_SIZES.get(s)
    if size is None:
        return None
    return (f"win_{size}" if subject_wins else f"lose_{size}")


def _p_margin_bucket(dist: "ScoreDistribution", bucket: str) -> float:
    """Probabilité d'un seau d'écart, lue sur la matrice jointe.

    La masse de nul réglementaire bascule entièrement sur « par 1 » : un match
    à égalité après 60 minutes se termine toujours par un but d'écart, en
    prolongation ou en fusillade. C'est ce qui fait de « par 1 » l'écart le plus
    fréquent du hockey, et aucun modèle qui l'ignore ne retrouve la forme réelle
    de la distribution.
    """
    M, marg = dist.M, dist._margin
    tie = float(M[dist._tie].sum())
    p_ot = dist.p_ot_home

    def decisive(lo: int, hi: int | None, side: int) -> float:
        m = marg * side
        sel = (m >= lo) if hi is None else ((m >= lo) & (m <= hi))
        return float(M[sel].sum())

    if bucket == "win_1":       return decisive(1, 1, 1) + tie * p_ot
    if bucket == "lose_1":      return decisive(1, 1, -1) + tie * (1.0 - p_ot)
    if bucket == "win_2":       return decisive(2, 2, 1)
    if bucket == "lose_2":      return decisive(2, 2, -1)
    if bucket == "win_3plus":   return decisive(3, None, 1)
    if bucket == "lose_3plus":  return decisive(3, None, -1)
    if bucket == "win_2plus":   return decisive(2, None, 1)
    if bucket == "lose_2plus":  return decisive(2, None, -1)
    return 0.0


def _parse_period(selection: str | None) -> str | None:
    s = (selection or "").strip().lower()
    if s in ("p1", "1", "1st", "period1", "first"):  return "P1"
    if s in ("p2", "2", "2nd", "period2", "second"): return "P2"
    if s in ("p3", "3", "3rd", "period3", "third"):  return "P3"
    if s in ("tie", "tied", "draw", "equal"):        return "tie"
    return None


def _p_highest_period_total(total_lam: float, period: str) -> float:
    """P(la période demandée a STRICTEMENT le plus de buts), ou P(égalité en
    tête) pour `tie`, à partir des buts réglementaires attendus du match.

    Chaque période reçoit sa part mesurée (`_PERIOD_SHARE`) — la 2e sort donc
    un peu plus souvent en tête. Règlement (`settlement.service.ts`) : buts
    réglementaires seulement, égalité en tête = perdu pour P1/P2/P3.
    """
    pmfs = [[poisson_pmf(n, total_lam * sh) for n in range(16)] for sh in _PERIOD_SHARE]
    cdf_below = [[sum(pm[:n]) for n in range(16)] for pm in pmfs]   # P(X < n)

    def strict(i: int) -> float:
        a, b = [j for j in range(3) if j != i]
        return sum(pmfs[i][n] * cdf_below[a][n] * cdf_below[b][n] for n in range(16))

    if period == "tie":
        return clamp(1.0 - sum(strict(i) for i in range(3)), 0.02, 0.98)
    return clamp(strict({"P1": 0, "P2": 1, "P3": 2}[period]), 0.02, 0.98)


def _p_highest_period(dist: "ScoreDistribution", period: str) -> float:
    """P(la période demandée est la plus prolifique du match)."""
    return _p_highest_period_total(dist.lam_home + dist.lam_away, period)


def _has_evidence(team: str | None) -> bool:
    """Dispose-t-on d'une observation quelconque sur cette équipe ?

    Deux sources, et il en suffit d'une :
      - `inference_state.json` — statistiques roulantes MoneyPuck, ce que les
        22 features du modèle de score consomment réellement ;
      - `elo_ratings.json` — la force d'équipe, seule feature qui survit quand
        tout le reste manque.

    Les statistiques que le backend envoie (win%, buts, unités spéciales) ne
    comptent PAS : elles ont toutes une valeur par défaut, donc leur présence ne
    prouve rien.
    """
    if not team:
        return False
    t = team.upper()
    if (_inference_state.get("teams") or {}).get(t):
        return True
    return t in _elo_ratings


def _require_evidence(f: GameFeatures) -> None:
    """Refuse de pricer un match sur lequel le service ne sait rien.

    Le seuil est volontairement BAS : une seule équipe reconnue suffit, parce
    qu'un modèle qui connaît un des deux camps dit encore quelque chose. Ce
    qu'on interdit, c'est la réponse construite à 100 % sur des défauts.
    """
    if _has_evidence(f.home_team) or _has_evidence(f.away_team):
        return
    named = " / ".join(x for x in (f.home_team, f.away_team) if x) or "aucune équipe nommée"
    raise HTTPException(
        status_code=422,
        detail={
            "error": "no_estimate",
            "market": f.market_type,
            "message": (f"No data for this matchup ({named}) — every feature would be "
                        f"a default, so any number returned would be invented."),
        },
    )


def _subject_view(dist: "ScoreDistribution", subject_is_home: bool) -> "ScoreDistribution":
    """La même distribution, vue du côté du SUJET.

    `ScoreDistribution` est construite du point de vue du domicile : `M[i][j]` =
    P(domicile marque i, extérieur j). La transposée est exactement la même loi
    vue de l'extérieur, donc toutes les formules écrites « pour le domicile »
    répondent pour le visiteur sans être réécrites — y compris celles qui ne
    sont PAS des compléments (`team_total_goals`, `clean_sheet`), pour
    lesquelles un simple `1 − p` serait faux.

    `_margin`, `_total` et `_tie` ne dépendent que des indices : ils restent
    valides tels quels. Seuls les λ et le côté qui gagne la prolongation
    s'échangent.
    """
    if subject_is_home:
        return dist
    mirrored = copy.copy(dist)
    mirrored.M = np.ascontiguousarray(dist.M.T)
    mirrored.lam_home, mirrored.lam_away = dist.lam_away, dist.lam_home
    mirrored.p_ot_home = 1.0 - dist.p_ot_home
    return mirrored


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

    # ── Variantes des tableaux de la page match (sept. 2026) ────────────────
    #
    # Toutes lues sur la loi jointe, vue du SUJET (`dist` est déjà tournée).

    # Puck line à une autre ligne que −1.5 (−2.5, −3.5). `line` = handicap du
    # sujet, comme au règlement.
    if market == "puck_line" and f.line is not None and abs(f.line + 1.5) > 1e-9:
        p = _p_cover(dist, f.line)
        return p, 0.85, (f"P(sujet {f.line:+.1f} couvre) = {int(p * 100)}% sur le score "
                         f"final (λ={lh:.2f}/{la:.2f}).")

    # Les deux marquent 2+ / 3+.
    if market == "both_teams_score" and f.line is not None and f.line > 0.5:
        p = _p_both_score(dist, f.line)
        return p, 0.85, (f"Matrice jointe λ={lh:.2f}/{la:.2f} → les deux marquent "
                         f"{int(f.line + 0.5)}+ : {int(p * 100)}%.")

    # Score exact. `selection` = « h-a » dans l'ordre DOMICILE–VISITEUR du
    # match, ou `home_other` / `away_other` (ce camp gagne avec 5 buts ou plus).
    if market == "correct_score":
        sel = (f.selection or "").strip().lower()
        F = _final_grid(dist)                  # vue du sujet
        m = re.match(r"^(\d{1,2})-(\d{1,2})$", sel)
        if m:
            h, a = int(m.group(1)), int(m.group(2))
            s_goals, o_goals = (h, a) if f.subject_is_home else (a, h)
            if s_goals >= F.shape[0] or o_goals >= F.shape[0]:
                return 0.0, 0.70, "Score hors de la grille du modèle."
            p = float(F[s_goals, o_goals])
            return p, 0.70, (f"Score final {h}-{a} : {p * 100:.1f}% "
                             f"(λ={lh:.2f}/{la:.2f}, prolongation comprise).")
        if sel in ("home_other", "away_other"):
            winner_is_subject = (sel == "home_other") == f.subject_is_home
            idx = np.arange(F.shape[0])
            s_i, o_i = idx[:, None], idx[None, :]
            mask = ((s_i > o_i) & (s_i >= 5)) if winner_is_subject else ((o_i > s_i) & (o_i >= 5))
            p = float(F[mask].sum())
            return p, 0.70, f"Victoire avec 5 buts ou plus : {p * 100:.1f}%."
        return None

    # Qui MÈNE après la période N (buts cumulés), ou égalité (`draw`).
    # 3e période = résultat en 60 minutes, égalité = prolongation.
    pm = re.match(r"^period([123])_winner$", market)
    if pm:
        n = int(pm.group(1))
        is_draw = (f.selection or "").strip().lower() in ("draw", "tie")
        if n == 3:
            p_draw = dist.p_regulation_tie()
            p_lead = float(dist.M[dist._margin > 0].sum())
        else:
            frac = _PERIOD_CUM[n]
            p_lead, p_draw = _skellam_lead(lh * frac, la * frac)
        p = p_draw if is_draw else p_lead
        what = "égalité" if is_draw else "le sujet mène"
        return p, 0.74, (f"Après la période {n} ({what}) : {int(p * 100)}% — buts "
                         f"cumulés, λ du modèle de score ({lh:.2f}/{la:.2f}).")

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

    if market == "ot_so_winner":
        # « Le sujet gagne en prolongation ou en fusillade », SANS condition :
        # P(nul après 60 min) × P(le sujet gagne la prolongation). Les tuiles
        # « in OT/SO » de Match Betting ; leurs deux moitiés somment à
        # `game_to_ot`.
        p = dist.p_regulation_tie() * dist.p_ot_home
        return p, 0.80, (f"P(nul après 60 min) {dist.p_regulation_tie():.0%} × "
                         f"P(le sujet gagne la prolongation) {dist.p_ot_home:.0%} = {int(p * 100)}%.")

    if market == "both_teams_score":
        p = _p_both_score(dist)
        return p, 0.90, (f"Matrice jointe λ={lh:.2f}/{la:.2f} → les deux marquent : "
                         f"{int(p * 100)}%. Blanchissage d'un côté ou de l'autre : "
                         f"{int((1 - p) * 100)}%.")

    if market == "ot_winner":
        # `dist.p_ot_home` porte DÉJÀ la logistique ajustée sur 3 427
        # prolongations (`p_ot_for`, coefficients dans score_report.json), et
        # `_subject_view` l'a retournée si le sujet est le visiteur. Il n'y a
        # rien à recalculer ici — seulement à cesser de l'ignorer.
        p = dist.p_ot_home
        return p, 0.72, (f"P(le sujet gagne la prolongation) = {int(p * 100)}% — "
                         f"modèle ajusté sur l'écart de cadence "
                         f"(λ {lh:.2f} vs {la:.2f}). Le 3 contre 3 puis les tirs "
                         f"de barrage sont proches du pile ou face.")

    if market == "clean_sheet":
        # Lu sur la MÊME matrice que « les deux marquent », donc cohérent avec
        # lui par construction. L'heuristique `exp(-lam_away)` qu'il remplace
        # ignorait la défense d'en face et pouvait annoncer 10 % de blanchissage
        # sur un match où BTTS disait 92 % — soit au plus 8 % possible.
        # Réglé sur le score FINAL : un 0-0 après 60 minutes que l'adversaire
        # gagne en prolongation ou en fusillade finit 0-1 — plus de blanchissage
        # (ml/INCOHERENCES_ML.md §18). Seule la part gagnée par le sujet reste.
        p = float(dist.M[:, 0].sum()) - float(dist.M[0, 0]) * (1.0 - dist.p_ot_home)
        return p, 0.88, (f"P(l'adversaire ne marque pas) = {int(p * 100)}%, "
                         f"score final lu sur la matrice jointe (un 0-0 perdu en "
                         f"prolongation n'est pas un blanchissage).")

    if market == "winning_margin":
        bucket = _parse_margin_bucket(f.selection, f.subject_is_home)
        if bucket is None:
            return None
        p = _p_margin_bucket(dist, bucket)
        return p, 0.78, (f"P({bucket.replace('_', ' ')}) = {int(p * 100)}% — "
                         f"tout match nul après 60 minutes se finit à 1 but d'écart.")

    if market == "highest_scoring_period":
        period = _parse_period(f.selection)
        if period is None:
            return None
        p = _p_highest_period(dist, period)
        return p, 0.60, (f"P({period} est la période la plus prolifique) = {int(p*100)}% — "
                         f"buts réglementaires λ={lh + la:.2f} répartis "
                         f"{_PERIOD_SHARE[0]:.0%}/{_PERIOD_SHARE[1]:.0%}/{_PERIOD_SHARE[2]:.0%}.")

    pt = re.match(r"^period([123])_total_goals$", market)
    if pt:
        n = int(pt.group(1))
        line = f.line if f.line is not None else 1.5
        lam_p = (lh + la) * _PERIOD_SHARE[n - 1]
        p = poisson_over(line, lam_p)
        return p, 0.74, (f"Buts de la période {n} : λ={lam_p:.2f} ({_PERIOD_SHARE[n - 1]:.1%} des "
                         f"buts réglementaires du modèle de score) → OVER {line} : {int(p * 100)}%.")

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
        if line is not None and abs(line + 1.5) > 1e-9:
            return lambda d: _p_cover(d, line)
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
    if market == "ot_so_winner":
        return lambda d: d.p_regulation_tie() * d.p_ot_home
    if market == "ot_winner":
        # σ est invariant par complément, donc la même fonction sert les deux
        # camps — les membres de l'ensemble restent orientés domicile.
        return lambda d: d.p_ot_home
    if market == "both_teams_score":
        # σ est invariant par complément (écart-type de 1−X = écart-type de X),
        # donc la même fonction sert les deux côtés du marché.
        if line is not None and line > 0.5:
            return lambda d: _p_both_score(d, line)
        return _p_both_score
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
            # Score exact : une case vaut souvent moins de 2 % — le plancher
            # habituel la triplerait et la ligne ne sommerait plus à 100.
            lo = 0.0 if market == "correct_score" else 0.02
            return clamp(p, lo, 0.98), conf, expl

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
        # `0.52 + win_diff · 0.28` montait à 69 % pour un gros favori, alors que
        # le modèle ajusté de CE MÊME service en donne ~55 % pour une équipe qui
        # a un but par match d'avance. La pente était posée à la main ; celle-ci
        # est mesurée. On l'utilise même sans modèle de score : `_p_ot_for`
        # retombe sur le scalaire `_score_p_ot` si aucun modèle n'est chargé.
        #
        # Orientation : les λ reçus ici sont déjà ceux du SUJET (cf. le bloc
        # `subject_is_home` de `predict_game`), mais l'ordonnée à l'origine du
        # modèle vaut pour le DOMICILE. On évalue donc côté domicile, puis on
        # complémente — inverser le signe de l'écart ne suffirait pas.
        if f.subject_is_home:
            prob = _p_ot_for(lam_home, lam_away)
        else:
            prob = 1.0 - _p_ot_for(lam_away, lam_home)
        conf = 0.72
        expl = (f"P(le sujet gagne la prolongation) = {int(prob*100)}% — modèle "
                f"ajusté sur l'écart de cadence, pas une pente posée à la main.")

    elif market == "both_teams_score":
        # P(both score) = 1 − P(home shutout) − P(away shutout) + P(double shutout)
        p_home_shutout = math.exp(-lam_away)  # away team scores 0
        p_away_shutout = math.exp(-lam_home)  # home team scores 0
        # Plancher ramené de 0.40 à 0.05 : il n'existe que pour borner l'absurde,
        # et à 0.40 le côté « non » (son complément) était plafonné à 60 % — une
        # borne qui n'a aucun fondement. Ce repli ne sert que sans modèle de
        # score chargé ; sinon `_apply_score_model` price BTTS sur la matrice
        # jointe, corrélation et sur-dispersion comprises.
        prob = clamp(
            1.0 - p_home_shutout - p_away_shutout + p_home_shutout * p_away_shutout,
            0.05, 0.95
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
        period = _parse_period(f.selection)
        if period is None:
            raise _NoEstimate(market)
        prob = _p_highest_period_total(total_lam, period)
        conf = 0.55
        expl = (f"P({period} la plus prolifique) = {int(prob*100)}% — buts λ={total_lam:.2f} "
                f"répartis selon les parts mesurées par période.")

    elif market == "period1_total_goals":
        p1_line = f.line if f.line is not None else 1.5
        p1_lam = total_lam * _PERIOD_SHARE[0]
        prob = clamp(poisson_over(p1_line, p1_lam), 0.05, 0.95)
        conf = 0.74
        expl = f"Poisson P1 λ={p1_lam:.2f} ({_PERIOD_SHARE[0]:.1%} des buts) → OVER {p1_line}: {int(prob*100)}%."

    elif market == "period2_total_goals":
        p2_line = f.line if f.line is not None else 1.5
        p2_lam = total_lam * _PERIOD_SHARE[1]
        prob = clamp(poisson_over(p2_line, p2_lam), 0.05, 0.95)
        conf = 0.74
        expl = f"Poisson P2 λ={p2_lam:.2f} ({_PERIOD_SHARE[1]:.1%} des buts) → OVER {p2_line}: {int(prob*100)}%."

    elif market == "period3_total_goals":
        p3_line = f.line if f.line is not None else 1.5
        p3_lam = total_lam * _PERIOD_SHARE[2]
        prob = clamp(poisson_over(p3_line, p3_lam), 0.05, 0.95)
        conf = 0.72
        expl = f"Poisson P3 λ={p3_lam:.2f} ({_PERIOD_SHARE[2]:.1%} des buts) → OVER {p3_line}: {int(prob*100)}%."

    elif market == "winning_margin":
        # Sans modèle de score il n'y a pas de loi jointe d'où tirer un seau
        # d'écart. `base_prob * 0.40` rendait le même chiffre aux six tuiles,
        # pour une partition exhaustive qui doit totaliser 100 %.
        raise _NoEstimate(market)

    elif market == "double_chance":
        # Home wins in reg OR goes to OT and home wins OT
        ot_rate = clamp(0.20 + max(0.0, 0.25 - abs(win_diff)) * 0.88, 0.08, 0.40)
        ot_home = (_p_ot_for(lam_home, lam_away) if f.subject_is_home
                   else 1.0 - _p_ot_for(lam_away, lam_home))
        prob = clamp(base_prob * 0.85 + ot_rate * ot_home, 0.35, 0.92)
        conf = 0.88
        expl = f"Double chance (gagne reg + OT): {int(prob*100)}%."

    elif market == "team_pp_goals":
        # PP% est un taux PAR OCCASION. Sur ~3,1 occasions :
        #   P(au moins un but en AN) = 1 − e^(−3.1 × PP%)
        # `0.40 + (pp − 20) × 0.007` rendait 40 % à une équipe à 20 %, là où le
        # calcul en donne 46 %. Mêmes formule et constante que
        # `predictionEngine.ts` et `nhlPredictions.ts` : trois moteurs, un seul
        # chiffre pour un même match.
        # Le PP% du SUJET — `home_pp_pct` pour tous les sujets donnait au
        # visiteur l'avantage numérique de l'équipe à domicile.
        pp_raw = f.home_pp_pct if f.subject_is_home else f.away_pp_pct
        pp = pp_raw if pp_raw is not None else LEAGUE_PP_PCT
        prob = clamp(1.0 - math.exp(-PP_OPPORTUNITIES * (pp / 100.0)), 0.05, 0.95)
        conf = 0.70
        expl = (f"PP {pp:.1f}% sur ~{PP_OPPORTUNITIES} occasions → "
                f"{int(prob*100)}% de marquer en avantage numérique.")

    elif market == "team_penalty_kill":
        # Marché ABSENT de ce dispatcher : il tombait dans le `else`, qui
        # servait la probabilité moneyline sous le nom « tue toutes ses
        # pénalités ». Tuer UNE pénalité à 80 % ne fait pas une soirée parfaite
        # à 80 % — il faut réussir les ~3,1 fois.
        pk_raw = f.home_pk_pct if f.subject_is_home else f.away_pk_pct
        pk = pk_raw if pk_raw is not None else LEAGUE_PK_PCT
        prob = clamp(math.pow(pk / 100.0, PP_OPPORTUNITIES), 0.05, 0.95)
        conf = 0.70
        expl = (f"PK {pk:.1f}% ^ {PP_OPPORTUNITIES} occasions = "
                f"{int(prob*100)}% de tout tuer.")

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
        # 0.52 n'était dérivé de rien et se présentait comme une prédiction.
        raise _NoEstimate(market)

    else:
        # Marché inconnu. Renvoyer `base_prob` servait la probabilité MONEYLINE
        # sous le nom du marché demandé : `corner_kicks` rendait 84 %, soit
        # exactement le moneyline, présenté comme une prédiction de ce marché.
        raise _NoEstimate(market)

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
        dist = ScoreDistribution(lam_h, lam_a, _p_ot_for(lam_h, lam_a), _score_tau)
        dist._dmatrix = dmat          # réutilisé par l'ensemble, cf. ci-dessous
        return dist
    except Exception as e:
        print(f"[ML] ⚠️  modèle de score indisponible pour ce match : {e}")
        return None


# ── S4 ② — décomposition de log λ en facteurs lisibles ───────────────────────
#
# CE QUE ÇA REMPLACE. Jusqu'ici `feature_importances` servait les gains globaux
# du classifieur : les MÊMES six colonnes pour tous les matchs de la saison, et
# une `direction` devinée par correspondance de chaînes sur le nom de la feature
# (`"win" in name`, `"gf" in name`…) confrontée à trois écarts globaux. Ça ne
# disait rien du match affiché.
#
# CE QUE ÇA DONNE À LA PLACE. XGBoost expose `predict(..., pred_contribs=True)`,
# soit la contribution EXACTE de chaque feature au score brut — ici log λ,
# puisque le modèle de score est un `count:poisson`. On la lit sur les deux
# lignes déjà construites pour ce match (ligne domicile, ligne extérieur) et on
# prend l'écart :
#
#     effet_net(f) = contrib(f, ligne dom) − contrib(f, ligne ext)
#
# positif = pousse vers le domicile. C'est par match, c'est signé, et c'est la
# décomposition réelle du modèle, pas une heuristique.
#
# `is_home` et `elo_atk_minus_def` se décomposent correctement sans traitement
# spécial : la ligne domicile porte `is_home=1` et `elo_dom − elo_ext`, la ligne
# extérieur `is_home=0` et l'opposé. L'écart des contributions EST l'avantage de
# la glace, et l'écart de force d'équipe.
#
# POURQUOI DES GROUPES ET PAS LES COLONNES. Sept concepts se lisent ; vingt-deux
# noms de colonnes non. Et surtout un groupe est **stable** : si le jeu de
# features bouge, une colonne disparaît simplement de son groupe au lieu de
# faire disparaître une ligne de l'affichage.
#
# `factor.other` est un filet, pas un huitième concept : une colonne qu'aucune
# règle ne reconnaît y tombe au lieu d'être silencieusement perdue. S'il
# apparaît à l'écran, c'est que `_factor_of` a besoin d'une règle de plus.

# Part minimale pour qu'un facteur mérite une ligne : en dessous, la barre est
# invisible et n'ajoute que du bruit à une liste déjà courte.
_FACTOR_MIN_SHARE = 0.005


def _factor_of(name: str) -> str:
    """Concept auquel rattacher une feature du modèle de score.

    Par règles et non par table exhaustive : une colonne ajoutée à `ATK_COLS`
    ou `DEF_COLS` tombe alors dans le bon groupe sans qu'on ait à toucher ici.
    """
    if name == "is_home":
        return "factor.home_ice"
    if name == "elo_atk_minus_def":
        return "factor.team_strength"
    stem = name[4:] if name[:4] in ("atk_", "def_") else name
    if stem.startswith("goalie_"):
        return "factor.goalie"
    if stem in ("star_power", "stars_out_weight", "lineup_xg", "lineup_pts"):
        return "factor.lineup"
    if stem in ("rest_days", "b2b"):
        return "factor.schedule"
    if name.startswith("def_"):
        return "factor.opp_defense"
    if name.startswith("atk_"):
        return "factor.attack"
    return "factor.other"


def _lambda_factor_importances(
    dist: "ScoreDistribution | None",
) -> list[FeatureImportance]:
    """Facteurs du match, décomposés depuis log λ. Liste vide = repli.

    Rend une liste VIDE plutôt que de lever : `feature_importances` est un
    élément d'affichage, il ne doit jamais faire échouer une prédiction. Chaque
    sortie vide laisse l'appelant conserver la liste du classifieur.

    `name` porte une CLÉ i18n (`factor.*`), pas un libellé : le client la traduit
    et retombe sur la chaîne brute s'il ne la connaît pas — ce qui garde le repli
    classifieur, dont les noms sont des colonnes, affichable tel quel.

    `importance` est une part normalisée du total des |effets| (le client la
    rend en pourcentage), et `direction` dit vers quel camp le facteur pousse :
    `positive` = vers le DOMICILE, comme la probabilité affichée.
    """
    dmat = getattr(dist, "_dmatrix", None)
    if dmat is None or _xgb_score is None or not _SCORE_FEAT_NAMES:
        return []
    try:
        contribs = np.asarray(_xgb_score.predict(dmat, pred_contribs=True))
    except Exception as e:
        print(f"[ML] ⚠️  décomposition λ indisponible : {e}")
        return []

    # (2, n_features + 1) — la dernière colonne est le biais, commun aux deux
    # lignes : il s'annule dans l'écart, on l'écarte explicitement.
    n = len(_SCORE_FEAT_NAMES)
    if contribs.ndim != 2 or contribs.shape[0] != 2 or contribs.shape[1] < n:
        return []
    net = contribs[0, :n] - contribs[1, :n]

    agg: dict[str, float] = {}
    for name, value in zip(_SCORE_FEAT_NAMES, net):
        if not np.isfinite(value):
            continue
        key = _factor_of(name)
        agg[key] = agg.get(key, 0.0) + float(value)

    total = sum(abs(v) for v in agg.values())
    if total <= 0.0:
        return []

    out = [
        FeatureImportance(
            name=key,
            importance=round(abs(value) / total, 4),
            direction="positive" if value > 0 else "negative",
        )
        for key, value in agg.items()
        if abs(value) / total >= _FACTOR_MIN_SHARE
    ]
    out.sort(key=lambda fi: fi.importance, reverse=True)
    return out


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
        k = float(getattr(dist, "level_k", 1.0))   # même niveau que le prix servi
        for mdl in _score_members:
            lam = mdl.predict(dmat)
            lh, la = float(lam[0]), float(lam[1])
            if 0.5 <= lh <= 8.0 and 0.5 <= la <= 8.0:
                lambdas.append((lh * k, la * k))
        if len(lambdas) < 2:
            return None
        # Les membres partagent le p_ot du point estimé : leurs λ n'en diffèrent
        # que d'un bruit d'échantillonnage, et σ mesure la dispersion des λ, pas
        # celle de la prolongation.
        return ScoreEnsemble(lambdas, dist.p_ot_home, _score_tau, point=dist)
    except Exception as e:
        print(f"[ML] ⚠️  ensemble indisponible pour ce match : {e}")
        return None


# ── Gardien de relève (modèle de score v2, 2026-09-27) ───────────────────────
#
# Même définition qu'à l'entraînement (`build_dataset.GOALIE_BACKUP_*`) : le
# partant a commencé moins de 40 % des 10 derniers matchs de son équipe. L'état
# d'inférence porte cette part par gardien (`share_last10`). Constante recopiée
# plutôt qu'importée : build_dataset lit des CSV au chargement et n'a rien à
# faire dans l'image du service.
_GOALIE_BACKUP_SHARE = 0.40


# ── Appariement des noms (2026-10-02, ml/INCOHERENCES_ML.md §3) ──────────────
#
# L'état d'inférence porte les noms MoneyPuck, SANS accents (« Juraj
# Slafkovsky »). Les noms reçus du serveur viennent eux de l'API NHL (absents
# officiels, blessés : « Juraj Slafkovský ») ou d'une saisie à la main (gardien
# partant). Comparés en `.lower()` seul, un absent accentué était ignoré en
# silence, et un gardien partant accentué ou mal espacé devenait un gardien
# INCONNU — donc de relève (`goalie_backup = 1`), 6e feature du modèle de score.
# Toute comparaison de noms passe désormais par cette clé.

def _name_key(s: str) -> str:
    """Clé de comparaison d'un nom : sans accents, sans points, espaces
    réduits, minuscules. « Slafkovský » (NHL) et « Slafkovsky » (MoneyPuck),
    « T.J. Brodie » et « TJ Brodie » donnent la même clé."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace(".", "").replace("\u2019", "'")
    return " ".join(s.split()).lower()


# Noms déjà signalés : un paquet est recalculé toutes les 10 minutes par match,
# inutile de répéter le même avertissement à chaque fois.
_UNMATCHED_WARNED: set[tuple[str, str, str]] = set()


def _warn_unmatched(kind: str, team: str, name: str) -> None:
    """Dit à voix haute qu'un nom reçu n'a été reconnu nulle part — c'est
    presque toujours une faute de saisie, qui sinon change la prédiction sans
    laisser de trace."""
    k = (kind, team, _name_key(name))
    if k in _UNMATCHED_WARNED:
        return
    _UNMATCHED_WARNED.add(k)
    print(f"[ML] ⚠️  {kind} « {name} » ({team or '?'}) introuvable dans "
          f"l'état d'inférence — vérifier l'orthographe")


def _find_goalie(goalies: list[dict], goalie_id: int | None,
                 goalie_name: str | None) -> dict | None:
    """Le gardien suivi qui part ce soir, ou None.

    Par identifiant NHL d'abord — quand l'état d'inférence en porte (produit
    depuis le 2026-10-02) —, par nom normalisé ensuite (`_name_key`).
    """
    if goalie_id is not None:
        by_id = [g for g in goalies if g.get("id") is not None and int(g["id"]) == int(goalie_id)]
        if by_id:
            return by_id[0]
    if goalie_name and goalie_name.strip():
        key = _name_key(goalie_name)
        by_name = [g for g in goalies if _name_key(g["name"]) == key]
        if by_name:
            return by_name[0]
    return None


def _goalie_backup_flag(goalies: list[dict], goalie_name: str | None,
                        goalie_id: int | None = None) -> float:
    """1.0 relève, 0.0 titulaire, pour le partant du soir.

    • Partant nommé et connu : son drapeau exact.
    • Partant nommé mais absent des deux gardiens suivis : un troisième gardien
      (rappelé, réserviste) — relève.
    • Partant inconnu : le drapeau du partant le PLUS PROBABLE (plus grande part
      des 10 derniers départs). Pas l'espérance du drapeau : le modèle a appris
      sur des 0 et des 1, et un arbre coupe précisément entre les deux — une
      espérance de 0,5 serait routée tout entière d'un côté.
    • État d'inférence antérieur à la v2 (pas de `share_last10`) : NaN.
    """
    if not goalies or any("share_last10" not in g for g in goalies):
        return float("nan")
    named = _find_goalie(goalies, goalie_id, goalie_name)
    if named is not None:
        return float(named["share_last10"] < _GOALIE_BACKUP_SHARE)
    if goalie_id is not None or (goalie_name and goalie_name.strip()):
        return 1.0
    usual = max(goalies, key=lambda g: float(g["share_last10"]))
    return float(float(usual["share_last10"]) < _GOALIE_BACKUP_SHARE)


# Sous ce nombre d'habillés reçus, la liste est jugée incomplète et ignorée
# (18 patineurs + 2 gardiens dans un alignement officiel).
_MIN_DRESSED = 18


def _dressed_matcher(ids: list[int] | None, names: list[str] | None):
    """Prédicat « ce joueur est-il habillé ce soir ? », ou None si l'alignement
    officiel n'est pas connu. Apparie par identifiant NHL d'abord, par nom
    ensuite (états d'inférence antérieurs au 2026-10-02 : pas d'`id`)."""
    id_set = {int(i) for i in (ids or [])}
    name_set = {_name_key(n) for n in (names or []) if n and n.strip()}
    if max(len(id_set), len(name_set)) < _MIN_DRESSED:
        return None

    def is_dressed(p: dict) -> bool:
        pid = p.get("id")
        if pid is not None and id_set:
            return int(pid) in id_set
        return _name_key(p.get("name", "")) in name_set
    return is_dressed


def _game_context(f: GameFeatures) -> dict:
    """Tout ce qui ne dépend QUE du match — features, modèles, λ, P(victoire).

    Séparé du prix d'un marché (`_price_game_market`) pour que le paquet d'un
    match (`/predict/game/bundle`) ne construise les features et ne fasse
    tourner les modèles qu'UNE fois pour ses ~95 marchés. `predict_game` fait
    exactement les deux étapes à la suite : sa réponse est inchangée.

    Rien ici ne lit `market_type`, `line`, `selection` ni `subject_is_home`
    (hors message d'erreur de `_require_evidence`) : le contexte est commun à
    tous les marchés du match.
    """
    # 0. A-t-on la moindre donnée sur ce match ?
    #
    # C'EST LE GARDE-FOU LE PLUS PROFOND DE CE FICHIER. Tous les champs de
    # `GameFeatures` ont une valeur par défaut : un corps vide est un corps
    # VALIDE, et le service répondait alors une probabilité et une confiance
    # comme pour n'importe quel autre match. Sans `home_team`/`away_team`, la
    # ligne de features du modèle de score ne contient que des défauts, et le
    # modèle extrapole sur du vide — mesuré : 55 % avec 66 % de confiance, pour
    # deux équipes qui n'ont pas de nom.
    #
    # Le service n'avait aucun moyen de dire « je ne sais pas ». Il en a un.
    _require_evidence(f)

    # 1. Corriger les valeurs manquantes (0 = pas de données NHL API)
    # Moyennes de ligue SEULEMENT là où la donnée manque vraiment.
    if f.home_pk_pct is None: f.home_pk_pct = LEAGUE_PK_PCT
    if f.away_pk_pct is None: f.away_pk_pct = LEAGUE_PK_PCT
    if f.home_pp_pct is None: f.home_pp_pct = LEAGUE_PP_PCT
    if f.away_pp_pct is None: f.away_pp_pct = LEAGUE_PP_PCT

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
                                "home_goalie_id", "away_goalie_id",
                                "home_stars_missing", "away_stars_missing",
                                "home_scratches", "away_scratches",
                                "home_dressed_ids", "away_dressed_ids",
                                "home_dressed", "away_dressed"}),
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
        pool_st   = _inference_state.get("skater_pool", {})
        for side, team, goalie_name, goalie_id, stars_missing, scratches, is_dressed, dressed_ids in [
            ("home", (f.home_team or "").upper(), f.home_goalie, f.home_goalie_id, f.home_stars_missing,
             f.home_scratches, _dressed_matcher(f.home_dressed_ids, f.home_dressed), f.home_dressed_ids),
            ("away", (f.away_team or "").upper(), f.away_goalie, f.away_goalie_id, f.away_stars_missing,
             f.away_scratches, _dressed_matcher(f.away_dressed_ids, f.away_dressed), f.away_dressed_ids),
        ]:
            for k, v in (teams_st.get(team) or {}).items():
                if isinstance(v, (int, float)):
                    feat_values[f"{side}_{k}"] = float(v)
            goalies = goalie_st.get(team) or []
            if goalies:
                # Gardien nommé si fourni, sinon mix pondéré par usage récent
                g0 = _find_goalie(goalies, goalie_id, goalie_name)
                if g0 is None and (goalie_id is not None or (goalie_name and goalie_name.strip())):
                    _warn_unmatched("gardien partant", team,
                                    goalie_name or f"id {goalie_id}")
                if g0 is not None:
                    feat_values[f"{side}_goalie_gsax60"] = g0["gsax60"]
                    feat_values[f"{side}_goalie_svpct"]  = g0["svpct"]
                else:
                    tot = sum(g["recent_start_share"] for g in goalies) or 1.0
                    feat_values[f"{side}_goalie_gsax60"] = sum(
                        g["gsax60"] * g["recent_start_share"] for g in goalies) / tot
                    feat_values[f"{side}_goalie_svpct"] = sum(
                        g["svpct"] * g["recent_start_share"] for g in goalies) / tot
                feat_values[f"{side}_goalie_backup"] = _goalie_backup_flag(
                    goalies, goalie_name, goalie_id)
            st = stars_st.get(team) or {}
            scratch_set = {_name_key(s) for s in (scratches or []) if s and s.strip()}
            # Avec l'alignement officiel, les absents restent ceux que le
            # serveur NOMME (saisie + blessés + absents officiels de la NHL) et
            # non « tout joueur clé non habillé » : l'état d'inférence garde les
            # joueurs partis à l'intersaison (échangés, agents libres), qui ne
            # sont pas des absents. Mesuré sur CGY le 2026-10-01 : trois partis
            # (Coleman, Määttä, Brzustewicz) comptaient pour 1,55 d'absence.
            if st.get("top5"):
                if scratch_set:
                    # Noms réels connus → on retire les BONS joueurs (pas "du haut")
                    present = [p["ppg"] for p in st["top5"]
                              if _name_key(p["name"]) not in scratch_set]
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
                    sum(k["w"] for k in keys if _name_key(k["name"]) in scratch_set))

            # ── Projection bottom-up de l'alignement (P3) ────────────────────
            # Somme des contributions xG des patineurs effectivement disponibles.
            # Chaque absent retire exactement sa propre contribution, pondérée par
            # son temps de glace habituel — là où `stars_missing` ne comptait que
            # des têtes parmi un top-5 figé.
            roster = lineup_st.get(team) or []
            if is_dressed is not None:
                # Alignement officiel : on additionne exactement les habillés,
                # comme l'entraînement additionne ceux qui ont joué. Le bassin
                # (`skater_pool`, toute la ligue, par identifiant NHL) contient
                # le joueur de retour d'une longue blessure — avec ses cadences
                # d'avant la blessure — et celui arrivé d'une autre équipe, que
                # l'effectif récent (25 derniers matchs du club) ignorait.
                # Sans identifiants (état d'inférence ancien, noms seuls) : on
                # apparie par nom dans l'effectif du club, pas dans la ligue
                # (deux « Sebastian Aho » y jouent).
                if pool_st and dressed_ids:
                    avail = [pool_st[str(i)] for i in dressed_ids if str(i) in pool_st]
                else:
                    avail = [p for p in roster if is_dressed(p)]
                # Moins de 12 patineurs appariés : l'état d'inférence ne connaît
                # pas cet effectif (identifiants manquants, état périmé). Mieux
                # vaut l'ancienne projection qu'une somme amputée de moitié.
                if len(avail) < 12:
                    avail = ([p for p in roster
                              if _name_key(p.get("name", "")) not in scratch_set]
                             if roster else None)
            elif roster:
                avail = [p for p in roster
                         if _name_key(p.get("name", "")) not in scratch_set]
            else:
                avail = None
            if avail is not None:
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
                     "b2b", "3in4", "lineup_xg"):
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
        # Même ligne SANS les cotes (NaN, comme les saisons non cotées de
        # l'entraînement) : c'est elle qu'expose `probability_classifier`.
        pure = np.array([[np.nan if n in _ODDS_FEATURES else _fv(n)
                          for n in _GAME_FEAT_NAMES]], dtype=np.float32)
        pred = _xgb_game.predict(xgb.DMatrix(np.vstack([row, pure]),
                                             feature_names=_GAME_FEAT_NAMES, missing=np.nan))
        raw_prob, raw_pure = float(pred[0]), float(pred[1])
        base_prob = raw_prob
        eps = 1e-7
        p_clf_pure = _platt(raw_pure)
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

    # 4bis. Facteurs affichés — décomposition λ du match dès que le modèle de
    #       score répond (S4 ②). Les gains globaux du classifieur, calculés en
    #       3, ne restent qu'en repli : ils sont identiques pour tous les
    #       matchs de la saison.
    if score_dist is not None:
        lam_fi = _lambda_factor_importances(score_dist)
        if lam_fi:
            fi_list = lam_fi

    # 4ter. Le moneyline de base vient du modèle de score dès qu'il répond
    #       (S4 ④). Il ne sert QUE de repli : `_apply_market` price d'abord les
    #       marchés dérivables exactement, via `_apply_score_model`. Les marchés
    #       qui retombent ici — `last_team_score`, `period{1,2,3}_winner`,
    #       `winning_margin`, `double_chance` — appliquaient jusqu'ici leur
    #       coefficient à la probabilité du CLASSIFIEUR.
    #
    #       CE QUI JUSTIFIE LE CHANGEMENT, mesuré le 2026-08-25 sur la MÊME
    #       tranche de test (4 304 matchs, 2023-02-26 → 2026-04-16) :
    #
    #           modèle de score + τ   log-loss 0.6642
    #           classifieur + Platt   log-loss 0.6653
    #
    #       Le plan redoutait de perdre le « blend ⊕ marché » du classifieur en
    #       faisant ça. Au 2026-08-25, ce blend n'avait jamais été actif (pas de
    #       `blend_weights` dans `training_report.json`, faute de cotes dans la
    #       tranche de test). Depuis le backfill The Odds API il l'est : il
    #       produit `base_prob` QUAND le modèle de score ne répond pas, et
    #       seulement là. Sa log-loss mesurée sur 2025-26 (0,6843) ne bat pas le
    #       marché seul (0,6822).
    #
    #       Le jour où les cotes reviendront (A1 payant ou A1bis accumulé), le
    #       blend de S4 ① s'appliquera PAR-DESSUS `dist.p_home_win()` — c'est
    #       exactement ce que `train_score.fit_market_blend` prépare.
    #
    #       Le classifieur reste calculé en 3 : on garde sa valeur avant de
    #       l'écraser, pour l'exposer à côté de celle servie (cf. les deux
    #       champs `probability_*` de `MLResponse`). Zéro calcul en plus.
    # `probability_classifier` = le classifieur SEUL : sans cotes en entrée,
    # calibré Platt. Jusqu'au 2026-10-03 on exposait `base_prob`, qui depuis
    # que `training_report.json` porte des poids de blend était le mélange
    # classifieur ⊕ marché dès que des cotes étaient fournies — la comparaison
    # « modèle de score vs classifieur » affichée penchait donc vers le marché
    # (ml/INCOHERENCES_ML.md §10). Le blend reste le REPLI de `base_prob` quand
    # le modèle de score ne répond pas.
    p_clf = p_clf_pure if _xgb_game is not None else None
    p_score_model = None
    p_corrected = None
    if score_dist is not None:
        # `p_score_model` = la victoire du modèle de score BRUT, avant la couche
        # de correction (exposée telle quelle, `probability_score_model`).
        p_score_model = score_dist.p_home_win()
        # Couche de correction → distribution recalée (INCOHERENCES_ML §6) :
        # tous les marchés, pas seulement le moneyline, se lisent dessus.
        p_corrected = _apply_correction(p_score_model, feat_values)
        aligned = _align_distribution(score_dist, p_corrected)
        if aligned is not None:
            score_dist = aligned
            p_corrected = None        # déjà dans la distribution
        # Recalage de niveau des buts : total × k, victoire inchangée.
        leveled = _apply_level(score_dist)
        if leveled is not None:
            score_dist = leveled
        base_prob = score_dist.p_home_win()
        model_type = "Modèle de score (Poisson empilé)"
        # `model_version` identifiait l'entraînement du CLASSIFIEUR
        # (`xgb-nhl-v4.0`). L'UI affiche les deux côte à côte —
        # « v xgb-nhl-v4.0 · Modèle de score (Poisson empilé) » annonçait donc la
        # version d'un modèle qui ne produit plus cette probabilité. Champ
        # purement d'affichage, vérifié : aucun usage fonctionnel côté serveur
        # ni client.
        model_version = "score-nhl-v1.0"

    return {
        "feat_values": feat_values,
        # Victoire corrigée que le recalage n'a PAS pu intégrer à la
        # distribution (repli : servie sur le seul marché `moneyline`, comme
        # avant). None dans le cas normal — la correction est dans `score_dist`.
        "p_home_corrected": p_corrected,
        "score_dist": score_dist, "base_prob": base_prob, "win_diff": win_diff,
        "gf_diff": gf_diff, "form_diff": form_diff,
        "lam_home": lam_home, "lam_away": lam_away,
        "model_type": model_type, "model_version": model_version, "fi_list": fi_list,
        "p_score_model": p_score_model, "p_clf": p_clf,
        # Ensemble bootstrap construit à la demande, UNE fois, orienté domicile.
        "_ens": None, "_ens_built": False,
    }


def _home_ensemble(ctx: dict):
    """Ensemble bootstrap du match, orienté DOMICILE, construit une seule fois.

    L'ancien code le reconstruisait à chaque requête à partir de la
    distribution DÉJÀ tournée vers le sujet : pour un sujet visiteur, les λ des
    membres restaient orientés domicile alors que `p_ot_home` était inversé, et
    σ mesurait un mélange des deux orientations. Ici les membres restent côté
    domicile, et chaque marché est lu à travers `_subject_view`.
    """
    if not ctx["_ens_built"]:
        ctx["_ens"] = _build_score_ensemble(ctx["score_dist"])
        ctx["_ens_built"] = True
    return ctx["_ens"]


def _price_game_market(ctx: dict, f: GameFeatures) -> MLResponse:
    """Prix d'UN marché à partir du contexte du match."""
    score_dist    = ctx["score_dist"]
    base_prob     = ctx["base_prob"]
    win_diff      = ctx["win_diff"]
    gf_diff       = ctx["gf_diff"]
    form_diff     = ctx["form_diff"]
    lam_home      = ctx["lam_home"]
    lam_away      = ctx["lam_away"]
    model_type    = ctx["model_type"]
    model_version = ctx["model_version"]
    fi_list       = ctx["fi_list"]
    p_score_model = ctx["p_score_model"]
    p_clf         = ctx["p_clf"]

    # ── Point de vue du SUJET ────────────────────────────────────────────────
    # `home_team`/`away_team` décrivent le match ; `subject_is_home` dit de quel
    # côté est la question. Tout ce qui suit est exprimé pour le sujet : la
    # matrice jointe est transposée, et les entrées des heuristiques (λ,
    # probabilité de base, écart de win%) sont échangées avec elle.
    if not f.subject_is_home:
        score_dist = _subject_view(score_dist, False) if score_dist is not None else None
        base_prob  = 1.0 - base_prob
        win_diff   = -win_diff
        lam_home, lam_away = lam_away, lam_home

    try:
        prob, conf_mult, explanation = _apply_market(
            f.market_type, base_prob, f, win_diff, lam_home, lam_away, model_type,
            dist=score_dist,
        )
    except _NoEstimate as e:
        raise HTTPException(
            status_code=422,
            detail={"error": "no_estimate", "market": e.market,
                    "message": "No estimate available for this market with the data provided"},
        )

    # 4ter-bis. Moneyline : la couche de correction est d'ordinaire déjà dans
    #          la distribution (`_align_distribution`). On le dit ; et si le
    #          recalage a échoué, on retombe sur l'ancien remplacement du seul
    #          moneyline, vu du sujet.
    raw = getattr(ctx["score_dist"], "raw_lambdas", None) if ctx["score_dist"] is not None else None
    if f.market_type == "moneyline" and raw is not None and p_score_model is not None:
        p_raw = p_score_model if f.subject_is_home else 1.0 - p_score_model
        explanation = (f"{explanation} Corrigé (forme, fatigue, alignement, ELO) : "
                       f"{int(p_raw * 100)}% → {int(prob * 100)}% ; tous les marchés "
                       f"du match suivent (λ bruts {raw[0]:.2f}/{raw[1]:.2f}).")
    p_corr = ctx.get("p_home_corrected")
    if f.market_type == "moneyline" and p_corr is not None:
        p_subject = p_corr if f.subject_is_home else 1.0 - p_corr
        explanation = (f"{explanation} Corrigé (forme, fatigue, alignement, ELO) : "
                       f"{int(prob * 100)}% → {int(p_subject * 100)}%.")
        prob = p_subject

    # 4quater. Côté « non » d'un marché binaire (cf. `_BINARY_MARKETS`). Le
    #          complément est pris APRÈS `_apply_market`, donc après son clamp.
    if _is_negative_side(f):
        prob = 1.0 - prob
        explanation = (f"Côté « moins » = 100 − P(plus). {explanation}"
                       if f.market_type in _OVER_UNDER_MARKETS
                       else f"Côté « non » = 100 − P(oui). {explanation}")

    # 5. Incertitude d'estimation (P4) — σ sur le marché effectivement servi,
    #    lu sur les membres de l'ensemble vus du côté du sujet.
    prob_std = uncertainty = None
    market_fn = _score_market_fn(f.market_type, f) if score_dist is not None else None
    ens = _home_ensemble(ctx) if market_fn is not None else None
    if ens is not None and market_fn is not None:
        fn = market_fn if f.subject_is_home else (lambda d, _fn=market_fn: _fn(_subject_view(d, False)))
        _, sd = ens.spread(fn)
        if np.isfinite(sd):
            prob_std = round(sd * 100.0, 2)      # en points de pourcentage
            uncertainty = round(min(1.0, sd / _score_sigma_max), 4)

    # 6. Confidence = force du signal × multiplicateur du marché (cf. S4 ③).
    base_conf = _confidence_from_lambdas(score_dist)
    if base_conf is None:
        magnitude = abs(win_diff) * 2 + abs(gf_diff) / 3 + abs(form_diff)
        base_conf = clamp(0.55 + magnitude * 0.25, _CONF_MIN, _CONF_MAX)
    confidence = int(clamp(base_conf * conf_mult, 0.38, 0.90) * 100)

    return MLResponse(
        probability=round(prob * 100),
        probability_exact=round(float(prob), 6),
        confidence=confidence,
        feature_importances=fi_list[:5],
        model_version=model_version,
        model_type=model_type,
        explanation=explanation,
        probability_std=prob_std,
        uncertainty=uncertainty,
        probability_score_model=(None if p_score_model is None
                                 else int(round(p_score_model * 100))),
        probability_classifier=(None if p_clf is None
                                else int(round(p_clf * 100))),
    )


@app.post("/predict/game", response_model=MLResponse, dependencies=_PROTECTED)
def predict_game(f: GameFeatures) -> MLResponse:
    return _price_game_market(_game_context(f), f)


# ── Paquet d'un match : tous ses marchés en UNE requête ───────────────────────
#
# La page d'un match affiche ~95 tuiles. Chacune faisait sa requête : Node
# reconstruisait les features du match, ce service refaisait tourner le
# classifieur, le modèle de score et l'ensemble bootstrap — pour les MÊMES λ à
# chaque fois, seule la dernière ligne (la lecture du marché) changeant. Avec
# 2 workers et une limite de 60 requêtes/minute côté Node, la moitié des tuiles
# finissait en 429 et en « — ».
#
# Ici : un contexte, N lectures. Un marché qu'on ne sait pas pricer rend `null`
# pour SA case, sans faire échouer le paquet.

def _player_rates(ctx: dict, f: GameFeatures, home_ids: list[str], away_ids: list[str]) -> dict:
    """Cadence par match de chaque joueur des deux alignements, pour CE match.

    L'état du joueur (rôle, talent, coéquipiers) vient de `player_state.json` ;
    le contexte (forces des deux équipes, gardiens, repos) vient des MÊMES
    features que le modèle de score, déjà calculées pour le paquet. Aucun appel,
    aucune lecture en plus : un DMatrix de ~40 lignes par statistique.

    Un joueur absent de l'état (recrue sans match LNH) est simplement omis —
    Node lui garde la règle.
    """
    if not _player_models or not _player_state:
        return {}
    fv = ctx.get("feat_values") or {}
    players = _player_state.get("players", {})
    ids, rows = [], []
    for side, other, pids in (("home", "away", home_ids), ("away", "home", away_ids)):
        for pid in pids:
            st = players.get(str(pid))
            if not st:
                continue
            row = dict(st["f"])
            row["is_home"] = 1 if side == "home" else 0
            row["is_D"] = 1 if st.get("pos") == "D" else 0
            row["b2b"] = float(getattr(f, f"{side}_b2b", 0) or 0)
            row["days_rest"] = float(getattr(f, f"{side}_rest_days", 2) or 2)
            for c in _PLAYER_TEAM_COLS:
                row[f"tm_{c}"] = fv.get(f"{side}_{c}")
                row[f"opp_{c}"] = fv.get(f"{other}_{c}")
            ids.append(str(pid))
            rows.append([np.nan if row.get(n) is None else float(row[n]) for n in _player_feats])
    if not rows:
        return {}
    dmat = xgb.DMatrix(np.array(rows, dtype=np.float32), feature_names=_player_feats, missing=np.nan)
    out: dict[str, dict[str, float]] = {i: {} for i in ids}
    for stat, bst in _player_models.items():
        for i, mu in zip(ids, bst.predict(dmat)):
            out[i][stat] = round(float(mu), 4)
    return out


class BundlePlayers(BaseModel):
    home: List[str] = Field(default_factory=list, max_length=60)
    away: List[str] = Field(default_factory=list, max_length=60)


class BundleMarket(BaseModel):
    id: str = Field(..., max_length=64)
    market_type: str = Field(..., max_length=40)
    line: Optional[float] = None
    selection: Optional[str] = Field(None, max_length=40)
    subject_is_home: bool = True


class GameBundleRequest(BaseModel):
    features: GameFeatures
    markets: List[BundleMarket] = Field(..., max_length=300)
    # Identifiants NHL des deux effectifs : le paquet renvoie alors aussi les
    # cadences du modèle joueur, dans la MÊME réponse.
    players: Optional[BundlePlayers] = None


class GameBundleResponse(BaseModel):
    results: dict[str, Optional[MLResponse]]
    lambda_home: Optional[float] = None
    lambda_away: Optional[float] = None
    # { playerId: { stat: cadence par match } } — modèle joueur.
    player_rates: dict[str, dict[str, float]] = Field(default_factory=dict)
    # k de la binomiale négative par stat ; `null` = Poisson.
    player_dispersion: dict[str, Optional[float]] = Field(default_factory=dict)
    player_model_as_of: Optional[str] = None


@app.post("/predict/game/bundle", response_model=GameBundleResponse, dependencies=_PROTECTED)
def predict_game_bundle(req: GameBundleRequest) -> GameBundleResponse:
    ctx = _game_context(req.features)     # 422 si aucune donnée sur le match
    results: dict[str, Optional[MLResponse]] = {}
    for m in req.markets:
        f = req.features.model_copy(update={
            "market_type": m.market_type, "line": m.line,
            "selection": m.selection, "subject_is_home": m.subject_is_home,
        })
        try:
            results[m.id] = _price_game_market(ctx, f)
        except HTTPException:
            results[m.id] = None
    dist = ctx["score_dist"]
    rates = {}
    if req.players is not None:
        rates = _player_rates(ctx, req.features, req.players.home, req.players.away)
    return GameBundleResponse(
        results=results,
        lambda_home=None if dist is None else round(dist.lam_home, 4),
        lambda_away=None if dist is None else round(dist.lam_away, 4),
        player_rates=rates,
        player_dispersion=dict(_player_k) if rates else {},
        player_model_as_of=_player_state.get("as_of") if rates else None,
    )

# ── Player prop model ─────────────────────────────────────────────────────────

# Props joueur qui sont un ÉVÉNEMENT par match (0 ou 1), pas un comptage.
_BINARY_PLAYER_PROPS = {"wins", "shutouts"}


@app.post("/predict/player", response_model=MLResponse, dependencies=_PROTECTED)
def predict_player(f: PlayerPropFeatures) -> MLResponse:
    rate_map = {
        "goals":    f.goals_per_game,
        "assists":  f.assists_per_game,
        "points":   f.points_per_game,
        "shots":    f.shots_per_game,
        "pp_point": f.pp_points_per_game,      # mesuré ; None → pas d'estimation
        # Physical / goalie props — rate injected via shots_per_game by Node.js
        "hits":     f.shots_per_game,
        "blocks":   f.shots_per_game,
        "pim":      f.shots_per_game,
        "saves":    f.shots_per_game,
        "wins":     f.shots_per_game,
        "shutouts": f.shots_per_game,
    }
    if f.prop_type not in rate_map or rate_map[f.prop_type] is None:
        # `rate_map.get(..., f.goals_per_game)` servait la cadence de BUTS sous
        # le nom du marché demandé. Un marché qu'on ne sait pas pricer n'a pas
        # de chiffre, il a une absence de chiffre.
        raise HTTPException(
            status_code=422,
            detail={"error": "no_estimate", "market": f.prop_type,
                    "message": "No estimate available for this prop type"},
        )
    rate = rate_map[f.prop_type]

    # Victoire et blanchissage d'un gardien sont des événements OUI/NON sur un
    # match : la « cadence » reçue est une PROBABILITÉ (part de ses matchs). En
    # Poisson, une cadence de 0,50 donnait P(≥ 1) = 1 − e^−0,5 = 39 % au lieu de
    # 50 % (ml/INCOHERENCES_ML.md §12). Au plus 1 par match : au-delà d'une
    # ligne de 1, « plus » est impossible.
    binary = f.prop_type in _BINARY_PLAYER_PROPS
    if binary:
        raw_over = clamp(rate, 0.0, 1.0) if f.line < 1 else 0.0
    else:
        raw_over = poisson_over(f.line, rate)
    prob = raw_over if f.selection == "over" else 1.0 - raw_over
    prob = clamp(prob, 0.05, 0.95)

    # Confidence: grows with games played (sample size)
    confidence = clamp(0.40 + f.games_played / 82 * 0.50, 0.42, 0.88)

    pace_vs_line = (rate - f.line) / max(f.line, 0.1)

    importances = sorted([
        FeatureImportance(name=(f"{f.prop_type.capitalize()} rate/game (league avg)"
                                if f.rate_is_league_average
                                else f"{f.prop_type.capitalize()} rate/game"),
                          importance=round(rate, 3), direction="positive" if rate > f.line else "negative"),
        FeatureImportance(name="Sample size (GP)",                       importance=round(f.games_played / 82, 3), direction="positive"),
        FeatureImportance(name="Pace vs line",                           importance=round(abs(pace_vs_line), 3),   direction="positive" if pace_vs_line > 0 else "negative"),
        FeatureImportance(name="Points/game",                            importance=round(f.points_per_game, 3),   direction="positive" if f.points_per_game > 0.5 else "negative"),
        FeatureImportance(name="Shots/game",                             importance=round(f.shots_per_game / 5, 3), direction="positive" if f.shots_per_game > 2.5 else "negative"),
    ], key=lambda x: x.importance, reverse=True)

    over_under = f.selection.upper()
    # Ne JAMAIS attribuer au joueur une cadence qu'on n'a pas mesurée sur lui.
    if binary:
        source = ("NHL average for goalies — no per-goalie data" if f.rate_is_league_average
                  else "share of this goalie's games")
        explanation = (f"Yes/no event: {f.prop_type} in {rate:.0%} of games ({source}); "
                       f"{over_under} {f.line} implied at {round(prob*100)}%.")
    elif f.rate_is_league_average:
        explanation = (f"Poisson model: NHL average is {rate:.2f} {f.prop_type}/game for this "
                       f"position — no per-player data available for this stat, so every player "
                       f"gets the same number; {over_under} {f.line} implied at {round(prob*100)}%.")
    else:
        explanation = (f"Poisson model: player averages {rate:.2f} {f.prop_type}/game; "
                       f"{over_under} {f.line} implied at {round(prob*100)}%.")
    return MLResponse(
        probability=round(prob * 100),
        probability_exact=round(float(prob), 6),
        confidence=round(confidence * 100),
        feature_importances=importances[:5],
        model_version="poisson-v1.1",
        model_type="Bernoulli (yes/no)" if binary else "Poisson Distribution",
        explanation=explanation,
    )

# ── Team futures model ────────────────────────────────────────────────────────

RANK_PRIORS: dict[str, list[float]] = {
    "cup":     [.28,.20,.15,.11,.08,.06,.04,.03,.02,.01,.01,.01,.005,.005,.003,.002],
    "conf":    [.38,.30,.23,.18,.13,.09,.07,.05,.04,.03,.02,.01,.01,.01,.005,.003],
    "playoff": [.97,.95,.91,.85,.77,.68,.56,.43,.30,.20,.12,.07,.04,.02,.01,.005],
}

@app.post("/predict/team", response_model=MLResponse, dependencies=_PROTECTED)
def predict_team(f: TeamFuturesFeatures) -> MLResponse:
    if f.pk_pct is None: f.pk_pct = LEAGUE_PK_PCT
    if f.pp_pct is None: f.pp_pct = LEAGUE_PP_PCT
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
        probability=round(prob * 100),
        probability_exact=round(float(prob), 6),
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
            # Le modèle joueur entraîné sert les cadences du paquet de match ;
            # `/predict/player` reste une loi de Poisson / oui-non sur la
            # cadence envoyée par le serveur.
            "player": ("XGBoost count:poisson (cadences du paquet) + Poisson (/predict/player)"
                       if _player_models else "Poisson Distribution"),
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
        "goal_level_k": _level_k_now(),
        "elo_teams_loaded": len(_elo_ratings),
        "calibrated":       _platt_a is not None,
        # Seulement quand il manque vraiment un modèle : affiché en jaune sur
        # /dev/ml, il poussait à relancer un entraînement alors que XGBoost était
        # chargé (QA_TEST_PLAN.md, observation du 2026-08-31).
        "tip": (None if (_xgb_game is not None and _xgb_score is not None)
                else "Lance fetch_data.py puis train.py pour activer XGBoost (models/*.json)."),
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
    "level_report",
)

# Fichiers dont on ne veut QUE la fraîcheur et la taille (trop gros à renvoyer).
_ARTIFACT_FILES = (
    "game_model",
    "score_model",
    "inference_state",
    "score_ablation_cache",
    "fold_params_cache",
    "level_layer",
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
            "goal_level_k": _level_k_now(),
            "goal_level_layer": _level_layer,
        },
    }


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("ml_service:app", host="0.0.0.0", port=8000, reload=True)
