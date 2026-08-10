"""
fetch_data.py
=============
Collecte des données historiques NHL depuis :
  - api-web.nhle.com/v1        (standings : win%, GF/GA, L10, splits dom/ext, séries)
  - api.nhle.com/stats/rest    (team summary : PP%, PK% réels, tirs, mises au jeu)

Génère : ml/data/nhl_games.csv

Usage :
    cd ml/python
    python fetch_data.py --seasons 5

Options :
    --seasons 5     # nombre de saisons à récupérer (défaut 5 = 2021-22 → 2025-26)
    --output ../data/nhl_games.csv

Durée estimée : ~10–20 min (2 requêtes/jour de saison, délai API intégré)
"""

import argparse
import os
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

# ── Config ────────────────────────────────────────────────────────────────────

BASE       = "https://api-web.nhle.com/v1"
STATS_BASE = "https://api.nhle.com/stats/rest/en"

SEASONS = [
    # (start_date, end_date, season_id)   # saison régulière seulement
    ("2021-10-12", "2022-04-29", 20212022),
    ("2022-10-07", "2023-04-14", 20222023),
    ("2023-10-10", "2024-04-18", 20232024),
    ("2024-10-04", "2025-04-17", 20242025),
    ("2025-10-07", "2026-04-16", 20252026),
]

GAME_TYPE_REGULAR = 2   # 2 = saison régulière, 3 = playoffs

# L'API stats/rest identifie les équipes par nom complet — mapping vers abréviations
TEAM_NAME_TO_ABBR = {
    "Anaheim Ducks": "ANA",         "Arizona Coyotes": "ARI",
    "Boston Bruins": "BOS",         "Buffalo Sabres": "BUF",
    "Calgary Flames": "CGY",        "Carolina Hurricanes": "CAR",
    "Chicago Blackhawks": "CHI",    "Colorado Avalanche": "COL",
    "Columbus Blue Jackets": "CBJ", "Dallas Stars": "DAL",
    "Detroit Red Wings": "DET",     "Edmonton Oilers": "EDM",
    "Florida Panthers": "FLA",      "Los Angeles Kings": "LAK",
    "Minnesota Wild": "MIN",        "Montréal Canadiens": "MTL",
    "Montreal Canadiens": "MTL",    "Nashville Predators": "NSH",
    "New Jersey Devils": "NJD",     "New York Islanders": "NYI",
    "New York Rangers": "NYR",      "Ottawa Senators": "OTT",
    "Philadelphia Flyers": "PHI",   "Pittsburgh Penguins": "PIT",
    "San Jose Sharks": "SJS",       "Seattle Kraken": "SEA",
    "St. Louis Blues": "STL",       "Tampa Bay Lightning": "TBL",
    "Toronto Maple Leafs": "TOR",   "Utah Hockey Club": "UTA",
    "Utah Mammoth": "UTA",          "Vancouver Canucks": "VAN",
    "Vegas Golden Knights": "VGK",  "Washington Capitals": "WSH",
    "Winnipeg Jets": "WPG",
}

# ── HTTP helper ───────────────────────────────────────────────────────────────

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "ICEEDGE-ML/2.0 (data collection)"})


def get(url: str, params: dict | None = None, retries: int = 3) -> dict | None:
    for attempt in range(retries):
        try:
            r = SESSION.get(url, params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                return None          # pas de données pour cette date
            if attempt == retries - 1:
                print(f"  [WARN] {url} → {e}")
                return None
            time.sleep(2 ** attempt)
        except Exception as e:
            if attempt == retries - 1:
                print(f"  [WARN] {url} → {e}")
                return None
            time.sleep(2 ** attempt)
    return None


# ── Stats spéciales & tirs (PP/PK réels) — api.nhle.com/stats/rest ────────────

def get_team_stats(date_str: str, season_id: int) -> dict[str, dict]:
    """
    PP%, PK%, tirs/match et mises au jeu cumulés STRICTEMENT AVANT date_str
    (gameDate<= date_str, où date_str est déjà J-1 → pas de leakage).
    Une seule requête pour les 32 équipes.
    """
    cayenne = (
        f'seasonId={season_id} and gameTypeId={GAME_TYPE_REGULAR} '
        f'and gameDate<="{date_str}"'
    )
    data = get(f"{STATS_BASE}/team/summary", params={"limit": -1, "cayenneExp": cayenne})
    if not data:
        return {}

    teams: dict[str, dict] = {}
    for t in data.get("data", []):
        abbr = TEAM_NAME_TO_ABBR.get(t.get("teamFullName", ""))
        if not abbr:
            continue
        teams[abbr] = {
            "pp_pct":           round((t.get("powerPlayPct")   or 0.20) * 100, 2),
            "pk_pct":           round((t.get("penaltyKillPct") or 0.80) * 100, 2),
            "shots_for_pg":     round(t.get("shotsForPerGame")     or 30.0, 2),
            "shots_against_pg": round(t.get("shotsAgainstPerGame") or 30.0, 2),
            "faceoff_pct":      round((t.get("faceoffWinPct")  or 0.50) * 100, 2),
        }
    return teams


# ── Données de classement (stats par équipe à une date donnée) ────────────────

def _split_win_pct(wins, losses, ot_losses) -> float:
    gp = (wins or 0) + (losses or 0) + (ot_losses or 0)
    return round((wins or 0) / gp, 4) if gp > 0 else 0.5


def get_standings(date_str: str) -> dict[str, dict]:
    """
    Retourne un dict {abbr: features} avec les stats cumulées jusqu'à date_str.
    Utilise v1/standings/{date} — une seule requête pour les 32 équipes.
    """
    data = get(f"{BASE}/standings/{date_str}")
    if not data:
        return {}

    teams: dict[str, dict] = {}
    for s in data.get("standings", []):
        abbr = (s.get("teamAbbrev") or {}).get("default") or s.get("teamAbbrev", "")
        if not abbr:
            continue

        gp = max(s.get("gamesPlayed", 1) or 1, 1)

        # Last 10 (l10Wins / 10)
        l10w = s.get("l10Wins", 5)
        last10_win_pct = min(1.0, l10w / 10)

        # Série en cours, signée : W3 → +3, L2 → -2, OT → -1×count
        streak_count = s.get("streakCount", 0) or 0
        streak_code  = s.get("streakCode", "") or ""
        streak = streak_count if streak_code == "W" else -streak_count

        teams[abbr] = {
            "win_pct":          round(s.get("winPctg") or 0.5, 4),
            "goals_for_pg":     round((s.get("goalFor",     0) or 0) / gp, 3),
            "goals_against_pg": round((s.get("goalAgainst", 0) or 0) / gp, 3),
            "last10_win_pct":   last10_win_pct,
            # Splits domicile / extérieur
            "home_record_pct":  _split_win_pct(s.get("homeWins"), s.get("homeLosses"), s.get("homeOtLosses")),
            "road_record_pct":  _split_win_pct(s.get("roadWins"), s.get("roadLosses"), s.get("roadOtLosses")),
            "streak":           streak,
            "gp":               gp,
        }
    return teams


# ── Planning des matchs pour une date ────────────────────────────────────────

def get_games_for_date(date_str: str) -> list[dict]:
    """
    Retourne la liste des matchs d'une journée.
    v1/schedule/{date} renvoie une semaine; on filtre sur la date exacte.
    """
    data = get(f"{BASE}/schedule/{date_str}")
    if not data:
        return []
    for week in data.get("gameWeek", []):
        if week.get("date") == date_str:
            return week.get("games", [])
    return []


# ── Construction du dataset ───────────────────────────────────────────────────

FINISHED_STATES = {"OFF", "FINAL", "OVER"}

DEFAULT_REST = 3   # jours de repos par défaut (début de saison)
MAX_REST     = 7   # cap — au-delà, l'effet repos plafonne


def build_dataset(n_seasons: int = 5) -> pd.DataFrame:
    seasons_to_use = SEASONS[:n_seasons]
    records: list[dict] = []

    for season_start, season_end, season_id in seasons_to_use:
        current    = date.fromisoformat(season_start)
        end_date   = date.fromisoformat(season_end)
        total_days = (end_date - current).days + 1
        day_count  = 0

        standings_cache: dict[str, dict] = {}
        stats_cache:     dict[str, dict] = {}
        last_played:     dict[str, date] = {}   # abbr → date du dernier match (reset par saison)

        print(f"\n📅 Saison {season_start[:4]}-{season_end[2:4]}")

        while current <= end_date:
            date_str  = current.isoformat()
            prev_str  = (current - timedelta(days=1)).isoformat()
            day_count += 1

            # Matchs du jour (d'abord — évite de fetch les stats les jours sans match)
            games = get_games_for_date(date_str)
            time.sleep(0.15)

            regular_games = [
                g for g in games
                if g.get("gameType") == GAME_TYPE_REGULAR
                and g.get("gameState") in FINISHED_STATES
            ]

            if regular_games:
                # Stats du jour précédent (stats avant les matchs du jour → pas de leakage)
                if prev_str not in standings_cache:
                    standings_cache[prev_str] = get_standings(prev_str)
                    time.sleep(0.15)
                if prev_str not in stats_cache:
                    stats_cache[prev_str] = get_team_stats(prev_str, season_id)
                    time.sleep(0.15)

                standings  = standings_cache[prev_str]
                team_stats = stats_cache[prev_str]

                for g in regular_games:
                    home_abbr  = (g.get("homeTeam") or {}).get("abbrev", "")
                    away_abbr  = (g.get("awayTeam") or {}).get("abbrev", "")
                    home_score = (g.get("homeTeam") or {}).get("score")
                    away_score = (g.get("awayTeam") or {}).get("score")

                    if not home_abbr or not away_abbr:
                        continue
                    if home_score is None or away_score is None:
                        continue

                    # Repos / back-to-back — calculés AVANT le filtre gp<5
                    # pour que last_played reste correct
                    h_rest = min((current - last_played[home_abbr]).days, MAX_REST) \
                             if home_abbr in last_played else DEFAULT_REST
                    a_rest = min((current - last_played[away_abbr]).days, MAX_REST) \
                             if away_abbr in last_played else DEFAULT_REST
                    last_played[home_abbr] = current
                    last_played[away_abbr] = current

                    if home_abbr not in standings or away_abbr not in standings:
                        continue
                    if home_abbr not in team_stats or away_abbr not in team_stats:
                        continue

                    h,  a  = standings[home_abbr],  standings[away_abbr]
                    hs, as_ = team_stats[home_abbr], team_stats[away_abbr]

                    # Ignorer les tout premiers matchs (stats peu fiables, GP < 5)
                    if h["gp"] < 5 or a["gp"] < 5:
                        continue

                    records.append({
                        # Métadonnées
                        "date":       date_str,
                        "home_team":  home_abbr,
                        "away_team":  away_abbr,
                        "home_score": home_score,
                        "away_score": away_score,
                        # Cibles
                        "home_win":    1 if home_score > away_score else 0,
                        "total_goals": home_score + away_score,
                        # Features domicile
                        "home_win_pct":          h["win_pct"],
                        "home_goals_for_pg":     h["goals_for_pg"],
                        "home_goals_against_pg": h["goals_against_pg"],
                        "home_pp_pct":           hs["pp_pct"],
                        "home_pk_pct":           hs["pk_pct"],
                        "home_last10_win_pct":   h["last10_win_pct"],
                        "home_home_win_pct":     h["home_record_pct"],   # record À DOMICILE
                        "home_streak":           h["streak"],
                        "home_shots_for_pg":     hs["shots_for_pg"],
                        "home_shots_against_pg": hs["shots_against_pg"],
                        "home_faceoff_pct":      hs["faceoff_pct"],
                        "home_rest_days":        h_rest,
                        "home_b2b":              1 if h_rest == 1 else 0,
                        # Features visiteur
                        "away_win_pct":          a["win_pct"],
                        "away_goals_for_pg":     a["goals_for_pg"],
                        "away_goals_against_pg": a["goals_against_pg"],
                        "away_pp_pct":           as_["pp_pct"],
                        "away_pk_pct":           as_["pk_pct"],
                        "away_last10_win_pct":   a["last10_win_pct"],
                        "away_road_win_pct":     a["road_record_pct"],   # record À L'EXTÉRIEUR
                        "away_streak":           a["streak"],
                        "away_shots_for_pg":     as_["shots_for_pg"],
                        "away_shots_against_pg": as_["shots_against_pg"],
                        "away_faceoff_pct":      as_["faceoff_pct"],
                        "away_rest_days":        a_rest,
                        "away_b2b":              1 if a_rest == 1 else 0,
                    })

            # Affichage progression
            pct = (day_count / total_days) * 100
            n   = len(records)
            sys.stdout.write(f"\r  [{pct:5.1f}%] {date_str}  — {n} matchs collectés")
            sys.stdout.flush()

            current += timedelta(days=1)

        print()   # nouvelle ligne après la saison

    return pd.DataFrame(records)


# ── Point d'entrée ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Collecte données NHL historiques")
    parser.add_argument("--seasons", type=int, default=5,
                        help=f"Nombre de saisons à récupérer (1–{len(SEASONS)}, défaut 5)")
    parser.add_argument("--output", default="../data/nhl_games.csv",
                        help="Chemin du CSV de sortie")
    args = parser.parse_args()

    n = max(1, min(args.seasons, len(SEASONS)))
    print(f"🏒 ArakIce — collecte de {n} saison(s) de données NHL")
    print(f"   APIs : {BASE} + {STATS_BASE}")
    print(f"   Sortie : {args.output}")

    df = build_dataset(n_seasons=n)

    if df.empty:
        print("\n⚠️  Aucun match collecté. Vérifiez la connexion ou les dates de saison.")
        sys.exit(1)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    df.to_csv(args.output, index=False)

    print(f"\n✅ {len(df)} matchs sauvegardés → {args.output}")
    print(f"   Colonnes : {list(df.columns)}")
    print(f"   Taux victoire domicile : {df['home_win'].mean():.1%}")
    print(f"   Buts totaux moy.       : {df['total_goals'].mean():.2f}")

    # Sanity check : PP/PK doivent avoir de la variance (bug historique : constantes 20/80)
    for col in ("home_pp_pct", "home_pk_pct"):
        if df[col].std() < 0.01:
            print(f"⚠️  {col} est constant ({df[col].iloc[0]}) — vérifier l'API stats/rest !")


if __name__ == "__main__":
    main()




species = "Hibiscus rosa-sinensis"

pollinators = [
    "Bees",
    "Butterflies",
    "Hummingbirds"
]

daily_flowers = 18
days = 5
total = 0

print(f"Flower production report for {species}\n")

for day in range(1, days + 1):
    total += daily_flowers
    print(f"Day {day}: {daily_flowers} flowers opened")

print(f"\nTotal flowers: {total}")

if total > 80:
    print("Excellent flowering performance.")
else:
    print("Average flowering performance.")

print("Flower lifespan: approximately one day.")
print("Common uses: ornamental gardens, herbal tea and natural dyes.")


