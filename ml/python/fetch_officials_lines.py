"""
fetch_officials_lines.py
========================
P5 (STATUS.md §3.5 P, 2026-10-12) — deux sources GRATUITES qui ouvrent des
familles de patterns aujourd'hui intestables :

  --officials   arbitres et juges de lignes de chaque match de saison régulière
                (API NHL `gamecenter/{id}/right-rail` → `gameInfo`), depuis
                2008-09. Une requête par match, reprise automatique : seuls les
                matchs absents de `officials.csv` sont demandés.
                → ml/data/officials.csv
                  game_id, season, date, ref1, ref2, lines1, lines2

  --lines       trios d'attaquants et paires de défenseurs à 5 contre 5, par
                saison (MoneyPuck `seasonSummary/{saison}/regular/lines.csv`),
                et le résumé saison des patineurs (`skaters.csv`, pour les
                statistiques « sur la glace » de chaque joueur).
                → ml/data/raw/lines/lines_{saison}.csv, skaters_{saison}.csv
                  (les saisons terminées ne sont plus retéléchargées ; la saison
                  en cours l'est à chaque appel)

Lecture seule pour le service : rien ici n'est lu par ml_service.py.
Les mesures sont dans `measure_lines_refs.py`.

Usage :
    cd ml/python
    python fetch_officials_lines.py --officials     # ~30-60 min la 1re fois (~21 700 matchs)
    python fetch_officials_lines.py --lines         # ~2 min
    python fetch_officials_lines.py                 # les deux
    python fetch_officials_lines.py --officials --workers 4
"""

from __future__ import annotations

import argparse
import csv
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pandas as pd
import requests

DATA_DIR = "../data"
OFFICIALS_CSV = f"{DATA_DIR}/officials.csv"
LINES_DIR = f"{DATA_DIR}/raw/lines"
RIGHT_RAIL = "https://api-web.nhle.com/v1/gamecenter/{gid}/right-rail"
MP_SEASON = "https://moneypuck.com/moneypuck/playerData/seasonSummary/{season}/regular/{kind}.csv"
FIRST_SEASON = 2008
OFF_COLS = ["game_id", "season", "date", "ref1", "ref2", "lines1", "lines2"]

_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = "ICEEDGE-ml/1.0 (research; contact support.arakice@gmail.com)"
        _local.s = s
    return s


def _get(url: str, retries: int = 4, timeout: int = 30):
    for attempt in range(retries):
        try:
            r = _session().get(url, timeout=timeout)
            if r.status_code == 404:
                return None
            if r.status_code == 429:                       # trop vite : on recule
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            return r
        except Exception:
            if attempt == retries - 1:
                return None
            time.sleep(2 ** attempt)
    return None


def current_season() -> int:
    t = date.today()
    return t.year if t.month >= 8 else t.year - 1


# ── Arbitres ─────────────────────────────────────────────────────────────────

def _officials_row(gid: int, season: int, day: str) -> dict | None:
    r = _get(RIGHT_RAIL.format(gid=gid))
    if r is None:
        return None
    try:
        info = r.json().get("gameInfo") or {}
    except ValueError:
        return None
    name = lambda o: ((o or {}).get("fullName") or {}).get("default", "").strip()
    refs = [name(o) for o in info.get("referees") or []]
    lines = [name(o) for o in info.get("linesmen") or []]
    if not any(refs):
        return None                                       # pas encore publié : on réessaiera
    # Ordre alphabétique : « A et B » et « B et A » sont le même duo.
    pad2 = lambda xs: (sorted(x for x in xs if x) + ["", ""])[:2]
    refs, lines = pad2(refs), pad2(lines)
    return {"game_id": gid, "season": season, "date": day,
            "ref1": refs[0], "ref2": refs[1], "lines1": lines[0], "lines2": lines[1]}


def fetch_officials(workers: int = 6, max_seconds: float | None = None) -> None:
    spine = pd.read_csv(f"{DATA_DIR}/games_spine.csv")
    spine = spine[(spine["season"] >= FIRST_SEASON) & spine["home_score"].notna()]
    done = set()
    if os.path.exists(OFFICIALS_CSV):
        done = set(pd.read_csv(OFFICIALS_CSV, usecols=["game_id"])["game_id"].astype(int))
    todo = spine[~spine["game_id"].isin(done)]
    print(f"🦓 Arbitres : {len(done)} matchs déjà connus, {len(todo)} à demander "
          f"({workers} requêtes en parallèle)", flush=True)
    if todo.empty:
        return
    new_file = not os.path.exists(OFFICIALS_CSV)
    n_ok = n_miss = 0
    t0 = time.time()
    batch = workers * 40
    items = [(int(r.game_id), int(r.season), str(r.date)) for r in todo.itertuples()]
    with open(OFFICIALS_CSV, "a", newline="", encoding="utf-8") as fh, \
            ThreadPoolExecutor(max_workers=workers) as ex:
        w = csv.DictWriter(fh, fieldnames=OFF_COLS)
        if new_file:
            w.writeheader()
        # Par lots, écrits et vidés sur disque à chaque fois : un arrêt (Ctrl+C,
        # --max-seconds) ne perd au plus qu'un lot, et la relance reprend où on en était.
        for start in range(0, len(items), batch):
            if max_seconds and time.time() - t0 > max_seconds:
                print(f"   ⏸️  arrêt après {max_seconds:.0f} s — relancer la même commande pour continuer")
                break
            for row in ex.map(lambda it: _officials_row(*it), items[start:start + batch]):
                if row:
                    w.writerow(row)
                    n_ok += 1
                else:
                    n_miss += 1
            fh.flush()
            i = min(start + batch, len(items))
            rate = i / max(time.time() - t0, 1e-9)
            print(f"   {i}/{len(items)} ({rate:.1f}/s, reste ~{(len(items) - i) / rate / 60:.0f} min)", flush=True)
    print(f"   ✅ {n_ok} matchs écrits, {n_miss} sans arbitres publiés → {os.path.relpath(OFFICIALS_CSV)}")


# ── Trios et paires (MoneyPuck) ──────────────────────────────────────────────

def fetch_lines() -> None:
    os.makedirs(LINES_DIR, exist_ok=True)
    cur = current_season()
    print(f"🏒 Trios / paires et résumés patineurs MoneyPuck {FIRST_SEASON}-{cur} …")
    for season in range(FIRST_SEASON, cur + 1):
        for kind in ("lines", "skaters"):
            path = f"{LINES_DIR}/{kind}_{season}.csv"
            if os.path.exists(path) and season < cur:
                continue
            r = _get(MP_SEASON.format(season=season, kind=kind), timeout=120)
            if r is None:
                print(f"   ⚠️ {kind} {season} indisponible")
                continue
            with open(path, "wb") as fh:
                fh.write(r.content)
            time.sleep(1.0)                                # MoneyPuck refuse les rafales
        print(f"   {season} ✓", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--officials", action="store_true")
    ap.add_argument("--lines", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--max-seconds", type=float, default=None,
                    help="arrête proprement la collecte des arbitres après N secondes (reprise à la relance)")
    a = ap.parse_args()
    both = not (a.officials or a.lines)
    if a.lines or both:
        fetch_lines()
    if a.officials or both:
        fetch_officials(a.workers, a.max_seconds)


if __name__ == "__main__":
    main()
