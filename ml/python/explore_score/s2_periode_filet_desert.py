"""Piste 1 — modèle dynamique par période avec filet désert explicite.

Intensités de but par seconde, pour chaque équipe :
    r(t) = λ_équipe / 3600 × c(avance de l'équipe, tranche de temps)
c est estimé de façon non paramétrique sur les buts réels (live_goals.csv) :
    c = buts observés dans la case / Σ (exposition en secondes × λ/3600)
Tranches : P1, P2, P3 0-10', 10-15', puis minute par minute de 55' à 60'.
La distribution du score final est obtenue par programmation dynamique
(pas de 5 s) sur la grille 14×14 — aucune simulation, aucun τ.
"""
import json, sys
import numpy as np, pandas as pd
from harness import *
import sys as _sys; _sys.path.insert(0, str(HERE))

DT = 5
EDGES = np.array([0, 1200, 2400, 3000, 3300, 3360, 3420, 3480, 3540, 3600])  # 9 tranches
NB = len(EDGES) - 1
LEADS = np.arange(-3, 4)            # avance de l'équipe, bornée à ±3
BLAB = ["P1", "P2", "P3 0-10", "P3 10-15", "55-56", "56-57", "57-58", "58-59", "59-60"]

X = load()
G = pd.read_csv(str(DATA) + "/live_goals.csv")
G = G[G.period <= 3].copy()
G["season"] = G.game_id // 1_000_000
cov = set(G.season.unique())
X["s_lg"] = X.game_id // 1_000_000
cnt = G.groupby("game_id").size()
X["n_lg"] = X.game_id.map(cnt).fillna(0).astype(int)
X["ok_lg"] = X.s_lg.isin(cov) & (X.n_lg == X.hr + X.ar)
print("matchs avec buts horodatés cohérents :", X.ok_lg.sum(), "/", len(X))

def cell_stats(games, goals):
    """Expositions et buts par (avance, tranche), pondérés par λ."""
    expo = np.zeros((len(LEADS), NB)); gl = np.zeros((len(LEADS), NB))
    en = np.zeros((len(LEADS), NB))
    gg = goals[goals.game_id.isin(games.game_id)].sort_values(["game_id", "time"])
    by = {k: v for k, v in gg.groupby("game_id")}
    sec_b = np.searchsorted(EDGES, np.arange(3600), side="right") - 1
    for r in games.itertuples():
        g = by.get(r.game_id)
        lead = np.zeros(3600, int)            # avance du domicile, seconde par seconde
        if g is not None:
            for t, hs in zip(g.time.values, g.home_scored.values):
                lead[min(t, 3599) + 1:] += 1 if hs else -1
            # buts : avance de l'équipe qui marque AVANT le but
            for t, hs, hb, ab, e in zip(g.time.values, g.home_scored.values, g.home_before.values,
                                        g.away_before.values, g.empty_net.values):
                d = (hb - ab) if hs else (ab - hb)
                li, b = np.clip(d, -3, 3) + 3, sec_b[min(t, 3599)]
                gl[li, b] += 1; en[li, b] += e
        for side, lam, sgn in (("h", r.lam_h, 1), ("a", r.lam_a, -1)):
            li = np.clip(sgn * lead, -3, 3) + 3
            np.add.at(expo, (li, sec_b), lam / 3600.0)
    return gl, expo, en

def fit_cells(games, goals, prior=200.0):
    gl, expo, en = cell_stats(games, goals)
    # rétrécissement vers le multiplicateur de la tranche (cases vides en fin de match)
    col = gl.sum(0) / expo.sum(0)
    c = (gl + prior / 3600 * col[None]) / (expo + prior / 3600)
    return c, gl, expo, en

def dp(lh, la, c, t_end=3600, P0=None, track_period=False):
    n = len(lh)
    P = np.zeros((n, K, K)); P[:, 0, 0] = 1.0
    lead_cl = np.clip(MARG, -3, 3) + 3
    snaps = {}
    for t in range(0, t_end, DT):
        b = np.searchsorted(EDGES, t, side="right") - 1
        ch = c[lead_cl, b]; ca = c[np.clip(-MARG, -3, 3) + 3, b]
        ph = (lh[:, None, None] / 3600 * DT) * ch[None]
        pa = (la[:, None, None] / 3600 * DT) * ca[None]
        stay = P * (1 - ph - pa)
        new = stay
        new[:, 1:, :] += (P * ph)[:, :-1, :]
        new[:, :, 1:] += (P * pa)[:, :, :-1]
        # masse qui sortirait de la grille : repliée sur le bord
        new[:, -1, :] += (P * ph)[:, -1, :]; new[:, :, -1] += (P * pa)[:, :, -1]
        P = new
        if t + DT in (1200, 2400):
            snaps[t + DT] = P.copy()
    return P / P.sum((1, 2), keepdims=True), snaps

def period_goal_dist(lh, la, c, P_start, t0, t1, gmax=12):
    """Distribution des buts DANS la période [t0,t1), état = (avance dom, buts période)."""
    n = len(lh); L = np.arange(-10, 11)
    S = np.zeros((n, len(L), gmax + 1))
    lead0 = np.stack([P_start[:, MARG == d].sum(1) for d in L], 1)
    S[:, :, 0] = lead0
    for t in range(t0, t1, DT):
        b = np.searchsorted(EDGES, t, side="right") - 1
        ch = c[np.clip(L, -3, 3) + 3, b]; ca = c[np.clip(-L, -3, 3) + 3, b]
        ph = (lh[:, None] / 3600 * DT) * ch[None]; pa = (la[:, None] / 3600 * DT) * ca[None]
        new = S * (1 - ph - pa)[:, :, None]
        mh = S * ph[:, :, None]; ma = S * pa[:, :, None]
        new[:, 1:, 1:] += mh[:, :-1, :-1]; new[:, :-1, 1:] += ma[:, 1:, :-1]
        S = new
    g = S.sum(1)
    return g / g.sum(1, keepdims=True)

if __name__ == "__main__":
    tr = X[(X.split == "train") & X.ok_lg].reset_index(drop=True)
    c_tr, gl, expo, en = fit_cells(tr, G)
    pd.set_option("display.width", 200)
    print("\nMultiplicateur c(avance, tranche) — ajusté sur TRAIN (2010-2020) :")
    print(pd.DataFrame(c_tr.round(2), index=[f"avance {d:+d}" for d in LEADS], columns=BLAB).to_string())
    print("\nPart des buts en filet désert par case (train) :")
    print(pd.DataFrame(np.where(gl > 0, en / np.maximum(gl, 1), np.nan).round(2), index=[f"avance {d:+d}" for d in LEADS], columns=BLAB).to_string())

    # Ajustement « fenêtre glissante » : pour la saison S, les 3 saisons S-3..S-1
    # (λ hors échantillon : OOF pour train, modèle servi pour val/test).
    te = X[X.split == "test"].reset_index(drop=True)
    seasons = sorted(te.season.unique())
    c_roll = {}
    for S in seasons:
        w = X[(X.season >= S - 3) & (X.season < S) & X.ok_lg]
        c_roll[S], gl_r, _, en_r = fit_cells(w, G)
        print(f"\nFenêtre {S-3}-{S-1} pour {S} ({len(w)} matchs) — lignes avance −1, −2 et +1 :")
        print(pd.DataFrame(c_roll[S][[2, 1, 4]].round(2), index=["−1", "−2", "+1"], columns=BLAB).to_string())

    # τ glissant équivalent (même fenêtre) pour comparer à armes égales
    def tau_fit(w):
        M = indep(w.lam_h.values, w.lam_a.values)
        m = (w.hr - w.ar).values; tau = {}
        for k in range(-6, 7):
            emp, ex = (m == k).mean(), M[:, MARG == k].sum(1).mean()
            tau[k] = float(np.clip(emp / ex, .25, 4)) if emp > 0 else 1.0
        return tau

    lh, la = te.lam_h.values, te.lam_a.values
    M_pois = indep(lh, la)
    res = {"Poisson indép": M_pois, "Poisson+τ": apply_tau(M_pois)}
    M_dp_tr, snaps_tr = dp(lh, la, c_tr)
    res["Dyn. période+FD (train)"] = M_dp_tr
    M_tau_roll = np.empty_like(M_pois); M_dp_roll = np.empty_like(M_pois)
    snaps_roll = {1200: np.empty_like(M_pois), 2400: np.empty_like(M_pois)}
    for S in seasons:
        i = (te.season == S).values
        w = X[(X.season >= S - 3) & (X.season < S)]
        M_tau_roll[i] = apply_tau(M_pois[i], tau_fit(w))
        M_dp_roll[i], sn = dp(lh[i], la[i], c_roll[S])
        for k in sn: snaps_roll[k][i] = sn[k]
    res["Poisson+τ glissant"] = M_tau_roll
    res["Dyn. période+FD glissant"] = M_dp_roll
    np.save("res_s2.npy", {k: v.astype(np.float32) for k, v in res.items()}, allow_pickle=True)
    tab, pg = compare(res, te)
    cols = [c for c in tab.columns if c.endswith(" Δ") or c.endswith(" z")]
    print("\n", tab[["méthode", "score_exact", "moneyline", "PL_dom_-1.5", "nul_60", "over_5.5"]].to_string())
    print(tab.set_index("méthode")[cols].T.to_string())
    print(margin_table(res, te).to_string())
    print("Total moyen prédit (régl.) :", {k: round(float((M * TOT).sum((1, 2)).mean()), 3) for k, M in res.items()},
          " observé", round((te.hr + te.ar).mean(), 3), " λ", round((lh + la).mean(), 3))

    # ── marchés par période (test, matchs horodatés) ──────────────────────
    ok = te.ok_lg.values
    tt = te[ok].reset_index(drop=True)
    Gt = G[G.game_id.isin(tt.game_id)]
    per = Gt.groupby(["game_id", "period", "home_scored"]).size().unstack([1, 2], fill_value=0)
    def pg_(p, h): return tt.game_id.map(per[(p, h)] if (p, h) in per.columns else pd.Series(dtype=float)).fillna(0).values
    y = {p: (pg_(p, 1), pg_(p, 0)) for p in (1, 2, 3)}
    lh2, la2 = tt.lam_h.values, tt.lam_a.values
    SH = {1: 0.305, 2: 0.365, 3: 0.330}
    out = []
    # heuristique actuelle : Poisson (λh+λa)×part ; P1 3 voies : deux Poisson λ×0.305
    from scipy.stats import poisson
    # DP glissant : distribution P1 (snap 1200), buts par période
    P1 = snaps_roll[1200][ok]; P2c = snaps_roll[2400][ok]
    pdist = {}
    for p, (t0, t1, Pst) in {1: (0, 1200, None), 2: (1200, 2400, P1), 3: (2400, 3600, P2c)}.items():
        if Pst is None:
            Pst = np.zeros((len(tt), K, K)); Pst[:, 0, 0] = 1
        pdist[p] = np.zeros((len(tt), 13))
        for S in seasons:
            i = (tt.season == S).values
            if i.sum(): pdist[p][i] = period_goal_dist(lh2[i], la2[i], c_roll[S], Pst[i], t0, t1)
    for p in (1, 2, 3):
        yt = y[p][0] + y[p][1]
        for L in (0.5, 1.5, 2.5):
            p_h = 1 - poisson.cdf(L, (lh2 + la2) * SH[p])
            p_d = pdist[p][:, int(L) + 1:].sum(1)
            a, b = ll((yt > L).astype(float), p_h), ll((yt > L).astype(float), p_d)
            dd = b - a
            out.append({"marché": f"P{p} total > {L}", "heuristique": a.mean().round(5), "dynamique": b.mean().round(5),
                        "Δ": dd.mean().round(5), "z": (dd.mean() / (dd.std() / np.sqrt(len(dd)))).round(2),
                        "obs": (yt > L).mean().round(3), "préd heur": p_h.mean().round(3), "préd dyn": p_d.mean().round(3)})
    # P1 3 voies
    ph1, pa1 = pois_pmf(lh2 * SH[1]), pois_pmf(la2 * SH[1])
    Mh = ph1[:, :, None] * pa1[:, None, :]
    def three(M): return np.stack([M[:, MARG > 0].sum(1), M[:, MARG == 0].sum(1), M[:, MARG < 0].sum(1)], 1)
    yy = np.select([y[1][0] > y[1][1], y[1][0] == y[1][1]], [0, 1], 2)
    for nm, M in (("heur", Mh), ("dyn", P1)):
        pr = three(M)
        out.append({"marché": f"P1 3 voies ({nm})", "heuristique": np.nan,
                    "dynamique": (-np.log(pr[np.arange(len(yy)), yy])).mean().round(5),
                    "obs": np.bincount(yy, minlength=3) / len(yy), "préd": pr.mean(0).round(3)})
    print("\nMarchés par période, test (", len(tt), "matchs horodatés)")
    print(pd.DataFrame(out).to_string())
    json.dump({"c_train": c_tr.tolist(), "c_roll": {int(k): v.tolist() for k, v in c_roll.items()},
               "edges": EDGES.tolist(), "leads": LEADS.tolist()}, open("params_s2.json", "w"))
