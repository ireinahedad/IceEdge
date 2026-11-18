"""Les desaccords de 5 a 10 points sont-ils rentables ? (sections 7.3 contre 7.4)

Contradiction relevee le 2026-11-16. La section 7.3 dit que, entre 5 et 10 points
de desaccord, le cote prefere par le modele gagne 56,7 % des matchs quand la
cloture annonce 52,7 % : 4 points d'ecart, soit plus de 4 erreurs-types. Avec une
marge d'environ 2 points par cote, cela devrait etre rentable. La section 7.4
conclut pourtant a un rendement nul.

Deux explications possibles, qui se distinguent par le PRIX et par ce qui sert a
SELECTIONNER :

  7.3 selectionne sur le desaccord avec la CLOTURE. Miser dessus suppose de
      connaitre la cloture : ce n'est pas une strategie, c'est un diagnostic.
  7.4 selectionne sur l'edge contre l'OUVERTURE et mise a l'ouverture. C'est
      executable, et c'est ce qui compte pour la rentabilite.

Le script mesure les deux, par tranche de desaccord, avec les VRAIS prix
decimaux du jeu de donnees :

  - desaccord avec la cloture -> rendement AU PRIX DE CLOTURE (diagnostic) ;
  - desaccord avec l'ouverture -> rendement AU PRIX D'OUVERTURE (executable).

Aucun entrainement : rejoue les predictions hors echantillon mises en cache par
m1_melange.py et refait la couche de correction en walk-forward.

    python explore_marche/m4_desaccord_roi.py   # -> ml/models/desaccord_roi_report.json
"""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))

import backtest_walkforward as BW
import train_score as TS

OUT = os.path.join(HERE, "out")
REPORT = f"{BW.MODELS}/desaccord_roi_report.json"
NEED = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
MIN_PAST = BW.RECAL_MIN_SEASONS
BUCKETS = [(0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 1.01)]


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def build():
    """Reconstruit, saison par saison, les predictions servies et les prix."""
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(BW.season_of)
    seasons = [s for s in sorted(df["season"].unique())
               if s >= 2012 and (df["season"] < s).sum() >= 800
               and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
    P, frames = {}, {}
    for s in seasons:
        f = os.path.join(OUT, f"oos_{s}.npz")
        if not os.path.exists(f):
            print(f"   manque {os.path.basename(f)} — lancer m1_melange.py"); return None
        z = np.load(f, allow_pickle=True)
        cur = df[df["season"] == s].dropna(subset=NEED).reset_index(drop=True)
        if len(cur) != len(z["p"]):
            print(f"   cache desaligne pour {s} : {len(cur)} contre {len(z['p'])}"); return None
        P[s] = {"p": z["p"], "y": z["y"], "X": z["X"], "pk": z["pk"]}
        frames[s] = cur
    # couche de correction, walk-forward strict (identique a m1_melange)
    ks = sorted(P)
    rows = []
    for i, s in enumerate(ks):
        past = ks[:i]
        if len(past) < MIN_PAST:
            continue
        y_tr = np.concatenate([P[x]["y"] for x in past])
        lp_tr = BW._logit(np.concatenate([P[x]["p"] for x in past]))
        X_tr = np.concatenate([P[x]["X"] for x in past])
        mu, sd = np.nanmean(X_tr, axis=0), np.nanstd(X_tr, axis=0)
        sd[sd == 0] = 1.0
        std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
        b, _ = BW._logistic_offset(y_tr, np.column_stack([lp_tr, std(X_tr)]),
                                   np.zeros(len(y_tr)))
        lp = BW._logit(P[s]["p"])
        p_srv = 1 / (1 + np.exp(-(b[0] + np.column_stack([lp, std(P[s]["X"])]) @ b[1:])))
        cur = frames[s]
        rows.append(pd.DataFrame({
            "season": s, "date": cur["date"].values, "game_id": cur["game_id"].values,
            "p_srv": p_srv, "home_win": P[s]["y"],
            "p_close": P[s]["pk"],
            "p_open": (cur["market_home_p_open"].to_numpy(float)
                       if "market_home_p_open" in cur else np.nan),
            "ml_close_h": (cur["home_ml_close"].to_numpy(float)
                           if "home_ml_close" in cur else np.nan),
            "ml_close_a": (cur["away_ml_close"].to_numpy(float)
                           if "away_ml_close" in cur else np.nan),
            "ml_open_h": (cur["home_ml_open"].to_numpy(float)
                          if "home_ml_open" in cur else np.nan),
            "ml_open_a": (cur["away_ml_open"].to_numpy(float)
                          if "away_ml_open" in cur else np.nan),
            "source": (cur["source"].fillna("sbro").astype(str).values
                       if "source" in cur else "sbro")}))
    return pd.concat(rows, ignore_index=True)


def side_table(G, p_ref_col, dec_h_col, dec_a_col, label):
    """Oriente chaque match vers le cote prefere par le modele, puis par tranche."""
    g = G.dropna(subset=[p_ref_col, dec_h_col, dec_a_col]).copy()
    g = g[(g[dec_h_col] > 1) & (g[dec_a_col] > 1)]
    home = g["p_srv"] >= g[p_ref_col]
    g["p_model"] = np.where(home, g["p_srv"], 1 - g["p_srv"])
    g["p_market"] = np.where(home, g[p_ref_col], 1 - g[p_ref_col])
    g["dec"] = np.where(home, g[dec_h_col], g[dec_a_col])
    g["won"] = np.where(home, g["home_win"] > 0.5, g["home_win"] < 0.5)
    g["gap"] = g["p_model"] - g["p_market"]
    out = {"label": label, "n": int(len(g)), "buckets": []}
    for lo, hi in BUCKETS:
        m = (g["gap"] >= lo) & (g["gap"] < hi)
        if m.sum() < 20:
            continue
        sub = g[m]
        ret = np.where(sub["won"], sub["dec"] - 1.0, -1.0)
        roi = float(ret.mean()) * 100
        se = float(ret.std(ddof=1) / np.sqrt(len(ret))) * 100
        obs = float(sub["won"].mean())
        d = ll(sub["won"].astype(float).to_numpy(), sub["p_model"].to_numpy()) \
            - ll(sub["won"].astype(float).to_numpy(), sub["p_market"].to_numpy())
        pr = BW._paired(d)
        out["buckets"].append({
            "bucket": f"{lo:.0%}-{hi:.0%}" if hi <= 1 else f"{lo:.0%}+",
            "n": int(m.sum()), "p_model": round(obs * 0 + float(sub["p_model"].mean()), 4),
            "p_market": round(float(sub["p_market"].mean()), 4),
            "observe": round(obs, 4),
            "observe_se": round(float(np.sqrt(obs * (1 - obs) / len(sub))), 4),
            "cote_moyenne": round(float(sub["dec"].mean()), 3),
            "roi_pct": round(roi, 2), "roi_se_pct": round(se, 2),
            "roi_z": round(roi / se, 2) if se else None,
            "paired_ll_modele_moins_marche": pr})
    return out


def main():
    G = build()
    if G is None:
        return
    print(f"   {len(G)} matchs predits (chaine servie, walk-forward)")
    res = {
        "question": ("les desaccords de 5 a 10 points de la section 7.3 sont-ils "
                     "rentables, et pourquoi 7.4 ne le voit pas ?"),
        "protocol": {
            "chaine": "modele de score + couche de correction, walk-forward strict "
                      "(cache de m1_melange.py)",
            "diagnostic": "desaccord avec la CLOTURE, rendement au prix de CLOTURE : "
                          "non executable (il faut connaitre la cloture pour selectionner)",
            "executable": "desaccord avec l'OUVERTURE, rendement au prix d'OUVERTURE : "
                          "c'est la mesure de la section 7.4",
            "mise": "a plat, 1 unite par pari ; cote decimale reelle du jeu de donnees",
            "signe": "paired_ll negatif = le modele fait mieux que le marche",
        },
        "tables": [],
    }
    for args in [("p_close", "ml_close_h", "ml_close_a",
                  "desaccord avec la cloture, mise a la cloture (diagnostic)"),
                 ("p_open", "ml_open_h", "ml_open_a",
                  "desaccord avec l'ouverture, mise a l'ouverture (executable)"),
                 ("p_close", "ml_open_h", "ml_open_a",
                  "desaccord avec la cloture, mise a l'ouverture (ni l'un ni l'autre)")]:
        t = side_table(G, *args)
        res["tables"].append(t)
        print(f"\n   {t['label']} — {t['n']} paris possibles")
        print(f"   {'tranche':>10} {'paris':>6} {'modele':>8} {'marche':>8} "
              f"{'observe':>9} {'cote':>6} {'ROI':>9} {'z':>6} {'ll m-m':>9} {'z':>6}")
        for b in t["buckets"]:
            pr = b["paired_ll_modele_moins_marche"]
            print(f"   {b['bucket']:>10} {b['n']:>6} {b['p_model']:>7.1%} "
                  f"{b['p_market']:>7.1%} {b['observe']:>7.1%}±{b['observe_se']*100:>3.1f} "
                  f"{b['cote_moyenne']:>6.2f} {b['roi_pct']:>+8.2f}% {b['roi_z']:>+6.2f} "
                  f"{pr['delta']:>+9.4f} {pr['z']:>+6.2f}")
    BW._dump_json_atomic(res, REPORT)
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    main()
