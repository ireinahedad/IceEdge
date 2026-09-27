"""probe_odds_books.py - quels livres d'une region cotent vraiment la NHL ?

Sondage ponctuel, avant de figer le livre de reference du backfill et de la
collecte. The Odds API ne publie pas Bet365 pour la NHL (bet365_au ne couvre
que l'AFL et la NRL) : il faut choisir un livre qui a des prix, AUJOURD'HUI
et sur 2023-2026, sinon le backfill paie des snapshots vides.

Cout, en credits (verifie dans l'en-tete x-requests-remaining affiche) :
  - 1 appel live, h2h+spreads, une region   ->  2
  - 3 appels historiques, h2h+spreads       -> 3 x 20 = 60
  Total ~61 credits.

Usage (cmd.exe) :
    set ODDS_API_KEY=ta-cle
    cd ml\\python && python probe_odds_books.py            (region ca)
    python probe_odds_books.py --regions ca --dates 2023-11-15,2024-11-15

Aucun fichier n'est ecrit. Sortie en ASCII seulement : la console Windows est
en cp1252 et un emoji y fait planter print().
"""
import argparse
from collections import defaultdict

from fetch_data_v4 import (ODDS_API_SPORT, _oddsapi_get, _oddsapi_key,
                           _OddsApiStop)

# Mercredi 2023-11-15, vendredi 2024-11-15, samedi 2025-11-15 : trois soirees
# de pleine saison. 22:00Z = 17 h a l'Est, avant tous les matchs du soir.
DEFAULT_DATES = "2023-11-15,2024-11-15,2025-11-15"


def tally(events: list, label: str) -> None:
    ml = defaultdict(int)
    pl = defaultdict(int)
    for ev in events or []:
        for bk in ev.get("bookmakers") or []:
            mk = {m.get("key"): m for m in bk.get("markets") or []}
            if "h2h" in mk:
                ml[bk["key"]] += 1
            sp = mk.get("spreads", {}).get("outcomes") or []
            if any(abs(abs(float(o.get("point") or 0)) - 1.5) < 1e-9 for o in sp):
                pl[bk["key"]] += 1
    n = len(events or [])
    print(f"\n{label} : {n} matchs")
    if not n:
        return
    for book in sorted(set(ml) | set(pl), key=lambda b: -ml.get(b, 0)):
        print(f"   {book:<26} moneyline {ml.get(book, 0):>3}/{n}"
              f"   puck line +-1.5 {pl.get(book, 0):>3}/{n}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--regions", default="ca")
    p.add_argument("--dates", default=DEFAULT_DATES)
    p.add_argument("--no-live", action="store_true")
    a = p.parse_args()

    key = _oddsapi_key()
    if not key:
        return
    try:
        if not a.no_live:
            live = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/odds",
                                {"regions": a.regions, "markets": "h2h,spreads",
                                 "oddsFormat": "decimal"}, key)
            tally(live if isinstance(live, list) else [], f"LIVE ({a.regions})")
        for d in [x.strip() for x in a.dates.split(",") if x.strip()]:
            snap = _oddsapi_get(f"/historical/sports/{ODDS_API_SPORT}/odds",
                                {"regions": a.regions, "markets": "h2h,spreads",
                                 "oddsFormat": "decimal",
                                 "date": f"{d}T22:00:00Z"}, key)
            data = snap.get("data") if isinstance(snap, dict) else None
            tally(data or [], f"HISTORIQUE {d} ({a.regions})")
    except _OddsApiStop as e:
        print(f"\narret : {e}")
    rem = getattr(_oddsapi_get, "remaining", "?")
    print(f"\nCredits restants : {rem}")


if __name__ == "__main__":
    main()
