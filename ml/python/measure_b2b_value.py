"""
measure_b2b_value.py
====================
Étape P4 (STATUS.md §3.5 P), 2026-10-12 : la chaîne SERVIE et la règle des value
bets se trompent-elles sur les équipes en back-to-back ?

  1. Calibration, du point de vue de l'équipe SEULE en b2b (l'adversaire ne l'est
     pas) : victoires réelles vs p servie (`served_pregame.csv`) vs clôture dévigée.
  2. Règle des value bets en service (edge vs prix d'OUVERTURE dans [2 %, 6 %],
     EV ≥ 0) : ROI des paris SUR l'équipe en b2b, CONTRE elle, et des autres.
  3. Walk-forward : un terme b2b de plus au-dessus de la chaîne servie
     (logistique sur logit p + b2b_diff, ajustée sur les saisons < S) améliore-t-il
     le moneyline ? Critère fixé avant le run, celui de `--correction` :
     z ≤ −2 (apparié par match) ET gain sur ≥ 70 % des saisons.

Entrées : ../data/nhl_games_v4.csv, ../data/served_pregame.csv (live_pregame.py --served)
Sortie  : ../models/b2b_value_report.json

Usage : cd ml/python && python measure_b2b_value.py
"""
import json, math
import numpy as np, pandas as pd
D = "../data"
g = pd.read_csv(f"{D}/nhl_games_v4.csv", low_memory=False)
s = pd.read_csv(f"{D}/served_pregame.csv")
df = g.merge(s[["game_id", "p_home_win", "p_home_corr", "p_home_raw"]], on="game_id")
df = df[df.p_home_corr.notna() & df.home_win.notna()].copy()          # 2015-16 → 2026-27
df["date"] = pd.to_datetime(df["date"])
EPS = 1e-6

def rz(y, p):
    p = np.clip(p, EPS, 1-EPS); return float((y-p).sum()/math.sqrt((p*(1-p)).sum()))

def side_rows(d):
    """Deux lignes par match (point de vue de chaque équipe)."""
    rows = []
    for me, op, home in (("home","away",True),("away","home",False)):
        r = pd.DataFrame({
            "game_id": d.game_id, "season": d.season, "source": d.source.fillna(""),
            "y": d.home_win if home else 1-d.home_win,
            "p": d.p_home_win if home else 1-d.p_home_win,
            "p_open": d.market_home_p_open if home else 1-d.market_home_p_open,
            "p_close": d.market_home_p_close if home else 1-d.market_home_p_close,
            "dec_open": d[f"{me}_ml_open"], "dec_close": d[f"{me}_ml_close"],
            "me_b2b": d[f"{me}_b2b"], "op_b2b": d[f"{op}_b2b"]})
        rows.append(r)
    return pd.concat(rows, ignore_index=True)

T = side_rows(df)
T["cat"] = np.select([(T.me_b2b==1)&(T.op_b2b==0), (T.me_b2b==0)&(T.op_b2b==1)],
                     ["équipe seule en b2b", "adversaire seul en b2b"], "autre")
out = {}
# 1. Calibration : servi vs marché vs réel
cal = {}
for cat, x in T.groupby("cat"):
    m = x.p_close.notna()
    cal[cat] = {"n": int(len(x)), "victoires": round(x.y.mean(),4), "servi": round(x.p.mean(),4),
                "z_servi": round(rz(x.y.values, x.p.values),2),
                "n_cotes": int(m.sum()), "victoires_cotes": round(x.y[m].mean(),4),
                "marche_cloture": round(x.p_close[m].mean(),4), "servi_cotes": round(x.p[m].mean(),4),
                "z_marche": round(rz(x.y[m].values, x.p_close[m].values),2)}
out["calibration"] = cal
# par période
per = {}
for lab, ss in (("2015-2019", range(2015,2020)), ("2020-2026", range(2020,2027))):
    x = T[(T.cat=="équipe seule en b2b") & T.season.isin(ss)]
    m = x.p_close.notna()
    per[lab] = {"n": int(len(x)), "victoires": round(x.y.mean(),4), "servi": round(x.p.mean(),4),
                "z_servi": round(rz(x.y.values,x.p.values),2), "n_cotes": int(m.sum()),
                "marche": round(x.p_close[m].mean(),4), "z_marche": round(rz(x.y[m].values,x.p_close[m].values),2)}
out["equipe_b2b_par_periode"] = per

# 2. Règle des value bets en service : edge vs prix d'OUVERTURE dans [2 %, 6 %], EV >= 0
V = T[T.p_open.notna() & T.dec_open.notna() & (T.dec_open > 1)].copy()
V["edge"] = V.p - V.p_open
V["ev"] = V.p*V.dec_open - 1
sel = V[(V.edge >= 0.02-1e-9) & (V.edge <= 0.06+1e-9) & (V.ev >= -1e-9)].copy()
sel["pnl"] = np.where(sel.y==1, sel.dec_open-1, -1.0)
sel["clv"] = sel.p_close - sel.p_open
vb = {}
for cat, x in sel.groupby("cat"):
    se = x.pnl.std(ddof=1)/math.sqrt(len(x))
    c = x.clv.dropna()
    vb[cat] = {"paris": int(len(x)), "part": round(len(x)/len(sel),3),
               "reussite": round(x.y.mean(),4), "p_servi_moy": round(x.p.mean(),4),
               "roi_pct": round(x.pnl.mean()*100,2), "roi_se_pct": round(se*100,2),
               "clv_moy": round(c.mean(),4), "clv_t": round(c.mean()/(c.std(ddof=1)/math.sqrt(len(c))),2)}
out["value_bets_regle_servie"] = vb
out["value_bets_total"] = int(len(sel))
# part des matchs b2b dans l'univers
out["part_univers"] = (V.cat.value_counts(normalize=True).round(3)).to_dict()
REPORT = out

# ── 3. Walk-forward ──
g = pd.read_csv(f"{D}/nhl_games_v4.csv", low_memory=False)
s = pd.read_csv(f"{D}/served_pregame.csv")
df = g.merge(s[["game_id","p_home_win","p_home_corr"]], on="game_id")
df = df[df.p_home_corr.notna() & df.home_win.notna()].sort_values("date").reset_index(drop=True)
E=1e-6
lg = lambda p: np.log(np.clip(p,E,1-E)/(1-np.clip(p,E,1-E)))
ll = lambda y,p: -(y*np.log(np.clip(p,E,1))+(1-y)*np.log(np.clip(1-p,E,1)))
def fit(X, y, it=50):
    A=np.column_stack([np.ones(len(X)),X]); b=np.zeros(A.shape[1])
    for _ in range(it):
        p=1/(1+np.exp(-A@b)); W=p*(1-p); H=A.T@(A*W[:,None])+1e-9*np.eye(len(b))
        st=np.linalg.solve(H,A.T@(y-p)); b+=st
        if np.abs(st).max()<1e-10: break
    return b
variants = {"b2b_diff": df.b2b_diff.fillna(0).values}
y = df.home_win.values.astype(float); lp = lg(df.p_home_win.values); S = df.season.values
seasons = sorted(set(S)); out = {}
for name, x in variants.items():
    D_all=[]; by=[]; coefs=[]
    for i, ss in enumerate(seasons):
        past = seasons[:i]
        if len(past) < 3: continue
        tr = np.isin(S, past); te = S==ss
        b = fit(np.column_stack([lp[tr], x[tr]]), y[tr])
        p2 = 1/(1+np.exp(-(b[0]+b[1]*lp[te]+b[2]*x[te])))
        d = ll(y[te],p2)-ll(y[te],1/(1+np.exp(-lp[te])))
        D_all.append(d); by.append({"saison":int(ss),"n":int(te.sum()),"delta":round(float(d.mean()),6),"coef_b2b":round(float(b[2]),4)})
    d = np.concatenate(D_all); se = d.std(ddof=1)/math.sqrt(len(d))
    better = sum(1 for r in by if r["delta"]<0)
    z = d.mean()/se
    out[name] = {"n":int(len(d)),"delta":round(float(d.mean()),6),"se":round(float(se),6),"z":round(float(z),2),
                 "saisons_meilleures":f"{better}/{len(by)}",
                 "verdict": "ADOPTER" if z<=-2 and better/len(by)>=0.7 else ("PIRE" if z>=2 else "NON TRANCHABLE"),
                 "par_saison":by}
REPORT["walk_forward_terme_b2b"] = out["b2b_diff"]
REPORT["generated"] = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%MZ")
json.dump(REPORT, open("../models/b2b_value_report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in REPORT.items() if k != "walk_forward_terme_b2b"}, ensure_ascii=False, indent=1))
w = REPORT["walk_forward_terme_b2b"]
print("walk-forward :", {k: v for k, v in w.items() if k != "par_saison"})
