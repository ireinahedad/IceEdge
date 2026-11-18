"""Les totaux contre le marche : precision, calibration, rendement.

Manque releve le 2026-11-16 : le modele predit des buts, SBRO et DraftKings
donnent des lignes de totaux, et la section 7 ne compare jamais les deux. Le
moneyline sort d'un ecart entre deux lambdas ; le total sort de leur SOMME, que
l'objectif de Poisson optimise directement. Si le modele doit battre le marche
quelque part, c'est la.

Mesures, sur l'echantillon walk-forward (meme cache de folds que m2) :

  1. log-loss plus/moins contre la cloture devigee, appariee par match, a la
     ligne du marche (poussees ecartees et comptees) ;
  2. calibration de P(plus) par classes de 10 points, et niveau du total predit
     contre le total observe ;
  3. rendement a la cloture par bande de desaccord, comme en 7.3 pour le
     moneyline.

La CLV des totaux est deja mesuree par `run_clv` (bloc TOTAL de
`clv_matin_report.json`, SBRO seulement : les totaux ne sont pas dans la serie
horodatee de l'API) ; ce script la reprend avec et sans l'alignement.

    python explore_marche/m7_totaux.py pov      # a relancer jusqu'a COMPLET
    python explore_marche/m7_totaux.py compare  # -> ml/models/totaux_report.json
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

REPORT = f"{BW.MODELS}/totaux_report.json"
COLS = ["total_close", "market_over_p_close", "total_close_over", "total_close_under",
        "total_open", "market_over_p_open", "total_open_over", "total_open_under"]


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def pov_path(variant, season):
    return os.path.join(OUT, f"pov_{variant}_{season}.npz")


def stage_pov(variant="complet"):
    atk, dfn = VARIANTS[variant]
    TS.ATK_COLS, TS.DEF_COLS = list(atk), list(dfn)
    df = load_data()
    snaps, _ = BW.load_snapshot_pairs()
    seasons = clv_seasons(df, snaps)
    budget = float(os.environ.get("BUDGET", "130"))
    t0 = time.time()
    reste = []
    for s in seasons:
        f = pov_path(variant, s)
        if os.path.exists(f):
            continue
        if time.time() - t0 > budget:
            reste.append(s); continue
        with open(cache_path(variant, s), "rb") as fh:
            c = pickle.load(fh)
        cur = df[df["season"] == s].dropna(subset=NEED).reset_index(drop=True)
        st = TS.stack(cur)
        lam_h = np.full(len(cur), np.nan); lam_a = np.full(len(cur), np.nan)
        rows, sides = st["_row"].values, st["_side"].values
        lam_h[rows[sides == "home"]] = c["pred"][sides == "home"]
        lam_a[rows[sides == "away"]] = c["pred"][sides == "away"]
        lc = cur["total_close"].to_numpy(float) if "total_close" in cur else np.full(len(cur), np.nan)
        lo = cur["total_open"].to_numpy(float) if "total_open" in cur else np.full(len(cur), np.nan)
        p_close, p_open, p55, exp_tot = (np.full(len(cur), np.nan) for _ in range(4))
        for j in range(len(cur)):
            d = ScoreDistribution(lam_h[j], lam_a[j], c["p_ot"], c["tau"])
            exp_tot[j] = d.expected_total()
            p55[j] = d.p_over(5.5)
            if np.isfinite(lc[j]):
                p_close[j] = d.p_over(float(lc[j]))
            if np.isfinite(lo[j]):
                p_open[j] = d.p_over(float(lo[j]))
        out = {"p_close": p_close, "p_open": p_open, "p55": p55, "exp_total": exp_tot,
               "total": cur["total_goals"].to_numpy(float),
               "src": (cur["source"].fillna("sbro").astype(str).to_numpy()
                       if "source" in cur else np.full(len(cur), "sbro"))}
        for c_ in COLS:
            out[c_] = cur[c_].to_numpy(float) if c_ in cur else np.full(len(cur), np.nan)
        np.savez(f, **out)
        print(f"   [{variant}] {s}-{str(s+1)[2:]:<2} {len(cur):>6} matchs "
              f"({time.time()-t0:.0f}s cumul)", flush=True)
    TS.ATK_COLS, TS.DEF_COLS = ATK_FULL, DEF_FULL
    print("\n   " + (f"INCOMPLET : {len(reste)} saisons restantes — relancer" if reste else "COMPLET"))


def load_pov(variant, seasons):
    parts = []
    for s in seasons:
        f = pov_path(variant, s)
        if not os.path.exists(f):
            print(f"   manque {os.path.basename(f)} — lancer « pov »"); return None
        z = np.load(f, allow_pickle=True)
        d = {k: z[k] for k in z.files if k != "src"}
        d["src"] = z["src"].astype(str)
        d["season"] = np.full(len(d["total"]), s)
        parts.append(pd.DataFrame(d))
    return pd.concat(parts, ignore_index=True)


def stage_compare():
    df = load_data()
    snaps, _ = BW.load_snapshot_pairs()
    seasons = clv_seasons(df, snaps)
    G = load_pov("complet", seasons)
    if G is None:
        return
    res = {"question": "le modele bat-il le marche sur les totaux ?",
           "protocol": {
               "modele": "modele de score brut, walk-forward (cache de m2), "
                         "P(plus) lue sur la matrice de scores a la ligne du marche",
               "resultat": "total final, prolongation et fusillade comprises, "
                           "comme le reglement des paris",
               "poussees": "ecartees du test et comptees a part",
               "signe": "ecart de log-loss negatif = le modele fait mieux"},
           "precision": {}, "calibration": {}, "niveau": {}, "bandes": []}

    # ── 1. precision contre la cloture ──────────────────────────────────────
    m = (np.isfinite(G["p_close"]) & np.isfinite(G["market_over_p_close"])
         & np.isfinite(G["total_close"]))
    g = G[m].copy()
    push = np.abs(g["total"] - g["total_close"]) < 1e-9
    res["precision"]["n_lignes"] = int(len(g))
    res["precision"]["n_poussees"] = int(push.sum())
    g = g[~push]
    y = (g["total"] > g["total_close"]).astype(float).to_numpy()
    pm, pk = g["p_close"].to_numpy(), g["market_over_p_close"].to_numpy()
    d = ll(y, pm) - ll(y, pk)
    sea = g["season"].to_numpy()
    pr = BW._paired(d)
    us = np.unique(sea)
    means = np.array([d[sea == s].mean() for s in us])
    se_s = float(means.std(ddof=1) / np.sqrt(len(us)))
    res["precision"]["ensemble"] = {
        "n": int(len(y)), "ll_modele": round(float(ll(y, pm).mean()), 5),
        "ll_marche": round(float(ll(y, pk).mean()), 5), **pr,
        "z_seasons": round(float(d.mean()) / se_s, 2) if se_s else None,
        "saisons_gagnees": int((means < 0).sum()), "n_saisons": int(len(us)),
        "taux_plus_observe": round(float(y.mean()), 4)}
    res["precision"]["par_source"] = {}
    for s in np.unique(g["src"]):
        k = (g["src"] == s).to_numpy()
        if k.sum() < 100:
            continue
        res["precision"]["par_source"][str(s)] = {
            "n": int(k.sum()), "ll_modele": round(float(ll(y[k], pm[k]).mean()), 5),
            "ll_marche": round(float(ll(y[k], pk[k]).mean()), 5),
            **BW._paired(d[k])}

    # ── 2. calibration de P(plus) et niveau du total ─────────────────────────
    bins = np.arange(0.0, 1.01, 0.10)
    idx = np.clip(np.digitize(pm, bins) - 1, 0, len(bins) - 2)
    classes, ece = [], 0.0
    for b in range(len(bins) - 1):
        k = idx == b
        if k.sum() < 20:
            continue
        obs, prd = float(y[k].mean()), float(pm[k].mean())
        ece += (k.sum() / len(y)) * abs(obs - prd)
        classes.append({"classe": f"{bins[b]:.0%}-{bins[b+1]:.0%}", "n": int(k.sum()),
                        "predit": round(prd, 4), "observe": round(obs, 4),
                        "ecart_points": round((obs - prd) * 100, 2)})
    res["calibration"] = {"classes": classes, "ece_points": round(ece * 100, 2)}
    all_ok = np.isfinite(G["exp_total"])
    res["niveau"] = {
        "n": int(all_ok.sum()),
        "total_predit_moyen": round(float(G.loc[all_ok, "exp_total"].mean()), 3),
        "total_observe_moyen": round(float(G.loc[all_ok, "total"].mean()), 3),
        "p_plus_de_5_5_predit": round(float(G.loc[all_ok, "p55"].mean()), 4),
        "p_plus_de_5_5_observe": round(float((G.loc[all_ok, "total"] > 5.5).mean()), 4),
        "note": "lambdas brutes, sans le recalage de niveau de la section 4.6"}

    # ── 3. rendement a la cloture par bande de desaccord ────────────────────
    gg = g.dropna(subset=["total_close_over", "total_close_under"]).copy()
    gg = gg[(gg["total_close_over"] > 1) & (gg["total_close_under"] > 1)]
    over = gg["p_close"].to_numpy() >= gg["market_over_p_close"].to_numpy()
    p_model = np.where(over, gg["p_close"], 1 - gg["p_close"])
    p_mkt = np.where(over, gg["market_over_p_close"], 1 - gg["market_over_p_close"])
    dec = np.where(over, gg["total_close_over"], gg["total_close_under"])
    won = np.where(over, gg["total"] > gg["total_close"], gg["total"] < gg["total_close"])
    gap = p_model - p_mkt
    for lo_, hi_ in [(0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 1.01)]:
        k = (gap >= lo_) & (gap < hi_)
        if k.sum() < 20:
            continue
        ret = np.where(won[k], dec[k] - 1.0, -1.0)
        se = float(ret.std(ddof=1) / np.sqrt(k.sum())) * 100
        res["bandes"].append({
            "bande": f"{lo_:.0%}-{hi_:.0%}" if hi_ <= 1 else f"{lo_:.0%}+",
            "n": int(k.sum()), "p_model": round(float(p_model[k].mean()), 4),
            "p_marche": round(float(p_mkt[k].mean()), 4),
            "observe": round(float(won[k].mean()), 4),
            "roi_pct": round(float(ret.mean()) * 100, 2), "roi_se_pct": round(se, 2),
            "roi_z": round(float(ret.mean()) * 100 / se, 2) if se else None,
            "part_plus": round(float(over[k].mean()), 3)})

    # ── 4. la CLV des totaux, deja mesuree par run_clv ──────────────────────
    res["clv_existante"] = {}
    for variant in ("complet", "matin"):
        f = os.path.join(OUT, f"clv_{variant}.json")
        if not os.path.exists(f):
            continue
        rows = (((json.load(open(f, encoding="utf-8")).get("by_source") or {})
                 .get("sbro") or {}).get("markets") or {}).get("total") or []
        res["clv_existante"][variant] = [
            {"edge": r["edge"], "n_bets": r["n_bets"], "roi_open_pct": r["roi_open_pct"],
             "clv_mean": (r.get("clv") or {}).get("mean"),
             "clv_t": (r.get("clv") or {}).get("t"),
             "placebo_mean": (r.get("clv_placebo") or {}).get("mean"),
             "clv_net": r.get("clv_net"), "clv_net_z": r.get("clv_net_z")}
            for r in rows]

    p = res["precision"]["ensemble"]
    print(f"   Precision, {p['n']} lignes de totaux ({res['precision']['n_poussees']} poussees "
          f"ecartees), taux de « plus » observe {p['taux_plus_observe']:.1%}")
    print(f"   modele {p['ll_modele']:.5f}  marche {p['ll_marche']:.5f}  ecart "
          f"{p['delta']:+.5f} (z {p['z']:+.2f} par match, {p['z_seasons']:+.2f} par saison, "
          f"{p['saisons_gagnees']}/{p['n_saisons']} saisons)")
    for s, b in res["precision"]["par_source"].items():
        print(f"     [{s}] n {b['n']} modele {b['ll_modele']:.5f} marche "
              f"{b['ll_marche']:.5f} ({b['delta']:+.5f}, z {b['z']:+.2f})")
    print(f"\n   Calibration de P(plus), ECE {res['calibration']['ece_points']:.2f} points")
    for c in res["calibration"]["classes"]:
        print(f"     {c['classe']:>9} n {c['n']:>6} predit {c['predit']:.1%} "
              f"observe {c['observe']:.1%} ({c['ecart_points']:+.2f} pts)")
    n = res["niveau"]
    print(f"\n   Niveau : total predit {n['total_predit_moyen']:.3f} contre "
          f"{n['total_observe_moyen']:.3f} observe ; P(plus de 5,5) "
          f"{n['p_plus_de_5_5_predit']:.1%} contre {n['p_plus_de_5_5_observe']:.1%}")
    print(f"\n   Rendement a la cloture par bande de desaccord :")
    for b in res["bandes"]:
        print(f"     {b['bande']:>8} n {b['n']:>6} modele {b['p_model']:.1%} marche "
              f"{b['p_marche']:.1%} observe {b['observe']:.1%} ROI {b['roi_pct']:+.2f}% "
              f"(z {b['roi_z']:+.2f}) part « plus » {b['part_plus']:.0%}")
    for v, rows in res["clv_existante"].items():
        if rows:
            r = next((x for x in rows if abs(x["edge"] - 0.02) < 1e-9), rows[0])
            print(f"\n   CLV totaux SBRO [{v}] edge {r['edge']:.0%} : {r['n_bets']} paris, "
                  f"CLV {r['clv_mean']:+.5f} (t {r['clv_t']:.2f}), placebo "
                  f"{r['placebo_mean']:+.5f}, nette {r['clv_net']:+.5f} (z {r['clv_net_z']:+.2f})")
    BW._dump_json_atomic(res, REPORT)
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "compare"
    if cmd == "pov":
        stage_pov(sys.argv[2] if len(sys.argv) > 2 else "complet")
    else:
        stage_compare()
