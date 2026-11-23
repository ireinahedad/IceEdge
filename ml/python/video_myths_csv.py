"""Chart data for the YouTube video "What actually influences a hockey prediction?".

One small CSV per graphic in content/data/video-what-influences/. Numbers match
content/MYTHBUSTERS.md. Usage (from ml/python):  python video_myths_csv.py

`expected_pct` = mean pre-game Elo win probability for those games, corrected for
Elo's home-ice overestimate (~2.6 pts), so actual vs expected compares like with like.
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from insights_common import split_relocations, is_active_team, welch_p, benjamini_hochberg

ML = os.path.dirname(HERE)
DATA = os.path.join(ML, "data")
OUT = os.path.join(os.path.dirname(ML), "content", "data", "video-what-influences")
os.makedirs(OUT, exist_ok=True)


def save(df: pd.DataFrame, name: str) -> None:
    df.to_csv(os.path.join(OUT, name), index=False, encoding="utf-8")
    print(f"  {name:38s} {len(df)} rows")


# ── team-game long format ────────────────────────────────────────────────────
g = pd.read_csv(os.path.join(DATA, "nhl_games_v4.csv"), low_memory=False)
g = split_relocations(g, "home_team", "season")
g = split_relocations(g, "away_team", "season")
g = g.sort_values(["date", "game_id"]).reset_index(drop=True)

parts = []
for side, opp in (("home", "away"), ("away", "home")):
    parts.append(pd.DataFrame({
        "game_id": g.game_id, "season": g.season, "date": g.date,
        "team": g[f"{side}_team"], "opp": g[f"{opp}_team"],
        "is_home": int(side == "home"),
        "win": g.home_win if side == "home" else 1 - g.home_win,
        "gf": g[f"{side}_score"], "ga": g[f"{opp}_score"], "ot": g.went_to_ot,
        "rest": g[f"{side}_rest_days"], "b2b": g[f"{side}_b2b"],
        "tz": g[f"{side}_tz_shift"],
        "exp": g.elo_expected if side == "home" else 1 - g.elo_expected,
    }))
L = pd.concat(parts).dropna(subset=["exp"]).sort_values(["team", "date", "game_id"]).reset_index(drop=True)
L["exp_raw"] = L.exp
L["exp"] = L.exp + (L.win - L.exp).groupby(L.is_home).transform("mean")  # remove Elo home bias
L["res"] = L.win - L.exp


def streaks(t: pd.DataFrame) -> pd.Series:
    out, s = [], 0
    for w in t.win:
        out.append(s)
        s = (s + 1 if s >= 0 else 1) if w == 1 else (s - 1 if s <= 0 else -1)
    return pd.Series(out, index=t.index)


L["streak"] = L.groupby("team", group_keys=False).apply(streaks)
H, A = L[L.is_home == 1], L[L.is_home == 0]
pct = lambda x: round(float(x) * 100, 1)


def row(label: str, d: pd.DataFrame, **extra) -> dict:
    return {"label": label, **extra, "games": len(d), "win_pct": pct(d.win.mean()), "expected_pct": pct(d.exp.mean())}


def team_split(mask: pd.Series, base: pd.DataFrame, min_n: int = 60) -> pd.DataFrame:
    m = mask.reindex(base.index).fillna(False).astype(bool)
    res = []
    for t, grp in base.groupby("team"):
        if not is_active_team(t):
            continue
        a, b = grp[m.loc[grp.index]], grp[~m.loc[grp.index]]
        if len(a) < min_n or len(b) < min_n:
            continue
        res.append({"team": t, "games": len(a), "win_pct": pct(a.win.mean()), "win_pct_otherwise": pct(b.win.mean()),
                    "vs_expected_pts": round((a.res.mean() - b.res.mean()) * 100, 1),
                    "p": welch_p(a.res.mean(), a.res.var(), len(a), b.res.mean(), b.res.var(), len(b))})
    df = pd.DataFrame(res)
    df["holds_up"] = benjamini_hochberg(df.p.tolist())
    return df.drop(columns="p").sort_values("vs_expected_pts").reset_index(drop=True)


print(f"Writing to {OUT}")

# 01 cold open: favourites (raw pre-game odds = what a viewer would have seen)
save(pd.DataFrame([
    {"label": "Coin flip", "win_pct": 50.0, "games": None, "odds_said_pct": 50.0},
    {"label": "Favourite (any)", "win_pct": pct(L[L.exp_raw > .5].win.mean()), "games": int((L.exp_raw > .5).sum()),
     "odds_said_pct": pct(L[L.exp_raw > .5].exp_raw.mean())},
    {"label": "Big favourite (65%+)", "win_pct": pct(L[L.exp_raw >= .65].win.mean()), "games": int((L.exp_raw >= .65).sum()),
     "odds_said_pct": pct(L[L.exp_raw >= .65].exp_raw.mean())},
]), "01_favourite_win_rate.csv")

# 02 ANA @ CAR 2023-02-25 (+ shot-danger explainer + losers outshooting)
mp = pd.read_csv(os.path.join(DATA, "mp_team_games.csv"), low_memory=False, usecols=[
    "gameId", "team", "opposingTeam", "gameDate", "home_or_away", "situation", "playoffGame",
    "shotsOnGoalFor", "shotsOnGoalAgainst", "goalsFor", "goalsAgainst", "xGoalsFor", "xGoalsAgainst",
    "hitsFor", "hitsAgainst", "faceOffsWonFor", "faceOffsWonAgainst", "penalityMinutesFor", "penalityMinutesAgainst",
    "takeawaysFor", "takeawaysAgainst", "highDangerShotsFor", "highDangerShotsAgainst",
    "lowDangerShotsFor", "mediumDangerShotsFor", "lowDangerGoalsFor", "mediumDangerGoalsFor", "highDangerGoalsFor"])
mp = mp[(mp.situation == "all") & (mp.playoffGame == 0)]
mp = mp.merge(g[["game_id", "home_win"]].rename(columns={"game_id": "gameId"}), on="gameId")
mp["win"] = np.where(mp.home_or_away == "HOME", mp.home_win, 1 - mp.home_win)

def game_card(date: int, team: str, fname: str) -> None:
    r = mp[(mp.gameDate == date) & (mp.team == team)]
    save(r[["gameDate", "team", "opposingTeam", "home_or_away", "goalsFor", "goalsAgainst",
            "shotsOnGoalFor", "shotsOnGoalAgainst", "xGoalsFor", "xGoalsAgainst", "hitsFor", "hitsAgainst"]].round(2), fname)

game_card(20230225, "ANA", "02_game_ANA_at_CAR_2023-02-25.csv")

# 03-06 home ice
save(H.groupby("season").win.mean().mul(100).round(1).reset_index()
     .assign(season_label=lambda d: d.season.astype(str) + "-" + (d.season + 1).astype(str).str[-2:])
     .rename(columns={"win": "home_win_pct"})[["season_label", "home_win_pct"]], "03_home_win_by_season.csv")
gap = []
for t, grp in L.groupby("team"):
    if is_active_team(t):
        h, a = grp[grp.is_home == 1], grp[grp.is_home == 0]
        gap.append({"team": t, "home_win_pct": pct(h.win.mean()), "road_win_pct": pct(a.win.mean()),
                    "gap_pts": round((h.win.mean() - a.win.mean()) * 100, 1), "home_games": len(h)})
save(pd.DataFrame(gap).sort_values("gap_pts", ascending=False), "04_home_road_gap_by_team.csv")
save(pd.DataFrame([row("Regulation", H[H.ot == 0]), row("Overtime / shootout", H[H.ot == 1])]), "05_home_win_regulation_vs_ot.csv")
nyr = L[L.team == "NYR"].pivot_table(index="season", columns="is_home", values="win", aggfunc=["mean", "size"])
save(pd.DataFrame({"season": nyr.index, "home_win_pct": (nyr[("mean", 1)] * 100).round(1).values,
                   "road_win_pct": (nyr[("mean", 0)] * 100).round(1).values,
                   "home_games": nyr[("size", 1)].values}).query("home_games >= 20"), "06_NYR_home_road_by_season.csv")

# 07-09 jet lag
tzr = [row(f"{int(z):+d} zones" if z else "0 zones", A[A.tz == z], zones_crossed=int(z)) for z in sorted(A.tz.unique())]
save(pd.DataFrame(tzr), "07_road_win_by_time_zones_crossed.csv")
save(pd.DataFrame([row("Road, 2+ zones east", A[A.tz >= 2]), row("Road, no zone change", A[A.tz == 0])]), "07b_road_east_vs_none.csv")
pit = L[L.team == "PIT"]
save(pd.DataFrame([row("Flying east", pit[pit.tz > 0]), row("All other games", pit[pit.tz <= 0]),
                   row("Flying east, before 2016", pit[(pit.tz > 0) & (pit.season < 2016)]),
                   row("Flying east, 2016 and after", pit[(pit.tz > 0) & (pit.season >= 2016)])]), "08_PIT_flying_east.csv")
vgk = L[L.team == "VGK"]
save(pd.DataFrame([row("Flying east", vgk[vgk.tz > 0]), row("All other games", vgk[vgk.tz <= 0]),
                   row("All road games", vgk[vgk.is_home == 0])]), "09_VGK_raw_stats_lie.csv")

# 10-13 back-to-backs
save(pd.DataFrame([row("2nd night of back-to-back", L[L.b2b == 1]), row("Normal schedule", L[L.b2b == 0])]), "10_b2b_league.csv")
save(pd.DataFrame([row("Home team, normal", H[H.b2b == 0]), row("Home team on back-to-back", H[H.b2b == 1])]), "11_home_ice_erased_by_b2b.csv")
save(team_split(L.b2b == 1, L), "12_b2b_by_team.csv")
s = L[L.season.between(2022, 2025)]
per = s.groupby(["team", "season"]).b2b.sum().mean()
save(pd.DataFrame([{"b2b_per_team_season": round(per, 1), "extra_losses_per_100": 4.3,
                    "wins_lost_per_season": round(per * 0.043, 2)}]), "13_b2b_math_half_a_win.csv")
lak = L[(L.team == "LAK") & (L.date == "2026-02-26")][["date", "team", "opp", "is_home", "gf", "ga", "b2b"]]
save(lak, "13b_game_LAK_vs_EDM_2026-02-26.csv")

# 14-15 rest
L["rest_bucket"] = L.rest.clip(upper=5)
save(pd.DataFrame([row({1: "1 day (back-to-back)", 5: "5+ days"}.get(r, f"{r} days"), L[L.rest_bucket == r], days=int(r))
                   for r in sorted(L.rest_bucket.unique())]), "14_rest_curve.csv")
edm = L[L.team == "EDM"]
save(pd.DataFrame([row("4+ days off", edm[edm.rest >= 4]), row("Normal rest", edm[edm.rest < 4]),
                   row("4+ days off, since 2015", edm[(edm.rest >= 4) & (edm.season >= 2015)]),
                   row("4+ days off, before 2015", edm[(edm.rest >= 4) & (edm.season < 2015)])]), "15_EDM_rest_4plus.csv")
save(edm[(edm.rest >= 4) & edm.date.isin(["2024-10-09", "2025-11-08"])][["date", "team", "opp", "is_home", "gf", "ga", "rest"]],
     "15b_EDM_rested_examples.csv")
save(team_split(L.rest >= 4, L), "15c_rest_4plus_by_team.csv")

# 16-18 shots vs chances
def more(f, a, label, margin=0):
    d = mp[mp[f] >= mp[a] + max(margin, 1)] if margin else mp[mp[f] > mp[a]]
    return {"label": label, "games": len(d), "win_pct": pct(d.win.mean())}
save(pd.DataFrame([
    more("shotsOnGoalFor", "shotsOnGoalAgainst", "More shots"),
    more("shotsOnGoalFor", "shotsOnGoalAgainst", "10+ more shots", 10),
    more("xGoalsFor", "xGoalsAgainst", "More expected goals"),
    more("highDangerShotsFor", "highDangerShotsAgainst", "More high-danger chances"),
    more("takeawaysFor", "takeawaysAgainst", "More takeaways"),
    more("faceOffsWonFor", "faceOffsWonAgainst", "More faceoffs won"),
    more("penalityMinutesFor", "penalityMinutesAgainst", "More penalty minutes"),
    more("hitsFor", "hitsAgainst", "More hits"),
    more("hitsFor", "hitsAgainst", "10+ more hits", 10),
]), "16_what_wins_inside_the_game.csv")
save(pd.DataFrame([{"zone": z, "goals_per_100_shots": round(mp[f"{k}DangerGoalsFor"].sum() / mp[f"{k}DangerShotsFor"].sum() * 100, 1),
                    "shots": int(mp[f"{k}DangerShotsFor"].sum())}
                   for z, k in [("Far (low danger)", "low"), ("Medium range", "medium"), ("Right in front (high danger)", "high")]]),
     "17_shot_danger_explainer.csv")
dec = mp[mp.goalsFor != mp.goalsAgainst]
lost = dec[dec.goalsFor < dec.goalsAgainst]
save(pd.DataFrame([{"label": "Loser outshot the winner", "pct_of_games": pct((lost.shotsOnGoalFor > lost.shotsOnGoalAgainst).mean()),
                    "games": len(lost)}]), "18_losers_outshoot_winners.csv")
game_card(20221126, "PIT", "18b_game_PIT_hits_vs_TOR_2022-11-26.csv")

# 19-21 streaks
save(pd.DataFrame([row("After 5+ wins", L[L.streak >= 5]), row("After 3+ wins", L[L.streak >= 3]),
                   row("After 3+ losses", L[L.streak <= -3]), row("After 5+ losses", L[L.streak <= -5])]), "19_streaks_actual_vs_expected.csv")
hot = team_split(L.streak >= 3, L)
save(hot, "20_after_3_wins_by_team.csv")
e = L[(L.team == "EDM") & L.date.between("2023-11-01", "2024-02-06")]
e = e[e.index >= e[(e.streak <= 0) & (e.date < "2024-02-06")].index.max()]  # first win of the streak -> the loss that ended it
save(e[["date", "opp", "is_home", "gf", "ga", "win", "rest"]].assign(streak_before=e.streak), "21_EDM_16_game_streak.csv")

# 22 verdict scoreboard
save(pd.DataFrame([
    {"order": 1, "belief": "Home ice matters", "verdict": "TENDENCY", "true": True, "outlier": "NYR"},
    {"order": 2, "belief": "Jet lag hurts", "verdict": "OUTLIER", "true": False, "outlier": "PIT"},
    {"order": 3, "belief": "Back-to-backs hurt", "verdict": "TENDENCY", "true": True, "outlier": "DAL, WSH"},
    {"order": 4, "belief": "More rest = better", "verdict": "OUTLIER", "true": False, "outlier": "EDM"},
    {"order": 5, "belief": "Shot quality beats shot volume", "verdict": "TENDENCY", "true": True, "outlier": ""},
    {"order": 6, "belief": "Hot streaks continue", "verdict": "OUTLIER", "true": False, "outlier": "TOR, NYR"},
]), "22_verdict_scoreboard.csv")
print("done")
