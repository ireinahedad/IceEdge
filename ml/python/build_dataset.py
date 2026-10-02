"""
build_dataset.py
================
Construit le dataset v4 à partir des sorties de fetch_data_v4.py.
Toutes les features sont PRÉ-MATCH (EWMA/rolling décalés d'un match → zéro leakage).

Familles de features :
  • Stats avancées équipe (MoneyPuck)  : xGF/xGA par 60, xGF%, Corsi%, high-danger,
    finishing (buts - xG), PP/PK par xG, rolling court (EWMA hl=6) + long (EWMA hl=20)
  • Gardien partant                    : save%, GSAx/60 sur ses derniers départs,
    + charge de travail (départs sur les 10 derniers matchs d'équipe)
  • Top joueurs                        : "star power" = somme des pts/match EWMA du
    top-3 présent, joueurs clés absents (top-5 habituel qui ne joue pas)
  • Calendrier                         : repos, back-to-back, 3 matchs en 4 soirs
  • ELO                                : identique v3 (base 1500, K=6, MOV, régression)
  • Cotes                              : probabilité implicite dévigée open/close

Sorties :
    ml/data/nhl_games_v4.csv
    ml/models/inference_state.json   (état par équipe pour l'inférence temps réel)
    ml/models/elo_ratings.json

Usage :
    cd ml/python
    python fetch_data_v4.py      # d'abord
    python build_dataset.py
"""

import json
import os
import sys

import numpy as np
import pandas as pd

DATA_DIR   = "../data"
MODELS_DIR = "../models"

SHORT_HL, LONG_HL = 6, 20         # demi-vies EWMA (matchs)
GOALIE_HL         = 8             # demi-vie EWMA gardien (départs) — legacy, cf. ci-dessous
MIN_GP            = 5             # matchs minimum avant d'émettre une ligne

# ── Gardien : régression vers la moyenne (P3) ────────────────────────────────
# Le GSAx60 d'un gardien est essentiellement du bruit à court terme. Mesuré sur
# 45 222 départs :
#   • fiabilité pair/impair intra-saison : 0.19 à 0.25 — et elle N'AUGMENTE PAS
#     avec le nombre de départs (10-20 départs : 0.242 ; 50-90 : 0.246)
#   • corrélation entre le GSAx60 passé et celui du match suivant : r = +0.038
#
# L'EWMA hl=8 avec min_periods=3 laissait un gardien à 3 départs peser autant
# qu'un vétéran, avec des valeurs allant jusqu'à ±3.4 GSAx60 — du pur bruit
# d'échantillonnage. On estime désormais par cumul régressé vers 0 :
#
#     gsax60 = Σ(GSAx passés) / (Σ(heures passées) + GOALIE_PRIOR_HOURS)
#
# GOALIE_PRIOR_HOURS = 50 h a été retenu par optimisation directe de la
# corrélation avec le match suivant (testé de 0 à 600 h). L'écart-type des
# estimations tombe de 0.394 à 0.119, ce qui correspond à l'écart réel mesuré
# entre quartiles de gardiens (Q4−Q1 = 0.165 but/60, à xG subi identique).
GOALIE_PRIOR_HOURS = 50.0
GOALIE_PRIOR_SVPCT = 0.906        # % d'arrêts moyen de la ligue
GOALIE_PRIOR_STARTS = 50          # pseudo-départs pour la régression du sv%

# ── Gardien de relève (2026-09-27) ───────────────────────────────────────────
# Le partant a-t-il commencé moins de 40 % des 10 matchs précédents de son
# équipe ? Ses stats de carrière, régressées vers la moyenne, font ressembler un
# réserviste à un titulaire ; l'analyse de l'écart au marché (`--market-gap`) a
# mesuré que ce drapeau porte une information absente du modèle (z −3,9). Même
# définition dans l'état d'inférence (`share_last10`), pour que le service
# calcule le drapeau du partant confirmé exactement comme à l'entraînement.
GOALIE_BACKUP_WINDOW = 10
GOALIE_BACKUP_SHARE = 0.40
GOALIE_BACKUP_MIN_HISTORY = 5

# ── Alignement : projection bottom-up (P3) ───────────────────────────────────
# Somme, sur les patineurs réellement habillés, de leur taux de xG individuel
# passé × leur temps de glace projeté. Remplace avantageusement les proxys
# grossiers (`star_power` = somme des ppg du top-3 disponible) : mesuré en
# déviance Poisson de validation, 1.05500 → 1.05232, et log-loss moneyline
# 0.6687 → 0.6675. Les deux signaux sont complémentaires — on garde les deux.
LINEUP_HL = 20                    # demi-vie EWMA par joueur (matchs)
LINEUP_RECENT_GAMES = 25          # fenêtre définissant l'effectif « actuel »
LINEUP_ROSTER_MAX   = 26          # profondeur conservée (marge pour les absences)
LINEUP_DRESSED      = 18          # patineurs habillés par match (12 att. + 6 déf.)
# Bassin de patineurs (2026-10-02) : TOUS les patineurs vus dans la ligue sur
# les LINEUP_POOL_DAYS derniers jours, indexés par identifiant NHL, avec les
# cadences de leur dernier match — quelle que soit l'équipe. Il ne sert que
# quand le serveur fournit l'alignement OFFICIEL du soir (API NHL) : le service
# additionne alors exactement les habillés, comme l'entraînement additionne les
# joueurs qui ont réellement joué (dont les cadences sont propres au JOUEUR, pas
# à l'équipe). Deux trous que l'effectif récent (LINEUP_RECENT_GAMES matchs de
# l'équipe) laissait :
#   • le joueur de retour d'une longue blessure en était sorti — le soir de son
#     retour, le modèle ne pouvait pas le compter ;
#   • le joueur arrivé d'une autre équipe (échange, agent libre) n'y était pas
#     encore — mesuré le 2026-10-01 sur SEA–CGY : par équipe, 15 habillés de
#     CGY sur 18 seulement étaient connus.
# Une recrue sans match NHL n'a pas de cadence : elle compte 0, exactement
# comme à l'entraînement (cadence NaN, ignorée par la somme).
LINEUP_POOL_DAYS    = 550

# ── ELO (identique à train.py v3) ────────────────────────────────────────────
ELO_BASE, ELO_K, ELO_HOME_ADV, ELO_SEASON_REGRESS = 1500.0, 6.0, 50.0, 0.30


def elo_expected_home(rh: float, ra: float) -> float:
    return 1.0 / (1.0 + 10 ** (-((rh + ELO_HOME_ADV) - ra) / 400.0))


def norm_team(abbr: str) -> str:
    m = {"ATL": "WPG", "PHX": "ARI", "ARI": "UTA", "L.A": "LAK", "S.J": "SJS",
         "N.J": "NJD", "T.B": "TBL"}
    abbr = (str(abbr) or "").strip().upper()
    while abbr in m:
        abbr = m[abbr]
    return abbr


def mp_date(v) -> str:
    s = str(int(v)) if not isinstance(v, str) else v.replace("-", "")
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def need_cols(df: pd.DataFrame, cols: list[str], src: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        print(f"❌ Colonnes manquantes dans {src}: {missing}")
        print(f"   Colonnes disponibles : {list(df.columns)}")
        sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Features équipe (MoneyPuck, par situation)
# ══════════════════════════════════════════════════════════════════════════════

def _season_prior_ewm(x: pd.Series, seas: pd.Series, hl: float,
                      k: float) -> pd.Series:
    """Moyenne mobile qui repart à chaque saison, amorcée par la précédente.

    Variante « saison d'abord » des EWMA continus, pour le mode `--recency` de
    backtest_walkforward.py. L'EWMA continu ignore le changement de saison : au
    10e match d'octobre, sa version longue (hl=20) repose encore à ~70 % sur la
    saison précédente, c'est-à-dire sur l'effectif d'avant l'été.

    Ici, pour le match N d'une saison :

        cur   = EWMA(hl) des matchs antérieurs de la MÊME saison
        prior = moyenne de la saison précédente complète de l'équipe
        n     = nombre de ces matchs antérieurs
        valeur = (n·cur + k·prior) / (n + k)

    La saison précédente vaut donc k matchs : elle domine en ouverture, puis
    s'efface (k=5 : 50 % au 5e match, 25 % au 15e). Sans saison précédente
    (équipe d'expansion), même plancher que l'original : 3 matchs.

    Aucune fuite : `prior` ne contient que des saisons terminées avant le
    match, `cur` que des matchs antérieurs (décalage d'un match).
    """
    prev = x.groupby(seas).shift(1)
    cur = prev.groupby(seas).transform(
        lambda s: s.ewm(halflife=hl, min_periods=1).mean())
    n = prev.notna().astype(float).groupby(seas).cumsum()
    season_mean = x.groupby(seas).mean().sort_index()
    prior = seas.map(season_mean.shift(1))
    blended = (n * cur + k * prior) / (n + k)
    out = blended.where(prior.notna(), cur.where(n >= 3))
    # Premier match de la saison : `cur` est vide, seule la saison passée parle.
    return out.where(~(prior.notna() & (n == 0)), prior)


def build_team_features(season_prior_k: float | None = None
                        ) -> tuple[pd.DataFrame, dict]:
    """Features d'équipe roulantes et état d'inférence.

    `season_prior_k=None` (défaut) : EWMA continus, comportement historique.
    Une valeur k : variante « saison d'abord » (`_season_prior_ewm`), utilisée
    UNIQUEMENT par la mesure `--recency`. L'état d'inférence reste calculé à
    l'ancienne dans les deux cas : la variante n'est pas servie.
    """
    print("📊 Features équipe (MoneyPuck) …")
    mp = pd.read_csv(f"{DATA_DIR}/mp_team_games.csv", low_memory=False)
    need_cols(mp, ["playerTeam", "opposingTeam", "home_or_away", "gameDate", "gameId",
                   "situation", "iceTime", "xGoalsFor", "xGoalsAgainst",
                   "shotAttemptsFor", "shotAttemptsAgainst", "goalsFor", "goalsAgainst",
                   "highDangerxGoalsFor", "highDangerxGoalsAgainst",
                   "shotsOnGoalFor", "shotsOnGoalAgainst"], "mp_team_games.csv")

    mp["team"] = mp["playerTeam"].map(norm_team)
    mp["date"] = mp["gameDate"].map(mp_date)

    def per_situation(sit: str, prefix: str, cols: dict[str, str]) -> pd.DataFrame:
        d = mp[mp["situation"] == sit].copy()
        hours = d["iceTime"].replace(0, np.nan) / 3600.0
        out = d[["team", "date", "gameId"]].copy()
        for src, dst in cols.items():
            if src.endswith("_per60"):
                base = src[:-6]
                out[f"{prefix}{dst}"] = d[base] / hours
            else:
                out[f"{prefix}{dst}"] = d[src]
        return out

    all_sit = per_situation("all", "", {
        "goalsFor": "gf", "goalsAgainst": "ga",
        "xGoalsFor_per60": "xgf60", "xGoalsAgainst_per60": "xga60",
        "shotsOnGoalFor": "sog_f", "shotsOnGoalAgainst": "sog_a",
    })
    all_sit["finishing"] = mp.loc[mp["situation"] == "all", "goalsFor"].values \
                         - mp.loc[mp["situation"] == "all", "xGoalsFor"].values
    all_sit["win"] = (all_sit["gf"] > all_sit["ga"]).astype(float)   # hors SO — proxy forme

    ev = per_situation("5on5", "ev_", {
        "xGoalsFor_per60": "xgf60", "xGoalsAgainst_per60": "xga60",
        "highDangerxGoalsFor_per60": "hdxgf60", "highDangerxGoalsAgainst_per60": "hdxga60",
    })
    d5 = mp[mp["situation"] == "5on5"]
    ev["ev_cf_pct"]  = (d5["shotAttemptsFor"] /
                        (d5["shotAttemptsFor"] + d5["shotAttemptsAgainst"]).replace(0, np.nan)).values
    ev["ev_xgf_pct"] = (d5["xGoalsFor"] /
                        (d5["xGoalsFor"] + d5["xGoalsAgainst"]).replace(0, np.nan)).values

    pp = per_situation("5on4", "pp_", {"xGoalsFor_per60": "xgf60"})
    pk = per_situation("4on5", "pk_", {"xGoalsAgainst_per60": "xga60"})

    tg = all_sit.merge(ev, on=["team", "date", "gameId"], how="left") \
                .merge(pp, on=["team", "date", "gameId"], how="left") \
                .merge(pk, on=["team", "date", "gameId"], how="left") \
                .sort_values(["team", "date", "gameId"]).reset_index(drop=True)

    raw_cols = [c for c in tg.columns if c not in ("team", "date", "gameId")]

    # EWMA décalés (la ligne du match N n'utilise que les matchs < N)
    feats, state = [], {}
    for team, g in tg.groupby("team", sort=False):
        g = g.sort_values(["date", "gameId"]).reset_index(drop=True)
        block = {"team": team, "date": g["date"], "gameId": g["gameId"],
                 "team_gp": np.arange(len(g))}
        # Saison NHL lue dans l'identifiant de match (2008020001 → 2008) et
        # non dans la date : les séries de la bulle 2020 se sont jouées en
        # août-septembre et tomberaient sinon dans la saison suivante.
        seas = ((g["gameId"].astype("int64") // 1_000_000).astype(int)
                if season_prior_k is not None else None)
        for c in raw_cols:
            if season_prior_k is None:
                shifted = g[c].shift(1)
                block[f"{c}_s"] = shifted.ewm(halflife=SHORT_HL, min_periods=3).mean()
                block[f"{c}_l"] = shifted.ewm(halflife=LONG_HL, min_periods=3).mean()
            else:
                for suf, hl in (("_s", SHORT_HL), ("_l", LONG_HL)):
                    block[f"{c}{suf}"] = _season_prior_ewm(g[c], seas, hl,
                                                           season_prior_k)
        feats.append(pd.DataFrame(block))
        # État final pour l'inférence (inclut le dernier match joué)
        state[team] = {f"{c}_s": round(float(g[c].ewm(halflife=SHORT_HL).mean().iloc[-1]), 4)
                       for c in raw_cols if g[c].notna().any()}
        state[team].update({f"{c}_l": round(float(g[c].ewm(halflife=LONG_HL).mean().iloc[-1]), 4)
                            for c in raw_cols if g[c].notna().any()})
        state[team]["last_game_date"] = str(g["date"].iloc[-1])

    out = pd.concat(feats, ignore_index=True)
    print(f"   ✅ {len(out)} lignes équipe-match, {len(raw_cols) * 2} features rolling")
    return out, state


# ══════════════════════════════════════════════════════════════════════════════
# 2. Features gardien partant
# ══════════════════════════════════════════════════════════════════════════════

def build_goalie_features() -> tuple[pd.DataFrame, dict]:
    print("🥅 Features gardien …")
    gl = pd.read_csv(f"{DATA_DIR}/mp_goalie_games.csv", low_memory=False)
    if "situation" in gl.columns:
        gl = gl[gl["situation"] == "all"].copy()
    need_cols(gl, ["playerId", "name", "playerTeam", "gameId", "gameDate",
                   "icetime", "xGoals", "goals", "ongoal"], "mp_goalie_games.csv")

    gl["team"] = gl["playerTeam"].map(norm_team)
    gl["date"] = gl["gameDate"].map(mp_date)

    # Partant = gardien avec le plus de temps de glace du match
    gl = gl.sort_values(["team", "gameId", "icetime"], ascending=[True, True, False])
    starters = gl.drop_duplicates(subset=["team", "gameId"], keep="first").copy()

    # Forme du gardien : EWMA sur SES départs (décalé → pré-match)
    starters = starters.sort_values(["playerId", "date"]).reset_index(drop=True)
    starters["hours"] = starters["icetime"].replace(0, np.nan) / 3600.0
    starters["gsax_abs"] = starters["xGoals"] - starters["goals"]   # GSAx absolu du match
    hours = starters["hours"]
    starters["g_gsax60_raw"] = starters["gsax_abs"] / hours
    starters["g_svpct_raw"]  = 1.0 - starters["goals"] / starters["ongoal"].replace(0, np.nan)

    grp = starters.groupby("playerId", sort=False)
    # Cumul régressé vers la moyenne de ligue (cf. GOALIE_PRIOR_HOURS).
    # Aucun min_periods : un gardien sans historique reçoit exactement le prior
    # (0 pour le GSAx60, la moyenne de ligue pour le sv%), ce qui est la bonne
    # réponse — et non un NaN ni une valeur extrême tirée de 3 matchs.
    cum_gsax  = grp["gsax_abs"].transform(lambda s: s.shift(1).cumsum())
    cum_hours = grp["hours"].transform(lambda s: s.shift(1).cumsum())
    starters["goalie_gsax60"] = (
        cum_gsax / (cum_hours.fillna(0.0) + GOALIE_PRIOR_HOURS)).fillna(0.0)

    cum_sv = grp["g_svpct_raw"].transform(lambda s: s.shift(1).expanding().mean())
    n_prev = grp.cumcount()
    starters["goalie_svpct"] = (
        (cum_sv.fillna(GOALIE_PRIOR_SVPCT) * n_prev
         + GOALIE_PRIOR_SVPCT * GOALIE_PRIOR_STARTS)
        / (n_prev + GOALIE_PRIOR_STARTS))
    starters["goalie_starts"] = n_prev

    # Relève : part des GOALIE_BACKUP_WINDOW matchs précédents de l'ÉQUIPE
    # commencés par ce partant (décalé : le match du soir n'y est pas).
    starters = starters.sort_values(["team", "date", "gameId"]).reset_index(drop=True)
    backup = np.full(len(starters), np.nan)
    for _, g in starters.groupby("team", sort=False):
        pid = g["playerId"].to_numpy()
        for j, i in enumerate(g.index):
            prev = pid[max(0, j - GOALIE_BACKUP_WINDOW):j]
            if len(prev) >= GOALIE_BACKUP_MIN_HISTORY:
                backup[i] = float(np.mean(prev == pid[j]) < GOALIE_BACKUP_SHARE)
    starters["goalie_backup"] = backup

    out = starters[["team", "gameId", "date", "name",
                    "goalie_gsax60", "goalie_svpct", "goalie_starts",
                    "goalie_backup"]].copy()

    # État d'inférence : pour chaque équipe, les 2 gardiens les plus utilisés récemment.
    # Les estimations reposent sur la carrière COMPLÈTE du gardien (toutes équipes
    # confondues) et sur le même estimateur régressé qu'à l'entraînement — un
    # gardien échangé en cours de saison ne repart donc pas de zéro.
    career = starters.groupby("playerId").agg(
        gsax_sum=("gsax_abs", "sum"), hours_sum=("hours", "sum"),
        sv_mean=("g_svpct_raw", "mean"), n=("g_svpct_raw", "size"))
    career["gsax60"] = career["gsax_sum"] / (career["hours_sum"] + GOALIE_PRIOR_HOURS)
    career["svpct"] = ((career["sv_mean"].fillna(GOALIE_PRIOR_SVPCT) * career["n"]
                        + GOALIE_PRIOR_SVPCT * GOALIE_PRIOR_STARTS)
                       / (career["n"] + GOALIE_PRIOR_STARTS))

    state: dict = {}
    for team, g in starters.groupby("team"):
        recent = g.sort_values("date").tail(15)
        usage = recent["name"].value_counts(normalize=True)
        last10 = g.sort_values("date").tail(GOALIE_BACKUP_WINDOW)["name"] \
                  .value_counts(normalize=True)
        goalies = []
        for gname, share in usage.head(2).items():
            pid = g.loc[g["name"] == gname, "playerId"].iloc[-1]
            c = career.loc[pid]
            goalies.append({
                "name": gname, "recent_start_share": round(float(share), 3),
                "gsax60": round(float(c["gsax60"]), 4),
                "svpct":  round(float(c["svpct"]), 4),
                "career_starts": int(c["n"]),
                # Part des 10 derniers départs de l'équipe : le service en tire
                # `goalie_backup` pour le partant confirmé (< 0,40 = relève).
                "share_last10": round(float(last10.get(gname, 0.0)), 3),
            })
        state[team] = goalies
    print(f"   ✅ {len(out)} départs de gardien qualifiés")
    return out, state


# ══════════════════════════════════════════════════════════════════════════════
# 2 bis. Projection bottom-up de l'alignement (P3)
# ══════════════════════════════════════════════════════════════════════════════

def build_lineup_features() -> tuple[pd.DataFrame, dict, dict]:
    """Force offensive reconstruite depuis les patineurs réellement habillés.

    Pour chaque joueur, on calcule en pré-match (EWMA décalée, donc sans fuite) :
      • son taux de xG individuel par 60 minutes
      • son temps de glace habituel

    La projection d'équipe est la somme, sur l'alignement du soir, de
    `xg60 × toi / 60`. Contrairement à `star_power` — qui compte des ppg parmi un
    top-5 figé — cette somme baisse exactement de la contribution du joueur absent,
    pondérée par son usage réel.

    Contrôle de cohérence : la somme moyenne vaut 2.84 xG par équipe-match, contre
    2.83 buts réglementaires réellement marqués en moyenne. L'échelle est bonne.

    Retourne (DataFrame (team, date, lineup_*), état d'inférence par équipe,
    bassin de patineurs par identifiant NHL).
    """
    print("👥 Projection bottom-up de l'alignement …")
    sk = pd.read_csv(f"{DATA_DIR}/mp_skater_games.csv", low_memory=False)
    need_cols(sk, ["playerId", "name", "playerTeam", "gameDate", "situation",
                   "icetime", "I_F_xGoals", "I_F_points"], "mp_skater_games.csv")
    if "situation" in sk.columns:
        sk = sk[sk["situation"] == "all"].copy()
    sk = sk[sk["icetime"] > 0].copy()
    sk["team"] = sk["playerTeam"].map(norm_team)
    sk["date"] = sk["gameDate"].map(mp_date)
    sk = sk.sort_values(["playerId", "date"]).reset_index(drop=True)

    sk["xg60"] = sk["I_F_xGoals"] / (sk["icetime"] / 3600.0)
    grp = sk.groupby("playerId", sort=False)
    sk["xg60_prior"] = grp["xg60"].transform(
        lambda s: s.shift(1).ewm(halflife=LINEUP_HL, min_periods=2).mean())
    sk["toi_prior"] = grp["icetime"].transform(
        lambda s: s.shift(1).ewm(halflife=LINEUP_HL, min_periods=2).mean())
    sk["pts_prior"] = grp["I_F_points"].transform(
        lambda s: s.shift(1).ewm(halflife=LINEUP_HL, min_periods=2).mean())
    sk["contrib"] = sk["xg60_prior"] * sk["toi_prior"] / 3600.0

    out = (sk.groupby(["team", "date"], as_index=False)
             .agg(lineup_xg=("contrib", "sum"),
                  lineup_pts=("pts_prior", "sum"),
                  lineup_size=("contrib", "size")))

    # État d'inférence : effectif ACTUEL de chaque équipe.
    #
    # Restreindre aux joueurs vus sur les LINEUP_RECENT_GAMES derniers matchs de
    # l'équipe est indispensable : sans ce filtre, on remonterait tout l'historique
    # de la franchise depuis 2008 et la somme d'alignement serait plus du double de
    # celle vue à l'entraînement — un décalage entraînement/service silencieux.
    valid = sk.dropna(subset=["xg60_prior", "toi_prior"])
    state: dict = {}
    for team, g in valid.groupby("team"):
        recent_dates = sorted(g["date"].unique())[-LINEUP_RECENT_GAMES:]
        g_recent = g[g["date"].isin(recent_dates)]
        last = g_recent.sort_values("date").groupby("playerId").tail(1)
        # Classement par TEMPS DE GLACE, pas par xG : un entraîneur habille par
        # rôle, pas par talent offensif. Trier par xG sélectionnerait 18 marqueurs
        # et surestimerait la projection de 18.6 % ; par temps de glace, l'écart
        # avec l'échelle d'entraînement tombe à 2.3 %.
        roster = last.sort_values("toi_prior", ascending=False).head(LINEUP_ROSTER_MAX)
        state[team] = [_lineup_entry(r) for _, r in roster.iterrows()
                       if r["contrib"] == r["contrib"]]
    # Bassin de patineurs (cf. LINEUP_POOL_DAYS) : servi SEULEMENT avec
    # l'alignement officiel. Chaque joueur garde les cadences de son dernier
    # match, toutes équipes confondues — pour un blessé, celles d'avant la
    # blessure, exactement ce que l'entraînement lui attribue le soir du retour.
    cutoff = (pd.Timestamp(valid["date"].max()) - pd.Timedelta(days=LINEUP_POOL_DAYS)).strftime("%Y-%m-%d")
    last = (valid[valid["date"] >= cutoff].sort_values(["date", "gameId"])
            .groupby("playerId").tail(1))
    pool = {str(int(r["playerId"])): _lineup_entry(r) for _, r in last.iterrows()
            if r["contrib"] == r["contrib"]}
    sums = [sum(p["xg"] for p in v[:LINEUP_DRESSED]) for v in state.values() if v]
    print(f"   ✅ {len(out)} équipes-matchs, somme moyenne {out['lineup_xg'].mean():.3f} xG")
    print(f"   ✅ état d'inférence : {len(state)} équipes, somme top-{LINEUP_DRESSED} "
          f"moyenne {np.mean(sums):.3f} xG (doit rester proche de la valeur ci-dessus)")
    print(f"   ✅ bassin de patineurs : {len(pool)} joueurs "
          f"(vus sur les {LINEUP_POOL_DAYS} derniers jours, toutes équipes)")
    return out, state, pool


def _lineup_entry(r) -> dict:
    """Une ligne d'effectif servie. `id` = identifiant NHL (MoneyPuck reprend
    ceux de la NHL) : c'est lui qui apparie l'alignement officiel, les noms ne
    servant que de repli (accents, orthographes différentes)."""
    return {"id": int(r["playerId"]),
            "name": r["name"],
            "xg": round(float(r["contrib"]), 5),
            "pts": round(float(r["pts_prior"]), 4),
            "toi": round(float(r["toi_prior"]), 1)}


# ══════════════════════════════════════════════════════════════════════════════
# 3. Features top joueurs ("star power")
# ══════════════════════════════════════════════════════════════════════════════

# ── Pondération des absences (source unique) ──────────────────────────────────
# Les poids sont calculés ICI et stockés pré-calculés dans inference_state
# ("keys"[].w) ; ml_service.py les consomme tels quels → parité garantie sans
# dupliquer les constantes.
# Poids d'un joueur clé absent = performance individuelle (ppg EWMA pré-match)
# × rôle. Le rôle combine la position (prime aux D, dont la valeur défensive
# n'est pas captée par la ppg) et le rang dans son groupe (proxy du trio/paire :
# une 1re ligne / 1re paire pèse plus qu'une 3e). Pas de données de trio réelles
# dans l'historique MoneyPuck → le trio est approché par le rang ppg intra-groupe.
STARS_PPG_FLOOR = 0.15     # plancher : un D défensif à faible ppg pèse quand même
STARS_D_PREMIUM = 1.6      # prime défenseur (valeur non captée par la ppg)
STARS_N_TOP_F   = 6        # top-6 attaquants
STARS_N_TOP_D   = 4        # top-4 défenseurs
STARS_F_TIER    = [1.0, 1.0, 0.85, 0.85, 0.70, 0.70]   # rang ppg chez les F (trio)
STARS_D_TIER    = [1.0, 1.0, 0.75, 0.75]               # rang ppg chez les D (paire)


def _norm_pos(p) -> str:
    """C/L/R/W/F → 'F', D → 'D' (défaut 'F' si inconnu)."""
    return "D" if str(p).upper().strip().startswith("D") else "F"


def _player_weight(ppg: float, grp: str, rank: int) -> float:
    """Poids d'un joueur clé absent = perf individuelle × rôle (position + trio)."""
    base = max(float(ppg) if ppg == ppg else 0.0, STARS_PPG_FLOOR)
    if grp == "D":
        tier = STARS_D_TIER[rank] if rank < len(STARS_D_TIER) else STARS_D_TIER[-1]
        return base * STARS_D_PREMIUM * tier
    tier = STARS_F_TIER[rank] if rank < len(STARS_F_TIER) else STARS_F_TIER[-1]
    return base * tier


def _key_pool(active: dict) -> list:
    """top-6 F + top-4 D par ppg → [(pid, ppg, name, grp, rang_intra_groupe)].
    `active` : {pid: [ppg, name, last_seen_idx, pos]}."""
    fwd = sorted((kv for kv in active.items() if kv[1][3] == "F"),
                 key=lambda kv: -kv[1][0])[:STARS_N_TOP_F]
    dfn = sorted((kv for kv in active.items() if kv[1][3] == "D"),
                 key=lambda kv: -kv[1][0])[:STARS_N_TOP_D]
    pool = []
    for rank, (pid, v) in enumerate(fwd):
        pool.append((pid, v[0], v[1], "F", rank))
    for rank, (pid, v) in enumerate(dfn):
        pool.append((pid, v[0], v[1], "D", rank))
    return pool


def build_star_features() -> tuple[pd.DataFrame | None, dict]:
    path = f"{DATA_DIR}/mp_skater_games.csv"
    if not os.path.exists(path):
        print("⛸️  Pas de mp_skater_games.csv — features joueurs ignorées.")
        return None, {}
    print("⭐ Features top joueurs …")
    sk = pd.read_csv(path, low_memory=False)
    if "situation" in sk.columns:
        sk = sk[sk["situation"] == "all"].copy()
    team_col = "playerTeam" if "playerTeam" in sk.columns else "team"
    need_cols(sk, [team_col, "playerId", "name", "gameId", "gameDate", "I_F_points"],
              "mp_skater_games.csv")
    sk["team"] = sk[team_col].map(norm_team)
    sk["date"] = sk["gameDate"].map(mp_date)
    sk["pos"]  = sk["position"].map(_norm_pos) if "position" in sk.columns else "F"
    sk = sk.sort_values(["playerId", "date"]).reset_index(drop=True)

    # ppg EWMA pré-match par joueur (décalé)
    sk["ppg"] = (sk.groupby("playerId")["I_F_points"]
                   .transform(lambda s: s.shift(1).ewm(halflife=15, min_periods=5).mean()))

    # État incrémental par équipe : {playerId: [ppg, name, idx dernier match vu, pos]}
    # → top-5 "habituel" = meilleurs ppg parmi les joueurs vus sur les
    #   10 derniers matchs d'équipe. O(n) au lieu de O(n²).
    rows, state = [], {}
    for team, g in sk.groupby("team", sort=False):
        g = g.sort_values(["date", "gameId"], kind="stable")
        roster: dict = {}          # playerId → [ppg, name, last_seen_game_idx, pos]
        game_idx = 0
        for gid, gg in g.groupby("gameId", sort=False):
            date = gg["date"].iloc[0]
            active = {pid: v for pid, v in roster.items() if game_idx - v[2] <= 10
                      and v[0] == v[0]}                      # exclut NaN
            if active:
                top5 = sorted(active.items(), key=lambda kv: -kv[1][0])[:5]
                playing = set(gg["playerId"])
                present = [kv for kv in top5 if kv[0] in playing]
                # Absence pondérée (perf + position/trio) sur le pool top-6 F + top-4 D
                pool = _key_pool(active)
                out_w = sum(_player_weight(ppg, grp, rank)
                            for pid, ppg, name, grp, rank in pool if pid not in playing)
                rows.append({
                    "team": team, "gameId": gid, "date": date,
                    "star_power": round(sum(kv[1][0] for kv in present[:3]), 4),
                    "stars_missing": len(top5) - len(present),
                    "stars_out_weight": round(out_w, 4),
                })
            for pid, ppg, name, pos in zip(gg["playerId"], gg["ppg"], gg["name"], gg["pos"]):
                roster[pid] = [float(ppg) if ppg == ppg else np.nan, name, game_idx, pos]
            game_idx += 1
        active = {pid: v for pid, v in roster.items()
                  if game_idx - v[2] <= 10 and v[0] == v[0]}
        top5 = sorted(active.items(), key=lambda kv: -kv[1][0])[:5]
        pool = _key_pool(active)
        state[team] = {
            # `id` (identifiant NHL) : apparie l'alignement officiel du soir.
            "top5": [{"id": int(pid), "name": v[1], "ppg": round(v[0], 3)} for pid, v in top5],
            "star_power_full": round(sum(v[0] for _, v in top5[:3]), 4),
            # Pool clé + poids pré-calculé (utilisé tel quel par ml_service.py) :
            # noms = orthographe MoneyPuck (matching des scratches par nom exact).
            "keys": [{"id": int(pid), "name": name, "ppg": round(ppg, 3), "pos": grp,
                      "w": round(_player_weight(ppg, grp, rank), 4)}
                     for pid, ppg, name, grp, rank in pool],
        }
    out = pd.DataFrame(rows)
    print(f"   ✅ {len(out)} lignes star power")
    return out, state


# ══════════════════════════════════════════════════════════════════════════════
# 4. Assemblage : spine + features + calendrier + ELO + cotes
# ══════════════════════════════════════════════════════════════════════════════

def add_schedule(df: pd.DataFrame) -> pd.DataFrame:
    dates = pd.to_datetime(df["date"])
    last: dict[str, pd.Timestamp] = {}
    recent: dict[str, list] = {}
    h_rest, a_rest, h_3in4, a_3in4 = [], [], [], []
    for i, row in df.iterrows():
        d = dates.iloc[i]
        for side, team, rest_list, dense_list in [
            ("h", row["home_team"], h_rest, h_3in4),
            ("a", row["away_team"], a_rest, a_3in4),
        ]:
            rest_list.append(min((d - last[team]).days, 7) if team in last else 3)
            hist = recent.setdefault(team, [])
            dense_list.append(sum(1 for x in hist if (d - x).days <= 3))
            hist.append(d)
            recent[team] = [x for x in hist if (d - x).days <= 6]
            last[team] = d
    df["home_rest_days"], df["away_rest_days"] = h_rest, a_rest
    df["home_b2b"] = (df["home_rest_days"] == 1).astype(int)
    df["away_b2b"] = (df["away_rest_days"] == 1).astype(int)
    df["home_3in4"], df["away_3in4"] = h_3in4, a_3in4
    return df


# ── Voyage / fuseaux / altitude / road-trip ──────────────────────────────────
# Réf. arénas (lat/lon, offset UTC standard, altitude m) + relocations datées.
# Logique IDENTIQUE au miroir TS server/src/services/travel.ts (câblage live).
_ARENAS: dict | None = None
_RELOCS: list | None = None


def _load_arenas() -> tuple[dict, list]:
    global _ARENAS, _RELOCS
    if _ARENAS is None:
        with open(f"{DATA_DIR}/arenas.json", encoding="utf-8") as f:
            data = json.load(f)
        _ARENAS = data["arenas"]
        _RELOCS = data.get("relocations", [])
    return _ARENAS, _RELOCS


def _venue(team: str, date: str) -> dict | None:
    """Aréna d'une équipe à une date — gère les relocations (ex. ARI→UTA 2024)."""
    arenas, relocs = _load_arenas()
    for r in relocs:
        if r["team"] == team and date < r["before"]:
            return r
    return arenas.get(team)


def _haversine(a: dict | None, b: dict | None) -> float:
    if not a or not b:
        return 0.0
    la1, la2 = np.radians(a["lat"]), np.radians(b["lat"])
    dla = np.radians(b["lat"] - a["lat"])
    dlo = np.radians(b["lon"] - a["lon"])
    h = np.sin(dla / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin(dlo / 2) ** 2
    return float(6371.0 * 2 * np.arcsin(min(1.0, np.sqrt(h))))


def add_travel(df: pd.DataFrame) -> pd.DataFrame:
    """Distance, fuseaux, altitude et métriques de road-trip par équipe/match.

    Colonnes : home_/away_ × {distance_km, tz_shift, days_away, road_trip_len,
    road_game_num, getaway, alt_gain} + venue_altitude_m (partagé).
    """
    n = len(df)
    dates = df["date"].tolist()
    homes = df["home_team"].tolist()
    aways = df["away_team"].tolist()

    # Séquence ordonnée des matchs par équipe : (index_ligne, date, is_home).
    # df est déjà trié par (date, game_id) → l'ordre d'apparition est chronologique.
    from collections import defaultdict
    seq: dict[str, list] = defaultdict(list)
    for i in range(n):
        seq[homes[i]].append((i, dates[i], True))
        seq[aways[i]].append((i, dates[i], False))

    cols = ["distance_km", "tz_shift", "days_away",
            "road_trip_len", "road_game_num", "getaway", "alt_gain"]
    home_out = {c: [np.nan] * n for c in cols}
    away_out = {c: [np.nan] * n for c in cols}
    venue_alt = [np.nan] * n
    for i in range(n):
        v = _venue(homes[i], dates[i])
        venue_alt[i] = v["alt"] if v else np.nan

    for team, games in seq.items():
        gv = [_venue(homes[i], d)  # aréna du match = équipe à domicile ce soir-là
              for (i, d, _is_home) in games]
        for k, (i, d, is_home) in enumerate(games):
            cur = gv[k]
            out = home_out if is_home else away_out

            # Segment depuis l'aréna précédent
            if k > 0 and cur and gv[k - 1]:
                prev = gv[k - 1]
                dist = _haversine(prev, cur)
                tzs  = cur["tz"] - prev["tz"]
                altg = cur["alt"] - prev["alt"]
            else:
                dist, tzs, altg = 0.0, 0, 0

            if is_home:
                road_len = road_num = getaway = days_away = 0
            else:
                road_num = 0
                j = k
                while j >= 0 and not games[j][2]:
                    road_num += 1
                    j -= 1
                road_len = road_num
                j = k + 1
                while j < len(games) and not games[j][2]:
                    road_len += 1
                    j += 1
                getaway = 1 if (k + 1 < len(games) and games[k + 1][2]) else 0
                last_home = next((games[j][1] for j in range(k - 1, -1, -1)
                                  if games[j][2]), None)
                base = last_home if last_home is not None else games[0][1]
                days_away = (pd.Timestamp(d) - pd.Timestamp(base)).days

            out["distance_km"][i]   = dist
            out["tz_shift"][i]      = tzs
            out["alt_gain"][i]      = altg
            out["days_away"][i]     = days_away
            out["road_trip_len"][i] = road_len
            out["road_game_num"][i] = road_num
            out["getaway"][i]       = getaway

    for c in cols:
        df[f"home_{c}"] = home_out[c]
        df[f"away_{c}"] = away_out[c]
    df["venue_altitude_m"] = venue_alt
    return df


def add_elo(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    ratings: dict[str, float] = {}
    prev = None
    cols = {k: [] for k in ("home_elo", "away_elo", "elo_diff", "elo_expected")}
    dates = pd.to_datetime(df["date"])
    for i, row in df.iterrows():
        d = dates.iloc[i]
        if prev is not None and (d - prev).days > 60:
            for t in ratings:
                ratings[t] += ELO_SEASON_REGRESS * (ELO_BASE - ratings[t])
        prev = d
        h, a = row["home_team"], row["away_team"]
        rh, ra = ratings.get(h, ELO_BASE), ratings.get(a, ELO_BASE)
        exp = elo_expected_home(rh, ra)
        cols["home_elo"].append(rh); cols["away_elo"].append(ra)
        cols["elo_diff"].append(rh - ra); cols["elo_expected"].append(exp)
        margin = abs(int(row["home_score"]) - int(row["away_score"])) or 1
        mov = 0.6686 * np.log(margin) + 0.8048
        outcome = 1.0 if row["home_score"] > row["away_score"] else 0.0
        delta = ELO_K * mov * (outcome - exp)
        ratings[h], ratings[a] = rh + delta, ra - delta
    for k, v in cols.items():
        df[k] = v
    return df, ratings


def devig(p_home_raw: pd.Series, p_away_raw: pd.Series) -> pd.Series:
    s = p_home_raw + p_away_raw
    return p_home_raw / s


# ══════════════════════════════════════════════════════════════════════════════
# Cibles du modèle de score (P2) — prolongation et buts réglementaires
# ══════════════════════════════════════════════════════════════════════════════

def build_ot_flags() -> pd.DataFrame:
    """Détecte les matchs allés en prolongation via le temps de glace MoneyPuck.

    Aucune colonne du dataset n'indique la prolongation. Mais `iceTime` en
    situation 'all' donne la durée réelle du match : 3600 s en temps
    réglementaire, davantage sinon (3600 + jusqu'à 300 s d'OT, puis fusillade).

    Vérifié sur 46 444 lignes : 79.5 % à exactement 60 min, le reste réparti
    entre 61-65 min — soit un taux de prolongation de 23.0 %, qui correspond
    au taux NHL connu.

    Retourne un DataFrame (team, date, went_to_ot).
    """
    mp = pd.read_csv(f"{DATA_DIR}/mp_team_games.csv", low_memory=False,
                     usecols=["playerTeam", "gameDate", "situation", "iceTime"])
    a = mp[mp["situation"] == "all"].copy()
    a["team"] = a["playerTeam"].map(norm_team)
    a["date"] = a["gameDate"].map(mp_date)
    # Marge de 10 s : un match réglementaire ne dépasse jamais 3610 s
    a["went_to_ot"] = (a["iceTime"] > 3610).astype(int)
    out = a.groupby(["team", "date"], as_index=False)["went_to_ot"].max()
    print(f"⏱️  Prolongations détectées : {out['went_to_ot'].mean():.1%} des équipes-matchs")
    return out


def add_score_targets(df: pd.DataFrame, ot: pd.DataFrame) -> pd.DataFrame:
    """Ajoute les cibles du modèle de score.

    Un match en prolongation était forcément à égalité à la fin du temps
    réglementaire : le score réglementaire vaut donc min(dom, ext) des deux
    côtés, et le but supplémentaire (OT ou fusillade) revient au vainqueur.
    C'est exact, pas une approximation.
    """
    df = df.merge(ot.rename(columns={"team": "home_team", "went_to_ot": "_ot"}),
                  on=["home_team", "date"], how="left")
    tied = df["_ot"].fillna(0).astype(int) == 1
    low = df[["home_score", "away_score"]].min(axis=1)
    df["went_to_ot"] = df["_ot"]
    df["home_reg_score"] = np.where(tied, low, df["home_score"])
    df["away_reg_score"] = np.where(tied, low, df["away_score"])
    df["reg_total_goals"] = df["home_reg_score"] + df["away_reg_score"]
    df = df.drop(columns=["_ot"])
    cov = df["went_to_ot"].notna().mean()
    print(f"🥅 Cibles de score : couverture prolongation {cov:.1%}, "
          f"buts réglementaires moy {df['reg_total_goals'].mean():.2f}")
    return df


def main():
    for f in ("games_spine.csv", "mp_team_games.csv", "mp_goalie_games.csv"):
        if not os.path.exists(f"{DATA_DIR}/{f}"):
            print(f"❌ {f} manquant — lance d'abord : python fetch_data_v4.py")
            sys.exit(1)

    spine = pd.read_csv(f"{DATA_DIR}/games_spine.csv")
    spine["home_team"] = spine["home_team"].map(norm_team)
    spine["away_team"] = spine["away_team"].map(norm_team)
    spine = spine.sort_values(["date", "game_id"]).reset_index(drop=True)
    print(f"📂 Spine : {len(spine)} matchs")

    team_feats, team_state   = build_team_features()
    goalie_feats, goalie_state = build_goalie_features()
    lineup_feats, lineup_state, skater_pool = build_lineup_features()
    star_feats, star_state   = build_star_features()

    df = spine.copy()
    df["home_win"]    = (df["home_score"] > df["away_score"]).astype(int)
    df["total_goals"] = df["home_score"] + df["away_score"]
    df = add_score_targets(df, build_ot_flags())

    # Merge des features par (équipe, gameId MoneyPuck ≠ game_id NHL) → clé (team, date)
    def merge_side(base, feats, side):
        f = feats.drop(columns=["gameId"], errors="ignore") \
                 .drop(columns=["name"], errors="ignore")
        f = f.rename(columns={c: f"{side}_{c}" for c in f.columns if c not in ("team", "date")})
        f = f.drop_duplicates(subset=["team", "date"], keep="last")
        return base.merge(f, left_on=[f"{side}_team", "date"],
                          right_on=["team", "date"], how="left") \
                   .drop(columns=["team"])

    for side in ("home", "away"):
        df = merge_side(df, team_feats, side)
        df = merge_side(df, goalie_feats, side)
        df = merge_side(df, lineup_feats, side)
        if star_feats is not None and not star_feats.empty:
            df = merge_side(df, star_feats, side)

    df = add_schedule(df)
    df = add_travel(df)
    df, final_elo = add_elo(df)

    # ── Cotes ────────────────────────────────────────────────────────────────
    odds_path = f"{DATA_DIR}/odds.csv"
    if os.path.exists(odds_path):
        odds = pd.read_csv(odds_path)
        odds["home_team"] = odds["home_team"].map(norm_team)
        odds["away_team"] = odds["away_team"].map(norm_team)
        odds = odds.drop_duplicates(subset=["date", "home_team", "away_team"], keep="last")
        df = df.merge(odds, on=["date", "home_team", "away_team"], how="left")
        for stage in ("open", "close"):
            h, a = df.get(f"home_ml_{stage}"), df.get(f"away_ml_{stage}")
            if h is not None and a is not None:
                df[f"market_home_p_{stage}"] = devig(1 / h, 1 / a)
        cov = df["market_home_p_close"].notna().mean() if "market_home_p_close" in df else 0
        print(f"💰 Cotes fusionnées — couverture clôture : {cov:.1%}")

        # ── Marchés dérivés dévigés ──────────────────────────────────────────
        # Même traitement que le moneyline : on retire la marge du bookmaker
        # pour obtenir une probabilité comparable à celle du modèle. Sans ça,
        # tout « edge » calculé contient la marge et est faux d'environ 2 points.
        for stage in ("open", "close"):
            o, u = df.get(f"total_{stage}_over"), df.get(f"total_{stage}_under")
            if o is not None and u is not None:
                df[f"market_over_p_{stage}"] = devig(1 / o, 1 / u)
        ph, pa = df.get("pl_home_price"), df.get("pl_away_price")
        if ph is not None and pa is not None:
            df["market_pl_home_p"] = devig(1 / ph, 1 / pa)

        for label, col in [("prix totaux (clôture)", "market_over_p_close"),
                           ("prix puck line",        "market_pl_home_p")]:
            if col in df:
                print(f"   {label} — couverture : {df[col].notna().mean():.1%}")
    else:
        print("💰 Pas de odds.csv — dataset sans cotes.")

    # ── Diffs clés ───────────────────────────────────────────────────────────
    pairs = [("xgf60_s", "xga60_s"), ("ev_xgf_pct_s", None), ("goalie_gsax60", None),
             ("star_power", None)]
    if "home_xgf60_s" in df and "away_xga60_s" in df:
        df["xg_matchup_home"] = df["home_xgf60_s"] - df["away_xga60_s"]  # attaque H vs défense A
        df["xg_matchup_away"] = df["away_xgf60_s"] - df["home_xga60_s"]
        df["xg_matchup_diff"] = df["xg_matchup_home"] - df["xg_matchup_away"]
    for c in ("ev_xgf_pct_s", "ev_cf_pct_s", "ev_xgf_pct_l", "ev_cf_pct_l",
              "goalie_gsax60", "goalie_svpct",
              "star_power", "finishing_s", "win_s", "rest_days",
              # ── voyage / calendrier ──
              "distance_km", "tz_shift", "days_away", "alt_gain",
              "road_trip_len", "road_game_num"):
        h, a = f"home_{c}", f"away_{c}"
        if h in df.columns and a in df.columns:
            df[f"{c}_diff"] = df[h] - df[a]
    if "home_stars_missing" in df.columns:
        df["stars_missing_diff"] = df["home_stars_missing"].fillna(0) - df["away_stars_missing"].fillna(0)
    if "home_stars_out_weight" in df.columns:
        df["stars_out_weight_diff"] = df["home_stars_out_weight"].fillna(0) - df["away_stars_out_weight"].fillna(0)
    # Calendrier : dos-à-dos et 3-en-4 en écart signé (symétrie home/away)
    for c in ("b2b", "3in4"):
        h, a = f"home_{c}", f"away_{c}"
        if h in df.columns and a in df.columns:
            df[f"{c}_diff"] = df[h].fillna(0).astype(float) - df[a].fillna(0).astype(float)

    # Filtre début de saison : minimum de matchs joués
    before = len(df)
    df = df[(df["home_team_gp"] >= MIN_GP) & (df["away_team_gp"] >= MIN_GP)]
    print(f"🧹 {before - len(df)} matchs filtrés (< {MIN_GP} GP), {len(df)} restants")

    os.makedirs(MODELS_DIR, exist_ok=True)
    df.to_csv(f"{DATA_DIR}/nhl_games_v4.csv", index=False)
    print(f"✅ Dataset v4 : {len(df)} matchs × {len(df.columns)} colonnes → nhl_games_v4.csv")

    # ── États d'inférence ────────────────────────────────────────────────────
    with open(f"{MODELS_DIR}/inference_state.json", "w") as f:
        json.dump({
            "as_of": str(df["date"].max()),
            "teams": team_state,
            "goalies": goalie_state,
            "lineups": lineup_state,
            "skater_pool": skater_pool,
            "stars": star_state,
        }, f, indent=1)
    with open(f"{MODELS_DIR}/elo_ratings.json", "w") as f:
        json.dump({"base": ELO_BASE, "home_adv": ELO_HOME_ADV,
                   "as_of_date": str(df["date"].max()),
                   "ratings": {k: round(v, 1) for k, v in sorted(final_elo.items())}},
                  f, indent=2)
    print("✅ inference_state.json + elo_ratings.json → ml/models/")
    print("\n🚀 Prochaine étape : python train.py")


if __name__ == "__main__":
    main()
