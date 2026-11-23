# YouTube script: What actually influences a hockey prediction? (the not-so-obvious takes)

Format: informational long-form, **~12 min** (~1,850 words of narration + visual pauses). Voice-over + graphics.
Numbers: `content/MYTHBUSTERS.md` + game examples pulled from `ml/data/` (21,651 regular-season games, 2008-09 to Oct 2026).
On screen, always say **"since 2008"**, never "this season".

**Rhythm:** segments alternate **TENDENCY ✅** (a real league-wide rule) and **OUTLIER ❌** (myth busted, but one team breaks it).
Inside each segment the beats also alternate: league chart → team case → twist → team case.

| # | Segment | Stamp | Star case |
|---|---|---|---|
| 1 | Home ice | TENDENCY ✅ | Rangers, Tampa |
| 2 | Jet lag | OUTLIER ❌ | Penguins (+ Vegas "raw stats lie") |
| 3 | Back-to-backs | TENDENCY ✅ | Kings 1-8, Stars, Capitals |
| 4 | More rest | OUTLIER ❌ | Oilers |
| 5 | Shots vs chances | TENDENCY ✅ | Ducks 16 shots vs 53 |
| 6 | Hot streaks | OUTLIER ❌ | Leafs, Rangers, Oilers' 16-game streak |

**Title options**
1. What Actually Influences a Hockey Prediction? (Not What You Think)
2. Home Ice, Rest, Jet Lag, Hot Streaks: 18 Years of NHL Data Says Otherwise
3. 6 Things Everyone Thinks Decide NHL Games (Only 3 Are True)

**Thumbnail:** split ice, left "REST ✅?" in white, right Oilers orange with "33%". Very little text.

**Plain-language rule (audience: regular fans and bettors, not analysts)**
- Every technical idea gets ONE simple sentence and, where marked 🟦 EXPLAINER, a small visual. Explain it the first time; afterwards just use it.
- Say "out of 100 games" instead of "percentage points". "4 points worse" = "out of 100 games, about 4 more losses".
- Never say on screen: Elo, statistical significance, Benjamini-Hochberg, regression, variance. Use "pre-game odds", "holds up / just luck", "random".
- Every 🟦 EXPLAINER card uses the same look (icon + 1 line), so viewers learn to recognise it.

**Graphics rules**
- One idea per chart. League bars in neutral grey, the rule-breaking team in its colours.
- Sample size always shown small in a corner (`n = 2,332 games`).
- Stamp at the end of each segment: green **TENDENCY ✅** or orange **OUTLIER ❌**.
- Corner label on adjusted numbers: "vs pre-game expectation".
- A running scoreboard in the corner that fills in as segments end (✅ ❌ ✅ ❌ ✅ ❌).

---

## 0. COLD OPEN (0:00-0:40)

**[VISUAL: black screen, one number fades in: 57.7%]**

> In the NHL, the team that's supposed to win… wins 57.7% of the time.
> Not 80. Not 70. Barely more than a coin flip with a little weight on it.

**[VISUAL: coin flip, the coin lands, a "FAVOURITE" label slides off]**

> In February 2023, Anaheim went into Carolina, one of the best teams in the league, and got outshot 53 to 16. Fifty-three to sixteen. They won 3-2.

**[VISUAL: scoreboard "CAR 2 · ANA 3", shots 53-16 underneath]**

> So when someone says a team *will* win tonight because they're at home, rested, or on a hot streak… what does that really mean?
> We went through more than 21,000 NHL games since 2008 to find out which "obvious" factors actually move the needle, and which teams ignore the rules completely.

**[TITLE CARD]**

---

## 1. HOW WE CHECKED (0:40-1:30)

**[VISUAL: 3-step diagram: Belief → League data → Team exceptions]**

> Quick word on the method, because it's what separates a real pattern from a fun coincidence.
> For each belief we look at two numbers. First, the raw win rate: how often teams win in that situation.
> Second, and this is the important one, we compare it to what was *expected* before the game. A great team winning on the road isn't a surprise: a great team is supposed to win. So the question is, did teams do better or worse than their pre-game odds?

**[🟦 EXPLAINER: "EXPECTED = the estimate before the job". A quote sheet: "Estimate: 10 days". Then the job takes 13 days → "3 days over". Then a hockey version: "Pre-game odds: wins 60 out of 100" → "Actually won 55" → "5 under"]**

> Think of it like a job estimate. If the quote says ten days and the job takes thirteen, you're three days over, no matter how big the job was. Same here: the pre-game odds are the estimate. We check if teams came in over or under it.

**[🟦 EXPLAINER: "60% = 6 games out of 10". A row of 10 jerseys, 6 lit up]**

> And when we say a team "has 60%", it just means: play this game ten times, they win about six.

**[VISUAL: two bars "Raw win %" vs "vs expected", the second highlighted]**

> And when one team seems to break a rule, we check it isn't just a lucky stretch.

**[🟦 EXPLAINER: "LUCK OR REAL?" Flip a coin 10 times: 7 heads, which happens all the time. Flip it 100 times: 70 heads, now something's up]**

> Flip a coin ten times and you can easily get seven heads. That's luck. Flip it a hundred times and get seventy, and now something's going on. With 32 teams, somebody will always look weird over a few games. We only keep the patterns that hold up over at least a hundred games and pass a test for luck.

**[🟦 EXPLAINER: arrow pointing to the corner: "n = number of games behind this stat"]**

> That small number in the corner of every chart? That's how many games the stat is based on.

**[VISUAL: the empty corner scoreboard appears: 6 empty slots]**

> Six beliefs. Let's see how many survive.

---

## 2. HOME ICE MATTERS (1:30-3:10): TENDENCY

**[VISUAL: big number 54.3%, crowd silhouette]**

> We start with the one everybody agrees on: home ice. And yes, it's real. Since 2008, home teams win 54.3% of their games.

**[VISUAL: line chart, home win % by season 2008 → 2026, shaded band 52-57%]**

> It's not one era, either. Every season since 2008 sits between 52 and 57%. Rule changes, new arenas, even the seasons played in empty buildings: it never goes away.

**[VISUAL: horizontal bars, home % minus road % for every team. Tampa on top]**

> Some buildings are worth a lot more than others. Tampa Bay wins 63% at home and 48% on the road: a 15-point swing, the biggest in the league. Pittsburgh is right behind at plus 13.

**[VISUAL: two bars, Regulation 55.4% | Overtime 50.8%]**

> Then the first twist. Get to overtime, and home ice nearly disappears: 50.8%. In overtime there are only three skaters a side instead of five, so there's open ice everywhere and one mistake ends it.

**[🟦 EXPLAINER: rink top view: 5 dots per side in regulation → 3 dots per side in overtime]**

> The crowd matters much less once the game turns into chaos.

**[VISUAL: MSG silhouette, near-equal bars: 54.8% home | 52.1% road]**

> And then there's the New York Rangers. The most famous arena in hockey, and statistically it gives them almost nothing: 54.8% at home, 52.1% on the road. Too small to tell apart from zero.

**[VISUAL: NYR 2025-26 bars: home 34% | road 49%]**

> Last season it actually flipped. The 2025-26 Rangers won 34% of their home games and 49% on the road.

**[STAMP: TENDENCY ✅, small tag "outlier: NYR"]**

> Home ice is real. Just don't assume every building is worth the same.

---

## 3. JET LAG (3:10-4:50): OUTLIER

**[VISUAL: map of North America, 4 time zones, a plane flying west to east]**

> But is home ice really about the crowd, or about the trip the *other* team had to make? The NHL covers four time zones. Fly from Vancouver to Florida and you lose three hours. Surely that matters.

**[VISUAL: bar chart by time zones crossed, −3 to +3, every bar around 50%]**

> Honestly? Not really. Road teams that flew two or more time zones east win 44.8%. Road teams that didn't change zones: 45.7%. Basically identical. League-wide, jet lag doesn't show up in the results.

**[VISUAL: Penguins colours, 70.1% vs 54.6%]**

> Except in Pittsburgh. When the Penguins fly east, they win 70% of the time, against 55% otherwise. Part of it is coming *home* from western trips, but they win going east on the road too. And it's not one golden era: it's 69% before 2016 and 71% after.

**[VISUAL: red "RAW STATS LIE" banner. Vegas: 41.9% flying east vs 60.4%]**

> Now here's why you have to be careful. Vegas flying east wins only 41.9%, against 60% the rest of the time. Looks like a massive jet-lag problem.
> But every single one of those games is a road game, against Eastern teams, often good ones. Account for that and the effect is gone. Vegas doesn't have a jet-lag problem. It has a road-game problem, like everybody else.

**[VISUAL: Vegas bar slides down to sit next to a "VGK, all road games" bar: basically the same]**

**[STAMP: OUTLIER ❌, myth busted, "outlier: PIT"]**

---

## 4. BACK-TO-BACKS HURT (4:50-6:20): TENDENCY

**[VISUAL: calendar, two consecutive nights circled]**

> Next: the back-to-back. That's when a team plays two nights in a row, often with a flight in between. Every coach complains about it. Are they right?

**[🟦 EXPLAINER: "BACK-TO-BACK": Mon night game → flight at midnight → Tue night game. Second game highlighted in red]**

**[VISUAL: bars, Back-to-back 44.9% | Normal 51.0%, then a "−4.3 pts vs expected" stamp]**

> Yes. Teams on the second night win 44.9%, against 51% otherwise. And it's not just because of who they play: even compared to their pre-game odds, they come in about four points under. In plain words: out of every 100 back-to-backs, that's about four extra losses.

**[🟦 EXPLAINER: 100 small pucks, 4 turn red: "−4 points = 4 extra losses per 100 games"]**

**[VISUAL: the 54.3% home-ice bar from segment 2 shrinks to 50.4%]**

> And here's my favourite detail in this video. Put the *home* team on a back-to-back and their win rate drops to 50.4%. Remember the home ice we just talked about? Fatigue erases it. Completely.

**[VISUAL: scoreboard "LAK 1 · EDM 8", Feb 26 2026, "2nd night of a back-to-back"]**

> February 2026: the Kings host Edmonton on the second night of a back-to-back. Final score: 8-1 Oilers.

**[VISUAL: Dallas and Washington logos: DAL 41.1% vs 54.5% | WSH 47.7% vs 59.1%]**

> Some teams feel it more. Dallas and Washington both drop around 10 points beyond expectation on back-to-backs, more than double the league average. And no team in our data is significantly immune. Everybody gets tired.

**[STAMP: TENDENCY ✅]**

---

## 5. MORE REST = BETTER (6:20-8:00): OUTLIER

**[VISUAL: question card "If tired is bad… is rested good?"]**

> So if fatigue hurts, more rest should help, right? This is where it gets interesting.

**[VISUAL: bars by days of rest: 1 day 44.9% | 2 days 50.8% | 3 days 52.1% | 4 days 51.3% | 5+ days 49.4%. The curve flattens]**

> Look at the curve. One day of rest to two: a big jump. After that, flat. Four days, five days, a full week: nothing. Teams with four or more days off win 50.3%; teams on normal rest win 50.0%.

**[VISUAL: text "Being tired hurts. Being extra-rested doesn't help."]**

> So the real rule isn't "rest helps". It's "fatigue hurts". Once you're rested, extra days buy you nothing.

**[VISUAL: Oilers colours, giant 33%]**

> And then there are the Edmonton Oilers. With four or more days off, Edmonton wins 33% of the time, one game in three. Normally they win about 48%, basically one in two. Compared to their pre-game odds, that's about 15 extra losses for every 100 of those games, and it held up over 115 games.

**[VISUAL: two scoreboards: "EDM 0 · WPG 6" (season opener, Oct 9 2024, 7 days rest) and "EDM 1 · COL 9" (Nov 8 2025, 4 days rest)]**

> Opening night 2024, after a week off: a 6-0 loss to Winnipeg. November 2025, four days off: a 9-1 loss to Colorado.
> And before you say "that's the bad Oilers of the early 2010s": since 2015, the McDavid era, they still win only 38% after four days off.

**[VISUAL: calendar marking All-Star break, bye week, Christmas]**

> Why? The data can't prove it, but think about *when* a team gets four days off: the All-Star break, the bye week, the holidays. Some teams come back sharp. Edmonton seems to come back rusty.

**[STAMP: OUTLIER ❌, myth busted, "outlier: EDM"]**

---

## 6. SHOTS VS CHANCES (8:00-9:40): TENDENCY

**[VISUAL: shot counter spinning upward]**

> Let's look inside the game itself. Everyone says it: shoot the puck, outshoot them, you'll win.

**[VISUAL: bar "Team with more shots wins: 51.9%", then "+10 shots: 53.8%"]**

> The team with more shots wins… 51.9% of the time. Outshoot them by ten or more? 53.8%. Barely better than a coin flip.

**[VISUAL: cold-open scoreboard again: ANA 16 shots, CAR 53 shots, final 3-2 ANA]**

> Remember Anaheim in Carolina, 53 shots to 16? That's not a freak accident. That's how hockey works.

**[VISUAL: animated graph: the losing team shoots more as time runs down, the leading team "sits back"]**

> Here's why. When a team is losing, it throws everything at the net, and the team ahead sits back and protects the lead. In 46% of NHL games, the team that *lost* took more shots. Shot totals often tell you who was chasing the game, not who was better.

**[🟦 EXPLAINER: "46% of games: the loser outshot the winner". Two columns, the loser's shot column taller with a "LOST" tag]**

**[VISUAL: two bars "More expected goals: 64.2%" | "More high-danger chances: 64.3%"]**

> What does matter is shot *quality*. Not all shots are equal.

**[🟦 EXPLAINER: rink half, 3 coloured zones. Far/blue line (grey): "3 goals per 100 shots" · mid-range (yellow): "12 per 100" · right in front, the "slot" (red): "33 per 100"]**

> From far away, near the blue line, about 3 shots out of 100 go in. From medium range, about 12. From right in front of the goalie, what analysts call a "high-danger chance", it's 33 out of 100. One shot from in front is worth about ten from the point.

**[🟦 EXPLAINER: "EXPECTED GOALS = adding up the danger". Three shots appear: 0.03 + 0.03 + 0.33 → "0.39 expected goals"]**

> "Expected goals" just adds that up. Every shot gets a value for how often a shot like it goes in, and you add them together. It measures how many *good* chances a team created, not how many times it threw the puck at the net.
> And the team with more expected goals wins 64% of the time. The team with more high-danger chances, 64% too. That's the stat that matters.

**[VISUAL: "HITS" counter: more hits → 44.1%; 10+ more hits → 38.7%. Example "PIT 57 hits vs 23, lost 4-1 to TOR, Nov 2022"]**

> Bonus myth: "the physical team wins". It's the opposite. The team with more hits wins 44%, and with ten or more extra hits, 39%. You only hit when you don't have the puck. Pittsburgh once threw 57 hits against Toronto's 23… and lost 4-1.

**[VISUAL: quick-fire tiles: Faceoffs 51.3% | Penalty minutes 49.6% | Takeaways 57.3%]**

> Faceoffs, the puck drop to start each play? 51%, close to nothing. Penalty minutes? No effect. Takeaways, meaning stealing the puck from the other team: 57%. Having the puck matters more than hitting the guy who has it.

**[STAMP: TENDENCY ✅, "quality over quantity"]**

---

## 7. HOT STREAKS (9:40-11:00): OUTLIER

**[VISUAL: flame icon, "W W W W W"]**

> Last one, and probably the most repeated belief in sports: momentum. A hot team keeps winning.

**[VISUAL: bars, After 5+ wins 55.4% | After 5+ losses 43.2%]**

> On the surface it looks true. Teams on a five-game winning streak win their next game 55.4% of the time. Teams on a five-game losing streak, 43.2%.

**[VISUAL: same bars with "expected" markers right on top: −0.3 pts]**

> But compare that to their pre-game odds, and the effect disappears. The odds already expected them to win about 56% of those games. They won 55%. No bonus for being hot. Streaking teams win more because they're *good*, not because they're *hot*.

**[🟦 EXPLAINER: "GOOD ≠ HOT". A strong team's bar with a flame on it; remove the flame, the bar doesn't move]**

> The streak is a symptom, not a cause. And a team on a losing streak isn't "due". It's just not very good right now.

**[VISUAL: Oilers 16-win streak graphic. Final tile: "Feb 6 2024 @VGK, L 1-3, after 7 days off (All-Star break)"]**

> Want a perfect example? In 2024 the Oilers won 16 straight. The streak ended in Vegas, in their first game back from the All-Star break, after seven days off.
> Momentum didn't save them. And the rest we talked about earlier? It didn't help either.

**[VISUAL: Leafs + Rangers after 3 straight wins: TOR 43.3% vs 50.8% | NYR 46.7% vs 54.5%]**

> Two teams do the opposite of momentum. After three straight wins, the Maple Leafs and the Rangers play *worse* than their odds said, about 11 extra losses for every 100 of those games. A post-streak hangover. Leafs fans… you've probably felt that one.

**[STAMP: OUTLIER ❌, myth busted, "outliers: TOR, NYR"]**

---

## 8. WHY HOCKEY IS SO HARD TO PREDICT (11:00-11:45)

**[VISUAL: the corner scoreboard expands to full screen: Home ice ✅ · Jet lag ❌ · Back-to-back ✅ · Rest ❌ · Shot quality ✅ · Hot streaks ❌]**

> Three real, three myths. And almost every rule has a team that breaks it.

**[VISUAL: "back-to-back = −4.3 pts" × "12.5 per season" = "≈ half a win"]**

> But here's the bigger picture. The strongest effect we found today, the back-to-back, costs about four wins out of every 100 games. A team plays around twelve back-to-backs a season. Do the math: that's about half a win over an entire season.

**[VISUAL: web of factors around a puck: goalie, injuries, shot quality, special teams, schedule, travel, home ice, luck]**

> That's why no single factor decides a game. Who's in net, who's injured, the quality of chances, special teams, the schedule: each one carries a small weight, and they all stack.
> And the favourite, the team the odds say should win, still wins only 57.7% of the time. Even big favourites, the ones the odds give 65% or more, lose about one game in three. One bounce, one hot goalie, and the whole prediction is gone.

**[VISUAL: text "Probabilities, not certainties."]**

> So the next time someone tells you a game is a lock: it isn't. The best you can do is understand the probabilities.

---

## 9. NEXT VIDEO TEASER + OUTRO (11:45-12:30)

**[VISUAL: dark screen, a goalie mask silhouette, then a jersey with a "?" on the back]**

> So far, we've only talked about teams. But a team is just its players.
> Next video: the players. What happens when the starting goalie sits and the backup plays? Spoiler: for some teams it's a disaster. What's a missing star actually worth? Spoiler: it depends a lot on *which* star.
> And why do players score less in certain games, even when they play the exact same minutes?

**[VISUAL: three quick tiles flash: "BACKUP GOALIE: −?" · "2 STARS OUT: −?" · "SAME MINUTES, FEWER POINTS?"]**

> Subscribe so you don't miss it.
> The data behind this video comes from ArakIce, link in the description, if you want to dig into any team yourself.
> And tell me in the comments: which factor should we test after that? Referees? Revenge games?

**[END SCREEN]**

---

## Description box

> We analyzed 21,651 NHL regular-season games since 2008 to see which "obvious" factors actually influence who wins: home ice, jet lag, back-to-backs, rest, shot quality and hot streaks. Three are real, three are myths, and some teams break every rule.
>
> Method: NHL results 2008-09 to 2026, schedule and travel computed from arena locations, results compared to pre-game Elo expectations; team exceptions filtered for false positives across all 32 teams.
>
> 0:00 The favourite wins only 57.7%
> 0:40 How we checked
> 1:30 Home ice
> 3:10 Jet lag
> 4:50 Back-to-backs
> 6:20 Does more rest help?
> 8:00 Shots vs chances
> 9:40 Hot streaks
> 11:00 Why hockey is so hard to predict
> 11:45 Next video: the players
>
> Team-by-team stats: arakice.com
> Informational only, not betting advice.

---

# SHORTS (vertical, to promote the long video)

## Short A: "Home ice disappears" (~40 s)

| Time | On screen (big text) | Voice-over |
|---|---|---|
| 0-2 s | **HOME ICE = 54%** | "Home teams win 54% of NHL games." |
| 2-6 s | bar 54.3% | "Since 2008, every season. It's real." |
| 6-12 s | **BUT…** calendar with 2 nights circled | "But put the home team on the second night of a back-to-back…" |
| 12-18 s | bar shrinks 54.3 → **50.4%** | "…and it drops to 50.4%. A coin flip. Fatigue erases home ice." |
| 18-26 s | scoreboard LAK 1 · EDM 8 | "February 2026: the Kings, on a back-to-back, at home. Lost 8-1." |
| 26-34 s | DAL / WSH bars | "Dallas and Washington get hit twice as hard as everyone else." |
| 34-40 s | **"Jet lag? Rest? Hot streaks? Full breakdown on the channel"** | "Jet lag, rest, hot streaks: which ones are myths? Full video on the channel." |

## Short B: "Give the Oilers a week off" (~35 s)

| Time | On screen | Voice-over |
|---|---|---|
| 0-2 s | **OILERS + 4 DAYS OFF = 33%** | "Give the Oilers four days off and they win 33% of the time." |
| 2-8 s | rest curve flattening | "Around the league, extra rest does nothing. Tired hurts, rested doesn't help." |
| 8-16 s | EDM 33% vs 48% | "But Edmonton? 15 points worse than expected, over 115 games." |
| 16-26 s | EDM 0 · WPG 6 / EDM 1 · COL 9 / 16-game streak ends after All-Star break | "6-0 on opening night. 9-1 against Colorado. Their 16-game win streak? Ended right after the All-Star break." |
| 26-35 s | **"Full video on the channel"** | "Is it rust or coincidence? Full breakdown on the channel." |

Shorts rule: subject named on every frame (EDM / LAK…), sample size small in a corner, no picks, no odds.

---

## Notes before recording
- The Leafs "post-streak hangover" is mostly an older-era effect (30% before 2016, 47% since, still below their normal rate). Keep the wording "historically".
- The dataset contains an Oilers game dated 2026-09-29, which looks like a preseason game. It's not used in the script, but check `nhl_games_v4.csv` for preseason rows before quoting any 2026-27 number.
