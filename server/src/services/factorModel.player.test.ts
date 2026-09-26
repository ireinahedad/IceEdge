import { describe, it, expect } from 'vitest';
import { attachPlayerFactors, PlayerFactorCtx } from './factorModel';

// Garde-fou de l'ancrage des props joueur (2026-09-26, cf. le commentaire
// au-dessus de `goalFactors`). Avant, les facteurs de tendance — constants
// d'une ligne à l'autre — tiraient les lignes hautes vers 50 % : « 2+ buts »
// d'Ovechkin sortait à 34 % pour un Poisson de 6 %.

function poissonOver(lambda: number, line: number): number {
  const k = Math.floor(line);
  let cdf = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) { cdf += term; term = (term * lambda) / (i + 1); }
  return Math.max(0.02, Math.min(0.98, 1 - cdf));
}
const shown = (p: number) => Math.max(3, Math.min(97, Math.round(p * 100)));

// Ovechkin 2025-26 tel que servi en production le 2026-09-26.
const OVI: PlayerFactorCtx = {
  pos: 'L', gpg: 32 / 82, apg: 32 / 82, ppg: 64 / 82, spg: 244 / 82, pppg: 19 / 82,
  shotPct: 13.1, hitsPg: 2.1, blocksPg: 0.4, pimPg: 0.5,
};
// Défenseur défensif : tendances majoritairement SOUS 0,5 (l'autre sens).
const STAY_HOME_D: PlayerFactorCtx = {
  pos: 'D', gpg: 0.04, apg: 0.15, ppg: 0.19, spg: 0.9, pppg: 0.0,
  shotPct: 4.0, hitsPg: 1.4, blocksPg: 1.9, pimPg: 0.6,
};

function groupsFor() {
  const o = (id: string) => ({ id, rulePct: -1 } as any);
  return [
    { id: 'goals',   options: [o('g-anytime'), o('g-first'), o('g-2plus')] },
    { id: 'assists', options: [o('a-1plus'), o('a-2plus'), o('a-3plus')] },
    { id: 'points',  options: [o('pts-1plus'), o('pts-2plus'), o('pts-3plus')] },
    { id: 'shots',   options: [o('sog-o25'), o('sog-o35'), o('sog-o45')] },
    { id: 'hits',    options: [o('hits-o15'), o('hits-o25'), o('hits-o35')] },
    { id: 'blocks',  options: [o('blk-o05'), o('blk-o15')] },
    { id: 'pp',      options: [o('pp-point'), o('pp-goal')] },
    { id: 'pim',     options: [o('pim-o05'), o('pim-o15')] },
  ];
}
const pctOf = (groups: any[], id: string): number =>
  groups.flatMap(g => g.options).find((x: any) => x.id === id).rulePct;

describe.each([['Ovechkin', OVI], ['défenseur défensif', STAY_HOME_D]] as const)(
  'props joueur ancrées sur le taux — %s', (_name, c) => {
  const g = groupsFor();
  attachPlayerFactors(g, c);

  const expected: Record<string, number> = {
    'g-anytime': poissonOver(c.gpg, 0.5),  'g-2plus':   poissonOver(c.gpg, 1.5),
    'a-1plus':   poissonOver(c.apg, 0.5),  'a-2plus':   poissonOver(c.apg, 1.5),  'a-3plus':   poissonOver(c.apg, 2.5),
    'pts-1plus': poissonOver(c.ppg, 0.5),  'pts-2plus': poissonOver(c.ppg, 1.5),  'pts-3plus': poissonOver(c.ppg, 2.5),
    'sog-o25':   poissonOver(c.spg, 2.5),  'sog-o35':   poissonOver(c.spg, 3.5),  'sog-o45':   poissonOver(c.spg, 4.5),
    'hits-o15':  poissonOver(c.hitsPg, 1.5), 'hits-o25': poissonOver(c.hitsPg, 2.5), 'hits-o35': poissonOver(c.hitsPg, 3.5),
    'blk-o05':   poissonOver(c.blocksPg, 0.5), 'blk-o15': poissonOver(c.blocksPg, 1.5),
    'pim-o05':   poissonOver(c.pimPg, 0.5),  'pim-o15':  poissonOver(c.pimPg, 1.5),
  };

  it.each(Object.keys(expected))('%s = taux Poisson (±1 pt d’arrondi des poids)', (id) => {
    expect(Math.abs(pctOf(g, id) - shown(expected[id]))).toBeLessThanOrEqual(1);
  });

  it('chaque échelle décroît avec la ligne', () => {
    const ladders = [
      ['g-anytime', 'g-2plus'], ['a-1plus', 'a-2plus', 'a-3plus'],
      ['pts-1plus', 'pts-2plus', 'pts-3plus'], ['sog-o25', 'sog-o35', 'sog-o45'],
      ['hits-o15', 'hits-o25', 'hits-o35'], ['blk-o05', 'blk-o15'], ['pim-o05', 'pim-o15'],
    ];
    for (const l of ladders) {
      const v = l.map(id => pctOf(g, id));
      for (let i = 1; i < v.length; i++) expect(v[i], l.join(' > ')).toBeLessThanOrEqual(v[i - 1]);
    }
  });

  it('premier buteur ≤ buteur, but PP ≤ point PP', () => {
    expect(pctOf(g, 'g-first')).toBeLessThanOrEqual(pctOf(g, 'g-anytime'));
    expect(pctOf(g, 'pp-goal')).toBeLessThanOrEqual(pctOf(g, 'pp-point'));
  });

  it('chaque facteur reste dans [2 %, 98 %] et les poids somment à 100', () => {
    for (const o of g.flatMap(x => x.options) as any[]) {
      expect(o.factors.reduce((s: number, f: any) => s + f.weight, 0)).toBe(100);
      for (const f of o.factors) {
        expect(f.value).toBeGreaterThanOrEqual(0.02);
        expect(f.value).toBeLessThanOrEqual(0.98);
      }
    }
  });
});

describe('repondération', () => {
  it('déplacer le poids vers une tendance fait encore bouger la tuile', () => {
    const g = groupsFor();
    attachPlayerFactors(g, OVI);
    const o = g[0].options[0] as any; // g-anytime
    const blend = (fs: any[]) =>
      fs.reduce((s, f) => s + f.weight * f.value, 0) / fs.reduce((s, f) => s + f.weight, 0);
    const byDefault = blend(o.factors);
    const tilted = blend(o.factors.map((f: any) => ({ ...f, weight: f.id === 'shotVolume' ? 100 : 0 })));
    expect(Math.abs(tilted - byDefault)).toBeGreaterThan(0.01);
  });
});
