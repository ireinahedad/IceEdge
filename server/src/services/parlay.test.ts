import { describe, it, expect } from 'vitest';
import { combineParlayLegs } from './parlay';
import type { ParlayLeg } from './parlay';

/**
 * Ce que ce fichier prouve : un coupon impossible vaut zéro.
 *
 * La route multipliait les jambes et appliquait 0,95, sans jamais regarder ce
 * que les jambes DISAIENT. « Domicile gagne » et « Extérieur gagne » sur le même
 * match sortaient à 22,8 % — un pari qui ne peut pas gagner, vendu comme un
 * 1 contre 4. Le schéma acceptait en plus un champ `correlation` que la route
 * ne lisait pas, et la docstring du client s'en servait pour affirmer que les
 * corrélations étaient prises en compte.
 *
 * Les cas ci-dessous sont tous DÉMONTRABLES : aucun ne dépend d'un coefficient
 * ajusté à la main. Le client importe ce même module (`BetContext.tsx`) : ces
 * tests couvrent donc aussi le coupon de l'application.
 */

const leg = (p: Partial<ParlayLeg> & { probability: number }): ParlayLeg => ({
  marketType: 'moneyline', ...p,
});

const G = '2026020001';
const H = '2026020002';

describe('jambes incompatibles — la seule réponse est zéro', () => {
  it('domicile gagne + extérieur gagne sur le MÊME match', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'moneyline', selection: 'TOR', probability: 55 }),
      leg({ gameId: G, marketType: 'moneyline', selection: 'MTL', probability: 45 }),
    ]);
    // Avant : 55 × 45 × 0.95 = 23.5 %.
    expect(r.probability).toBe(0);
    expect(r.impossible).toBe(true);
  });

  it('les deux mêmes équipes sur des matchs DIFFÉRENTS restent un pari normal', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'moneyline', selection: 'TOR', probability: 60 }),
      leg({ gameId: H, marketType: 'moneyline', selection: 'MTL', probability: 50 }),
    ]);
    expect(r.impossible).toBe(false);
    expect(r.probability).toBeCloseTo(30, 6);
  });

  it('plus de 5.5 + moins de 5.5', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'total_goals_over',  line: 5.5, probability: 54 }),
      leg({ gameId: G, marketType: 'total_goals_under', line: 5.5, probability: 46 }),
    ]);
    expect(r.impossible).toBe(true);
  });

  it('plus de 5.5 + moins de 6.5 est parfaitement possible', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'total_goals_over',  line: 5.5, probability: 54 }),
      leg({ gameId: G, marketType: 'total_goals_under', line: 6.5, probability: 62 }),
    ]);
    expect(r.impossible).toBe(false);
    expect(r.probability).toBeGreaterThan(0);
  });

  it('oui + non sur un marché binaire', () => {
    for (const market of ['both_teams_score', 'game_to_ot', 'clean_sheet', 'puck_line']) {
      const r = combineParlayLegs([
        leg({ gameId: G, marketType: market, selection: 'yes', probability: 70 }),
        leg({ gameId: G, marketType: market, selection: 'no',  probability: 30 }),
      ]);
      expect(r.impossible, market).toBe(true);
    }
  });

  it('deux buteurs différents pour le PREMIER but', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'first_goal_scorer', selection: '8478483', probability: 12 }),
      leg({ gameId: G, marketType: 'first_goal_scorer', selection: '8471675', probability: 11 }),
    ]);
    // Avant : 1,3 %. Un seul joueur peut marquer le premier but.
    expect(r.impossible).toBe(true);
  });

  it('mais deux buteurs « à tout moment » sont parfaitement compatibles', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'anytime_goal', selection: '8478483', probability: 42 }),
      leg({ gameId: G, marketType: 'anytime_goal', selection: '8471675', probability: 38 }),
    ]);
    expect(r.impossible).toBe(false);
    expect(r.probability).toBeGreaterThan(0);
  });

  it('deux seaux d\'écart différents sur le même match', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'winning_margin', selection: '1',  probability: 20 }),
      leg({ gameId: G, marketType: 'winning_margin', selection: '3+', probability: 16 }),
    ]);
    expect(r.impossible).toBe(true);
  });
});

describe('doublons et implications — P(A ∩ A) = P(A), P(A ∩ B) = P(A) si A ⊆ B', () => {
  it('la même jambe deux fois ne se multiplie pas par elle-même', () => {
    const l = leg({ gameId: G, marketType: 'moneyline', selection: 'TOR', probability: 60 });
    const r = combineParlayLegs([l, { ...l }]);
    // Avant : 0.60 × 0.60 × 0.95 = 34.2 % pour un pari qui vaut 60 %.
    expect(r.probability).toBeCloseTo(60, 6);
    expect(r.redundantLegs).toBe(1);
  });

  it('gagner par 2+ implique gagner', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'puck_line', selection: 'TOR', probability: 34 }),
      leg({ gameId: G, marketType: 'moneyline', selection: 'TOR', probability: 60 }),
    ]);
    // L'intersection EST « gagne par 2+ ». Multiplier donnait 20 %.
    expect(r.probability).toBeCloseTo(34, 6);
    expect(r.redundantLegs).toBe(1);
  });

  it('gagner en 60 minutes implique gagner', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'regulation_result', selection: 'TOR', probability: 48 }),
      leg({ gameId: G, marketType: 'moneyline',         selection: 'TOR', probability: 60 }),
    ]);
    expect(r.probability).toBeCloseTo(48, 6);
  });

  it('plus de 6.5 implique plus de 5.5', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'total_goals_over', line: 6.5, probability: 38 }),
      leg({ gameId: G, marketType: 'total_goals_over', line: 5.5, probability: 54 }),
    ]);
    expect(r.probability).toBeCloseTo(38, 6);
  });

  it('l\'ordre des jambes ne change rien', () => {
    const a = leg({ gameId: G, marketType: 'puck_line', selection: 'TOR', probability: 34 });
    const b = leg({ gameId: G, marketType: 'moneyline', selection: 'TOR', probability: 60 });
    expect(combineParlayLegs([a, b]).probability)
      .toBeCloseTo(combineParlayLegs([b, a]).probability, 6);
  });
});

describe('ce qui reste approximatif, et le dit', () => {
  it('deux jambes d\'un même match sans relation connue : produit ET drapeau', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'moneyline',        selection: 'TOR', probability: 60 }),
      leg({ gameId: G, marketType: 'total_goals_over', line: 5.5,             probability: 54 }),
    ]);
    expect(r.probability).toBeCloseTo(32.4, 6);
    // On ne connaît pas leur corrélation — on ne la fabrique pas, on la signale.
    expect(r.assumesIndependence).toBe(true);
  });

  it('des matchs distincts n\'ont rien à signaler', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, marketType: 'moneyline', selection: 'TOR', probability: 60 }),
      leg({ gameId: H, marketType: 'moneyline', selection: 'BOS', probability: 50 }),
    ]);
    expect(r.assumesIndependence).toBe(false);
    expect(r.probability).toBeCloseTo(30, 6);
  });
});

describe('garde-fous', () => {
  it('plus d\'abattement forfaitaire de 0,95', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, probability: 50, selection: 'TOR' }),
      leg({ gameId: H, probability: 50, selection: 'BOS' }),
    ]);
    // Avant : 25 × 0.95 = 23.75 %. Le rabais n'était pas un modèle.
    expect(r.probability).toBeCloseTo(25, 6);
  });

  it('une probabilité illisible rend NaN, jamais un pourcentage', () => {
    const r = combineParlayLegs([
      leg({ gameId: G, probability: Number.NaN }),
      leg({ gameId: H, probability: 50 }),
    ]);
    expect(Number.isNaN(r.probability)).toBe(true);
  });

  it('un coupon sans identifiant de match reste traité comme indépendant', () => {
    const r = combineParlayLegs([
      leg({ marketType: 'moneyline', selection: 'TOR', probability: 60 }),
      leg({ marketType: 'moneyline', selection: 'MTL', probability: 50 }),
    ]);
    // Sans `gameId`, rien ne dit que c'est le même match : l'ancien
    // comportement est conservé plutôt que de deviner.
    expect(r.impossible).toBe(false);
    expect(r.probability).toBeCloseTo(30, 6);
  });
});
