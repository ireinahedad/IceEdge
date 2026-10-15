"""s8 — piste 4 de « ICEEDGE — Des buts attendus à tous les paris » : les trois
marchés d'équipe encore chiffrés par une formule (ml_service._apply_market),
contre le moteur de match (`game_dynamics.team_events`).

    python explore_score/s0_lambdas.py          # λ hors échantillon (out/lambdas.csv)
    python explore_score/s8_marches_equipe.py

Marchés et règles actuelles :
  premier but       λ_s / (λ_s + λ_o), borné à [35 %, 65 %]
  dernier but       50 % + (P(victoire) − 50 %) × 0,65, borné à [30 %, 70 %]
  marque à chaque période   (1 − e^(−λ/3))³, borné à [4 %, 55 %]
Moteur : `team_events` (premier / dernier but réglementaire, chaque période),
plus la prolongation : seul un but en prolongation compte (q = 0,649 des
prolongations, piste 2), pas la fusillade — comme le règlement du serveur.
Premier et dernier but sont chiffrés SACHANT qu'il y a au moins un but (sinon
le pari n'est pas réglé).

Règle (posée avant le run, 2026-10-15) : le moteur remplace la règle pour un
marché si la log-perte baisse en validation (saison 2022-23) ET en test
(2023-24 → 2025-26), avec z ≥ 2 en test.

Hors échantillon : λ du modèle de score sur sa validation et son test, recalés
en niveau dans la saison ; table c du moteur ajustée sur 2019-20 → 2021-22
(`game_dynamics.fit(current_season=2022)`), AVANT les saisons mesurées — la
table servie (fenêtre 2023-2025) recouperait le test.
"""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
import game_dynamics as GD                                    # noqa: E402
from score_model import ScoreDistribution, level_k, read_ot_model, p_ot_for   # noqa: E402

ML = os.path.dirname(PY)
DATA, MODELS, OUT = os.path.join(ML, "data"), os.path.join(ML, "models"), os.path.join(HERE, "out")
Q_OT_GOAL = 0.649


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def z(d):
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def causal_level(X, n0):
    k = np.ones(len(X))
    for _, g in X.sort_values(["date", "game_id"]).groupby("season", sort=False):
        obs = (g.home_reg_score + g.away_reg_score).values.astype(float)
        lam = (g.lam_h + g.lam_a).values
        co, cl = np.concatenate([[0], np.cumsum(obs)[:-1]]), np.concatenate([[0], np.cumsum(lam)[:-1]])
        for j, idx in enumerate(g.index):
            k[X.index.get_loc(idx)] = level_k(co[j], cl[j], j, n0) if j else 1.0
    return k


def main():
    gd = GD.fit(os.path.join(DATA, "nhl_games_v4.csv"), os.path.join(DATA, "live_goals.csv"),
                MODELS, current_season=2022, verbose=False)
    _, c = GD.read_game_dynamics(gd)
    print(f"🧭 table c ajustée sur {gd['window_seasons']} ({gd['n_games_timed']} matchs horodatés)")
    w_ot = read_ot_model(json.load(open(os.path.join(MODELS, "score_report.json"))))
    n0 = float(json.load(open(os.path.join(MODELS, "level_layer.json")))["prior_games"])

    X = pd.read_csv(os.path.join(HERE, "out", "lambdas.csv"))
    X = X[(X.split != "train") & (X.season.between(2022, 2025))].reset_index(drop=True)
    X["k"] = causal_level(X, n0)
    X["lh"], X["la"] = X.lam_h * X.k, X.lam_a * X.k

    # ── Issues observées ─────────────────────────────────────────────────────
    G = pd.read_csv(os.path.join(DATA, "live_goals.csv"))
    G = G[G.period <= 3].sort_values(["game_id", "period", "time"])
    cnt = G.groupby("game_id").size()
    X = X[X.game_id.map(cnt).fillna(0).astype(int) == X.home_reg_score + X.away_reg_score].copy()
    T = pd.read_csv(os.path.join(DATA, "mp_team_games.csv"), usecols=["gameId", "home_or_away", "situation", "goalsFor"])
    T = T[T.situation == "all"].pivot_table(index="gameId", columns="home_or_away", values="goalsFor", aggfunc="first")
    X["h_all"], X["a_all"] = X.game_id.map(T.get("HOME")), X.game_id.map(T.get("AWAY"))
    X = X.dropna(subset=["h_all", "a_all"]).copy()
    tied = X.home_reg_score == X.away_reg_score
    ot_h = tied & (X.h_all == X.home_reg_score + 1)
    ot_a = tied & (X.a_all == X.away_reg_score + 1)
    first_reg = G.groupby("game_id").home_scored.first()
    last_reg = G.groupby("game_id").home_scored.last()
    X["first_h"] = X.game_id.map(first_reg)
    X.loc[X.first_h.isna() & ot_h, "first_h"] = 1
    X.loc[X.first_h.isna() & ot_a, "first_h"] = 0
    X["last_h"] = X.game_id.map(last_reg)
    X.loc[ot_h, "last_h"], X.loc[ot_a, "last_h"] = 1, 0
    per = G.groupby(["game_id", "period", "home_scored"]).size().unstack([1, 2], fill_value=0)
    def every(gid, home):
        if gid not in per.index:
            return 0
        r = per.loc[gid]
        return int(all(r.get((p, int(home)), 0) > 0 for p in (1, 2, 3)))
    X["every_h"] = [every(g, True) for g in X.game_id]
    X["every_a"] = [every(g, False) for g in X.game_id]
    print(f"   {len(X)} matchs (2022-23 → 2025-26) aux buts horodatés complets ; "
          f"{int(tied.sum())} prolongations, {int((ot_h | ot_a).sum())} tranchées par un but")

    # ── Prédictions ──────────────────────────────────────────────────────────
    rows = []
    for r in X.itertuples(index=False):
        po = p_ot_for(w_ot, r.lh, r.la, 0.5)
        ev = GD.team_events(r.lh, r.la, c)
        f, l = ev["first"], ev["last"]
        fh = f["A"] + f["none"] * Q_OT_GOAL * po
        fa = f["B"] + f["none"] * Q_OT_GOAL * (1 - po)
        tie_all = l["A_tie"] + l["B_tie"] + l["none_tie"]
        lh_ = l["A"] + tie_all * Q_OT_GOAL * po + l["A_tie"] * (1 - Q_OT_GOAL)
        la_ = l["B"] + tie_all * Q_OT_GOAL * (1 - po) + l["B_tie"] * (1 - Q_OT_GOAL)
        p_win = ScoreDistribution(r.lh, r.la, po, GD.MatchDynamics(c)).p_home_win()
        rows.append({
            "first_eng": fh / (fh + fa),
            "first_rule": np.clip(r.lh / (r.lh + r.la + 0.001), 0.35, 0.65),
            "last_eng": lh_ / (lh_ + la_),
            "last_rule": np.clip(0.5 + (p_win - 0.5) * 0.65, 0.30, 0.70),
            "every_h_eng": ev["every"]["A"], "every_a_eng": ev["every"]["B"],
            "every_h_rule": np.clip((1 - np.exp(-r.lh / 3)) ** 3, 0.04, 0.55),
            "every_a_rule": np.clip((1 - np.exp(-r.la / 3)) ** 3, 0.04, 0.55),
        })
    P = pd.concat([X.reset_index(drop=True), pd.DataFrame(rows)], axis=1)
    P["split"] = np.where(P.season == 2022, "val", "test")

    rep = {"generated": "2026-10-15", "c_window": gd["window_seasons"], "q_ot_goal": Q_OT_GOAL,
           "rule": "moteur adopté si log-perte plus basse en validation (2022-23) ET en test (2023-26), z ≥ 2 en test",
           "markets": {}}
    def measure(name, y, eng, rule, mask=None):
        out = {}
        for sp in ("val", "test"):
            m = (P.split == sp).values & (np.ones(len(P), bool) if mask is None else mask)
            d = ll(y[m], rule[m]) - ll(y[m], eng[m])          # > 0 : moteur meilleur
            out[sp] = {"n": int(m.sum()), "logloss_rule": round(float(ll(y[m], rule[m]).mean()), 5),
                       "logloss_engine": round(float(ll(y[m], eng[m]).mean()), 5),
                       "gain": round(float(d.mean()), 6), "z": round(z(d), 2),
                       "obs": round(float(y[m].mean()), 4), "p_rule": round(float(rule[m].mean()), 4),
                       "p_engine": round(float(eng[m].mean()), 4)}
        out["adopt"] = bool(out["val"]["gain"] > 0 and out["test"]["gain"] > 0 and out["test"]["z"] >= 2)
        rep["markets"][name] = out
        print(f"   {name:24s} val {out['val']['gain']:+.5f} (z {out['val']['z']:+.1f})  "
              f"test {out['test']['gain']:+.5f} (z {out['test']['z']:+.1f})  "
              f"obs {out['test']['obs']:.3f} règle {out['test']['p_rule']:.3f} moteur {out['test']['p_engine']:.3f}"
              f"  → {'ADOPTER' if out['adopt'] else 'non'}")
        return out
    has = P.first_h.notna().values
    measure("premier but (domicile)", P.first_h.fillna(0).values, P.first_eng.values, P.first_rule.values, has)
    measure("dernier but (domicile)", P.last_h.fillna(0).values, P.last_eng.values, P.last_rule.values,
            P.last_h.notna().values)
    yy = np.concatenate([P.every_h.values, P.every_a.values])
    ee = np.concatenate([P.every_h_eng.values, P.every_a_eng.values])
    rr = np.concatenate([P.every_h_rule.values, P.every_a_rule.values])
    P2 = pd.concat([P, P])                                  # une ligne par équipe
    P_, P = P, P2.reset_index(drop=True)
    measure("marque à chaque période", yy, ee, rr)
    P = P_
    # Déciles de la règle du dernier but : où se trompe-t-elle ?
    json.dump(rep, open(os.path.join(OUT, "s8_marches_equipe.json"), "w"), indent=1, ensure_ascii=False)
    print("✅ explore_score/out/s8_marches_equipe.json")


if __name__ == "__main__":
    main()
