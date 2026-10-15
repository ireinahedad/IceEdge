"""
joint.py — piste 2, suite : ce que la grille apporte aux COMBINÉS d'un même
match quand une jambe est un pari joueur. (topdown.py a tranché : pour les
marginales, le modèle joueur reste meilleur ; la grille ne gagne que sur la
loi jointe.)

    python explore_players/topdown.py      # d'abord (cache des μ, rapport marginal)
    python explore_players/joint.py

── Ce qui serait servi ─────────────────────────────────────────────────────
Les probabilités AFFICHÉES de chaque jambe ne changent pas (modèle joueur pour
le joueur, grille pour l'équipe). La grille ne fournit que le FACTEUR

    facteur = P_grille(toutes les jambes) / ∏ P_grille(chaque jambe)

appliqué au produit des chiffres affichés — exactement ce que fait déjà
`gameParlay.ts` pour les jambes d'équipe. Le joueur entre dans la grille par sa
part s = μ_buts / Σ_équipe μ_buts : sachant que l'équipe a marqué n buts
comptables, P(il marque) = 1 − (1 − s)^n.

── Mesure ──────────────────────────────────────────────────────────────────
Pour chaque couple de jambes, log-perte sur les 4 issues (les deux passent,
l'une, l'autre, aucune) : « facteur de la grille » contre « produit »
(indépendance, ce que fait le coupon aujourd'hui pour une jambe joueur), mêmes
marginales. Règle posée avant le run : le facteur est adopté pour un couple si
Δ > 0 en validation ET en test, z ≥ 2 en test.
"""
from __future__ import annotations
import json, os, sys, time
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import topdown as TD                                          # noqa: E402
from score_model import read_ot_model, p_ot_for               # noqa: E402
from game_dynamics import read_game_dynamics, regulation_matrix  # noqa: E402
from score_model import joint_matrix                          # noqa: E402

# Variantes de robustesse (le coupon de Node lit une grille Poisson « règles ») :
#   GRID=engine|poisson   SHARE=sum|EN   (part = μ / Σ_équipe μ, ou μ / E[N] de la grille)
GRID = os.environ.get("GRID", "engine")
SHARE = os.environ.get("SHARE", "sum")


def outcomes(M: np.ndarray, po: float, q: float):
    """Issues finales du match : (buts finaux dom, ext, buts comptables dom, ext, poids).
    Un nul k-k va au vainqueur de la prolongation (po) : par un but (q), compté
    pour ses joueurs, ou en fusillade (1 − q), +1 au score final seulement."""
    n = M.shape[0]
    i, j = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    off = i != j
    rows = [np.stack([i[off], j[off], i[off], j[off], M[off]], 1)]
    k = np.arange(n); t = np.diag(M)
    rows += [np.stack([k + 1, k, k + 1, k, t * po * q], 1), np.stack([k + 1, k, k, k, t * po * (1 - q)], 1),
             np.stack([k, k + 1, k, k + 1, t * (1 - po) * q], 1), np.stack([k, k + 1, k, k, t * (1 - po) * (1 - q)], 1)]
    O = np.concatenate(rows)
    return O[O[:, 4] > 0]


def logloss4(pa, pb, pab, ya, yb):
    p = {(1, 1): pab, (1, 0): pa - pab, (0, 1): pb - pab, (0, 0): 1 - pa - pb + pab}
    out = np.empty(len(ya))
    for (a, b), v in p.items():
        m = (ya == a) & (yb == b)
        out[m] = np.log(np.clip(v[m], 1e-9, None))
    return out


def main():
    t0 = time.time()
    lam = pd.read_csv(os.path.join(HERE, "..", "explore_score", "out", "lambdas.csv"))
    gd = json.load(open(os.path.join(TD.MODELS, "game_dynamics.json")))
    _, c = read_game_dynamics(gd)
    w_ot = read_ot_model(json.load(open(os.path.join(TD.MODELS, "score_report.json"))))
    n0 = float(json.load(open(os.path.join(TD.MODELS, "level_layer.json")))["prior_games"])
    q = json.load(open(os.path.join(HERE, "out", "topdown_report.json")))["q_ot_goal"]
    P = TD.player_rows()

    E = lam[(lam.split != "train") & (lam.season >= 2022)].copy().reset_index(drop=True)
    E["k_level"] = TD.causal_level(E, n0)
    E["lh"], E["la"] = E.lam_h * E.k_level, E.lam_a * E.k_level
    E["final_tot"] = np.where(E.went_to_ot == 1, E.home_reg_score + E.away_reg_score + 1, E.home_score + E.away_score)
    G = E.set_index("game_id")

    D = P[P.gameId.isin(E.game_id) & (P.season >= 2022)].copy()
    D["split"] = np.where(D.gameId.map(G.season) == 2022, "val", "test")
    tg = D.groupby(["gameId", "team_side"])
    D["share_g"] = (D.mu_goals / tg.mu_goals.transform("sum")).clip(1e-6, 0.99)
    D["share_p"] = (D.mu_points / tg.mu_goals.transform("sum")).clip(1e-6, 0.99)
    D["rank_g"] = tg.mu_goals.rank(ascending=False, method="first")

    # Couples évalués : (nom, jambe joueur, jambe d'équipe/match)
    #   jambe joueur : "goal" (≥ 1 but) ou "point" (≥ 1 point)
    #   jambe de match : fonction des issues → indicateur, et observé.
    rec = {k: [] for k in ("score_win", "point_win", "score_over55", "score_pl15", "score_oppwin", "two_mates")}
    for gid, g in D.groupby("gameId", sort=False):
        r = G.loc[gid]
        po = p_ot_for(w_ot, r.lh, r.la, TD.P_OT_DEFAULT)
        Mg = regulation_matrix(r.lh, r.la, c) if GRID == "engine" else joint_matrix(r.lh, r.la)
        O = outcomes(Mg / Mg.sum(), po, q)
        fh, fa, ch, ca, w = O.T
        for side, sub in g.groupby("team_side"):
            home = side == "HOME"
            mine_f, opp_f, mine_c = (fh, fa, ch) if home else (fa, fh, ca)
            won_obs = int(r.home_win == home)
            margin_obs = (r.home_score - r.away_score) * (1 if home else -1)
            reg_margin_obs = (r.home_reg_score - r.away_reg_score) * (1 if home else -1)
            legs = {
                "win": (mine_f > opp_f, won_obs),
                "over55": (fh + fa > 5.5, int(r.final_tot > 5.5)),
                "pl15": (mine_f - opp_f >= 2, int(reg_margin_obs >= 2)),
                "oppwin": (opp_f > mine_f, 1 - won_obs),
            }
            EN = float((w * mine_c).sum())
            for p in sub.itertuples(index=False):
                sg = p.share_g if SHARE == "sum" else min(p.mu_goals / EN, 0.99)
                sp_ = p.share_p if SHARE == "sum" else min(p.mu_points / EN, 0.99)
                for kind, share, yobs, pairs in (
                        ("goal", sg, int(p.y_goals >= 1), (("score_win", "win"), ("score_over55", "over55"),
                                                                   ("score_pl15", "pl15"), ("score_oppwin", "oppwin"))),
                        ("point", sp_, int(p.y_points >= 1), (("point_win", "win"),))):
                    px_cell = 1 - (1 - share) ** mine_c
                    px = float((w * px_cell).sum())
                    pA = 1 - np.exp(-(p.mu_goals if kind == "goal" else p.mu_points))
                    for name, leg in pairs:
                        ind, yleg = legs[leg]
                        pl = float(w[ind].sum())
                        joint = float((w * px_cell * ind).sum())
                        fac = joint / (px * pl) if px * pl > 0 else 1.0
                        rec[name].append((p.split, pA, pl, min(pA * pl * fac, min(pA, pl)), yobs, yleg))
            # Deux coéquipiers (les deux meilleurs buteurs attendus) marquent tous les deux.
            top = sub.sort_values("rank_g").head(2)
            if len(top) == 2:
                s1, s2 = top.share_g.values if SHARE == "sum" else np.minimum(top.mu_goals.values / EN, 0.99)
                both = 1 - (1 - s1) ** mine_c - (1 - s2) ** mine_c + np.clip(1 - s1 - s2, 0, 1) ** mine_c
                p1 = float((w * (1 - (1 - s1) ** mine_c)).sum()); p2 = float((w * (1 - (1 - s2) ** mine_c)).sum())
                fac = float((w * both).sum()) / (p1 * p2)
                a1, a2 = 1 - np.exp(-top.mu_goals.values)
                rec["two_mates"].append((top.split.values[0], a1, a2, min(a1 * a2 * fac, min(a1, a2)),
                                         int(top.y_goals.values[0] >= 1), int(top.y_goals.values[1] >= 1)))
    print(f"   couples construits ({time.time()-t0:.0f}s)")

    report = {"generated": time.strftime("%Y-%m-%d"), "q_ot_goal": q, "grid": GRID, "share": SHARE,
              "rule": "facteur de la grille adopté pour un couple si Δ log-perte 4 issues (facteur − produit) > 0 "
                      "en validation ET en test, z ≥ 2 en test", "pairs": {}}
    for name, rows in rec.items():
        R = pd.DataFrame(rows, columns=["split", "pa", "pb", "pab", "ya", "yb"])
        res = {}
        for sp in ("val", "test"):
            S = R[R.split == sp]
            lf = logloss4(S.pa.values, S.pb.values, S.pab.values, S.ya.values, S.yb.values)
            li = logloss4(S.pa.values, S.pb.values, S.pa.values * S.pb.values, S.ya.values, S.yb.values)
            d = lf - li
            obs_lift = float((S.ya & S.yb).mean() / (S.ya.mean() * S.yb.mean()))
            res[sp] = {"n": len(S), "dll": round(float(d.mean()), 6), "z": round(TD.zstat(d), 2),
                       "lift_observed": round(obs_lift, 4),
                       "lift_factor": round(float(S.pab.mean() / (S.pa * S.pb).mean()), 4),
                       "p_both_observed": round(float((S.ya & S.yb).mean()), 4),
                       "p_both_factor": round(float(S.pab.mean()), 4),
                       "p_both_product": round(float((S.pa * S.pb).mean()), 4)}
        res["adopt"] = bool(res["val"]["dll"] > 0 and res["test"]["dll"] > 0 and res["test"]["z"] >= 2)
        report["pairs"][name] = res
        print(f"   {name:13s} val Δ {res['val']['dll']:+.5f} (z {res['val']['z']:+.1f})  "
              f"test Δ {res['test']['dll']:+.5f} (z {res['test']['z']:+.1f})  lift obs {res['test']['lift_observed']} "
              f"facteur {res['test']['lift_factor']} → {'ADOPTER' if res['adopt'] else 'non'}", flush=True)
    json.dump(report, open(os.path.join(HERE, "out", f"joint_report{'' if (GRID, SHARE) == ('engine', 'sum') else f'_{GRID}_{SHARE}'}.json"), "w"), indent=1)
    print(f"✅ explore_players/out/joint_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
