"""Piste 4 — simulation tir par tir à partir des xG.
A. Données tir par tir (2021-22) : les buts, SACHANT les tirs réels, suivent-ils
   une Poisson-binomiale (Σ Bernoulli(xG)) ?
B. Avant-match : nombre de tirs N aléatoire (sur-dispersion v_N mesurée sans fuite),
   chaque tir marque avec p ~ xG. Loi composée → dispersion des buts
   D = 1 + μp (v_N − 1). On l'évalue sur le test, comme les autres pistes."""
import numpy as np, pandas as pd, json
from scipy.special import gammaln
from harness import *
import sys as _sys; _sys.path.insert(0, str(HERE))

# ---------- A ----------
cols = ["game_id", "season", "period", "isPlayoffGame", "isHomeTeam", "xGoal", "goal", "event",
        "homeEmptyNet", "awayEmptyNet", "shotWasOnGoal"]
S = pd.concat([pd.read_csv(DATA / "raw" / "shots" / f"shots_{y}.zip", usecols=lambda c: c in cols) for y in (2021, 2022)])
S = S[(S.isPlayoffGame == 0) & (S.period <= 3)]
S["en"] = np.where(S.isHomeTeam == 1, S.awayEmptyNet, S.homeEmptyNet)
VAR_P_SHOT = S.xGoal.var()
print("tirs non bloqués :", len(S), " xG moyen/tir", S.xGoal.mean().round(4), " but/tir", S.goal.mean().round(4))
print("  dont filet désert :", int(S.en.sum()), "tirs, xG moyen", S[S.en == 1].xGoal.mean().round(3), "réussite", S[S.en == 1].goal.mean().round(3))
for nm, d in (("tous les tirs", S), ("hors filet désert", S[S.en == 0])):
    g = d.groupby(["season", "game_id", "isHomeTeam"]).agg(G=("goal", "sum"), xg=("xGoal", "sum"),
                                                          v=("xGoal", lambda p: (p * (1 - p)).sum()), N=("goal", "size"))
    r = g.G - g.xg
    print(f"  {nm:18s}: E[G]={g.G.mean():.3f} E[Σp]={g.xg.mean():.3f} | Var(G−Σp)={r.var():.3f}  "
          f"Poisson-binomiale Σp(1−p)={g.v.mean():.3f}  Poisson Σp={g.xg.mean():.3f}  → ratio PB {r.var()/g.v.mean():.3f}")
    # calibration par déciles de Σp
    g["q"] = pd.qcut(g.xg, 5, labels=False)
    print("     calibration par quintile de Σxg :", g.groupby("q").apply(lambda z: f"{z.xg.mean():.2f}→{z.G.mean():.2f}").tolist())

# ---------- B ----------
m = pd.read_csv(str(DATA) + "/mp_team_games.csv",
                usecols=["season", "gameId", "playerTeam", "opposingTeam", "home_or_away", "situation", "gameDate",
                         "xGoalsFor", "goalsFor", "unblockedShotAttemptsFor", "unblockedShotAttemptsAgainst"])
m = m[m.situation == "all"].sort_values(["gameDate", "gameId"])
m = m[m.gameId.astype(str).str[4:6] == "02"] if m.gameId.max() > 1e9 else m
# moyennes glissantes AVANT le match (30 derniers matchs) : tirs pour de l'équipe, tirs contre de l'adversaire
m["ff_avg"] = m.groupby("playerTeam").unblockedShotAttemptsFor.transform(lambda s: s.shift().rolling(30, min_periods=10).mean())
m["fa_avg"] = m.groupby("playerTeam").unblockedShotAttemptsAgainst.transform(lambda s: s.shift().rolling(30, min_periods=10).mean())
opp = m[["gameId", "playerTeam", "fa_avg"]].rename(columns={"playerTeam": "opposingTeam", "fa_avg": "opp_fa"})
m = m.merge(opp, on=["gameId", "opposingTeam"])
lg = m.groupby("season").unblockedShotAttemptsFor.transform("mean")
m["N_hat"] = m.ff_avg * m.opp_fa / lg
d = m.dropna(subset=["N_hat"])
for per, dd in (("2010-2020", d[(d.season >= 2010) & (d.season <= 2020)]), ("2023-2025", d[d.season.between(2023, 2025)])):
    N, Nh = dd.unblockedShotAttemptsFor.values, dd.N_hat.values
    Nh = Nh * N.mean() / Nh.mean()
    vN = np.mean((N - Nh) ** 2 / Nh)
    mup = dd.xGoalsFor.sum() / dd.unblockedShotAttemptsFor.sum()
    print(f"\n{per}: tirs non bloqués/match {N.mean():.1f}, VMR conditionnelle v_N = {vN:.2f} (borne haute : N̂ imparfait), "
          f"xG/tir μp = {mup:.4f} → dispersion des buts prédite D = 1 + μp(v_N−1) = {1 + mup * (vN - 1):.4f}")
    # avec hétérogénéité de qualité commune au match : variance de xG/tir entre matchs
    q = dd.xGoalsFor / dd.unblockedShotAttemptsFor
    # la variance observée de xG/tir entre matchs contient le bruit d'échantillonnage
    # (moyenne de ~42 tirs) : on le retire pour garder l'hétérogénéité réelle
    var_true = max(0.0, q.var() - VAR_P_SHOT * np.mean(1 / dd.unblockedShotAttemptsFor))
    D_shot = 1 + mup * (vN - 1) + N.mean() * var_true / mup
    print(f"   + qualité de tir commune au match (sd brute {q.std():.4f}, réelle {np.sqrt(var_true):.4f}) → D ≈ {D_shot:.4f}")
json.dump({"D_shot": D_shot}, open("params_s3.json", "w"))

# évaluation : binomiale négative de dispersion D_shot (= loi des buts d'une simulation tir par tir)
def nb_pmf(lam, D):
    lam = np.asarray(lam, float)[:, None]
    r = lam / (D - 1); p = 1 / D
    lp = gammaln(IDX + r) - gammaln(r) - gammaln(IDX + 1) + r * np.log(p) + IDX * np.log1p(-p)
    out = np.exp(lp); out[:, -1] += np.clip(1 - out.sum(1), 0, None)
    return out / out.sum(1, keepdims=True)
X = load(); tr, te = X[X.split == "train"].reset_index(drop=True), X[X.split == "test"].reset_index(drop=True)
def tau_fit(M, d):
    mm = (d.hr - d.ar).values; t = {}
    for k in range(-6, 7):
        emp, ex = (mm == k).mean(), M[:, MARG == k].sum(1).mean(); t[k] = float(np.clip(emp / ex, .25, 4))
    return t
Mtr = nb_pmf(tr.lam_h, D_shot)[:, :, None] * nb_pmf(tr.lam_a, D_shot)[:, None, :]
Mte = nb_pmf(te.lam_h, D_shot)[:, :, None] * nb_pmf(te.lam_a, D_shot)[:, None, :]
Mp = indep(te.lam_h.values, te.lam_a.values)
res = {"Poisson indép": Mp, "Poisson+τ": apply_tau(Mp), "Sim. tirs xG": Mte, "Sim. tirs xG+τ": apply_tau(Mte, tau_fit(Mtr, tr))}
np.save("res_s3.npy", {k: v.astype(np.float32) for k, v in res.items() if "xG" in k}, allow_pickle=True)
tab, _ = compare(res, te)
print(tab.set_index("méthode")[[c for c in tab.columns if c.endswith(" Δ") or c.endswith(" z")]].T.to_string())
