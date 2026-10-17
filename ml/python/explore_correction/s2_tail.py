"""Piste 2 — la queue des gros favoris.

POURQUOI. `--market-gap` : quand le marché donne ≥ 70 % au favori, il gagne
69,8 % ; le modèle disait 64,4 %, le marché 67,1 %. La couche est LINÉAIRE en
logit p : un seul coefficient pour le milieu et pour les queues. Elle ne peut
pas étirer les queues sans déformer le milieu.

Variantes, toutes = couche C (7 variables) + un terme sur logit p :
  C_abs    : + logit·|logit|         (étire / comprime les queues, symétrique)
  C_cube   : + logit³
  C_h60    : + pentes à part au-delà de |logit| > 0,6  (p < 35 % ou > 65 %)
  C_h85    : + pentes à part au-delà de |logit| > 0,85 (p < 30 % ou > 70 %)

RÈGLE FIXÉE AVANT LE RUN. Adoptée si elle bat C en log-loss à z ≤ −2 (apparié)
ET sur ≥ 70 % des saisons. Calibration de la queue (favori ≥ 65 %, et matchs où
le MARCHÉ donne ≥ 70 %) et ECE : affichées, elles ne décident pas seules —
une queue mieux calibrée qui coûte en log-loss ailleurs n'est pas un progrès.
"""
from lab import *

G = load()
raw = G["p_ml"].to_numpy()
mk = G["market_home_p_close"].to_numpy(float)
y = G["y"].to_numpy()
variants = {"C": "lin", "C_abs": "abs", "C_cube": "cube", "C_h60": "hinge0.6", "C_h85": "hinge0.85"}
P = {k: as_vector(G, walk_forward(G, C7, basis=b, name=k)) for k, b in variants.items()}
ok = np.isfinite(P["C"])
mfav = np.isfinite(mk) & (np.maximum(mk, 1 - mk) >= 0.70) & ok


def mkt_tail(p):
    """Matchs où le marché donne ≥ 70 % : victoire du favori du MARCHÉ, prédite vs observée."""
    yf = np.where(mk >= 0.5, y, 1 - y)[mfav]
    pf = np.where(mk >= 0.5, p, 1 - p)[mfav]
    return {"n": int(mfav.sum()), "pred": round(float(pf.mean()), 4), "obs": round(float(yf.mean()), 4),
            "market": round(float(np.maximum(mk, 1 - mk)[mfav].mean()), 4)}


out = {"protocol": __doc__.strip().split("\n\n")[1:], "variants": {}}
print(f"{'':<7} {'vs C':>10} {'z':>6} {'saisons':>8}  ECE    fav≥65% préd/obs (n)      marché≥70% préd/obs")
for k, p in P.items():
    vc = compare(G, p, P["C"], k)
    rel = reliability(G, p, edges=(0, .25, .3, .35, .4, .45, .5, .55, .6, .65, .7, .75, 1.0))
    ft, mt = fav_tail(G, p, 0.65), mkt_tail(p)
    out["variants"][k] = {"vs_C": vc, "verdict_vs_C": verdict(vc) if k != "C" else "-",
                          "vs_raw": compare(G, p, raw), "reliability": rel,
                          "fav_tail_65": ft, "market_tail_70": mt}
    print(f"{k:<7} {vc['delta']:>+10.5f} {vc['z'] or 0:>+6.2f} {vc['seasons_better']:>4}/{vc['n_seasons']}"
          f"  {rel['ece']:.4f}  {ft['pred']:.3f}/{ft['obs']:.3f} ({ft['n']})"
          f"   {mt['pred']:.3f}/{mt['obs']:.3f} (marché {mt['market']:.3f}, n {mt['n']})"
          f"  {out['variants'][k]['verdict_vs_C']}")
ft, mt = fav_tail(G, raw, 0.65, mask=ok), mkt_tail(raw)
out["raw"] = {"fav_tail_65": ft, "market_tail_70": mt, "reliability": reliability(G, raw, mask=ok)}
print(f"brut                                  {out['raw']['reliability']['ece']:.4f}  {ft['pred']:.3f}/{ft['obs']:.3f} ({ft['n']})"
      f"   {mt['pred']:.3f}/{mt['obs']:.3f}")
print("\nCalibration C (tranche, n, prédit, observé, z) :")
for r in out["variants"]["C"]["reliability"]["bins"]:
    print("  ", r)
dump("s2_tail_report.json", out)
