"""
backtest.py (v4)
================
Backtest "value betting" du modèle sur le TEST SET uniquement (jamais vu à
l'entraînement) : on parie quand la proba du modèle diverge assez de la proba
implicite du marché.

Stratégies évaluées :
  • Flat 1u, seuil d'edge variable (1% → 8%)
  • Kelly fractionné (1/4)
Métriques : ROI, nb de paris, hit rate, log-loss comparé au marché.

Usage :
    cd ml/python
    python backtest.py               # utilise le blend si dispo
    python backtest.py --use raw     # modèle calibré sans blend
"""

import argparse
import json

import numpy as np
import pandas as pd
import xgboost as xgb

DATA   = "../data/nhl_games_v4.csv"
MODELS = "../models"


def _logit(p, eps=1e-7):
    p = np.clip(p, eps, 1 - eps)
    return np.log(p / (1 - p))

def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--use", choices=["blend", "raw"], default="blend")
    args = ap.parse_args()

    report = json.load(open(f"{MODELS}/training_report.json"))
    feats = report["features"]["game"]
    gr = report["game_model"]

    df = pd.read_csv(DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    test = df.iloc[int(len(df) * 0.8):].copy()

    need = ["market_home_p_close", "home_ml_close", "away_ml_close"]
    if not all(c in test.columns for c in need):
        print("❌ Pas de cotes dans le dataset — backtest ROI impossible.")
        return
    test = test[test["market_home_p_close"].notna()].copy()
    if len(test) < 100:
        print(f"❌ Seulement {len(test)} matchs de test avec cotes — backtest peu fiable.")
        return
    print(f"📊 Backtest sur {len(test)} matchs de test avec cotes "
          f"({test['date'].min()} → {test['date'].max()})")

    model = xgb.Booster()
    model.load_model(f"{MODELS}/game_model.json")
    dm = xgb.DMatrix(test[feats].values.astype(np.float32),
                     feature_names=feats, missing=np.nan)
    p_raw = model.predict(dm)

    cal = gr["calibration"]
    p_model = _sigmoid(cal["a"] * _logit(p_raw) + cal["b"])

    blend_w = (gr.get("baselines", {}).get("market", {}) or {}).get("blend_weights")
    if args.use == "blend" and blend_w:
        w = blend_w
        p_model = _sigmoid(w[0] * _logit(p_raw)
                           + w[1] * _logit(test["market_home_p_close"].values) + w[2])
        print("   → probas = blend modèle ⊕ marché")
    else:
        print("   → probas = modèle calibré (sans blend)")

    y = test["home_win"].values.astype(float)
    p_mkt = test["market_home_p_close"].values
    dec_h = test["home_ml_close"].values
    dec_a = test["away_ml_close"].values

    ll_model = -np.mean(y * np.log(np.clip(p_model, 1e-7, 1))
                        + (1 - y) * np.log(np.clip(1 - p_model, 1e-7, 1)))
    ll_mkt = -np.mean(y * np.log(p_mkt) + (1 - y) * np.log(1 - p_mkt))
    print(f"\n   Log-loss : modèle {ll_model:.4f}  vs marché {ll_mkt:.4f}")

    results = []
    print(f"\n   {'edge>':>6} {'paris':>6} {'hit%':>6} {'ROI flat':>9} {'ROI ¼Kelly':>11}")
    for edge in [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]:
        profit_flat, profit_kelly, stake_kelly, bets, wins = 0.0, 0.0, 0.0, 0, 0
        for i in range(len(test)):
            if not (np.isfinite(dec_h[i]) and np.isfinite(dec_a[i])):
                continue
            for p, dec, won in [(p_model[i], dec_h[i], y[i] == 1),
                                (1 - p_model[i], dec_a[i], y[i] == 0)]:
                if dec <= 1:
                    continue
                p_imp = (1 / dec) / (1 / dec_h[i] + 1 / dec_a[i])   # dévigé
                if p - p_imp < edge:
                    continue
                bets += 1
                wins += int(won)
                profit_flat += (dec - 1) if won else -1
                b = dec - 1
                k = max(0.0, (p * b - (1 - p)) / b) * 0.25
                stake_kelly += k
                profit_kelly += k * b if won else -k
        roi_f = profit_flat / bets * 100 if bets else 0
        roi_k = profit_kelly / stake_kelly * 100 if stake_kelly > 0 else 0
        hit = wins / bets * 100 if bets else 0
        results.append({"edge_threshold": edge, "n_bets": bets,
                        "hit_rate": round(hit, 2), "roi_flat_pct": round(roi_f, 2),
                        "roi_kelly_pct": round(roi_k, 2)})
        print(f"   {edge:>5.0%} {bets:>6} {hit:>5.1f}% {roi_f:>8.2f}% {roi_k:>10.2f}%")

    out = {"n_test_games": len(test),
           "period": [str(test["date"].min()), str(test["date"].max())],
           "probas": args.use,
           "log_loss": {"model": round(float(ll_model), 4), "market": round(float(ll_mkt), 4)},
           "strategies": results}
    json.dump(out, open(f"{MODELS}/backtest_report.json", "w"), indent=2)
    print(f"\n✅ backtest_report.json → {MODELS}/")
    print("   ⚠️ ROI basé sur cotes de clôture historiques — le marché réel bouge. "
          "Un ROI flat > 0 avec ≥ 200 paris est déjà un excellent signe.")


if __name__ == "__main__":
    main()
