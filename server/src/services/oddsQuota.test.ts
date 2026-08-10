/**
 * oddsQuota.test.ts — La règle d'arbitrage du quota The Odds API.
 *
 * Ce qui est vérifié ici n'est pas de la plomberie : c'est la garantie que le
 * collecteur de fond ne peut pas affamer les visiteurs. Sur une clé gratuite
 * (500 crédits/mois), l'erreur est facile à commettre et invisible — on ne
 * s'en aperçoit qu'une fois le mois consommé et le site vide.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

process.env.ODDS_USER_RESERVE = '150';

import * as quota from './oddsQuota';

/** Fabrique un jeu d'en-têtes façon `fetch`. */
const headers = (remaining: number | null, used = 0) => ({
  get: (name: string) =>
    name === 'x-requests-remaining'
      ? (remaining === null ? null : String(remaining))
      : name === 'x-requests-used'
        ? String(used)
        : null,
});

describe('oddsQuota — arbitrage collecteur / visiteurs', () => {
  beforeEach(() => quota.__resetForTests());

  it('laisse le collecteur dépenser tant que la réserve reste intacte', async () => {
    quota.observe(headers(400));
    expect(quota.remaining()).toBe(400);
    expect(await quota.collectorMaySpend(3)).toBe(true);
  });

  it('coupe le collecteur dès que la dépense entamerait la réserve', async () => {
    // 152 − 3 = 149 < 150 : la passe suivante mordrait sur la réserve.
    quota.observe(headers(152));
    expect(await quota.collectorMaySpend(3)).toBe(false);

    quota.observe(headers(153));   // 153 − 3 = 150, pile à la limite
    expect(await quota.collectorMaySpend(3)).toBe(true);
  });

  it('garde la réserve entière pour les visiteurs', async () => {
    quota.observe(headers(150));
    expect(await quota.collectorMaySpend(1)).toBe(false);
    // Le proxy, lui, n'est jamais bridé : il peut descendre jusqu'à 0. C'est
    // exactement l'asymétrie voulue — rien dans ce module ne l'en empêche.
    expect(quota.remaining()).toBe(150);
  });

  it('sans observation, concède UNE sonde puis se tait', async () => {
    // Un redémarrage ne doit pas faire repartir la collecte « à l'aveugle » en
    // supposant le quota intact : c'est ainsi qu'on dépense un mois sans le
    // voir. Mais un blocage total serait pire — sur une base vierge, rien ne
    // débloquerait la collecte tant qu'aucun visiteur n'est passé. D'où une
    // sonde unique, dont la réponse renseigne le solde pour de bon.
    expect(quota.remaining()).toBe(0);
    expect(await quota.collectorMaySpend(3)).toBe(true);   // la sonde
    expect(await quota.collectorMaySpend(3)).toBe(false);  // plus rien ensuite
  });

  it('une fois le solde connu, la sonde ne resurgit pas', async () => {
    quota.observe(headers(10));            // très bas, sous la réserve
    expect(await quota.collectorMaySpend(3)).toBe(false);
    expect(await quota.collectorMaySpend(3)).toBe(false);
  });

  it('ignore un en-tête absent ou illisible plutôt que de repartir à zéro', async () => {
    // `Number(null)` vaut 0, qui est fini : une vérification naïve laissait
    // passer une réponse sans en-tête, écrasait le solde et suspendait la
    // collecte pour de bon, sans erreur visible.
    quota.observe(headers(300));
    quota.observe(headers(null));          // réponse sans en-tête de quota
    expect(quota.remaining()).toBe(300);

    quota.observe({ get: () => '' });      // en-tête présent mais vide
    expect(quota.remaining()).toBe(300);

    quota.observe({ get: () => 'beaucoup' });   // non numérique
    expect(quota.remaining()).toBe(300);
  });

  it('ne lève jamais, même sans objet d’en-têtes exploitable', async () => {
    // Un compteur de crédits ne doit pas pouvoir casser la fonctionnalité
    // qu'il observe : l'appel est dans le `try` de `fetchAllOdds`, donc une
    // exception ici faisait échouer TOUTE la récupération des cotes.
    quota.observe(headers(300));
    expect(() => quota.observe(undefined)).not.toThrow();
    expect(() => quota.observe(null)).not.toThrow();
    expect(() => quota.observe({} as any)).not.toThrow();
    expect(quota.remaining()).toBe(300);
  });

  it('décrémente entre deux observations, puis la réponse fait autorité', async () => {
    quota.observe(headers(300));
    quota.debit(3);
    expect(quota.remaining()).toBe(297);
    // Le fournisseur reste la source de vérité : d'autres environnements
    // peuvent partager la clé, et le décompte local dériverait.
    quota.observe(headers(250));
    expect(quota.remaining()).toBe(250);
  });

  it('allonge le TTL du proxy à mesure que les crédits baissent', async () => {
    const base = 5 * 60_000;
    const ttlAt = (left: number) => {
      quota.__resetForTests();
      quota.observe(headers(left));
      return quota.proxyTtlMs(base);
    };

    expect(ttlAt(450)).toBe(base);              // abondance : inchangé
    expect(ttlAt(300)).toBeGreaterThan(base);
    expect(ttlAt(150)).toBeGreaterThan(ttlAt(300));
    expect(ttlAt(50)).toBeGreaterThan(ttlAt(150));
    expect(ttlAt(0)).toBeGreaterThanOrEqual(24 * 60 * 60_000);
  });

  it('le TTL est monotone : jamais plus court quand il reste moins de crédits', async () => {
    const base = 5 * 60_000;
    const ttls: number[] = [];
    for (const left of [500, 420, 399, 300, 249, 150, 99, 40, 0]) {
      quota.__resetForTests();
      quota.observe(headers(left));
      ttls.push(quota.proxyTtlMs(base));
    }
    for (let i = 1; i < ttls.length; i++) {
      expect(ttls[i]).toBeGreaterThanOrEqual(ttls[i - 1]);
    }
  });
});
