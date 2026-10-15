"""Validation des marchés de période avec le moteur SERVI (`game_dynamics`).

Pour chaque saison S du test : c ajusté sur S-3..S-1 (relatif), comme le fera
`game_dynamics.py` en service. Comparé à l'heuristique actuelle de
`ml_service` (Skellam sur part cumulée, Poisson de part fixe). Deux niveaux :
λ bruts, et λ recalés au niveau observé (contrôle du biais de niveau)."""
import math, sys
import numpy as np, pandas as pd
from harness import *
sys.path.insert(0, str(HERE.parent))
import game_dynamics as GD

SH = (0.305, 0.365, 0.330)
X = load()
G = pd.read_csv(DATA / "live_goals.csv"); G = G[G.period <= 3]
cnt = G.groupby("game_id").size()
X["ok"] = (X.game_id // 1_000_000).isin(set(G.game_id // 1_000_000)) & (X.game_id.map(cnt).fillna(0) == X.hr + X.ar)
te = X[(X.split == "test") & X.ok].reset_index(drop=True)
per = G[G.game_id.isin(te.game_id)].groupby(["game_id", "period", "home_scored"]).size().unstack([1, 2], fill_value=0)
def col(p, h): return te.game_id.map(per[(p, h)]).fillna(0).values if (p, h) in per.columns else np.zeros(len(te))
yh = {p: col(p, 1) for p in (1, 2, 3)}; ya = {p: col(p, 0) for p in (1, 2, 3)}
c_roll = {S: GD.fit_cells(X[(X.season >= S - 3) & (X.season < S) & X.ok], G)[0] for S in sorted(te.season.unique())}

def pois(k, l): return math.exp(-l + k * math.log(l) - math.lgamma(k + 1))
def heur(lh, la):
    o = {}
    for n in (1, 2):
        f = SH[0] if n == 1 else SH[0] + SH[1]
        ph = [pois(k, lh * f) for k in range(16)]; pa = [pois(k, la * f) for k in range(16)]
        lead = sum(ph[i] * pa[j] for i in range(16) for j in range(16) if i > j)
        draw = sum(ph[i] * pa[i] for i in range(16)); o[f"win{n}"] = (lead, draw, 1 - lead - draw)
    for n in (1, 2, 3):
        o[f"g{n}"] = np.array([pois(k, (lh + la) * SH[n - 1]) for k in range(10)])
    pm = [[pois(k, (lh + la) * s) for k in range(16)] for s in SH]
    cb = [[sum(p[:k]) for k in range(16)] for p in pm]
    st = [sum(pm[i][k] * cb[a][k] * cb[b][k] for k in range(16)) for i, (a, b) in enumerate(((1, 2), (0, 2), (0, 1)))]
    o["hi"] = (*st, 1 - sum(st)); return o
def dyn(lh, la, c):
    r = GD.period_dynamics(lh, la, c); L = r["lead_values"]; o = {}
    for n in (1, 2):
        d = r["lead_after"][n]; o[f"win{n}"] = (d[L > 0].sum(), d[L == 0].sum(), d[L < 0].sum())
    for n in (1, 2, 3): o[f"g{n}"] = r["goals"][n]
    h = r["highest"]; o["hi"] = (h["P1"], h["P2"], h["P3"], h["tie"]); return o

def run(scale_h, scale_a, label):
    rows = {}
    loss = {k: {"heur": [], "dyn": []} for k in ["P1 vainqueur (3 voies)", "P2 vainqueur (3 voies)", "Période la + prolifique (4 voies)"]
            + [f"P{p} total > {L}" for p in (1, 2, 3) for L in (0.5, 1.5, 2.5)]}
    for i, r in te.iterrows():
        lh, la = r.lam_h * scale_h, r.lam_a * scale_a
        for nm, o in (("heur", heur(lh, la)), ("dyn", dyn(lh, la, c_roll[r.season]))):
            for n in (1, 2):
                h = sum(yh[p][i] for p in range(1, n + 1)); a = sum(ya[p][i] for p in range(1, n + 1))
                k = 0 if h > a else (1 if h == a else 2)
                loss[f"P{n} vainqueur (3 voies)"][nm].append(-math.log(max(o[f"win{n}"][k], 1e-9)))
            gt = [yh[p][i] + ya[p][i] for p in (1, 2, 3)]
            m = max(gt); top = [p for p in range(3) if gt[p] == m]
            k = top[0] if len(top) == 1 else 3
            loss["Période la + prolifique (4 voies)"][nm].append(-math.log(max(o["hi"][k], 1e-9)))
            for p in (1, 2, 3):
                g = o[f"g{p}"] / o[f"g{p}"].sum()
                for L in (0.5, 1.5, 2.5):
                    q = float(np.clip(g[int(L) + 1:].sum(), 1e-9, 1 - 1e-9)); y = gt[p - 1] > L
                    loss[f"P{p} total > {L}"][nm].append(-math.log(q if y else 1 - q))
    out = []
    for k, v in loss.items():
        a, b = np.array(v["heur"]), np.array(v["dyn"]); d = b - a
        out.append({"marché": k, "heuristique": a.mean().round(5), "dynamique": b.mean().round(5),
                    "Δ": d.mean().round(5), "z": (d.mean() / (d.std(ddof=1) / math.sqrt(len(d)))).round(2)})
    print(f"\n=== {label} — {len(te)} matchs horodatés du test ===")
    print(pd.DataFrame(out).to_string(index=False))
run(1.0, 1.0, "λ bruts (servis sans level_layer)")
run(te.hr.mean() / te.lam_h.mean(), te.ar.mean() / te.lam_a.mean(), "λ recalés au niveau observé")
