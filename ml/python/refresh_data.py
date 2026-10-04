"""
refresh_data.py — met à jour les données du modèle EN COURS DE SAISON, sans réentraîner
====================================================================================

Pourquoi. Le service ML lit `inference_state.json` (forme des équipes, gardiens,
alignements) et `elo_ratings.json`, produits par `build_dataset.py`. Sans
rafraîchissement ils restent figés au dernier jour de la saison précédente : en
octobre le modèle prédit 2026-27 avec la forme d'avril 2026, sans les échanges
de l'été ni les premiers matchs. C'était le premier manque du bilan du
2026-10-02. Le réentraînement (mensuel) est une autre étape : ici, mêmes
modèles, données du jour.

Ce que le script fait, dans l'ordre :
  1. calendrier des matchs joués (API NHL, une requête) ;
  2. équipes : `all_teams.csv` de MoneyPuck (toutes saisons, ~125 Mo) ;
  3. gardiens et patineurs, saison en cours SEULEMENT, ajoutés à l'historique
     déjà sur disque (`mp_*_games.csv`) — l'historique 2008-2025 ne bouge plus,
     inutile de relire ses 400 Mo de zips chaque semaine. Source : le zip de
     saison de MoneyPuck ; s'il est inaccessible, les fichiers « carrière » de
     chaque joueur ayant joué cette saison (plus lent, prévenu) ;
  4. `build_dataset.py` → `nhl_games_v4.csv`, `inference_state.json`,
     `elo_ratings.json` ;
  5. recalage de niveau des buts (2026-10-04) : le modèle de score SERVI
     chiffre les matchs déjà joués de la saison en cours, et le rapport buts
     observés / buts prévus, rétréci vers 1, part dans `level_layer.json`
     (`score_model.level_k`, mesure et règle dans `measure_level.py`). Le
     service multiplie le total λ par ce k, sans toucher à la victoire.

Ce qu'il ne fait JAMAIS : toucher `odds.csv` (irremplaçable, cf. le garde-fou de
`fetch_data_v4._write_odds_csv`), réentraîner, committer.

Ensuite, pour que le service en ligne en profite : committer
`ml/models/inference_state.json`, `ml/models/elo_ratings.json` et
`ml/models/level_layer.json`, puis pousser (le service ML embarque
`ml/models/` dans son image).

Usage :
    cd ml/python
    python refresh_data.py              # tout
    python refresh_data.py --dry-run    # télécharge et contrôle, n'écrit rien dans data/ ni models/
"""

import argparse
import io
import os
import sys
import time
from datetime import datetime, timezone

import pandas as pd

import fetch_data_v4 as F
from score_model import level_k

DATA_DIR = F.DATA_DIR
RAW_DIR = F.RAW_DIR
MP_BASE = "https://moneypuck.com/moneypuck/playerData"
CAREER_URL = MP_BASE + "/careers/gameByGame/regular/{kind}/{pid}.csv"
SUMMARY_URL = MP_BASE + "/seasonSummary/{season}/regular/{kind}.csv"


def current_season(today: datetime | None = None) -> int:
    """Année de début de la saison NHL en cours (août → année courante)."""
    d = today or datetime.now(timezone.utc)
    return d.year if d.month >= 8 else d.year - 1


def season_of_game(game_ids: pd.Series) -> pd.Series:
    """2026020004 → 2026 : la saison est dans l'identifiant de match."""
    return (pd.to_numeric(game_ids, errors="coerce") // 1_000_000).astype("Int64")


# ── 2. Équipes ────────────────────────────────────────────────────────────────

def refresh_teams(dry: bool) -> pd.DataFrame:
    print("🏒 MoneyPuck — équipes (all_teams.csv) …")
    r = F.http_get(F.MP_TEAMS_URL, timeout=900)
    if r is None:
        sys.exit("   ❌ all_teams.csv inaccessible — rien n'a été modifié")
    df = pd.read_csv(io.BytesIO(r.content), low_memory=False)
    df = df[df["situation"].isin(["all", "5on5", "5on4", "4on5"])]
    df = df[df["season"] >= F.FIRST_SEASON]
    if not dry:
        with open(f"{RAW_DIR}/all_teams.csv", "wb") as fh:   # --from-local reste cohérent
            fh.write(r.content)
    return df


# ── 3. Gardiens et patineurs, saison en cours ────────────────────────────────

def _season_zip(kind: str, season: int) -> pd.DataFrame | None:
    url = F.MP_GBG_SEASON.format(kind=kind, season=season)
    r = F.http_get(url, retries=2, timeout=600)
    if r is None or r.status_code != 200 or not r.content.startswith(b"PK"):
        return None
    keep = F.SKATER_KEEP if kind == "skaters" else None
    return F._read_zip_csvs(r.content, keep=keep)


def _polite_get(url: str, pause: float):
    """GET poli : MoneyPuck répond 429 au-delà d'une requête par seconde environ
    (mesuré le 2026-10-02 : refus en série dès 5 req/s). Sur 429 on attend
    (Retry-After, sinon 30 s puis 60 s…) et on retente."""
    for attempt in range(6):
        try:
            r = F.SESSION.get(url, timeout=120)
        except Exception as e:
            print(f"  [WARN] {url} → {e}")
            time.sleep(5)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After") or 30 * (attempt + 1))
            print(f"   … MoneyPuck demande d'attendre ({wait} s)")
            time.sleep(wait)
            continue
        time.sleep(pause)
        if r.status_code == 404:
            return "absent"
        return r if r.status_code == 200 else None
    return None


def _from_careers(kind: str, season: int, columns: list[str]) -> pd.DataFrame | None:
    """Repli : un fichier « carrière » par joueur ayant joué cette saison
    (liste tirée du sommaire de saison MoneyPuck), lignes de la saison gardées."""
    r = F.http_get(SUMMARY_URL.format(season=season, kind=kind), retries=2, timeout=120)
    if r is None:
        return None
    summary = pd.read_csv(io.BytesIO(r.content), low_memory=False)
    pids = sorted(summary["playerId"].dropna().astype(int).unique())
    print(f"   repli : {len(pids)} fichiers « carrière » {kind}, une requête par joueur "
          f"et par seconde (~{len(pids) / 60:.0f} min) …")
    frames, failed, absent = [], [], []
    cache_dir = f"{RAW_DIR}/careers/{kind}"
    os.makedirs(cache_dir, exist_ok=True)
    for i, pid in enumerate(pids, 1):
        cached = f"{cache_dir}/{pid}.csv"
        # Cache d'une demi-journée : relancer après une panne ne repaie pas tout.
        if os.path.exists(cached) and time.time() - os.path.getmtime(cached) < 12 * 3600:
            with open(cached, "rb") as fh:
                content = fh.read()
        else:
            rr = _polite_get(CAREER_URL.format(kind=kind, pid=pid), pause=1.0)
            if rr == "absent":
                absent.append(pid)
                continue
            if rr is None:
                failed.append(pid)
                continue
            content = rr.content
            with open(cached, "wb") as fh:
                fh.write(content)
        d = pd.read_csv(io.BytesIO(content), low_memory=False)
        d = d[(d["season"] == season) & (d["situation"] == "all")]
        frames.append(d[[c for c in columns if c in d.columns]])
        if i % 100 == 0:
            print(f"     {i}/{len(pids)}")
    if absent:
        # MoneyPuck n'a pas (encore) de fichier pour ce joueur : il compte 0,
        # comme un débutant sans cadence à l'entraînement.
        print(f"   ℹ️  {len(absent)} joueur(s) sans fichier chez MoneyPuck : {absent[:10]}")
    if failed:
        # Une saison TROUÉE par des erreurs réseau ferait disparaître des
        # joueurs de l'alignement projeté : mieux vaut garder l'état précédent.
        print(f"   ❌ {len(failed)} joueur(s) non récupéré(s) (erreurs réseau) sur {len(pids)} "
              f"— saison {kind} non mise à jour : {failed[:10]}")
        return None
    return pd.concat(frames, ignore_index=True) if frames else None


def refresh_players(kind: str, out: str, season: int, dry: bool) -> pd.DataFrame | None:
    path = f"{DATA_DIR}/{out}"
    hist = pd.read_csv(path, low_memory=False)
    columns = list(hist.columns)
    print(f"{'🥅' if kind == 'goalies' else '⛸️ '} MoneyPuck — {kind}, saison {season}-{str(season + 1)[2:]} …")
    cur = _season_zip(kind, season)
    if cur is None:
        print("   zip de saison inaccessible")
        cur = _from_careers(kind, season, columns)
    if cur is None or cur.empty:
        print(f"   ⚠️  aucune donnée {kind} pour {season} — historique gardé tel quel")
        return None
    cur = cur[[c for c in columns if c in cur.columns]]
    keep = hist[season_of_game(hist["gameId"]) < season]
    merged = pd.concat([keep, cur], ignore_index=True)
    merged = merged.drop_duplicates(subset=["playerId", "gameId", "situation"], keep="last")
    n_cur = int((season_of_game(merged["gameId"]) == season).sum())
    print(f"   ✅ {n_cur} lignes {season}-{str(season + 1)[2:]} "
          f"(historique : {len(keep)} lignes conservées)")
    if not dry:
        merged.to_csv(path, index=False)
    return merged


# ── 5. Recalage de niveau des buts ───────────────────────────────────────────

LEVEL_LAYER = "level_layer.json"
LEVEL_REPORT = "level_report.json"


def refresh_level(season: int, models_dir: str, data_path: str) -> dict:
    """Calcule k pour la saison `season` et écrit `level_layer.json`.

    Les λ viennent du modèle de score SERVI (`score_model.json`), sur les
    lignes du dataset — les mêmes features qu'à l'entraînement. La saison en
    cours est toujours hors de son entraînement : `train_score.split` réserve
    les 20 % les plus récents au test, et ceux-ci couvrent plusieurs saisons.

    Écrit TOUJOURS un fichier, même à k = 1 (début de saison, mesure rejetée,
    modèle illisible) : un `level_layer.json` d'une saison précédente resté sur
    disque serait sinon servi tel quel — le service le refuse déjà sur la
    saison, mais mieux vaut que le fichier dise l'état réel.
    """
    import json

    import numpy as np

    out = {"season": int(season), "k": 1.0, "obs_sum": 0.0, "lam_sum": 0.0,
           "n_games": 0, "prior_games": None, "verdict": "REJETER",
           "as_of": None, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "note": ""}
    try:
        with open(os.path.join(models_dir, LEVEL_REPORT), encoding="utf-8") as fh:
            rep = json.load(fh)
        out["verdict"] = rep.get("verdict", "REJETER")
        out["prior_games"] = float(rep["prior_games"])
    except Exception as e:
        out["note"] = f"level_report.json illisible ({e}) — lancer measure_level.py"
    if out["verdict"] != "ADOPTER" or out["prior_games"] is None:
        out["note"] = out["note"] or "mesure non adoptée — k = 1"
    else:
        try:
            import xgboost as xgb
            import train_score as TS
            with open(os.path.join(models_dir, "score_report.json"), encoding="utf-8") as fh:
                feats = list(json.load(fh)["features"])
            if feats != TS.stacked_features():
                raise ValueError("features de score_report.json ≠ train_score.stacked_features()")
            model = xgb.Booster()
            model.load_model(os.path.join(models_dir, "score_model.json"))
            df = pd.read_csv(data_path, low_memory=False)
            df = df[df["date"].map(lambda d: int(str(d)[:4]) if int(str(d)[5:7]) >= 8
                                   else int(str(d)[:4]) - 1) == season]
            df = df.dropna(subset=["home_reg_score", "away_reg_score"]).reset_index(drop=True)
            if len(df):
                lam_h, lam_a = TS.lambdas_for(model, feats, TS.stack(df), len(df))
                # Même garde-fou que le service : une intensité aberrante
                # trahit une ligne mal remplie, elle ne compte pas.
                ok = (lam_h >= 0.5) & (lam_h <= 8.0) & (lam_a >= 0.5) & (lam_a <= 8.0)
                obs = (df["home_reg_score"] + df["away_reg_score"]).values.astype(float)
                out["obs_sum"] = round(float(obs[ok].sum()), 6)
                out["lam_sum"] = round(float((lam_h + lam_a)[ok].sum()), 6)
                out["n_games"] = int(ok.sum())
                out["as_of"] = str(df.loc[ok, "date"].max()) if ok.any() else None
            # Le service recalcule k à partir des comptes écrits et refuse le
            # fichier s'ils ne concordent pas : k est donc calculé sur les
            # comptes DÉJÀ arrondis, pour que les deux calculs tombent juste.
            out["k"] = level_k(out["obs_sum"], out["lam_sum"], out["n_games"], out["prior_games"])
            if out["n_games"] == 0:
                out["note"] = "aucun match joué cette saison — k = 1"
        except Exception as e:
            out.update(k=1.0, obs_sum=0.0, lam_sum=0.0, n_games=0, verdict="REJETER",
                       note=f"calcul impossible ({e}) — k = 1")
    with open(os.path.join(models_dir, LEVEL_LAYER), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    ratio = out["obs_sum"] / out["lam_sum"] if out["lam_sum"] else float("nan")
    print(f"\n📏 Recalage de niveau {season}-{str(season + 1)[2:]} : k = {out['k']:.4f} "
          f"({out['n_games']} matchs, buts/λ {ratio:.3f}, n0 {out['prior_games']})"
          + (f" — {out['note']}" if out["note"] else ""))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Télécharge et contrôle sans rien écrire dans data/ ni models/")
    args = ap.parse_args()
    season = current_season()
    t0 = time.time()
    os.makedirs(RAW_DIR, exist_ok=True)

    if args.dry_run:
        print("— essai à blanc : rien ne sera écrit —")
    else:
        F.fetch_spine()                                       # 1
    teams = refresh_teams(args.dry_run)                       # 2
    if not args.dry_run:
        teams.to_csv(f"{DATA_DIR}/mp_team_games.csv", index=False)
    n_team_cur = int((teams["season"] == season).sum())
    print(f"   ✅ {len(teams)} lignes équipe, dont {n_team_cur} pour {season}-{str(season + 1)[2:]}")

    for kind, out in (("goalies", "mp_goalie_games.csv"), ("skaters", "mp_skater_games.csv")):
        refresh_players(kind, out, season, args.dry_run)      # 3

    if args.dry_run:
        print(f"\n🏁 Essai terminé en {(time.time() - t0) / 60:.1f} min.")
        return

    print("\n🧱 build_dataset.py …")                           # 4
    import build_dataset
    build_dataset.main()

    refresh_level(season, build_dataset.MODELS_DIR, f"{DATA_DIR}/nhl_games_v4.csv")   # 5

    import json
    with open(f"{build_dataset.MODELS_DIR}/inference_state.json", encoding="utf-8") as fh:
        st = json.load(fh)
    with open(f"{build_dataset.MODELS_DIR}/elo_ratings.json", encoding="utf-8") as fh:
        elo = json.load(fh)
    print(f"\n🏁 Terminé en {(time.time() - t0) / 60:.1f} min — état d'inférence au {st['as_of']}, "
          f"ELO au {elo.get('as_of_date')}, {len(st['teams'])} équipes, "
          f"{len(st.get('skater_pool', {}))} patineurs dans le bassin.")
    print("   Pour le service en ligne : committer ml/models/inference_state.json, "
          "ml/models/elo_ratings.json et ml/models/level_layer.json, puis pousser. "
          "Pas de réentraînement nécessaire.")


if __name__ == "__main__":
    main()
