"""
fetch_data_v4.py
================
Collecte v4 — 3 sources :
  1. Spine des matchs (scores officiels, SO inclus)  → api.nhle.com/stats/rest/en/game  (1 requête)
  2. Stats avancées MoneyPuck (xG, Corsi, gardiens, joueurs) → moneypuck.com (CSV/zips)
  3. Cotes historiques (moneyline + totaux, open/close) → sportsbookreviewsonline.com (xlsx)

Sorties dans ml/data/ :
    games_spine.csv       # date, home, away, scores (toutes saisons)
    mp_team_games.csv     # stats équipe par match par situation (MoneyPuck)
    mp_goalie_games.csv   # stats gardien par match (situation 'all')
    mp_skater_games.csv   # stats patineur par match (colonnes minimales)
    odds.csv              # cotes historiques normalisées

Usage :
    cd ml/python
    python fetch_data_v4.py                # tout
    python fetch_data_v4.py --skip-skaters # sans les patineurs (plus rapide)
    python fetch_data_v4.py --only odds    # une seule source (spine|moneypuck|odds)

Ensuite : python build_dataset.py  puis  python train.py
"""

import argparse
import io
import os
import sys
import time
import zipfile

import pandas as pd
import requests

DATA_DIR = "../data"
SESSION = requests.Session()
# En-têtes navigateur — moneypuck.com renvoie 403 aux User-Agents de script
SESSION.headers.update({
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "text/csv,application/zip,application/octet-stream,text/html,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    "Referer": "https://moneypuck.com/data.htm",
    "Connection": "keep-alive",
})

FIRST_SEASON = 2008          # 2008-09 — début de la couverture MoneyPuck fiable
LAST_SEASON  = 2025          # 2025-26 (saison en cours)

# Continuité des franchises (ELO + rolling stats suivent la franchise)
FRANCHISE_MAP = {"ATL": "WPG", "PHX": "ARI", "ARI": "UTA", "L.A": "LAK", "S.J": "SJS",
                 "N.J": "NJD", "T.B": "TBL"}


def norm_team(abbr: str) -> str:
    abbr = (abbr or "").strip().upper()
    while abbr in FRANCHISE_MAP:
        abbr = FRANCHISE_MAP[abbr]
    return abbr


def http_get(url: str, retries: int = 3, timeout: int = 120) -> requests.Response | None:
    for attempt in range(retries):
        try:
            r = SESSION.get(url, timeout=timeout)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r
        except Exception as e:
            if attempt == retries - 1:
                print(f"  [WARN] {url} → {e}")
                return None
            time.sleep(2 ** attempt)
    return None


# ══════════════════════════════════════════════════════════════════════════════
# 1. SPINE — tous les matchs + scores officiels (une seule requête)
# ══════════════════════════════════════════════════════════════════════════════

def fetch_spine() -> None:
    print("📅 Spine des matchs (api.nhle.com/stats/rest) …")
    teams = http_get("https://api.nhle.com/stats/rest/en/team").json()["data"]
    id2abbr = {t["id"]: t["triCode"] for t in teams}

    games = http_get("https://api.nhle.com/stats/rest/en/game").json()["data"]
    rows = []
    for g in games:
        season = g.get("season")          # ex. 20232024
        if not season or int(str(season)[:4]) < FIRST_SEASON:
            continue
        if g.get("gameType") != 2:        # saison régulière seulement
            continue
        if g.get("gameStateId") not in (6, 7):   # 6/7 = final
            continue
        h, a = id2abbr.get(g["homeTeamId"]), id2abbr.get(g["visitingTeamId"])
        if not h or not a:
            continue
        rows.append({
            "game_id":    g["id"],
            "season":     int(str(season)[:4]),
            "date":       str(g["gameDate"])[:10],
            "home_team":  norm_team(h),
            "away_team":  norm_team(a),
            "home_score": g["homeScore"],
            "away_score": g["visitingScore"],
        })
    df = pd.DataFrame(rows).sort_values(["date", "game_id"]).reset_index(drop=True)
    df.to_csv(f"{DATA_DIR}/games_spine.csv", index=False)
    print(f"   ✅ {len(df)} matchs ({df['season'].min()}-{df['season'].max()}) → games_spine.csv")


# ══════════════════════════════════════════════════════════════════════════════
# 2. MONEYPUCK — équipes, gardiens, patineurs (par match)
# ══════════════════════════════════════════════════════════════════════════════

MP_TEAMS_URL   = "https://moneypuck.com/moneypuck/playerData/careers/gameByGame/all_teams.csv"
MP_GBG_HIST    = "https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/{kind}/2008_to_2024.zip"
MP_GBG_SEASON  = "https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/{kind}/{season}.zip"

SKATER_KEEP = ["playerId", "name", "playerTeam", "team", "gameId", "gameDate", "situation",
               "position", "icetime", "I_F_goals", "I_F_points", "I_F_xGoals", "I_F_shotsOnGoal"]


def _read_zip_csvs(content: bytes, keep: list[str] | None = None,
                   situation: str | None = "all") -> pd.DataFrame:
    frames = []
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        for name in z.namelist():
            if not name.endswith(".csv"):
                continue
            with z.open(name) as f:
                df = pd.read_csv(f, low_memory=False)
            if situation and "situation" in df.columns:
                df = df[df["situation"] == situation]
            if keep:
                df = df[[c for c in keep if c in df.columns]]
            frames.append(df)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


RAW_DIR = f"{DATA_DIR}/raw"


def fetch_moneypuck(skip_skaters: bool = False, from_local: bool = False) -> None:
    # ── Équipes (un seul gros CSV, toutes saisons, toutes situations) ─────────
    print("🏒 MoneyPuck — stats équipe par match …")
    if from_local:
        local_csv = f"{RAW_DIR}/all_teams.csv"
        if not os.path.exists(local_csv):
            print(f"   ❌ {local_csv} introuvable — télécharge-le depuis "
                  f"moneypuck.com/data.htm"); sys.exit(1)
        df = pd.read_csv(local_csv, low_memory=False)
    else:
        r = http_get(MP_TEAMS_URL, timeout=600)
        if r is None:
            print("   ❌ échec all_teams.csv — utilise --from-local (voir README)")
            sys.exit(1)
        df = pd.read_csv(io.BytesIO(r.content), low_memory=False)
    df = df[df["situation"].isin(["all", "5on5", "5on4", "4on5"])]
    if "season" in df.columns:
        df = df[df["season"] >= FIRST_SEASON]
    df.to_csv(f"{DATA_DIR}/mp_team_games.csv", index=False)
    print(f"   ✅ {len(df)} lignes → mp_team_games.csv")

    # ── Gardiens + patineurs (historique + saison courante) ──────────────────
    import glob as _glob
    for kind, out, keep in [
        ("goalies", "mp_goalie_games.csv", None),
        ("skaters", "mp_skater_games.csv", SKATER_KEEP),
    ]:
        if kind == "skaters" and skip_skaters:
            print("   ⏭️  patineurs ignorés (--skip-skaters)")
            continue
        print(f"🥅 MoneyPuck — {kind} par match …" if kind == "goalies"
              else f"⛸️  MoneyPuck — {kind} par match (gros zips) …")
        frames = []
        if from_local:
            zips = sorted(_glob.glob(f"{RAW_DIR}/{kind}*.zip"))
            if not zips:
                print(f"   ❌ aucun {RAW_DIR}/{kind}*.zip — télécharge "
                      f"{kind}_2008_to_2024.zip et {kind}_2025.zip"); continue
            for zp in zips:
                print(f"   lecture {os.path.basename(zp)} …")
                with open(zp, "rb") as fh:
                    frames.append(_read_zip_csvs(fh.read(), keep=keep))
        else:
            r = http_get(MP_GBG_HIST.format(kind=kind), timeout=900)
            if r is not None:
                frames.append(_read_zip_csvs(r.content, keep=keep))
            for season in range(2025, LAST_SEASON + 1):
                r = http_get(MP_GBG_SEASON.format(kind=kind, season=season), timeout=600)
                if r is not None:
                    frames.append(_read_zip_csvs(r.content, keep=keep))
        if not frames:
            print(f"   ❌ aucune donnée {kind}"); continue
        allg = pd.concat(frames, ignore_index=True)
        allg.to_csv(f"{DATA_DIR}/{out}", index=False)
        print(f"   ✅ {len(allg)} lignes → {out}")


# ══════════════════════════════════════════════════════════════════════════════
# 3. COTES HISTORIQUES — sportsbookreviewsonline (xlsx, gratuit, ~2007→2022)
# ══════════════════════════════════════════════════════════════════════════════

SBRO_BASE = "https://www.sportsbookreviewsonline.com/scoresoddsarchives/nhl/nhl%20odds%20{s}.xlsx"

# Le site a migré les archives vers des pages HTML par saison (les xlsx n'existent plus)
# slug → année de début de saison (attention : "nhl-odds-2021" = saison COVID 2020-21)
SBRO_HTML_BASE  = "https://www.sportsbookreviewsonline.com/scoresoddsarchives/nhl-odds-{slug}"
SBRO_HTML_SLUGS = {
    "2007-08": 2007, "2008-09": 2008, "2009-10": 2009, "2010-11": 2010,
    "2011-12": 2011, "2012-13": 2012, "2013-14": 2013, "2014-15": 2014,
    "2015-16": 2015, "2016-17": 2016, "2017-18": 2017, "2018-19": 2018,
    "2019-20": 2019, "2021": 2020, "2021-22": 2021, "2022-23": 2022,
}

SBRO_TEAM_MAP = {
    "ANAHEIM": "ANA", "ARIZONA": "UTA", "PHOENIX": "UTA", "UTAH": "UTA",
    "ATLANTA": "WPG", "BOSTON": "BOS", "BUFFALO": "BUF", "CALGARY": "CGY",
    "CAROLINA": "CAR", "CHICAGO": "CHI", "COLORADO": "COL", "COLUMBUS": "CBJ",
    "DALLAS": "DAL", "DETROIT": "DET", "EDMONTON": "EDM", "FLORIDA": "FLA",
    "LOSANGELES": "LAK", "MINNESOTA": "MIN", "MONTREAL": "MTL", "NASHVILLE": "NSH",
    "NEWJERSEY": "NJD", "NYISLANDERS": "NYI", "NYRANGERS": "NYR", "OTTAWA": "OTT",
    "PHILADELPHIA": "PHI", "PITTSBURGH": "PIT", "SANJOSE": "SJS", "SEATTLE": "SEA",
    "ST.LOUIS": "STL", "STLOUIS": "STL", "TAMPABAY": "TBL", "TORONTO": "TOR",
    "VANCOUVER": "VAN", "VEGAS": "VGK", "VEGASGOLDEN": "VGK",
    "VEGASGOLDENKNIGHTS": "VGK", "WASHINGTON": "WSH", "WINNIPEG": "WPG",
    "SEATTLEKRAKEN": "SEA", "ATLANTA": "WPG",
}


def _sbro_team(raw: str) -> str | None:
    key = str(raw).replace(" ", "").replace("é", "e").upper()
    return SBRO_TEAM_MAP.get(key)


def _american_to_decimal(ml) -> float | None:
    try:
        ml = float(ml)
    except (TypeError, ValueError):
        return None
    if ml == 0:
        return None
    return 1 + ml / 100 if ml > 0 else 1 + 100 / abs(ml)


def _sbro_date(mmdd, season_start_year: int) -> str | None:
    try:
        mmdd = int(mmdd)
    except (TypeError, ValueError):
        return None
    month, day = divmod(mmdd, 100)
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    year = season_start_year if month >= 8 else season_start_year + 1
    return f"{year:04d}-{month:02d}-{day:02d}"


def _sbro_sources(from_local: bool):
    """Génère (label, start_year, contenu_xlsx bytes) par saison."""
    if from_local:
        import glob as _glob
        import re as _re
        files = sorted(_glob.glob(f"{RAW_DIR}/odds/*.xls*"))
        if not files:
            print(f"   ❌ aucun xlsx dans {RAW_DIR}/odds/ — télécharge les "
                  f"'nhl odds YYYY-YY.xlsx' de sportsbookreviewsonline")
        for path in files:
            m = _re.search(r"(20\d\d)", os.path.basename(path))
            if not m:
                print(f"   [WARN] année introuvable dans le nom : {path}")
                continue
            start = int(m.group(1))
            with open(path, "rb") as fh:
                yield os.path.basename(path), start, fh.read()
    else:
        for start in range(2007, 2025):
            label = f"{start}-{str(start + 1)[2:]}"
            r = http_get(SBRO_BASE.format(s=label), timeout=120)
            if r is not None:
                yield label, start, r.content


def _pair_rows(recs: list[dict], start: int, all_rows: list[dict]) -> int:
    """Apparie les lignes V (visiteur) / H (domicile) et remplit all_rows."""
    n_season, i = 0, 0
    while i + 1 < len(recs):
        v, h = recs[i], recs[i + 1]
        if str(v.get("vh")).strip().upper() not in ("V", "N") or \
           str(h.get("vh")).strip().upper() not in ("H", "N"):
            i += 1
            continue
        date = _sbro_date(v.get("date"), start)
        away, home = _sbro_team(v.get("team")), _sbro_team(h.get("team"))
        if not date or not away or not home:
            i += 2
            continue
        row = {
            "date": date, "home_team": home, "away_team": away,
            "home_ml_open":  _american_to_decimal(h.get("open")),
            "away_ml_open":  _american_to_decimal(v.get("open")),
            "home_ml_close": _american_to_decimal(h.get("close")),
            "away_ml_close": _american_to_decimal(v.get("close")),
        }
        # Totaux : colonnes 'open ou'/'close ou' ou variantes
        for src, dst in [("open ou", "total_open"), ("close ou", "total_close"),
                         ("openou", "total_open"), ("closeou", "total_close")]:
            if src in h and dst not in row:
                try:
                    val = float(h[src])
                    row[dst] = val if 3.5 <= val <= 9.5 else None
                except (TypeError, ValueError):
                    row[dst] = None
        all_rows.append(row)
        n_season += 1
        i += 2
    return n_season


def _parse_sbro_html(html: str) -> list[dict]:
    """
    Parse le <table> d'une page d'archive SBRO (texte HTML déjà en mémoire).
    Une cellule <td> par champ, dans l'ordre :
      0 Date  1 Rot  2 VH  3 Team  4 1st  5 2nd  6 3rd  7 Final
      8 Open  9 Close  10 PuckLine  11 PLprix  12 OpenOU  13 OUprix
      14 CloseOU  15 OUprix
    On lit les cellules par position (read_html) au lieu de découper du texte.
    """
    try:
        tables = pd.read_html(io.StringIO(html))
    except ImportError as e:
        # Backend HTML manquant (lxml / bs4+html5lib) → échoue sur TOUS les fichiers
        print(f"   ❌ pd.read_html requiert un parseur HTML : {e}")
        print("      installe-le : pip install lxml   (ou : pip install beautifulsoup4 html5lib)")
        return []
    except ValueError:
        return []                    # aucune <table> dans la page

    # Retenir la table dont la 1re ligne contient l'en-tête attendu
    df = None
    for t in tables:
        header = {str(c).strip().lower() for c in t.iloc[0].tolist()}
        if {"date", "vh", "team"}.issubset(header):
            df = t.iloc[1:].reset_index(drop=True)   # retirer la ligne d'en-tête
            break
    if df is None or df.shape[1] < 16:
        return []

    def num(tok):
        tok = str(tok).replace("½", ".5").strip()
        try:
            return float(tok)
        except ValueError:
            return None          # 'NL' (no line), 'PK', etc.

    recs = []
    for vals in df.itertuples(index=False, name=None):
        vh = str(vals[2]).strip().upper()
        if vh not in ("V", "H", "N"):
            continue
        team = str(vals[3]).strip()
        if not team:
            continue
        recs.append({
            "date": vals[0], "vh": vh, "team": team,
            "final": num(vals[7]),
            "open":  num(vals[8]),  "close": num(vals[9]),
            "open ou": num(vals[12]), "close ou": num(vals[14]),
        })
    return recs


def _scrape_sbro_html(slug: str) -> list[dict]:
    """Télécharge puis parse une page d'archive (peut échouer si le site bloque)."""
    r = http_get(SBRO_HTML_BASE.format(slug=slug), timeout=120)
    if r is None:
        return []
    return _parse_sbro_html(r.text)


def _local_html_sources():
    """(label, start_year, html_text) pour chaque page .html sauvegardée dans data/raw/odds/."""
    import glob as _glob
    import re as _re
    files = sorted(_glob.glob(f"{RAW_DIR}/odds/*.htm*"))
    for path in files:
        base = os.path.basename(path).lower()
        # Année de début : on réutilise SBRO_HTML_SLUGS (gère 'nhl-odds-2021' = 2020-21).
        # Slugs les plus longs testés d'abord (2021-22 avant 2021).
        start = None
        for slug, yr in sorted(SBRO_HTML_SLUGS.items(), key=lambda kv: -len(kv[0])):
            if slug in base:
                start = yr
                break
        if start is None:
            m = _re.search(r"(20\d\d)", base)
            start = int(m.group(1)) if m else None
        if start is None:
            print(f"   [WARN] saison introuvable dans le nom : {path}")
            continue
        with open(path, encoding="utf-8", errors="ignore") as fh:
            yield os.path.basename(path), start, fh.read()


# ── Source alternative : CSV tiers déposé dans data/raw/odds/ ─────────────────
# (une ligne = un match, colonnes déjà séparées domicile/visiteur — p. ex. le
#  dataset Kaggle "NHL Full Game & Betting Statistics"). Détection tolérante des
#  noms de colonnes : si une colonne clé manque, on affiche ce qui a été vu.
_ODDS_COL_ALIASES = {
    "date":          ["date", "game_date", "gamedate", "datetime", "game_datetime"],
    "home_team":     ["home_team", "home", "hometeam", "home_abbr", "home_name",
                      "home_team_abbr"],
    "away_team":     ["away_team", "away", "awayteam", "away_abbr", "away_name",
                      "visitor", "visitor_team", "away_team_abbr"],
    "home_ml_close": ["home_ml_close", "home_ml", "home_moneyline", "home_close",
                      "close_home_ml", "moneyline_home", "home_ml_closing", "ml_home",
                      "home_odds"],
    "away_ml_close": ["away_ml_close", "away_ml", "away_moneyline", "away_close",
                      "close_away_ml", "moneyline_away", "away_ml_closing", "ml_away",
                      "away_odds"],
    "home_ml_open":  ["home_ml_open", "open_home_ml", "home_open_ml", "home_ml_opening"],
    "away_ml_open":  ["away_ml_open", "open_away_ml", "away_open_ml", "away_ml_opening"],
    "total_close":   ["total_close", "close_ou", "closeou", "total", "over_under",
                      "ou_close", "closing_total"],
    "total_open":    ["total_open", "open_ou", "openou", "ou_open", "opening_total"],
}


def _to_decimal_series(s: pd.Series) -> pd.Series:
    """Convertit une colonne de cotes en décimales (auto-détection américaine)."""
    v = pd.to_numeric(s, errors="coerce")
    if ((v < 0) | (v.abs() >= 100)).any():        # au moins une cote américaine
        return v.map(_american_to_decimal)
    return v                                       # déjà en décimales


def _norm_any_team(x) -> str | None:
    """Accepte une abréviation (CHI) ou un nom complet (Chicago / St. Louis)."""
    t = norm_team(str(x))
    if len(t) == 3 and t.isalpha():
        return t
    return _sbro_team(x)


def _load_local_odds_csv() -> list[dict]:
    import glob as _glob
    rows: list[dict] = []
    for path in sorted(_glob.glob(f"{RAW_DIR}/odds/*.csv")):
        name = os.path.basename(path)
        try:
            df = pd.read_csv(path)
        except Exception as e:
            print(f"   [WARN] {name}: lecture impossible ({e})")
            continue
        cols_lower = {str(c).strip().lower(): c for c in df.columns}
        pick = {k: next((cols_lower[a] for a in al if a in cols_lower), None)
                for k, al in _ODDS_COL_ALIASES.items()}
        need = ("date", "home_team", "away_team", "home_ml_close", "away_ml_close")
        missing = [k for k in need if pick[k] is None]
        if missing:
            print(f"   [WARN] {name}: colonnes clés non reconnues {missing}")
            print(f"          colonnes vues : {list(df.columns)}")
            continue
        out = pd.DataFrame({
            "date": pd.to_datetime(df[pick["date"]], errors="coerce").dt.strftime("%Y-%m-%d"),
            "home_team": df[pick["home_team"]].map(_norm_any_team),
            "away_team": df[pick["away_team"]].map(_norm_any_team),
            "home_ml_close": _to_decimal_series(df[pick["home_ml_close"]]),
            "away_ml_close": _to_decimal_series(df[pick["away_ml_close"]]),
        })
        for k in ("home_ml_open", "away_ml_open"):
            out[k] = _to_decimal_series(df[pick[k]]) if pick[k] else pd.NA
        for k in ("total_open", "total_close"):
            out[k] = pd.to_numeric(df[pick[k]], errors="coerce") if pick[k] else pd.NA
        out = out.dropna(subset=["date", "home_team", "away_team"])
        rows.extend(out.to_dict("records"))
        print(f"   {name}: {len(out)} matchs avec cotes")
    return rows


def fetch_odds(from_local: bool = False) -> None:
    print("💰 Cotes historiques (sportsbookreviewsonline) …")
    all_rows = []
    if from_local:
        # xlsx téléchargés manuellement dans data/raw/odds/
        for label, start, content in _sbro_sources(True):
            try:
                raw = pd.read_excel(io.BytesIO(content))
            except Exception as e:
                print(f"   [WARN] parse {label}: {e}")
                continue
            raw.columns = [str(c).strip().lower() for c in raw.columns]
            if not {"date", "vh", "team"}.issubset(set(raw.columns)):
                print(f"   [WARN] colonnes inattendues {label}")
                continue
            n = _pair_rows(raw.to_dict("records"), start, all_rows)
            print(f"   {label}: {n} matchs avec cotes")
        # Pages .html sauvegardées depuis le navigateur (contourne le blocage bot)
        for label, start, html in _local_html_sources():
            recs = _parse_sbro_html(html)
            if not recs:
                print(f"   [WARN] {label}: aucune table exploitable")
                continue
            n = _pair_rows(recs, start, all_rows)
            print(f"   {label}: {n} matchs avec cotes")
        # CSV tiers (Kaggle, etc.) — une ligne par match, colonnes auto-détectées
        all_rows.extend(_load_local_odds_csv())
    else:
        # Scraping des pages HTML d'archives (les xlsx n'existent plus)
        for slug, start in SBRO_HTML_SLUGS.items():
            recs = _scrape_sbro_html(slug)
            if not recs:
                print(f"   [WARN] page {slug} vide ou inaccessible")
                continue
            n = _pair_rows(recs, start, all_rows)
            print(f"   {slug}: {n} matchs avec cotes")

    df = pd.DataFrame(all_rows)

    # ── Fusion avec le log de cotes live (The Odds API, loggé par le serveur) ──
    live_path = f"{DATA_DIR}/odds_live_log.csv"
    if os.path.exists(live_path):
        live = pd.read_csv(live_path)
        live["home_team"] = live["home_team"].map(norm_team)
        live["away_team"] = live["away_team"].map(norm_team)
        df = pd.concat([df, live], ignore_index=True)
        print(f"   + {len(live)} lignes du log live (odds_live_log.csv)")

    if df.empty:
        print("   ⚠️  Aucune cote récupérée — le modèle s'entraînera sans cotes.")
        return
    df = df.drop_duplicates(subset=["date", "home_team", "away_team"], keep="last")
    df.to_csv(f"{DATA_DIR}/odds.csv", index=False)
    print(f"   ✅ {len(df)} matchs avec cotes → odds.csv")


# ══════════════════════════════════════════════════════════════════════════════

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--only", choices=["spine", "moneypuck", "odds"], default=None)
    p.add_argument("--skip-skaters", action="store_true")
    p.add_argument("--from-local", action="store_true",
                   help="Lit les fichiers téléchargés manuellement dans data/raw/ "
                        "(all_teams.csv, goalies_*.zip, skaters_*.zip, odds/*.xlsx) "
                        "au lieu de les télécharger")
    args = p.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    t0 = time.time()
    if args.only in (None, "spine"):
        fetch_spine()   # api.nhle.com — toujours en ligne (pas bloqué)
    if args.only in (None, "moneypuck"):
        fetch_moneypuck(skip_skaters=args.skip_skaters, from_local=args.from_local)
    if args.only in (None, "odds"):
        fetch_odds(from_local=args.from_local)
    print(f"\n🏁 Terminé en {(time.time() - t0) / 60:.1f} min. "
          f"Prochaine étape : python build_dataset.py")


if __name__ == "__main__":
    main()
