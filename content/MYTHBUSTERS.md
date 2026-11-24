# NHL myths: true or false? (research for the ArakIce YouTube video)

Generated 2026-11-22 from `ml/data/nhl_games_v4.csv` (21,651 regular-season games, 2008-09 → Oct 2026)
and `ml/data/mp_team_games.csv` (MoneyPuck box scores). Say **"since 2008"** on screen, never "this season".

**How each claim was checked**
- *Win %* = raw win rate, OT/shootout wins included.
- *vs expected* = result compared to the pre-game Elo probability, which removes team strength, opponent
  and era. Elo overrates home teams by 2.6 pts, which is corrected here. This is the number that decides TRUE/FALSE.
- Team exceptions: team compared to its own other games, at least 60 games in the split, and the result must survive the
  Benjamini-Hochberg correction across 32 teams (q = 0.10). Anything that fails is marked *doesn't hold up*.

Video format per segment: **the belief → the league chart → the verdict → the team that breaks the rule.**

---

## 1. Home ice matters: TRUE
- Home teams win **54.3%** (n = 21,651). Every season sits between 52% and 57%.
- Twist: in **overtime** it nearly vanishes, **50.8%** home (n = 4,976) vs 55.4% in regulation.
- **Exception: Rangers.** Madison Square Garden gives them nothing: **54.8% home vs 52.1% road** (n = 703, no significant gap).
  Opposite extreme: **Lightning 63.2% home vs 48.2% road (+15 pts)**, Penguins +13.3.
- Chart: bar per team, home % minus road %, NYR at the bottom, TBL at the top.

## 2. Tired teams lose (back-to-back): TRUE
- Second night of a back-to-back: **44.9% vs 51.0%**, **−4.3 pts vs expected** (n = 7,287).
- A home team on a back-to-back wins **50.4%**, a coin flip: fatigue erases home ice.
- Tired vs rested opponent: **42.6%**.
- **Exception (hit even harder): Stars (−10.2) and Capitals (−10.0).** No team is significantly immune.

## 3. More rest = better: FALSE
- Win % by days of rest: 1 day 44.9 · 2 days 50.8 · 3 days 52.1 · 4 days 51.3 · 5+ days 49.4.
- 4+ days vs normal rest: **50.3% vs 50.0%**, **+0.1 pts vs expected**. Past normal rest, extra days do nothing.
  The rule is "being tired hurts", not "more rest helps".
- **Exception: Oilers.** With 4+ days off they win **33.0%** vs 47.6% otherwise (n = 115), **−15.5 pts vs expected**.
- Hook: *"Give the Oilers a week off and they forget how to win."*

## 4. Jet lag (crossing time zones): FALSE
- Crossing any time zone: 49.4% vs 50.3%, no penalty vs expected.
- Road team flying 2+ zones east: **44.8% vs 45.7%** for other road games, identical.
- **Exception: Penguins flying east: 70.1%** vs 54.6% (n = 117, **+14.5 vs expected**).
- Teaser for "raw stats lie": Vegas flying east wins only **41.9% vs 60.4%**, which looks huge,
  but every one of those games is a road game; adjusted, it *doesn't hold up*.

## 5. Long road trips wear you down: NOT PROVEN
- Game 4+ of a road trip: 44.1% vs 46.0% (p = 0.10, not conclusive).
- "Getaway game" (last game before flying home): **45.6% vs 45.0%**, no effect on wins.
- Correction (2026-11-24): the earlier "skaters score 5.8% fewer points in getaway games" was a home/road effect.
  Compared with other road games, getaway games show no drop (−0.2%). Players DO score 4.4% less on a road
  back-to-back with the same ice time (see the players video research).

## 6. The "trap game" after coming home: FALSE
- First home game after a 3+ game road trip: **55.5% vs 54.1%** at home otherwise. No trap.

## 7. Denver's altitude kills visitors: FALSE (not proven)
- Visitors at Colorado: **43.2%** vs 45.8% on other road ice, **−1.1 vs expected, p = 0.55** (n = 703).

## 8. Hot streaks / momentum: FALSE
- Teams on a 5+ game win streak win **55.4%** next game, exactly what Elo expected (**−0.3**).
  They're good, not hot.
- "Due for a win" after 5+ losses: **43.2%**, also exactly as expected.
- **Exception: Maple Leafs and Rangers after 3 straight wins** do *worse* than expected:
  TOR **43.3%** (−11.6), NYR **46.7%** (−11.3). A real hangover effect.

## 9. Revenge games: FALSE
- After losing the previous meeting (same season): **47.8%**, **0.0 vs expected** (n = 13,876).
- Even after losing by 3+ goals: no bounce-back.

## 10. Starting the backup goalie costs you: TRUE
- **46.8% vs 51.1%**, **−3.5 vs expected** (n = 11,140).
- **Exceptions (it hurts double): Lightning −11.1, Blue Jackets −10.9, Sabres −8.9, Red Wings −7.4.**

## 11. Missing your stars hurts: TRUE
- 1+ star out: 47.9% vs 51.0% (−2.2). **2+ stars out: 44.2% vs 50.3% (−5.3)**.

## 12. Outshoot them and you win: MOSTLY FALSE
- Team with more shots on goal wins only **51.9%**. Outshooting by 10+: **53.8%**.
- What actually wins: **more expected goals → 64.2%**, **more high-danger chances → 64.3%**.
- Why: the team that's losing throws everything at the net; the team ahead sits back (score effects).

## 13. Physical teams win (hits): FALSE, it's the opposite
- Team with more hits wins **44.1%**. **10+ more hits: 38.7%**.
- You only hit when you don't have the puck. Takeaways, by contrast: **57.3%**.

## 14. Win the faceoffs, win the game: BARELY
- More faceoffs won → **51.3%**.

## 15. Stay out of the box: NO EFFECT
- Team with more penalty minutes wins **49.6%**.

## Bonus: the favourite always wins: FALSE (hockey parity)
- The pre-game favourite wins only **57.7%**. Even 65%+ favourites win **68.1%** (the model said 69.5%,
  so it is calibrated; the sport is just that random). Strong hook for ArakIce: *"that's why we show probabilities, not locks."*

---
**Correction to the earlier top-10 list:** "Vegas loses after crossing time zones" does NOT hold once
home/road is accounted for. Pittsburgh's eastward record and the Oilers' rest record DO hold (Oilers: it's 4+ days, not 3+).
