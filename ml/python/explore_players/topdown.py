"""
topdown.py — piste 2 de « ICEEDGE — Des buts attendus à tous les paris » :
les buts, passes et points des joueurs dérivés du MATCH SIMULÉ (« top-down »)
plutôt que du seul modèle joueur (« bottom-up »).

    python explore_players/s0_lambdas.py        # λ hors échantillon (cf. explore_score)
    python explore_players/topdown.py           # construit, mesure, écrit le rapport

── Les deux façons de chiffrer « X marque » ───────────────────────────────
  A (servi aujourd'hui) : X ~ Poisson(μ_X), μ = modèle joueur XGBoost
      (train_player.py, k « infini » pour buts, passes et points).
  B (top-down)          : le moteur de match donne la loi de N, les buts
      COMPTABLES de l'équipe (réglementaire + but en prolongation ; pas la
      fusillade). Chaque but de l'équipe revient au joueur avec la probabilité
      s = μ_buts(X) / Σ_équipe μ_buts — sa part dans l'attaque, lue sur le
      modèle joueur. Passe : a = μ_passes(X) / Σ μ_buts (≤ 1 passe par but) ;
      point : p = μ_points(X) / Σ μ_buts (≤ 1 point par but). D'où
          P(X = x) = Σ_n P(N = n) · Binom(x ; n, s).
      Les cadences des joueurs d'une équipe s'additionnent alors EXACTEMENT
      aux buts attendus de l'équipe, et « X marque ET son équipe gagne » se lit
      sur la même grille.
  C (contrôle)          : Poisson(s · E[N]) — le niveau de B sans sa forme,
      pour savoir d'où viendrait un écart.

── Règle de décision (posée AVANT le premier run, 2026-10-15) ─────────────
Par statistique (buts, passes, points) : B remplace A si l'écart apparié de
log-vraisemblance par joueur-match (B − A) est > 0 en VALIDATION (saison
2022-23) ET en TEST (2023-24 → 2025-26), avec z ≥ 2 en test. Sinon les
marginales restent celles du modèle joueur.
Mesure à part (sans règle d'adoption ici) : le gain de la grille sur la loi
JOINTE « X marque » × « son équipe gagne » (4 issues), contre le produit des
deux marginales — c'est elle qui décide des combinés du même match.

── Hors échantillon ───────────────────────────────────────────────────────
· λ : score_model.json sur les matchs de validation / test de train_score
  (après le 2021-04-06), recalés en niveau comme le service (k de la saison
  en cours sur les matchs DÉJÀ joués, n0 = prior_games de level_layer.json).
· μ : boosters entraînés ≤ 2021-22, arrêt précoce 2022-23.
· Moteur : table c de game_dynamics.json (fenêtre glissante récente — légère
  fuite sur la FORME du match, pas sur les niveaux ; signalée dans le rapport).
· q (part des prolongations tranchées par un but, pas la fusillade) : estimée
  sur 2015-16 → 2021-22 (3 c. 3), jamais sur le test.
"""
from __future__ import annotations
import json, os, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import binom, poisson

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
import train_player as TP                     # noqa: E402
from score_model import level_k, read_ot_model, p_ot_for   # noqa: E402
from game_dynamics import read_game_dynamics, regulation_matrix  # noqa: E402

ML = os.path.dirname(PY)
DATA, MODELS = os.path.join(ML, "data"), os.environ.get("MODELS_DIR") or os.path.join(ML, "models")
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
NMAX = 14                       # buts d'équipe : 0..13 en réglementaire, +1 en prolongation
STATS3 = ("goals", "assists", "points")
P_OT_DEFAULT = 0.5


# ══════════════════════════════════════════════════════════════════════════════
# 1. Joueurs : μ du modèle joueur, hors échantillon
# ══════════════════════════════════════════════════════════════════════════════

def player_rows() -> pd.DataFrame:
    cache = os.path.join(OUT, "player_mu.pkl")
    if os.path.exists(cache):
        return pd.read_pickle(cache)
    t0 = time.time()
    pg = TP.per_game(TP.load_skaters(os.path.join(DATA, "raw")))
    pre = TP.rolling_features(pg, shift=1)
    df = pd.concat([pg, pre, TP.vs_features(pg, pre, shift=1)], axis=1)
    games = pd.read_csv(os.path.join(DATA, "nhl_games_v4.csv"), low_memory=False)
    df = TP.game_context(df, games)
    rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    keep = df.season >= 2015          # 2015-21 : estimation de q ; ≥ 2022 : mesure
    df = df[keep].copy()
    for s in STATS3:
        feats = rep["stats"][s]["features"]
        assert not any(f.startswith("ref_") for f in feats), f"{s} : variables arbitre non gérées ici"
        b = xgb.Booster()
        b.load_model(os.path.join(MODELS, "player", f"{s}.json"))
        df[f"mu_{s}"] = b.predict(xgb.DMatrix(df[feats], feature_names=feats))
    cols = ["playerId", "name", "gameId", "season", "date", "playerTeam", "team_side", "pos",
            "y_goals", "y_assists", "y_points"] + [f"mu_{s}" for s in STATS3]
    out = df[cols].reset_index(drop=True)
    out.to_pickle(cache)
    print(f"   {len(out)} joueur-matchs, μ prédits ({time.time()-t0:.0f}s)")
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 2. Match : loi des buts comptables de chaque équipe, depuis la grille
# ══════════════════════════════════════════════════════════════════════════════

def causal_level(X: pd.DataFrame, n0: float) -> np.ndarray:
    """k de la saison au moment du match : matchs de la saison DÉJÀ joués."""
    k = np.ones(len(X))
    for _, g in X.sort_values(["date", "game_id"]).groupby("season", sort=False):
        obs = (g.home_reg_score + g.away_reg_score).values.astype(float)
        lam = (g.lam_h + g.lam_a).values
        co, cl = np.concatenate([[0], np.cumsum(obs)[:-1]]), np.concatenate([[0], np.cumsum(lam)[:-1]])
        for j, idx in enumerate(g.index):
            k[X.index.get_loc(idx)] = level_k(co[j], cl[j], j, n0) if j else 1.0
    return k


def team_goal_pmfs(lh: float, la: float, c: np.ndarray, p_ot_h: float, q: float):
    """(pmf dom, pmf ext, M) — buts COMPTABLES : un nul k-k devient k+1 pour le
    vainqueur de la prolongation seulement si elle est tranchée par un but (q)."""
    M = regulation_matrix(lh, la, c)
    n = M.shape[0]
    tie = np.diag(M).copy()
    off = M - np.diag(tie)
    ph, pa = np.zeros(n + 1), np.zeros(n + 1)
    ph[:n] += off.sum(1)
    pa[:n] += off.sum(0)
    for k_, t in enumerate(tie):
        ph[k_ + 1] += t * q * p_ot_h
        ph[k_] += t * (1 - q * p_ot_h)
        pa[k_ + 1] += t * q * (1 - p_ot_h)
        pa[k_] += t * (1 - q * (1 - p_ot_h))
    return ph, pa, M


def joint_score_win(M: np.ndarray, side: str, s: np.ndarray, p_ot_h: float, q: float) -> np.ndarray:
    """P(X ≥ 1 ET l'équipe gagne) pour chaque part s (vecteur), sur la grille."""
    n = M.shape[0]
    i, j = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    own = i if side == "H" else j
    win = (i > j) if side == "H" else (j > i)
    pw_ot = p_ot_h if side == "H" else 1 - p_ot_h
    miss = (1 - s)[:, None]
    # Victoires en réglementaire.
    w_reg = M[win]
    out = (w_reg[None, :] * (1 - miss ** own[win][None, :])).sum(1)
    # Nuls gagnés en prolongation : but en prolongation (q) ou fusillade (1 − q).
    tie = np.diag(M)
    kk = np.arange(n)
    goal_ot = 1 - miss ** (kk[None, :] + 1)
    shoot = 1 - miss ** kk[None, :]
    # En prolongation tranchée par un but, ce but est un des buts de l'équipe :
    # le joueur l'inscrit avec la même part s.
    out += (tie[None, :] * pw_ot * (q * goal_ot + (1 - q) * shoot)).sum(1)
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 3. Mesure
# ══════════════════════════════════════════════════════════════════════════════

def mixture_logpmf(y: np.ndarray, share: np.ndarray, pmf_rows: np.ndarray) -> np.ndarray:
    n = np.arange(pmf_rows.shape[1])
    P = binom.pmf(y[:, None], n[None, :], share[:, None])
    return np.log(np.clip((P * pmf_rows).sum(1), 1e-300, None))


def mixture_ge(kmin: int, share: np.ndarray, pmf_rows: np.ndarray) -> np.ndarray:
    n = np.arange(pmf_rows.shape[1])
    P = binom.sf(kmin - 1, n[None, :], share[:, None])
    return (P * pmf_rows).sum(1)


def zstat(d: np.ndarray) -> float:
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def main():
    t0 = time.time()
    lam = pd.read_csv(os.path.join(HERE, "..", "explore_score", "out", "lambdas.csv"))
    gd = json.load(open(os.path.join(MODELS, "game_dynamics.json")))
    _, c = read_game_dynamics(gd)
    assert c is not None, "game_dynamics.json : table c refusée"
    rep_s = json.load(open(os.path.join(MODELS, "score_report.json")))
    w_ot = read_ot_model(rep_s)
    n0 = float(json.load(open(os.path.join(MODELS, "level_layer.json")))["prior_games"])

    P = player_rows()
    print(f"⛸️  joueurs prêts ({time.time()-t0:.0f}s)")

    # ── q : part des prolongations tranchées par un but (3 c. 3, ≤ 2021-22) ──
    gsum = P.groupby("gameId").y_goals.sum()
    g = lam.set_index("game_id")
    ot = g[(g.went_to_ot == 1) & g.season.between(2015, 2021)]
    ot = ot[ot.index.isin(gsum.index)]
    extra = gsum.loc[ot.index] - (ot.home_reg_score + ot.away_reg_score)
    q = float((extra == 1).mean())
    print(f"   q (prolongation tranchée par un but) = {q:.3f} sur {len(ot)} prolongations 2015-21 "
          f"(écart à 0/1 : {float((~extra.isin([0, 1])).mean()):.3%})")

    # ── λ hors échantillon, recalés en niveau comme le service ──────────────
    E = lam[(lam.split != "train") & (lam.season >= 2022)].copy().reset_index(drop=True)
    E["k_level"] = causal_level(E, n0)
    E["lh"], E["la"] = E.lam_h * E.k_level, E.lam_a * E.k_level
    pmfs_h, pmfs_a, mats, pot = {}, {}, {}, {}
    for r in E.itertuples(index=False):
        po = p_ot_for(w_ot, r.lh, r.la, P_OT_DEFAULT)
        ph, pa, M = team_goal_pmfs(r.lh, r.la, c, po, q)
        pmfs_h[r.game_id], pmfs_a[r.game_id], mats[r.game_id], pot[r.game_id] = ph, pa, M, po
    print(f"   {len(E)} matchs ≥ 2022-23 : grilles du moteur ({time.time()-t0:.0f}s)")

    # ── Lignes joueur de ces matchs ─────────────────────────────────────────
    D = P[P.gameId.isin(E.game_id) & (P.season >= 2022)].copy()
    split_of = dict(zip(E.game_id, np.where(E.season == 2022, "val", "test")))
    win_of = dict(zip(E.game_id, E.home_win))
    D["split"] = D.gameId.map(split_of)
    tg = D.groupby(["gameId", "team_side"])
    D["sum_mu_goals"] = tg.mu_goals.transform("sum")
    D["n_team"] = tg.mu_goals.transform("size")
    D["pmf"] = [pmfs_h[g_] if s_ == "HOME" else pmfs_a[g_] for g_, s_ in zip(D.gameId, D.team_side)]
    PM = np.stack(D.pmf.values)
    EN = PM @ np.arange(PM.shape[1])
    D["E_N"] = EN
    D["team_won"] = [int(win_of[g_] == (s_ == "HOME")) for g_, s_ in zip(D.gameId, D.team_side)]
    print(f"   {len(D)} joueur-matchs ({(D.split=='val').sum()} validation, {(D.split=='test').sum()} test), "
          f"{D.n_team.median():.0f} patineurs par équipe ; Σμ_buts {D.groupby(['gameId','team_side']).sum_mu_goals.first().mean():.3f} "
          f"vs E[N] {D.groupby(['gameId','team_side']).E_N.first().mean():.3f} "
          f"vs observé {D.groupby(['gameId','team_side']).y_goals.sum().mean():.3f}")

    report = {"generated": time.strftime("%Y-%m-%d"), "q_ot_goal": round(q, 4),
              "rule": "B remplace A pour une stat si Δ log-vraisemblance (B − A) > 0 en validation 2022-23 "
                      "ET en test ≥ 2023-24, avec z ≥ 2 en test",
              "n_rows": {"val": int((D.split == "val").sum()), "test": int((D.split == "test").sum())},
              "calibration_team": {
                  "sum_mu_goals": round(float(D.groupby(["gameId", "team_side"]).sum_mu_goals.first().mean()), 4),
                  "E_N_grid": round(float(D.groupby(["gameId", "team_side"]).E_N.first().mean()), 4),
                  "observed": round(float(D.groupby(["gameId", "team_side"]).y_goals.sum().mean()), 4)},
              "stats": {}, "joint_score_and_win": {}}

    base = D.sum_mu_goals.clip(lower=1e-3).values
    for s in STATS3:
        y = D[f"y_{s}"].values.astype(int)
        mu = np.clip(D[f"mu_{s}"].values, 1e-6, None)
        share = np.clip(mu / base, 1e-6, 0.99)
        llA = poisson.logpmf(y, mu)
        llB = mixture_logpmf(y, share, PM)
        llC = poisson.logpmf(y, share * EN)
        pA1, pB1 = 1 - np.exp(-mu), mixture_ge(1, share, PM)
        pA2, pB2 = poisson.sf(1, mu), mixture_ge(2, share, PM)
        res = {}
        for sp in ("val", "test"):
            m = (D.split == sp).values
            dB, dC = llB[m] - llA[m], llC[m] - llA[m]
            res[sp] = {
                "loglik_A": round(float(llA[m].mean()), 6), "loglik_B": round(float(llB[m].mean()), 6),
                "loglik_C": round(float(llC[m].mean()), 6),
                "dll_B": round(float(dB.mean()), 6), "z_B": round(zstat(dB), 2),
                "dll_C": round(float(dC.mean()), 6), "z_C": round(zstat(dC), 2),
                "brier_ge1_A": round(float(((pA1[m] - (y[m] >= 1)) ** 2).mean()), 6),
                "brier_ge1_B": round(float(((pB1[m] - (y[m] >= 1)) ** 2).mean()), 6),
                "brier_ge2_A": round(float(((pA2[m] - (y[m] >= 2)) ** 2).mean()), 6),
                "brier_ge2_B": round(float(((pB2[m] - (y[m] >= 2)) ** 2).mean()), 6),
                "mean_obs": round(float(y[m].mean()), 4), "mean_A": round(float(mu[m].mean()), 4),
                "mean_B": round(float((share[m] * EN[m]).mean()), 4),
                "obs_ge2": round(float((y[m] >= 2).mean()), 5), "pA_ge2": round(float(pA2[m].mean()), 5),
                "pB_ge2": round(float(pB2[m].mean()), 5),
            }
            if sp == "test":
                res["test_by_season"] = {int(ss): round(float(dB[D.season.values[m] == ss].mean()), 6)
                                         for ss in sorted(D.season[m].unique())}
        res["adopt_B"] = bool(res["val"]["dll_B"] > 0 and res["test"]["dll_B"] > 0 and res["test"]["z_B"] >= 2)
        report["stats"][s] = res
        print(f"   {s:8s} val ΔB {res['val']['dll_B']:+.6f} (z {res['val']['z_B']:+.2f})  "
              f"test ΔB {res['test']['dll_B']:+.6f} (z {res['test']['z_B']:+.2f})  "
              f"ΔC test {res['test']['dll_C']:+.6f}  → {'ADOPTER' if res['adopt_B'] else 'garder A'}", flush=True)

    # ── Loi jointe « marque » × « équipe gagne » ────────────────────────────
    y1 = (D.y_goals.values >= 1).astype(int)
    won = D.team_won.values
    shareG = np.clip(D.mu_goals.values / base, 1e-6, 0.99)
    pB_sw = np.empty(len(D))
    for (gid, side), idx in D.groupby(["gameId", "team_side"]).indices.items():
        pB_sw[idx] = joint_score_win(mats[gid], "H" if side == "HOME" else "A", shareG[idx], pot[gid], q)
    # P(équipe gagne) sur la même grille (prolongation comprise).
    p_win = np.array([
        (lambda M, po: (M[np.tril_indices(M.shape[0], -1)].sum() + np.trace(M) * po) if s_ == "HOME"
         else (M[np.triu_indices(M.shape[0], 1)].sum() + np.trace(M) * (1 - po)))(mats[g_], pot[g_])
        for g_, s_ in zip(D.gameId, D.team_side)])
    pA1 = 1 - np.exp(-np.clip(D.mu_goals.values, 1e-6, None))
    pB1 = mixture_ge(1, shareG, PM)

    def four(p1, pw, p11):
        p10, p01 = p1 - p11, pw - p11
        p00 = 1 - p1 - pw + p11
        Q = np.clip(np.stack([p11, p10, p01, p00], 1), 1e-9, None)
        return Q / Q.sum(1, keepdims=True)
    cell = np.where(y1 & won, 0, np.where(y1 & ~won.astype(bool), 1, np.where(~y1.astype(bool) & won, 2, 3)))
    QA = four(pA1, p_win, pA1 * p_win)                # marginales servies, indépendantes
    QB = four(pB1, p_win, pB_sw)                      # tout depuis la grille
    QBi = four(pB1, p_win, pB1 * p_win)               # marginales B, indépendance
    for sp in ("val", "test"):
        m = (D.split == sp).values
        lA = np.log(QA[m, cell[m]]); lB = np.log(QB[m, cell[m]]); lBi = np.log(QBi[m, cell[m]])
        obs_ratio = float((y1[m] & won[m]).mean() / (y1[m].mean() * won[m].mean()))
        report["joint_score_and_win"][sp] = {
            "loglik_indep_A": round(float(lA.mean()), 6), "loglik_grid_B": round(float(lB.mean()), 6),
            "dll_grid_vs_indep_A": round(float((lB - lA).mean()), 6), "z": round(zstat(lB - lA), 2),
            "dll_corr_only": round(float((lB - lBi).mean()), 6), "z_corr_only": round(zstat(lB - lBi), 2),
            "lift_observed": round(obs_ratio, 4),
            "lift_grid": round(float(pB_sw[m].mean() / (pB1[m] * p_win[m]).mean()), 4),
        }
        print(f"   joint {sp}: {report['joint_score_and_win'][sp]}", flush=True)

    with open(os.path.join(OUT, "topdown_report.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    print(f"✅ rapport → explore_players/out/topdown_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
