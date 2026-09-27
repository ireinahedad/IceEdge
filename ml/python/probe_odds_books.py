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


# Marchés de MATCH hors des trois de base, servis seulement par l'endpoint
# par événement (/events/{id}/odds). Coût : 1 crédit par marché RENVOYÉ et par
# région (10 livres = 1 région) — un marché que le livre ne cote pas ne coûte rien.
EXTRA_MARKETS = ",".join([
    "h2h_3_way", "alternate_spreads", "alternate_totals", "team_totals",
    "alternate_team_totals", "btts", "draw_no_bet",
    "h2h_p1", "h2h_p2", "h2h_p3", "h2h_3_way_p1", "h2h_3_way_p2", "h2h_3_way_p3",
    "spreads_p1", "spreads_p2", "spreads_p3", "totals_p1", "totals_p2", "totals_p3",
    "team_totals_p1", "team_totals_p2", "team_totals_p3",
])


def probe_event(key: str, books: str, markets: str) -> None:
    """Un match à venir : quels marchés supplémentaires chaque livre cote-t-il ?"""
    events = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/events", {}, key)   # gratuit
    if not events:
        print("Aucun match à venir.")
        return
    ev = events[0]
    print(f"\nMatch sondé : {ev.get('away_team')} @ {ev.get('home_team')} "
          f"({ev.get('commence_time')})")
    data = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/events/{ev['id']}/odds",
                        {"bookmakers": books, "markets": markets,
                         "oddsFormat": "decimal"}, key)
    if not isinstance(data, dict):
        print("Réponse vide (marché inconnu ? voir le message d'erreur plus haut).")
        return
    for bk in data.get("bookmakers") or []:
        print(f"\n   {bk['key']}")
        for m in bk.get("markets") or []:
            outs = m.get("outcomes") or []
            sample = ", ".join(
                f"{o.get('name')}{'' if o.get('point') is None else ' ' + str(o.get('point'))}"
                f"{'' if not o.get('description') else ' [' + o['description'] + ']'}"
                f"={o.get('price')}" for o in outs[:4])
            print(f"      {m['key']:<24} {len(outs):>3} issues   {sample}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--regions", default="ca")
    p.add_argument("--dates", default=DEFAULT_DATES)
    p.add_argument("--no-live", action="store_true")
    p.add_argument("--event", action="store_true",
                   help="Sonde les marchés supplémentaires d'UN match à venir "
                        "(coût : 1 crédit par marché renvoyé)")
    p.add_argument("--books", default="betano_ca_on,playnow_ca,bet99_ca_on")
    p.add_argument("--markets", default=EXTRA_MARKETS)
    a = p.parse_args()

    key = _oddsapi_key()
    if not key:
        return
    try:
        if a.event:
            probe_event(key, a.books, a.markets)
            print(f"\nCredits restants : {getattr(_oddsapi_get, 'remaining', '?')}")
            return
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
