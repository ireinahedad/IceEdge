"""Section 7.1 du document technique : les gains du modèle de score sur les
baselines sont-ils significatifs ? Test APPARIÉ par match, comme en 6.4.

Même tranche de test que `backtest.py --reliability` (20 % finaux, triés par
date, jamais vus par aucun modèle). Pour chaque match, on calcule la
log-loss moneyline de chaque prédicteur ; la différence score − baseline est
moyennée, avec son erreur-type (z = moyenne / erreur-type). Négatif = le
modèle de score fait mieux.

Prédicteurs :
- score       : modèle de score servi (`backtest._p_score`)
- constante   : taux de victoire domicile du train
- elo         : `elo_expected` (probabilité ELO avant match)
- classifieur : XGBoost + Platt (`backtest._p_classifier`), cotes masquées
                (information égale) ET non masquées (ligne « avec cotes »)
- marché      : clôture dé-viggée, sur les seuls matchs cotés

Contrôle : chaque log-loss moyenne doit retomber sur le tableau 7.1
(training_report.json / reliability_report.json).

Le test est aussi fait par saison (z sur les moyennes de saison) : les matchs
d'une même saison partagent des chocs communs, l'erreur-type par match peut
être trop optimiste.

Lancer depuis ml/python : python test_paires_71.py
Sortie : ../models/paired_baselines_report.json
"""
from __future__ import annotations

import json

import numpy as np

import backtest as B

OUT = f"{B.MODELS}/paired_baselines_report.json"
CUTOFF = "2026-08-01"


def ll_each(y, p):
    p = np.clip(np.asarray(p, float), 1e-7, 1 - 1e-7)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def paired(d, seasons):
    n = len(d)
    mean = float(d.mean())
    se = float(d.std(ddof=1) / np.sqrt(n))
    us = np.unique(seasons)
    m_s = np.array([d[seasons == s].mean() for s in us])
    se_s = float(m_s.std(ddof=1) / np.sqrt(len(us))) if len(us) > 1 else float("nan")
    return {"n": n, "delta": round(mean, 5), "se": round(se, 5), "z": round(mean / se, 2),
            "ic95": [round(mean - 1.96 * se, 5), round(mean + 1.96 * se, 5)],
            "by_season": {str(int(s)): round(float(x), 5) for s, x in zip(us, m_s)},
            "seasons_better": int((m_s < 0).sum()), "n_seasons": int(len(us)),
            "z_seasons": round(mean / se_s, 2) if se_s > 0 else None}


def main():
    train_df, _, test = B._test_slice()
    # Le tableau 7.1 a été mesuré avant le début de la saison 2026-27 : on
    # retire les matchs joués depuis (dataset reconstruit le 2026-10-12).
    test = test[test["date"] < CUTOFF].reset_index(drop=True)
    y = test["home_win"].to_numpy(float)
    seasons = test["date"].map(lambda d: int(d[:4]) - (1 if int(d[5:7]) < 8 else 0)).to_numpy()

    pt = B._p_score(test)
    p = {"score": pt["moneyline"]}
    p["constante"] = np.full(len(y), float(train_df["home_win"].mean()))
    p["elo"] = test["elo_expected"].to_numpy(float)
    p["classifieur_masque"], _ = B._p_classifier(test, mask_market=True)
    p["classifieur_cotes"], _ = B._p_classifier(test, mask_market=False)

    ok = np.all([np.isfinite(v) for v in p.values()], axis=0)
    print(f"Test : {len(y)} matchs ({test['date'].min()} → {test['date'].max()}), "
          f"{int((~ok).sum())} écartés faute de probabilité")
    y, seasons = y[ok], seasons[ok]
    p = {k: v[ok] for k, v in p.items()}
    L = {k: ll_each(y, v) for k, v in p.items()}
    pk = test["market_home_p_close"].to_numpy(float)[ok]
    mk = np.isfinite(pk)

    out = {"n_test": int(len(y)), "period": [test["date"].min(), test["date"].max()],
           "log_loss": {k: round(float(v.mean()), 5) for k, v in L.items()},
           "paired_score_minus": {}}
    print("\nLog-loss moyennes (contrôle contre le tableau 7.1) :")
    for k, v in L.items():
        print(f"   {k:<20} {v.mean():.5f}")
    print("\nScore − baseline (négatif = score meilleur) :")
    for k in ("constante", "elo", "classifieur_masque", "classifieur_cotes"):
        r = paired(L["score"] - L[k], seasons)
        out["paired_score_minus"][k] = r
        print(f"   {k:<20} {r['delta']:+.5f} ± {r['se']:.5f}  z {r['z']:+.2f}   "
              f"saisons {r['seasons_better']}/{r['n_seasons']}  z saisons {r['z_seasons']}")
    if mk.sum() > 100:
        L_m = ll_each(y[mk], pk[mk])
        out["market"] = {"n": int(mk.sum()), "ll_market": round(float(L_m.mean()), 5),
                         "ll_score_same_games": round(float(L["score"][mk].mean()), 5),
                         "ll_elo_same_games": round(float(L["elo"][mk].mean()), 5)}
        for k in ("score", "elo"):
            r = paired(L[k][mk] - L_m, seasons[mk])
            out["paired_score_minus"][f"marche_vs_{k}"] = r
            print(f"   {k} − marché ({mk.sum()} matchs cotés) {r['delta']:+.5f} ± {r['se']:.5f}  "
                  f"z {r['z']:+.2f}  saisons {r['seasons_better']}/{r['n_seasons']}")
        print(f"   log-loss sur ces matchs : marché {L_m.mean():.5f}, score "
              f"{L['score'][mk].mean():.5f}, elo {L['elo'][mk].mean():.5f}")
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(f"\nOK {OUT}")


if __name__ == "__main__":
    main()
