"""Section 7.2 : où le modèle et le marché sont-ils en désaccord, et qui a raison ?

Modèle = chaîne SERVIE pour la victoire, en walk-forward : modèle de score de
la saison S entraîné sur les saisons < S, puis couche de correction (variante
C) ajustée sur les prédictions hors échantillon des saisons < S (au moins 3).
Mêmes prédictions que test_joueurs_cles.py (variante A), relues dans son
point de reprise ; le contrôle est fait là-bas (correction_report.json
reproduit au 5e chiffre).

Marché = probabilité de clôture dé-viggée (`market_home_p_close`), SBRO puis
DraftKings (The Odds API). Saisons sans cotes : ignorées.

Trois mesures :
1. Par saison : log-loss modèle − marché, appariée par match (± erreur-type).
2. Par taille de désaccord |p_modèle − p_marché| : chaque match est orienté
   vers le côté que le modèle aime PLUS que le marché ; on compare la
   fréquence observée de ce côté à la prévision du modèle et à celle du
   marché. Celui qui est le plus proche « a raison » ; la log-loss appariée
   dit si l'écart est résolu.
3. Les plus gros désaccords, match par match.

Lancer depuis ml/python, après test_joueurs_cles.py :  python desaccord_marche.py
Sortie : ../models/market_disagreement_report.json
"""
from __future__ import annotations

import json
import pickle

import numpy as np
import pandas as pd

import backtest_walkforward as BW

CKPT = f"{BW.MODELS}/key_players_test_ckpt.pkl"
OUT = f"{BW.MODELS}/market_disagreement_report.json"
SUSPECT = 0.15
BUCKETS = [(0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 1.01)]


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def paired(d):
    n = len(d)
    se = float(d.std(ddof=1) / np.sqrt(n))
    return {"n": n, "delta": round(float(d.mean()), 5), "se": round(se, 5),
            "z": round(float(d.mean()) / se, 2)}


def main():
    P = pickle.load(open(CKPT, "rb"))
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(BW.season_of)
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    seasons = sorted({s for (s, v) in P if v == "A"})
    for s in seasons:  # la dernière saison n'a pas toujours son « meta » dans le point de reprise
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        P[(s, "meta")] = {"y": cur["home_win"].to_numpy(float),
                          "X": BW._correction_X(cur, BW.CORRECTION_FEATURES)}

    rows = []
    for i, s in enumerate(seasons):
        past = seasons[:i]
        if len(past) < BW.RECAL_MIN_SEASONS:
            continue
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        y = P[(s, "meta")]["y"]
        assert len(cur) == len(y) and np.array_equal(cur["home_win"].to_numpy(float), y)
        y_tr = np.concatenate([P[(x, "meta")]["y"] for x in past])
        lp_tr = BW._logit(np.concatenate([P[(x, "A")]["p_ml"] for x in past]))
        X_tr = np.concatenate([P[(x, "meta")]["X"] for x in past])
        mu, sd = np.nanmean(X_tr, axis=0), np.nanstd(X_tr, axis=0)
        sd[sd == 0] = 1.0
        std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
        b, _ = BW._logistic_offset(y_tr, np.column_stack([lp_tr, std(X_tr)]), np.zeros(len(y_tr)))
        Xte = np.column_stack([BW._logit(P[(s, "A")]["p_ml"]), std(P[(s, "meta")]["X"])])
        p_mod = 1 / (1 + np.exp(-(b[0] + Xte @ b[1:])))
        rows.append(pd.DataFrame({
            "season": s, "date": cur["date"], "home": cur["home_team"], "away": cur["away_team"],
            "y": y, "p_mod": p_mod, "p_mkt": cur["market_home_p_close"].to_numpy(float),
            "p_open": cur["market_home_p_open"].to_numpy(float),
            "src": cur["source"].fillna("-").astype(str) if "source" in cur else "-"}))
    G = pd.concat(rows, ignore_index=True)
    G = G[np.isfinite(G["p_mkt"])].reset_index(drop=True)
    # Cote de clôture suspecte : à plus de 15 points de l'ouverture du même
    # match (SBRO). Ex. 2016-02-04 WSH–NYI : ouverture 0,588, clôture 0,321.
    G["suspect"] = (np.abs(G["p_mkt"] - G["p_open"]) > SUSPECT).fillna(False).to_numpy(bool)
    y, pm, pk = G["y"].to_numpy(), G["p_mod"].to_numpy(), G["p_mkt"].to_numpy()
    sus = G["suspect"].to_numpy(bool)
    d_ll = ll(y, pm) - ll(y, pk)
    out = {"n_games": int(len(G)), "overall": paired(d_ll),
           "n_suspect_close": int(sus.sum()), "overall_without_suspect": paired(d_ll[~sus]),
           "ll_model": round(float(ll(y, pm).mean()), 5), "ll_market": round(float(ll(y, pk).mean()), 5)}

    print(f"clôtures suspectes : {int(sus.sum())} ; global sans elles : {out['overall_without_suspect']}")
    print(f"{len(G)} matchs cotés, saisons {sorted(G['season'].unique())}")
    print(f"Global : modèle {out['ll_model']}  marché {out['ll_market']}  "
          f"écart {out['overall']['delta']:+.5f} (z {out['overall']['z']:+.2f})")

    out["by_season"] = []
    print("\nPar saison (modèle − marché, positif = marché meilleur) :")
    for s, g in G.groupby("season"):
        r = paired(d_ll[g.index])
        r.update({"season": int(s), "label": f"{s}-{str(s + 1)[2:]}",
                  "source": g["src"].mode().iat[0]})
        out["by_season"].append(r)
        print(f"   {r['label']}  n {r['n']:>5}  {r['delta']:+.5f} ± {r['se']:.5f}  z {r['z']:+.2f}  {r['source']}")

    # Orientation : le côté que le modèle aime plus que le marché.
    home_side = pm >= pk
    q_mod = np.where(home_side, pm, 1 - pm)
    q_mkt = np.where(home_side, pk, 1 - pk)
    hit = np.where(home_side, y, 1 - y)
    gap = q_mod - q_mkt
    # Le côté préféré par le modèle est-il le favori du marché ou l'outsider ?
    fav_side = q_mkt >= 0.5
    out["buckets"] = []
    print("\nPar taille de désaccord (côté que le modèle préfère au marché) :")
    for lo, hi in BUCKETS:
        m = (gap >= lo) & (gap < hi)
        if m.sum() < 30:
            continue
        n = int(m.sum())
        obs = float(hit[m].mean())
        se_obs = float(np.sqrt(obs * (1 - obs) / n))
        r = {"bucket": [lo, hi], "n": n, "share": round(n / len(G), 3),
             "p_model": round(float(q_mod[m].mean()), 4), "p_market": round(float(q_mkt[m].mean()), 4),
             "observed": round(obs, 4), "observed_se": round(se_obs, 4),
             "share_model_on_underdog": round(float((~fav_side[m]).mean()), 3),
             "paired_ll_model_minus_market": paired(d_ll[m]),
             "n_suspect_close": int(sus[m].sum())}
        mc = m & ~sus
        if mc.sum() >= 30:
            oc = float(hit[mc].mean())
            r["without_suspect"] = {"n": int(mc.sum()), "p_model": round(float(q_mod[mc].mean()), 4),
                                    "p_market": round(float(q_mkt[mc].mean()), 4), "observed": round(oc, 4),
                                    "observed_se": round(float(np.sqrt(oc * (1 - oc) / mc.sum())), 4),
                                    "paired_ll_model_minus_market": paired(d_ll[mc])}
        r["closer"] = "modèle" if abs(r["p_model"] - obs) < abs(r["p_market"] - obs) else "marché"
        out["buckets"].append(r)
        print(f"   [{lo:.2f},{hi:.2f})  n {n:>5}  modèle {r['p_model']:.3f}  marché {r['p_market']:.3f}  "
              f"observé {obs:.3f} ± {se_obs:.3f}  outsider {r['share_model_on_underdog']:.0%}  "
              f"LL {r['paired_ll_model_minus_market']['delta']:+.5f} (z {r['paired_ll_model_minus_market']['z']:+.2f})"
              f"  → {r['closer']}  suspects {r['n_suspect_close']}  sans : {r.get('without_suspect')}")

    # Le modèle penche-t-il systématiquement vers l'outsider ou le favori ?
    for name, m in (("modele_sur_outsider", ~fav_side & (gap >= 0.05)),
                    ("modele_sur_favori", fav_side & (gap >= 0.05))):
        n = int(m.sum())
        obs = float(hit[m].mean())
        out[name] = {"n": n, "p_model": round(float(q_mod[m].mean()), 4),
                     "p_market": round(float(q_mkt[m].mean()), 4), "observed": round(obs, 4),
                     "observed_se": round(float(np.sqrt(obs * (1 - obs) / n)), 4),
                     "paired_ll_model_minus_market": paired(d_ll[m])}
        print(f"   {name} (écart ≥ 5 pts) : {out[name]}")

    top = np.argsort(-np.abs(pm - pk))[:10]
    out["largest"] = [{"date": G["date"].iat[i], "match": f"{G['home'].iat[i]} vs {G['away'].iat[i]}",
                       "p_model_home": round(float(pm[i]), 3), "p_market_home": round(float(pk[i]), 3),
                       "home_win": int(y[i]), "p_open_home": None if not np.isfinite(G["p_open"].iat[i]) else round(float(G["p_open"].iat[i]), 3),
                       "suspect_close": bool(sus[i])} for i in top]
    print("\nPlus gros désaccords :")
    for r in out["largest"]:
        print("  ", r)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(f"\nOK {OUT}")


if __name__ == "__main__":
    main()
