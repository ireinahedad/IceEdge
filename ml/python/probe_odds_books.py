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
    python probe_odds_books.py --links       (liens directs par livre, 2 credits)

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


# Props joueurs NHL (cles The Odds API). Surtout cotees par les livres US.
PLAYER_PROPS = ",".join([
    "player_points", "player_goals", "player_assists", "player_shots_on_goal",
    "player_power_play_points", "player_blocked_shots", "player_total_saves",
    "player_goal_scorer_anytime", "player_goal_scorer_first",
])

# Gros livres US (menu NHL le plus complet) + Pinnacle (reference sharp)
# + les 3 livres canadiens. 10 livres max = 1 region au sens du cout.
WIDE_BOOKS = ",".join([
    "draftkings", "fanduel", "betmgm", "williamhill_us", "betrivers",
    "fanatics", "pinnacle", "bet99_ca_on", "playnow_ca", "betano_ca_on",
])

from datetime import datetime, timedelta, timezone


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def probe_event(key: str, books: str, markets: str, lead_h: float = 2.0) -> None:
    """Un match qui commence dans au moins lead_h heures : quels marchés
    supplémentaires chaque livre cote-t-il ? (/events renvoie aussi les
    matchs EN COURS : sans ce filtre on sonde du live.)"""
    events = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/events", {}, key)   # gratuit
    now = datetime.now(timezone.utc)
    upcoming = [e for e in events or []
                if e.get("commence_time")
                and _ts(e["commence_time"]) > now + timedelta(hours=lead_h)]
    if not upcoming:
        print(f"Aucun match qui commence dans plus de {lead_h:g} h.")
        return
    ev = min(upcoming, key=lambda e: _ts(e["commence_time"]))
    dh = (_ts(ev["commence_time"]) - now).total_seconds() / 3600
    print(f"\nMatch sonde : {ev.get('away_team')} @ {ev.get('home_team')} "
          f"({ev.get('commence_time')}, dans {dh:.1f} h)")
    data = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/events/{ev['id']}/odds",
                        {"bookmakers": books, "markets": markets,
                         "oddsFormat": "decimal"}, key)
    if not isinstance(data, dict):
        print("Reponse vide (marche inconnu ? voir le message d'erreur plus haut).")
        return
    seen = set()
    matrix = defaultdict(set)          # marche -> livres qui le cotent
    for bk in data.get("bookmakers") or []:
        for m in bk.get("markets") or []:
            matrix[m["key"]].add(bk["key"])
    for bk in data.get("bookmakers") or []:
        seen.add(bk["key"])
        print(f"\n   {bk['key']}")
        for m in bk.get("markets") or []:
            outs = m.get("outcomes") or []
            sample = ", ".join(
                f"{o.get('name')}{'' if o.get('point') is None else ' ' + str(o.get('point'))}"
                f"{'' if not o.get('description') else ' [' + o['description'] + ']'}"
                f"={o.get('price')}" for o in outs[:4])
            print(f"      {m['key']:<24} {len(outs):>3} issues   {sample}")
    # L'API omet un livre qui ne cote aucun des marchés demandés : on le dit.
    for b in [x.strip() for x in books.split(",") if x.strip()]:
        if b not in seen:
            print(f"\n   {b:<26} aucun marche supplementaire sur ce match")
    # Resume pour choisir quoi garder : 1 credit par marche renvoye (par region).
    asked = [x.strip() for x in markets.split(",") if x.strip()]
    nb = len([x for x in books.split(",") if x.strip()])
    regions = (nb + 9) // 10
    print("\nRESUME marche -> nb de livres (livres)")
    for mk in asked:
        bks = sorted(matrix.get(mk, ()))
        print(f"   {mk:<28} {len(bks):>2}   {', '.join(bks) if bks else '-- aucun'}")
    print(f"\nMarches renvoyes : {len(matrix)}/{len(asked)}   "
          f"regions facturees : {regions}   "
          f"cout estime : {len(matrix) * regions} credits")


def probe_links(key: str, books: str) -> None:
    """Quels livres renvoient un LIEN vers le match / le marche / le coupon ?

    `includeLinks=true` + `includeSids=true` sur l'endpoint de la ligue :
    l'API ajoute, quand le livre les fournit, `link` (et `sid`) au niveau du
    livre (page du match), du marche et de l'issue (souvent un coupon deja
    rempli). Cout : h2h + spreads, une region (10 livres max) -> 2 credits.
    Bet365 n'est PAS dans la liste : The Odds API ne le cote pas en NHL, il ne
    renverrait rien (voir l'en-tete de ce fichier).
    """
    data = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/odds",
                        {"bookmakers": books, "markets": "h2h,spreads",
                         "oddsFormat": "decimal",
                         "includeLinks": "true", "includeSids": "true"}, key)
    if data is None:
        print("\nReponse vide : l'API a refuse la requete (HTTP 422 = parametre "
              "includeLinks/includeSids non accepte par ce plan ?).")
        return
    events = data if isinstance(data, list) else []
    now = datetime.now(timezone.utc)
    events = [e for e in events
              if e.get("commence_time") and _ts(e["commence_time"]) > now]
    print(f"\nLIENS : {len(events)} matchs a venir")
    if not events:
        return
    stats = defaultdict(lambda: {"ev": 0, "evlink": 0, "mklink": 0, "outlink": 0, "sid": 0})
    sample = {}
    for ev in events:
        for bk in ev.get("bookmakers") or []:
            st = stats[bk["key"]]
            st["ev"] += 1
            if bk.get("link"):
                st["evlink"] += 1
            if bk.get("sid"):
                st["sid"] += 1
            for m in bk.get("markets") or []:
                if m.get("link"):
                    st["mklink"] += 1
                for o in m.get("outcomes") or []:
                    if o.get("link"):
                        st["outlink"] += 1
                        sample.setdefault(bk["key"], (ev.get("away_team"), ev.get("home_team"),
                                                      m.get("key"), o.get("name"), o.get("link")))
            if bk["key"] not in sample and bk.get("link"):
                sample[bk["key"]] = (ev.get("away_team"), ev.get("home_team"), "match", "-", bk["link"])
    print(f"   {'livre':<18} {'matchs':>6} {'lien match':>10} {'lien marche':>11} {'lien issue':>10} {'sid':>5}")
    for b, st in sorted(stats.items(), key=lambda x: -x[1]["outlink"]):
        print(f"   {b:<18} {st['ev']:>6} {st['evlink']:>10} {st['mklink']:>11} {st['outlink']:>10} {st['sid']:>5}")
    for b in [x.strip() for x in books.split(",") if x.strip()]:
        if b not in stats:
            print(f"   {b:<18} aucun prix sur ces matchs")
    print("\nExemple de lien par livre (a ouvrir dans le navigateur) :")
    for b, (away, home, mk, name, link) in sample.items():
        print(f"   {b}: {away} @ {home} [{mk} / {name}]\n      {link}")

def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--regions", default="ca")
    p.add_argument("--dates", default=DEFAULT_DATES)
    p.add_argument("--no-live", action="store_true")
    p.add_argument("--event", action="store_true",
                   help="Sonde les marchés supplémentaires d'UN match à venir "
                        "(coût : 1 crédit par marché renvoyé)")
    p.add_argument("--books", default="betano_ca_on,playnow_ca,bet99_ca_on")
    p.add_argument("--lead", type=float, default=2.0,
                       help="--event : heures minimum avant la mise au jeu")
    p.add_argument("--links", action="store_true",
                   help="Quels livres renvoient des liens directs (match, marche, "
                        "coupon) ? Livres de --wide, h2h+spreads : 2 credits")
    p.add_argument("--markets", default=EXTRA_MARKETS)
    p.add_argument("--props", action="store_true",
                   help="--event : ajoute les props joueurs NHL a --markets")
    p.add_argument("--wide", action="store_true",
                   help="--event : livres US + Pinnacle + 3 canadiens (remplace --books)")
    a = p.parse_args()
    if a.wide:
        a.books = WIDE_BOOKS
    if a.props:
        a.markets = a.markets + "," + PLAYER_PROPS



    key = _oddsapi_key()
    if not key:
        return
    try:
        if a.links:
            probe_links(key, WIDE_BOOKS)
            print(f"\nCredits restants : {getattr(_oddsapi_get, 'remaining', '?')}")
            return
        if a.event:
            probe_event(key, a.books, a.markets, a.lead)
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
