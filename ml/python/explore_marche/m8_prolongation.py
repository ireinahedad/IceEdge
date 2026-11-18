"""Le modele de prolongation vaut-il mieux qu'une constante ?

Trou releve le 2026-11-16 : la section 4.4 decrit un modele ajuste sur 3 429
prolongations, la section 7.5 s'intitule « Fin de match et prolongation » et ne
dit rien de la prolongation. Or 23 % des matchs s'y rendent, et le moneyline
s'ecrit p_reg + p_nul x p_prolongation : si ce dernier facteur est un pile ou
face pour tout le monde, un gros favori est sous-estime a chaque fois qu'il va
en prolongation.

Trois mesures, sur l'ECHANTILLON 1 (tranche de test, modeles servis) :

  1. sur les matchs reellement alles en prolongation, log-loss du modele contre
     la constante servie en repli ;
  2. effet sur le moneyline de TOUS les matchs : la chaine servie contre la
     meme chaine ou p_prolongation est remplace par la constante. C'est ce qui
     compte pour le produit ;
  3. calibration du p_prolongation par classes, et taux de nuls apres 60 min
     predit contre observe (controle de la matrice, section 4.3).

    python explore_marche/m8_prolongation.py   # -> ml/models/prolongation_report.json
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))

import backtest as B
import backtest_walkforward as BW

REPORT = f"{BW.MODELS}/prolongation_report.json"


def ll(y, p):
    p = np.clip(np.asarray(p, float), 1e-7, 1 - 1e-7)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def paired(d, seasons):
    d = np.asarray(d, float)
    pr = BW._paired(d)
    us = np.unique(seasons)
    means = np.array([d[seasons == s].mean() for s in us])
    se_s = float(means.std(ddof=1) / np.sqrt(len(us))) if len(us) > 1 else float("nan")
    return {**pr, "n_saisons": int(len(us)), "saisons_gagnees": int((means < 0).sum()),
            "z_saisons": round(float(d.mean()) / se_s, 2) if se_s > 0 else None}


def main():
    train_df, _, test = B._test_slice()
    if test is None:
        print("tranche de test indisponible"); return
    test = test.reset_index(drop=True)
    pt = B._p_score(test)
    if pt is None:
        print("modele de score indisponible"); return

    y = test["home_win"].to_numpy(float)
    seasons = np.array([int(d[:4]) - (1 if int(d[5:7]) < 8 else 0)
                        for d in test["date"].astype(str)])
    ot = test["went_to_ot"].to_numpy(float) == 1
    p_ot_model = np.asarray(pt["p_ot_used"], float)
    p_ot_const = float(pt["p_ot_const"])
    p_tie, p_reg = np.asarray(pt["tie"], float), np.asarray(pt["reg"], float)
    p_ml = np.asarray(pt["moneyline"], float)
    p_ml_const = p_reg + p_tie * p_ot_const          # la meme chaine, sans le modele

    out = {
        "question": "le modele de prolongation (4.4) bat-il la constante servie en repli ?",
        "echantillon": {"nom": "tranche de test (echantillon 1, section 6)",
                        "n": int(len(y)), "n_prolongations": int(ot.sum()),
                        "periode": [str(test["date"].min()), str(test["date"].max())]},
        "constante": round(p_ot_const, 4),
        "modele_utilise": pt["ot_model"] is not None,
    }

    # ── 1. sur les prolongations seules ─────────────────────────────────────
    if ot.sum() >= 50:
        d = ll(y[ot], p_ot_model[ot]) - ll(y[ot], np.full(int(ot.sum()), p_ot_const))
        out["prolongations_seules"] = {
            "n": int(ot.sum()),
            "ll_modele": round(float(ll(y[ot], p_ot_model[ot]).mean()), 5),
            "ll_constante": round(float(ll(y[ot], np.full(int(ot.sum()), p_ot_const)).mean()), 5),
            "domicile_gagne_pct": round(float(y[ot].mean()) * 100, 1),
            **paired(d, seasons[ot])}

    # ── 2. effet sur le moneyline de tous les matchs ────────────────────────
    d_all = ll(y, p_ml) - ll(y, p_ml_const)
    out["moneyline_tous_matchs"] = {
        "n": int(len(y)),
        "ll_chaine_servie": round(float(ll(y, p_ml).mean()), 5),
        "ll_avec_constante": round(float(ll(y, p_ml_const).mean()), 5),
        **paired(d_all, seasons)}

    # ── 3. calibration du p_prolongation, et taux de nuls ───────────────────
    bins = [0.40, 0.45, 0.50, 0.55, 0.60, 1.01]
    classes = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = ot & (p_ot_model >= lo) & (p_ot_model < hi)
        if m.sum() < 20:
            continue
        obs = float(y[m].mean())
        classes.append({"classe": f"{lo:.0%}-{hi:.0%}", "n": int(m.sum()),
                        "predit": round(float(p_ot_model[m].mean()), 4),
                        "observe": round(obs, 4),
                        "observe_se": round(float(np.sqrt(obs * (1 - obs) / m.sum())), 4)})
    out["calibration"] = classes
    out["nuls_apres_60_min"] = {
        "predit_pct": round(float(p_tie.mean()) * 100, 2),
        "observe_pct": round(float(ot.mean()) * 100, 2),
        "n": int(len(y))}

    print(f"   Tranche de test : {out['echantillon']['n']} matchs, "
          f"{out['echantillon']['n_prolongations']} prolongations "
          f"({100*ot.mean():.1f} %)")
    print(f"   Constante servie en repli : {p_ot_const:.4f}")
    if "prolongations_seules" in out:
        p = out["prolongations_seules"]
        print(f"\n   1. Sur les prolongations seules ({p['n']}) : modele "
              f"{p['ll_modele']:.5f} contre {p['ll_constante']:.5f} "
              f"(ecart {p['delta']:+.5f}, z {p['z']:+.2f} par match, "
              f"{p['z_saisons']:+.2f} par saison, {p['saisons_gagnees']}/{p['n_saisons']} saisons). "
              f"Le domicile gagne {p['domicile_gagne_pct']:.1f} % de ces matchs.")
    m = out["moneyline_tous_matchs"]
    print(f"   2. Moneyline, tous les matchs ({m['n']}) : {m['ll_chaine_servie']:.5f} "
          f"contre {m['ll_avec_constante']:.5f} avec la constante "
          f"(ecart {m['delta']:+.5f}, z {m['z']:+.2f})")
    print(f"   3. Calibration du p_prolongation :")
    for c in classes:
        print(f"      {c['classe']:>9} n {c['n']:>5} predit {c['predit']:.1%} "
              f"observe {c['observe']:.1%} (+/- {c['observe_se']*100:.1f})")
    n = out["nuls_apres_60_min"]
    print(f"   Nuls apres 60 min : {n['predit_pct']:.2f} % predits pour "
          f"{n['observe_pct']:.2f} % observes")

    BW._dump_json_atomic(out, REPORT)
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    main()
