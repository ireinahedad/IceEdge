"""compare_odds_sources.py - SBRO face a The Odds API sur les matchs communs.

Controle exige par P7 (ml/REFACTOR_PLAN.md) AVANT d'etendre la serie de cotes
a 2023-2026 avec The Odds API : les deux sources n'ont ni le meme livre ni la
meme marge. Un ROI ou un CLV qui n'apparaitrait que d'un cote de la jointure
serait un artefact de source, pas du hockey.

Entrees :
  ../data/odds.csv                 lignes `source == sbro` (cloture SBRO)
  ../data/odds_snapshots_hist.csv  backfill The Odds API ; pour chaque match,
                                   la DERNIERE observation avant la mise au jeu
                                   fait office de cloture.

Ne coute aucun credit, n'ecrit rien. A lancer apres une plage de recouvrement :
    python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings ^
        --odds-api-from 2022-01-12 --odds-api-to 2022-01-15 --odds-api-budget 400
    python compare_odds_sources.py

Sortie ASCII seulement (console Windows en cp1252).
"""
import os
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
KEY = ["date", "home_team", "away_team"]


def devig(a, b):
    ia, ib = 1 / a, 1 / b
    return ia / (ia + ib), ia + ib - 1


def main() -> int:
    odds = pd.read_csv(os.path.join(DATA, "odds.csv"))
    sbro = odds[odds.get("source", "sbro").astype(str).str.startswith("sbro")]

    path = os.path.join(DATA, "odds_snapshots_hist.csv")
    if not os.path.exists(path):
        print("odds_snapshots_hist.csv absent : lancer d'abord la plage de "
              "recouvrement (voir l'en-tete).")
        return 1
    snap = pd.read_csv(path)
    snap = snap[snap["observed_at"] < snap["commence_time"]]
    close = (snap.sort_values("observed_at")
                 .groupby(["game_date", "home_team", "away_team"]).tail(1)
                 .rename(columns={"game_date": "date"}))

    m = sbro.merge(close, on=KEY, suffixes=("_sbro", "_api"))
    print(f"Matchs communs : {len(m)}  (sources API : "
          f"{', '.join(sorted(m['source_api'].astype(str).unique())) or '-'})")
    if m.empty:
        print("Aucun match commun : verifier que la plage demandee est bien "
              "couverte par SBRO (2014-10 -> 2022-11).")
        return 1

    ml = m.dropna(subset=["home_ml_close", "away_ml_close", "home_ml", "away_ml"])
    if len(ml):
        p_s, mg_s = devig(ml["home_ml_close"], ml["away_ml_close"])
        p_a, mg_a = devig(ml["home_ml"], ml["away_ml"])
        d = (p_a - p_s)
        print("\nMONEYLINE (cloture, probabilite domicile devigee)")
        print(f"   n = {len(ml)}")
        print(f"   marge moyenne     SBRO {mg_s.mean():.4f}   API {mg_a.mean():.4f}")
        print(f"   |ecart| moyen     {d.abs().mean():.4f}   (max {d.abs().max():.4f})")
        print(f"   ecart moyen signe {d.mean():+.4f}   (biais domicile d'une source)")
        print(f"   correlation       {p_s.corr(p_a):.4f}")
        print(f"   meme favori       {((p_s > .5) == (p_a > .5)).mean():.1%}")

    pl = m.dropna(subset=["pl_home_price_sbro", "pl_away_price_sbro",
                          "pl_home_price_api", "pl_away_price_api"])
    print(f"\nPuck line presente : SBRO {m['pl_home_price_sbro'].notna().sum()}"
          f" / API {m['pl_home_price_api'].notna().sum()} sur {len(m)} matchs"
          f" (commune : {len(pl)})")
    if len(pl):
        same = (pl["puck_line_home_sbro"] == pl["puck_line_home_api"])
        q = pl[same]
        p_s, mg_s = devig(q["pl_home_price_sbro"], q["pl_away_price_sbro"])
        p_a, mg_a = devig(q["pl_home_price_api"], q["pl_away_price_api"])
        d = p_a - p_s
        print("\nPUCK LINE +-1.5 (cloture)")
        print(f"   n = {len(pl)}   meme cote du handicap : {same.mean():.1%}")
        if len(q):
            print(f"   marge moyenne     SBRO {mg_s.mean():.4f}   API {mg_a.mean():.4f}")
            print(f"   |ecart| moyen     {d.abs().mean():.4f}   (max {d.abs().max():.4f})")
            print(f"   ecart moyen signe {d.mean():+.4f}")

    print("\nLecture : un |ecart| moyen de l'ordre de 0.01-0.02 et une marge "
          "voisine\nsont normaux entre deux livres. Un ecart SIGNE loin de 0 "
          "(> 0.01) est un\nbiais de source : le signaler avant de joindre les "
          "saisons.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
