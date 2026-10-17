"""Piste 7 — ré-ajuster la couche sur la victoire du MOTEUR de match.

POURQUOI. Depuis le 2026-10-15 la matrice servie vient du moteur
(`game_dynamics.MatchDynamics`), dont la victoire domicile est ≈ 1 point plus
basse que Poisson × τ. La couche a été ajustée sur Poisson × τ : le service lui
donne donc encore cette victoire-là (`ml_service._p_home_layer_input`), un
chemin de calcul à part qui n'existe que pour elle.

CE QU'ON FAIT. Pour chaque saison S, les cellules c du moteur sont ajustées sur
les 3 saisons précédentes (λ hors échantillon de `build_oos.py`, buts horodatés
de `live_goals.csv`), comme `game_dynamics.fit` le fait en service. Pour
2012-2014, qui ne servent qu'à l'ajustement de la couche, c vient de 2012-2014.
Puis la couche est ajustée en walk-forward sur logit(p_moteur) au lieu de
logit(p_Poisson×τ).

RÈGLE FIXÉE AVANT LE RUN. Le but est de SIMPLIFIER le service, pas de gagner :
la couche ré-ajustée sur le moteur remplace l'actuelle si elle ne perd pas à
z ≥ +1 contre elle (log-loss moneyline, apparié), pour C comme pour C5.
"""
import glob
from lab import *
import game_dynamics as GD
from score_model import ScoreDistribution

G = load()
goals = pd.read_csv("../data/live_goals.csv")
goals = goals[goals["period"] <= 3]
cnt = goals.groupby("game_id").size()
G["n_timed"] = G["game_id"].map(cnt).fillna(0).astype(int)
timed_ok = (G["n_timed"] == G["home_reg_score"] + G["away_reg_score"]).to_numpy()
seasons = sorted(G.season.unique())
pE = np.full(len(G), np.nan)
cache = os.path.join(OUT, "p_engine.npy")
if os.path.exists(cache):
    pE = np.load(cache)
else:
    for s in seasons:
        win = [x for x in seasons if s - 3 <= x < s] if s >= 2015 else [2012, 2013, 2014]
        w = G[G.season.isin(win).to_numpy() & timed_ok
              & G.lam_h.between(0.5, 8).to_numpy() & G.lam_a.between(0.5, 8).to_numpy()]
        c, *_ = GD.fit_cells(w[["game_id", "lam_h", "lam_a"]], goals)
        md = GD.MatchDynamics(c, win)
        idx = np.flatnonzero((G.season == s).to_numpy())
        for i in idx:
            r = G.iloc[i]
            pE[i] = ScoreDistribution(r.lam_h, r.lam_a, r.p_ot, md).p_home_win()
        print(f"   {s} : c sur {win} ({len(w)} matchs), victoire moteur {np.nanmean(pE[idx]):.4f}"
              f" vs Poisson×τ {G.p_ml.to_numpy()[idx].mean():.4f}", flush=True)
    np.save(cache, pE)

raw = G["p_ml"].to_numpy()
GE = G.copy()
GE["lp"] = BW._logit(pE)
C5 = [c for c in C7 if c not in ("xg_matchup_diff", "ev_xgf_pct_l_diff")]
out = {"protocol": __doc__.strip().split("\n\n")[1:], "variants": {}}
ok = np.isfinite(as_vector(G, walk_forward(G, C7)))
d_raw = compare(G, pE, raw, "moteur brut vs Poisson×τ brut", mask=ok)
out["raw_engine_vs_poisson"] = {**d_raw, "mean_shift": round(float(np.nanmean(pE[ok] - raw[ok])), 4)}
print(f"\nmoteur brut − Poisson×τ brut : victoire {out['raw_engine_vs_poisson']['mean_shift']:+.4f},"
      f" log-loss {d_raw['delta']:+.5f} (z {d_raw['z']:+.2f})")
for name, feats in (("C", C7), ("C5", C5)):
    cur = as_vector(G, walk_forward(G, feats))
    eng = as_vector(GE, walk_forward(GE, feats))
    vc = compare(G, eng, cur, f"{name} sur moteur vs {name} sur Poisson×τ")
    v = "ADOPTER (simplification)" if (vc["z"] or 0) < 1 else "GARDER Poisson×τ"
    out["variants"][name] = {"engine_vs_current": vc, "verdict": v,
                             "mean_shift": round(float(np.nanmean(eng[ok] - cur[ok])), 4),
                             "reliability_engine": reliability(G, eng)}
    print(f"{name}: moteur vs actuel {vc['delta']:+.6f} (z {vc['z']:+.2f}, {vc['seasons_better']}/{vc['n_seasons']}),"
          f" victoire {out['variants'][name]['mean_shift']:+.4f} → {v}")
dump("s4_engine_report.json", out)
