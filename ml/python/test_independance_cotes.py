"""
test_independance_cotes.py — X402_PLAN.md, phase 2, premier test (bloquant).

Question : les probabilités vendues (victoire domicile, handicap −1,5 de chaque
côté) dépendent-elles des cotes du marché ? `buildGameFeatures` (Node) envoie
`home_odds_decimal`, `away_odds_decimal` et `total_line_market` au service.
Si un seul chiffre bouge avec les cotes, la promesse « indépendant du marché »
est fausse.

Méthode : même match, mêmes features, on ne change QUE les champs de cotes
(absents, favori domicile écrasant, favori visiteur écrasant, totaux 5,5 / 7,5),
et on compare `probability_exact` au bit près, sur plusieurs affiches réelles.

Deux chemins :
  • normal  — le modèle de score (Poisson empilé) produit les chiffres ;
  • repli   — modèle de score indisponible : `base_prob` vient du classifieur,
              qui, lui, LIT les cotes (`market_home_p_*`). Ce test documente
              ce cas : l'API doit refuser de vendre un chiffre de repli.

Lancer :  python ml/python/test_independance_cotes.py   (code 0 = indépendant)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ML_API_KEY", "")

import ml_service as svc  # noqa: E402

MATCHUPS = [("TOR", "MTL"), ("COL", "CHI"), ("SJS", "CGY"), ("EDM", "VGK"), ("BOS", "FLA")]
ODDS_VARIANTS = {
    "sans cotes":       {},
    "domicile 1.30":    {"home_odds_decimal": 1.30, "away_odds_decimal": 3.90},
    "visiteur 1.30":    {"home_odds_decimal": 3.90, "away_odds_decimal": 1.30},
    "pile ou face":     {"home_odds_decimal": 1.95, "away_odds_decimal": 1.95},
    "total 5.5":        {"total_line_market": 5.5},
    "total 7.5 + cote": {"total_line_market": 7.5, "home_odds_decimal": 1.50, "away_odds_decimal": 2.70},
}
MARKETS = [
    ("homeWin",   "moneyline", None, True),
    ("homeMinus", "puck_line", -1.5, True),
    ("awayMinus", "puck_line", -1.5, False),
]


def base_features(home: str, away: str) -> dict:
    return dict(
        home_team=home, away_team=away,
        home_win_pct=0.55, away_win_pct=0.50,
        home_goals_for_pg=3.2, away_goals_for_pg=3.0,
        home_goals_against_pg=2.8, away_goals_against_pg=3.1,
        home_last10_win_pct=0.6, away_last10_win_pct=0.5,
        home_rest_days=2, away_rest_days=1,
    )


def price(home: str, away: str, extra: dict) -> tuple[dict, str]:
    req = svc.GameBundleRequest(
        features=svc.GameFeatures(**base_features(home, away), **extra),
        markets=[svc.BundleMarket(id=k, market_type=m, line=l, subject_is_home=h) for k, m, l, h in MARKETS],
    )
    out = svc.predict_game_bundle(req)
    probs, types = {}, set()
    for k, *_ in MARKETS:
        r = out.results.get(k)
        probs[k] = None if r is None else (r.probability_exact if r.probability_exact is not None else r.probability / 100)
        if r is not None:
            types.add(r.model_type)
    return probs, " | ".join(sorted(types))


def run(label: str) -> list[str]:
    diffs = []
    for home, away in MATCHUPS:
        ref, ref_type = price(home, away, {})
        print(f"  {away}@{home}  {ref_type}  " + "  ".join(f"{k}={v:.5f}" for k, v in ref.items() if v is not None))
        for name, extra in ODDS_VARIANTS.items():
            got, _ = price(home, away, extra)
            for k in ref:
                if ref[k] != got[k]:
                    diffs.append(f"{label} {away}@{home} [{name}] {k}: {ref[k]} → {got[k]}")
    return diffs


if __name__ == "__main__":
    if svc._xgb_score is None:
        print("❌ modèle de score non chargé : le test ne mesure rien")
        sys.exit(2)

    print("Chemin normal (modèle de score) :")
    normal = run("normal")

    print("\nChemin de repli (modèle de score désactivé) :")
    saved = svc._xgb_score
    svc._xgb_score = None
    try:
        fallback = run("repli")
    finally:
        svc._xgb_score = saved

    print()
    if normal:
        print(f"❌ DÉPENDANT DES COTES sur le chemin normal ({len(normal)} écarts) :")
        print("\n".join("   " + d for d in normal[:20]))
    else:
        print(f"✅ Chemin normal : {len(MATCHUPS)} matchs × {len(ODDS_VARIANTS)} variantes × {len(MARKETS)} marchés, chiffres identiques au bit près.")
    if fallback:
        print(f"⚠️  Chemin de repli : {len(fallback)} écarts — un chiffre de repli ne doit jamais être vendu. Ex. :")
        print("\n".join("   " + d for d in fallback[:4]))
    else:
        print("✅ Chemin de repli : identique aussi.")
    sys.exit(1 if normal else 0)
