# Bibliothèque de hooks — 112 entrées

Le plan 1 d'une vidéo. Trois secondes, huit mots maximum, lisible sans son et
sans contexte par quelqu'un qui ne connaît ni le compte ni le hockey.

**Le prompt pioche ici plutôt que d'inventer.** C'est ce qui donne au compte une
voix constante : cinquante vidéos rédigées séparément sonnent comme cinquante
comptes différents. Enrichir cette banque fait évoluer la voix de façon
contrôlée.

**Colonnes.** `levier` = ressort psychologique. `gabarits` = règles de
`rules.json` compatibles, ou `*` pour universel. `{variables}` = à remplir depuis
les `facts` du candidat.

**Interdits rappelés :** aucun hook ne contient bet, odds, lock, guaranteed,
edge, value, parlay. Voir `STYLE-GUIDE.md` §4.

---

## Curiosité — 28

L'ouverture par défaut. Crée un manque d'information que le spectateur veut
combler. Le plus fiable des cinq leviers, et le moins fatigant à la répétition.

| # | Hook | Gabarits | Variables |
|---|---|---|---|
| C01 | Most people miss this. | `*` | — |
| C02 | Nobody checks this stat. | `penalty_kill_unsung`, `faceoff_specialist` | — |
| C03 | Everyone looks at points. Almost nobody looks at this. | `ice_time_riser`, `penalty_kill_unsung` | — |
| C04 | There's a number nobody mentions about {team}. | `*` | team |
| C05 | We looked at {n} games to find this. | `league_travel_fatigue`, `league_situational_factor` | n |
| C06 | This took 774,000 player games to see. | `league_travel_fatigue` | — |
| C07 | One number explains {team}'s season. | `home_road_split`, `team_defensive_turnaround` | team |
| C08 | The stat sheet hides this one. | `ice_time_riser`, `sniper_efficiency` | — |
| C09 | Something changed for {name} this year. | `breakout_pace`, `goalie_surge` | name |
| C10 | Why is {name} suddenly playing this much? | `ice_time_riser` | name |
| C11 | What happens to players who never sleep at home? | `league_travel_fatigue` | — |
| C12 | The standings don't show this. | `matchup_domination`, `one_goal_clutch` | — |
| C13 | Same team. Two completely different records. | `home_road_split` | — |
| C14 | {team} has a problem only the data sees. | `home_road_split` | team |
| C15 | There's a reason this keeps happening. | `matchup_domination` | — |
| C16 | Look at what happens after the third road game. | `league_travel_fatigue` | — |
| C17 | This is the shift nobody noticed. | `ice_time_riser`, `powerplay_jump` | — |
| C18 | {name} did something no one expected. | `career_best_season`, `breakout_pace` | name |
| C19 | Coaches know this. Fans don't. | `faceoff_specialist`, `penalty_kill_unsung` | — |
| C20 | We tracked every {team} game for two seasons. | `matchup_domination` | team |
| C21 | The answer isn't in the box score. | `*` | — |
| C22 | How does a team lose 33 points of win rate? | `home_road_split` | — |
| C23 | His coach changed something this season. | `ice_time_riser` | — |
| C24 | Watch what happens on night two. | `league_travel_fatigue` | — |
| C25 | {name} plays a role that never shows up. | `penalty_kill_unsung`, `faceoff_specialist` | name |
| C26 | We measured it. It's not close. | `matchup_domination` | — |
| C27 | The quietest 60-point season in the league. | `breakout_pace` | — |
| C28 | Something is different about {team} at home. | `home_road_split` | team |

---

## Surprise — 24

Contredit une intuition. Le plus fort des cinq quand le fait le justifie
vraiment — et le plus coûteux quand ce n'est pas le cas. Ne jamais promettre un
retournement pour livrer une banalité : c'est ce qui fait perdre un abonné.

| # | Hook | Gabarits | Variables |
|---|---|---|---|
| S01 | More rest. More goals. Fewer wins. | `league_situational_factor` | — |
| S02 | Rest doesn't help the way you think. | `league_situational_factor` | — |
| S03 | The bench doesn't get shorter. They just get worse. | `league_travel_fatigue` | — |
| S04 | Same minutes. Less production. | `league_travel_fatigue` | — |
| S05 | Our model gave them {pct}%. They lost. | `historical_upset` | pct |
| S06 | The model was wrong. Here's how wrong. | `historical_upset` | — |
| S07 | He doesn't shoot often. He just doesn't miss. | `sniper_efficiency` | — |
| S08 | {name} is not the player he was last year. | `breakout_pace`, `goalie_surge` | name |
| S09 | Winning close games isn't a skill. | `one_goal_clutch` | — |
| S10 | This team is unbeatable in one building only. | `home_road_split` | — |
| S11 | A 3-hour flight costs more than you'd guess. | `league_travel_fatigue` | — |
| S12 | Travel doesn't tire legs. It tires hands. | `league_travel_fatigue` | — |
| S13 | The worst night of the season, by the numbers. | `historical_upset` | — |
| S14 | Nothing changed on this roster. Everything changed. | `team_defensive_turnaround` | — |
| S15 | {shots_faced} shots. {goals_allowed} goals. | `historical_goalie_game` | shots_faced, goals_allowed |
| S16 | The favourite lost. Badly. | `historical_upset` | — |
| S17 | {name} went from fourth line to first. | `ice_time_riser` | name |
| S18 | Back-to-backs hurt. Just not who you'd expect. | `league_situational_factor` | — |
| S19 | Playing at home isn't always an advantage. | `home_road_split` | — |
| S20 | This rookie is outproducing veterans. | `rookie_watch` | — |
| S21 | Their power play is a different unit now. | `powerplay_jump` | — |
| S22 | It's not luck. We checked. | `league_travel_fatigue`, `matchup_domination` | — |
| S23 | It is luck. We checked. | `one_goal_clutch` | — |
| S24 | A career year at {age}. | `career_best_season` | age |

---

## Contrarien — 20

Prend le contre-pied d'une opinion répandue. Génère des commentaires, donc de la
portée. À doser : trois vidéos contrariennes d'affilée transforment le compte en
compte de provocation.

| # | Hook | Gabarits | Variables |
|---|---|---|---|
| K01 | Everyone checks the standings. Almost nobody checks this. | `*` | — |
| K02 | The eye test is wrong about {name}. | `breakout_pace`, `sniper_efficiency` | name |
| K03 | Stop looking at total points. | `breakout_pace` | — |
| K04 | Goals against per game lies to you. | `team_defensive_turnaround` | — |
| K05 | Save percentage doesn't measure what you think. | `historical_goalie_game` | — |
| K06 | A goalie's record says more about his team. | `goalie_surge` | — |
| K07 | {team} isn't clutch. They're lucky. | `one_goal_clutch` | team |
| K08 | Hot streaks tell you almost nothing. | `one_goal_clutch` | — |
| K09 | The best player on this team isn't the one you think. | `penalty_kill_unsung` | — |
| K10 | Faceoffs matter more than highlights. | `faceoff_specialist` | — |
| K11 | Ice time is the only stat that predicts anything. | `ice_time_riser` | — |
| K12 | Scoring 30 goals on 300 shots isn't impressive. | `sniper_efficiency` | — |
| K13 | Home ice isn't worth what people say. | `home_road_split` | — |
| K14 | Nobody wants to hear this about {team}. | `*` | team |
| K15 | This isn't a slump. It's the schedule. | `league_travel_fatigue` | — |
| K16 | Rookies aren't overrated. They're invisible. | `rookie_watch` | — |
| K17 | Head-to-head records usually mean nothing. This one does. | `matchup_domination` | — |
| K18 | Blaming the goalie is almost always wrong. | `goalie_surge` | — |
| K19 | The schedule decides more games than the roster. | `league_situational_factor` | — |
| K20 | Every model is wrong sometimes. Here's ours. | `historical_upset` | — |

---

## Preuve sociale et autorité — 22

S'appuie sur le volume de données. C'est l'atout structurel du compte : très peu
de créateurs peuvent écrire ces phrases-là honnêtement.

| # | Hook | Gabarits | Variables |
|---|---|---|---|
| P01 | We looked at 774,000 player games. | `league_travel_fatigue` | — |
| P02 | Eighteen seasons of data say this. | `league_situational_factor` | — |
| P03 | {n} games. One pattern. | `league_situational_factor` | n |
| P04 | We measured every road trip since 2008. | `league_travel_fatigue` | — |
| P05 | This held up across {n} games. | `league_situational_factor` | n |
| P06 | We ran this on all 32 teams. | `home_road_split`, `team_defensive_turnaround` | — |
| P07 | Two seasons. {combined_gp} meetings. One result. | `matchup_domination` | combined_gp |
| P08 | Best in the league. By a lot. | `faceoff_specialist`, `penalty_kill_unsung` | — |
| P09 | Number one out of 615 skaters. | `sniper_efficiency`, `breakout_pace` | — |
| P10 | The largest gap we found all season. | `home_road_split` | — |
| P11 | Only five players did this. | `penalty_kill_unsung` | — |
| P12 | This has happened five times in NHL history. | `historical_upset` | — |
| P13 | Top 5 all time. | `historical_goalie_game` | — |
| P14 | Second-best goalie game ever recorded. | `historical_goalie_game` | — |
| P15 | We tested 21 different situations. | `league_travel_fatigue` | — |
| P16 | Every team, every game, since 2008. | `league_situational_factor` | — |
| P17 | The numbers agree across three different metrics. | `league_travel_fatigue` | — |
| P18 | This is the biggest change of any team. | `team_defensive_turnaround`, `powerplay_jump` | — |
| P19 | No other rookie is close. | `rookie_watch` | — |
| P20 | {name} leads all centers. | `faceoff_specialist` | name |
| P21 | Nobody in the league gained more minutes. | `ice_time_riser` | name |
| P22 | Career best. In {gp} games. | `career_best_season` | gp |

---

## Urgence et actualité — 18

Ancre dans le moment. **Inutilisables hors saison** — un hook au présent sur des
chiffres d'avril est trompeur. Le prompt doit les écarter en mode rétrospectif.

| # | Hook | Gabarits | Variables | Hors saison |
|---|---|---|---|---|
| U01 | {streak_len} straight. Nobody saw this coming. | `streak_alert` | streak_len | ✗ |
| U02 | This is happening right now. | `streak_alert` | — | ✗ |
| U03 | {team} is on a run. Here's what's driving it. | `streak_alert` | team | ✗ |
| U04 | Watch {name} over the next two weeks. | `ice_time_riser` | name | ✗ |
| U05 | This started three weeks ago. | `ice_time_riser`, `goalie_surge` | — | ✗ |
| U06 | It's still going. | `streak_alert` | — | ✗ |
| U07 | The gap is growing every week. | `home_road_split` | — | ✗ |
| U08 | {team} plays them again in four days. | `matchup_domination` | team | ✗ |
| U09 | Last season, this happened {gp} times. | `matchup_domination` | gp | ✓ |
| U10 | The 2025-26 season is over. This is what it showed. | `*` | — | ✓ |
| U11 | Looking back at a season nobody expected. | `career_best_season` | — | ✓ |
| U12 | The number that defined {team}'s season. | `home_road_split` | team | ✓ |
| U13 | Before next season starts, look at this. | `*` | — | ✓ |
| U14 | One year ago, {name} was a fourth-liner. | `ice_time_riser`, `breakout_pace` | name | ✓ |
| U15 | This is what {name} did last season. | `career_best_season` | name | ✓ |
| U16 | Remember this game? | `historical_upset` | — | ✓ |
| U17 | The season ended. The pattern didn't. | `league_travel_fatigue` | — | ✓ |
| U18 | Nobody talked about this in April. | `*` | — | ✓ |

---

## Notes d'usage

**Ne jamais réutiliser un hook à moins de 10 jours**, même sur un sujet
différent. Le fil d'un abonné mélange les vidéos et la répétition d'une formule
se remarque avant celle d'un sujet.

**Un hook par vidéo, jamais deux.** Empiler deux accroches divise l'attention et
double le temps de lecture des trois secondes qui comptent.

**Si le hook promet un retournement, le plan 2 doit le livrer.** Un hook
`Surprise` suivi d'un chiffre banal fait plus de dégâts qu'un hook plat suivi
d'un bon chiffre.

**Un hook ne doit rien affirmer que les données ne prouvent pas.** C'est la même
règle que pour les chiffres, et elle est plus facile à enfreindre : une
affirmation se glisse dans une tournure sans qu'on la remarque. Deux entrées ont
dû être réécrites pour cette raison après le premier lot réel — « Worst power
play in the league » alors qu'on savait seulement que le taux était passé de
15.2 % à 23.4 %, sans avoir jamais comparé au reste de la ligue ; et « moved
before the points did » alors qu'on mesurait le temps de glace et rien d'autre.

À surveiller en particulier : les superlatifs (*worst*, *best*, *first*,
*only*), qui supposent un classement complet, et les tournures causales
(*because*, *that's why*, *before X did*), qui supposent un lien qu'une
statistique descriptive n'établit jamais.

**Reformuler à la main est prévu et souhaitable.** La bibliothèque donne le
moule, ton oreille fait le reste. Après reformulation, relance
`npm run content:check -- --fix` : la durée d'un plan se déduit du nombre de mots
et pilote le montage, elle doit suivre le texte.

**Compatibilité.** Un hook marqué `*` va avec n'importe quel gabarit. Les autres
sont limités : `S15` cite des tirs et des buts, il n'a de sens que sur une
performance de gardien.

**Hors saison.** Toute la section Urgence marquée ✗ est interdite. Les ✓ sont
formulées au passé et restent valables.
