# ArakIce ML Service

Standalone FastAPI service. Node.js calls it; it replies with ML-generated probabilities.

## Setup

```bash
cd server/python
pip install -r requirements.txt
python ml_service.py
# → runs on http://localhost:8000
```

## Endpoints

| Method | Path | Body |
|---|---|---|
| POST | `/predict/game` | `GameFeatures` |
| POST | `/predict/player` | `PlayerPropFeatures` |
| POST | `/predict/team` | `TeamFuturesFeatures` |
| GET | `/health` | — |
| GET | `/features` | — |

Interactive docs: http://localhost:8000/docs (disabled once deployed).

## Access control

`/predict/*` and `/features` require the `X-ML-Token` header to match
`ML_API_TOKEN`; `/health` and `/health/ready` stay open for platform probes.
Locally, leaving `ML_API_TOKEN` unset skips the check. In a deployed
environment (`ENVIRONMENT=production` or Railway) the service **refuses to
start** without a token — set `ML_AUTH_DISABLED=true` only if the service has no
public domain at all. `ML_CORS_ORIGINS` (comma-separated) opts specific browser
origins in; none are allowed by default, since the Node backend proxies
everything. See `DEPLOYMENT.md` §3.

```bash
curl -X POST http://localhost:8000/predict/game \
  -H "Content-Type: application/json" -H "X-ML-Token: $ML_API_TOKEN" -d '{...}'
```

## Training a real model

Replace the hand-tuned logistic coefficients in `ml_service.py` with a trained sklearn model:

```python
# In a separate train.py:
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
import pickle, pandas as pd

df = pd.read_csv("historical_nhl_games.csv")  # collect from NHL API
X = df[FEATURE_COLS]
y = df["home_win"]

model = GradientBoostingClassifier(n_estimators=200)
model.fit(X, y)

pickle.dump(model, open("model.pkl", "wb"))
```

Then load in `ml_service.py`:
```python
model = pickle.load(open("model.pkl", "rb"))

@app.post("/predict/game")
def predict_game(f: GameFeatures):
    X = [[f.home_win_pct, f.away_win_pct, ...]]
    prob = model.predict_proba(X)[0][1]
    importances = model.feature_importances_  # GBM
    ...
```
