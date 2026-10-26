import { describe, it, expect } from 'vitest';
import { publicVsModel, PUBLIC_VS_MODEL_MIN_SETTLED, type SettledPickemGame } from './pickem';

/**
 * F5 « Public vs modèle » (NEWS_CONSENSUS_PLAN.md, étape 6). Ce qui compte :
 *   • rien n'est publiable sous 300 picks réglés ;
 *   • semaine lundi → dimanche, heure de l'Est, comme le classement ;
 *   • modèle compté seulement là où son choix a été FIGÉ avant le match ;
 *   • public : choix majoritaire, égalité non comptée ; « très sûr » = ≥ 80 % et ≥ 10 votes.
 */

const g = (iso: string, rightN: number, wrongN: number, modelCorrect: boolean | null = true): SettledPickemGame =>
  ({ gameStart: Date.parse(iso), rightN, wrongN, modelCorrect });

describe('publicVsModel', () => {
  it('aucun match : pas prêt, série vide', () => {
    const r = publicVsModel([]);
    expect(r).toMatchObject({ ready: false, settledPicks: 0, minSettled: PUBLIC_VS_MODEL_MIN_SETTLED, weeks: [] });
    expect(r.total).toMatchObject({ games: 0, since: null, until: null, model: { games: 0, wins: 0, pct: null } });
  });

  it('prêt à partir de 300 picks réglés, pas avant', () => {
    expect(publicVsModel([g('2026-10-27T23:00:00Z', 200, 99)]).ready).toBe(false);
    expect(publicVsModel([g('2026-10-27T23:00:00Z', 200, 100)]).ready).toBe(true);
  });

  it('semaines lundi → dimanche heure de l’Est : dimanche 22 h ET reste dans sa semaine', () => {
    const r = publicVsModel([
      g('2026-11-02T02:30:00Z', 3, 1),   // dimanche 1er nov., 21 h 30 ET (heure normale depuis le 1er nov.)
      g('2026-10-27T23:00:00Z', 3, 1),   // mardi 27 oct.
      g('2026-11-03T00:00:00Z', 3, 1),   // lundi 2 nov., 19 h ET
    ]);
    expect(r.weeks.map((w) => [w.weekStart, w.weekEnd, w.games])).toEqual([
      ['2026-10-26', '2026-11-01', 2],
      ['2026-11-02', '2026-11-08', 1],
    ]);
    expect(r.total).toMatchObject({ since: '2026-10-26', until: '2026-11-08', games: 3 });
  });

  it('public : majorité, égalité non comptée ; modèle : seulement là où il a été figé', () => {
    const r = publicVsModel([
      g('2026-10-27T23:00:00Z', 6, 4, true),    // public a raison, modèle aussi
      g('2026-10-28T23:00:00Z', 2, 5, false),   // public a tort, modèle aussi
      g('2026-10-29T23:00:00Z', 3, 3, true),    // égalité : public non compté
      g('2026-10-30T23:00:00Z', 1, 4, null),    // modèle pas capturé
    ]);
    const w = r.weeks[0];
    expect(w.games).toBe(4);
    expect(w.model).toEqual({ games: 3, wins: 2, pct: 66.7 });
    expect(w.crowd).toEqual({ games: 3, wins: 1, pct: 33.3 });
  });

  it('public très sûr : ≥ 80 % du même côté ET ≥ 10 votes', () => {
    const r = publicVsModel([
      g('2026-10-27T23:00:00Z', 8, 2),    // 80 %, 10 votes : compté, juste
      g('2026-10-28T23:00:00Z', 1, 9),    // 90 % du côté perdant : compté, faux
      g('2026-10-29T23:00:00Z', 8, 1),    // 89 % mais 9 votes : non
      g('2026-10-30T23:00:00Z', 15, 5),   // 75 % : non
    ]);
    expect(r.total.strongCrowd).toEqual({ games: 2, wins: 1, pct: 50 });
    expect(r.total.crowd).toEqual({ games: 4, wins: 3, pct: 75 });
    expect(r.settledPicks).toBe(49);
  });
});
