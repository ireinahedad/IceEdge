"""Ce que coutent, en PRECISION, les 7 variables d'alignement retirees par m2.

m2 montre que la CLV DraftKings disparait sans le gardien partant ni
l'alignement du soir. Reste a savoir si le modele « matin » est globalement
beaucoup moins bon, ou a peine moins bon. Si la perte de log-loss est petite et
que la CLV tombe a zero, alors la CLV de la section 7.8 ne venait pas de la
qualite generale du modele : elle venait de cette information tardive.

Rejoue les folds mis en cache par m2 (aucun entrainement) et compare, sur les
MEMES matchs, la log-loss moneyline des deux variantes, puis le test apparie.

    python explore_marche/m3_precision.py pml complet   # cache les p (budget)
    python explore_marche/m3_precision.py pml matin
    python explore_marche/m3_precision.py compare       # -> ml/models/clv_matin_precision.json
"""
import json, os, pickle, sys, time
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))

import backtest_walkforward as BW
import train_score as TS
from score_model import ScoreDistribution
from m2_clv_matin import (OUT, VARIANTS, NEED, cache_path, load_data, clv_seasons,
                          ATK_FULL, DEF_FULL)

REPORT = f"{BW.MODELS}/clv_matin_precision.json"


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def pml_path(variant, season):
    return os.path.join(OUT, f"pml_{variant}_{season}.npz")


def stage_pml(variant):
    atk, dfn = VARIANTS[variant]
    TS.ATK_COLS, TS.DEF_COLS = list(atk), list(dfn)
    df = load_data()
    snaps, _ = BW.load_snapshot_pairs()
    seasons = clv_seasons(df, snaps)
    budget = float(os.environ.get("BUDGET", "135"))
    t0 = time.time()
    reste = []
    for s in seasons:
        f = pml_path(variant, s)
        if os.path.exists(f):
            continue
        if time.time() - t0 > budget:
            reste.append(s); continue
        with open(cache_path(variant, s), "rb") as fh:
            c = pickle.load(fh)
        test_df = df[df["season"] == s].dropna(subset=NEED).reset_index(drop=True)
        s_te = TS.stack(test_df)
        lam_h = np.full(len(test_df), np.nan); lam_a = np.full(len(test_df), np.nan)
        rows, sides = s_te["_row"].values, s_te["_side"].values
        lam_h[rows[sides == "home"]] = c["pred"][sides == "home"]
        lam_a[rows[sides == "away"]] = c["pred"][sides == "away"]
        p_ml = np.array([ScoreDistribution(h, a, c["p_ot"], c["tau"]).p_home_win()
                         for h, a in zip(lam_h, lam_a)])
        np.savez(f, p=p_ml, y=test_df["home_win"].to_numpy(float),
                 pk=(test_df["market_home_p_close"].to_numpy(float)
                     if "market_home_p_close" in test_df
                     else np.full(len(test_df), np.nan)),
                 po=(test_df["market_home_p_open"].to_numpy(float)
                     if "market_home_p_open" in test_df
                     else np.full(len(test_df), np.nan)),
                 src=(test_df["source"].fillna("sbro").astype(str).to_numpy()
                      if "source" in test_df else np.full(len(test_df), "sbro")))
        print(f"   [{variant}] {s}-{str(s+1)[2:]:<2} {len(test_df):>6} matchs "
              f"({time.time()-t0:.0f}s cumul)", flush=True)
    TS.ATK_COLS, TS.DEF_COLS = ATK_FULL, DEF_FULL
    print(f"\n   {'INCOMPLET : ' + str(len(reste)) + ' saisons restantes — relancer' if reste else 'COMPLET'}")


def stage_compare():
    df = load_data()
    snaps, _ = BW.load_snapshot_pairs()
    seasons = clv_seasons(df, snaps)
    Z = {}
    for v in VARIANTS:
        parts = []
        for s in seasons:
            f = pml_path(v, s)
            if not os.path.exists(f):
                print(f"   manque {os.path.basename(f)}"); return
            z = np.load(f, allow_pickle=True)
            parts.append(pd.DataFrame({"season": s, "p": z["p"], "y": z["y"],
                                       "pk": z["pk"], "po": z["po"],
                                       "src": z["src"].astype(str)}))
        Z[v] = pd.concat(parts, ignore_index=True)
    a, b = Z["complet"], Z["matin"]
    assert len(a) == len(b) and (a["y"].values == b["y"].values).all()
    y = a["y"].to_numpy()
    out = {"question": "ce que les 7 variables d'alignement valent en precision pure",
           "n_games": int(len(y)), "seasons": [int(s) for s in seasons],
           "ensembles": {}}
    sets = {"tous les matchs": np.ones(len(y), bool),
            "matchs cotes (cloture)": np.isfinite(a["pk"].to_numpy()),
            "DraftKings": a["src"].to_numpy() == "oddsapi:draftkings",
            "SBRO": a["src"].to_numpy() == "sbro"}
    print(f"   {'ensemble':<24} {'n':>6} {'complet':>9} {'matin':>9} {'ecart':>9} "
          f"{'z':>7} {'marche':>9}")
    for name, m in sets.items():
        if m.sum() < 50:
            continue
        d = ll(y[m], b["p"].to_numpy()[m]) - ll(y[m], a["p"].to_numpy()[m])
        pr = BW._paired(d)
        pk = a["pk"].to_numpy()[m]
        ll_mkt = float(ll(y[m][np.isfinite(pk)], pk[np.isfinite(pk)]).mean()) \
            if np.isfinite(pk).any() else None
        out["ensembles"][name] = {
            "n": int(m.sum()),
            "ll_complet": round(float(ll(y[m], a["p"].to_numpy()[m]).mean()), 5),
            "ll_matin": round(float(ll(y[m], b["p"].to_numpy()[m]).mean()), 5),
            "ll_marche_cloture": round(ll_mkt, 5) if ll_mkt else None,
            "matin_moins_complet": pr}
        e = out["ensembles"][name]
        print(f"   {name:<24} {e['n']:>6} {e['ll_complet']:>9.5f} {e['ll_matin']:>9.5f} "
              f"{pr['delta']:>+9.5f} {pr['z']:>+7.2f} "
              + (f"{e['ll_marche_cloture']:>9.5f}" if ll_mkt else f"{'—':>9}"))
    # Desaccord avec l'OUVERTURE : c'est lui que la CLV recompense
    po = a["po"].to_numpy()
    m = np.isfinite(po)
    out["desaccord_ouverture"] = {
        "n": int(m.sum()),
        "ecart_moyen_absolu_complet": round(float(np.abs(a["p"].to_numpy()[m] - po[m]).mean()), 5),
        "ecart_moyen_absolu_matin": round(float(np.abs(b["p"].to_numpy()[m] - po[m]).mean()), 5),
        "correlation_des_deux_p": round(float(np.corrcoef(a["p"].to_numpy()[m],
                                                          b["p"].to_numpy()[m])[0, 1]), 4)}
    print(f"\n   Desaccord moyen avec l'ouverture : complet "
          f"{out['desaccord_ouverture']['ecart_moyen_absolu_complet']:.4f}, matin "
          f"{out['desaccord_ouverture']['ecart_moyen_absolu_matin']:.4f} ; "
          f"correlation des deux probabilites "
          f"{out['desaccord_ouverture']['correlation_des_deux_p']:.3f}")
    BW._dump_json_atomic(out, REPORT)
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "compare"
    if cmd == "pml":
        stage_pml(sys.argv[2])
    else:
        stage_compare()
