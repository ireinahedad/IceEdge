import { describe, it, expect } from 'vitest';
import {
  finalScoreGrid, gridSum, liveFraction, nbAtLeast, nbAtLeastLive, evolveLiveScore, LiveEffects,
  powerPlayFromSituation, ppCategory,
} from './finalScore';
import measured from './liveEffects.json';

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

describe('evolveLiveScore — effets de score mesurés', () => {
  const FLAT: LiveEffects = {
    slices: [[0, 1200], [1200, 2400], [2400, 3600]], diffs: [-3, -2, -1, 0, 1, 2, 3],
    m: [1, 2, 3].map(() => new Array(7).fill(1)), periodDist: [0.305, 0.365, 0.330],
  };
  const FX = measured as LiveEffects;
  const sum = (r: number[][]) => r.reduce((t, row) => t + row.reduce((a, b) => a + b, 0), 0);

  it('m ≡ 1 : on retrouve les deux Poisson de la phase 1', () => {
    const live = { homeScore: 1, awayScore: 0, secondsLeftReg: 1500, inOvertime: false };
    // f de la phase 1 avec la même pondération par période que le moteur.
    const f = (300 / 1200) * 0.365 + 0.330;
    const p1 = finalScoreGrid(3.1, 2.8, 0.5, { ...live, f });
    const p2 = finalScoreGrid(3.1, 2.8, 0.5, { ...live, effects: FLAT });
    for (let h = 0; h < p1.size; h++) {
      for (let a = 0; a < p1.size; a++) expect(p2.p[h][a]).toBeCloseTo(p1.p[h][a], 4);
    }
  });

  it('la masse est conservée, et rien ne bouge une fois les 60 minutes jouées', () => {
    expect(sum(evolveLiveScore(3.2, 2.9, 0, 0, 0, FX))).toBeCloseTo(1, 9);
    const end = evolveLiveScore(3.2, 2.9, 2, 1, 3600, FX);
    expect(end[0][0]).toBe(1);
  });

  it("menée d'un but en fin de match : l'égalisation est plus probable qu'à cadence fixe", () => {
    const live = { homeScore: 2, awayScore: 1, secondsLeftReg: 120, inOvertime: false };
    const flat = finalScoreGrid(3.0, 3.0, 0.5, { ...live, f: (120 / 1200) * 0.330 });
    const fx = finalScoreGrid(3.0, 3.0, 0.5, { ...live, effects: FX });
    expect(fx.regTie).toBeGreaterThan(flat.regTie * 1.5);
    // … et le but dans le filet désert aussi : le domicile gagne plus souvent par 2+.
    expect(gridSum(fx, (h, a) => h - a >= 2)).toBeGreaterThan(gridSum(flat, (h, a) => h - a >= 2));
  });

  it('prolongation en cours : les effets ne changent rien (partage direct)', () => {
    const live = { homeScore: 2, awayScore: 2, secondsLeftReg: 0, inOvertime: true };
    const a = finalScoreGrid(3.0, 3.0, 0.55, live);
    const b = finalScoreGrid(3.0, 3.0, 0.55, { ...live, effects: FX });
    expect(b.p[3][2]).toBeCloseTo(a.p[3][2], 12);
  });
});

describe('avantage numérique en cours — facteurs mesurés (calibrate_live_pp.py)', () => {
  // Facteurs mesurés le 2026-10-13 (ml/models/live/calibrate_live_pp_report.json). NON servis :
  // le rejeu ne montre aucun gain (pénalités de compensation), `liveEffects.json` n'a pas de clé pp.
  const FX: LiveEffects = { ...(measured as LiveEffects),
    pp: { g: {"EV": 0.9367, "EVS": 0.8844, "PP1": 2.1853, "PP2": 5.1049, "SH1": 0.3534, "SH2": 0.1003} } };

  it("liveEffects.json servi n'a PAS de clé pp (rejeu sans gain, 2026-10-13)", () => {
    expect((measured as LiveEffects).pp).toBeUndefined();
  });
  const sum = (r: number[][]) => r.reduce((t, row) => t + row.reduce((a, b) => a + b, 0), 0);
  const mean = (r: number[][], side: 'h' | 'a') =>
    r.reduce((t, row, i) => t + row.reduce((a, p, j) => a + p * (side === 'h' ? i : j), 0), 0);

  it('facteurs mesurés : avantage > moyenne > désavantage', () => {
    const g = FX.pp!.g;
    expect(g.PP1).toBeGreaterThan(1.5);
    expect(g.SH1).toBeLessThan(0.6);
    expect(g.PP2).toBeGreaterThan(g.PP1);
  });

  it('situationCode → situation (gardien retiré non compté, 5 c. 5 = rien)', () => {
    expect(powerPlayFromSituation('1451', 90)).toEqual({ homeSkaters: 5, awaySkaters: 4, secondsLeft: 90, endsOnGoal: true });
    expect(powerPlayFromSituation('1541', 300)).toEqual({ homeSkaters: 4, awaySkaters: 5, secondsLeft: 300, endsOnGoal: false });
    expect(powerPlayFromSituation('1441', 60)?.endsOnGoal).toBe(false);
    expect(powerPlayFromSituation('1551', 0)).toBeNull();
    expect(powerPlayFromSituation('1551', 100)).toBeNull();
    expect(powerPlayFromSituation('0651', 100)).toBeNull();   // 6 c. 5, gardien visiteur retiré
    expect(powerPlayFromSituation('1560', 100)).toBeNull();
    expect(powerPlayFromSituation('1451', Number.NaN)).toBeNull();
    expect(powerPlayFromSituation(651, 100)).toBeNull();      // code numérique sans le 0 de tête
    expect(powerPlayFromSituation('1451', 900)?.secondsLeft).toBe(300);
    expect(ppCategory(5, 3)).toBe('PP2');
    expect(ppCategory(3, 5)).toBe('SH2');
  });

  it("sans situation, ou facteurs à 1 : exactement le moteur d'avant", () => {
    const base = evolveLiveScore(3.1, 2.8, 1, 1, 1500, FX);
    expect(evolveLiveScore(3.1, 2.8, 1, 1, 1500, FX, null)).toEqual(base);
    const ones: LiveEffects = { ...FX, pp: { g: { EV: 1, EVS: 1, PP1: 1, PP2: 1, SH1: 1, SH2: 1 } } };
    // 120 s : la fin de la pénalité tombe sur un pas du moteur, rien n'est redécoupé.
    const pp = { homeSkaters: 5, awaySkaters: 4, secondsLeft: 120, endsOnGoal: true };
    const r = evolveLiveScore(3.1, 2.8, 1, 1, 1500, ones, pp);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) expect(r[i][j]).toBeCloseTo(base[i][j], 12);
  });

  it('domicile à 5 c. 4 : plus de buts pour lui, moins pour le visiteur, masse conservée', () => {
    const base = evolveLiveScore(3.1, 2.8, 0, 0, 1500, FX);
    const pp = evolveLiveScore(3.1, 2.8, 0, 0, 1500, FX, { homeSkaters: 5, awaySkaters: 4, secondsLeft: 120, endsOnGoal: true });
    expect(sum(pp)).toBeCloseTo(1, 9);
    expect(mean(pp, 'h')).toBeGreaterThan(mean(base, 'h') + 0.05);
    expect(mean(pp, 'a')).toBeLessThan(mean(base, 'a'));
  });

  it("mineure : un but de l'équipe en avantage y met fin (moins de 2e but qu'une majeure)", () => {
    const sit = { homeSkaters: 5, awaySkaters: 4, secondsLeft: 120 };
    const minor = evolveLiveScore(3.1, 2.8, 0, 0, 1500, FX, { ...sit, endsOnGoal: true });
    const major = evolveLiveScore(3.1, 2.8, 0, 0, 1500, FX, { ...sit, endsOnGoal: false });
    const twoPlus = (r: number[][]) => r.slice(2).reduce((t, row) => t + row.reduce((a, b) => a + b, 0), 0);
    expect(twoPlus(minor)).toBeLessThan(twoPlus(major));
    // P(au moins un but) identique : la pénalité court tant qu'il n'y en a pas.
    const onePlus = (r: number[][]) => 1 - r[0].reduce((a, b) => a + b, 0);
    expect(onePlus(minor)).toBeCloseTo(onePlus(major), 9);
  });

  it('la grille du score final lit `live.pp`', () => {
    const live = { homeScore: 1, awayScore: 1, secondsLeftReg: 600, inOvertime: false, effects: FX };
    const a = finalScoreGrid(3.0, 3.0, 0.5, live);
    const b = finalScoreGrid(3.0, 3.0, 0.5, { ...live, pp: { homeSkaters: 5, awaySkaters: 4, secondsLeft: 120, endsOnGoal: true } });
    expect(b.regHome).toBeGreaterThan(a.regHome + 0.03);
  });
});

describe('evolveLiveScore — fin de match : table « après un but » (§10.4)', () => {
  const FX = measured as unknown as LiveEffects;
  const total = (g: number[][]) => g.reduce((a, r) => a + r.reduce((b, v) => b + v, 0), 0);
  const pN = (g: number[][], n: number) => g.reduce((a, r, i) => a + r.reduce((b, v, j) => b + (i + j === n ? v : 0), 0), 0);

  it('la table servie porte bien les deux tables', () => {
    expect([3300, 3420, 3480]).toContain(FX.endgameStart);
    expect(FX.mAfterGoal?.length).toBe(FX.m.length);
  });

  it('mAfterGoal = m : exactement le calcul d\'une seule table', () => {
    const same = { ...FX, mAfterGoal: FX.m };
    const single = { ...FX, mAfterGoal: undefined, endgameStart: undefined };
    const a = evolveLiveScore(3.1, 2.8, 2, 1, 3400, same);
    const b = evolveLiveScore(3.1, 2.8, 2, 1, 3400, single);
    a.forEach((r, i) => r.forEach((v, j) => expect(v).toBeCloseTo(b[i][j], 12)));
  });

  it('la masse est conservée, depuis la mise au jeu comme en fin de match', () => {
    for (const el of [0, 2400, 3300, 3480, 3590]) {
      expect(total(evolveLiveScore(3.1, 2.8, 1, 1, el, FX))).toBeCloseTo(1, 9);
      expect(total(evolveLiveScore(3.1, 2.8, 1, 1, el, FX, null, true))).toBeCloseTo(1, 9);
    }
  });

  it('après un premier but, un second est moins probable qu\'avec une seule table', () => {
    const single = { ...FX, mAfterGoal: undefined, endgameStart: undefined };
    const two = evolveLiveScore(3.1, 2.8, 3, 2, 3480, FX);
    const one = evolveLiveScore(3.1, 2.8, 3, 2, 3480, single);
    const ge2 = (g: number[][]) => 1 - pN(g, 0) - pN(g, 1);
    expect(ge2(two)).toBeLessThan(ge2(one));
  });

  it('un but déjà marqué depuis le début de la fin de match ralentit la suite', () => {
    const before = evolveLiveScore(3.1, 2.8, 3, 2, 3500, FX, null, false);
    const after = evolveLiveScore(3.1, 2.8, 3, 2, 3500, FX, null, true);
    expect(1 - pN(after, 0)).toBeLessThan(1 - pN(before, 0));
  });

  it('avant le début de la fin de match, l\'indicateur n\'a aucun effet sur l\'état de départ', () => {
    const a = evolveLiveScore(3.1, 2.8, 1, 0, 2400, FX, null, false);
    const b = evolveLiveScore(3.1, 2.8, 1, 0, 2400, FX, null, true);
    a.forEach((r, i) => r.forEach((v, j) => expect(v).toBeCloseTo(b[i][j], 12)));
  });
});
