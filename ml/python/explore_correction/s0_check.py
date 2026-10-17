"""Contrôle : le banc reproduit-il correction_report.json (R, C, B) ?"""
from lab import *

G = load()
print(len(G), "matchs", G.season.min(), G.season.max())
y = G["y"].to_numpy(); raw = G["p_ml"].to_numpy()
rep = json.load(open("../models/correction_report.json"))
R = as_vector(G, walk_forward(G, [], name="R"))
C = as_vector(G, walk_forward(G, C7, name="C"))
B = as_vector(G, walk_forward(G, [c for c in C7 if c != "elo_diff"], name="B"))
for lab_, p in (("R", R), ("C", C), ("B", B)):
    c = compare(G, p, raw, lab_)
    print(lab_, c["delta"], c["z"], c["seasons_better"], "/", c["n_seasons"], verdict(c),
          "| rapport:", rep["variants"][lab_]["delta"], rep["variants"][lab_]["z"])
for r in rep["by_season"]:
    s = r["season"]; m = (G.season == s).to_numpy()
    print(s, r["ll_raw"], round(ll(y[m], raw[m]).mean(), 5), r["ll_C"], round(ll(y[m], C[m]).mean(), 5))
