"""Étape 0 — prédictions hors échantillon du modèle de score, une saison à la fois.

Reproduit la boucle de `backtest_walkforward.run_correction` (même découpage,
mêmes hyperparamètres en cache, `_eval_v2` sans γ) mais garde aussi λ_dom, λ_ext,
p_ot et τ de chaque fold, pour pouvoir rejouer toutes les variantes de la couche
(et la matrice du moteur, piste 7) sans réentraîner.

    python explore_correction/build_oos.py      # → explore_correction/out/oos.csv
"""
import json, os, sys, time
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))
import backtest_walkforward as BW
import train_score as TS
from score_model import ScoreDistribution, fit_margin_correction

OUT = os.path.join(HERE, "out")


def eval_fold(train_df, test_df, atk, dfn, params):
    """`BW._eval_v2(use_gamma=False)`, en gardant les intermédiaires."""
    import xgboost as xgb
    feats = TS.stacked_features(atk, dfn)
    cut = int(len(train_df) * 0.85)
    tr, cal = train_df.iloc[:cut].reset_index(drop=True), train_df.iloc[cut:].reset_index(drop=True)
    s_tr, s_cal = TS.stack(tr, atk, dfn), TS.stack(cal, atk, dfn)
    m = xgb.train(params, TS.dm(s_tr, feats), num_boost_round=700,
                  evals=[(TS.dm(s_cal, feats), "cal")], early_stopping_rounds=40, verbose_eval=False)
    ot = train_df[train_df["went_to_ot"] == 1]
    p_ot_home = float((ot["home_score"] > ot["away_score"]).mean()) if len(ot) else 0.5
    lh_tr, la_tr = TS.oof_lambdas(train_df, feats, params, int(m.best_iteration) + 1,
                                  atk_cols=atk, def_cols=dfn)
    tau = fit_margin_correction((train_df["home_reg_score"] - train_df["away_reg_score"]).to_numpy(),
                                TS.expected_margin_pmf(lh_tr, la_tr))
    ot_model = TS.fit_ot_model(train_df.reset_index(drop=True), lh_tr, la_tr, p_ot_home)
    s_te = TS.stack(test_df.reset_index(drop=True), atk, dfn)
    lh, la = TS.lambdas_for(m, feats, s_te, len(test_df))
    p_ot = np.broadcast_to(np.asarray(TS.p_ot_series(ot_model, lh, la, p_ot_home), float), (len(lh),))
    p_ml = np.array([ScoreDistribution(h, a, po, tau).p_home_win() for h, a, po in zip(lh, la, p_ot)])
    return {"lh": lh, "la": la, "p_ot": np.asarray(p_ot), "p_ml": p_ml,
            "tau": {str(k): float(v) for k, v in (tau or {}).items()}}


def main():
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    seasons = [s for s in sorted(df["season"].unique())
               if s >= 2012 and (df["season"] < s).sum() >= 800
               and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
    atk, dfn = list(TS.ATK_COLS), list(TS.DEF_COLS)
    base = BW.base_score_params(8)
    parts, taus = [], {}
    only = [int(x) for x in sys.argv[1:]]
    for s in seasons:
        if only and s not in only:
            continue
        f = os.path.join(OUT, f"oos_{s}.csv")
        if os.path.exists(f):
            print(f"   {s} déjà fait"); continue
        t0 = time.time()
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = BW.search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                       TS.stacked_features(atk, dfn), base, 8, seed=42, season=s,
                                       use_cache=True, atk=atk, dfn=dfn)
        r = eval_fold(prior, cur, atk, dfn, params)
        o = pd.DataFrame({"game_id": cur["game_id"], "season": s, "date": cur["date"],
                          "lam_h": r["lh"], "lam_a": r["la"], "p_ot": r["p_ot"], "p_ml": r["p_ml"]})
        o.to_csv(f, index=False)
        with open(os.path.join(OUT, f"tau_{s}.json"), "w") as fh:
            json.dump(r["tau"], fh)
        print(f"   {s}: {len(cur)} matchs, {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
