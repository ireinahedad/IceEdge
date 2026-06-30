# ICEEDGE ML Service

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

Interactive docs: http://localhost:8000/docs

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
