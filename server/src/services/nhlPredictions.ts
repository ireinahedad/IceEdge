/**
 * nhlPredictions.ts
 * Rule-based prediction engine for all NHL bet market types.
 *
 * Game markets  → Log5 + Poisson + Skellam per-period
 * Team markets  → same, vs league-average opponent
 * Player markets → Poisson on per-game rates
 */

import { fetchGameById, fetchTeams, fetchTeamByAbbr, fetchPlayerById } from './nhlApiClient';

// ─── Shared interfaces ────────────────────────────────────────────────────────

export interface BetOption {
  id:        string;
  label:     string;
  rulePct:   number;
  ruleNote:  string;
}

export interface MarketGroup {
  id:    string;
  title: string;
  cols:  2 | 3;
  options: BetOption[];
}

// ─── Math primitives ──────────────────────────────────────────────────────────

/** Bill James Log5: P(A beats B) given their independent win rates */
function log5(wA: number, wB: number): number {
  const d = wA + wB - 2 * wA * wB;
  if (d === 0) return 0.5;
  return Math.max(0.03, Math.min(0.97, (wA - wA * wB) / d));
}

/** Poisson P(X = k) */
function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 0; i < k; i++) p *= lambda / (i + 1);
  return p;
}

/** Poisson P(X > line) — supports half-integer lines */
function poissonOver(lambda: number, line: number): number {
  const k = Math.floor(line);
  let cdf = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) { cdf += term; term = (term * lambda) / (i + 1); }
  return Math.max(0.02, Math.min(0.98, 1 - cdf));
}

/** Poisson P(X < line) — equivalent to 1 - P(X >= ceil(line)) */
function poissonUnder(lambda: number, line: number): number {
  return Math.max(0.02, Math.min(0.98, 1 - poissonOver(lambda, line - 1)));
}

/**
 * Skellam-based 3-way period result.
 * Returns { home, draw, away } as fractions summing to ~1.
 */
function skellamPeriod(lambdaH: number, lambdaA: number): { home: number; draw: number; away: number } {
  const MAX_K = 12;
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAX_K; h++) {
    const ph = poissonPmf(lambdaH, h);
    if (ph < 1e-9) continue;
    for (let a = 0; a <= MAX_K; a++) {
      const pa = poissonPmf(lambdaA, a);
      if (pa < 1e-9) continue;
      const joint = ph * pa;
      if      (h > a) home += joint;
      else if (h < a) away += joint;
      else            draw += joint;
    }
  }
  const total = home + draw + away || 1;
  return { home: home / total, draw: draw / total, away: away / total };
}

/** Clamp and round to integer percentage */
function pct(p: number): number {
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}

/** Format a goals-per-game rate for display */
function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

// ─── League constants ─────────────────────────────────────────────────────────

const HOME_ICE_ADJ   = 0.03;   // +3% for home ice
const LEAGUE_AVG_GPG = 3.05;   // league avg goals/game per team
const OT_BASE        = 0.225;  // ~22.5% of NHL games go to OT/SO

/** Per-period goal fractions (empirical NHL averages) */
const PERIOD_DIST = [0.305, 0.365, 0.330] as const;

/** Estimate OT probability based on how evenly matched the teams are */
function otProb(homeWin: number): number {
  const balance = 1 - 2 * Math.abs(homeWin - 0.5); // 0=mismatch, 1=even
  return OT_BASE + 0.06 * balance; // range ~18%–28%
}

// ─── Game markets ─────────────────────────────────────────────────────────────

function computeGameMarkets(
  home: any,
  away: any,
  homeName: string,
  awayName: string,
): MarketGroup[] {
  const wH  = (home.winPct ?? 50) / 100;
  const wA  = (away.winPct ?? 50) / 100;
  const gfH = home.goalsForPerGame     ?? LEAGUE_AVG_GPG;
  const gaH = home.goalsAgainstPerGame ?? LEAGUE_AVG_GPG;
  const gfA = away.goalsForPerGame     ?? LEAGUE_AVG_GPG;
  const gaA = away.goalsAgainstPerGame ?? LEAGUE_AVG_GPG;

  // Adjusted lambda: blend each team's offence vs the opponent's defence
  const lambdaH = (gfH + gaA) / 2;   // home expected goals
  const lambdaA = (gfA + gaH) / 2;   // away expected goals
  const lambdaT = lambdaH + lambdaA;  // total expected goals

  const mlHome = log5(wH + HOME_ICE_ADJ, wA);
  const mlAway = 1 - mlHome;
  const ot     = otProb(mlHome);
  const regAdj = 1 - ot;

  // ── 1. Match Betting ──────────────────────────────────────────────────────
  const matchBetting: MarketGroup = {
    id: 'match', title: 'Match Betting', cols: 3,
    options: [
      {
        id: 'ml-home',
        label: `${homeName} to Win`,
        rulePct: pct(mlHome),
        ruleNote: `Win% ${fmt(wH*100,0)}% → Log5 vs opponent ${fmt(wA*100,0)}% → home ice +3% = ${fmt(mlHome*100,0)}%`,
      },
      {
        id: 'ml-ot',
        label: 'OT / Shootout',
        rulePct: pct(ot),
        ruleNote: `NHL avg ~22.5% OT rate; closer matchup (+${fmt((ot-OT_BASE)*100,0)}%) based on win% spread`,
      },
      {
        id: 'ml-away',
        label: `${awayName} to Win`,
        rulePct: pct(mlAway),
        ruleNote: `Away win probability = 1 − home win = ${fmt(mlAway*100,0)}%`,
      },
    ],
  };

  // ── 2. Puck Line ──────────────────────────────────────────────────────────
  // Home -1.5: team wins by 2+ ≈ 62% of home wins; Away +1.5: covers if away wins or loses by 1
  const plHome = mlHome * 0.62;
  const plAway = 1 - plHome;
  const puckLine: MarketGroup = {
    id: 'puckline', title: 'Puck Line', cols: 2,
    options: [
      {
        id: 'pl-home',
        label: `${homeName} −1.5`,
        rulePct: pct(plHome),
        ruleNote: `ML ${fmt(mlHome*100,0)}% × 62% (wins-by-2+ rate) = ${fmt(plHome*100,0)}%`,
      },
      {
        id: 'pl-away',
        label: `${awayName} +1.5`,
        rulePct: pct(plAway),
        ruleNote: `Covers if away wins OR home wins by exactly 1 = ${fmt(plAway*100,0)}%`,
      },
    ],
  };

  // ── 3. Totals ─────────────────────────────────────────────────────────────
  const over55  = poissonOver(lambdaT, 5.5);
  const over65  = poissonOver(lambdaT, 6.5);
  const totals: MarketGroup = {
    id: 'totals', title: 'Total Goals', cols: 2,
    options: [
      {
        id: 'o55',
        label: 'Over 5.5',
        rulePct: pct(over55),
        ruleNote: `Expected goals λ=${fmt(lambdaT)} (${fmt(lambdaH)}+${fmt(lambdaA)}) → Poisson P(>5.5)=${fmt(over55*100,0)}%`,
      },
      {
        id: 'u55',
        label: 'Under 5.5',
        rulePct: pct(1 - over55),
        ruleNote: `P(<5.5) = ${fmt((1-over55)*100,0)}%`,
      },
      {
        id: 'o65',
        label: 'Over 6.5',
        rulePct: pct(over65),
        ruleNote: `Poisson P(>6.5) = ${fmt(over65*100,0)}%`,
      },
      {
        id: 'u65',
        label: 'Under 6.5',
        rulePct: pct(1 - over65),
        ruleNote: `P(<6.5) = ${fmt((1-over65)*100,0)}%`,
      },
    ],
  };

  // ── 4. Both Teams to Score ────────────────────────────────────────────────
  const bttsH   = 1 - Math.exp(-lambdaH);  // P(home scores ≥1)
  const bttsA   = 1 - Math.exp(-lambdaA);  // P(away scores ≥1)
  const bttsYes = bttsH * bttsA;
  const btts: MarketGroup = {
    id: 'btts', title: 'Both Teams to Score', cols: 2,
    options: [
      {
        id: 'btts-yes',
        label: 'Yes',
        rulePct: pct(bttsYes),
        ruleNote: `P(home≥1)=${fmt(bttsH*100,0)}% × P(away≥1)=${fmt(bttsA*100,0)}% = ${fmt(bttsYes*100,0)}%`,
      },
      {
        id: 'btts-no',
        label: 'No',
        rulePct: pct(1 - bttsYes),
        ruleNote: `At least one team is shut out = ${fmt((1-bttsYes)*100,0)}%`,
      },
    ],
  };

  // ── 5. Double Chance ──────────────────────────────────────────────────────
  // Home or Draw = home reg win + OT  |  Away or Draw = away reg win + OT
  const homeOrOT = mlHome * regAdj + ot;
  const awayOrOT = mlAway * regAdj + ot;
  const doubleChance: MarketGroup = {
    id: 'dc', title: 'Double Chance', cols: 2,
    options: [
      {
        id: 'dc-home',
        label: `${homeName} or OT`,
        rulePct: pct(homeOrOT),
        ruleNote: `Home reg win ${fmt(mlHome*regAdj*100,0)}% + OT ${fmt(ot*100,0)}% = ${fmt(homeOrOT*100,0)}%`,
      },
      {
        id: 'dc-away',
        label: `${awayName} or OT`,
        rulePct: pct(awayOrOT),
        ruleNote: `Away reg win ${fmt(mlAway*regAdj*100,0)}% + OT ${fmt(ot*100,0)}% = ${fmt(awayOrOT*100,0)}%`,
      },
    ],
  };

  // ── 6–8. Period Results (Skellam) ─────────────────────────────────────────
  const periodGroups: MarketGroup[] = ['1st', '2nd', '3rd'].map((name, i) => {
    const f  = PERIOD_DIST[i];
    const lH = lambdaH * f;
    const lA = lambdaA * f;
    const r  = skellamPeriod(lH, lA);
    return {
      id:    `p${i+1}`,
      title: `${name} Period Result`,
      cols:  3,
      options: [
        {
          id:       `p${i+1}-home`,
          label:    `${homeName}`,
          rulePct:  pct(r.home),
          ruleNote: `λH=${fmt(lH)} vs λA=${fmt(lA)} → Skellam P(home>away)=${fmt(r.home*100,0)}%`,
        },
        {
          id:       `p${i+1}-draw`,
          label:    'Draw',
          rulePct:  pct(r.draw),
          ruleNote: `P(equal goals in period) = ${fmt(r.draw*100,0)}%`,
        },
        {
          id:       `p${i+1}-away`,
          label:    `${awayName}`,
          rulePct:  pct(r.away),
          ruleNote: `P(away>home) = ${fmt(r.away*100,0)}%`,
        },
      ],
    };
  });

  // ── 9. 1st Period Goals O/U ───────────────────────────────────────────────
  const lP1 = lambdaT * PERIOD_DIST[0];
  const p1Goals: MarketGroup = {
    id: 'p1goals', title: '1st Period Goals', cols: 3,
    options: [
      {
        id: 'p1-o05',
        label: 'Over 0.5',
        rulePct: pct(poissonOver(lP1, 0.5)),
        ruleNote: `P1 λ=${fmt(lP1)} → P(≥1 goal)=${fmt(poissonOver(lP1,0.5)*100,0)}%`,
      },
      {
        id: 'p1-o15',
        label: 'Over 1.5',
        rulePct: pct(poissonOver(lP1, 1.5)),
        ruleNote: `P(≥2 goals in P1)=${fmt(poissonOver(lP1,1.5)*100,0)}%`,
      },
      {
        id: 'p1-o25',
        label: 'Over 2.5',
        rulePct: pct(poissonOver(lP1, 2.5)),
        ruleNote: `P(≥3 goals in P1)=${fmt(poissonOver(lP1,2.5)*100,0)}%`,
      },
    ],
  };

  // ── 10. Overtime ──────────────────────────────────────────────────────────
  const overtime: MarketGroup = {
    id: 'ot', title: 'Extra Time', cols: 2,
    options: [
      {
        id: 'ot-yes',
        label: 'Goes to OT',
        rulePct: pct(ot),
        ruleNote: `Balance factor from win% spread → ${fmt(ot*100,0)}% OT probability`,
      },
      {
        id: 'ot-no',
        label: 'Decided in Regulation',
        rulePct: pct(1 - ot),
        ruleNote: `P(regulation finish) = ${fmt((1-ot)*100,0)}%`,
      },
    ],
  };

  // ── 11. Winning Margin ────────────────────────────────────────────────────
  // Given a winner, margin distribution (historical NHL: ~42% by 1, 30% by 2, 28% by 3+)
  // Adjust slightly: high-scoring games → fewer 1-goal games
  const by1Share   = Math.max(0.30, 0.45 - 0.025 * (lambdaT - 6.0));
  const by2Share   = 0.30;
  const by3pShare  = Math.max(0.20, 1 - by1Share - by2Share);
  const margin: MarketGroup = {
    id: 'margin', title: 'Winning Margin', cols: 3,
    options: [
      {
        id: 'wm-1',
        label: 'Win by 1',
        rulePct: pct((mlHome + mlAway) * by1Share),
        ruleNote: `Any reg win × 1-goal game rate (${fmt(by1Share*100,0)}%) = ${fmt((mlHome+mlAway)*by1Share*100,0)}%`,
      },
      {
        id: 'wm-2',
        label: 'Win by 2',
        rulePct: pct((mlHome + mlAway) * by2Share),
        ruleNote: `Any reg win × 2-goal margin rate (${fmt(by2Share*100,0)}%)`,
      },
      {
        id: 'wm-3p',
        label: 'Win by 3+',
        rulePct: pct((mlHome + mlAway) * by3pShare),
        ruleNote: `Any reg win × blowout rate (${fmt(by3pShare*100,0)}%), λ=${fmt(lambdaT)}`,
      },
    ],
  };

  return [
    matchBetting,
    puckLine,
    totals,
    btts,
    doubleChance,
    ...periodGroups,
    p1Goals,
    overtime,
    margin,
  ];
}

// ─── Public: game predictions ─────────────────────────────────────────────────

export async function buildGameMarkets(gameId: string): Promise<MarketGroup[]> {
  const game = await fetchGameById(gameId);
  const homeAbbr = game.homeTeam?.abbreviation ?? game.homeTeam?.abbrev ?? '';
  const awayAbbr = game.awayTeam?.abbreviation ?? game.awayTeam?.abbrev ?? '';

  const [homeTeam, awayTeam] = await Promise.all([
    fetchTeamByAbbr(homeAbbr),
    fetchTeamByAbbr(awayAbbr),
  ]);

  return computeGameMarkets(
    homeTeam, awayTeam,
    game.homeTeam?.name ?? homeAbbr,
    game.awayTeam?.name ?? awayAbbr,
  );
}

// ─── Public: team predictions (vs league-average opponent) ────────────────────

export async function buildTeamMarkets(teamAbbr: string): Promise<MarketGroup[]> {
  const [team, all] = await Promise.all([fetchTeamByAbbr(teamAbbr), fetchTeams()]);

  // Build league-average pseudo-team
  const n   = all.length || 1;
  const avg = {
    winPct:             all.reduce((s: number, t: any) => s + (t.winPct ?? 50), 0) / n,
    goalsForPerGame:    all.reduce((s: number, t: any) => s + (t.goalsForPerGame ?? 3.0), 0) / n,
    goalsAgainstPerGame:all.reduce((s: number, t: any) => s + (t.goalsAgainstPerGame ?? 3.0), 0) / n,
  };

  return computeGameMarkets(team, avg, team.name, 'Avg Opponent');
}

// ─── Player markets ───────────────────────────────────────────────────────────

/** Position-based per-game defaults for stats not in the landing endpoint */
const POSITION_DEFAULTS: Record<string, Record<string, number>> = {
  F: { hits: 2.1, blocks: 0.4, pim: 0.50, faceoffWins: 6  },
  D: { hits: 2.2, blocks: 1.6, pim: 0.45, faceoffWins: 1  },
  C: { hits: 2.0, blocks: 0.5, pim: 0.50, faceoffWins: 11 },
  G: { saves: 27, goalsAllowed: 3.0 },
};

function posDefaults(pos: string): Record<string, number> {
  if (pos === 'G') return POSITION_DEFAULTS.G;
  if (pos === 'D') return POSITION_DEFAULTS.D;
  if (pos === 'C') return POSITION_DEFAULTS.C;
  return POSITION_DEFAULTS.F;
}

export async function buildPlayerMarkets(playerId: string): Promise<MarketGroup[]> {
  const p  = await fetchPlayerById(playerId);
  const gp = Math.max(p.gamesPlayed ?? 1, 1);
  const pos = (p.position ?? 'F').toUpperCase();
  const def = posDefaults(pos);
  const isGoalie = pos === 'G';

  if (isGoalie) return buildGoalieMarkets(p, gp, def);
  return buildSkaterMarkets(p, gp, pos, def);
}

function buildSkaterMarkets(p: any, gp: number, pos: string, def: Record<string, number>): MarketGroup[] {
  const gpg  = p.goals   / gp;
  const apg  = p.assists / gp;
  const ppg  = p.points  / gp;
  const spg  = p.shots   / gp;
  const pppg = (p.ppPoints ?? 0) / gp;
  const hits = def.hits;
  const blks = def.blocks;
  const pim  = def.pim;

  // ── Goal Scoring ──────────────────────────────────────────────────────────
  const goals: MarketGroup = {
    id: 'goals', title: 'Goal Scoring', cols: 3,
    options: [
      {
        id: 'g-anytime',
        label: 'Anytime Goal',
        rulePct: pct(1 - Math.exp(-gpg)),
        ruleNote: `${p.goals}G in ${gp} GP = ${fmt(gpg)} G/game → P(≥1)=${fmt((1-Math.exp(-gpg))*100,0)}%`,
      },
      {
        id: 'g-first',
        label: 'First Goal Scorer',
        rulePct: pct((1 - Math.exp(-gpg)) / 5.2),
        ruleNote: `Anytime% ÷ ~5.2 avg shooters/game = ${fmt(((1-Math.exp(-gpg))/5.2)*100,0)}%`,
      },
      {
        id: 'g-2plus',
        label: '2+ Goals',
        rulePct: pct(poissonOver(gpg, 1.5)),
        ruleNote: `Poisson P(X>1.5 | λ=${fmt(gpg)}) = ${fmt(poissonOver(gpg,1.5)*100,0)}%`,
      },
    ],
  };

  // ── Assists ───────────────────────────────────────────────────────────────
  const assists: MarketGroup = {
    id: 'assists', title: 'Assists', cols: 3,
    options: [
      {
        id: 'a-1plus',
        label: '1+ Assist',
        rulePct: pct(1 - Math.exp(-apg)),
        ruleNote: `${p.assists}A in ${gp} GP = ${fmt(apg)} A/game → P(≥1)=${fmt((1-Math.exp(-apg))*100,0)}%`,
      },
      {
        id: 'a-2plus',
        label: '2+ Assists',
        rulePct: pct(poissonOver(apg, 1.5)),
        ruleNote: `Poisson P(X>1.5 | λ=${fmt(apg)}) = ${fmt(poissonOver(apg,1.5)*100,0)}%`,
      },
      {
        id: 'a-3plus',
        label: '3+ Assists',
        rulePct: pct(poissonOver(apg, 2.5)),
        ruleNote: `Poisson P(X>2.5 | λ=${fmt(apg)}) = ${fmt(poissonOver(apg,2.5)*100,0)}%`,
      },
    ],
  };

  // ── Points ────────────────────────────────────────────────────────────────
  const points: MarketGroup = {
    id: 'points', title: 'Points', cols: 3,
    options: [
      {
        id: 'pts-1plus',
        label: '1+ Point',
        rulePct: pct(1 - Math.exp(-ppg)),
        ruleNote: `${p.points}PTS in ${gp} GP = ${fmt(ppg)} P/game → P(≥1)=${fmt((1-Math.exp(-ppg))*100,0)}%`,
      },
      {
        id: 'pts-2plus',
        label: '2+ Points',
        rulePct: pct(poissonOver(ppg, 1.5)),
        ruleNote: `Poisson P(X>1.5 | λ=${fmt(ppg)}) = ${fmt(poissonOver(ppg,1.5)*100,0)}%`,
      },
      {
        id: 'pts-3plus',
        label: '3+ Points',
        rulePct: pct(poissonOver(ppg, 2.5)),
        ruleNote: `Poisson P(X>2.5 | λ=${fmt(ppg)}) = ${fmt(poissonOver(ppg,2.5)*100,0)}%`,
      },
    ],
  };

  // ── Shots on Goal ─────────────────────────────────────────────────────────
  const shots: MarketGroup = {
    id: 'shots', title: 'Shots on Goal', cols: 3,
    options: [
      {
        id: 'sog-o25',
        label: 'Over 2.5',
        rulePct: pct(poissonOver(spg, 2.5)),
        ruleNote: `${p.shots} shots in ${gp} GP = ${fmt(spg)} SOG/game → P(>2.5)=${fmt(poissonOver(spg,2.5)*100,0)}%`,
      },
      {
        id: 'sog-o35',
        label: 'Over 3.5',
        rulePct: pct(poissonOver(spg, 3.5)),
        ruleNote: `Poisson P(>3.5 | λ=${fmt(spg)}) = ${fmt(poissonOver(spg,3.5)*100,0)}%`,
      },
      {
        id: 'sog-o45',
        label: 'Over 4.5',
        rulePct: pct(poissonOver(spg, 4.5)),
        ruleNote: `Poisson P(>4.5 | λ=${fmt(spg)}) = ${fmt(poissonOver(spg,4.5)*100,0)}%`,
      },
    ],
  };

  // ── Hits ──────────────────────────────────────────────────────────────────
  const hitsGroup: MarketGroup = {
    id: 'hits', title: 'Hits', cols: 3,
    options: [
      {
        id: 'hits-o15',
        label: 'Over 1.5',
        rulePct: pct(poissonOver(hits, 1.5)),
        ruleNote: `Position avg ${fmt(hits)} hits/game → P(>1.5)=${fmt(poissonOver(hits,1.5)*100,0)}%`,
      },
      {
        id: 'hits-o25',
        label: 'Over 2.5',
        rulePct: pct(poissonOver(hits, 2.5)),
        ruleNote: `P(>2.5) = ${fmt(poissonOver(hits,2.5)*100,0)}%`,
      },
      {
        id: 'hits-o35',
        label: 'Over 3.5',
        rulePct: pct(poissonOver(hits, 3.5)),
        ruleNote: `P(>3.5) = ${fmt(poissonOver(hits,3.5)*100,0)}%`,
      },
    ],
  };

  // ── Blocked Shots ─────────────────────────────────────────────────────────
  const blocksGroup: MarketGroup = {
    id: 'blocks', title: 'Blocked Shots', cols: 2,
    options: [
      {
        id: 'blk-o05',
        label: 'Over 0.5',
        rulePct: pct(poissonOver(blks, 0.5)),
        ruleNote: `${pos === 'D' ? 'D-man' : 'Forward'} avg ${fmt(blks)} blocks/game → P(≥1)=${fmt(poissonOver(blks,0.5)*100,0)}%`,
      },
      {
        id: 'blk-o15',
        label: 'Over 1.5',
        rulePct: pct(poissonOver(blks, 1.5)),
        ruleNote: `P(≥2 blocks) = ${fmt(poissonOver(blks,1.5)*100,0)}%`,
      },
    ],
  };

  // ── Power Play ────────────────────────────────────────────────────────────
  const ppGroup: MarketGroup = {
    id: 'pp', title: 'Power Play', cols: 2,
    options: [
      {
        id: 'pp-point',
        label: 'PP Point',
        rulePct: pct(1 - Math.exp(-pppg)),
        ruleNote: `${p.ppPoints ?? 0} PP pts in ${gp} GP = ${fmt(pppg)} PP pts/game → P(≥1)=${fmt((1-Math.exp(-pppg))*100,0)}%`,
      },
      {
        id: 'pp-goal',
        label: 'PP Goal',
        rulePct: pct(1 - Math.exp(-pppg * 0.45)),
        ruleNote: `~45% of PP pts are goals → P(PP goal)=${fmt((1-Math.exp(-pppg*0.45))*100,0)}%`,
      },
    ],
  };

  // ── Penalty Minutes ───────────────────────────────────────────────────────
  const pimGroup: MarketGroup = {
    id: 'pim', title: 'Penalty Minutes', cols: 2,
    options: [
      {
        id: 'pim-o05',
        label: 'Over 0.5',
        rulePct: pct(poissonOver(pim, 0.5)),
        ruleNote: `Position avg ${fmt(pim)} PIM/game → P(≥1 PIM)=${fmt(poissonOver(pim,0.5)*100,0)}%`,
      },
      {
        id: 'pim-o15',
        label: 'Over 1.5',
        rulePct: pct(poissonOver(pim, 1.5)),
        ruleNote: `P(≥2 PIM) = ${fmt(poissonOver(pim,1.5)*100,0)}%`,
      },
    ],
  };

  return [goals, assists, points, shots, hitsGroup, blocksGroup, ppGroup, pimGroup];
}

function buildGoalieMarkets(p: any, gp: number, def: Record<string, number>): MarketGroup[] {
  const savesLambda = def.saves ?? 27;
  const gaLambda    = def.goalsAllowed ?? 3.0;
  // Estimate win probability from save% proxy (higher saves ≈ stronger goalie)
  const winEstimate = 0.52; // goalies play ~50/50 adjusted for team

  const saves: MarketGroup = {
    id: 'saves', title: 'Saves', cols: 3,
    options: [
      {
        id: 'sv-o245',
        label: 'Over 24.5',
        rulePct: pct(poissonOver(savesLambda, 24.5)),
        ruleNote: `League avg ${savesLambda} saves/game → P(>24.5)=${fmt(poissonOver(savesLambda,24.5)*100,0)}%`,
      },
      {
        id: 'sv-o275',
        label: 'Over 27.5',
        rulePct: pct(poissonOver(savesLambda, 27.5)),
        ruleNote: `P(>27.5) = ${fmt(poissonOver(savesLambda,27.5)*100,0)}%`,
      },
      {
        id: 'sv-o295',
        label: 'Over 29.5',
        rulePct: pct(poissonOver(savesLambda, 29.5)),
        ruleNote: `P(>29.5) = ${fmt(poissonOver(savesLambda,29.5)*100,0)}%`,
      },
    ],
  };

  const goalsAllowed: MarketGroup = {
    id: 'ga', title: 'Goals Against', cols: 3,
    options: [
      {
        id: 'ga-o15',
        label: 'Over 1.5 GA',
        rulePct: pct(poissonOver(gaLambda, 1.5)),
        ruleNote: `League avg ${fmt(gaLambda)} GA/game → P(>1.5)=${fmt(poissonOver(gaLambda,1.5)*100,0)}%`,
      },
      {
        id: 'ga-o25',
        label: 'Over 2.5 GA',
        rulePct: pct(poissonOver(gaLambda, 2.5)),
        ruleNote: `P(>2.5) = ${fmt(poissonOver(gaLambda,2.5)*100,0)}%`,
      },
      {
        id: 'ga-u25',
        label: 'Under 2.5 GA',
        rulePct: pct(poissonUnder(gaLambda, 2.5)),
        ruleNote: `P(<2.5) = ${fmt(poissonUnder(gaLambda,2.5)*100,0)}%`,
      },
    ],
  };

  const result: MarketGroup = {
    id: 'gresult', title: 'Game Result', cols: 2,
    options: [
      {
        id: 'gr-win',
        label: 'Team Win',
        rulePct: pct(winEstimate),
        ruleNote: `Goalie team win probability (team-based, ~52% adjusted)`,
      },
      {
        id: 'gr-shutout',
        label: 'Shutout',
        rulePct: pct(Math.exp(-gaLambda)),
        ruleNote: `P(0 GA) = e^(−${fmt(gaLambda)}) = ${fmt(Math.exp(-gaLambda)*100,0)}%`,
      },
    ],
  };

  return [saves, goalsAllowed, result];
}
