"""compare_bet365.py - quel livre de The Odds API colle le mieux a Bet365 ?

The Odds API ne publie pas Bet365 pour la NHL. On releve donc a la main les
cotes Bet365 d'un match, et le script les compare, au meme moment, a TOUS les
livres que l'API propose (regions us, us2, uk, eu, au, ca).

Marches : moneyline (h2h, prolongation et tirs au but inclus, comme le
"Money Line" de Bet365) et puck line +-1.5 (spreads).

Cout : 1 credit par marche renvoye et par region. 2 marches x 6 regions
= 12 credits par match compare. La liste des matchs (/events) est gratuite.

Usage (cmd.exe), cotes DECIMALES Bet365 relevees juste avant de lancer :
    set ODDS_API_KEY=ta-cle
    python compare_bet365.py --team Devils --opp Flyers ^
        --b365-ml 1.85 --b365-opp-ml 2.00 --b365-pl 3.10 --b365-opp-pl 1.38

    --b365-pl / --b365-opp-pl : puck line de chaque equipe (-1.5 pour le
    favori, +1.5 pour l'autre). Toutes les cotes Bet365 sont optionnelles :
    sans elles, le script affiche seulement le tableau des livres.

Chaque comparaison est ajoutee a ../data/bet365_compare.csv. Apres plusieurs
matchs, le classement cumule (gratuit, aucun appel) :
    python compare_bet365.py --summary

Sortie ASCII seulement (console Windows en cp1252).
"""
import argparse
import csv
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fetch_data_v4 import (ODDS_API_SPORT, _oddsapi_get, _oddsapi_key,
                           _OddsApiStop)

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "..", "data", "bet365_compare.csv")
LOG_COLS = ["observed_at", "event_id", "commence_time", "team", "opp", "book",
            "market", "side", "point", "price", "b365_price", "gap_pp"]
ALL_REGIONS = "us,us2,uk,eu,au,ca"


def _ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _match(name, needle):
    return needle.lower() in (name or "").lower()


def find_event(key, team, opp):
    events = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/events", {}, key) or []
    now = datetime.now(timezone.utc)
    hits = [e for e in events
            if e.get("commence_time") and _ts(e["commence_time"]) > now
            and ((_match(e.get("home_team"), team) and _match(e.get("away_team"), opp))
                 or (_match(e.get("away_team"), team) and _match(e.get("home_team"), opp)))]
    return min(hits, key=lambda e: _ts(e["commence_time"])) if hits else None


def gap_pp(price, ref):
    """Ecart de probabilite implicite, en points de pourcentage (signe :
    positif = le livre paie MIEUX que Bet365)."""
    return (1 / ref - 1 / price) * 100


def pl_outcome(market, team_name):
    for o in (market or {}).get("outcomes") or []:
        if o.get("name") == team_name and o.get("point") is not None \
                and abs(abs(float(o["point"])) - 1.5) < 1e-9:
            return o
    return None


def compare(a, key):
    ev = find_event(key, a.team, a.opp)
    if not ev:
        print(f"Aucun match a venir entre '{a.team}' et '{a.opp}' "
              "dans le calendrier The Odds API.")
        return
    home, away = ev["home_team"], ev["away_team"]
    team_name = home if _match(home, a.team) else away
    opp_name = away if team_name == home else home
    t = _ts(ev["commence_time"])
    bali = t + timedelta(hours=8)
    print(f"\nMatch : {away} @ {home}")
    print(f"Mise au jeu : {ev['commence_time']}  (Bali {bali:%a %d %b %H:%M})")

    data = _oddsapi_get(f"/sports/{ODDS_API_SPORT}/events/{ev['id']}/odds",
                        {"regions": a.regions, "markets": "h2h,spreads",
                         "oddsFormat": "decimal"}, key)
    if not isinstance(data, dict) or not data.get("bookmakers"):
        print("Aucun livre ne cote encore ce match.")
        return

    ref = {("h2h", team_name): a.b365_ml, ("h2h", opp_name): a.b365_opp_ml,
           ("pl", team_name): a.b365_pl, ("pl", opp_name): a.b365_opp_pl}
    # Handicap Bet365 deduit du favori : -1.5 pour le favori, +1.5 pour l'autre.
    # Une puck line n'est comparee que si le livre a le MEME handicap.
    b365_pt = {}
    if a.b365_ml and a.b365_opp_ml:
        fav_is_team = a.b365_ml < a.b365_opp_ml
        b365_pt = {team_name: -1.5 if fav_is_team else 1.5,
                   opp_name: 1.5 if fav_is_team else -1.5}
    observed = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows, score = [], {}

    short = lambda n: n.split()[-1]
    T, O = short(team_name), short(opp_name)
    print(f"\n{'livre':<22}{T+' ML':>11}{O+' ML':>11}"
          f"{T+' PL':>15}{O+' PL':>15}   ecart moyen vs Bet365")
    if any(v for v in ref.values()):
        f = lambda v: f"{v:.2f}" if v else "-"
        print(f"{'BET365 (saisi)':<22}{f(a.b365_ml):>11}{f(a.b365_opp_ml):>11}"
              f"{f(a.b365_pl):>15}{f(a.b365_opp_pl):>15}")
    print("-" * 100)

    for bk in data["bookmakers"]:
        mk = {m["key"]: m for m in bk.get("markets") or []}
        cells, gaps = [], []
        for kind, name in (("h2h", team_name), ("h2h", opp_name),
                           ("pl", team_name), ("pl", opp_name)):
            if kind == "h2h":
                o = next((x for x in (mk.get("h2h") or {}).get("outcomes") or []
                          if x.get("name") == name), None)
            else:
                o = pl_outcome(mk.get("spreads"), name)
            if not o:
                cells.append("-")
                continue
            price, point = float(o["price"]), o.get("point")
            txt = f"{price:.2f}" if kind == "h2h" else f"{point:+.1f} {price:.2f}"
            r = ref[(kind, name)]
            if r and kind == "pl" and name in b365_pt \
                    and abs(float(point) - b365_pt[name]) > 1e-9:
                r = None          # handicap different : pas comparable
            g = gap_pp(price, r) if r else None
            if g is not None:
                gaps.append(abs(g))
            cells.append(txt)
            rows.append({"observed_at": observed, "event_id": ev["id"],
                         "commence_time": ev["commence_time"],
                         "team": team_name, "opp": opp_name, "book": bk["key"],
                         "market": kind, "side": name, "point": point,
                         "price": price, "b365_price": r or "",
                         "gap_pp": "" if g is None else round(g, 3)})
        if gaps:
            score[bk["key"]] = (sum(gaps) / len(gaps), len(gaps))
        tail = f"   {score[bk['key']][0]:.2f} pp ({len(gaps)})" if gaps else ""
        print(f"{bk['key']:<22}{cells[0]:>11}{cells[1]:>11}"
              f"{cells[2]:>15}{cells[3]:>15}{tail}")

    if score:
        print("\nPLUS PROCHES DE BET365 (ecart moyen de proba implicite, "
              "nb de cotes comparees) :")
        for i, (b, (g, n)) in enumerate(sorted(score.items(),
                                               key=lambda kv: kv[1][0])[:10], 1):
            print(f"   {i:>2}. {b:<22} {g:.2f} pp  ({n})")
        print("\n1 pp = 1 point de pourcentage. Un livre qui affiche les MEMES"
              " cotes que Bet365 est a 0.")

    if rows and not a.no_log:
        new = not os.path.exists(LOG)
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=LOG_COLS)
            if new:
                w.writeheader()
            w.writerows(rows)
        print(f"\n{len(rows)} lignes ajoutees a data/bet365_compare.csv")


def summary():
    if not os.path.exists(LOG):
        print("data/bet365_compare.csv absent : aucune comparaison enregistree.")
        return
    agg = defaultdict(list)
    games = defaultdict(set)
    with open(LOG, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["gap_pp"] != "":
                agg[r["book"]].append(abs(float(r["gap_pp"])))
                games[r["book"]].add(r["event_id"])
    if not agg:
        print("Aucune cote Bet365 saisie dans le journal.")
        return
    print("\nCLASSEMENT CUMULE (tous les matchs enregistres)")
    print(f"   {'livre':<22}{'ecart moyen':>12}{'cotes':>8}{'matchs':>8}")
    for b, gs in sorted(agg.items(), key=lambda kv: sum(kv[1]) / len(kv[1])):
        print(f"   {b:<22}{sum(gs) / len(gs):>9.2f} pp{len(gs):>8}{len(games[b]):>8}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--team", default="Devils")
    p.add_argument("--opp", default="Flyers")
    p.add_argument("--b365-ml", type=float, help="Bet365 : victoire --team")
    p.add_argument("--b365-opp-ml", type=float, help="Bet365 : victoire --opp")
    p.add_argument("--b365-pl", type=float, help="Bet365 : puck line --team")
    p.add_argument("--b365-opp-pl", type=float, help="Bet365 : puck line --opp")
    p.add_argument("--regions", default=ALL_REGIONS)
    p.add_argument("--no-log", action="store_true")
    p.add_argument("--summary", action="store_true",
                   help="classement cumule depuis le journal, sans appel API")
    a = p.parse_args()
    if a.summary:
        summary()
        return
    key = _oddsapi_key()
    if not key:
        return
    try:
        compare(a, key)
    except _OddsApiStop as e:
        print(f"\narret : {e}")
    print(f"\nCredits restants : {getattr(_oddsapi_get, 'remaining', '?')}")


if __name__ == "__main__":
    main()
