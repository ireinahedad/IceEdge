"""
fetch_live_pbp.py
=================
Situations de jeu HORODATÉES (avantage numérique, 4 c. 4…) et pénalités de chaque
match, pour mesurer l'effet de l'avantage numérique EN COURS sur les prédictions en
direct (`STATUS.md` §3.5, « Live predictions », point 1).

Les fichiers de tirs MoneyPuck (`fetch_live_goals.py`) ne donnent que les tirs : le
TEMPS passé à 5 c. 4 n'y est pas, donc l'exposition non plus. Le play-by-play NHL
(`v1/gamecenter/{id}/play-by-play`, gratuit) porte sur chaque événement le
`situationCode` (gardien visiteur, patineurs visiteur, patineurs domicile, gardien
domicile : « 1451 » = domicile à 5 c. 4), d'où une fonction en escalier de la
situation, et les pénalités (heure, équipe, durée).

Temps réglementaire seulement. Seuls les matchs de `live_games.csv` (contrôlés contre
le score officiel) sont tirés. Contrôle : les buts réglementaires du play-by-play
doivent recoller au score réglementaire de `live_games.csv`, sinon le match est écarté
et compté.

Reprenable : un match par ligne dans `ml/data/raw/pbp/{saison}.jsonl` (ignoré par
git) ; un match déjà présent n'est pas retiré. Chaque appel est borné par
`--max-seconds` (le shell du poste coupe les longues commandes) : relancer jusqu'à
« 0 à tirer ».

Sorties :
    ml/data/live_states.csv     game_id, t, code    (changements de situation, t en s écoulées)
    ml/data/live_penalties.csv  game_id, t, team, duration, kind
    ml/data/live_pbp_goals.csv  game_id, t, home_scored, code

Usage :
    cd ml/python
    python fetch_live_pbp.py --first 2018 --last 2025 --max-seconds 160   # à répéter
    python fetch_live_pbp.py --build                                       # écrit les CSV
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
RAW = os.path.join(DATA, "raw", "pbp")
URL = "https://api-web.nhle.com/v1/gamecenter/{gid}/play-by-play"


def clock(s: str) -> int:
    m, sec = str(s).split(":")
    return int(m) * 60 + int(sec)


def fetch(gid: int) -> dict | None:
    for attempt in range(3):
        try:
            req = urllib.request.Request(URL.format(gid=gid), headers={"User-Agent": "arakice-ml/1.0"})
            with urllib.request.urlopen(req, timeout=12) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except Exception:
            pass
        time.sleep(1.0 * (attempt + 1))
    return None


def compact(gid: int, d: dict) -> dict:
    """Ce qu'on garde d'un play-by-play : changements de situation, pénalités, buts (≤ 3e)."""
    home_id = d["homeTeam"]["id"]
    states, pens, goals = [], [], []
    last = None
    for p in d.get("plays", []):
        per = p.get("periodDescriptor", {})
        if per.get("periodType") != "REG" or int(per.get("number", 9)) > 3:
            continue
        t = (int(per["number"]) - 1) * 1200 + clock(p.get("timeInPeriod", "00:00"))
        code = p.get("situationCode")
        kind = p.get("typeDescKey")
        if code and code != last:
            states.append([t, code]); last = code
        det = p.get("details") or {}
        if kind == "penalty":
            pens.append([t, int(det.get("eventOwnerTeamId") == home_id), int(det.get("duration") or 0),
                         str(det.get("typeCode") or "")])
        elif kind == "goal":
            goals.append([t, int(det.get("eventOwnerTeamId") == home_id), code or ""])
    return {"game_id": gid, "states": states, "penalties": pens, "goals": goals}


def done_ids(season: int) -> set[int]:
    path = os.path.join(RAW, f"{season}.jsonl")
    if not os.path.exists(path):
        return set()
    out = set()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                out.add(int(json.loads(line)["game_id"]))
            except Exception:
                pass
    return out


def build() -> None:
    games = pd.read_csv(os.path.join(DATA, "live_games.csv"))
    reg = games.set_index("game_id")[["home_reg_score", "away_reg_score"]].to_dict("index")
    st, pe, go = [], [], []
    kept = bad = 0
    for f in sorted(os.listdir(RAW)):
        if not f.endswith(".jsonl"):
            continue
        with open(os.path.join(RAW, f), encoding="utf-8") as fh:
            for line in fh:
                try:
                    g = json.loads(line)
                except ValueError:      # ligne tronquée par une coupure : le match sera retiré
                    continue
                gid = g["game_id"]
                r = reg.get(gid)
                h = sum(x[1] for x in g["goals"]); a = len(g["goals"]) - h
                if r is None or not g["states"] or h != r["home_reg_score"] or a != r["away_reg_score"]:
                    bad += 1
                    continue
                kept += 1
                st += [[gid, t, c] for t, c in g["states"]]
                pe += [[gid, t, tm, du, k] for t, tm, du, k in g["penalties"]]
                go += [[gid, t, hs, c] for t, hs, c in g["goals"]]
    pd.DataFrame(st, columns=["game_id", "t", "code"]).to_csv(os.path.join(DATA, "live_states.csv"), index=False)
    pd.DataFrame(pe, columns=["game_id", "t", "home_team", "duration", "kind"]).to_csv(
        os.path.join(DATA, "live_penalties.csv"), index=False)
    pd.DataFrame(go, columns=["game_id", "t", "home_scored", "code"]).to_csv(
        os.path.join(DATA, "live_pbp_goals.csv"), index=False)
    print(f"✅ {kept} matchs gardés, {bad} écartés (buts ≠ score réglementaire ou absents de live_games) "
          f"→ live_states.csv ({len(st)}), live_penalties.csv ({len(pe)}), live_pbp_goals.csv ({len(go)})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, default=2018)
    ap.add_argument("--last", type=int, default=2025)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-seconds", type=float, default=1e9)
    ap.add_argument("--build", action="store_true")
    a = ap.parse_args()
    if a.build:
        build(); return

    t0 = time.time()
    os.makedirs(RAW, exist_ok=True)
    games = pd.read_csv(os.path.join(DATA, "live_games.csv"))
    todo = []
    for season in range(a.first, a.last + 1):
        have = done_ids(season)
        todo += [(season, int(g)) for g in games.loc[games["season"] == season, "game_id"] if int(g) not in have]
    print(f"   {len(todo)} matchs à tirer")
    n = miss = 0
    handles = {}
    try:
        with ThreadPoolExecutor(a.workers) as ex:
            it = iter(todo)
            running = {}
            def submit():
                if time.time() - t0 > a.max_seconds:
                    return False
                nxt = next(it, None)
                if nxt is None:
                    return False
                running[ex.submit(fetch, nxt[1])] = nxt
                return True
            for _ in range(a.workers * 2):
                if not submit():
                    break
            while running:
                fut = next(as_completed(list(running)))
                season, gid = running.pop(fut)
                d = fut.result()
                if d is None:
                    miss += 1
                else:
                    fh = handles.get(season) or open(os.path.join(RAW, f"{season}.jsonl"), "a", encoding="utf-8")
                    handles[season] = fh
                    fh.write(json.dumps(compact(gid, d), separators=(",", ":")) + "\n")
                    fh.flush()
                    n += 1
                submit()
    finally:
        for fh in handles.values():
            fh.close()
    left = len(todo) - n - miss
    print(f"   {n} tirés, {miss} introuvables, {left} restants ({time.time() - t0:.0f} s)"
          + ("" if left else " — relancer avec --build"))


if __name__ == "__main__":
    main()
