"""Un seul jeu d'echantillons, une seule generation, pour toute la section 7.

Probleme releve le 2026-11-16 : la section 7 donne la taille du test comme
4 305, 4 197, 4 331, 4 320, 4 304 ou 4 201 matchs selon le tableau, et les
matchs cotes comme 3 932, 4 016 ou 4 018. Deux causes, qu'il faut separer :

  1. DEUX EVALUATIONS differentes, ce qui est legitime mais n'est jamais dit.
     • Tranche de test : les modeles SERVIS (fichiers sur disque, entraines sur
       la tranche d'entrainement) appliques aux 20 % finaux du jeu de donnees.
       C'est ce que mesurent 7.1, 7.5 et 7.7.
     • Walk-forward : un modele reentraine par saison sur les seules saisons
       anterieures. C'est ce que mesurent 7.2, 7.3 et 7.8.
  2. DES GENERATIONS melangees : un tableau d'avant le reentrainement du
     1er novembre, des coupures de date ad hoc (`test_paires_71.CUTOFF`), des
     sous-ensembles differents selon la disponibilite des cotes.

Ce script fixe les deux echantillons une fois, les mesure avec la generation
courante, et sort tout ce dont la section 7 a besoin. Toute taille de la
section 7 doit ensuite venir de ce rapport.

Une correction au passage : la ligne « Modele de score (servi) » de 7.1 ne
mesure PAS la chaine servie mais le modele de score BRUT (`backtest._p_score`
n'applique pas la couche de correction). La chaine servie ne peut pas etre
mesuree honnetement sur la tranche de test, parce que la couche servie a ete
ajustee sur les predictions hors echantillon de toutes les saisons, celles du
test comprises : elle se juge en walk-forward (echantillon 2).

    python explore_marche/m6_echantillons.py   # -> ml/models/echantillons_report.json
"""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))

import backtest as B
import backtest_walkforward as BW

OUT = os.path.join(HERE, "out")
REPORT = f"{BW.MODELS}/echantillons_report.json"
NEED = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
MIN_PAST = BW.RECAL_MIN_SEASONS


def ll_each(y, p):
    p = np.clip(np.asarray(p, float), 1e-7, 1 - 1e-7)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def metrics(y, p):
    p = np.asarray(p, float)
    pick = np.where(p > 0.5, 1.0, np.where(p < 0.5, 0.0, np.nan))
    acc = float(np.nanmean((pick == y).astype(float))) if np.isfinite(pick).any() else None
    return {"n": int(len(y)), "log_loss": round(float(ll_each(y, p).mean()), 5),
            "brier": round(float(np.mean((p - y) ** 2)), 5),
            "bons_choix_pct": round(acc * 100, 1) if acc is not None else None}


def paired(d, seasons):
    d = np.asarray(d, float)
    pr = BW._paired(d)
    us = np.unique(seasons)
    m_s = np.array([d[seasons == s].mean() for s in us])
    se_s = float(m_s.std(ddof=1) / np.sqrt(len(us))) if len(us) > 1 else float("nan")
    return {**pr, "n_seasons": int(len(us)),
            "seasons_better": int((m_s < 0).sum()),
            "z_seasons": round(float(d.mean()) / se_s, 2) if se_s > 0 else None}


def season_of_dates(dates):
    return np.array([int(d[:4]) - (1 if int(d[5:7]) < 8 else 0) for d in dates])


# ── Echantillon 1 : la tranche de test, modeles servis ──────────────────────
def echantillon_test():
    train_df, valid, test = B._test_slice()
    if test is None:
        print("   tranche de test indisponible"); return None
    test = test.reset_index(drop=True)
    y = test["home_win"].to_numpy(float)
    seasons = season_of_dates(test["date"].astype(str).to_numpy())
    P = {"modele de score (brut)": B._p_score(test)["moneyline"],
         "classifieur (cotes masquees)": B._p_classifier(test, mask_market=True)[0],
         "ELO seul": test["elo_expected"].to_numpy(float),
         "probabilite constante": np.full(len(y), float(train_df["home_win"].mean()))}
    ok = np.all([np.isfinite(np.asarray(v, float)) for v in P.values()], axis=0)
    y, seasons = y[ok], seasons[ok]
    P = {k: np.asarray(v, float)[ok] for k, v in P.items()}
    pk = test["market_home_p_close"].to_numpy(float)[ok]
    mk = np.isfinite(pk)
    src = (test["source"].fillna("sbro").astype(str).to_numpy()[ok]
           if "source" in test else np.full(len(y), "sbro"))

    out = {"definition": "20 % finaux du jeu de donnees, tries par date ; modeles "
                         "SERVIS (entraines sur la tranche d'entrainement), aucune "
                         "coupure de date",
           "n": int(len(y)), "n_cotes": int(mk.sum()),
           "periode": [str(test["date"].min()), str(test["date"].max())],
           "n_ecartes_faute_de_probabilite": int((~ok).sum()),
           "modeles": {}, "apparies_contre_score": {}, "marche": {}}
    for k, v in P.items():
        out["modeles"][k] = metrics(y, v)
    out["modeles"]["toujours le domicile"] = {
        "n": int(len(y)), "log_loss": None, "brier": None,
        "bons_choix_pct": round(float(y.mean()) * 100, 1)}
    L = {k: ll_each(y, v) for k, v in P.items()}
    base = L["modele de score (brut)"]
    for k in P:
        if k == "modele de score (brut)":
            continue
        out["apparies_contre_score"][k] = paired(base - L[k], seasons)
    if mk.sum() > 100:
        Lm = ll_each(y[mk], pk[mk])
        out["marche"] = {
            "n": int(mk.sum()),
            "log_loss_marche": round(float(Lm.mean()), 5),
            "log_loss_score_memes_matchs": round(float(base[mk].mean()), 5),
            "log_loss_elo_memes_matchs": round(float(L["ELO seul"][mk].mean()), 5),
            "score_moins_marche": paired(base[mk] - Lm, seasons[mk]),
            "elo_moins_marche": paired(L["ELO seul"][mk] - Lm, seasons[mk]),
            "par_source": {str(s): int((src[mk] == s).sum()) for s in np.unique(src[mk])}}
    return out


# ── Echantillon 2 : walk-forward, matchs cotes ──────────────────────────────
def echantillon_walkforward():
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(BW.season_of)
    seasons = [s for s in sorted(df["season"].unique())
               if s >= 2012 and (df["season"] < s).sum() >= 800
               and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
    P = {}
    for s in seasons:
        f = os.path.join(OUT, f"oos_{s}.npz")
        if not os.path.exists(f):
            print(f"   manque {os.path.basename(f)} — lancer m1_melange.py"); return None
        z = np.load(f, allow_pickle=True)
        P[s] = {"p": z["p"], "y": z["y"], "X": z["X"], "pk": z["pk"],
                "src": z["src"].astype(str)}
    ks = sorted(P)
    served, rows = {}, []
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
        served[s] = 1 / (1 + np.exp(-(b[0] + np.column_stack(
            [BW._logit(P[s]["p"]), std(P[s]["X"])]) @ b[1:])))
    sk = sorted(served)
    acc = {k: [] for k in ("y", "brut", "servi", "marche", "melange", "src", "saison")}
    for i, s in enumerate(sk):
        past = sk[:i]
        ok = np.isfinite(P[s]["pk"])
        if not ok.any():
            continue
        # melange walk-forward : ajuste sur les matchs cotes des saisons passees
        p_mel = None
        if len(past) >= MIN_PAST:
            ytr, mtr, ktr = [], [], []
            for x in past:
                o = np.isfinite(P[x]["pk"])
                if o.any():
                    ytr.append(P[x]["y"][o]); mtr.append(served[x][o]); ktr.append(P[x]["pk"][o])
            if ytr and sum(len(v) for v in ytr) >= 500:
                ytr = np.concatenate(ytr)
                bb, _ = BW._logistic_offset(
                    ytr, np.column_stack([BW._logit(np.concatenate(mtr)),
                                          BW._logit(np.concatenate(ktr))]),
                    np.zeros(len(ytr)))
                p_mel = 1 / (1 + np.exp(-(bb[0] + np.column_stack(
                    [BW._logit(served[s][ok]), BW._logit(P[s]["pk"][ok])]) @ bb[1:])))
        if p_mel is None:
            continue
        acc["y"].append(P[s]["y"][ok]); acc["brut"].append(P[s]["p"][ok])
        acc["servi"].append(served[s][ok]); acc["marche"].append(P[s]["pk"][ok])
        acc["melange"].append(p_mel); acc["src"].append(P[s]["src"][ok])
        acc["saison"].append(np.full(int(ok.sum()), s))
        rows.append({"saison": int(s), "n": int(ok.sum())})
    A = {k: np.concatenate(v) for k, v in acc.items()}
    y, sea = A["y"], A["saison"]
    out = {"definition": "matchs cotes des saisons predites en walk-forward strict, "
                         "couche de correction et poids du melange ajustes sur les "
                         "seules saisons anterieures",
           "n": int(len(y)), "saisons": [int(s) for s in np.unique(sea)],
           "par_saison": rows, "modeles": {}, "apparies_contre_marche": {}, "par_source": {}}
    names = {"modele brut": "brut", "chaine servie": "servi",
             "marche (cloture devigee)": "marche", "melange servi + marche": "melange"}
    for label, key in names.items():
        out["modeles"][label] = metrics(y, A[key])
    Lm = ll_each(y, A["marche"])
    for label, key in names.items():
        if key == "marche":
            continue
        out["apparies_contre_marche"][label] = paired(ll_each(y, A[key]) - Lm, sea)
    for s in np.unique(A["src"]):
        m = A["src"] == s
        if m.sum() < 50:
            continue
        out["par_source"][str(s)] = {
            "n": int(m.sum()),
            **{label: metrics(y[m], A[key][m])["log_loss"] for label, key in names.items()},
            "servi_moins_marche_z": paired(ll_each(y[m], A["servi"][m]) - Lm[m], sea[m])["z"]}
    return out


def main():
    res = {"question": "un seul jeu d'echantillons et une seule generation pour la section 7",
           "genere_le": pd.Timestamp.utcnow().strftime("%Y-%m-%d"),
           "xgboost": __import__("xgboost").__version__}
    print("== Echantillon 1 : tranche de test, modeles servis ==")
    e1 = echantillon_test()
    if e1:
        res["tranche_de_test"] = e1
        print(f"   n {e1['n']} ({e1['periode'][0]} -> {e1['periode'][1]}), "
              f"{e1['n_cotes']} cotes, {e1['n_ecartes_faute_de_probabilite']} ecartes")
        print(f"   {'modele':<30} {'log-loss':>9} {'Brier':>8} {'bons choix':>11}")
        for k, m in e1["modeles"].items():
            f_ll = "%.5f" % m["log_loss"] if m["log_loss"] is not None else "-"
            f_br = "%.4f" % m["brier"] if m["brier"] is not None else "-"
            f_ac = ("%.1f %%" % m["bons_choix_pct"]) if m["bons_choix_pct"] is not None else "-"
            print(f"   {k:<30} {f_ll:>9} {f_br:>8} {f_ac:>11}")
        print("   apparies (score brut - baseline, negatif = score meilleur) :")
        for k, r in e1["apparies_contre_score"].items():
            print(f"     {k:<30} {r['delta']:+.5f} z {r['z']:+.2f} (saison {r['z_seasons']}) "
                  f"{r['seasons_better']}/{r['n_seasons']}")
        if e1["marche"]:
            mm = e1["marche"]
            print(f"   marche ({mm['n']} matchs) : {mm['log_loss_marche']:.5f} ; score "
                  f"{mm['log_loss_score_memes_matchs']:.5f} (z "
                  f"{mm['score_moins_marche']['z']:+.2f}) ; ELO "
                  f"{mm['log_loss_elo_memes_matchs']:.5f} (z {mm['elo_moins_marche']['z']:+.2f})")
    print("\n== Echantillon 2 : walk-forward, matchs cotes ==")
    e2 = echantillon_walkforward()
    if e2:
        res["walk_forward_cotes"] = e2
        print(f"   n {e2['n']}, saisons {e2['saisons'][0]} -> {e2['saisons'][-1]}")
        print(f"   {'modele':<28} {'log-loss':>9} {'Brier':>8} {'bons choix':>11}")
        for k, m in e2["modeles"].items():
            print(f"   {k:<28} {m['log_loss']:>9.5f} {m['brier']:>8.4f} "
                  f"{m['bons_choix_pct']:>10.1f} %")
        print("   apparies contre le marche (negatif = mieux que le marche) :")
        for k, r in e2["apparies_contre_marche"].items():
            print(f"     {k:<28} {r['delta']:+.5f} z {r['z']:+.2f} (saison {r['z_seasons']}) "
                  f"{r['seasons_better']}/{r['n_seasons']}")
        for s, blk in e2["par_source"].items():
            print(f"   [{s}] n {blk['n']} brut {blk['modele brut']:.5f} servi "
                  f"{blk['chaine servie']:.5f} marche {blk['marche (cloture devigee)']:.5f} "
                  f"melange {blk['melange servi + marche']:.5f} (servi-marche z "
                  f"{blk['servi_moins_marche_z']:+.2f})")
    BW._dump_json_atomic(res, REPORT)
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    main()
