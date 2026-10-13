"""
referee_effects.py
==================
Effets ARBITRE pré-match (2026-10-12, STATUS.md §3.5 P5), partagés par
`train_player.py` (entraînement + table d'inférence) et `refresh_data.py`
(table rafraîchie chaque lundi). Mesure et règle : `measure_ref_props.py`.

Pour chaque arbitre, écart moyen de ses matchs au niveau de la ligue, rétréci :
    effet = Σ (valeur du match − moyenne des LEAGUE_WINDOW matchs précédents)
            / (n_matchs + REF_SHRINK)
sur deux grandeurs : `pen` (pénalités des deux équipes) et `pp` (minutes à
5 c. 4 des deux équipes). Les variables d'un match sont la SOMME des effets de
ses deux arbitres :
    ref_pen, ref_pp

  * entraînement (`pregame_features`) : effets calculés sur les matchs
    PRÉCÉDENTS de chaque arbitre seulement — aucune fuite ;
  * inférence (`write_table` → ../models/ref_effects.json) : effets sur TOUS
    les matchs connus, l'état « avant le prochain match » ;
  * arbitre inconnu ou non annoncé → 0, la valeur neutre (c'est aussi ce que
    l'entraînement voit pour un arbitre sans historique).

Noms normalisés comme `normalizeRefName` (server/src/services/refereeStore.ts) :
sans accents, minuscules, lettres et espaces seulement — les noms de Scouting
the Refs (côté Node) et de l'API NHL (ici) se rejoignent ainsi.

Dépendances : pandas, numpy. ml_service.py ne l'importe PAS (l'image Docker
n'embarque que ml_service.py, score_model.py…) : il lit ref_effects.json.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import numpy as np
import pandas as pd

REF_FEATS = ["ref_pen", "ref_pp"]
REF_SHRINK = 40
LEAGUE_WINDOW = 1000
TABLE_NAME = "ref_effects.json"


def norm_ref_name(name) -> str:
    s = unicodedata.normalize("NFD", str(name or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def load_ref_games(data_dir: str) -> pd.DataFrame | None:
    """Un match par ligne : game_id, date, ref1, ref2 (normalisés), pen, pp.
    None si `officials.csv` ou `mp_team_games.csv` manque."""
    off_path = os.path.join(data_dir, "officials.csv")
    tg_path = os.path.join(data_dir, "mp_team_games.csv")
    if not (os.path.exists(off_path) and os.path.exists(tg_path)):
        return None
    off = pd.read_csv(off_path)
    t = pd.read_csv(tg_path, usecols=["gameId", "situation", "iceTime", "penaltiesFor"])
    pen = t[t.situation == "all"].groupby("gameId")["penaltiesFor"].sum().rename("pen")
    pp = (t[t.situation == "5on4"].groupby("gameId")["iceTime"].sum() / 60).rename("pp")
    g = off.merge(pen, left_on="game_id", right_index=True) \
           .merge(pp, left_on="game_id", right_index=True)
    g["ref1"] = g["ref1"].map(norm_ref_name)
    g["ref2"] = g["ref2"].map(norm_ref_name)
    g = g[(g.ref1 != "") & (g.ref2 != "")]
    return g.sort_values(["date", "game_id"]).reset_index(drop=True)


def _long(g: pd.DataFrame, col: str) -> pd.DataFrame:
    base = g[col].shift(1).rolling(LEAGUE_WINDOW, min_periods=200).mean()
    dev = g[col] - base
    return pd.concat([
        pd.DataFrame({"game_id": g.game_id, "date": g.date, "ref": g.ref1, "dev": dev}),
        pd.DataFrame({"game_id": g.game_id, "date": g.date, "ref": g.ref2, "dev": dev}),
    ]).sort_values(["ref", "date", "game_id"])


def pregame_features(g: pd.DataFrame) -> pd.DataFrame:
    """game_id → ref_pen, ref_pp, à partir des matchs PRÉCÉDENTS de chaque arbitre."""
    out = g[["game_id"]].copy()
    for col, name in (("pen", "ref_pen"), ("pp", "ref_pp")):
        long = _long(g, col)
        grp = long.groupby("ref")["dev"]
        cum = grp.transform(lambda s: s.fillna(0).cumsum().shift(1).fillna(0))
        n = grp.transform(lambda s: s.notna().astype(int).cumsum().shift(1).fillna(0))
        long = long.assign(eff=cum / (n + REF_SHRINK))
        out[name] = out["game_id"].map(long.groupby("game_id")["eff"].sum())
    return out


def effects_table(g: pd.DataFrame) -> dict:
    """{ arbitre normalisé: {"pen": effet, "pp": effet, "n": matchs} } sur TOUS les matchs."""
    table: dict[str, dict] = {}
    for col in ("pen", "pp"):
        long = _long(g, col).dropna(subset=["dev"])
        agg = long.groupby("ref")["dev"].agg(["sum", "count"])
        for ref, r in agg.iterrows():
            d = table.setdefault(ref, {"n": int(r["count"])})
            d[col] = round(float(r["sum"] / (r["count"] + REF_SHRINK)), 5)
    return table


def write_table(data_dir: str, models_dir: str) -> dict | None:
    g = load_ref_games(data_dir)
    if g is None or g.empty:
        print("   ⚠️ effets arbitre : officials.csv ou mp_team_games.csv absent — "
              "lancer fetch_officials_lines.py --officials")
        return None
    out = {"as_of": str(g.date.max()), "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "features": REF_FEATS, "shrink": REF_SHRINK, "league_window": LEAGUE_WINDOW,
           "games": int(len(g)), "refs": effects_table(g)}
    with open(os.path.join(models_dir, TABLE_NAME), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print(f"   🦓 effets arbitre : {len(out['refs'])} arbitres, {out['games']} matchs "
          f"(au {out['as_of']}) → {TABLE_NAME}")
    return out


def features_for(refs, table: dict | None) -> dict[str, float]:
    """ref_pen / ref_pp d'un match à venir à partir des noms de ses arbitres."""
    t = (table or {}).get("refs") or {}
    vals = {"ref_pen": 0.0, "ref_pp": 0.0}
    for r in refs or []:
        e = t.get(norm_ref_name(r))
        if e:
            vals["ref_pen"] += float(e.get("pen", 0.0))
            vals["ref_pp"] += float(e.get("pp", 0.0))
    return vals
