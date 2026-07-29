import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * La garantie testée ici est économique, pas fonctionnelle : « ne jamais payer
 * plus que ce que l'utilisateur paie ». Elle ne produit aucun symptôme visible
 * tant qu'elle tient — on ne s'aperçoit de sa rupture que sur une facture, avec
 * un mois de retard. D'où des tests sur l'arithmétique elle-même, et pas
 * seulement sur le comportement du compteur.
 */

/** Postgres bouchonné : reproduit la sémantique des UPDATE conditionnels. */
function makeFakePool() {
  const perUser = new Map<string, number>();
  const global = new Map<string, number>();

  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes('INSERT INTO llm_usage_global')) {
      const [month, cap] = params;
      const cur = global.get(month) ?? 0;
      if (cur >= Number(cap)) return { rowCount: 0, rows: [] };   // clause WHERE fausse
      global.set(month, cur + 1);
      return { rowCount: 1, rows: [{ count: cur + 1 }] };
    }
    if (sql.includes('INSERT INTO llm_usage')) {
      const [userId, month, limit] = params;
      const key = `${userId}|${month}`;
      const cur = perUser.get(key) ?? 0;
      if (cur >= Number(limit)) return { rowCount: 0, rows: [] };
      perUser.set(key, cur + 1);
      return { rowCount: 1, rows: [{ count: cur + 1 }] };
    }
    if (sql.includes('UPDATE llm_usage_global')) {
      const [month] = params;
      global.set(month, Math.max((global.get(month) ?? 0) - 1, 0));
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE llm_usage')) {
      const [userId, month] = params;
      const key = `${userId}|${month}`;
      perUser.set(key, Math.max((perUser.get(key) ?? 0) - 1, 0));
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('SELECT count FROM llm_usage')) {
      const [userId, month] = params;
      const c = perUser.get(`${userId}|${month}`);
      return { rowCount: c == null ? 0 : 1, rows: c == null ? [] : [{ count: c }] };
    }
    throw new Error(`SQL non bouchonné : ${sql}`);
  });

  return { query, perUser, global };
}

async function load(env: Record<string, string>, fake = makeFakePool()) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.doMock('../db/connection', () => ({ pool: { query: fake.query } }));
  const mod = await import('./llmQuota.service');
  return { mod, fake };
}

const BASE_ENV = {
  PRO_PRICE_MONTHLY: '9.99',
  LLM_BUDGET_SHARE: '0.30',
  LLM_PRICE_INPUT_PER_MTOK: '0.40',
  LLM_PRICE_OUTPUT_PER_MTOK: '1.60',
  LLM_MAX_PROMPT_CHARS: '8000',
  LLM_MAX_SYSTEM_CHARS: '2000',
  LLM_MAX_OUTPUT_TOKENS: '512',
  LLM_GLOBAL_MONTHLY_CAP: '10000',
};

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => { process.env = { ...ORIGINAL_ENV }; delete process.env.LLM_MONTHLY_QUOTA; });

describe('dérivation du plafond', () => {
  // LE test de la garantie. Si le plafond × coût pire-cas dépassait le budget,
  // un utilisateur maximisant chaque requête coûterait plus qu'il ne rapporte.
  it('le coût pire-cas du quota entier ne dépasse jamais le budget alloué', async () => {
    const { mod } = await load(BASE_ENV);

    const budget = 9.99 * 0.30;
    const worstCaseSpend = mod.MONTHLY_QUOTA * mod.WORST_CASE_COST_PER_REQUEST;

    expect(worstCaseSpend).toBeLessThanOrEqual(budget);
    // Et le plafond doit rester utile : pas de division ratée qui donnerait 1.
    expect(mod.MONTHLY_QUOTA).toBeGreaterThan(100);
  });

  it('le plafond suit le prix : doubler le prix double le quota', async () => {
    const cheap = await load({ ...BASE_ENV, PRO_PRICE_MONTHLY: '5.00' });
    const dear  = await load({ ...BASE_ENV, PRO_PRICE_MONTHLY: '10.00' });

    expect(dear.mod.MONTHLY_QUOTA).toBeGreaterThan(cheap.mod.MONTHLY_QUOTA * 1.9);
  });

  // Le tarif du fournisseur est le seul paramètre décidé par quelqu'un d'autre.
  // Une hausse doit resserrer le plafond toute seule, sans intervention.
  it('un modèle plus cher réduit le plafond', async () => {
    const cheap = await load(BASE_ENV);
    const dear  = await load({
      ...BASE_ENV,
      LLM_PRICE_INPUT_PER_MTOK: '2.00',
      LLM_PRICE_OUTPUT_PER_MTOK: '8.00',
    });

    expect(dear.mod.MONTHLY_QUOTA).toBeLessThan(cheap.mod.MONTHLY_QUOTA);
    expect(dear.mod.MONTHLY_QUOTA * dear.mod.WORST_CASE_COST_PER_REQUEST)
      .toBeLessThanOrEqual(9.99 * 0.30);
  });

  // La réessai de fetchWithTimeoutRetry peut faire facturer deux fois.
  it('compte deux tentatives par requête', async () => {
    const { mod } = await load(BASE_ENV);

    const oneAttempt =
      ((8000 + 2000) / 3.5 / 1_000_000) * 0.40 + (512 / 1_000_000) * 1.60;

    expect(mod.WORST_CASE_COST_PER_REQUEST).toBeCloseTo(2 * oneAttempt, 6);
  });

  it('respecte une surcharge explicite de quota', async () => {
    const { mod } = await load({ ...BASE_ENV, LLM_MONTHLY_QUOTA: '500' });
    expect(mod.MONTHLY_QUOTA).toBe(500);
  });
});

describe('consumeProRequest', () => {
  it('laisse passer tant qu’il reste de la place, puis refuse', async () => {
    const { mod, fake } = await load({ ...BASE_ENV, LLM_MONTHLY_QUOTA: '3' });

    for (let i = 1; i <= 3; i++) {
      const v = await mod.consumeProRequest('u1');
      expect(v.allowed, `requête ${i}`).toBe(true);
      expect(v.used).toBe(i);
    }

    const over = await mod.consumeProRequest('u1');
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe('user');
    expect(over.limit).toBe(3);
    expect(over.resetsAt).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  // Avec un limiteur à 10 req/min, deux requêtes simultanées au bord du plafond
  // sont tout à fait atteignables. L'incrément conditionnel est ce qui empêche
  // les deux de passer.
  it('ne laisse pas deux requêtes simultanées franchir le plafond', async () => {
    const { mod } = await load({ ...BASE_ENV, LLM_MONTHLY_QUOTA: '1' });

    const [a, b] = await Promise.all([
      mod.consumeProRequest('u1'),
      mod.consumeProRequest('u1'),
    ]);

    expect([a.allowed, b.allowed].filter(Boolean)).toHaveLength(1);
  });

  it('sépare les utilisateurs', async () => {
    const { mod } = await load({ ...BASE_ENV, LLM_MONTHLY_QUOTA: '1' });

    expect((await mod.consumeProRequest('u1')).allowed).toBe(true);
    expect((await mod.consumeProRequest('u1')).allowed).toBe(false);
    expect((await mod.consumeProRequest('u2')).allowed).toBe(true);
  });

  it('déclenche le disjoncteur global', async () => {
    const { mod } = await load({
      ...BASE_ENV, LLM_MONTHLY_QUOTA: '100', LLM_GLOBAL_MONTHLY_CAP: '2',
    });

    expect((await mod.consumeProRequest('u1')).allowed).toBe(true);
    expect((await mod.consumeProRequest('u2')).allowed).toBe(true);
    const blocked = await mod.consumeProRequest('u3');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('global');
  });

  // Sinon le disjoncteur global dériverait à la hausse à cause de requêtes qui
  // n'ont jamais été envoyées, et sauterait bien avant la dépense réelle.
  it('rend le compteur global quand le plafond individuel bloque', async () => {
    const { mod, fake } = await load({
      ...BASE_ENV, LLM_MONTHLY_QUOTA: '1', LLM_GLOBAL_MONTHLY_CAP: '100',
    });

    await mod.consumeProRequest('u1');
    const before = fake.global.get(mod.currentMonth());
    await mod.consumeProRequest('u1');            // refusée : plafond perso
    expect(fake.global.get(mod.currentMonth())).toBe(before);
  });

  // Fail-closed : ne pas pouvoir compter, c'est ne pas pouvoir garantir.
  it('refuse quand la base est injoignable', async () => {
    const fake = makeFakePool();
    const { mod } = await load(BASE_ENV, fake);
    fake.query.mockRejectedValueOnce(new Error('DB down'));

    const v = await mod.consumeProRequest('u1');
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('db');
  });
});

describe('refundProRequest', () => {
  // Une panne du fournisseur ne doit pas amputer le quota du mois : rien n'a
  // été facturé, l'utilisateur n'a rien reçu.
  it('rend une requête au quota', async () => {
    const { mod } = await load({ ...BASE_ENV, LLM_MONTHLY_QUOTA: '1' });

    await mod.consumeProRequest('u1');
    expect((await mod.consumeProRequest('u1')).allowed).toBe(false);

    await mod.refundProRequest('u1');
    expect((await mod.consumeProRequest('u1')).allowed).toBe(true);
  });

  it('ne descend jamais sous zéro', async () => {
    const { mod, fake } = await load(BASE_ENV);

    await mod.refundProRequest('u1');
    await mod.refundProRequest('u1');

    expect(fake.perUser.get(`u1|${mod.currentMonth()}`) ?? 0).toBe(0);
  });
});

describe('getUsage', () => {
  it('rapporte la consommation sans la modifier', async () => {
    const { mod } = await load({ ...BASE_ENV, LLM_MONTHLY_QUOTA: '10' });

    await mod.consumeProRequest('u1');
    await mod.consumeProRequest('u1');

    const a = await mod.getUsage('u1');
    const b = await mod.getUsage('u1');

    expect(a).toEqual({ used: 2, limit: 10, remaining: 8, resetsAt: mod.nextResetISO() });
    expect(b.used).toBe(2);   // la lecture n'a rien consommé
  });
});

describe('bornes du mois', () => {
  it('bascule le compteur au changement de mois', async () => {
    const { mod } = await load(BASE_ENV);

    expect(mod.currentMonth(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01');
    expect(mod.currentMonth(new Date('2026-02-01T00:00:00Z'))).toBe('2026-02');
  });

  it('annonce la remise à zéro au 1er du mois suivant, décembre compris', async () => {
    const { mod } = await load(BASE_ENV);

    expect(mod.nextResetISO(new Date('2026-07-15T10:00:00Z'))).toBe('2026-08-01T00:00:00.000Z');
    expect(mod.nextResetISO(new Date('2026-12-20T10:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });
});
