import { describe, expect, it } from 'vitest';
import { findLegOption, gameLine, summarizeSlip, type WidgetGame, type WidgetLeg } from './widget.service';
import type { MarketGroup } from './nhlPredictions';

const groups: MarketGroup[] = [{
  id: 'match', title: 'Match', cols: 2,
  options: [
    { id: 'ml-home',  label: 'MTL in Reg', rulePct: 40, ruleNote: '', ml: { type: 'game', subjectId: 'MTL', propType: 'moneyline', selection: 'MTL', isHome: true } },
    { id: 'win-home', label: 'MTL',        rulePct: 52, ruleNote: '', ml: { type: 'game', subjectId: 'MTL', propType: 'moneyline', selection: 'MTL', isHome: true } },
    { id: 'tot-o55',  label: 'Over 5.5',   rulePct: 48, ruleNote: '', ml: { type: 'game', subjectId: 'MTL', propType: 'total_goals_over', selection: 'over', line: 5.5 } },
    { id: 'tot-o65',  label: 'Over 6.5',   rulePct: 30, ruleNote: '', ml: { type: 'game', subjectId: 'MTL', propType: 'total_goals_over', selection: 'over', line: 6.5 } },
    { id: 'btts',     label: 'Both score', rulePct: 70, ruleNote: '', ml: { type: 'game', subjectId: 'MTL', propType: 'both_teams_score', settleMarket: 'both_teams_score', settleSelection: 'yes' } },
  ],
}];

describe('findLegOption', () => {
  it('apparie marché + sélection + ligne', () => {
    expect(findLegOption(groups, { marketType: 'total_goals', selectionValue: 'over', line: 6.5 })?.id).toBe('tot-o65');
  });
  it('départage deux tuiles du même marché par l’étiquette de la jambe', () => {
    expect(findLegOption(groups, { marketType: 'moneyline', selectionValue: 'MTL', marketLabel: 'MTL in Reg' })?.id).toBe('ml-home');
    expect(findLegOption(groups, { marketType: 'moneyline', selectionValue: 'mtl', marketLabel: 'MTL' })?.id).toBe('win-home');
  });
  it('lit settleMarket/settleSelection quand la tuile les annonce', () => {
    expect(findLegOption(groups, { marketType: 'both_teams_score', selectionValue: 'yes' })?.id).toBe('btts');
  });
  it('null sans correspondance (ligne différente, marché inconnu, jambe vide)', () => {
    expect(findLegOption(groups, { marketType: 'total_goals', selectionValue: 'over', line: 4.5 })).toBeNull();
    expect(findLegOption(groups, { marketType: 'player_goals', selectionValue: 'over' })).toBeNull();
    expect(findLegOption(groups, {})).toBeNull();
  });
});

const live: WidgetGame = { state: 'live', home: 'TOR', away: 'MTL', homeScore: 1, awayScore: 2, period: 2, clock: '12:34', startsAt: '2026-10-10T23:00:00Z' };
const later: WidgetGame = { state: 'scheduled', home: 'BOS', away: 'NYR', homeScore: null, awayScore: null, period: null, clock: null, startsAt: '2026-10-11T00:00:00Z' };

describe('gameLine', () => {
  it('score, période et horloge en direct ; affiche simple avant le match', () => {
    expect(gameLine(live, 'fr')).toBe('MTL 2–1 TOR · P2 12:34');
    expect(gameLine({ ...live, period: 4, clock: null }, 'fr')).toBe('MTL 2–1 TOR · Prol.');
    expect(gameLine(later, 'en')).toBe('NYR @ BOS');
  });
});

describe('summarizeSlip', () => {
  it('pari simple en direct : titre = la sélection, chiffre live', () => {
    const legs: WidgetLeg[] = [{ placedPct: 55, currentPct: 71, live: true, game: live }];
    const b = summarizeSlip({ id: 's1', legs: [{ selection: 'MTL to win' }], combinedProbability: 55 }, legs, 'fr');
    expect(b).toMatchObject({ title: 'MTL to win', subtitle: 'MTL 2–1 TOR · P2 12:34', state: 'live', placedPct: 55, currentPct: 71, live: true, legs: 1 });
  });
  it('combiné : produit des jambes, repli sur le chiffre du pari, prochaine mise au jeu', () => {
    const legs: WidgetLeg[] = [
      { placedPct: 60, currentPct: 80, live: true, game: live },
      { placedPct: 50, currentPct: null, live: false, game: later },
    ];
    const b = summarizeSlip({ id: 's2', legs: [{}, {}], combinedProbability: 30 }, legs, 'fr');
    expect(b.title).toBe('Combiné · 2 paris');
    expect(b.currentPct).toBe(40);
    expect(b.placedPct).toBe(30);
    expect(b.state).toBe('live');
    expect(b.subtitle).toBe('MTL 2–1 TOR · P2 12:34 · +1');
    expect(b.startsAt).toBe('2026-10-11T00:00:00Z');
  });
  it('jambe sans aucun chiffre → probabilité actuelle inconnue', () => {
    const b = summarizeSlip({ id: 's3', legs: [{}], combinedProbability: null }, [{ placedPct: null, currentPct: null, live: false, game: null }], 'en');
    expect(b.currentPct).toBeNull();
    expect(b.title).toBe('Bet');
  });
});
