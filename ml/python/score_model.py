"""
score_model.py — dérivations analytiques du modèle de score (P2)
================================================================

Le modèle de score prédit deux intensités de Poisson : λ_dom et λ_ext, les buts
attendus de chaque équipe **en temps réglementaire**. Tout le reste — moneyline,
puckline, totaux à n'importe quelle ligne, totaux d'équipe — s'en déduit
analytiquement, sans réentraîner quoi que ce soit.

Pourquoi Poisson indépendant et pas Poisson bivarié
---------------------------------------------------
Mesuré sur 40 604 matchs (2008-2025) :

  buts réglementaires dom : moyenne 2.959, variance 2.996  → ratio 1.013
  buts réglementaires ext : moyenne 2.695, variance 2.672  → ratio 0.991
  corrélation dom ↔ ext   : -0.048

La dispersion est celle d'un Poisson pur (ratio ≈ 1), et la corrélation est
quasi nulle et légèrement NÉGATIVE. Or le Poisson bivarié standard (composante
partagée λ₃) ne peut modéliser qu'une corrélation *positive* : il serait donc
non seulement inutile ici, mais structurellement incapable de capter le peu de
dépendance qui existe. On garde deux Poisson indépendants.

Structure prolongation
----------------------
Un match nul après 60 minutes part en prolongation puis en fusillade, et le
vainqueur reçoit exactement un but. Mesuré : 23.01 % des matchs vont en
prolongation, et l'équipe à domicile en gagne 50.51 % — autant dire un pile ou
face. On ne dépense donc aucune capacité de modèle là-dessus.

  P(victoire dom) = P(dom mène après 60') + P(nul après 60') × P_OT_DOM
"""

from __future__ import annotations

import math

import numpy as np

# Taux empirique de victoire à domicile en prolongation/fusillade (4 328 matchs)
P_OT_HOME = 0.5051

# Grille de scores considérée. P(≥13 buts pour une équipe) < 1e-9 avec λ≈3.
MAX_GOALS = 13


def _poisson_pmf(lam: float, k_max: int = MAX_GOALS) -> np.ndarray:
    """Vecteur [P(X=0) … P(X=k_max)] avec la masse résiduelle repliée sur k_max."""
    lam = max(float(lam), 1e-6)
    ks = np.arange(k_max + 1)
    logp = -lam + ks * math.log(lam) - np.array([math.lgamma(k + 1) for k in ks])
    p = np.exp(logp)
    p[-1] += max(0.0, 1.0 - p.sum())      # rien ne se perd
    return p / p.sum()


def joint_matrix(lam_home: float, lam_away: float) -> np.ndarray:
    """Matrice (i, j) = P(dom marque i, ext marque j) en temps réglementaire."""
    return np.outer(_poisson_pmf(lam_home), _poisson_pmf(lam_away))


# ── Correction de marge (filets déserts / effets de score) ───────────────────
#
# Le Poisson indépendant est structurellement biaisé sur les ÉCARTS, mesuré sur
# 18 810 matchs :
#
#     écart   empirique   Poisson     delta
#        0      0.2301     0.1710    +0.0591
#       ±1      0.1032     0.1552    -0.0521
#       ±2      0.1028     0.1166    -0.0139
#       ±3      0.1092     0.0735    +0.0365
#
# Ce n'est pas du bruit, c'est de la mécanique de fin de match : une équipe menée
# d'un but retire son gardien — soit elle égalise (l'écart passe à 0, d'où
# l'excès de nuls), soit elle encaisse dans le filet désert (l'écart de 1 passe à
# 2). Une équipe menée de 2 fait pareil, et l'écart de 2 passe à 3. D'où le
# déficit sur ±1 et ±2 et l'excès sur 0 et ±3.
#
# Correction multiplicative par écart, dans l'esprit de Dixon-Coles (qui corrige
# les cellules à faible score au football) : M'(i,j) = M(i,j) × τ(i-j), puis
# renormalisation. Le mécanisme sous-jacent — retrait du gardien — est universel
# et stable dans le temps, ce qui justifie un τ global plutôt que conditionné.
#
# τ est ESTIMÉ À L'ENTRAÎNEMENT (cf. train_score.py) et stocké dans le modèle.
# Ne jamais le coder en dur ici : il doit être ajusté sur les données passées et
# validé hors échantillon.

def fit_margin_correction(margins: np.ndarray, expected_pmf: np.ndarray,
                          max_abs: int = 6, floor: float = 0.25,
                          ceil: float = 4.0) -> dict[int, float]:
    """Estime τ(écart) = P_empirique(écart) / P_Poisson(écart).

    `margins` : écarts réglementaires observés (dom − ext).
    `expected_pmf` : distribution des écarts prédite par le Poisson, moyennée
                     sur les λ de chaque match (pas un λ global — sinon on
                     confond l'hétérogénéité des matchs avec le biais du modèle).

    Les écarts au-delà de ±max_abs sont laissés à 1.0 : trop peu d'observations
    pour estimer quoi que ce soit de stable, et les borner évite qu'un ratio
    aberrant sur 3 matchs ne déforme la distribution.
    """
    tau: dict[int, float] = {}
    n = len(margins)
    for d in range(-max_abs, max_abs + 1):
        emp = float((margins == d).sum()) / n
        exp = float(expected_pmf[d])
        if exp <= 1e-9 or emp <= 0.0:
            tau[d] = 1.0
        else:
            tau[d] = float(np.clip(emp / exp, floor, ceil))
    return tau


def apply_margin_correction(M: np.ndarray, tau: dict[int, float] | None) -> np.ndarray:
    """Applique τ(écart) à la matrice jointe et renormalise."""
    if not tau:
        return M
    n = M.shape[0]
    idx = np.arange(n)
    margin = idx[:, None] - idx[None, :]
    mult = np.ones_like(M)
    for d, t in tau.items():
        mult[margin == int(d)] = t
    out = M * mult
    s = out.sum()
    return out / s if s > 0 else M


# ── Blend logistique « modèle ⊕ marché » (S4) ────────────────────────────────
#
# POURQUOI CES TROIS FONCTIONS VIVENT ICI. Elles sont le seul point commun entre
# l'entraînement et le service : `train_score.py` AJUSTE les poids sur la tranche
# de validation et les écrit dans `score_report.json`, `ml_service` les APPLIQUE
# à `dist.p_home_win()`. Les poser dans l'un des deux obligerait l'autre à
# l'importer — or `train.py`, qui porte aujourd'hui des copies de ces fonctions
# pour le classifieur, est précisément ce que S4 doit finir par supprimer.
# `score_model.py` est déjà importé des deux côtés : c'est le bon foyer.
#
# POURQUOI UN BLEND PLUTÔT QUE LE MODÈLE NU. Mesuré (P1) : le marché seul fait
# 0.66399 de log-loss, le modèle de score nu 0.6664. Le marché est le meilleur
# estimateur connu du moneyline ; jeter son apport pour simplifier le service
# paierait une dégradation mesurable contre une économie de lignes. La
# simplification de S4 vient de la suppression d'un *modèle* entier, pas du blend.
#
# Descente de gradient plutôt que scipy : deux poids et un biais sur quelques
# milliers de lignes convergent en une fraction de seconde, et le service tourne
# déjà sans scipy — on n'ajoute pas une dépendance pour ça.

def logit(p, eps: float = 1e-7):
    """log(p / (1-p)), borné pour rester fini aux extrêmes."""
    p = np.clip(p, eps, 1 - eps)
    return np.log(p / (1 - p))


def fit_logistic(X: np.ndarray, y: np.ndarray, lr: float = 0.1,
                 iters: int = 4000) -> np.ndarray:
    """Régression logistique par descente de gradient.

    X : (n, k) — ici les deux logits à combiner. Retourne (k+1,) = [w…, biais].
    Même procédure et mêmes hyperparamètres que la calibration du classifieur
    dans `train.py`, pour que les deux blends restent comparables.
    """
    n, k = X.shape
    w = np.zeros(k + 1)
    Xb = np.hstack([X, np.ones((n, 1))])
    for _ in range(iters):
        q = 1.0 / (1.0 + np.exp(-(Xb @ w)))
        w -= lr * (Xb.T @ (q - y)) / n
    return w


def apply_logistic(X: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Applique les poids rendus par `fit_logistic`. X : (n, k)."""
    Xb = np.hstack([X, np.ones((X.shape[0], 1))])
    return 1.0 / (1.0 + np.exp(-(Xb @ w)))


# ── Prolongation dépendante de l'affiche (S4) ────────────────────────────────
#
# `p_home_win = p_reg + p_tie × p_ot_home`. Ce troisième facteur était une
# constante : un gros favori qui va en prolongation était traité comme un pile
# ou face. Mesuré le 2026-08-26 sur les 951 prolongations de la tranche de test
# — favori ≥ 0.65 selon le modèle : 61.7 % de victoires en prolongation
# (n = 149, IC 95 % [0.537 ; 0.692]) ; la constante 0.4996 tombe hors de l'IC.
#
# Le remplaçant est AJUSTÉ par `train_score.fit_ot_model` et LU ici, pour que
# l'entraînement, le service et la mesure (`backtest.py --reliability`) ne
# puissent pas diverger sur la formule ou sur ce qu'ils acceptent.

OT_LEVEL_MIN, OT_LEVEL_MAX = 0.35, 0.65


def read_ot_model(rep: dict) -> list[float] | None:
    """[pente, ordonnée] lus dans `score_report.json`, ou None si douteux.

    Tout est vérifié plutôt que supposé : un rapport antérieur à ce changement
    n'a pas la clé, un rapport futur peut porter un autre signal. Une pente
    négative dirait que les favoris perdent PLUS souvent leurs prolongations —
    signe d'un ajustement raté, pas une découverte. Une ordonnée aberrante
    déplacerait le NIVEAU, donc toutes les probabilités, au lieu de corriger les
    seules affiches tranchées. Dans les deux cas on rend None, et l'appelant
    garde le scalaire.
    """
    cal = rep.get("p_ot_model")
    if not isinstance(cal, dict) or cal.get("signal") != "lambda_diff":
        return None
    raw = cal.get("w")
    if not isinstance(raw, list) or len(raw) != 2:
        return None
    try:
        a, b = float(raw[0]), float(raw[1])
    except (TypeError, ValueError):
        return None
    if not (np.isfinite(a) and np.isfinite(b)) or a <= 0:
        return None
    if not (OT_LEVEL_MIN <= 1.0 / (1.0 + np.exp(-b)) <= OT_LEVEL_MAX):
        return None
    return [a, b]


def p_ot_for(w: list[float] | None, lam_home: float, lam_away: float,
             default: float) -> float:
    """P(le domicile gagne la prolongation) pour CE match, ou `default`."""
    if not w:
        return default
    d = float(lam_home) - float(lam_away)
    if not np.isfinite(d):
        return default
    z = float(np.clip(w[0] * d + w[1], -30.0, 30.0))
    return float(1.0 / (1.0 + np.exp(-z)))


class ScoreDistribution:
    """Distribution complète d'un match à partir de (λ_dom, λ_ext).

    Toutes les probabilités renvoyées portent sur le résultat **final**
    (prolongation et fusillade incluses), qui est ce sur quoi les paris se règlent.
    """

    def __init__(self, lam_home: float, lam_away: float,
                 p_ot_home: float = P_OT_HOME,
                 tau: dict[int, float] | None = None):
        self.lam_home = float(lam_home)
        self.lam_away = float(lam_away)
        self.p_ot_home = float(p_ot_home)
        self.tau = tau
        self.M = apply_margin_correction(joint_matrix(lam_home, lam_away), tau)
        n = self.M.shape[0]
        idx = np.arange(n)
        self._margin = idx[:, None] - idx[None, :]     # i - j
        self._total = idx[:, None] + idx[None, :]      # i + j
        self._tie = self._margin == 0

    # ── Moneyline ────────────────────────────────────────────────────────────

    def p_home_win(self) -> float:
        """P(victoire domicile), prolongation incluse."""
        p_reg = float(self.M[self._margin > 0].sum())
        p_tie = float(self.M[self._tie].sum())
        return p_reg + p_tie * self.p_ot_home

    def p_regulation_tie(self) -> float:
        return float(self.M[self._tie].sum())

    # ── Puckline (handicap ±1.5) ─────────────────────────────────────────────

    def p_home_cover_minus_15(self) -> float:
        """P(domicile gagne par 2 buts ou plus).

        Un match qui va en prolongation se termine forcément avec un écart de 1 :
        seuls les écarts acquis en temps réglementaire comptent ici.
        """
        return float(self.M[self._margin >= 2].sum())

    def p_home_cover_plus_15(self) -> float:
        """P(domicile perd par 1 but au plus, ou gagne)."""
        return float(1.0 - self.M[self._margin <= -2].sum())

    # ── Totaux ───────────────────────────────────────────────────────────────

    def total_pmf(self) -> np.ndarray:
        """Distribution du total de buts FINAL (le but de prolongation compte)."""
        n = self.M.shape[0]
        pmf = np.zeros(2 * n + 1)
        np.add.at(pmf, self._total[~self._tie], self.M[~self._tie])
        # Les nuls en réglementaire gagnent exactement un but
        np.add.at(pmf, self._total[self._tie] + 1, self.M[self._tie])
        return pmf

    def p_over(self, line: float) -> float:
        """P(total final > ligne). Lignes en .5 → aucun push possible."""
        pmf = self.total_pmf()
        totals = np.arange(len(pmf))
        return float(pmf[totals > line].sum())

    def p_under(self, line: float) -> float:
        pmf = self.total_pmf()
        totals = np.arange(len(pmf))
        return float(pmf[totals < line].sum())

    def expected_total(self) -> float:
        pmf = self.total_pmf()
        return float((np.arange(len(pmf)) * pmf).sum())

    # ── Totaux d'équipe ──────────────────────────────────────────────────────

    def team_total_pmf(self, side: str) -> np.ndarray:
        """Distribution des buts FINAUX d'une équipe ('home' ou 'away')."""
        n = self.M.shape[0]
        pmf = np.zeros(n + 2)
        axis = 1 if side == "home" else 0
        # Matchs décidés en réglementaire : le score de l'équipe est son indice
        non_tie = np.where(self._tie, 0.0, self.M)
        marg = non_tie.sum(axis=axis)
        pmf[:n] += marg
        # Nuls : l'équipe marque un but de plus si elle gagne en prolongation
        p_win_ot = self.p_ot_home if side == "home" else 1.0 - self.p_ot_home
        tie_diag = np.diag(self.M)
        for k, p in enumerate(tie_diag):
            pmf[k + 1] += p * p_win_ot
            pmf[k] += p * (1.0 - p_win_ot)
        return pmf

    def p_team_over(self, side: str, line: float) -> float:
        pmf = self.team_total_pmf(side)
        return float(pmf[np.arange(len(pmf)) > line].sum())

    # ── Tout d'un coup ───────────────────────────────────────────────────────

    def summary(self, total_lines=(4.5, 5.5, 6.5),
                team_lines=(1.5, 2.5, 3.5)) -> dict:
        return {
            "lambda_home": round(self.lam_home, 4),
            "lambda_away": round(self.lam_away, 4),
            "expected_total": round(self.expected_total(), 3),
            "p_home_win": round(self.p_home_win(), 4),
            "p_away_win": round(1.0 - self.p_home_win(), 4),
            "p_regulation_tie": round(self.p_regulation_tie(), 4),
            "puckline": {
                "home_-1.5": round(self.p_home_cover_minus_15(), 4),
                "home_+1.5": round(self.p_home_cover_plus_15(), 4),
            },
            "totals": {f"over_{l}": round(self.p_over(l), 4) for l in total_lines},
            "team_totals": {
                "home": {f"over_{l}": round(self.p_team_over("home", l), 4)
                         for l in team_lines},
                "away": {f"over_{l}": round(self.p_team_over("away", l), 4)
                         for l in team_lines},
            },
        }


# ── Incertitude d'estimation (P4) ────────────────────────────────────────────
#
# Un ensemble bootstrap donne K couples (λ_dom, λ_ext) au lieu d'un seul. Chacun
# se déplie en une distribution de score complète, donc en un prix pour CHAQUE
# marché dérivé. L'écart-type entre membres mesure alors l'incertitude
# d'estimation du prix lui-même — pas celle du résultat du match.
#
# La distinction compte. σ ici est *épistémique* : elle dit à quel point le
# modèle serait différent s'il avait vu d'autres données. Elle ne dit rien du
# hasard irréductible du hockey, qui est déjà dans la distribution de Poisson.
#
# Deux limites à garder en tête :
#   • avec K=20, σ est elle-même bruitée d'environ σ/√(2(K−1)) ≈ 16 % en relatif ;
#   • le bootstrap capte la variance d'échantillonnage, pas le biais. Un modèle
#     confiant et faux affiche un σ minuscule.

class ScoreEnsemble:
    """K tirages (λ_dom, λ_ext) → moyenne et écart-type de n'importe quel marché.

    `point` est la distribution du modèle principal (entraîné sur toutes les
    données). C'est elle qui reste le prix servi : les membres bootstrap ne
    voient chacun que ~63 % des matchs uniques, et on ne veut pas dégrader une
    calibration validée en P2 pour gagner un peu de variance. Ils servent
    uniquement à mesurer la dispersion.
    """

    def __init__(self, lambdas: list[tuple[float, float]],
                 p_ot_home: float = P_OT_HOME,
                 tau: dict[int, float] | None = None,
                 point: "ScoreDistribution | None" = None):
        self.members = [ScoreDistribution(lh, la, p_ot_home, tau) for lh, la in lambdas]
        self.point = point

    def __len__(self) -> int:
        return len(self.members)

    def spread(self, market, *args) -> tuple[float, float]:
        """(moyenne, écart-type) d'un marché sur les membres.

        `market` est soit le nom d'une méthode de ScoreDistribution
        ("p_home_win", "p_over", "p_home_cover_minus_15", "p_team_over"…), soit
        un appelable `dist -> proba`. La seconde forme couvre les marchés qui
        se lisent directement sur la matrice jointe (« gagne par ≥3 », victoire
        en 60 minutes) sans avoir de méthode dédiée.
        """
        if not self.members:
            return (float("nan"), 0.0)
        fn = market if callable(market) else (lambda d: getattr(d, market)(*args))
        vals = np.array([float(fn(d)) for d in self.members])
        sd = float(vals.std(ddof=1)) if len(vals) > 1 else 0.0
        return float(vals.mean()), sd

    def std(self, market, *args) -> float:
        return self.spread(market, *args)[1]


def uncertainty_haircut(kelly_fraction: float, sigma: float,
                        sigma_max: float) -> float:
    """Réduit une fraction de Kelly proportionnellement à l'incertitude.

        k' = k × (1 − min(1, σ / σ_max))

    **Ce que cette règle n'est PAS.** Sous utilité logarithmique, la croissance
    espérée `p·log(1+kb) + (1−p)·log(1−k)` est linéaire en p : intégrer sur une
    distribution a posteriori de p revient exactement à mettre E[p] dans la
    formule de Kelly. Une incertitude *bien calibrée* ne justifie donc, à elle
    seule, aucune réduction de mise. Ce n'est pas une correction bayésienne.

    **Ce qu'elle est.** Une garde contre la mauvaise spécification du modèle.
    Les paris sont sélectionnés par `edge ≥ seuil`, or sélectionner sur une
    quantité bruitée gonfle mécaniquement cette quantité dans l'échantillon
    retenu (malédiction du vainqueur), et le gonflement croît avec σ. Réduire la
    mise là où σ est grand attaque le symptôme plutôt que la cause, mais dans le
    bon sens.

    `sigma_max` doit venir des données (quantile haut de σ sur l'entraînement),
    jamais d'un choix à la main : sinon le seuil auquel on cesse de miser est
    arbitraire.
    """
    if not (sigma_max and sigma_max > 0) or not np.isfinite(sigma):
        return kelly_fraction
    return kelly_fraction * (1.0 - min(1.0, sigma / sigma_max))


def sanity_check() -> None:
    """Contrôles internes : toute distribution doit sommer à 1 et rester cohérente."""
    # τ approximatif issu de la mesure sur 18 810 matchs — pour le test seulement.
    tau_demo = {0: 1.35, 1: 0.67, -1: 0.66, 2: 0.88, -2: 0.89,
                3: 1.47, -3: 1.51, 4: 1.12, -4: 1.12}

    for label, tau in [("sans correction", None), ("avec correction τ", tau_demo)]:
        d = ScoreDistribution(2.9592, 2.6950, tau=tau)
        assert abs(d.M.sum() - 1.0) < 1e-9, f"{label}: matrice jointe ≠ 1"
        assert abs(d.total_pmf().sum() - 1.0) < 1e-9, f"{label}: pmf totaux ≠ 1"
        for side in ("home", "away"):
            assert abs(d.team_total_pmf(side).sum() - 1.0) < 1e-9, f"{label}: pmf {side} ≠ 1"
        assert abs(d.p_over(5.5) + d.p_under(5.5) - 1.0) < 1e-9, f"{label}: over+under ≠ 1"
        # Puckline : dom +1.5 et « ext gagne par 2+ » sont complémentaires
        p_lose_2plus = float(d.M[d._margin <= -2].sum())
        assert abs(d.p_home_cover_plus_15() + p_lose_2plus - 1.0) < 1e-9, \
            f"{label}: puckline incohérente"
        assert d.p_home_cover_minus_15() < d.p_home_cover_plus_15(), \
            f"{label}: dom -1.5 devrait être moins probable que dom +1.5"
        assert 0.0 < d.p_home_win() < 1.0, f"{label}: moneyline hors bornes"
        # Le total final dépasse le total réglementaire du taux de prolongation
        base = d.lam_home + d.lam_away
        assert base < d.expected_total() < base + 0.40, f"{label}: total espéré incohérent"
        print(f"  {label:<20} nul rég. {d.p_regulation_tie():.4f}  "
              f"P(dom) {d.p_home_win():.4f}  total {d.expected_total():.3f}  "
              f"dom-1.5 {d.p_home_cover_minus_15():.4f}")

    print("  référence empirique   nul rég. 0.2301  P(dom) 0.5459  total 5.884")

    # ── Ensemble : la dispersion doit croître avec l'étalement des λ ──────────
    point = ScoreDistribution(2.9592, 2.6950, tau=tau_demo)
    serre = ScoreEnsemble([(2.95 + 0.01 * i, 2.70 - 0.01 * i) for i in range(-2, 3)],
                          tau=tau_demo, point=point)
    large = ScoreEnsemble([(2.95 + 0.20 * i, 2.70 - 0.20 * i) for i in range(-2, 3)],
                          tau=tau_demo, point=point)
    for market, args in [("p_home_win", ()), ("p_over", (5.5,)),
                         ("p_home_cover_minus_15", ()), ("p_team_over", ("home", 2.5))]:
        m_s, s_s = serre.spread(market, *args)
        m_l, s_l = large.spread(market, *args)
        assert s_l > s_s, f"ensemble : σ({market}) ne croît pas avec l'étalement des λ"
        assert 0.0 <= m_s <= 1.0 and 0.0 <= m_l <= 1.0, f"ensemble : {market} hors bornes"
        print(f"  σ {market:<22} λ serrés {s_s:.4f}   λ étalés {s_l:.4f}")
    assert len(serre) == 5, "ensemble : nombre de membres incorrect"
    assert serre.std("p_home_win") >= 0.0

    # ── Réduction de mise : bornes et monotonie ───────────────────────────────
    assert uncertainty_haircut(0.10, 0.00, 0.05) == 0.10, "σ=0 ne doit rien réduire"
    assert uncertainty_haircut(0.10, 0.05, 0.05) == 0.0, "σ=σ_max doit annuler la mise"
    assert uncertainty_haircut(0.10, 0.50, 0.05) == 0.0, "σ>σ_max ne doit jamais être négatif"
    assert (uncertainty_haircut(0.10, 0.01, 0.05)
            > uncertainty_haircut(0.10, 0.03, 0.05)), "réduction non monotone"
    assert uncertainty_haircut(0.10, 0.02, 0.0) == 0.10, "σ_max absent → pas de réduction"
    print("  réduction de mise     bornes et monotonie OK")

    # ── Blend logistique (S4) ────────────────────────────────────────────────
    #
    # Ces trois fonctions décident de la probabilité moneyline SERVIE. Une erreur
    # de signe, ou une descente qui n'a pas convergé, donnerait des poids
    # d'apparence plausible et une dégradation silencieuse — le genre de panne
    # qu'aucune assertion de forme n'attrape. On ajuste donc sur une vérité
    # terrain simulée et on vérifie qu'elle est retrouvée.
    rng = np.random.default_rng(0)
    x = rng.normal(size=(4000, 1))
    y = (rng.random(4000) < 1.0 / (1.0 + np.exp(-(1.5 * x[:, 0] - 0.3)))).astype(float)
    w = fit_logistic(x, y, lr=0.5, iters=8000)
    assert abs(w[0] - 1.5) < 0.25, f"blend : poids mal retrouvé ({w[0]:.3f} pour 1.5)"
    assert abs(w[1] + 0.3) < 0.20, f"blend : biais mal retrouvé ({w[1]:.3f} pour -0.3)"
    p_fit = apply_logistic(x, w)
    assert np.all((p_fit > 0.0) & (p_fit < 1.0)), "blend : probabilité hors bornes"
    # `logit` doit borner les extrêmes plutôt que renvoyer ±inf : une cote à 0 ou
    # 1 (bookmaker qui ferme un marché) ne doit pas empoisonner tout le vecteur.
    assert np.all(np.isfinite(logit(np.array([0.0, 1.0])))), "logit : ±inf non borné"
    print(f"  blend logistique      poids {w[0]:.3f} (1.5) · biais {w[1]:.3f} (-0.3) OK")

    print("✅ score_model : contrôles internes OK")


if __name__ == "__main__":
    import json
    sanity_check()
    print(json.dumps(ScoreDistribution(2.9592, 2.6950).summary(), indent=2))
