import { describe, it, expect } from 'vitest';
import { finalScoreGrid, gridSum, liveFraction, nbAtLeast, nbAtLeastLive } from './finalScore';

/**
 * Ce que ce fichier prouve : la grille du score final sait partir d'un match
 * EN COURS (score actuel + buts restants) sans rien changer à l'avant-match.
 */

const total = (g: ReturnType<typeof finalScoreGrid>) => gridSum(g, () => true);

describe('finalScoreGrid — avant-match inchangé', () => {
  it('sans `live` : même taille, mêmes cases qu\'avant (valeurs figées)', () => {
    const g = finalScoreGrid(3.2, 2.9, 0.52);
    expect(g.size).toBe(16);
    // Valeurs relevées sur le code d'AVANT le mode direct (2026-09-30).
    expect(g.p[0][0]).toBe(0);                      // un nul 0–0 finit 1–0 ou 0–1
    expect(g.p[1][0]).toBeCloseTo(0.0083435, 7);
    expect(g.p[3][2]).toBeCloseTo(0.0766172, 7);
    expect(g.p[2][3]).toBeCloseTo(0.0698568, 7);
    expect(total(g)).toBeCloseTo(1, 12);
  });

  it('issue à 60 minutes : domicile + visiteur + nul = 1', () => {
    const g = finalScoreGrid(3.2, 2.9, 0.52);
    expect(g.regHome + g.regAway + g.regTie).toBeCloseTo(1, 12);
    expect(g.regHome).toBeGreaterThan(g.regAway);
  });
});

describe('finalScoreGrid — en direct', () => {
  it('0–0 avec 60 minutes à jouer = avant-match, case par case', () => {
    const pre  = finalScoreGrid(3.2, 2.9, 0.52);
    const live = finalScoreGrid(3.2, 2.9, 0.52, { homeScore: 0, awayScore: 0, secondsLeftReg: 3600, inOvertime: false });
    expect(live.size).toBe(pre.size);
    for (let h = 0; h < pre.size; h++) {
      for (let a = 0; a < pre.size; a++) expect(live.p[h][a]).toBeCloseTo(pre.p[h][a], 12);
    }
  });

  it('score décalé : aucune masse sous le score actuel, somme = 1', () => {
    const g = finalScoreGrid(3.2, 2.9, 0.52, { homeScore: 2, awayScore: 1, secondsLeftReg: 1500, inOvertime: false });
    expect(gridSum(g, (h, a) => h < 2 || a < 1)).toBe(0);
    expect(total(g)).toBeCloseTo(1, 12);
    expect(g.size).toBe(2 + 16);
  });

  it('plus de temps : plus rien ne bouge — 3–1 est le score final', () => {
    const g = finalScoreGrid(3.2, 2.9, 0.52, { homeScore: 3, awayScore: 1, secondsLeftReg: 0, inOvertime: false });
    expect(g.p[3][1]).toBe(1);
    expect(g.regHome).toBe(1);
  });

  it('nul à 60 minutes : un but de plus, partagé selon otShareHome', () => {
    const g = finalScoreGrid(3.2, 2.9, 0.6, { homeScore: 2, awayScore: 2, secondsLeftReg: 0, inOvertime: false });
    expect(g.p[3][2]).toBeCloseTo(0.6, 12);
    expect(g.p[2][3]).toBeCloseTo(0.4, 12);
    expect(g.regTie).toBe(1);
  });

  it('prolongation en cours : partage direct, même si du temps « restait »', () => {
    const g = finalScoreGrid(3.2, 2.9, 0.45, { homeScore: 1, awayScore: 1, secondsLeftReg: 900, inOvertime: true });
    expect(g.p[2][1]).toBeCloseTo(0.45, 12);
    expect(g.p[1][2]).toBeCloseTo(0.55, 12);
  });

  it('f explicite prioritaire sur le temps restant', () => {
    expect(liveFraction({ homeScore: 0, awayScore: 0, secondsLeftReg: 1800, inOvertime: false })).toBe(0.5);
    expect(liveFraction({ homeScore: 0, awayScore: 0, secondsLeftReg: 1800, inOvertime: false, f: 0.47 })).toBe(0.47);
    expect(liveFraction({ homeScore: 0, awayScore: 0, secondsLeftReg: 1800, inOvertime: true, f: 0.47 })).toBe(0);
  });

  it('tieBoost gonfle les nuls à 60 minutes, sans toucher au rapport domicile/visiteur', () => {
    const state = { homeScore: 0, awayScore: 0, secondsLeftReg: 3600, inOvertime: false };
    const base = finalScoreGrid(3.2, 2.9, 0.5, state);
    const boosted = finalScoreGrid(3.2, 2.9, 0.5, { ...state, tieBoost: 2 });
    expect(boosted.regTie).toBeGreaterThan(base.regTie);
    expect(boosted.regHome / boosted.regAway).toBeCloseTo(base.regHome / base.regAway, 10);
    expect(total(boosted)).toBeCloseTo(1, 12);
  });

  it('un but d\'avance à 5 minutes de la fin : victoire très probable, pas certaine', () => {
    const g = finalScoreGrid(3.2, 2.9, 0.5, { homeScore: 3, awayScore: 2, secondsLeftReg: 300, inOvertime: false });
    const win = gridSum(g, (h, a) => h > a);
    expect(win).toBeGreaterThan(0.8);
    expect(win).toBeLessThan(1);
  });
});

describe('nbAtLeastLive — « les deux marquent » sur le temps restant', () => {
  it('f = 1 : exactement la loi d\'avant-match', () => {
    for (const j of [1, 2, 3]) expect(nbAtLeastLive(3.1, j, 6.5, 1)).toBeCloseTo(nbAtLeast(3.1, j, 6.5), 12);
  });
  it('déjà atteint → 1 ; plus de temps → 0', () => {
    expect(nbAtLeastLive(3.1, 0, 6.5, 0.4)).toBe(1);
    expect(nbAtLeastLive(3.1, -1, 6.5, 0)).toBe(1);
    expect(nbAtLeastLive(3.1, 1, 6.5, 0)).toBe(0);
  });
  it('moins de temps → moins de chances', () => {
    expect(nbAtLeastLive(3.1, 1, 6.5, 0.2)).toBeLessThan(nbAtLeastLive(3.1, 1, 6.5, 0.6));
  });
});
