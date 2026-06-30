"""
fetch_data.py
=============
Collecte des données historiques NHL depuis api-web.nhle.com
(la même API que le client TypeScript ICEEDGE).

Génère : ml/data/nhl_games.csv

Usage :
    cd ml/python
    python fetch_data.py

Options :
    --seasons 3     # nombre de saisons à récupérer (défaut 3 = 2021-22, 2022-23, 2023-24)
    --output ../data/nhl_games.csv

Durée estimée : ~5–10 min (3 saisons × ~1230 matchs, délai API intégré)
"""

import argparse
import os
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

# ── Config ────────────────────────────────────────────────────────────────────

BASE = "https://api-web.nhle.com/v1"

SEASONS = [
    # (start_date, end_date)              # saison régulière seulement
    ("2021-10-12", "2022-04-29"),         # 2021-22
    ("2022-10-07", "2023-04-14"),         # 2022-23
    ("2023-10-10", "2024-04-18"),         # 2023-24
    ("2024-10-08", "2025-04-18"),         # 2024-25 (inc. si dispo)
]

GAME_TYPE_REGULAR = 2   # 2 = saison régulière, 3 = playoffs

# ── HTTP helper ───────────────────────────────────────────────────────────────

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "ICEEDGE-ML/1.0 (data collection)"})


def get(path: str, retries: int = 3) -> dict | None:
    url = f"{BASE}/{path}"
    for attempt in range(retries):
        try:
            r = SESSION.get(url, timeout=15)
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


# ── Données de classement (stats par équipe à une date donnée) ────────────────

def get_standings(date_str: str) -> dict[str, dict]:
    """
    Retourne un dict {abbr: features} avec les stats cumulées jusqu'à date_str.
    Utilise v1/standings/{date} — une seule requête pour les 32 équipes.
    """
    data = get(f"standings/{date_str}")
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

        # PP / PK : l'API renvoie des valeurs en 0–1 (ex. 0.2134 = 21.34 %)
        pp_raw = s.get("powerPlayPctg")
        pk_raw = s.get("penaltyKillPctg")
        pp_pct = round((pp_raw or 0.20) * 100, 2)
        pk_pct = round((pk_raw or 0.80) * 100, 2)

        teams[abbr] = {
            "win_pct":             round(s.get("winPctg") or 0.5, 4),
            "goals_for_pg":        round((s.get("goalFor",     0) or 0) / gp, 3),
            "goals_against_pg":    round((s.get("goalAgainst", 0) or 0) / gp, 3),
            "pp_pct":              pp_pct,
            "pk_pct":              pk_pct,
            "last10_win_pct":      last10_win_pct,
            "gp":                  gp,
        }
    return teams


# ── Planning des matchs pour une date ────────────────────────────────────────

def get_games_for_date(date_str: str) -> list[dict]:
    """
    Retourne la liste des matchs d'une journée.
    v1/schedule/{date} renvoie une semaine; on filtre sur la date exacte.
    """
    data = get(f"schedule/{date_str}")
    if not data:
        return []
    for week in data.get("gameWeek", []):
        if week.get("date") == date_str:
            return week.get("games", [])
    return []


# ── Construction du dataset ───────────────────────────────────────────────────

FINISHED_STATES = {"OFF", "FINAL", "OVER"}


def build_dataset(n_seasons: int = 3) -> pd.DataFrame:
    seasons_to_use = SEASONS[:n_seasons]
    records: list[dict] = []
    standings_cache: dict[str, dict] = {}

    for season_start, season_end in seasons_to_use:
        current   = date.fromisoformat(season_start)
        end_date  = date.fromisoformat(season_end)
        total_days = (end_date - current).days + 1
        day_count  = 0

        print(f"\n📅 Saison {season_start[:4]}-{season_end[2:4]}")

        while current <= end_date:
            date_str  = current.isoformat()
            prev_str  = (current - timedelta(days=1)).isoformat()
            day_count += 1

            # Standings du jour précédent (stats avant les matchs du jour)
            if prev_str not in standings_cache:
                standings_cache[prev_str] = get_standings(prev_str)
                time.sleep(0.15)   # rate limit doux

            standings = standings_cache[prev_str]

            # Matchs du jour
            games = get_games_for_date(date_str)
            time.sleep(0.15)

            for g in games:
                # Filtrer : saison régulière uniquement
                if g.get("gameType") != GAME_TYPE_REGULAR:
                    continue
                if g.get("gameState") not in FINISHED_STATES:
                    continue

                home_abbr  = (g.get("homeTeam") or {}).get("abbrev", "")
                away_abbr  = (g.get("awayTeam") or {}).get("abbrev", "")
                home_score = (g.get("homeTeam") or {}).get("score")
                away_score = (g.get("awayTeam") or {}).get("score")

                if not home_abbr or not away_abbr:
                    continue
                if home_score is None or away_score is None:
                    continue
                if home_abbr not in standings or away_abbr not in standings:
                    continue

                h = standings[home_abbr]
                a = standings[away_abbr]

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
                    # Cible
                    "home_win":   1 if home_score > away_score else 0,
                    "total_goals": home_score + away_score,
                    # Features domicile
                    "home_win_pct":          h["win_pct"],
                    "home_goals_for_pg":     h["goals_for_pg"],
                    "home_goals_against_pg": h["goals_against_pg"],
                    "home_pp_pct":           h["pp_pct"],
                    "home_pk_pct":           h["pk_pct"],
                    "home_last10_win_pct":   h["last10_win_pct"],
                    # Features visiteur
                    "away_win_pct":          a["win_pct"],
                    "away_goals_for_pg":     a["goals_for_pg"],
                    "away_goals_against_pg": a["goals_against_pg"],
                    "away_pp_pct":           a["pp_pct"],
                    "away_pk_pct":           a["pk_pct"],
                    "away_last10_win_pct":   a["last10_win_pct"],
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
    parser.add_argument("--seasons", type=int, default=3,
                        help="Nombre de saisons à récupérer (1–4, défaut 3)")
    parser.add_argument("--output", default="../data/nhl_games.csv",
                        help="Chemin du CSV de sortie")
    args = parser.parse_args()

    n = max(1, min(args.seasons, len(SEASONS)))
    print(f"🏒 ICEEDGE — collecte de {n} saison(s) de données NHL")
    print(f"   API : {BASE}")
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


if __name__ == "__main__":
    main()
