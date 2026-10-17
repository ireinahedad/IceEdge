"""Piste 1 — sélection IMBRIQUÉE des variables de la couche.

POURQUOI. Les 7 variables de la couche servie (C) ont été choisies par
`--market-gap` (2026-10-01) en regardant TOUTES les saisons, puis jugées en
walk-forward sur ces mêmes saisons : le −0,0021 (z −3,2) est donc en partie
optimiste. Ici, pour chaque saison S, la sélection est refaite sur les saisons
< S uniquement, avec le critère de `--market-gap` (variable par variable, logit p
en covariable, |z| ≥ 2), parmi les mêmes 23 candidates. Puis la couche est
ajustée sur ces seules variables et appliquée à S.

  N  = sélection sur tous les matchs passés ;
  NM = sélection sur les matchs passés AVEC cote de clôture (comme --market-gap) ;
  N3 = N avec un seuil plus dur, |z| ≥ 3.

RÈGLE FIXÉE AVANT LE RUN. La couche est « confirmée » si N bat le modèle brut à
z ≤ −2 (apparié, par match) ET sur ≥ 70 % des saisons. Sinon, son gain mesuré
venait (au moins en partie) de la sélection, et on le dit dans le doc. On
compare aussi N à C : si N est nettement moins bon que C, l'écart mesure
l'optimisme de la sélection.
"""
from lab import *


def selector(thr=2.0, need_market=False):
    def sel(P):
        if need_market:
            P = P[P["market_home_p_close"].notna()]
        y, lp = P["y"].to_numpy(), P["lp"].to_numpy()
        keep = []
        for c in GAP23:
            x = P[c].astype(float).to_numpy()
            ok = np.isfinite(x)
            if ok.sum() < 500 or np.nanstd(x[ok]) == 0:
                continue
            xs = (x[ok] - x[ok].mean()) / x[ok].std()
            b, se = BW._logistic_offset(y[ok], np.column_stack([lp[ok], xs]), np.zeros(ok.sum()))
            if abs(b[2] / se[2]) >= thr:
                keep.append(c)
        return keep
    return sel


G = load()
raw = G["p_ml"].to_numpy()
res = {"C": walk_forward(G, C7, name="C"),
       "N": walk_forward(G, select=selector(2.0), name="N"),
       "NM": walk_forward(G, select=selector(2.0, True), name="NM"),
       "N3": walk_forward(G, select=selector(3.0), name="N3")}
P = {k: as_vector(G, r) for k, r in res.items()}
mk = G["market_home_p_close"].to_numpy(float)
has_mk = np.isfinite(mk)
out = {"protocol": __doc__.strip().split("\n\n")[1:], "variants": {}, "chosen": {}}
print(f"{'':<4} {'vs brut':>10} {'z':>6} {'saisons':>8}   {'vs C':>10} {'z':>6}   ECE   vs marché")
for k, p in P.items():
    vb, vc = compare(G, p, raw, f"{k} vs brut"), compare(G, p, P["C"], f"{k} vs C")
    m = has_mk & np.isfinite(p)
    vm = BW._paired(ll(G.y.to_numpy()[m], p[m]) - ll(G.y.to_numpy()[m], mk[m]))
    rel = reliability(G, p)
    out["variants"][k] = {"vs_raw": vb, "verdict_vs_raw": verdict(vb), "vs_C": vc,
                          "vs_market": vm, "reliability": rel}
    out["chosen"][k] = res[k]["chosen"]
    print(f"{k:<4} {vb['delta']:>+10.5f} {vb['z']:>+6.2f} {vb['seasons_better']:>4}/{vb['n_seasons']}"
          f"   {vc['delta']:>+10.5f} {vc['z'] if vc['z'] is not None else 0:>+6.2f}"
          f"   {rel['ece']:.4f}  {vm['delta']:+.5f} (z {vm['z']:+.2f})  {verdict(vb)}")
m = has_mk & np.isfinite(P["C"])
vm0 = BW._paired(ll(G.y.to_numpy()[m], raw[m]) - ll(G.y.to_numpy()[m], mk[m]))
out["raw_vs_market"] = vm0
out["raw_reliability"] = reliability(G, raw, mask=np.isfinite(P["C"]))
print("brut vs marché", vm0, "ECE brut", out["raw_reliability"]["ece"])
print("\nVariables choisies par saison (N) :")
for s, f in res["N"]["chosen"].items():
    print(" ", s, f)
print("\nNM :")
for s, f in res["NM"]["chosen"].items():
    print(" ", s, f)
dump("s1_nested_report.json", out)
