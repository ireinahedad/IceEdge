"""
arena_effects.py — biais de COMPTAGE des arénas (mises en échec, tirs bloqués,
tirs cadrés), pour le modèle joueur.

Ces stats sont comptées à la main par l'équipe à domicile, et chaque aréna
compte à sa façon. Mesuré 2015-2026 (mp_team_games.csv) : un même match compte
de 0,68 à 1,38 fois la moyenne de ligue en mises en échec selon l'aréna
(écart-type 17 %), 0,76 à 1,21 en tirs bloqués (10 %), ±5 % en tirs cadrés —
et ce biais tient d'une saison à l'autre (corrélation 0,71 / 0,72 / 0,50).

Estimateur classique du biais de comptage : pour une équipe T, le total compté
(deux équipes) dans ses matchs À DOMICILE, rapporté au total compté dans ses
matchs À L'EXTÉRIEUR. Les deux échantillons ont la même équipe T sur la glace ;
seul le comptable change. Le style de T (une équipe qui frappe beaucoup)
s'annule dans le rapport.

    facteur(T, date) = 1 + w · (moy_dom / moy_ext − 1),   w = n / (n + PSEUDO)

sur les WINDOW derniers matchs à domicile et à l'extérieur de T AVANT la date
(n = le plus petit des deux comptes). 1 = aréna neutre ou inconnue.

Sorties :
  pregame_features(...)  game_id → arena_hits, arena_blocks, arena_sog (entraînement)
  write_table(...)       arena_effects.json : facteur courant de chaque aréna (service)
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

WINDOW = 120          # ≈ 1,5 saison de matchs à domicile (et autant à l'extérieur)
PSEUDO = 20.0         # matchs fictifs « aréna neutre »
ARENA_FEATS = ["arena_hits", "arena_blocks", "arena_sog"]
_STATS = {"arena_hits": ("hitsFor", "hitsAgainst"),
          "arena_blocks": ("blockedShotAttemptsFor", "blockedShotAttemptsAgainst"),
          "arena_sog": ("shotsOnGoalFor", "shotsOnGoalAgainst")}
FRANCHISE = {"ATL": "WPG", "PHX": "UTA", "ARI": "UTA", "L.A": "LAK", "S.J": "SJS", "N.J": "NJD", "T.B": "TBL"}


def load_games(data_dir: str) -> pd.DataFrame | None:
    """Un match de saison régulière par ligne : game_id, date, home, away, totaux comptés."""
    path = os.path.join(data_dir, "mp_team_games.csv")
    if not os.path.exists(path):
        return None
    cols = ["gameId", "gameDate", "playerTeam", "opposingTeam", "home_or_away", "situation", "playoffGame"]
    cols += sorted({c for pair in _STATS.values() for c in pair})
    t = pd.read_csv(path, usecols=cols, low_memory=False)
    t = t[(t.situation == "all") & (t.home_or_away == "HOME") & (t.playoffGame == 0)].copy()
    g = pd.DataFrame({"game_id": t.gameId.values,
                      "date": pd.to_datetime(t.gameDate.astype(str), format="%Y%m%d").values,
                      "home": t.playerTeam.replace(FRANCHISE).values,
                      "away": t.opposingTeam.replace(FRANCHISE).values})
    for name, (a, b) in _STATS.items():
        g[name] = (t[a] + t[b]).values.astype(float)
    return g.drop_duplicates("game_id").sort_values(["date", "game_id"]).reset_index(drop=True)


def _rolling(g: pd.DataFrame, team: str, side: str) -> pd.DataFrame:
    """Sommes glissantes des WINDOW derniers matchs de `team` côté `side`, AVANT chaque date."""
    s = g[g[side] == team].sort_values("date")
    out = pd.DataFrame({"date": s.date.values})
    out["n"] = np.minimum(np.arange(len(s)), WINDOW).astype(float)       # matchs strictement avant
    for name in _STATS:
        cs = s[name].cumsum().shift(1).fillna(0.0).values
        lag = s[name].cumsum().shift(1 + WINDOW).fillna(0.0).values
        out[name] = cs - lag
    # Plusieurs matchs le même jour n'existent pas pour une équipe ; on garde le dernier état.
    return out


def pregame_features(g: pd.DataFrame) -> pd.DataFrame:
    """game_id → facteur d'aréna de chaque stat, à partir des matchs PRÉCÉDENTS seulement."""
    res = []
    for team in sorted(set(g.home) | set(g.away)):
        H = _rolling(g, team, "home")
        R = _rolling(g, team, "away")
        hg = g[g.home == team][["game_id", "date"]].sort_values("date").reset_index(drop=True)
        hg = pd.concat([hg, H.drop(columns="date").add_prefix("h_")], axis=1)
        # État des matchs à l'extérieur au moment du match à domicile (strictement avant).
        R2 = R.copy()
        R2["n_r"] = R2.pop("n")
        hg = pd.merge_asof(hg.sort_values("date"), R2.rename(columns={k: f"r_{k}" for k in _STATS}),
                           on="date", direction="backward", allow_exact_matches=False)
        n = np.minimum(hg.h_n.values, hg.n_r.fillna(0).values)
        w = n / (n + PSEUDO)
        row = {"game_id": hg.game_id.values}
        for k in _STATS:
            mh = hg[f"h_{k}"].values / np.maximum(hg.h_n.values, 1)
            mr = hg[f"r_{k}"].fillna(0).values / np.maximum(hg.n_r.fillna(0).values, 1)
            ratio = np.where((mh > 0) & (mr > 0), mh / np.where(mr > 0, mr, 1), 1.0)
            row[k] = np.where(n > 0, 1.0 + w * (ratio - 1.0), 1.0)
        res.append(pd.DataFrame(row))
    return pd.concat(res, ignore_index=True)


def current_table(g: pd.DataFrame) -> dict:
    """Facteur courant de chaque aréna (tous ses matchs connus), pour le service."""
    out = {}
    for team in sorted(set(g.home)):
        h = g[g.home == team].tail(WINDOW)
        r = g[g.away == team].tail(WINDOW)
        n = min(len(h), len(r))
        if n == 0:
            continue
        w = n / (n + PSEUDO)
        out[team] = {k: round(float(1.0 + w * (h[k].mean() / r[k].mean() - 1.0)), 5)
                     if r[k].mean() > 0 else 1.0 for k in _STATS}
        out[team]["n"] = int(n)
    return out


def write_table(data_dir: str, models_dir: str) -> dict | None:
    g = load_games(data_dir)
    if g is None or g.empty:
        print("   ⚠️ effets d'aréna : mp_team_games.csv absent")
        return None
    out = {"as_of": str(g.date.max().date()), "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "features": ARENA_FEATS, "window": WINDOW, "pseudo": PSEUDO, "arenas": current_table(g)}
    with open(os.path.join(models_dir, "arena_effects.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"   🏟️  effets d'aréna : {len(out['arenas'])} arénas (au {out['as_of']}) → arena_effects.json")
    return out
