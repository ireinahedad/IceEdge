"""
fetch_data_v4.py
================
Collecte v4 — 3 sources :
  1. Spine des matchs (scores officiels, SO inclus)  → api.nhle.com/stats/rest/en/game  (1 requête)
  2. Stats avancées MoneyPuck (xG, Corsi, gardiens, joueurs) → moneypuck.com (CSV/zips)
  3. Cotes historiques → deux sources, chacune tracée dans la colonne `source` :
       • sportsbookreviewsonline (SBRO)  2007-08 → 2022-23 — archive FIGÉE
       • The Odds API                    depuis 2020-06-29 — moneyline, puck
         line et totals, snapshots 5 min, clé dans ODDS_API_KEY

     SBRO ne publiera plus rien : sa page d'index annonce « NHL scores and odds
     archive will not be updated » (vérifié le 2026-08-04). Toute saison à
     partir de 2023-24 vient donc de The Odds API.

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

Backfill des cotes (The Odds API, plan 20K = 20 000 crédits/mois remis à zéro
le 1er) — calendrier et coûts dans ml/REFACTOR_PLAN.md §A1. Une plage par
mois, le 1er, jamais plus de ~10 000 crédits : la clé est partagée avec l'app.
    export ODDS_API_KEY=...          # PowerShell : $env:ODDS_API_KEY = '...'
    python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
        --odds-api-from 2023-10-10 --odds-api-to 2024-01-14 \
        --odds-api-budget 10000 --odds-api-keep 6000             # récupère

    Deux plafonds DURS : `--odds-api-budget` (ce que ce run dépense) et
    `--odds-api-keep` (ce qui doit rester au COMPTE pour l'app, défaut 6 000).
    Arrêté par l'un ou l'autre, relancer la MÊME commande le mois suivant : le
    cache rend les appels déjà payés gratuits.

    Livre : `draftkings` (décidé le 2026-09-27, sondage probe_odds_books.py) —
    le MÊME que ODDS_COLLECT_BOOKMAKERS côté serveur, sinon le CLV compare deux
    livres. `--from-local` est obligatoire : la partie SBRO ne se télécharge
    plus, et sans lui le garde-fou refuse d'écrire odds.csv.

Les snapshots sont mis en cache dans data/raw/odds/oddsapi/ : relancer la même
plage ne coûte plus rien. Faire d'abord une saison de RECOUVREMENT (2021-22 par
exemple, couverte par les deux sources) pour comparer avant d'étendre.

Ensuite : python build_dataset.py  puis  python train.py
"""

import argparse
import io
import json
import os
import sys
import time
import shutil
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
# Saison EN COURS, calculée (août → année courante). Elle valait 2025 en dur :
# la saison 2026-27 commencée, ses zips de gardiens et de patineurs n'étaient
# plus demandés. En cours de saison, préférer `refresh_data.py` (incrémental).
_now = time.gmtime()
LAST_SEASON  = _now.tm_year if _now.tm_mon >= 8 else _now.tm_year - 1

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
    """Lit les CSV d'un zip MoneyPuck en ne matérialisant que le nécessaire.

    **Le bug corrigé (2026-08-23) : `MemoryError` sur les zips de patineurs.**
    La version précédente faisait `pd.read_csv(f)` sur le fichier entier, PUIS
    filtrait `situation == "all"` et ne gardait que 13 colonnes. Or le
    game-by-game des patineurs 2008-2024 fait plus de 150 colonnes et des
    millions de lignes, toutes situations confondues : la trame large était
    intégralement construite en mémoire avant d'être réduite à ~8 % de sa
    taille. Sur une machine 64 bits ça finissait en
    « C error: out of memory », et le message ne disait pas que 92 % de ce qui
    était chargé allait être jeté à la ligne suivante.

    Ici les deux filtres descendent DANS la lecture : `usecols` ne décode que
    les colonnes retenues, et `chunksize` traite le fichier par tranches dont
    seules les lignes gardées s'accumulent. Le résultat est identique — mêmes
    lignes, mêmes colonnes, même ordre — mais le pic mémoire devient celui de
    la sortie, pas celui de l'entrée.
    """
    frames = []
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        for name in z.namelist():
            if not name.endswith(".csv"):
                continue
            # L'en-tête d'abord : `usecols` lève si on demande une colonne
            # absente, et les fichiers MoneyPuck n'ont pas tous le même schéma
            # selon la saison.
            with z.open(name) as f:
                header = pd.read_csv(f, nrows=0).columns.tolist()
            want = None
            if keep:
                want = [c for c in keep if c in header]
                if not want:
                    continue
                # `situation` doit être lue pour pouvoir filtrer, même si elle
                # n'est pas demandée dans `keep`.
                if situation and "situation" in header and "situation" not in want:
                    want.append("situation")
            with z.open(name) as f:
                parts = [
                    chunk[chunk["situation"] == situation]
                    if situation and "situation" in chunk.columns else chunk
                    for chunk in pd.read_csv(f, usecols=want, low_memory=False,
                                             chunksize=250_000)
                ]
            df = (pd.concat(parts, ignore_index=True) if parts
                  else pd.DataFrame(columns=want or header))
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
    # 2022-23 est la DERNIÈRE saison publiée. La page d'index annonce
    # elle-même « NHL scores and odds archive will not be updated » (vérifié le
    # 2026-08-04) et les slugs 2023-24 et suivants n'existent pas.
    #
    # Ce n'était donc jamais un blocage anti-script contournable en enregistrant
    # les pages depuis un navigateur : la donnée n'a pas été produite. Les
    # saisons 2023-24 → 2025-26 passent par The Odds API
    # (`--odds-api-from/--odds-api-to`, voir plus bas).
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

        # ── Prix des marchés dérivés ─────────────────────────────────────────
        # Sans eux, aucun ROI n'est calculable sur les totaux ni la puck line —
        # c'est-à-dire précisément les marchés que le modèle de score price le
        # mieux. La ligne visiteur porte le Over, la ligne domicile le Under
        # (convention vérifiée, cf. _parse_sbro_html).
        row["total_open_over"]   = _american_to_decimal(v.get("open ou price"))
        row["total_open_under"]  = _american_to_decimal(h.get("open ou price"))
        row["total_close_over"]  = _american_to_decimal(v.get("close ou price"))
        row["total_close_under"] = _american_to_decimal(h.get("close ou price"))

        # Puck line : la valeur portée par la ligne domicile est le handicap du
        # domicile (−1.5 s'il est favori, +1.5 sinon). Chaque camp a son prix.
        pl_home = h.get("puck line")
        row["puck_line_home"]  = (float(pl_home)
                                  if isinstance(pl_home, (int, float)) and pl_home == pl_home
                                  else None)
        row["pl_home_price"] = _american_to_decimal(h.get("pl price"))
        row["pl_away_price"] = _american_to_decimal(v.get("pl price"))
        # Provenance explicite : depuis que deux sources coexistent, toute
        # analyse doit pouvoir isoler l'une ou l'autre. Un ROI qui n'apparaît
        # que d'un côté de la jointure est un artefact de source, pas un edge.
        row["source"] = "sbro"
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

    Attention : la ligne d'en-tête ne nomme QUE 13 colonnes sur 16 — les
    cellules de prix sont vides dans le HTML, donc pandas complète par des
    `nan` en fin de ligne et l'en-tête se retrouve décalé par rapport aux
    données. Ne jamais se fier aux noms de colonnes ici, uniquement aux
    positions ci-dessus, vérifiées sur les données.

    Les prix (11, 13, 15) étaient auparavant lus puis jetés : seules les lignes
    étaient conservées. C'est ce qui rendait le ROI des marchés dérivés
    impossible à mesurer, alors que la donnée était déjà sur le disque.

    Convention Over/Under, **vérifiée empiriquement** sur 9 061 matchs (push
    exclus) : la ligne VISITEUR porte le prix du Over, la ligne DOMICILE celui
    du Under. Log-loss 0.69086 dans ce sens contre 0.69978 dans l'autre, pour
    une constante à 0.69314 — seul le bon sens bat le taux de base.
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
            # Prix des marchés dérivés — en cotes américaines à ce stade.
            "puck line":    num(vals[10]), "pl price":       num(vals[11]),
            "open ou price": num(vals[13]), "close ou price": num(vals[15]),
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


# ── Chargeur de CSV tiers — SUPPRIMÉ (S5) ────────────────────────────────────
#
# `_load_local_odds_csv()` avalait n'importe quel CSV déposé dans
# `data/raw/odds/`, en devinant les noms de colonnes par une table d'alias. Le
# principal candidat — le dataset ESPN/Kaggle « NHL Full Game & Betting
# Statistics » — a des colonnes de paris FACTICES : chaque match de 2004 à
# 2018 y porte `favorite_moneyline -105`, `over_under 5.5`, `spread -1.5`.
# Les deux scripts qui l'écrivaient dans ce dossier (`download_dataset.py`,
# `build_dataset_extra.py`) ont été supprimés le 2026-08-10.
#
# Un chargeur tolérant qui absorbe en silence une source connue fausse n'est pas
# une commodité : il fabrique des cotes constantes sur 14 saisons, donc un ROI
# qui ne mesure plus rien. Et rien dans `odds.csv` ne le signalerait — la
# colonne `source` était même absente de ce chemin.
#
# Les sources restantes sont nommées et vérifiées : archives SBRO (xlsx/html,
# ≤ 2022-23), The Odds API (historique et log live). Ajouter une source se fait
# désormais explicitement, avec sa propre valeur de `source`.


# ══════════════════════════════════════════════════════════════════════════════
# Source de remplacement : The Odds API (historique)
#
# L'archive SBRO s'arrête à 2022-23 et la page l'annonce elle-même : « NHL
# scores and odds archive will not be updated » (vérifié le 2026-08-04). Ce
# n'est donc pas un blocage anti-script contournable en enregistrant les pages
# à la main — la donnée n'existe pas. Les saisons 2023-24 et suivantes doivent
# venir d'ailleurs.
#
# The Odds API couvre la NHL depuis le 2020-06-29 avec moneyline, spreads
# (puck line) ET totals, en snapshots de 5 minutes. Le recouvrement 2020-2023
# avec SBRO est le vrai intérêt : il permet de vérifier qu'un résultat obtenu
# sur SBRO se reproduit sur un autre bookmaker AVANT d'étendre la série. Deux
# époques, deux books, un ROI qui n'existe que de part et d'autre de la
# jointure : c'est la façon la plus banale de fabriquer un faux edge.
# ══════════════════════════════════════════════════════════════════════════════

ODDS_API_BASE = "https://api.the-odds-api.com/v4"
ODDS_API_SPORT = "icehockey_nhl"
ODDS_API_CACHE = f"{RAW_DIR}/odds/oddsapi"

# The Odds API rend les noms complets. Table alignée sur `NAME_TO_ABBR` de
# server/src/services/oddsLogger.service.ts — les deux doivent rester d'accord.
ODDS_API_TEAMS = {
    "anaheim ducks": "ANA", "arizona coyotes": "UTA", "utah hockey club": "UTA",
    "utah mammoth": "UTA", "boston bruins": "BOS", "buffalo sabres": "BUF",
    "calgary flames": "CGY", "carolina hurricanes": "CAR",
    "chicago blackhawks": "CHI", "colorado avalanche": "COL",
    "columbus blue jackets": "CBJ", "dallas stars": "DAL",
    "detroit red wings": "DET", "edmonton oilers": "EDM",
    "florida panthers": "FLA", "los angeles kings": "LAK",
    "minnesota wild": "MIN", "montreal canadiens": "MTL",
    "montréal canadiens": "MTL", "nashville predators": "NSH",
    "new jersey devils": "NJD", "new york islanders": "NYI",
    "new york rangers": "NYR", "ottawa senators": "OTT",
    "philadelphia flyers": "PHI", "pittsburgh penguins": "PIT",
    "san jose sharks": "SJS", "seattle kraken": "SEA", "st louis blues": "STL",
    "st. louis blues": "STL", "tampa bay lightning": "TBL",
    "toronto maple leafs": "TOR", "vancouver canucks": "VAN",
    "vegas golden knights": "VGK", "washington capitals": "WSH",
    "winnipeg jets": "WPG",
}


def _oddsapi_team(name) -> str | None:
    return ODDS_API_TEAMS.get(str(name).strip().lower())


def _oddsapi_game_date(commence_time: str) -> str | None:
    """Date LOCALE du match à partir du `commence_time` en UTC.

    Piège qui a coûté un premier jet entièrement vide : un match de 19 h à
    l'Est est à 00:00Z **le lendemain**. Découper sur la date UTC écarterait la
    quasi-totalité du calendrier, et silencieusement — le fichier serait
    simplement plus petit que prévu.

    Toutes les équipes NHL jouent entre l'heure de l'Est et celle du
    Pacifique : retirer 8 heures ramène tout coup d'envoi du soir sur sa date
    locale, et laisse les matinées (13 h à l'Est = 18:00Z) sur la leur. C'est
    la date qu'utilise `games_spine.csv`, donc celle sur laquelle la jointure
    de `build_dataset.py` se fait.
    """
    try:
        return (pd.Timestamp(commence_time) - pd.Timedelta(hours=8)).strftime("%Y-%m-%d")
    except Exception:
        return None


def _oddsapi_key() -> str | None:
    """Clé lue dans l'environnement, jamais dans le code ni sur le disque."""
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        print("   ❌ ODDS_API_KEY absente de l'environnement.")
        # `cmd.exe` d'abord : c'est l'invite par défaut sous Windows, et sa
        # syntaxe n'est ni celle de PowerShell ni celle de bash.
        print("      cmd.exe    : set ODDS_API_KEY=ta-cle")
        print("      PowerShell : $env:ODDS_API_KEY = 'ta-cle'")
        print("      bash       : export ODDS_API_KEY=ta-cle")
        print("      La variable ne vaut que pour CETTE fenêtre — c'est "
              "voulu : la clé\n      ne doit vivre ni dans le code ni sur le "
              "disque.")
        return None
    return key


# Coût d'un appel, en crédits : 10 par marché et par région pour l'endpoint
# HISTORIQUE, contre 1 par marché et par région pour l'endpoint live. Un
# paramètre `bookmakers` compte comme une région par tranche de 10 livres.
#
# Marchés par défaut depuis le 2026-09-27 : h2h + spreads, SANS les totaux.
# Les totaux sont clos pour de bon (CLV sous leur propre placebo, 2026-08-23) :
# les payer coûtait un tiers du backfill (66 630 → ~44 400 crédits) pour une
# donnée qu'aucune stratégie ne lit. `--odds-api-markets` les remet au besoin.
ODDS_API_MARKETS_DEFAULT = "h2h,spreads"
ODDS_API_HIST_COST = 10 * 2      # recalculé par `_set_hist_cost` à chaque run

# Réserve laissée au SOLDE DU COMPTE (2026-10-04). Le backfill partage la clé de
# l'app : le proxy d'affichage (~3 crédits / 30 min de trafic, jusqu'à ~4 300
# par mois) et la collecte live (~300 par mois) puisent dans les mêmes 20 000
# crédits mensuels. `--odds-api-budget` plafonne ce que CE run dépense, pas ce
# qui reste au compte : sans réserve, un backfill lancé le 20 du mois pouvait
# vider le solde et couper les cotes de l'app jusqu'au 1er. Le run s'arrête dès
# que le solde réel (`x-requests-remaining`) ne couvrirait plus un appel de
# plus AU-DESSUS de cette réserve. `--odds-api-keep` la change.
ODDS_API_KEEP_DEFAULT = 6000
ODDS_API_KEEP = ODDS_API_KEEP_DEFAULT


def _set_hist_cost(markets: str, regions: str, book: str | None) -> int:
    """Fixe le coût d'un appel historique pour ce run, et le rend.

    Une constante module est gardée (et non un paramètre de plus partout) parce
    que trois endroits la lisent : le garde-fou de solde de `_oddsapi_get`, le
    budget de `fetch_odds_api` et le chiffrage `--dry-run`. Un coût faux dans
    l'un d'eux ferait dépasser `--odds-api-budget` sans prévenir.
    """
    global ODDS_API_HIST_COST
    n_mk = len([m for m in markets.split(",") if m.strip()])
    if book:
        n_sel = -(-len([b for b in book.split(",") if b.strip()]) // 10)
    else:
        n_sel = len([r for r in regions.split(",") if r.strip()])
    ODDS_API_HIST_COST = 10 * max(n_mk, 1) * max(n_sel, 1)
    return ODDS_API_HIST_COST


class _OddsApiStop(Exception):
    """Budget épuisé, ou l'offre ne donne pas accès à l'historique."""


def _oddsapi_get(path: str, params: dict, key: str) -> dict | list | None:
    """Appel authentifié. La clé n'apparaît jamais dans un message d'erreur."""
    # Arrêt décidé sur la réponse PRÉCÉDENTE (solde sous la réserve) : levé
    # AVANT l'appel suivant, jamais après un appel payé — sinon la réponse
    # déjà facturée était jetée sans passer par le cache.
    stop = getattr(_oddsapi_get, "stop_next", None)
    if stop:
        raise _OddsApiStop(stop)
    url = f"{ODDS_API_BASE}{path}"
    try:
        r = SESSION.get(url, params={**params, "apiKey": key}, timeout=60)
    except Exception as e:
        print(f"   [WARN] {path} → {e}")
        return None
    if r.status_code == 401:
        print("   ❌ 401 — clé refusée.")
        raise _OddsApiStop("clé refusée")
    if r.status_code in (403, 429):
        # 403 = l'offre ne couvre pas l'endpoint (l'historique est exclu du
        # plan gratuit) ; 429 = quota épuisé. Dans les deux cas, insister ne
        # ferait que répéter le même refus — on arrête net.
        print(f"   ❌ HTTP {r.status_code} — accès refusé à {path}.")
        print("      L'endpoint /historical/ n'est pas servi aux clés "
              "gratuites : il faut un plan payant.")
        raise _OddsApiStop(f"HTTP {r.status_code}")
    if r.status_code == 422:
        # Hors de la fenêtre historique du fournisseur : normal en bord de plage.
        return None
    if r.status_code != 200:
        print(f"   [WARN] {path} → HTTP {r.status_code}")
        return None
    remaining = r.headers.get("x-requests-remaining")
    if remaining is not None:
        _oddsapi_get.remaining = remaining
        try:
            # Garde-fou côté fournisseur : si le solde réel ne couvre plus un
            # appel AU-DESSUS de la réserve de l'app (`ODDS_API_KEEP`), on
            # s'arrête sans attendre le prochain refus. Ce qui a été récupéré
            # est gardé, et le cache rend la reprise gratuite.
            if float(remaining) - ODDS_API_HIST_COST < ODDS_API_KEEP:
                print(f"   ⛔ solde du compte {remaining} : un appel de plus "
                      f"({ODDS_API_HIST_COST}) entamerait la réserve de l'app "
                      f"({ODDS_API_KEEP}). Reprendre le mois prochain, même commande.")
                _oddsapi_get.stop_next = "réserve du compte atteinte"
        except (TypeError, ValueError):
            pass
    try:
        return r.json()
    except ValueError:
        return None


def _oddsapi_cache_path(ts: str, regions: str,
                        markets: str = "h2h,spreads,totals",
                        book: str | None = None) -> str:
    """Chemin du snapshot en cache.

    Le nom porte TOUT ce qui change le contenu de la réponse : sélection des
    livres et marchés. Sans ça, un snapshot pris avec `bookmakers=draftkings`
    serait resservi à un run qui demande `regions=eu` — un prix du mauvais
    livre, gratuit, et invisible. L'ancien nom (`<regions>_<ts>`, trois marchés,
    sans livre) est conservé tel quel pour ne pas perdre un cache déjà payé.
    """
    stamp = ts.replace(':', '').replace('-', '')
    if not book and markets == "h2h,spreads,totals":
        return f"{ODDS_API_CACHE}/{regions}_{stamp}.json"
    sel = f"bk-{book.replace(',', '+')}" if book else regions.replace(',', '+')
    return f"{ODDS_API_CACHE}/{sel}_{markets.replace(',', '+')}_{stamp}.json"


def _oddsapi_snapshot(ts: str, key: str, regions: str, use_cache: bool = True,
                      markets: str = ODDS_API_MARKETS_DEFAULT,
                      book: str | None = None):
    """Un snapshot horodaté, mis en cache sur disque.

    Le cache n'est pas une optimisation de confort : chaque appel historique
    coûte 10 crédits par marché et par région, donc de l'argent. Un `build`
    relancé ne doit jamais repayer une donnée déjà obtenue — l'historique est
    immuable par construction.
    """
    os.makedirs(ODDS_API_CACHE, exist_ok=True)
    path = _oddsapi_cache_path(ts, regions, markets, book)
    if use_cache and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    data = _oddsapi_get(
        f"/historical/sports/{ODDS_API_SPORT}/odds",
        # Un livre nommé part en `bookmakers` (The Odds API ignore alors
        # `regions`) : la réponse ne contient que lui, même coût.
        {**({"bookmakers": book} if book else {"regions": regions}),
         "markets": markets, "oddsFormat": "decimal", "date": ts}, key)
    if data is None:
        return None
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except Exception as e:
        print(f"   [WARN] cache non écrit ({e})")
    return data


def _pick_book(event: dict, book: str | None) -> dict | None:
    """Le bookmaker retenu pour un événement.

    Un book **nommé** est préférable à un consensus : la marge et la convention
    de prix diffèrent d'un opérateur à l'autre, et mélanger les books d'un match
    à l'autre introduit une variation qui n'a rien à voir avec le hockey. Sans
    préférence, on prend le premier disponible et on le trace dans `source`.
    """
    books = event.get("bookmakers") or []
    if not books:
        return None
    if book:
        for b in books:
            if b.get("key") == book:
                return b
        return None
    return books[0]


def _oddsapi_row(event: dict, bk: dict) -> dict | None:
    """Un événement + un bookmaker → une ligne au schéma d'odds.csv."""
    home = _oddsapi_team(event.get("home_team"))
    away = _oddsapi_team(event.get("away_team"))
    date = _oddsapi_game_date(str(event.get("commence_time") or ""))
    if not home or not away or not date:
        return None

    markets = {m.get("key"): m for m in (bk.get("markets") or [])}
    row = {"date": date, "home_team": home, "away_team": away,
           "source": f"oddsapi:{bk.get('key')}"}

    def price(outcomes, name):
        for o in outcomes or []:
            if o.get("name") == name:
                return o.get("price"), o.get("point")
        return None, None

    h2h = markets.get("h2h", {}).get("outcomes")
    row["home_ml_close"], _ = price(h2h, event.get("home_team"))
    row["away_ml_close"], _ = price(h2h, event.get("away_team"))

    # Totaux : le point est identique des deux côtés, le prix ne l'est pas.
    tot = markets.get("totals", {}).get("outcomes")
    o_px, o_pt = price(tot, "Over")
    u_px, u_pt = price(tot, "Under")
    row["total_close"] = o_pt if o_pt is not None else u_pt
    row["total_close_over"] = o_px
    row["total_close_under"] = u_px

    # Puck line : `point` du côté domicile = son handicap (−1.5 favori, +1.5
    # sinon). Le backtest ne retient que |1.5| ; les lignes alternatives (±2.5)
    # sont écartées ici pour ne pas mélanger deux marchés dans une colonne.
    sp = markets.get("spreads", {}).get("outcomes")
    h_px, h_pt = price(sp, event.get("home_team"))
    a_px, _ = price(sp, event.get("away_team"))
    if h_pt is not None and abs(abs(float(h_pt)) - 1.5) < 1e-9:
        row["puck_line_home"] = float(h_pt)
        row["pl_home_price"] = h_px
        row["pl_away_price"] = a_px

    # `*_open` reste vide : un snapshot pré-match n'est pas une cote
    # d'ouverture, et remplir la colonne avec « le premier snapshot du jour »
    # lui donnerait une sémantique différente de celle des lignes SBRO.
    # Une colonne à moitié fausse est pire qu'une colonne absente.
    #
    # Ce que le CLV réclame ne passe donc PAS par cette colonne : les snapshots
    # intermédiaires partent dans `odds_snapshots_hist.csv`, horodatés, où leur
    # sémantique est explicite. Voir `_oddsapi_snapshot_row`.
    return row if row["home_ml_close"] and row["away_ml_close"] else None


# ── La série temporelle historique — même correctif que côté serveur ─────────
#
# LE MÊME GASPILLAGE, DES DEUX CÔTÉS DU PIPELINE. `oddsLogger.service.ts`
# appelait l'API toutes les 6 h et écrasait `*_close` à chaque passe : les
# observations intermédiaires étaient perdues. Ici, `fetch_odds_api` visite
# déjà ~4 snapshots par journée de match — un de reconnaissance à 15:30Z, puis
# un juste avant chaque heure de coup d'envoi — et **ne garde que le dernier**.
# Les autres sont téléchargés, payés, puis jetés.
#
# Or c'est exactement la matière du CLV : « quel prix était affiché à tel
# instant, et où la ligne a-t-elle fini ? ». Les conserver ne coûte **aucun
# crédit de plus** — les appels ont lieu de toute façon.
#
# POURQUOI UN FICHIER SÉPARÉ ET NON LES COLONNES `*_open` D'`odds.csv`. Parce
# que la remarque ci-dessus est juste : « le prix à 15:30Z » n'est pas « la
# cote d'ouverture » de SBRO. Les mélanger dans une même colonne fabriquerait
# un CLV qui compare deux choses différentes selon la source de la ligne, sans
# que rien ne le signale. Ici chaque enregistrement porte son horodatage : la
# sémantique est dans la donnée, pas dans une convention implicite.
#
# Le schéma est celui de la table `odds_snapshots` (migration 031), pour que la
# collecte live et le backfill historique produisent la même forme.

SNAPSHOTS_HIST = f"{DATA_DIR}/odds_snapshots_hist.csv"

SNAPSHOT_COLS = ["game_date", "home_team", "away_team", "observed_at",
                 "commence_time", "markets", "home_ml", "away_ml", "total",
                 "total_over", "total_under", "puck_line_home",
                 "pl_home_price", "pl_away_price", "source"]


def _oddsapi_snapshot_row(event: dict, bk: dict, snap_ts: str) -> dict | None:
    """Un événement observé à un instant donné → une ligne de série temporelle."""
    home = _oddsapi_team(event.get("home_team"))
    away = _oddsapi_team(event.get("away_team"))
    ct = str(event.get("commence_time") or "")
    date = _oddsapi_game_date(ct)
    if not home or not away or not date:
        return None

    markets = {m.get("key"): m for m in (bk.get("markets") or [])}

    def price(outcomes, name):
        for o in outcomes or []:
            if o.get("name") == name:
                return o.get("price"), o.get("point")
        return None, None

    row = {"game_date": date, "home_team": home, "away_team": away,
           "observed_at": snap_ts, "commence_time": ct,
           "markets": "+".join(sorted(markets)) or "none",
           "source": f"oddsapi:{bk.get('key')}"}

    h2h = markets.get("h2h", {}).get("outcomes")
    row["home_ml"], _ = price(h2h, event.get("home_team"))
    row["away_ml"], _ = price(h2h, event.get("away_team"))

    tot = markets.get("totals", {}).get("outcomes")
    o_px, o_pt = price(tot, "Over")
    u_px, u_pt = price(tot, "Under")
    row["total"] = o_pt if o_pt is not None else u_pt
    row["total_over"] = o_px
    row["total_under"] = u_px

    sp = markets.get("spreads", {}).get("outcomes")
    h_px, h_pt = price(sp, event.get("home_team"))
    a_px, _ = price(sp, event.get("away_team"))
    # Même règle que partout : seule la ligne standard ±1.5. Une alternative
    # (±2.5) dans la même colonne rendrait le règlement ambigu au backtest.
    if h_pt is not None and abs(abs(float(h_pt)) - 1.5) < 1e-9:
        row["puck_line_home"] = float(h_pt)
        row["pl_home_price"] = h_px
        row["pl_away_price"] = a_px

    # Une observation sans aucun prix n'apprend rien.
    if row["home_ml"] is None and row["total"] is None \
            and row.get("pl_home_price") is None:
        return None
    return row


def fetch_odds_api(start: str, end: str, book: str | None, regions: str,
                   dry_run: bool = False, use_cache: bool = True,
                   budget: int | None = None,
                   markets: str = ODDS_API_MARKETS_DEFAULT,
                   close_window_min: int = 60) -> list[dict]:
    """Historique The Odds API entre deux dates (AAAA-MM-JJ incluses).

    **Comment on approxime la cote de clôture.** Un snapshot renvoie tous les
    matchs pas encore commencés, chacun avec son `commence_time`. Pour chaque
    journée on tire donc un premier snapshot avant la première mise au jeu —
    il découvre le programme — puis un snapshot juste avant chaque heure de
    début distincte. Chaque match retient le dernier snapshot antérieur à SON
    propre coup d'envoi. Une soirée NHL a 2 à 4 heures de début distinctes,
    d'où ~4 appels par jour.

    **Coût, recalculé le 2026-08-23 aux tarifs du fournisseur.** 10 crédits
    par marché et par région : avec h2h + spreads + totals sur une région,
    **30 crédits par appel**, ~4 appels par jour de match, donc ~120 crédits la
    journée. Une saison NHL compte ~186 jours de match → **~22 000 crédits la
    saison**, ~67 000 pour les trois saisons que SBRO ne couvre pas
    (2023-24 → 2025-26). `--dry-run` chiffre avant de dépenser sur la plage de
    dates demandée, `budget` impose un plafond dur.

    **Ces appels servent deux fois.** Le dernier snapshot avant chaque coup
    d'envoi alimente `odds.csv` (la clôture) ; **tous** les snapshots partent
    dans `odds_snapshots_hist.csv`, la série temporelle du CLV. Le second
    fichier ne coûte pas un crédit de plus — ces observations étaient
    téléchargées, payées, puis jetées.

    **Le budget n'est pas une commodité.** Les crédits sont de l'argent et une
    plage de dates un peu large les consomme silencieusement. Trois barrières
    indépendantes : le plafond demandé, le solde réel renvoyé par le
    fournisseur (`x-requests-remaining`), et le cache disque qui rend toute
    reprise gratuite. Un appel servi par le cache ne coûte rien et n'est donc
    pas décompté.
    """
    _set_hist_cost(markets, regions, book)
    key = None if dry_run else _oddsapi_key()
    if key is None and not dry_run:
        return []

    days = pd.date_range(start, end, freq="D")
    if dry_run:
        n = len(days) * 4
        print(f"   Estimation : {len(days)} jours × ~4 appels × "
              f"{ODDS_API_HIST_COST} crédits = ~{n * ODDS_API_HIST_COST:,} crédits")
        print(f"   Borne haute : les jours SANS match ne coûtent qu'un appel. "
              f"Sur une saison\n   complète, compter plutôt ~186 jours de match, "
              f"soit ~{186 * 4 * ODDS_API_HIST_COST:,} crédits.")
        print(f"   (les jours sans match coûtent {ODDS_API_HIST_COST} au lieu "
              f"de {4 * ODDS_API_HIST_COST} — c'est une borne haute)")
        if budget:
            reach = budget // ODDS_API_HIST_COST
            print(f"   Avec un budget de {budget:,} crédits : ~{reach} appels, "
                  f"soit ~{reach // 4} jours de match couverts.")
        return []

    best: dict[str, tuple[str, dict, dict]] = {}   # id → (ts, event, bookmaker)
    # Toutes les observations, et pas seulement la dernière : c'est la série
    # temporelle du CLV, et elle ne coûte rien de plus (cf. le commentaire de
    # `_oddsapi_snapshot_row`). Clé (id, horodatage) pour l'idempotence — un
    # snapshot servi par le cache lors d'une reprise ne doit pas se dupliquer.
    snaps: dict[tuple, dict] = {}
    n_calls = spent = 0
    stopped = None
    for day in days:
        d = day.strftime("%Y-%m-%d")
        # Reconnaissance à 15:30Z (10h30 à l'Est) : AVANT tout coup d'envoi, y
        # compris les matinées de week-end. Un snapshot plus tardif serait
        # meilleur marché en prix mais raterait purement et simplement les
        # matchs déjà commencés. Ce premier appel ne sert qu'à découvrir le
        # programme et les heures de début ; les prix viennent des snapshots de
        # clôture programmés juste après.
        pending = [f"{d}T15:30:00Z"]
        seen_ts, day_rows = set(), 0
        while pending:
            ts = pending.pop(0)
            if ts in seen_ts:
                continue
            seen_ts.add(ts)
            # Un snapshot déjà en cache ne coûte rien : on ne le décompte pas
            # du budget, sinon une simple reprise le consommerait à vide.
            cached = _oddsapi_cache_path(ts, regions, markets, book)
            billable = not (use_cache and os.path.exists(cached))
            if billable and budget is not None and spent + ODDS_API_HIST_COST > budget:
                stopped = f"budget atteint ({spent}/{budget} crédits)"
                break
            try:
                snap = _oddsapi_snapshot(ts, key, regions, use_cache,
                                         markets, book)
            except _OddsApiStop as e:
                stopped = str(e)
                break
            n_calls += 1
            if billable:
                spent += ODDS_API_HIST_COST
            if not snap:
                continue
            snap_ts = str(snap.get("timestamp") or ts)
            # Par heure de début croissante : le regroupement des clôtures
            # (plus bas) doit voir le match le plus TÔT d'abord, sinon il
            # garderait la mauvaise heure du groupe selon l'ordre du flux.
            for ev in sorted(snap.get("data") or [],
                             key=lambda e: str(e.get("commence_time") or "")):
                ct = str(ev.get("commence_time") or "")
                if ct <= snap_ts:
                    continue                        # match déjà commencé
                if _oddsapi_game_date(ct) != d:
                    continue                        # autre journée de calendrier
                bk = _pick_book(ev, book)
                if bk is None:
                    continue
                gid = str(ev.get("id"))
                if gid not in best or snap_ts > best[gid][0]:
                    best[gid] = (snap_ts, ev, bk)
                    day_rows += 1
                sr = _oddsapi_snapshot_row(ev, bk, snap_ts)
                if sr is not None:
                    snaps[(gid, snap_ts)] = sr
                # Programme un snapshot juste avant CE coup d'envoi…
                close_ts = (pd.Timestamp(ct) - pd.Timedelta(minutes=8)) \
                    .strftime("%Y-%m-%dT%H:%M:%SZ")
                if close_ts <= snap_ts or close_ts in seen_ts or close_ts in pending:
                    continue
                # … SAUF si un snapshot déjà pris ou prévu tombe dans les
                # `close_window_min` minutes qui précèdent (décision du user,
                # 2026-09-27). Une soirée à 19 h, 19 h 30, 22 h, 22 h 30 coûte
                # alors 2 appels de clôture au lieu de 4 ; le match de 19 h 30
                # prend sa « clôture » à 18 h 52. Le prix de ~1/3 des crédits :
                # une clôture jusqu'à une heure trop tôt pour certains matchs —
                # mesurable, puisque chaque observation garde `observed_at` et
                # `commence_time` dans `odds_snapshots_hist.csv`.
                #
                # Un snapshot DÉJÀ EN CACHE ne coûte rien : on le reprend
                # toujours, pour ne pas dégrader les jours backfillés avant le
                # regroupement.
                cached_free = use_cache and os.path.exists(
                    _oddsapi_cache_path(close_ts, regions, markets, book))
                if close_window_min > 0 and not cached_free:
                    lo = (pd.Timestamp(close_ts)
                          - pd.Timedelta(minutes=close_window_min)) \
                        .strftime("%Y-%m-%dT%H:%M:%SZ")
                    if any(lo <= t <= close_ts for t in (*seen_ts, *pending)):
                        continue
                pending.append(close_ts)
            pending.sort()
        if day_rows:
            print(f"   {d}: {day_rows} maj  ({n_calls} appels, {spent} crédits)",
                  end="\r")
        if stopped:
            print(f"\n   ⛔ arrêt : {stopped}")
            print(f"      Les {len(best)} matchs déjà obtenus sont conservés, "
                  f"et le cache évitera de les repayer.")
            break

    rows = [r for r in (_oddsapi_row(ev, bk) for _, ev, bk in best.values())
            if r is not None]
    _write_snapshots(list(snaps.values()))
    rem = getattr(_oddsapi_get, "remaining", "?")
    print(f"\n   The Odds API : {len(rows)} matchs, {len(snaps)} observations, "
          f"{n_calls} appels, {spent} crédits dépensés, restants {rem}")
    return rows


def _write_snapshots(rows: list[dict]) -> None:
    """Fusionne les observations dans `odds_snapshots_hist.csv`.

    **Fusion et non écrasement** : une reprise après un arrêt sur budget ne doit
    pas effacer ce que la passe précédente avait obtenu. La clé
    (match, horodatage) porte l'idempotence, comme la clé primaire de la table
    `odds_snapshots` côté serveur.
    """
    if not rows:
        return
    df = pd.DataFrame(rows)
    for c in SNAPSHOT_COLS:
        if c not in df.columns:
            df[c] = None
    df = df[SNAPSHOT_COLS]
    if os.path.exists(SNAPSHOTS_HIST):
        try:
            old = pd.read_csv(SNAPSHOTS_HIST)
            df = pd.concat([old, df], ignore_index=True)
        except Exception as e:
            print(f"   ⚠️  {SNAPSHOTS_HIST} illisible ({e}) — non fusionné, "
                  f"l'ancien fichier est conservé sous .bak")
            try:
                os.replace(SNAPSHOTS_HIST, SNAPSHOTS_HIST + ".bak")
            except OSError:
                pass
    # `source` dans la clé : deux livres observés à la même passe sont deux
    # observations (collecte parallèle, 2026-10-04), pas un doublon.
    df = df.drop_duplicates(subset=["game_date", "home_team", "away_team",
                                    "observed_at", "source"], keep="last")
    df = df.sort_values(["game_date", "home_team", "observed_at"])
    df.to_csv(SNAPSHOTS_HIST, index=False)
    n_games = df.groupby(["game_date", "home_team", "away_team"]).ngroups
    per = len(df) / n_games if n_games else 0
    print(f"\n   📈 {SNAPSHOTS_HIST} : {len(df):,} observations sur "
          f"{n_games:,} matchs ({per:.1f} par match)")


def _write_odds_csv(df: pd.DataFrame, allow_shrink: bool = False) -> bool:
    """Écrit `odds.csv` — mais refuse de le faire rétrécir sans autorisation.

    **POURQUOI CE GARDE-FOU EXISTE (2026-08-23).** `odds.csv` est
    IRREMPLAÇABLE : l'archive SBRO s'arrête à 2022-23, sa page d'index annonce
    qu'elle ne sera plus mise à jour, et le site est aujourd'hui injoignable.
    Ce qui a été parsé ne se re-télécharge pas.

    Or `fetch_odds` réécrit le fichier à chaque exécution, et son seul garde-fou
    était `if df.empty: return`. Il ne protège que du cas total. Le cas partiel
    — SBRO injoignable, pas de clé API, mais `odds_live_log.csv` présent avec
    quelques dizaines de lignes — produit un `df` NON vide, et **10 592 lignes
    d'historique sont alors remplacées par une poignée**, silencieusement, avec
    un ✅ dans la sortie.

    Ce scénario a failli se produire le 2026-08-23 : commande lancée sans
    `--from-local` (SBRO a échoué en réseau) et sans `ODDS_API_KEY`. Seul le
    hasard du contenu de `odds_live_log.csv` a évité la perte.

    La règle : un fichier qui rétrécit de plus de 10 % est refusé. C'est le
    signe d'une source manquante, pas d'une intention. `--allow-shrink` force,
    et une sauvegarde `.bak` est posée dans tous les cas.
    """
    path = f"{DATA_DIR}/odds.csv"
    if os.path.exists(path):
        try:
            n_old = len(pd.read_csv(path, usecols=[0]))
        except Exception:
            n_old = 0
        if n_old and len(df) < n_old * 0.9 and not allow_shrink:
            print(f"\n   ⛔ ÉCRITURE REFUSÉE — {len(df)} lignes contre "
                  f"{n_old} existantes ({len(df) / n_old:.0%}).")
            print("      `odds.csv` est irremplaçable : SBRO ne sera plus mis à "
                  "jour et le site\n      est injoignable. Un tel écart signale "
                  "une source absente, pas une intention.")
            print("      Causes probables : `--from-local` oublié (SBRO se "
                  "scrape alors en ligne\n      et échoue), ou ODDS_API_KEY "
                  "absente.")
            print("      Le fichier existant est INTACT. Pour forcer malgré "
                  "tout : --allow-shrink")
            return False
        if n_old:
            try:
                shutil.copyfile(path, path + ".bak")
            except OSError as e:
                print(f"   ⚠️  sauvegarde .bak impossible ({e})")
    df.to_csv(path, index=False)
    return True


# Marge admissible d'une paire à DEUX issues : 1/c_dom + 1/c_ext. Même borne
# que le collecteur (`oddsLogger.service.ts`, `TWO_WAY_OVERROUND`, 2026-10-12).
# Le log live de la saison 2026-27 contenait des paires à 0.79-0.88 (marché
# « 60 minutes » à trois issues ou livres mélangés) : dévigées, elles donnaient
# une probabilité fausse dans `market_home_p_*`. Ceinture et bretelles : le
# serveur ne les écrit plus et `npm run odds:repair` nettoie la base, mais un
# vieil export ne doit pas pouvoir les réintroduire.
TWO_WAY_OVERROUND = (1.00, 1.12)
_PAIRS = [("home_ml_open", "away_ml_open"), ("home_ml_close", "away_ml_close"),
          ("total_open_over", "total_open_under"), ("total_close_over", "total_close_under"),
          ("pl_home_price", "pl_away_price")]


def _drop_implausible_pairs(live: pd.DataFrame) -> pd.DataFrame:
    """Met à NaN les paires de prix du log live dont la marge est impossible."""
    live = live.copy()
    dropped = {}
    for a, b in _PAIRS:
        if a not in live.columns or b not in live.columns:
            continue
        o = 1 / pd.to_numeric(live[a], errors="coerce") + 1 / pd.to_numeric(live[b], errors="coerce")
        bad = o.notna() & ~o.between(*TWO_WAY_OVERROUND)
        if bad.any():
            live.loc[bad, [a, b]] = float("nan")
            dropped[a.replace("home_", "").replace("_over", "")] = int(bad.sum())
    if dropped:
        print("   ⚠️  log live : paires de prix impossibles écartées (marge hors "
              f"[{TWO_WAY_OVERROUND[0]:.2f}, {TWO_WAY_OVERROUND[1]:.2f}]) — "
              + ", ".join(f"{k} {v}" for k, v in dropped.items()))
    return live


def fetch_odds(from_local: bool = False, api_range: tuple | None = None,
               book: str | None = None, regions: str = "us",
               dry_run: bool = False, api_cache: bool = True,
               budget: int | None = None, allow_shrink: bool = False,
               markets: str = ODDS_API_MARKETS_DEFAULT,
               close_window_min: int = 60) -> None:
    print("💰 Cotes historiques (sportsbookreviewsonline) …")
    all_rows = []

    # ── Les lignes The Odds API DÉJÀ dans odds.csv sont reprises ─────────────
    #
    # LE BUG QUE ÇA CORRIGE (2026-09-27). Le fichier était reconstruit à partir
    # des SEULES dates du run en cours : backfiller mars-avril 2026 a remplacé
    # les 951 matchs d'octobre-février par les 394 de mars-avril. La baisse
    # (−4,8 %) passait sous le garde-fou des 10 %. Un simple `--from-local`
    # sans plage API aurait même effacé TOUTES les lignes backfillées — des
    # crédits payés. Les lignes `oddsapi:<livre>` existantes sont donc reprises
    # en tête : un run qui re-récupère le même match l'écrase (`keep="last"`),
    # les autres restent. `oddsapi:live` n'est pas repris ici : il est relu
    # depuis `odds_live_log.csv` plus bas.
    odds_csv = f"{DATA_DIR}/odds.csv"
    if os.path.exists(odds_csv):
        try:
            prev = pd.read_csv(odds_csv)
            src = prev.get("source", pd.Series(dtype=str)).astype(str)
            keep = prev[src.str.startswith("oddsapi:") & (src != "oddsapi:live")]
            if len(keep):
                all_rows.extend(keep.to_dict("records"))
                print(f"   ↺ {len(keep)} lignes The Odds API déjà présentes, reprises")
        except Exception as e:
            print(f"   [WARN] odds.csv illisible, lignes API non reprises ({e})")

    # The Odds API — seule source pour 2023-24 et au-delà (SBRO s'arrête à
    # 2022-23 et ne sera plus mis à jour). Traité en premier pour que le
    # `drop_duplicates(keep="last")` en fin de fonction laisse SBRO gagner sur
    # les saisons de recouvrement : tant que la comparaison des deux sources
    # n'est pas faite, la série historique reste homogène.
    if api_range or dry_run:
        s, e = api_range or ("2023-10-01", "2024-04-30")
        cost = _set_hist_cost(markets, regions, book)
        print(f"   The Odds API {s} → {e} "
              f"(book={book or 'premier disponible'}, regions={regions}, "
              f"markets={markets}, {cost} crédits/appel)")
        if budget is not None:
            print(f"   Budget dur : {budget:,} crédits "
                  f"({budget // ODDS_API_HIST_COST} appels au maximum)")
        api_rows = fetch_odds_api(s, e, book, regions, dry_run, api_cache, budget,
                                  markets, close_window_min)
        if dry_run:
            return
        all_rows.extend(api_rows)

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
        # Les CSV déposés dans data/raw/odds/ ne sont plus lus — cf. S5 ci-dessus.
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
    # Depuis 2026-08-04 ce log porte AUSSI les prix over/under et la puck line
    # (migration 028) : c'est la seule source vivante pour ces marchés, et elle
    # se construit au fil de l'eau. Les colonnes portent déjà les noms
    # d'odds.csv, la concaténation les aligne donc d'elle-même ; celles qui
    # manqueraient d'un côté deviennent simplement NaN.
    live_path = f"{DATA_DIR}/odds_live_log.csv"
    if os.path.exists(live_path):
        live = pd.read_csv(live_path)
        live["home_team"] = live["home_team"].map(norm_team)
        live["away_team"] = live["away_team"].map(norm_team)
        if "source" not in live.columns:
            live["source"] = "oddsapi:live"      # exports antérieurs à la 028
        live = _drop_implausible_pairs(live)
        df = pd.concat([df, live], ignore_index=True)
        derived = [c for c in ("total_close_over", "pl_home_price")
                   if c in live.columns and live[c].notna().any()]
        print(f"   + {len(live)} lignes du log live (odds_live_log.csv)"
              + (f" — marchés dérivés présents : {', '.join(derived)}" if derived
                 else " — sans marchés dérivés (export d'avant la migration 028)"))

    if df.empty:
        print("   ⚠️  Aucune cote récupérée — le modèle s'entraînera sans cotes.")
        return
    df = df.drop_duplicates(subset=["date", "home_team", "away_team"], keep="last")
    if not _write_odds_csv(df, allow_shrink):
        return
    print(f"   ✅ {len(df)} matchs avec cotes → odds.csv")

    # Couverture par source et par saison : c'est ce tableau qui dit si une
    # saison est servie par SBRO, par l'API, ou par les deux — et donc si un
    # résultat mesuré dessus peut être comparé à un autre.
    if "source" in df.columns:
        d = df.dropna(subset=["date"]).copy()
        yr = pd.to_datetime(d["date"], errors="coerce")
        d["season"] = yr.dt.year.where(yr.dt.month >= 8, yr.dt.year - 1)
        tab = d.groupby(["season", d["source"].fillna("?")]).size().unstack(fill_value=0)
        print("\n   Couverture par saison et par source :")
        print(tab.to_string().replace("\n", "\n   "))


# ══════════════════════════════════════════════════════════════════════════════

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--only", choices=["spine", "moneypuck", "odds"], default=None)
    p.add_argument("--skip-skaters", action="store_true")
    p.add_argument("--from-local", action="store_true",
                   help="Lit les fichiers téléchargés manuellement dans data/raw/ "
                        "(all_teams.csv, goalies_*.zip, skaters_*.zip, odds/*.xlsx) "
                        "au lieu de les télécharger")
    # ── The Odds API — seule source pour 2023-24 et au-delà ──────────────────
    p.add_argument("--odds-api-from", metavar="AAAA-MM-JJ",
                   help="Début de l'historique The Odds API à récupérer "
                        "(couverture NHL depuis 2020-06-29). Nécessite "
                        "ODDS_API_KEY dans l'environnement.")
    p.add_argument("--odds-api-to", metavar="AAAA-MM-JJ",
                   help="Fin de l'historique The Odds API (incluse)")
    p.add_argument("--odds-api-book", default=None,
                   help="Clé du bookmaker à retenir (draftkings, fanduel, "
                        "pinnacle…). Recommandé : un book NOMMÉ, sinon la marge "
                        "varie d'un match à l'autre sans rapport avec le hockey")
    p.add_argument("--odds-api-regions", default="us",
                   help="Régions de bookmakers (us, us2, uk, eu, au). "
                        "'eu' pour Pinnacle. Défaut : us")
    p.add_argument("--odds-api-markets", default=ODDS_API_MARKETS_DEFAULT,
                   help="Marchés demandés (h2h, spreads, totals). Défaut : "
                        "h2h,spreads — les totaux sont clos et coûteraient un "
                        "tiers de plus. 10 crédits par marché et par appel")
    p.add_argument("--odds-api-close-window", type=int, default=60, metavar="MIN",
                   help="Regroupe les clôtures : pas de nouvel appel si un "
                        "snapshot tombe dans les MIN minutes avant ce coup "
                        "d'envoi. ~1/3 de crédits en moins. 0 = un appel par "
                        "heure de début (ancien comportement)")
    p.add_argument("--odds-api-dry-run", action="store_true",
                   help="Chiffre le coût en crédits sans appeler l'API")
    p.add_argument("--odds-api-no-cache", action="store_true",
                   help="Ignore les snapshots déjà en cache (redépense des "
                        "crédits — à n'utiliser que si le cache est suspect)")
    p.add_argument("--allow-shrink", action="store_true",
                   help="Autorise odds.csv à perdre plus de 10 %% de ses lignes. "
                        "Par défaut c'est REFUSÉ : l'archive SBRO ne sera plus "
                        "mise à jour et le site est injoignable, donc ce que le "
                        "fichier contient ne se re-télécharge pas. Un tel écart "
                        "signale presque toujours --from-local oublié ou "
                        "ODDS_API_KEY absente")
    p.add_argument("--odds-api-budget", type=int, default=None, metavar="CREDITS",
                   help="Plafond DUR de crédits pour cette exécution. "
                        "L'arrêt conserve tout ce qui a déjà été récupéré, et "
                        "le cache évite de le repayer. Fortement recommandé : "
                        "une plage de dates large consomme sans prévenir")
    p.add_argument("--odds-api-keep", type=int, default=ODDS_API_KEEP_DEFAULT,
                   metavar="CREDITS",
                   help="Crédits laissés au COMPTE pour l'app (proxy d'affichage + "
                        f"collecte live). Défaut {ODDS_API_KEEP_DEFAULT}. Le run "
                        "s'arrête quand le solde réel descendrait sous ce seuil")
    args = p.parse_args()
    global ODDS_API_KEEP
    ODDS_API_KEEP = max(0, int(args.odds_api_keep))

    api_range = None
    if args.odds_api_from or args.odds_api_to:
        if not (args.odds_api_from and args.odds_api_to):
            p.error("--odds-api-from et --odds-api-to vont par paire")
        api_range = (args.odds_api_from, args.odds_api_to)

    os.makedirs(DATA_DIR, exist_ok=True)
    t0 = time.time()
    if args.only in (None, "spine"):
        fetch_spine()   # api.nhle.com — toujours en ligne (pas bloqué)
    if args.only in (None, "moneypuck"):
        fetch_moneypuck(skip_skaters=args.skip_skaters, from_local=args.from_local)
    if args.only in (None, "odds"):
        fetch_odds(from_local=args.from_local, api_range=api_range,
                   book=args.odds_api_book, regions=args.odds_api_regions,
                   dry_run=args.odds_api_dry_run,
                   api_cache=not args.odds_api_no_cache,
                   budget=args.odds_api_budget,
                   allow_shrink=args.allow_shrink,
                   markets=args.odds_api_markets,
                   close_window_min=args.odds_api_close_window)
    print(f"\n🏁 Terminé en {(time.time() - t0) / 60:.1f} min. "
          f"Prochaine étape : python build_dataset.py")


if __name__ == "__main__":
    main()
