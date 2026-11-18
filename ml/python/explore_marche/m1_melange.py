"""Le melange modele (+) marche bat-il la cote de cloture ? Test apparie, walk-forward.

Question posee le 2026-11-16 (commentaire de la section 7.2 du document technique) :
le 0,6641 du melange contre 0,6649 de la cloture n'avait jamais ete teste par
paires, et il portait sur la seule tranche de test avec des poids ajustes sur une
validation. Ici, protocole strict :

  pour chaque saison S (>= 2012, au moins 800 matchs avant elle) :
    1. modele de score entraine sur les saisons < S            -> p_brut(S)
    2. couche de correction (5 variables, variante C) ajustee sur les saisons
       < S (au moins 3)                                        -> p_servi(S)
    3. melange : logistique sur [logit p_servi, logit p_cloture], ajustee sur
       les matchs COTES des saisons dont le p_servi est deja hors echantillon
       (au moins 3 saisons)                                    -> p_melange(S)
  puis test apparie par match sur les matchs cotes de toutes les saisons S.

Critere fixe AVANT le run : le melange bat la cloture si l'ecart de log-loss est
negatif avec z <= -2 (apparie, par match) ET un gain sur >= 70 % des saisons.
Le z par saison est donne a cote : les matchs d'une meme saison partagent des
chocs, le z par match est donc optimiste.

Ce que ce test dit et ne dit pas. Il ne decrit PAS une strategie de pari : le
melange lit la cote de cloture, qu'on ne connait pas au moment de miser. Il
repond a une seule question : le modele porte-t-il de l'information que la
cloture n'a pas ? Si oui, l'ajouter a la cloture doit ameliorer la cloture.

    python explore_marche/m1_melange.py        # -> ml/models/melange_marche_report.json
"""
import json, os, sys, time
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))

import backtest_walkforward as BW
import train_score as TS

OUT = os.path.join(HERE, "out")
REPORT = f"{BW.MODELS}/melange_marche_report.json"
MIN_PAST = BW.RECAL_MIN_SEASONS          # 3 saisons de passe minimum
SHARE = BW.RECENCY_SEASON_SHARE          # 0.70


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def fit_logistic(y, X):
    """Logistique sans offset ; renvoie (intercept, coefs)."""
    b, _ = BW._logistic_offset(np.asarray(y, float), np.asarray(X, float),
                              np.zeros(len(y)))
    return b


def apply_logistic(b, X):
    X = np.asarray(X, float)
    return 1.0 / (1.0 + np.exp(-(b[0] + X @ b[1:])))


def season_stats(delta, seasons):
    """Apparie par match + par saison, sur le meme vecteur d'ecarts."""
    pr = BW._paired(np.asarray(delta, float))
    uniq = np.unique(seasons)
    means = np.array([delta[seasons == s].mean() for s in uniq])
    se_s = float(means.std(ddof=1) / np.sqrt(len(means))) if len(means) > 1 else float("nan")
    better = [int(s) for s in uniq if delta[seasons == s].mean() < 0]
    return {**pr,
            "z_seasons": round(float(delta.mean()) / se_s, 2) if se_s else None,
            "n_seasons": int(len(uniq)),
            "seasons_better": better,
            "share_seasons_better": round(len(better) / len(uniq), 3)}


def main():
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(BW.season_of)
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    seasons = [s for s in sorted(df["season"].unique())
               if s >= 2012 and (df["season"] < s).sum() >= 800
               and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
    atk, dfn = list(TS.ATK_COLS), list(TS.DEF_COLS)
    base = BW.base_score_params(8)

    # ── Etape 1 : predictions hors echantillon du modele de score ───────────
    # Mise en cache par saison (out/oos_<saison>.npz) : le shell de la machine
    # coupe un appel a 180 s, donc le script s'arrete avant le budget et se
    # relance jusqu'a ce que toutes les saisons soient la.
    budget = float(os.environ.get("BUDGET", "135"))
    t_start = time.time()
    P, manquantes = {}, []
    print(f"   {len(seasons)} saisons a predire (budget {budget:.0f}s)")
    for s in seasons:
        f = os.path.join(OUT, f"oos_{s}.npz")
        if os.path.exists(f):
            z = np.load(f, allow_pickle=True)
            P[s] = {"p": z["p"], "y": z["y"], "X": z["X"], "pk": z["pk"],
                    "src": z["src"].astype(str)}
            continue
        if time.time() - t_start > budget:
            manquantes.append(s)
            continue
        t0 = time.time()
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = BW.search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                       TS.stacked_features(atk, dfn), base, 8,
                                       seed=42, season=s, use_cache=True,
                                       atk=atk, dfn=dfn)
        r = BW._eval_v2(prior, cur, atk, dfn, params, use_gamma=False)
        P[s] = {"p": np.asarray(r["p_ml"], float),
                "y": cur["home_win"].to_numpy(float),
                "X": BW._correction_X(cur, BW.CORRECTION_FEATURES),
                "pk": (cur["market_home_p_close"].to_numpy(float)
                       if "market_home_p_close" in cur
                       else np.full(len(cur), np.nan)),
                "src": (cur["source"].fillna("sbro").astype(str).to_numpy()
                        if "source" in cur else np.full(len(cur), "sbro"))}
        np.savez(f, **P[s])
        n_mkt = int(np.isfinite(P[s]["pk"]).sum())
        print(f"   {s}-{str(s+1)[2:]:<2} {len(cur):>6} matchs, {n_mkt:>6} cotes "
              f"({time.time()-t0:.0f}s)", flush=True)
    if manquantes:
        print(f"\n   INCOMPLET : {len(manquantes)} saisons restantes "
              f"({manquantes[0]}...{manquantes[-1]}) — relancer le script")
        return

    ks = sorted(P)

    # ── Etape 2 : couche de correction walk-forward -> p_servi ──────────────
    served = {}
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
        b = fit_logistic(y_tr, np.column_stack([lp_tr, std(X_tr)]))
        served[s] = apply_logistic(b, np.column_stack([BW._logit(P[s]["p"]),
                                                       std(P[s]["X"])]))
    sk = sorted(served)
    print(f"\n   couche de correction : {len(sk)} saisons servies "
          f"({sk[0]}-{sk[-1]})" if sk else "\n   aucune saison servie")

    # ── Etape 3 : melange walk-forward, puis tests apparies ────────────────
    rows, out_delta = [], {k: [] for k in
                           ("melange_vs_marche", "servi_vs_marche",
                            "melange_vs_servi", "moitie_vs_marche",
                            "brut_vs_marche")}
    S_lab, SRC_lab, coefs = [], [], {}
    for i, s in enumerate(sk):
        past = [x for x in sk[:i]]
        if len(past) < MIN_PAST:
            continue
        # entrainement du melange : matchs cotes des saisons passees
        ytr, m_tr, k_tr = [], [], []
        for x in past:
            ok = np.isfinite(P[x]["pk"])
            if not ok.any():
                continue
            ytr.append(P[x]["y"][ok])
            m_tr.append(served[x][ok])
            k_tr.append(P[x]["pk"][ok])
        if not ytr or sum(len(v) for v in ytr) < 500:
            continue
        ytr = np.concatenate(ytr)
        Xtr = np.column_stack([BW._logit(np.concatenate(m_tr)),
                               BW._logit(np.concatenate(k_tr))])
        b = fit_logistic(ytr, Xtr)

        ok = np.isfinite(P[s]["pk"])
        if not ok.any():
            continue
        y, pk = P[s]["y"][ok], P[s]["pk"][ok]
        p_servi, p_brut = served[s][ok], P[s]["p"][ok]
        p_mel = apply_logistic(b, np.column_stack([BW._logit(p_servi), BW._logit(pk)]))
        p_moitie = 1 / (1 + np.exp(-0.5 * (BW._logit(p_servi) + BW._logit(pk))))

        out_delta["melange_vs_marche"].append(ll(y, p_mel) - ll(y, pk))
        out_delta["servi_vs_marche"].append(ll(y, p_servi) - ll(y, pk))
        out_delta["melange_vs_servi"].append(ll(y, p_mel) - ll(y, p_servi))
        out_delta["moitie_vs_marche"].append(ll(y, p_moitie) - ll(y, pk))
        out_delta["brut_vs_marche"].append(ll(y, p_brut) - ll(y, pk))
        S_lab.append(np.full(len(y), s))
        SRC_lab.append(P[s]["src"][ok])
        coefs = {"n_train": int(len(ytr)), "intercept": round(float(b[0]), 4),
                 "poids_logit_modele": round(float(b[1]), 4),
                 "poids_logit_marche": round(float(b[2]), 4)}
        rows.append({"season": int(s), "n": int(len(y)),
                     "ll_marche": round(float(ll(y, pk).mean()), 5),
                     "ll_servi": round(float(ll(y, p_servi).mean()), 5),
                     "ll_melange": round(float(ll(y, p_mel).mean()), 5),
                     "poids_modele": round(float(b[1]), 3),
                     "poids_marche": round(float(b[2]), 3),
                     "n_train_melange": int(len(ytr))})
        print(f"   {s}-{str(s+1)[2:]:<2} {len(y):>6} cotes  marche "
              f"{ll(y, pk).mean():.5f}  servi {ll(y, p_servi).mean():.5f}  "
              f"melange {ll(y, p_mel).mean():.5f}   poids "
              f"{b[1]:.2f}/{b[2]:.2f}", flush=True)

    if not rows:
        print("ERREUR : aucune saison mesurable."); return

    S_all = np.concatenate(S_lab)
    SRC_all = np.concatenate(SRC_lab)
    out = {
        "question": ("le melange modele servi (+) cloture bat-il la cloture seule ? "
                     "test apparie par match, walk-forward strict"),
        "protocol": {
            "chaine": "modele de score (saisons < S) + couche de correction C "
                      "(5 variables, ajustee sur les saisons < S, au moins 3)",
            "melange": "logistique sur [logit p_servi, logit p_cloture], ajustee "
                       "sur les matchs cotes des saisons dont p_servi est deja "
                       "hors echantillon (au moins 3)",
            "adopt_if": "ecart de log-loss z <= -2 (apparie, par match) ET gain "
                        "sur >= 70 % des saisons",
            "lecture": "le melange lit la cloture : ce n'est pas une strategie de "
                       "pari, c'est un test d'information residuelle",
            "signe": "ecart NEGATIF = le premier nomme fait mieux",
            "xgboost": __import__("xgboost").__version__,
        },
        "by_season": rows,
        "melange_dernier_fold": coefs,
        "tests": {},
        "par_source": {},
    }
    print("\n   Tests apparies (ecart NEGATIF = le premier nomme fait mieux) :")
    for k, parts in out_delta.items():
        d = np.concatenate(parts)
        st = season_stats(d, S_all)
        verdict = ("MIEUX" if st["z"] <= -2 and st["share_seasons_better"] >= SHARE
                   else "PIRE" if st["z"] >= 2 else "NON TRANCHABLE")
        out["tests"][k] = {**st, "verdict": verdict}
        print(f"   {k:<22} n {st['n']:>6}  {st['delta']:+.5f}  z {st['z']:+.2f} "
              f"(par saison {st['z_seasons']:+.2f})  "
              f"{len(st['seasons_better'])}/{st['n_seasons']} saisons -> {verdict}")

    for src in np.unique(SRC_all):
        m = SRC_all == src
        out["par_source"][str(src)] = {
            k: BW._paired(np.concatenate(v)[m]) for k, v in out_delta.items()}
    print("\n   Par source :")
    for src, blk in out["par_source"].items():
        print(f"   {src:<22} " + "  ".join(
            f"{k.split('_vs_')[0]} {r['delta']:+.5f} (z {r['z']:+.2f})"
            for k, r in blk.items() if k in ("melange_vs_marche", "servi_vs_marche")))

    BW._dump_json_atomic(out, REPORT)
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    main()
