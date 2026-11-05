# ArakIce NHL predictions — public record

Pre-game NHL probabilities from the [ArakIce](https://arakice.com) model, committed here **every morning
before the games**, then scored against the final results. The point is a record nobody can quietly edit:
each day is one commit, made before puck drop, and never changed afterwards.

**Current numbers: [RECORD.md](RECORD.md)** (machine-readable: [`record.json`](record.json)).

## What is published

One file per NHL game day, `data/YYYY/YYYY-MM-DD.json`, written around 15:00 UTC (10:00 or 11:00 US Eastern):

| Field | Meaning |
|---|---|
| `homeWin` | P(home team wins), overtime and shootout included |
| `homeMinus1_5` | P(home team wins by 2 or more goals) |
| `awayMinus1_5` | P(away team wins by 2 or more goals) |
| `goaliesConfirmed` | `false` = usual starter assumed |
| `modelVersion` | model that produced the numbers (e.g. `score-nhl-v1.0`) |
| `recordedAt` | when the model produced the numbers |
| `excluded` | games left out of the day's file, with the reason (e.g. starting too soon) |

The model takes **no betting odds as input**: its numbers come out identical with or without market prices.
Only probabilities and results are published here. There are no odds, no betting returns and no picks.

## How the record is scored

`RECORD.md` is rebuilt every day by [`scripts/build-record.mjs`](scripts/build-record.mjs) (Node 20+, no install):

- **A game counts** only if the commit that added its file is earlier than the scheduled start, and the file
  was never modified after that commit. Everything else is listed in `record.json` under `notEligible`.
- **Results** come from the public NHL score feed (`api-web.nhle.com/v1/score/YYYY-MM-DD`) and are cached
  in `results/`. Postponed or cancelled games are void.
- **Home win** is the final score, overtime and shootout included (the NHL counts the shootout winner as one
  goal). **−1.5** means a final margin of 2 goals or more, so a shootout game never covers it.
- **Metrics**: log-loss and Brier score (lower is better), accuracy (the side given ≥ 50%), and calibration
  in 10% bins. For reference, a constant 50% forecast scores log-loss 0.6931 and Brier 0.25.

## Verify it yourself

```sh
git clone https://github.com/ireinahedad/arakice-nhl-predictions
cd arakice-nhl-predictions
node --test scripts/*.test.mjs
node scripts/build-record.mjs      # rebuilds RECORD.md from git history + the NHL feed
git diff --stat                    # nothing should change except the generation time
```

A git commit date is written by whoever makes the commit, so on its own it is a claim, not a proof.
The independent evidence is the time **GitHub received the push**: see this repository's
[Activity](https://github.com/ireinahedad/arakice-nhl-predictions/activity) page, or `GET https://api.github.com/repos/ireinahedad/arakice-nhl-predictions/activity`.
Rewriting history would also show there as a force push, and would break every existing clone.

## Example: compare with prediction markets

[`examples/compare-markets.mjs`](examples/compare-markets.mjs) prints today's published probabilities next to
public Kalshi and Polymarket prices, and the gap between them. Node 20+, no install, no account, no key:

```sh
node examples/compare-markets.mjs                  # today, both venues
node examples/compare-markets.mjs --source=kalshi --json
```

It only reads public endpoints and has no code to place orders. A gap is the difference between two
estimates, not a recommendation: market prices include the venue's margin, which the script does not remove.

## Data access

Coming soon: the same numbers as a JSON API at `https://agents.arakice.com` (`/openapi.json`, `/llms.txt`).
The track record will be free there too; same-day probabilities will be paid per request in USDC (x402 protocol).

---

_Model estimates. Not financial, legal or betting advice. Check the rules where you live._
