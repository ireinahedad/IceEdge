"""
train_player.py — modèle JOUEUR : cadence par match de 8 statistiques de patineur.

    python train_player.py                 # construit, entraîne, écrit l'état
    python train_player.py --state-only    # ne refait que player_state.json (+ recalage de niveau)
    python train_player.py --recent        # chaque été : réentraîne RECENT_STATS jusqu'à la
                                           # dernière saison complète (le reste ne bouge pas)

Entrées (déjà présentes pour le reste du pipeline) :
    ../data/raw/skaters_*.zip   MoneyPuck, patineur par match, TOUTES situations
    ../data/nhl_games_v4.csv    features d'équipe PRÉ-MATCH (build_dataset.py)

Sorties (MODELS_DIR, par défaut ../models) :
    player/<stat>.json          un booster XGBoost `count:poisson` par statistique
    player_report.json          features, dispersion k par stat, backtest vs règle
    player_state.json           features du DERNIER état de chaque joueur (inférence)

── Ce que le modèle voit ────────────────────────────────────────────────────
Tout est PRÉ-MATCH (fenêtres décalées d'un match) :
  · rôle      — temps de glace moyen (5, 10, 30 derniers matchs), temps en
                avantage numérique (10 derniers) : de loin le signal le plus fort
                pour les points et les tirs ;
  · talent    — production par 60 minutes sur 10 / 30 matchs et en carrière,
                pour les 8 statistiques (les tirs renseignent les buts, etc.),
                xG individuel par 60 ;
  · trio      — xG des COÉQUIPIERS quand il est sur la glace à 5 c. 5 (xG pour
                de l'unité moins son propre xG), 20 derniers matchs. MoneyPuck ne
                publie pas les trios par match : c'est leur trace mesurable ;
  · match     — forces de son équipe et de l'adversaire (buts, xG, tirs pour et
                contre, AN / PK, gardien), domicile, repos ;
  · face-à-face — sur ses 10 derniers matchs contre CET adversaire, a-t-il
                produit plus ou moins que son niveau du moment ? (`vs_lift_*`,
                rétréci vers 1, contrainte monotone : un lift plus haut ne
                peut que faire monter la prédiction). Essayé pour chaque stat,
                gardé seulement là où il bat le modèle sans face-à-face en
                validation ET en test (z ≥ 2) → `player_vs_report.json`.
                Mesure 2026-10-06 : gardé pour mises en échec et pénalités ;
                bruit pour buts, passes, points, tirs, tirs bloqués, points AN.
  · arbitres  — `ref_pen` / `ref_pp` (referee_effects.py) : tendance des deux
                arbitres du match à siffler (pénalités, minutes à 5 c. 4),
                calculée sur leurs matchs PRÉCÉDENTS. Essayés pour REF_TRY_STATS
                avec la même règle que le face-à-face → `player_ref_report.json`.
                Mesure 2026-10-12 (`measure_ref_props.py`) : gardé pour les
                pénalités (z 2.55), pas pour les points AN (z 1.74). Table
                d'inférence : `ref_effects.json` (0 = arbitre inconnu, neutre).

── Validation ───────────────────────────────────────────────────────────────
Entraînement ≤ 2021-22, arrêt précoce sur 2022-23, test 2023-24 → 2025-26. La
référence est la règle en production (`playerRates.ts`) : saison en cours
rétrécie vers un a priori de poste, × adversaire. `k` (binomiale négative) est
ajusté sur la validation.

── Saisons récentes ─────────────────────────────────────────────────────────
Pour RECENT_STATS (passes, points, tirs, mises en échec, tirs bloqués, points
en AN), le modèle servi est ensuite réentraîné jusqu'à la dernière saison
complète L (arrêt précoce sur L, puis réentraînement 2010 → L avec ce nombre
d'arbres) : mesuré meilleur que le modèle figé, chaque saison de test
(explore_players/retrain.py → player_retrain_report.json). Buts et pénalités
gardent le modèle ≤ 2021-22. À relancer chaque été (`--recent`).
Pour RECENCY_STATS (passes, points, tirs, tirs bloqués, points en AN), ce
modèle récent voit aussi le déploiement récent : temps de glace et d'AN au
dernier match, temps d'AN sur 3 matchs (explore_players/recency_wf.py).
"""
from __future__ import annotations
import argparse, glob, json, os, time, zipfile
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.special import gammaln

import referee_effects as RE

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
MODELS_DIR = os.environ.get("MODELS_DIR") or os.path.join(HERE, "..", "models")

STATS = ["goals", "assists", "points", "shots", "hits", "blocks", "pim", "ppPoints"]
TEAM_COLS = ["gf_s", "ga_s", "xgf60_s", "xga60_s", "sog_f_s", "sog_a_s", "ev_xgf60_s", "ev_xga60_s",
             "pp_xgf60_s", "pk_xga60_s", "goalie_svpct", "goalie_gsax60", "win_s"]
WINDOWS = (10, 30)
SKATER_COLS = ["playerId", "name", "gameId", "season", "playerTeam", "opposingTeam", "home_or_away",
               "gameDate", "position", "situation", "icetime", "I_F_goals", "I_F_primaryAssists",
               "I_F_secondaryAssists", "I_F_points", "I_F_shotsOnGoal", "I_F_xGoals", "I_F_hits",
               "shotsBlockedByPlayer", "penalityMinutes", "OnIce_F_xGoals",
               "I_F_shotAttempts", "OnIce_A_shotAttempts", "penalties"]

# ── Règle en production (référence du backtest) — miroir de playerRates.ts ──
PRIOR = {"F": dict(goals=.16, assists=.22, points=.38, shots=1.5, hits=1.1, blocks=.45, pim=.40, ppPoints=.08),
         "D": dict(goals=.05, assists=.20, points=.25, shots=1.2, hits=1.1, blocks=1.05, pim=.45, ppPoints=.06)}
PSEUDO = dict(goals=12, assists=12, points=12, shots=6, hits=6, blocks=6, pim=8, ppPoints=12)

# ── Face-à-face joueur vs adversaire ──────────────────────────────────────────
# Sur ses VS_WINDOW derniers matchs contre CETTE équipe, le joueur a-t-il produit
# plus (ou moins) que ce que son niveau du moment annonçait ? « lift » = réel /
# attendu, chaque rencontre étant jugée avec la cadence PRÉ-MATCH qu'il avait ce
# soir-là (30 derniers matchs) × son temps de glace — un joueur qui a progressé
# ne paraît donc pas « dominer » tout le monde. VS_PSEUDO (en événements
# attendus) rétrécit vers 1 : 2 matchs à 2 buts ne pèsent presque rien, 10 matchs
# à 40 tirs au lieu de 25 pèsent vraiment. Contrainte monotone +1 : un lift
# plus haut ne peut que FAIRE MONTER la prédiction (et un lift < 1 la baisser).
VS_WINDOW = 10
# Mêmes franchises que `build_dataset.norm_team` (codes MoneyPuck → codes NHL
# actuels) : l'état d'inférence est indexé par l'abréviation que Node envoie.
FRANCHISE = {"ATL": "WPG", "PHX": "UTA", "ARI": "UTA", "L.A": "LAK", "S.J": "SJS",
             "N.J": "NJD", "T.B": "TBL"}
VS_PSEUDO = dict(goals=4, assists=5, points=6, shots=20, hits=15, blocks=10, pim=10, ppPoints=3)
VS_FEATS = ["vs_gp"] + [f"vs_lift_{s}" for s in STATS]
# Arbitres (2026-10-12) : seulement les stats où un effet est plausible — la
# mesure a porté sur ces deux-là ; l'essayer partout multiplierait les tests.
REF_TRY_STATS = ("pim", "ppPoints")


# ══════════════════════════════════════════════════════════════════════════════
# 1. Données
# ══════════════════════════════════════════════════════════════════════════════

def load_skaters(raw_dir: str) -> pd.DataFrame:
    frames = []
    for zp in sorted(glob.glob(os.path.join(raw_dir, "skaters*.zip"))):
        z = zipfile.ZipFile(zp)
        for name in z.namelist():
            with z.open(name) as f:
                for ch in pd.read_csv(f, usecols=SKATER_COLS, chunksize=500_000, low_memory=False):
                    frames.append(ch[ch["situation"].isin(["all", "5on4", "5on5"])])
        print(f"   {os.path.basename(zp)} lu", flush=True)
    raw = pd.concat(frames, ignore_index=True)
    # La saison EN COURS arrive par `refresh_data.py` (skaters_<saison>_current.zip) ;
    # si un zip complet de la même saison est ajouté plus tard, ses lignes
    # doublent les siennes : on n'en garde qu'une.
    raw = raw.drop_duplicates(subset=["playerId", "gameId", "situation"], keep="last")
    return raw[raw.position != "G"]


def per_game(raw: pd.DataFrame) -> pd.DataFrame:
    """Une ligne par patineur et par match : cibles + temps de glace par situation."""
    base = raw[raw.situation == "all"].copy()
    pp = raw[raw.situation == "5on4"][["playerId", "gameId", "icetime", "I_F_points"]] \
        .rename(columns={"icetime": "toi_pp", "I_F_points": "pp_points"})
    ev = raw[raw.situation == "5on5"][["playerId", "gameId", "icetime", "OnIce_F_xGoals", "I_F_xGoals"]] \
        .rename(columns={"icetime": "toi_ev", "OnIce_F_xGoals": "ev_onice_xgf", "I_F_xGoals": "ev_ixg"})
    df = base.merge(pp, on=["playerId", "gameId"], how="left").merge(ev, on=["playerId", "gameId"], how="left")
    for c in ["toi_pp", "pp_points", "toi_ev", "ev_onice_xgf", "ev_ixg"]:
        df[c] = df[c].fillna(0.0)
    df["date"] = pd.to_datetime(df.gameDate.astype(str), format="%Y%m%d")
    df["opposingTeam"] = df.opposingTeam.replace(FRANCHISE)
    df["toi"] = df.icetime / 60.0
    df["toi_pp"] = df.toi_pp / 60.0
    df["toi_ev"] = df.toi_ev / 60.0
    df = df[df.toi > 0].copy()
    df["pos"] = np.where(df.position == "D", "D", "F")
    df["y_goals"] = df.I_F_goals
    df["y_assists"] = df.I_F_primaryAssists + df.I_F_secondaryAssists
    df["y_points"] = df.I_F_points
    df["y_shots"] = df.I_F_shotsOnGoal
    df["y_hits"] = df.I_F_hits
    df["y_blocks"] = df.shotsBlockedByPlayer
    df["y_pim"] = df.penalityMinutes
    df["y_ppPoints"] = df.pp_points
    # Pénalités en NOMBRE (2026-10-16, explore_players/penalties.py) : compte de
    # pénalités, et parmi elles les « non mineures » (double mineure, majeure,
    # inconduite) estimées par les minutes au-delà de 2 par pénalité.
    df["y_npen"] = df.penalties.fillna(0).clip(0, PEN_NMAX).astype(int)
    extra = (df.penalityMinutes.fillna(0) - 2 * df.y_npen).clip(lower=0)
    df["y_nbig"] = np.minimum(df.y_npen, np.where(extra > 0, np.maximum(1, (extra / 3).round()), 0)).astype(int)
    df["mates_xg"] = (df.ev_onice_xgf - df.ev_ixg).clip(lower=0)
    return df.sort_values(["playerId", "date", "gameId"]).reset_index(drop=True)


def rolling_features(df: pd.DataFrame, shift: int) -> pd.DataFrame:
    """Features joueur. `shift=1` : pré-match (entraînement). `shift=0` : état APRÈS
    le dernier match (inférence du match suivant)."""
    g = df.groupby("playerId", sort=False)

    def rsum(col, w):
        return g[col].transform(lambda s: s.shift(shift).rolling(w, min_periods=1).sum())

    def rcount(w):
        return g["toi"].transform(lambda s: s.shift(shift).rolling(w, min_periods=1).count())

    def csum(col):
        return g[col].transform(lambda s: s.shift(shift).cumsum())

    out = {}
    for w in (5,) + WINDOWS:
        out[f"toi_avg_{w}"] = rsum("toi", w) / rcount(w)
    for w in WINDOWS:
        toi_w = rsum("toi", w)
        for st in STATS:
            out[f"{st}_p60_{w}"] = rsum(f"y_{st}", w) / toi_w * 60
    out["toi_pp_avg_10"] = rsum("toi_pp", 10) / rcount(10)
    # Déploiement récent (chantier 3, 2026-10-15) : une promotion d'hier soir
    # sur le 1er trio ou la 1re unité d'AN, que les moyennes sur 5-30 matchs
    # diluent. Servi seulement pour RECENCY_STATS.
    out["toi_last1"] = g["toi"].shift(shift)
    out["toi_pp_last1"] = g["toi_pp"].shift(shift)
    out["toi_pp_avg_3"] = rsum("toi_pp", 3) / rcount(3)
    # Tentatives de tir (2026-10-16, explore_players/attempts.py) : ses tentatives
    # (cadrées, ratées, bloquées) par 60 pour les tirs ; les tentatives adverses
    # quand il est sur la glace, par 60, pour les tirs bloqués.
    for w in WINDOWS:
        out[f"att_p60_{w}"] = rsum("I_F_shotAttempts", w) / rsum("toi", w) * 60
    out["att_p60_career"] = csum("I_F_shotAttempts") / csum("toi") * 60
    out["oia_p60_20"] = rsum("OnIce_A_shotAttempts", 20) / rsum("toi", 20) * 60
    # Pénalités en nombre : ses pénalités et ses « non mineures » en carrière
    # (part propre au joueur de la loi des durées, servie par ml_service).
    if "y_npen" in df:
        out["pen_career"] = csum("y_npen").fillna(0)
        out["bigpen_career"] = csum("y_nbig").fillna(0)
    out["mates_xg60_20"] = rsum("mates_xg", 20) / rsum("toi_ev", 20) * 60
    out["ixg60_20"] = rsum("I_F_xGoals", 20) / rsum("toi", 20) * 60
    out["gp_career"] = g.cumcount() + (1 - shift)
    car = csum("toi")
    for st in STATS:
        out[f"{st}_p60_career"] = csum(f"y_{st}") / car * 60
    return pd.DataFrame(out, index=df.index).replace([np.inf, -np.inf], np.nan)


def vs_features(df: pd.DataFrame, pre: pd.DataFrame, shift: int) -> pd.DataFrame:
    """Face-à-face du joueur contre l'adversaire de chaque ligne.

    `pre` = rolling_features(df, shift=1) : la cadence PRÉ-MATCH de chaque
    rencontre passée, qui sert à calculer ce qui était « attendu » ce soir-là.
    `shift=1` : les VS_WINDOW rencontres AVANT ce match (entraînement, aucune
    fuite). `shift=0` : les VS_WINDOW dernières, ce match compris (état
    d'inférence pour la PROCHAINE rencontre contre cette équipe).
    """
    key = [df.playerId, df.opposingTeam]
    out = {}

    def window_sum(x: pd.Series) -> pd.Series:
        c = x.groupby(key, sort=False).cumsum()
        cg = c.groupby(key, sort=False)
        end = cg.shift(shift).fillna(0.0) if shift else c
        start = cg.shift(shift + VS_WINDOW).fillna(0.0)
        return end - start

    out["vs_gp"] = window_sum(pd.Series(1.0, index=df.index))
    for st in STATS:
        rate = pre[f"{st}_p60_30"].fillna(pre[f"{st}_p60_career"])
        ok = rate.notna()
        act = window_sum(df[f"y_{st}"].where(ok, 0.0).astype(float))
        exp = window_sum((rate * df.toi / 60.0).where(ok, 0.0))
        ps = VS_PSEUDO[st]
        out[f"vs_lift_{st}"] = (act + ps) / (exp + ps)
    return pd.DataFrame(out, index=df.index)


def build_vs_state(pg: pd.DataFrame, pre: pd.DataFrame, since_season: int) -> dict:
    """{ playerId: { équipe adverse: [vs_gp, lift goals, …, lift ppPoints] } }
    après la dernière rencontre de chaque paire — ce que l'inférence lit pour
    le prochain match contre cette équipe. Ordre des valeurs : VS_FEATS."""
    vs = vs_features(pg, pre, shift=0)
    full = pd.concat([pg[["playerId", "opposingTeam", "season"]], vs], axis=1)
    active = set(pg.loc[pg.season >= since_season, "playerId"].unique())
    last = full[full.playerId.isin(active)].groupby(["playerId", "opposingTeam"]).tail(1)
    out: dict[str, dict[str, list]] = {}
    for r in last.itertuples(index=False):
        d = r._asdict()
        out.setdefault(str(int(d["playerId"])), {})[d["opposingTeam"]] = \
            [int(d["vs_gp"])] + [round(float(d[f"vs_lift_{s}"]), 4) for s in STATS]
    return out


def game_context(df: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for side, other in (("home", "away"), ("away", "home")):
        sub = games[["game_id"]].copy()
        sub["team_side"] = side.upper()
        for c in TEAM_COLS:
            sub[f"tm_{c}"] = games.get(f"{side}_{c}")
            sub[f"opp_{c}"] = games.get(f"{other}_{c}")
        sub["b2b"] = games.get(f"{side}_b2b")
        sub["days_rest"] = games.get(f"{side}_rest_days")
        rows.append(sub)
    ctx = pd.concat(rows)
    df = df.copy()
    df["team_side"] = df.home_or_away.str.upper()
    df = df.merge(ctx, left_on=["gameId", "team_side"], right_on=["game_id", "team_side"], how="left")
    df["is_home"] = (df.team_side == "HOME").astype(int)
    df["is_D"] = (df.pos == "D").astype(int)
    return df


def feature_names() -> list[str]:
    return (["toi_avg_5", "toi_avg_10", "toi_avg_30", "toi_pp_avg_10", "mates_xg60_20", "ixg60_20",
             "gp_career", "days_rest", "is_home", "is_D", "b2b"]
            + [f"{s}_p60_{w}" for s in STATS for w in WINDOWS + ("career",)]
            + [f"tm_{c}" for c in TEAM_COLS] + [f"opp_{c}" for c in TEAM_COLS])


# ══════════════════════════════════════════════════════════════════════════════
# 2. Évaluation
# ══════════════════════════════════════════════════════════════════════════════

def nb_ll(y, mu, k):
    mu = np.maximum(mu, 1e-6)
    if k >= 1e4:
        return y * np.log(mu) - mu - gammaln(y + 1)
    return (gammaln(y + k) - gammaln(k) - gammaln(y + 1)
            + k * np.log(k / (k + mu)) + y * np.log(mu / (k + mu)))


K_GRID = [0.3, 0.5, 0.7, 1, 1.5, 2, 3, 4, 6, 8, 12, 20, 40, 1e5]


def p_ge1(mu, k):
    """P(X ≥ 1) — binomiale négative, Poisson quand k est « infini »."""
    return 1 - np.exp(-mu) if k >= 1e4 else 1 - (k / (k + mu)) ** k


def fit_k(y, mu):
    return max(K_GRID, key=lambda k: nb_ll(y, mu, k).mean())


def baseline(d: pd.DataFrame, s: str) -> np.ndarray:
    cur = d.gp_season_prior > 0
    tot = np.where(cur, d[f"{s}_season_prior"], d[f"prev_{s}_tot"].fillna(0))
    gp = np.where(cur, d.gp_season_prior, d["prev_gp_tot"].fillna(0))
    pri = np.where(d.pos == "D", PRIOR["D"][s], PRIOR["F"][s])
    lam = (tot + PSEUDO[s] * pri) / (gp + PSEUDO[s])
    if s in ("goals", "assists", "points", "ppPoints"):
        lam = lam * np.clip(d.opp_ga_s.fillna(3.05) / 3.05, .85, 1.15)
    elif s == "shots":
        lam = lam * np.clip(d.opp_sog_a_s.fillna(30) / 30, .9, 1.1)
    elif s == "blocks":
        lam = lam * np.clip(d.opp_sog_f_s.fillna(30) / 30, .85, 1.15)
    return np.maximum(lam, 1e-4)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Pipeline
# ══════════════════════════════════════════════════════════════════════════════

def build_state(pg: pd.DataFrame, since_season: int) -> dict:
    """Features de chaque joueur APRÈS son dernier match — ce que l'inférence
    combine au contexte du match à venir."""
    feats = rolling_features(pg, shift=0)
    full = pd.concat([pg[["playerId", "name", "playerTeam", "pos", "season", "date"]], feats], axis=1)
    last = full.groupby("playerId").tail(1)
    last = last[last.season >= since_season]
    keep = [c for c in feats.columns]
    state = {}
    for r in last.itertuples(index=False):
        d = r._asdict()
        state[str(int(d["playerId"]))] = {
            "name": d["name"], "team": d["playerTeam"], "pos": d["pos"],
            "last_game": d["date"].strftime("%Y-%m-%d"),
            "f": {k: (None if pd.isna(d[k]) else round(float(d[k]), 5)) for k in keep},
        }
    return state


# ── Recalage de NIVEAU dans la saison (2026-10-15) ───────────────────────────
#
# Entraîné ≤ 2021-22, le modèle suit mal les dérives de ligue (les tirs, les
# mises en échec baissent ; les tirs bloqués montent). Par statistique, k de la
# saison en cours = Σ observé / Σ prévu sur ses matchs DÉJÀ joués, rétréci
# vers 1 (`score_model.level_k`, n0 par stat). Mesure et règle :
# `explore_players/level_wf.py` → `player_level_report.json`, re-mesuré sur le
# modèle servi après réentraînement récent et déploiement récent (hors
# échantillon, n0 choisi sur 2023-24, test 2024-26) : ADOPTÉ pour tirs bloqués
# (z 5,4, n0 50) et mises en échec (z 3,5, n0 100) ; plus pour les points
# (perd sur 2023-24), toujours pas pour tirs, buts, passes, pénalités, points AN.
# Le modèle réentraîné ne surestime plus les tirs. Première mesure, sur le
# modèle figé : `explore_players/level.py` → `player_level_report_frozen.json`.
# Écrit `player_level_layer.json`, lu par ml_service (`_player_rates`).
PLAYER_LEVEL_REPORT = "player_level_report.json"
PLAYER_LEVEL_LAYER = "player_level_layer.json"


def refresh_player_level(pg: pd.DataFrame, pre: pd.DataFrame, season: int) -> dict:
    """k de chaque statistique adoptée pour la saison `season` → player_level_layer.json.

    Les cadences sont celles du modèle SERVI, avec les mêmes features d'avant-
    match qu'à l'entraînement (fenêtres décalées, face-à-face, arbitres).
    Écrit TOUJOURS un fichier : k = 1 (stat absente) quand la mesure n'est pas
    adoptée, le modèle illisible ou la saison vide.
    """
    from datetime import datetime, timezone
    from score_model import level_k
    out = {"season": int(season), "as_of": None, "n_games": 0, "stats": {}, "note": "",
           "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
    try:
        with open(os.path.join(MODELS_DIR, PLAYER_LEVEL_REPORT), encoding="utf-8") as fh:
            lrep = json.load(fh)
        adopted = {s: float(v["n0"]) for s, v in lrep["stats"].items() if v.get("adopt")}
        with open(os.path.join(MODELS_DIR, "player_report.json"), encoding="utf-8") as fh:
            prep = json.load(fh)
        cur = (pg.season == season).values
        if adopted and cur.any():
            df = pd.concat([pg[cur], pre[cur], vs_features(pg, pre, shift=1)[cur]], axis=1)
            df = game_context(df, pd.read_csv(os.path.join(DATA_DIR, "nhl_games_v4.csv"), low_memory=False))
            ref_games = RE.load_ref_games(DATA_DIR)
            if ref_games is not None:
                df = df.merge(RE.pregame_features(ref_games), left_on="gameId", right_on="game_id",
                              how="left", suffixes=("", "_ref"))
            for c in RE.REF_FEATS:
                if c not in df:
                    df[c] = np.nan
            df = add_team_attempts(df)
            n = int(df.gameId.nunique())
            out["n_games"], out["as_of"] = n, df.date.max().strftime("%Y-%m-%d")
            for s, n0 in adopted.items():
                feats = prep["stats"][s]["features"]
                b = xgb.Booster()
                b.load_model(os.path.join(MODELS_DIR, "player", f"{s}.json"))
                mu = b.predict(xgb.DMatrix(df[feats], feature_names=feats))
                obs_sum, lam_sum = round(float(df[f"y_{s}"].sum()), 6), round(float(mu.sum()), 6)
                out["stats"][s] = {"obs_sum": obs_sum, "lam_sum": lam_sum, "prior_games": n0,
                                   "k": level_k(obs_sum, lam_sum, n, n0)}
        else:
            out["note"] = "aucune stat adoptée ou aucun match cette saison — k = 1"
    except Exception as e:
        out.update(n_games=0, stats={}, note=f"calcul impossible ({e}) — k = 1")
    with open(os.path.join(MODELS_DIR, PLAYER_LEVEL_LAYER), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    ks = ", ".join(f"{s} {v['k']:.3f}" for s, v in out["stats"].items()) or "k = 1"
    print(f"   recalage du modèle joueur {season}-{str(season + 1)[2:]} : {ks} "
          f"({out['n_games']} matchs)" + (f" — {out['note']}" if out["note"] else ""))
    return out


def refresh_state() -> None:
    """État d'inférence + recalage de niveau, sans réentraîner (refresh_data.py, chaque lundi)."""
    t0 = time.time()
    print("⛸️  lecture des patineurs MoneyPuck …")
    pg = per_game(load_skaters(os.path.join(DATA_DIR, "raw")))
    print(f"   {len(pg)} patineur-matchs ({time.time()-t0:.0f}s)")
    pre = rolling_features(pg, shift=1)
    write_state(pg, pre)
    refresh_player_level(pg, pre, int(pg.season.max()))


def write_state(pg: pd.DataFrame, pre: pd.DataFrame) -> None:
    last_season = int(pg.season.max())
    state = build_state(pg, since_season=last_season - 1)
    vs_state = build_vs_state(pg, pre, since_season=last_season - 1)
    json.dump({"as_of": pg.date.max().strftime("%Y-%m-%d"), "players": state,
               "vs_features": VS_FEATS, "vs": vs_state,
               # Tentatives d'équipe (20 derniers matchs) : tm_att_a20 / opp_att_f20.
               "teams": team_attempt_state(DATA_DIR)},
              open(os.path.join(MODELS_DIR, "player_state.json"), "w"))
    print(f"   état : {len(state)} joueurs, {sum(len(v) for v in vs_state.values())} "
          f"paires joueur-adversaire → player_state.json")
    # Table d'inférence des arbitres : toujours réécrite avec l'état, pour qu'un
    # modèle entraîné AVEC ref_* ne parte jamais sans elle.
    RE.write_table(DATA_DIR, MODELS_DIR)


# ── Tentatives d'équipe (2026-10-16, explore_players/attempts.py) ────────────
# On ne bloque que ce que l'adversaire tente : pour les tirs bloqués, le volume
# de tentatives de l'adversaire (opp_att_f20) et celui que concède l'équipe du
# joueur (tm_att_a20), moyenne des 20 derniers matchs (mp_team_games.csv).
TEAM_ATT_WINDOW = 20
TEAM_ATT_FEATS = ["tm_att_a20", "opp_att_f20"]


def _team_attempt_games(data_dir: str) -> pd.DataFrame | None:
    path = os.path.join(data_dir, "mp_team_games.csv")
    if not os.path.exists(path):
        return None
    t = pd.read_csv(path, usecols=["gameId", "gameDate", "playerTeam", "home_or_away", "situation",
                                   "shotAttemptsFor", "shotAttemptsAgainst"], low_memory=False)
    t = t[t.situation == "all"].drop_duplicates(["gameId", "playerTeam"]).copy()
    t["team"] = t.playerTeam.replace(FRANCHISE)
    t["date"] = pd.to_datetime(t.gameDate.astype(str), format="%Y%m%d")
    return t.sort_values(["team", "date", "gameId"]).reset_index(drop=True)


def team_attempt_features(data_dir: str) -> pd.DataFrame | None:
    """(gameId, HOME/AWAY) → att_f20 / att_a20 de cette équipe AVANT le match."""
    t = _team_attempt_games(data_dir)
    if t is None:
        return None
    g = t.groupby("team", sort=False)
    for c, src in (("att_f20", "shotAttemptsFor"), ("att_a20", "shotAttemptsAgainst")):
        t[c] = g[src].transform(lambda x: x.shift(1).rolling(TEAM_ATT_WINDOW, min_periods=5).mean())
    return t[["gameId", "home_or_away", "att_f20", "att_a20"]].drop_duplicates(["gameId", "home_or_away"])


def team_attempt_state(data_dir: str) -> dict:
    """{ équipe: {att_f20, att_a20} } après son dernier match — pour le service."""
    t = _team_attempt_games(data_dir)
    if t is None:
        return {}
    last = t.groupby("team").tail(TEAM_ATT_WINDOW).groupby("team")
    return {team: {"att_f20": round(float(d.shotAttemptsFor.mean()), 3),
                   "att_a20": round(float(d.shotAttemptsAgainst.mean()), 3)}
            for team, d in last if len(d) >= 5}


def add_team_attempts(df: pd.DataFrame) -> pd.DataFrame:
    """Ajoute tm_att_a20 / opp_att_f20 (pré-match) aux lignes après game_context."""
    ta = team_attempt_features(DATA_DIR)
    if ta is not None:
        n = len(df)
        other = np.where(df.team_side == "HOME", "AWAY", "HOME")
        tm = ta.rename(columns={"home_or_away": "_hoa", "att_a20": "tm_att_a20"})[["gameId", "_hoa", "tm_att_a20"]]
        op = ta.rename(columns={"home_or_away": "_hoa", "att_f20": "opp_att_f20"})[["gameId", "_hoa", "opp_att_f20"]]
        df = df.assign(_side=df.team_side.values, _other=other)
        df = df.merge(tm, left_on=["gameId", "_side"], right_on=["gameId", "_hoa"], how="left").drop(columns="_hoa")
        df = df.merge(op, left_on=["gameId", "_other"], right_on=["gameId", "_hoa"], how="left").drop(columns="_hoa")
        df = df.drop(columns=["_side", "_other"])
        assert len(df) == n
    for c in TEAM_ATT_FEATS:
        if c not in df:
            df[c] = np.nan
    return df


def build_frame(pg: pd.DataFrame, pre: pd.DataFrame) -> pd.DataFrame:
    """Lignes d'entraînement : cibles, features pré-match, face-à-face, contexte
    de match, arbitres, et ce que la règle de référence (baseline) lit."""
    df = pd.concat([pg, pre, vs_features(pg, pre, shift=1)], axis=1)
    gs = df.groupby(["playerId", "season"], sort=False)
    df["gp_season_prior"] = gs.cumcount()
    for st in STATS:
        df[f"{st}_season_prior"] = gs[f"y_{st}"].transform(lambda s: s.shift(1).cumsum()).fillna(0)
    tot = df.groupby(["playerId", "season"]).agg(**{f"{s}_tot": (f"y_{s}", "sum") for s in STATS},
                                                 gp_tot=("gameId", "count")).reset_index()
    tot["season"] += 1
    df = df.merge(tot.rename(columns={c: "prev_" + c for c in tot.columns if c not in ("playerId", "season")}),
                  on=["playerId", "season"], how="left")
    games = pd.read_csv(os.path.join(DATA_DIR, "nhl_games_v4.csv"), low_memory=False)
    df = game_context(df, games)
    ref_games = RE.load_ref_games(DATA_DIR)
    if ref_games is not None:
        df = df.merge(RE.pregame_features(ref_games), left_on="gameId", right_on="game_id",
                      how="left", suffixes=("", "_ref"))
    for c in RE.REF_FEATS:
        if c not in df:
            df[c] = np.nan
    df = add_team_attempts(df)
    return df[df.season >= 2010]


# Réentraînement sur les saisons récentes (chantier 2, explore_players/retrain.py).
# Mesure 2026-10-15 en validation « marchante » (réentraîner chaque été avec ce
# qu'on savait, test 2023-24 → 2025-26) : meilleur que le modèle figé pour
# passes (z 5,3), points (5,7), tirs (7,6), mises en échec (14,2), tirs bloqués
# (3,2) et points en AN (3,6) ; pas pour buts (−0,2) ni pénalités (1,3), qui
# gardent le modèle entraîné ≤ 2021-22. Pondérer les saisons récentes (demi-vie
# 3 ans) n'a rien ajouté ; le facteur d'aréna a nui (mises en échec z −7,0).
RECENT_STATS = ("assists", "points", "shots", "hits", "blocks", "ppPoints")
# Déploiement récent (chantier 3, explore_players/lineup.py puis recency_wf.py) :
# temps de glace et d'AN au dernier match, temps d'AN sur 3 matchs. Ajoutés au
# modèle réentraîné, en validation « marchante » 2023-24 → 2025-26 : meilleurs
# pour points en AN (z 7,3), tirs (4,5), tirs bloqués (4,2), points (3,2),
# passes (2,4) ; pas pour mises en échec (−2,4) ni buts (1,0). Les absents du
# soir (minutes des habitués hors de l'alignement) ne pesaient rien : non servis.
RECENCY = ["toi_last1", "toi_pp_last1", "toi_pp_avg_3"]
RECENCY_STATS = ("assists", "points", "shots", "blocks", "ppPoints")
# Tentatives de tir (explore_players/attempts.py, 2026-10-16), ajoutées au
# modèle servi ci-dessus, validation « marchante » 2023-24 → 2025-26 : tirs
# + ses tentatives par 60 (z 4,1) ; tirs bloqués + tentatives adverses sur la
# glace, de l'adversaire, concédées par l'équipe (z 6,1).
ATTEMPT_FEATS = {"shots": ["att_p60_10", "att_p60_30", "att_p60_career"],
                 "blocks": ["oia_p60_20", "opp_att_f20", "tm_att_a20"]}
FULL_SEASON_GAMES = 1200


# Dispersion par profil (explore_players/dispersion.py, 2026-10-16) : un k par
# tiers de cadence prévue au lieu d'un k unique, choisi sur 2023-24, jugé sur
# 2024-26. Adopté pour les mises en échec seulement (z 5,5 ; petits frappeurs
# k 3, moyens 4, gros 10). Poste ou profil n'apportent rien aux autres stats.
# Écrit dans player_report.json → stats[s].k_tiers = {cuts, k}.
def apply_dispersion_tiers(rep: dict) -> None:
    path = os.path.join(MODELS_DIR, "player_dispersion_report.json")
    if not os.path.exists(path):
        return
    drep = json.load(open(path, encoding="utf-8"))["stats"]
    for s, r in drep.items():
        if s in rep["stats"]:
            if r.get("kept") == "M":
                rep["stats"][s]["k_tiers"] = {"cuts": r["k_M"]["tiers_mu"], "k": r["k_M"]["k"]}
            else:
                rep["stats"][s].pop("k_tiers", None)


def retrain_recent(df: pd.DataFrame, out_dir: str) -> None:
    """La politique mesurée dans retrain.py, sur la dernière saison COMPLÈTE L :
    entraînement 2010 → L−1, arrêt précoce sur L (nombre d'arbres, k), puis
    réentraînement 2010 → L avec ce nombre d'arbres. Mêmes features et
    paramètres que la stat servie ; seuls les RECENT_STATS sont touchés."""
    n_games = df.groupby("season").gameId.nunique()
    L = int(max(s for s, n in n_games.items() if n >= FULL_SEASON_GAMES))
    path = os.path.join(MODELS_DIR, "player_report.json")
    rep = json.load(open(path))
    params = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50,
                  subsample=0.8, colsample_bytree=0.8, eval_metric="poisson-nloglik",
                  max_delta_step=0.7, nthread=os.cpu_count() or 2, seed=7)
    tr, va, full = df[df.season <= L - 1], df[df.season == L], df[df.season <= L]
    print(f"   réentraînement récent : 2010 → {L - 1}, arrêt sur {L}, puis 2010 → {L} "
          f"({len(full)} patineur-matchs)", flush=True)
    for s in RECENT_STATS:
        y, feats = f"y_{s}", list(rep["stats"][s]["features"])
        if s in RECENCY_STATS:
            feats += [f for f in RECENCY if f not in feats]
        feats += [f for f in ATTEMPT_FEATS.get(s, []) if f not in feats]
        mono = {f"vs_lift_{x}": 1 for x in STATS if f"vs_lift_{x}" in feats}
        p = dict(params, monotone_constraints=mono) if mono else params
        dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
        b0 = xgb.train(p, xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats), 2000,
                       evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        R = b0.best_iteration + 1
        k = fit_k(va[y].values, b0.predict(dva, iteration_range=(0, R)))
        bst = xgb.train(p, xgb.DMatrix(full[feats], label=full[y], feature_names=feats), R, verbose_eval=False)
        bst.save_model(os.path.join(out_dir, f"{s}.json"))
        rep["stats"][s].update({"k": k, "rounds": R, "trained_through": L, "policy": "recent",
                                "features": feats})
        print(f"   {s:9s} {R} arbres, k {k}", flush=True)
    rep["features"] = list(rep["features"]) + [f for f in RECENCY + sum(ATTEMPT_FEATS.values(), [])
                                               if f not in rep["features"]
                                               and any(f in r["features"] for r in rep["stats"].values())]
    apply_dispersion_tiers(rep)
    rep["recent"] = {"trained_at": time.strftime("%Y-%m-%d"), "stats": list(RECENT_STATS),
                     "train": f"2010-{L}", "early_stop_on": L,
                     "note": "les métriques de test des stats « recent » datent du modèle figé (≤ 2021-22) ; "
                             "la mesure de la politique est dans player_retrain_report.json"}
    json.dump(rep, open(path, "w"), indent=1)
    print("✅ modèle joueur récent écrit")


# ── Pénalités en NOMBRE (2026-10-16, explore_players/penalties.py) ───────────
# Les minutes de pénalité tombent par blocs (2, 4, 5, 7…) : la binomiale
# négative en minutes mettait de la masse sur 1 et 3 minutes et sous-estimait
# « 2 minutes ou plus » (9,6 % prévu pour 16,8 % observé, test 2023-26). Servi :
#   N ~ BN(μ_N, k_N)  nombre de pénalités, XGBoost (features et découpage de la
#                     stat pim : entraînement ≤ 2021-22, arrêt sur 2022-23)
#   durées {2, 4, 5, 10} : loi de la ligue, avec la part de « non mineures »
#   propre au joueur (ses pénalités en carrière, rétrécie, pseudo PEN_PSEUDO)
#   PIM = somme des N durées → P(PIM ≥ m) calculé par ml_service.
# Mesure (règle posée avant) : log-vraisemblance des minutes z 217 contre le
# servi (surtout la masse impossible sur 1 et 3 min), part du joueur z 25 de
# plus ; « plus de 0,5 » 17,3 % prévu pour 16,8 %, « plus de 2,5 » 3,1 % pour
# 3,0 % (le servi : 4,7 %). Brier meilleur sur ces deux lignes.
PEN_DURATIONS = [2, 4, 5, 10]
PEN_NMAX = 8
PEN_PSEUDO = 20.0


def train_penalty_count(df: pd.DataFrame, out_dir: str) -> None:
    path = os.path.join(MODELS_DIR, "player_report.json")
    rep = json.load(open(path))
    feats = rep["stats"]["pim"]["features"]
    mono = {f"vs_lift_{x}": 1 for x in STATS if f"vs_lift_{x}" in feats}
    params = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50,
                  subsample=0.8, colsample_bytree=0.8, eval_metric="poisson-nloglik",
                  max_delta_step=0.7, nthread=os.cpu_count() or 2, seed=7)
    p = dict(params, monotone_constraints=mono) if mono else params
    tr, va = df[df.season <= 2021], df[df.season == 2022]
    dva = xgb.DMatrix(va[feats], label=va.y_npen, feature_names=feats)
    b0 = xgb.train(p, xgb.DMatrix(tr[feats], label=tr.y_npen, feature_names=feats), 2000,
                   evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
    R = b0.best_iteration + 1
    k = fit_k(va.y_npen.values, b0.predict(dva, iteration_range=(0, R)))
    b0[:R].save_model(os.path.join(out_dir, "pen_count.json"))
    one = tr[tr.y_npen == 1].y_pim.values
    c = np.array([(one == d).sum() for d in PEN_DURATIONS], dtype=float)
    c[0] += ((one != 2) & ~np.isin(one, PEN_DURATIONS)).sum()
    mix = c / c.sum()
    rep["penalty_count"] = {"features": feats, "k": k, "rounds": R, "durations": PEN_DURATIONS,
                            "mix_league": [round(float(x), 5) for x in mix], "pseudo": PEN_PSEUDO,
                            "nmax": PEN_NMAX, "trained_at": time.strftime("%Y-%m-%d"),
                            "split": {"train": "<=2021", "val": 2022}}
    json.dump(rep, open(path, "w"), indent=1)
    print(f"   pénalités en nombre : {R} arbres, k {k}, durées {dict(zip(PEN_DURATIONS, rep['penalty_count']['mix_league']))}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-only", action="store_true")
    ap.add_argument("--no-vs", action="store_true",
                    help="N'essaie pas les face-à-face (modèle sans vs_* pour toutes les stats)")
    ap.add_argument("--no-refs", action="store_true",
                    help="N'essaie pas les variables arbitre (ref_pen / ref_pp)")
    ap.add_argument("--penalties", action="store_true",
                    help="N'entraîne que le modèle des pénalités en nombre (pen_count.json)")
    ap.add_argument("--recent", action="store_true",
                    help="Réentraîne sur les saisons récentes les stats de RECENT_STATS (à faire chaque été)")
    args = ap.parse_args()
    t0 = time.time()
    print("⛸️  lecture des patineurs MoneyPuck …")
    pg = per_game(load_skaters(os.path.join(DATA_DIR, "raw")))
    print(f"   {len(pg)} patineur-matchs ({time.time()-t0:.0f}s)")
    out_dir = os.path.join(MODELS_DIR, "player")
    os.makedirs(out_dir, exist_ok=True)

    pre = rolling_features(pg, shift=1)
    write_state(pg, pre)
    if args.state_only:
        refresh_player_level(pg, pre, int(pg.season.max()))
        return

    if args.penalties:
        train_penalty_count(build_frame(pg, pre), out_dir)
        return
    if args.recent:
        retrain_recent(build_frame(pg, pre), out_dir)
        refresh_player_level(pg, pre, int(pg.season.max()))
        return

    df = build_frame(pg, pre)
    ref_games = RE.load_ref_games(DATA_DIR)
    BASE = feature_names()
    WITH_VS = BASE + VS_FEATS
    tr, va, te = df[df.season <= 2021], df[df.season == 2022], df[df.season >= 2023]
    print(f"   entraînement {len(tr)} / validation {len(va)} / test {len(te)}")
    print(f"   face-à-face (test) : {float((te.vs_gp > 0).mean()):.0%} des lignes ont ≥ 1 rencontre "
          f"passée, médiane {float(te.vs_gp.median()):.0f}")

    params = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50,
                  subsample=0.8, colsample_bytree=0.8, eval_metric="poisson-nloglik",
                  max_delta_step=0.7, nthread=os.cpu_count() or 2, seed=7)
    # Lift plus haut ⇒ prédiction plus haute (jamais l'inverse). vs_gp libre :
    # il sert au modèle à juger combien croire le lift.
    params_vs = dict(params, monotone_constraints={f"vs_lift_{s}": 1 for s in STATS})

    def fit(feats, p, y):
        dtr = xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats)
        dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
        bst = xgb.train(p, dtr, 2000, evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        it = (0, bst.best_iteration + 1)
        mu_va = bst.predict(dva, iteration_range=it)
        k = fit_k(va[y].values, mu_va)
        mu_te = bst.predict(xgb.DMatrix(te[feats], feature_names=feats), iteration_range=it)
        return bst[: it[1]], it[1], k, mu_va, mu_te

    report, vs_report, ref_report = {}, {}, {}
    try_refs = ref_games is not None and not args.no_refs
    yrs = te.season.values
    has_vs = (te.vs_gp >= 3).values
    for s in STATS:
        y = f"y_{s}"
        yv, yt = va[y].values, te[y].values
        b0, r0, k0, mva0, mte0 = fit(BASE, params, y)
        chosen = (b0, r0, k0, mte0, BASE)
        if not args.no_vs:
            b1, r1, k1, mva1, mte1 = fit(WITH_VS, params_vs, y)
            # Écarts appariés de log-vraisemblance (positif = face-à-face meilleur).
            d_va = nb_ll(yv, mva1, k1) - nb_ll(yv, mva0, k0)
            d_te = nb_ll(yt, mte1, k1) - nb_ll(yt, mte0, k0)
            z = float(d_te.mean() / (d_te.std(ddof=1) / np.sqrt(len(d_te))))
            per_season = {int(ss): round(float(d_te[yrs == ss].mean()), 6) for ss in np.unique(yrs)}
            # Règle (posée avant de lire le résultat) : on garde le face-à-face pour
            # cette stat si la log-vraisemblance s'améliore sur la validation ET sur
            # le test, avec z ≥ 2 sur le test.
            keep = bool(d_va.mean() > 0 and d_te.mean() > 0 and z >= 2)
            # Effet concret sur les joueurs à ≥ 3 rencontres : de combien la
            # cadence bouge-t-elle selon que le lift est haut ou bas ?
            lift = te[f"vs_lift_{s}"].values
            ratio = mte1 / np.maximum(mte0, 1e-6)
            hi, lo = has_vs & (lift >= 1.2), has_vs & (lift <= 0.8)
            vs_report[s] = {
                "keep": keep, "z_test": round(z, 2),
                "dll_val": round(float(d_va.mean()), 6), "dll_test": round(float(d_te.mean()), 6),
                "dll_test_by_season": per_season,
                "loglik_base": round(float(nb_ll(yt, mte0, k0).mean()), 5),
                "loglik_vs": round(float(nb_ll(yt, mte1, k1).mean()), 5),
                "pred_ratio_when_lift_ge_1.2": round(float(ratio[hi].mean()), 4) if hi.any() else None,
                "pred_ratio_when_lift_le_0.8": round(float(ratio[lo].mean()), 4) if lo.any() else None,
                "obs_over_base_when_lift_ge_1.2": round(float(yt[hi].sum() / mte0[hi].sum()), 4) if hi.any() else None,
                "obs_over_base_when_lift_le_0.8": round(float(yt[lo].sum() / mte0[lo].sum()), 4) if lo.any() else None,
                "n_lift_ge_1.2": int(hi.sum()), "n_lift_le_0.8": int(lo.sum()),
            }
            print(f"   {s:9s} face-à-face : {vs_report[s]}", flush=True)
            if keep:
                chosen = (b1, r1, k1, mte1, WITH_VS)
        if try_refs and s in REF_TRY_STATS:
            # Arbitres : mêmes features que le modèle retenu ci-dessus, + ref_*.
            # Même règle que le face-à-face, posée avant le run (2026-10-12).
            cur_feats = chosen[4]
            mva_c = chosen[0].predict(xgb.DMatrix(va[cur_feats], feature_names=cur_feats))
            ref_feats = cur_feats + RE.REF_FEATS
            p_ref = params_vs if cur_feats is WITH_VS else params
            b2, r2, k2, mva2, mte2 = fit(ref_feats, p_ref, y)
            d_va = nb_ll(yv, mva2, k2) - nb_ll(yv, mva_c, chosen[2])
            d_te = nb_ll(yt, mte2, k2) - nb_ll(yt, chosen[3], chosen[2])
            z = float(d_te.mean() / (d_te.std(ddof=1) / np.sqrt(len(d_te))))
            keep = bool(d_va.mean() > 0 and d_te.mean() > 0 and z >= 2)
            ref_report[s] = {"keep": keep, "z_test": round(z, 2),
                             "dll_val": round(float(d_va.mean()), 6), "dll_test": round(float(d_te.mean()), 6),
                             "dll_test_by_season": {int(ss): round(float(d_te[yrs == ss].mean()), 6)
                                                    for ss in np.unique(yrs)}}
            print(f"   {s:9s} arbitres : {ref_report[s]}", flush=True)
            if keep:
                chosen = (b2, r2, k2, mte2, ref_feats)
        bst, rounds, k, mu, feats = chosen
        base = baseline(te, s)
        kb = fit_k(yv, baseline(va, s))
        report[s] = {
            "k": k, "k_rules": kb, "rounds": rounds, "features": feats,
            "loglik_model": round(float(nb_ll(yt, mu, k).mean()), 5),
            "loglik_rules": round(float(nb_ll(yt, base, kb).mean()), 5),
            "brier_ge1_model": round(float(((p_ge1(mu, k) - (yt >= 1)) ** 2).mean()), 5),
            "brier_ge1_rules": round(float(((p_ge1(base, kb) - (yt >= 1)) ** 2).mean()), 5),
            "mean_obs": round(float(yt.mean()), 4), "mean_model": round(float(mu.mean()), 4),
        }
        bst.save_model(os.path.join(out_dir, f"{s}.json"))
        print(f"   {s:9s} {({k_: v for k_, v in report[s].items() if k_ != 'features'})}  "
              f"vs={'oui' if 'vs_gp' in feats else 'non'} "
              f"arbitres={'oui' if 'ref_pen' in feats else 'non'} ({time.time()-t0:.0f}s)", flush=True)

    union = BASE + [f for f in VS_FEATS + RE.REF_FEATS
                    if any(f in r["features"] for r in report.values())]
    json.dump({"trained_at": time.strftime("%Y-%m-%d"),
               # Union des features — chaque stat a sa propre liste dans stats[s].features.
               "features": union,
               "split": {"train": "<=2021", "val": 2022, "test": ">=2023"},
               "stats": report}, open(os.path.join(MODELS_DIR, "player_report.json"), "w"), indent=1)
    if vs_report:
        json.dump({"trained_at": time.strftime("%Y-%m-%d"), "window": VS_WINDOW, "pseudo": VS_PSEUDO,
                   "features": VS_FEATS,
                   "rule": "garder si Δ log-vraisemblance > 0 en validation ET en test, avec z ≥ 2 en test",
                   "stats": vs_report},
                  open(os.path.join(MODELS_DIR, "player_vs_report.json"), "w"), indent=1)
    if ref_report:
        json.dump({"trained_at": time.strftime("%Y-%m-%d"), "features": RE.REF_FEATS,
                   "shrink": RE.REF_SHRINK, "league_window": RE.LEAGUE_WINDOW,
                   "rule": "garder si Δ log-vraisemblance > 0 en validation ET en test, avec z ≥ 2 en test",
                   "stats": ref_report},
                  open(os.path.join(MODELS_DIR, "player_ref_report.json"), "w"), indent=1)
    print("✅ modèle joueur écrit")
    train_penalty_count(df, out_dir)
    # Les stats où ça a été mesuré meilleur repartent des saisons récentes.
    retrain_recent(df, out_dir)
    # Les cadences ont changé : le recalage se refait sur le NOUVEAU modèle.
    refresh_player_level(pg, pre, int(pg.season.max()))


if __name__ == "__main__":
    main()
