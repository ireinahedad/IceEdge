"""
game_dynamics.py — dynamique du match : τ glissant et intensités par période
============================================================================

Deux réglages du modèle de score, ajustés sur les **3 dernières saisons
complètes**, écrits dans `ml/models/game_dynamics.json` et lus par
`ml_service` au démarrage. Mesures et choix : `ml/EXPLORATION_SCORE.md`
(2026-10-15). Trois usages, adoptés dans cet ordre.

1. τ glissant (correction de marge)
-----------------------------------
`train_score.py` ajuste τ sur l'entraînement, soit 2008-2021. Or le jeu de fin
de match a changé — les gardiens sortent plus tôt et plus souvent :

    écart ±1 après 60'      23,2 % (2010-14) → 17,9 % (2023-25)
    écart ±3 après 60'      19,8 %           → 23,6 %
    buts en filet désert     3,8 %           →  6,0 %

Le τ de 2008-2021 prédisait encore ≈ 21 % d'écarts ±1 sur 2023-26. Ré-ajusté
sur les 3 saisons précédentes : score exact z −2,6 sur le test, aucun marché
servi dégradé. Même formule que `score_model.fit_margin_correction`, seules les
saisons changent. Les λ de la fenêtre sont ceux du modèle SERVI : ces saisons
sont dans sa tranche de test (`train_score.split` réserve les 20 % les plus
récents), donc hors de son entraînement.

2. Intensités par période (marchés de période)
----------------------------------------------
Intensité de but par seconde d'une équipe :

    r(t) = λ_équipe / 3600 × c(avance de l'équipe, tranche de temps)

`c` est mesuré sur `live_goals.csv` : buts observés dans la case ÷ (exposition
en secondes × λ/3600). Tranches : P1, P2, P3 0-10', 10-15', puis minute par
minute de 55' à 60' ; avance bornée à ±3. Le filet désert y est explicite :
mené d'un but, la dernière minute vaut ×2,5 pour l'équipe sans gardien, et
×7 pour celle qui mène (97 % de ces buts sont dans le filet vide).

`c` est rendu **relatif** (Σ exposition·c = Σ buts attendus par λ) : il porte
la FORME du match, pas son niveau — le niveau reste l'affaire de λ et de
`level_layer.json`. Sans ça, une saison où λ surestime les buts ferait baisser
c, et le recalage de niveau serait compté deux fois.

La loi exacte de la chaîne sur l'état (avance, buts P1, buts P2, buts P3)
donne alors, pour un match :
  - qui mène après P1 / P2 (et l'égalité) ;
  - la loi des buts de chaque période ;
  - la période la plus prolifique.
L'ancienne heuristique (Poisson de part fixe 30,5 / 36,5 / 33 %) ignorait que
la 3e période dépend du score à 40' : P3 > 1,5 prédit 58,6 % pour 65,0 %
observé. Le moteur dit 63,2 %. Mesuré sur 4 201 matchs du test 2023-26,
niveau recalé (`explore_score/s7_marches_periode.py`) : période la plus
prolifique z −5,1, P3 > 0,5 / 1,5 / 2,5 z −4,7 / −5,5 / −4,0, P2 > 2,5
z −4,2, vainqueurs après P1 / P2 neutres (|z| < 1).

3. Le match entier (moneyline, puck line, totaux, score exact…)
---------------------------------------------------------------
Le même moteur, sur l'état (buts dom, buts ext), rend la matrice du score
réglementaire (`regulation_matrix`) — sans τ : le filet désert et l'égalisation
gardien sorti y sont joués, pas corrigés après coup. Walk-forward 2013-2025
(`explore_score/s6_walkforward_match.py`, critère fixé avant le run) contre
Poisson × τ glissant : score exact −0,0032 (z −4,0, 11 saisons sur 13),
moneyline, puck line, nul 60', plus de 5,5 / 6,5 tous |z| < 1. ADOPTÉ :
`ml_service` passe `MatchDynamics` à `ScoreDistribution` à la place du dict τ.
Retour arrière sans redéploiement de modèle : SCORE_SHAPE=tau_window (τ
glissant) ou tau_train (τ 2008-2021).

La loi est résolue exactement (uniformisation, cf. plus bas) : ≈ 1,6 ms par
matrice, ≈ 16 ms pour la vue par période.

Usage :
    cd ml/python
    python game_dynamics.py            # écrit ../models/game_dynamics.json
    python game_dynamics.py --check    # contrôles internes du fichier en place
Appelé aussi par `refresh_data.py` (chaque lundi) et à la fin de
`train_score.py` (un nouveau modèle = de nouveaux λ).
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone

import numpy as np

from score_model import MAX_GOALS, fit_margin_correction, joint_matrix

# ── Constantes partagées par l'ajustement et le service ──────────────────────

# Bornes des tranches de temps, en secondes de temps réglementaire.
EDGES = (0, 1200, 2400, 3000, 3300, 3360, 3420, 3480, 3540, 3600)
BUCKET_LABELS = ("P1", "P2", "P3 0-10", "P3 10-15", "55-56", "56-57",
                 "57-58", "58-59", "59-60")
N_BUCKETS = len(EDGES) - 1
LEAD_CLIP = 3                      # avance de l'équipe bornée à ±3 dans c
N_LEADS = 2 * LEAD_CLIP + 1
PRIOR_SECONDS = 200.0              # rétrécissement d'une case vers sa tranche
WINDOW_SEASONS = 3
C_MIN, C_MAX = 0.05, 20.0          # garde-fous de lecture

# Grille du moteur de période : avance ±8 (repliée au bord), ≤ 9 buts par période.
_LMAX = 8
_GMAX = 9
_LEADS = np.arange(-_LMAX, _LMAX + 1)


def season_of(date: str) -> int:
    """Saison NHL d'une date ISO : août-décembre → année, sinon année − 1."""
    y, m = int(str(date)[:4]), int(str(date)[5:7])
    return y if m >= 8 else y - 1


# ── Ajustement ───────────────────────────────────────────────────────────────

def fit_cells(games, goals) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Multiplicateurs c(avance, tranche), RELATIFS, et leurs comptes.

    `games` : DataFrame avec game_id, lam_h, lam_a — uniquement des matchs dont
              les buts horodatés de `goals` sont complets.
    `goals` : `live_goals.csv` (game_id, period, time, home_scored,
              home_before, away_before, empty_net), périodes 1-3.

    Retourne (c, buts, exposition, buts_filet_désert), chacun (N_LEADS, N_BUCKETS).
    """
    sec_b = np.searchsorted(np.array(EDGES), np.arange(3600), side="right") - 1
    expo = np.zeros((N_LEADS, N_BUCKETS))
    gl = np.zeros((N_LEADS, N_BUCKETS))
    en = np.zeros((N_LEADS, N_BUCKETS))
    g = goals[goals["game_id"].isin(games["game_id"])].sort_values(["game_id", "time"])
    by = {k: v for k, v in g.groupby("game_id")}
    for r in games.itertuples():
        lead = np.zeros(3600, dtype=int)          # avance du domicile, seconde par seconde
        gg = by.get(r.game_id)
        if gg is not None:
            for t, hs, hb, ab, e in zip(gg["time"].values, gg["home_scored"].values,
                                        gg["home_before"].values, gg["away_before"].values,
                                        gg["empty_net"].values):
                t = min(int(t), 3599)
                lead[t + 1:] += 1 if hs else -1
                d = (hb - ab) if hs else (ab - hb)     # avance du buteur AVANT le but
                li, b = int(np.clip(d, -LEAD_CLIP, LEAD_CLIP)) + LEAD_CLIP, sec_b[t]
                gl[li, b] += 1
                en[li, b] += e
        for lam, sgn in ((r.lam_h, 1), (r.lam_a, -1)):
            li = np.clip(sgn * lead, -LEAD_CLIP, LEAD_CLIP) + LEAD_CLIP
            np.add.at(expo, (li, sec_b), lam / 3600.0)
    col = gl.sum(0) / np.maximum(expo.sum(0), 1e-12)
    c = (gl + PRIOR_SECONDS / 3600.0 * col[None]) / (expo + PRIOR_SECONDS / 3600.0)
    c = c * expo.sum() / (expo * c).sum()          # relatif : le niveau reste à λ
    return c, gl, expo, en


def expected_margin_pmf(lam_h, lam_a, max_abs: int = 6) -> dict[int, float]:
    """Loi moyenne des écarts sous Poisson indépendant, match par match."""
    idx = np.arange(MAX_GOALS + 1)
    margin = idx[:, None] - idx[None, :]
    acc = {d: 0.0 for d in range(-max_abs, max_abs + 1)}
    for lh, la in zip(lam_h, lam_a):
        M = joint_matrix(lh, la)
        for d in acc:
            acc[d] += float(M[margin == d].sum())
    n = max(len(lam_h), 1)
    return {d: v / n for d, v in acc.items()}


def fit(games_csv: str, goals_csv: str, models_dir: str,
        current_season: int | None = None, verbose: bool = True) -> dict:
    """Ajuste τ et c sur les 3 dernières saisons complètes, avec les λ du
    modèle servi. Ne lit que des fichiers locaux ; n'écrit rien."""
    import pandas as pd
    import xgboost as xgb
    import train_score as TS

    with open(os.path.join(models_dir, "score_report.json"), encoding="utf-8") as fh:
        feats = list(json.load(fh)["features"])
    if feats != TS.stacked_features():
        raise ValueError("features de score_report.json ≠ train_score.stacked_features()")
    model_path = os.path.join(models_dir, "score_model.json")
    model = xgb.Booster()
    model.load_model(model_path)
    with open(model_path, "rb") as fh:
        model_md5 = hashlib.md5(fh.read()).hexdigest()

    df = pd.read_csv(games_csv, low_memory=False)
    df = df.dropna(subset=["home_reg_score", "away_reg_score", "date"]).reset_index(drop=True).copy()
    df["season_"] = df["date"].map(season_of)
    if current_season is None:
        current_season = season_of(datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    goals = pd.read_csv(goals_csv)
    goals = goals[goals["period"] <= 3]
    goals_seasons = set((goals["game_id"] // 1_000_000).unique())

    # Fenêtre : les 3 dernières saisons COMPLÈTES présentes dans les deux fichiers.
    done = sorted(s for s in df["season_"].unique() if s < current_season and s in goals_seasons)
    window = done[-WINDOW_SEASONS:]
    if len(window) < WINDOW_SEASONS:
        raise ValueError(f"moins de {WINDOW_SEASONS} saisons complètes disponibles ({window})")
    w = df[df["season_"].isin(window)].reset_index(drop=True).copy()
    lam_h, lam_a = TS.lambdas_for(model, feats, TS.stack(w), len(w))
    w["lam_h"], w["lam_a"] = lam_h, lam_a
    w = w[(w["lam_h"].between(0.5, 8.0)) & (w["lam_a"].between(0.5, 8.0))].reset_index(drop=True).copy()
    hr, ar = w["home_reg_score"].astype(int).values, w["away_reg_score"].astype(int).values

    # ── τ glissant ──
    tau = fit_margin_correction(hr - ar, expected_margin_pmf(w["lam_h"], w["lam_a"]))

    # ── c : matchs dont les buts horodatés sont complets ──
    cnt = goals.groupby("game_id").size()
    w["n_goals_timed"] = w["game_id"].map(cnt).fillna(0).astype(int)
    timed = w[w["n_goals_timed"] == hr + ar].reset_index(drop=True)
    c, gl, expo, en = fit_cells(timed, goals)

    m = hr - ar
    out = {
        "version": 1,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "window_seasons": [int(s) for s in window],
        "n_games": int(len(w)),
        "n_games_timed": int(len(timed)),
        "score_model_md5": model_md5,
        "tau_margin": {str(k): round(float(v), 5) for k, v in tau.items()},
        "cells": {
            "edges": list(EDGES),
            "bucket_labels": list(BUCKET_LABELS),
            "lead_clip": LEAD_CLIP,
            "prior_seconds": PRIOR_SECONDS,
            "relative": True,
            "c": [[round(float(x), 5) for x in row] for row in c],
        },
        "diagnostics": {
            "goals": int(gl.sum()),
            "empty_net_share": round(float(en.sum() / max(gl.sum(), 1)), 4),
            "margin_observed": {str(d): round(float(np.mean(np.clip(np.abs(m), 0, 4) == d)), 4)
                                for d in range(5)},
            "mean_lambda_total": round(float((w["lam_h"] + w["lam_a"]).mean()), 4),
            "mean_goals_total": round(float((hr + ar).mean()), 4),
        },
    }
    if verbose:
        print(f"\n🧭 Dynamique du match — fenêtre {window[0]}-{window[-1]} : {len(w)} matchs, "
              f"{len(timed)} horodatés, {int(gl.sum())} buts "
              f"({out['diagnostics']['empty_net_share']:.1%} en filet désert)")
        print("   τ glissant : " + "  ".join(f"{d:+d}:{tau[d]:.3f}" for d in range(-4, 5)))
        li = {d: d + LEAD_CLIP for d in (-1, 1)}
        print(f"   c, dernière minute : mené d'un but ×{c[li[-1], -1]:.2f}, "
              f"mène d'un but ×{c[li[1], -1]:.2f}")
    return out


def write(out: dict, models_dir: str) -> str:
    """Écrit `game_dynamics.json` — seulement s'il passe la lecture du service
    et les contrôles du moteur : mieux vaut garder l'ancien fichier."""
    tau, c = read_game_dynamics(out)
    if tau is None or c is None:
        raise ValueError("réglages refusés par read_game_dynamics — fichier non écrit")
    sanity_check(c)
    path = os.path.join(models_dir, "game_dynamics.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    return path


# ── Lecture (service) ────────────────────────────────────────────────────────

def read_game_dynamics(d: dict | None) -> tuple[dict[int, float] | None, np.ndarray | None]:
    """(τ, c) lus dans `game_dynamics.json`, chacun None s'il est douteux.

    Tout est vérifié : un fichier tronqué ou d'une autre version des tranches
    ne doit pas pricer. τ et c sont indépendants — l'un peut être refusé sans
    l'autre.
    """
    if not isinstance(d, dict):
        return None, None
    tau = None
    try:
        t = {int(k): float(v) for k, v in (d.get("tau_margin") or {}).items()}
        if t and all(np.isfinite(v) and 0.25 <= v <= 4.0 for v in t.values()) and 0 in t:
            tau = t
    except (TypeError, ValueError):
        tau = None
    c = None
    try:
        cells = d["cells"]
        arr = np.array(cells["c"], dtype=float)
        if (tuple(cells["edges"]) == EDGES and int(cells["lead_clip"]) == LEAD_CLIP
                and cells.get("relative") is True
                and arr.shape == (N_LEADS, N_BUCKETS) and np.all(np.isfinite(arr))
                and arr.min() >= C_MIN and arr.max() <= C_MAX):
            c = arr
    except (KeyError, TypeError, ValueError):
        c = None
    return tau, c


# ── Moteur : chaîne de Markov en temps continu, résolue exactement ──────────
#
# Dans une tranche de temps, les intensités ne dépendent que de l'avance : le
# score suit une chaîne de Markov à temps continu. Sa loi au bout de la tranche
# s'obtient EXACTEMENT par uniformisation (Jensen) : avec Λ ≥ toute intensité
# totale de la tranche,
#     P(t) = Σ_k  e^{-Λt} (Λt)^k / k!  ·  P(0) · (I + Q/Λ)^k
# série tronquée quand la masse restante passe sous 1e-12. Environ 60 produits
# par match au lieu des 720 pas de 5 s d'un schéma explicite — dont l'erreur
# de discrétisation (≈ 5e-4 sur P(nul)) disparaît au passage.

_TRUNC = 1e-12


def _poisson_weights(mu: float) -> np.ndarray:
    """e^{-μ} μ^k / k! pour k = 0..K, K tel que la queue < _TRUNC."""
    w = [np.exp(-mu)]
    acc, k = w[0], 0
    while 1.0 - acc > _TRUNC and k < 400:
        k += 1
        w.append(w[-1] * mu / k)
        acc += w[-1]
    return np.array(w)


def _shift(x: np.ndarray, axis: int) -> np.ndarray:
    """Décale d'un cran vers le haut le long de `axis`, masse du bord repliée."""
    y = np.zeros_like(x)
    src = [slice(None)] * x.ndim
    dst = [slice(None)] * x.ndim
    src[axis], dst[axis] = slice(0, -1), slice(1, None)
    y[tuple(dst)] = x[tuple(src)]
    last = [slice(None)] * x.ndim
    last[axis] = -1
    y[tuple(last)] += x[tuple(last)]
    return y


def _evolve(S: np.ndarray, rate_a: np.ndarray, rate_b: np.ndarray, t: float, jump) -> np.ndarray:
    """Loi de l'état après `t` secondes. `rate_a`/`rate_b` : intensités (/s)
    diffusables sur S ; `jump(x, team)` applique un but de l'équipe à la masse x."""
    tot = rate_a + rate_b
    lam = float(tot.max())
    if lam <= 0.0 or t <= 0.0:
        return S
    pa, pb, stay = rate_a / lam, rate_b / lam, 1.0 - tot / lam
    out = np.zeros_like(S)
    v = S
    for wk in _poisson_weights(lam * t):
        out += wk * v
        v = v * stay + jump(v * pa, "a") + jump(v * pb, "b")
    return out


def _lead_rates(c: np.ndarray, bucket: int) -> tuple[np.ndarray, np.ndarray]:
    """Multiplicateurs de l'équipe A (avance +L) et B (avance −L) par état."""
    ca = c[np.clip(_LEADS, -LEAD_CLIP, LEAD_CLIP) + LEAD_CLIP, bucket]
    cb = c[np.clip(-_LEADS, -LEAD_CLIP, LEAD_CLIP) + LEAD_CLIP, bucket]
    return ca, cb


def period_dynamics(lam_a: float, lam_b: float, c: np.ndarray) -> dict:
    """Loi du match période par période, vue de l'équipe A (λ = lam_a).

    État : (avance de A, buts P1, buts P2, buts P3). Retourne :
      lead_after[1|2] : P(avance de A = L) pour L ∈ [−8, 8] (bords repliés)
      goals[1|2|3]    : P(n buts dans la période), n ∈ [0, 9]
      highest         : {"P1", "P2", "P3", "tie"} — période STRICTEMENT la plus
                        prolifique, ou égalité en tête
    """
    S = np.zeros((len(_LEADS), _GMAX + 1))
    S[_LMAX, 0] = 1.0
    out = {"lead_after": {}, "goals": {}}
    periods = ((0, 1200), (1200, 2400), (2400, 3600))
    for period, (t0, t1) in enumerate(periods, start=1):
        if period > 1:                          # nouvel axe « buts de la période »
            S = np.concatenate([S[..., None], np.zeros(S.shape + (_GMAX,))], axis=-1)
        g_axis = S.ndim - 1
        bshape = (len(_LEADS),) + (1,) * (S.ndim - 1)

        def jump(x, team, g_axis=g_axis):
            x = _shift(x, g_axis)               # un but de plus dans la période
            y = np.zeros_like(x)
            if team == "a":                     # avance de A + 1, bord replié
                y[1:] = x[:-1]
                y[-1] += x[-1]
            else:
                y[:-1] = x[1:]
                y[0] += x[0]
            return y

        for b in range(N_BUCKETS):
            lo, hi = max(EDGES[b], t0), min(EDGES[b + 1], t1)
            if hi <= lo:
                continue
            ca, cb = _lead_rates(c, b)
            ra = (float(lam_a) / 3600.0 * ca).reshape(bshape) * np.ones_like(S)
            rb = (float(lam_b) / 3600.0 * cb).reshape(bshape) * np.ones_like(S)
            S = _evolve(S, ra, rb, hi - lo, jump)
        if period < 3:
            out["lead_after"][period] = S.sum(axis=tuple(range(1, S.ndim)))
    S = S / S.sum()
    G = S.sum(axis=0)                           # (g1, g2, g3)
    out["goals"] = {1: G.sum((1, 2)), 2: G.sum((0, 2)), 3: G.sum((0, 1))}
    g = np.arange(_GMAX + 1)
    g1, g2, g3 = np.meshgrid(g, g, g, indexing="ij")
    hi_ = {"P1": float(G[(g1 > g2) & (g1 > g3)].sum()),
           "P2": float(G[(g2 > g1) & (g2 > g3)].sum()),
           "P3": float(G[(g3 > g1) & (g3 > g2)].sum())}
    hi_["tie"] = max(0.0, 1.0 - sum(hi_.values()))
    out["highest"] = hi_
    out["lead_values"] = _LEADS
    return out


_N = MAX_GOALS + 1
_MARG = np.arange(_N)[:, None] - np.arange(_N)[None, :]
_LC_H = np.clip(_MARG, -LEAD_CLIP, LEAD_CLIP) + LEAD_CLIP
_LC_A = np.clip(-_MARG, -LEAD_CLIP, LEAD_CLIP) + LEAD_CLIP


def regulation_matrix(lam_home: float, lam_away: float, c: np.ndarray) -> np.ndarray:
    """Matrice (dom, ext) du score réglementaire, 14×14, sommant à 1 — sans τ.

    C'est la matrice du match entier quand `game_dynamics.json` est servi
    (`MatchDynamics`) : adoptée le 2026-10-15 sur le walk-forward 2013-2025
    (`explore_score/s6_walkforward_match.py`, critère fixé avant).

    Même uniformisation que `_evolve`, écrite à plat : l'alignement sur la
    victoire corrigée (`lambdas_for_home_win`) l'appelle une soixantaine de fois
    par match, la version générique coûtait ~100 ms par paquet.
    """
    P = np.zeros((_N, _N))
    P[0, 0] = 1.0
    for b in range(N_BUCKETS):
        rh = float(lam_home) / 3600.0 * c[_LC_H, b]
        ra = float(lam_away) / 3600.0 * c[_LC_A, b]
        tot = rh + ra
        lam = float(tot.max())
        ph, pa, stay = rh / lam, ra / lam, 1.0 - tot / lam
        out = np.zeros_like(P)
        v = P
        for wk in _poisson_weights(lam * (EDGES[b + 1] - EDGES[b])):
            out += wk * v
            mh, ma = v * ph, v * pa
            v = v * stay
            v[1:, :] += mh[:-1, :]
            v[-1, :] += mh[-1, :]                # bord replié (≥ 13 buts)
            v[:, 1:] += ma[:, :-1]
            v[:, -1] += ma[:, -1]
        P = out
    return P / P.sum()


class MatchDynamics:
    """Le moteur, prêt à être passé à `ScoreDistribution(..., tau=...)` à la
    place d'un dict τ : la matrice du match entier vient alors de
    `regulation_matrix`. Porte aussi la vue par période (mise en cache : la
    même affiche est lue par une dizaine de marchés du paquet)."""

    def __init__(self, c: np.ndarray, window: list[int] | None = None):
        self.c = np.asarray(c, dtype=float)
        self.window = list(window or [])
        self._cache: dict[tuple[float, float], dict] = {}

    def regulation_matrix(self, lam_home: float, lam_away: float) -> np.ndarray:
        return regulation_matrix(lam_home, lam_away, self.c)

    def periods(self, lam_a: float, lam_b: float) -> dict:
        key = (round(float(lam_a), 6), round(float(lam_b), 6))
        hit = self._cache.get(key)
        if hit is None:
            if len(self._cache) > 512:          # quelques matchs par jour : borne large
                self._cache.clear()
            hit = self._cache[key] = period_dynamics(lam_a, lam_b, self.c)
        return hit

    def __repr__(self) -> str:
        w = f"{self.window[0]}-{self.window[-1]}" if self.window else "?"
        return f"MatchDynamics(fenêtre {w})"


def sanity_check(c: np.ndarray) -> None:
    """Contrôles internes du moteur sur une table c donnée."""
    M = regulation_matrix(3.1, 2.8, c)
    idx = np.arange(_N)
    assert abs(M.sum() - 1.0) < 1e-9, "matrice ≠ 1"
    Mt = regulation_matrix(2.8, 3.1, c)
    assert np.abs(M - Mt.T).max() < 1e-12, "échanger les λ doit transposer la matrice"
    r = period_dynamics(3.1, 2.8, c)
    e_mat = float((M * (idx[:, None] + idx[None, :])).sum())
    e_per = sum(float((r["goals"][p] * np.arange(_GMAX + 1)).sum()) for p in (1, 2, 3))
    assert abs(e_mat - e_per) < 1e-3, f"total matrice {e_mat:.4f} ≠ somme des périodes {e_per:.4f}"
    for p in (1, 2, 3):
        assert abs(r["goals"][p].sum() - 1.0) < 1e-9, f"P{p} ≠ 1"
    for p in (1, 2):
        assert abs(r["lead_after"][p].sum() - 1.0) < 1e-9, f"avance après P{p} ≠ 1"
    assert abs(sum(r["highest"].values()) - 1.0) < 1e-9
    rs = period_dynamics(2.8, 3.1, c)
    assert np.abs(r["lead_after"][1] - rs["lead_after"][1][::-1]).max() < 1e-12, "symétrie P1"
    print(f"  moteur OK — nul 60' {np.trace(M):.4f}, total {e_mat:.3f} = Σ périodes {e_per:.3f}, "
          f"P3 > 1,5 {r['goals'][3][2:].sum():.3f}, la + prolifique "
          + " / ".join(f"{k} {v:.3f}" for k, v in r["highest"].items()))


def main():
    import argparse
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=os.path.join(here, "..", "models"))
    ap.add_argument("--data", default=os.path.join(here, "..", "data"))
    ap.add_argument("--season", type=int, default=None,
                    help="Saison en cours (défaut : d'après la date du jour)")
    ap.add_argument("--check", action="store_true",
                    help="Contrôles internes sur le game_dynamics.json existant, sans réajuster")
    args = ap.parse_args()
    if args.check:
        with open(os.path.join(args.models, "game_dynamics.json"), encoding="utf-8") as fh:
            _, c = read_game_dynamics(json.load(fh))
        if c is None:
            raise SystemExit("game_dynamics.json refusé par read_game_dynamics")
        sanity_check(c)
        return
    out = fit(os.path.join(args.data, "nhl_games_v4.csv"), os.path.join(args.data, "live_goals.csv"),
              args.models, current_season=args.season)
    print(f"   → {write(out, args.models)}")


if __name__ == "__main__":
    main()
