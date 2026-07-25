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
GOALIE_HL         = 8             # demi-vie EWMA gardien (départs)
MIN_GP            = 5             # matchs minimum avant d'émettre une ligne

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

def build_team_features() -> tuple[pd.DataFrame, dict]:
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
        for c in raw_cols:
            shifted = g[c].shift(1)
            block[f"{c}_s"] = shifted.ewm(halflife=SHORT_HL, min_periods=3).mean()
            block[f"{c}_l"] = shifted.ewm(halflife=LONG_HL, min_periods=3).mean()
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
    hours = starters["icetime"].replace(0, np.nan) / 3600.0
    starters["g_gsax60_raw"] = (starters["xGoals"] - starters["goals"]) / hours
    starters["g_svpct_raw"]  = 1.0 - starters["goals"] / starters["ongoal"].replace(0, np.nan)

    grp = starters.groupby("playerId", sort=False)
    starters["goalie_gsax60"] = grp["g_gsax60_raw"].transform(
        lambda s: s.shift(1).ewm(halflife=GOALIE_HL, min_periods=3).mean())
    starters["goalie_svpct"] = grp["g_svpct_raw"].transform(
        lambda s: s.shift(1).ewm(halflife=GOALIE_HL, min_periods=3).mean())
    starters["goalie_starts"] = grp.cumcount()

    out = starters[["team", "gameId", "date", "name",
                    "goalie_gsax60", "goalie_svpct", "goalie_starts"]].copy()

    # État d'inférence : pour chaque équipe, les 2 gardiens les plus utilisés récemment
    state: dict = {}
    for team, g in starters.groupby("team"):
        recent = g.sort_values("date").tail(15)
        usage = recent["name"].value_counts(normalize=True)
        goalies = []
        for gname, share in usage.head(2).items():
            last = g[g["name"] == gname].sort_values("date").iloc[-1]
            gsax = last["g_gsax60_raw"]  # inclure le dernier match dans l'EWMA d'inférence
            hist = g[g["name"] == gname].sort_values("date")
            goalies.append({
                "name": gname, "recent_start_share": round(float(share), 3),
                "gsax60": round(float(hist["g_gsax60_raw"].ewm(halflife=GOALIE_HL).mean().iloc[-1]), 4),
                "svpct":  round(float(hist["g_svpct_raw"].ewm(halflife=GOALIE_HL).mean().iloc[-1]), 4),
            })
        state[team] = goalies
    print(f"   ✅ {len(out)} départs de gardien qualifiés")
    return out, state


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
            "top5": [{"name": v[1], "ppg": round(v[0], 3)} for _, v in top5],
            "star_power_full": round(sum(v[0] for _, v in top5[:3]), 4),
            # Pool clé + poids pré-calculé (utilisé tel quel par ml_service.py) :
            # noms = orthographe MoneyPuck (matching des scratches par nom exact).
            "keys": [{"name": name, "ppg": round(ppg, 3), "pos": grp,
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
    star_feats, star_state   = build_star_features()

    df = spine.copy()
    df["home_win"]    = (df["home_score"] > df["away_score"]).astype(int)
    df["total_goals"] = df["home_score"] + df["away_score"]

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
    else:
        print("💰 Pas de odds.csv — dataset sans cotes.")

    # ── Diffs clés ───────────────────────────────────────────────────────────
    pairs = [("xgf60_s", "xga60_s"), ("ev_xgf_pct_s", None), ("goalie_gsax60", None),
             ("star_power", None)]
    if "home_xgf60_s" in df and "away_xga60_s" in df:
        df["xg_matchup_home"] = df["home_xgf60_s"] - df["away_xga60_s"]  # attaque H vs défense A
        df["xg_matchup_away"] = df["away_xgf60_s"] - df["home_xga60_s"]
    for c in ("ev_xgf_pct_s", "ev_cf_pct_s", "goalie_gsax60", "goalie_svpct",
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
