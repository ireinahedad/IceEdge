"""Faut-il retirer les joueurs-clés (`atk_star_power`, `atk_stars_out_weight`)
du modèle de score servi ? Test de confirmation, critère fixé AVANT le run.

D'où vient la question. L'ablation par famille (ablation_familles.py,
2026-10-18) trouve que retirer les deux variables AMÉLIORE la log-loss
moneyline de 0,00028 (z −1,1, 9 saisons sur 14) et puck line de 0,00028
(z −1,5). Non résolu, et la famille a été repérée parmi 6 sur ces mêmes
saisons : il n'y a pas de données neuves pour confirmer, donc le seuil est
corrigé pour cette sélection.

Ce que ce test ajoute à l'ablation. Il juge la chaîne SERVIE pour la
victoire : modèle de score → couche de correction (variante C de
`--correction`, réajustée en walk-forward sur les saisons < S, au moins 3).
La couche contient `star_power_diff`, calculé sur les données brutes : retirer
les variables du modèle de score ne la prive pas de cette information, ce qui
peut changer la réponse.

Variantes
  A = servi : 26 variables + couche (5 variables)
  B = 24 variables (sans les joueurs-clés) + couche (5 variables)   ← décide
  C = B + couche sans `star_power_diff` (4 variables)               ← affiché seulement

CRITÈRE (fixé le 2026-10-18, avant tout run de ce script)
  Métrique principale : log-loss moneyline de la chaîne servie, B − A, test
  apparié par match, saisons 2015-16 à 2025-26 (11 : la couche demande 3
  saisons d'historique).
  • RETIRER  si z ≤ −2,64 ET B meilleur sur ≥ 70 % des saisons ET puck line
             (modèle de score, 14 saisons) z < +2.
             2,64 = seuil bilatéral à 5 % corrigé de Bonferroni pour 6
             familles : la question vient d'une sélection parmi 6.
  • PIRE     si z ≥ +2 sur la moneyline servie ou sur la puck line.
  • sinon    NON TRANCHABLE → on GARDE (statu quo : ne pas changer le
             modèle servi sans preuve).

Puissance annoncée avant le run : erreur-type ≈ 0,00025 par match (ablation).
Si l'effet vrai vaut −0,00028, P(z ≤ −2,64) ≈ 6 %. Le résultat le plus
probable est donc NON TRANCHABLE ; l'effet minimal détectable à 80 % est
≈ (2,64 + 0,84) × 0,00025 ≈ 0,0009.

Lancer depuis ml/python :  python test_joueurs_cles.py
Sortie : ../models/key_players_test_report.json
"""
from __future__ import annotations

import json
import os
import pickle

import numpy as np
import pandas as pd

import ablation_familles as AF
import backtest_walkforward as BW
import train_score as TS

OUT = f"{BW.MODELS}/key_players_test_report.json"
CKPT = f"{BW.MODELS}/key_players_test_ckpt.pkl"
DROP_ATK = ["star_power", "stars_out_weight"]
Z_RETIRER = 2.64
SHARE = 0.70
CRITERION = {
    "fixed": "2026-10-18, avant le run",
    "primary": "log-loss moneyline de la chaîne servie (score → couche C walk-forward), B − A, apparié par match",
    "retirer_if": f"z <= -{Z_RETIRER} ET B meilleur sur >= {SHARE:.0%} des saisons ET puck line z < +2",
    "pire_if": "z >= +2 sur la moneyline servie OU sur la puck line",
    "else": "NON TRANCHABLE -> garder (statu quo)",
    "threshold_reason": "Bonferroni 6 familles (famille choisie par l'ablation sur les mêmes saisons)",
    "power_note": "se ≈ 0,00025 ; si effet vrai −0,00028, P(z <= −2,64) ≈ 6 % ; effet détectable à 80 % ≈ 0,0009",
}


def main():
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(BW.season_of)
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    seasons = [s for s in sorted(df["season"].unique())
               if 2012 <= s <= 2025 and (df["season"] < s).sum() >= 800
               and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
    base = BW.base_score_params(AF.SEARCH_TRIALS)
    variants = {"A": list(TS.ATK_COLS), "B": [c for c in TS.ATK_COLS if c not in DROP_ATK]}
    dfn = list(TS.DEF_COLS)

    P = pickle.load(open(CKPT, "rb")) if os.path.exists(CKPT) else {}
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        cut_p = int(len(prior) * 0.85)
        for v, atk in variants.items():
            if (s, v) in P:
                continue
            feats = TS.stacked_features(atk, dfn)
            params = BW.search_params_fold(prior.iloc[:cut_p].reset_index(drop=True), feats,
                                           base, AF.SEARCH_TRIALS, seed=42, season=s,
                                           use_cache=True, atk=atk, dfn=dfn)
            r = AF.eval_variant(prior, cur, atk, dfn, [], params)
            P[(s, v)] = {k: r[k] for k in ("ml", "pl", "dev", "p_ml")}
            pickle.dump(P, open(CKPT, "wb"))
        if (s, "meta") not in P:
            P[(s, "meta")] = {"y": cur["home_win"].to_numpy(float),
                              "X": BW._correction_X(cur, BW.CORRECTION_FEATURES)}
        print(f"   {s}-{str(s + 1)[2:]}  brut ML A {P[(s, 'A')]['ml'].mean():.5f}  "
              f"B {P[(s, 'B')]['ml'].mean():.5f}", flush=True)

    ll = lambda y, p: -(y * np.log(np.clip(p, 1e-6, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-6, 1)))
    i_sp = BW.CORRECTION_FEATURES.index("star_power_diff")
    layer_cols = {"A": list(range(len(BW.CORRECTION_FEATURES))),
                  "B": list(range(len(BW.CORRECTION_FEATURES))),
                  "C": [i for i in range(len(BW.CORRECTION_FEATURES)) if i != i_sp]}
    model_of = {"A": "A", "B": "B", "C": "B"}
    served = {v: [] for v in layer_cols}
    lab, by_season = [], []
    for i, s in enumerate(seasons):
        past = seasons[:i]
        if len(past) < BW.RECAL_MIN_SEASONS:
            continue
        y = P[(s, "meta")]["y"]
        row = {"season": int(s), "n": int(len(y))}
        for v, idx in layer_cols.items():
            m = model_of[v]
            y_tr = np.concatenate([P[(x, "meta")]["y"] for x in past])
            lp_tr = BW._logit(np.concatenate([P[(x, m)]["p_ml"] for x in past]))
            X_tr = np.concatenate([P[(x, "meta")]["X"] for x in past])
            mu, sd = np.nanmean(X_tr, axis=0), np.nanstd(X_tr, axis=0)
            sd[sd == 0] = 1.0
            std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
            Xtr = np.column_stack([lp_tr, std(X_tr)[:, idx]])
            Xte = np.column_stack([BW._logit(P[(s, m)]["p_ml"]), std(P[(s, "meta")]["X"])[:, idx]])
            b, _ = BW._logistic_offset(y_tr, Xtr, np.zeros(len(y_tr)))
            p2 = 1 / (1 + np.exp(-(b[0] + Xte @ b[1:])))
            served[v].append(ll(y, p2))
            row[f"ll_served_{v}"] = round(float(ll(y, p2).mean()), 5)
        lab.append(np.full(len(y), s))
        by_season.append(row)
        print(f"   {s}-{str(s + 1)[2:]}  servi A {row['ll_served_A']:.5f}  "
              f"B {row['ll_served_B']:.5f}  C {row['ll_served_C']:.5f}")

    lab = np.concatenate(lab)
    S = {v: np.concatenate(x) for v, x in served.items()}
    us = np.unique(lab)

    def compare(d, labels):
        p = BW._paired(d)
        better = [int(x) for x in np.unique(labels) if d[labels == x].mean() < 0]
        return {**p, "seasons_better": better, "share_better": round(len(better) / len(np.unique(labels)), 3)}

    ml_B = compare(S["B"] - S["A"], lab)
    ml_C = compare(S["C"] - S["A"], lab)
    lab14 = np.concatenate([np.full(len(P[(s, "A")]["pl"]), s) for s in seasons])
    raw = {k: compare(np.concatenate([P[(s, "B")][k] for s in seasons])
                      - np.concatenate([P[(s, "A")][k] for s in seasons]), lab14)
           for k in ("ml", "pl", "dev")}

    if ml_B["z"] <= -Z_RETIRER and ml_B["share_better"] >= SHARE and raw["pl"]["z"] < 2:
        verdict = "RETIRER"
    elif ml_B["z"] >= 2 or raw["pl"]["z"] >= 2:
        verdict = "PIRE"
    else:
        verdict = "NON TRANCHABLE (on garde)"

    out = {"criterion": CRITERION,
           "seasons_served": [int(x) for x in us], "seasons_raw": [int(s) for s in seasons],
           "baseline_served_ml": round(float(S["A"].mean()), 6),
           "B_vs_A_served_moneyline": ml_B,
           "C_vs_A_served_moneyline_displayed_only": ml_C,
           "B_vs_A_raw_score_model": raw,
           "by_season": by_season, "verdict": verdict}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(f"\n   Moneyline servie B − A : {ml_B['delta']:+.5f} (z {ml_B['z']:+.2f}), "
          f"B meilleur {len(ml_B['seasons_better'])}/{len(us)} saisons")
    print(f"   Moneyline servie C − A : {ml_C['delta']:+.5f} (z {ml_C['z']:+.2f})  [affiché]")
    for k, r in raw.items():
        print(f"   Modèle brut {k:>3} B − A : {r['delta']:+.5f} (z {r['z']:+.2f}), "
              f"{len(r['seasons_better'])}/{len(seasons)}")
    print(f"\n   VERDICT : {verdict}\nOK {OUT}")


if __name__ == "__main__":
    main()
