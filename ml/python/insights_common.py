"""
insights_common.py
==================
Socle partagé par content_insights.py, content_insights_team_player.py et
content_insights_advanced.py.

Existe parce que les trois scripts avaient chacun leur propre notion de « quel
écart mérite de sortir », et qu'aucun n'en avait une. Résultat concret avant ce
fichier : des gardiens retraités depuis 2011 en tête des classements, la même
franchise dans la liste des plus constantes ET des plus volatiles, et un écart de
13 points sur 113 matchs présenté au même rang qu'un écart de 4 points sur 7 000.

Quatre corrections, appliquées de façon identique partout :

1. NORMALISATION DES ABRÉVIATIONS
   MoneyPuck a changé de convention en 2021 : `L.A` de 2008-2020 et `LAK` de
   2021-2025 sont la même équipe stockée sous deux noms. Idem N.J/NJD, S.J/SJS,
   T.B/TBL. Sans correction, chaque franchise concernée a ses données coupées en
   deux et peut apparaître aux deux extrémités d'un même classement.

2. SÉPARATION DES FRANCHISES DÉMÉNAGÉES
   Le problème inverse. `nhl_games_v4.csv` réétiquette rétroactivement Atlanta en
   WPG et Arizona en UTA — Utah se retrouve avec 16 saisons d'historique alors que
   la franchise existe depuis 2024. « UTA gagne 46 % de ses matchs depuis 2008 »
   est faux au sens éditorial. On re-scinde donc par saison : avant 2011 → ATL,
   avant 2024 → ARI. Ces deux-là portent alors `is_active: false` et sortent des
   classements d'équipes actuelles, sans disparaître des données.

3. SIGNIFICATION STATISTIQUE
   Les scripts triaient par écart absolu, sans jamais demander si l'écart tenait
   debout. Sur environ un millier de comparaisons, les plus gros écarts sont
   mécaniquement les plus petits échantillons : c'est ce qui remontait Vesa
   Toskala (n=18) et « EDM bien reposée gagne 32.7 % » (n=113). Chaque écart passe
   maintenant un test contre son propre complément, puis une correction de
   Benjamini-Hochberg pour tenir compte du nombre de comparaisons.

4. DÉDOUBLONNAGE DES FACTEURS COLINÉAIRES
   `home_3in4 = 0` et `home_rest_days ∈ (3, 7]` sortaient comme deux découvertes
   distinctes avec exactement le même n, le même taux et le même écart — parce
   qu'avec 3 jours de repos on ne peut pas être en 3-en-4. Une seule des deux
   sort désormais : celle qui se raconte le mieux en vidéo.

Aucune dépendance au-delà de numpy/pandas : les tests sont implémentés à la main
(scipy n'est pas installé dans cet environnement).
"""

from __future__ import annotations

import math

import pandas as pd

# ── 1. Abréviations ──────────────────────────────────────────────────────────

# MoneyPuck a basculé de "L.A" vers "LAK" à partir de la saison 2021.
MP_FORMAT_FIXES = {
    "L.A": "LAK",
    "N.J": "NJD",
    "S.J": "SJS",
    "T.B": "TBL",
}

# (abréviation actuelle, 1re saison sous cette identité, abréviation historique)
# Atlanta Thrashers → Winnipeg Jets en 2011 ; Arizona Coyotes → Utah en 2024.
RELOCATIONS = [
    ("WPG", 2011, "ATL"),
    ("UTA", 2024, "ARI"),
]

# Franchises qui n'existent plus sous ce nom : conservées dans les données,
# écartées des classements d'équipes actuelles.
DEFUNCT_ABBREVS = {hist for _, _, hist in RELOCATIONS}


def normalize_team(series: pd.Series) -> pd.Series:
    """Ramène les abréviations MoneyPuck d'avant 2021 au format actuel."""
    return series.replace(MP_FORMAT_FIXES)


def split_relocations(df: pd.DataFrame, team_col: str, season_col: str) -> pd.DataFrame:
    """Rend son identité d'époque à une franchise déménagée.

    `nhl_games_v4.csv` étiquette les matchs d'Atlanta 2008-2010 sous WPG et ceux
    d'Arizona sous UTA. On les remet sous ATL et ARI, sinon toute statistique
    « depuis 2008 » attribue à Winnipeg et Utah un passé qui n'est pas le leur.
    """
    out = df.copy()
    for current, first_season, historical in RELOCATIONS:
        mask = (out[team_col] == current) & (out[season_col] < first_season)
        out.loc[mask, team_col] = historical
    return out


def is_active_team(abbrev: str) -> bool:
    return abbrev not in DEFUNCT_ABBREVS


# ── 2. Planchers d'échantillon ───────────────────────────────────────────────
# Volontairement hauts. Un plancher bas ne filtre pas le bruit, il le déguise en
# découverte. Ces valeurs sont le principal bouton de réglage du fichier.

MIN_N_LEAGUE = 300          # matchs, pour un split au niveau ligue
MIN_N_TEAM = 150            # matchs, pour un split propre à une équipe
MIN_N_GOALIE_BUCKET = 40    # départs dans un bucket donné
MIN_GOALIE_STARTS = 40      # départs au total pour qu'un gardien soit éligible
MIN_N_GOALIE_POOLED = 500   # départs-matchs pour un split gardiens toute la ligue
MIN_N_SKATER_POOLED = 5000  # matchs-joueurs pour un split patineurs toute la ligue

# Seuil d'effet pratique, en % de la moyenne. Ne s'applique qu'aux analyses
# groupées. Sur 774 000 matchs-joueurs, absolument tout devient statistiquement
# significatif : au premier essai, 21 tests sur 21 passaient. Le test cesse alors
# de discriminer quoi que ce soit et c'est la taille de l'effet qui doit prendre
# le relais. Un écart de 0.4 % est peut-être réel, il ne fait pas une vidéo.
MIN_EFFECT_PCT = 2.0
MIN_TEAM_SEASONS = 8        # saisons, pour un classement de constance
MIN_SYNERGY_STARTS = 40     # départs pour un couple (équipe, gardien)

FDR_Q = 0.10                # taux de fausses découvertes toléré


# ── 3. Tests statistiques ────────────────────────────────────────────────────

def _normal_sf(z: float) -> float:
    """Queue supérieure de la loi normale centrée réduite."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def two_proportion_p(k_bucket: float, n_bucket: int,
                     k_total: float, n_total: int) -> float:
    """Compare le taux d'un bucket à celui du RESTE de la population.

    Le comparer à la moyenne globale serait une erreur : le bucket fait partie de
    cette moyenne, ce qui dilue l'écart et rend le test trop conservateur d'un
    côté, trompeur de l'autre. On teste donc bucket contre complément.
    """
    n_rest = n_total - n_bucket
    k_rest = k_total - k_bucket
    if n_bucket < 2 or n_rest < 2:
        return 1.0
    p1 = k_bucket / n_bucket
    p2 = k_rest / n_rest
    p_pool = (k_bucket + k_rest) / (n_bucket + n_rest)
    if p_pool <= 0 or p_pool >= 1:
        return 1.0
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n_bucket + 1 / n_rest))
    if se == 0:
        return 1.0
    return 2.0 * _normal_sf(abs((p1 - p2) / se))


def welch_p(mean1: float, var1: float, n1: int,
            mean2: float, var2: float, n2: int) -> float:
    """Welch, approximé par la normale.

    Sert aux métriques continues (% d'arrêts, buts marqués, xG) où un test de
    proportions n'a pas de sens. L'approximation normale est acceptable ici parce
    que les planchers ci-dessus garantissent n >= 40 des deux côtés.
    """
    if n1 < 2 or n2 < 2:
        return 1.0
    se = math.sqrt(max(var1, 0) / n1 + max(var2, 0) / n2)
    if se == 0:
        return 1.0
    return 2.0 * _normal_sf(abs((mean1 - mean2) / se))


def benjamini_hochberg(p_values: list[float], q: float = FDR_Q) -> list[bool]:
    """Corrige le fait de tester un millier d'hypothèses à la fois.

    Bonferroni serait plus simple mais si sévère qu'il ne laisserait passer que
    les effets déjà évidents — et le but du projet est justement de trouver ce que
    personne ne remarque. Benjamini-Hochberg accepte qu'environ `q` des résultats
    retenus soient de fausses alertes, ce qui est le bon compromis pour du
    contenu : on n'engage pas d'argent sur ces chiffres.
    """
    m = len(p_values)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: p_values[i])
    keep = [False] * m
    cutoff_rank = -1
    for rank, idx in enumerate(order, start=1):
        if p_values[idx] <= q * rank / m:
            cutoff_rank = rank
    for rank, idx in enumerate(order, start=1):
        if rank <= cutoff_rank:
            keep[idx] = True
    return keep


def apply_significance(rows: list[dict], q: float = FDR_Q,
                       p_key: str = "p_value") -> list[dict]:
    """Ajoute `significant` à chaque ligne et ne renvoie que celles qui passent."""
    if not rows:
        return []
    keep = benjamini_hochberg([r.get(p_key, 1.0) for r in rows], q)
    for row, ok in zip(rows, keep):
        row["significant"] = bool(ok)
    return [r for r in rows if r["significant"]]


# ── 4. Facteurs colinéaires ──────────────────────────────────────────────────

# Ordonné du plus au moins racontable en vidéo. Quand deux facteurs décrivent le
# même découpage, celui qui apparaît le plus haut est conservé.
# « 3 jours de repos » se comprend sans explication ; « 3in4 = 0 » demande une
# phrase d'introduction, et une phrase d'introduction tue un hook de 3 secondes.
FACTOR_READABILITY = [
    "home_b2b", "away_b2b", "b2b",
    "home_rest_days", "away_rest_days", "rest_days", "rest_days_diff",
    "home_tz_shift", "away_tz_shift", "tz_shift", "tz_shift_diff",
    "home_distance_km", "away_distance_km", "distance_km", "distance_km_diff",
    "home_road_trip_len", "away_road_trip_len", "road_trip_len",
    "home_days_away", "away_days_away", "days_away",
    "venue_altitude_m", "home_alt_gain", "away_alt_gain", "alt_gain",
    "home_road_game_num", "away_road_game_num", "road_game_num",
    "home_getaway", "away_getaway", "getaway",
    "home_3in4", "away_3in4", "3in4",
]

_READABILITY_RANK = {name: i for i, name in enumerate(FACTOR_READABILITY)}


def drop_collinear(rows: list[dict], group_keys: tuple[str, ...] = ("target",)) -> list[dict]:
    """Écarte les facteurs qui décrivent exactement le même découpage.

    Deux entrées avec le même n et le même taux, à quatre décimales, portent sur
    les mêmes matchs : ce n'est pas une coïncidence, c'est le même filtre exprimé
    deux fois. Le doublon écarté est mémorisé dans `duplicate_of` de celui qui
    reste, pour qu'on puisse vérifier que la détection ne s'emballe pas.
    """
    best: dict[tuple, dict] = {}
    dropped: dict[tuple, list[str]] = {}

    for row in rows:
        rate = row.get("rate", row.get("save_pct", row.get("value")))
        signature = tuple(row.get(k) for k in group_keys) + (row["n"], round(float(rate), 4))
        rank = _READABILITY_RANK.get(row["factor"], len(FACTOR_READABILITY))
        current = best.get(signature)
        if current is None:
            best[signature] = row
            dropped[signature] = []
        elif rank < _READABILITY_RANK.get(current["factor"], len(FACTOR_READABILITY)):
            dropped[signature].append(current["factor"])
            best[signature] = row
        else:
            dropped[signature].append(row["factor"])

    out = []
    for signature, row in best.items():
        if dropped[signature]:
            row["duplicate_of"] = sorted(set(dropped[signature]))
        out.append(row)
    return out


# ── 5. Joueurs actifs ────────────────────────────────────────────────────────

def current_season(df: pd.DataFrame, season_col: str = "season") -> int:
    return int(df[season_col].max())


def active_names(df: pd.DataFrame, name_col: str = "name",
                 season_col: str = "season") -> set[str]:
    """Noms ayant disputé au moins un match lors de la saison la plus récente.

    Sans ce filtre, les classements de gardiens se remplissent de joueurs partis
    depuis dix ans : les carrières courtes produisent les petits échantillons, et
    les petits échantillons produisent les écarts extrêmes. Ce filtre attaque la
    cause éditoriale, le test statistique attaque la cause mathématique — il faut
    les deux.

    Volontairement NON appliqué aux records historiques (« meilleure performance
    de tous les temps ») : un record filtré sur les joueurs actifs n'est plus un
    record. Ces sections portent `is_active` à la place, et c'est l'étape de
    sélection éditoriale qui tranche.
    """
    season = current_season(df, season_col)
    return set(df.loc[df[season_col] == season, name_col].dropna().unique())
