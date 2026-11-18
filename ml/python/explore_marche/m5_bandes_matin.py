"""Le rendement des gros desaccords survit-il sans l'information d'alignement ?

m4 trouve, en selectionnant sur le desaccord avec l'OUVERTURE et en misant a
l'ouverture, +6,2 % de rendement sur la bande 5-10 points (2 169 paris, z +2,9)
et +36,9 % au-dela de 10 points (330 paris, z +4,6) — alors que la section 7.4
annonce un rendement nul a tous les seuils d'edge. m2 a montre que l'avance du
modele sur le prix du matin vient de l'alignement du soir, qu'un parieur n'a pas
a ce prix-la. Ce script tranche : les memes bandes, le meme prix, avec et sans
les 7 variables d'alignement, et separement par source.

Trois precautions :
  - par SOURCE : l'ouverture SBRO precede de plusieurs jours, celle de l'API de
    ~8 h. m2 montre que le signal survit sur la premiere, pas sur la seconde.
  - ouvertures SUSPECTES : une erreur de prix a l'ouverture fabrique un edge
    enorme et un rendement fictif. Chaque bande est donc donnee aussi sans les
    matchs ou |ouverture - cloture| depasse 15 points.
  - modele BRUT des deux cotes (sans couche de correction), pour que la seule
    difference soit les 7 variables.

Descriptif, pas pre-enregistre : aucune regle de mise n'a ete figee avant.

    python explore_marche/m5_bandes_matin.py   # -> ml/models/bandes_matin_report.json
"""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))

import backtest_walkforward as BW
from m2_clv_matin import OUT, VARIANTS, NEED, load_data, clv_seasons

REPORT = f"{BW.MODELS}/bandes_matin_report.json"
BANDS = [(0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 1.01)]
SUSPECT = 0.15


def table(g, label):
    out = {"label": label, "n": int(len(g)), "bandes": []}
    for lo, hi in BANDS:
        m = (g["gap"] >= lo) & (g["gap"] < hi)
        if m.sum() < 20:
            continue
        sub = g[m]
        def roi(d):
            if len(d) < 5:
                return None, None, None
            r = np.where(d["won"], d["dec"] - 1.0, -1.0)
            se = float(r.std(ddof=1) / np.sqrt(len(r))) * 100
            return round(float(r.mean()) * 100, 2), round(se, 2), \
                (round(float(r.mean()) * 100 / se, 2) if se else None)
        r_all = roi(sub)
        clean = sub[~sub["suspect"]]
        r_cl = roi(clean)
        out["bandes"].append({
            "bande": f"{lo:.0%}-{hi:.0%}" if hi <= 1 else f"{lo:.0%}+",
            "n": int(m.sum()),
            "p_model": round(float(sub["p_model"].mean()), 4),
            "p_open": round(float(sub["p_market"].mean()), 4),
            "observe": round(float(sub["won"].mean()), 4),
            "roi_pct": r_all[0], "roi_se_pct": r_all[1], "roi_z": r_all[2],
            "n_sans_suspectes": int(len(clean)),
            "roi_sans_suspectes_pct": r_cl[0], "roi_sans_suspectes_z": r_cl[2]})
    return out


def frames_for(variant, df, seasons):
    parts = []
    for s in seasons:
        f = os.path.join(OUT, f"pml_{variant}_{s}.npz")
        if not os.path.exists(f):
            print(f"   manque {os.path.basename(f)} — lancer m3_precision.py pml {variant}")
            return None
        z = np.load(f, allow_pickle=True)
        cur = df[df["season"] == s].dropna(subset=NEED).reset_index(drop=True)
        if len(cur) != len(z["p"]):
            print(f"   cache desaligne {variant} {s}"); return None
        parts.append(pd.DataFrame({
            "season": s, "p": z["p"], "home_win": z["y"],
            "p_open": z["po"], "p_close": z["pk"], "source": z["src"].astype(str),
            "ml_open_h": cur["home_ml_open"].to_numpy(float),
            "ml_open_a": cur["away_ml_open"].to_numpy(float)}))
    G = pd.concat(parts, ignore_index=True)
    g = G.dropna(subset=["p_open", "ml_open_h", "ml_open_a"]).copy()
    g = g[(g["ml_open_h"] > 1) & (g["ml_open_a"] > 1)]
    home = g["p"] >= g["p_open"]
    g["p_model"] = np.where(home, g["p"], 1 - g["p"])
    g["p_market"] = np.where(home, g["p_open"], 1 - g["p_open"])
    g["dec"] = np.where(home, g["ml_open_h"], g["ml_open_a"])
    g["won"] = np.where(home, g["home_win"] > 0.5, g["home_win"] < 0.5)
    g["gap"] = g["p_model"] - g["p_market"]
    g["suspect"] = (np.abs(g["p_open"] - g["p_close"]) > SUSPECT).fillna(False)
    return g


def main():
    df = load_data()
    snaps, _ = BW.load_snapshot_pairs()
    seasons = clv_seasons(df, snaps)
    res = {"question": ("le rendement des gros desaccords au prix d'ouverture "
                        "survit-il sans les 7 variables d'alignement ?"),
           "protocol": {
               "modele": "modele de score BRUT des deux cotes, walk-forward, cache de m3",
               "selection": "desaccord avec l'OUVERTURE, mise a l'ouverture, a plat",
               "suspectes": f"matchs ou |ouverture - cloture| > {SUSPECT:.0%}",
               "statut": "descriptif : aucune regle de mise n'a ete figee avant"},
           "tables": []}
    for variant in VARIANTS:
        g = frames_for(variant, df, seasons)
        if g is None:
            return
        for src_label, mask in [("toutes sources", np.ones(len(g), bool)),
                                ("SBRO", (g["source"] == "sbro").to_numpy()),
                                ("DraftKings", (g["source"] == "oddsapi:draftkings").to_numpy())]:
            sub = g[mask]
            if len(sub) < 100:
                continue
            t = table(sub, f"{variant} / {src_label}")
            res["tables"].append(t)
    print(f"   {'variante / source':<26} {'bande':>7} {'paris':>6} {'modele':>7} "
          f"{'ouv':>7} {'obs':>7} {'ROI':>9} {'z':>6} {'ROI net susp':>13} {'z':>6}")
    for t in res["tables"]:
        for b in t["bandes"]:
            print(f"   {t['label']:<26} {b['bande']:>7} {b['n']:>6} {b['p_model']:>6.1%} "
                  f"{b['p_open']:>6.1%} {b['observe']:>6.1%} "
                  f"{(b['roi_pct'] or 0):>+8.2f}% {(b['roi_z'] or 0):>+6.2f} "
                  f"{(b['roi_sans_suspectes_pct'] or 0):>+12.2f}% "
                  f"{(b['roi_sans_suspectes_z'] or 0):>+6.2f}")
    BW._dump_json_atomic(res, REPORT)
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    main()
