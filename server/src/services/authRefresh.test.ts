import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

/**
 * La rotation du refresh token — PRE_IOS_PLAN.md R3bis.2.
 *
 * Ce fichier existe pour une régression qui ne se voit nulle part ailleurs :
 * si quelqu'un « simplifie » `refreshTokens()` en un SELECT puis un UPDATE, tout
 * continue de marcher à un seul onglet, et en production un jeton se met à en
 * engendrer plusieurs, chacun valide 7 à 30 jours. Aucun autre test ne tombe.
 *
 * L'inverse est aussi couvert : rendre la rotation atomique SANS fenêtre de
 * grâce renvoie un 401 au deuxième onglet, et côté client un 401 sur
 * /auth/refresh vide le stockage — donc une déconnexion à chaque rafraîchissement
 * silencieux. C'est pour ça que l'item était resté ouvert si longtemps.
 *
 * `pool.query` est bouchonné par un mini-Postgres en mémoire, comme dans
 * `jobLock.test.ts` : il ne reproduit que la sémantique des énoncés qui comptent
 * — l'`UPDATE … WHERE revoked = FALSE RETURNING *` (l'atomicité), la recherche
 * `rotated_at` de la grâce, et le contrôle « la session vit-elle encore ». Toute
 * requête non prévue lève, pour qu'un changement de code se voie ici.
 *
 * ⚠️ Ce que ce fichier NE prouve PAS : que le SQL est valide pour Postgres. Un
 * faux pool ne vérifie ni la syntaxe ni les types. Ça, c'est le bac à sable
 * PostgreSQL jetable du plan.
 */

interface TokenRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  revoked: boolean;
  remember: boolean;
  created_at: Date;
  rotated_at: Date | null;
}

const USER = {
  id: 'user-1',
  email: 'a@b.com',
  username: 'a',
  role: 'user',
  is_active: true,
};

function makeFakePool() {
  const tokens: TokenRow[] = [];
  let seq = 0;
  let now = Date.now();

  function insert(token: string, opts: Partial<TokenRow> = {}): TokenRow {
    const row: TokenRow = {
      id: `t${++seq}`,
      user_id: USER.id,
      token,
      expires_at: new Date(now + 7 * 24 * 3600_000),
      revoked: false,
      remember: false,
      created_at: new Date(now),
      rotated_at: null,
      ...opts,
    };
    tokens.push(row);
    return row;
  }

  const query = vi.fn(async (sql: string, params: any[] = []) => {
    // ── La rotation atomique ────────────────────────────────────────────────
    if (sql.includes('UPDATE refresh_tokens') && sql.includes('rotated_at = NOW()')) {
      const row = tokens.find(
        (t) => t.token === params[0] && !t.revoked && t.expires_at.getTime() > now,
      );
      if (!row) return { rowCount: 0, rows: [] };
      // Le point entier de l'énoncé : la ligne bascule AVANT que le prochain
      // appelant ne la lise. Pas d'await entre le test et l'écriture.
      row.revoked = true;
      row.rotated_at = new Date(now);
      return { rowCount: 1, rows: [{ ...row }] };
    }

    // ── La recherche de la fenêtre de grâce ─────────────────────────────────
    if (sql.includes('SELECT * FROM refresh_tokens') && sql.includes('rotated_at IS NOT NULL')) {
      const graceMs = Number(params[1]);
      const row = tokens.find(
        (t) => t.token === params[0] && t.rotated_at !== null && t.rotated_at.getTime() > now - graceMs,
      );
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    }

    // ── « la session vit-elle encore ? » ────────────────────────────────────
    if (sql.includes('SELECT 1 FROM refresh_tokens')) {
      const alive = tokens.some(
        (t) => t.user_id === params[0] && !t.revoked && t.expires_at.getTime() > now,
      );
      return { rowCount: alive ? 1 : 0, rows: alive ? [{ '?column?': 1 }] : [] };
    }

    if (sql.includes('INSERT INTO refresh_tokens')) {
      insert(params[1], { user_id: params[0], expires_at: params[2], remember: params[3] });
      return { rowCount: 1, rows: [] };
    }

    if (sql.includes('SELECT * FROM users')) {
      return USER.is_active && params[0] === USER.id
        ? { rowCount: 1, rows: [{ ...USER }] }
        : { rowCount: 0, rows: [] };
    }

    // logout / logoutAll
    if (sql.includes('UPDATE refresh_tokens SET revoked=TRUE WHERE token=$1')) {
      for (const t of tokens) if (t.token === params[0]) t.revoked = true;
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1')) {
      for (const t of tokens) if (t.user_id === params[0]) t.revoked = true;
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`SQL non bouchonné : ${sql}`);
  });

  return {
    query,
    tokens,
    insert,
    live: () => tokens.filter((t) => !t.revoked),
    advance: (ms: number) => { now += ms; },
  };
}

async function loadAuth(fake: ReturnType<typeof makeFakePool>) {
  vi.resetModules();
  vi.doMock('../db/connection', () => ({ pool: { query: fake.query } }));
  return import('./auth.service');
}

/** Le hash que le service calcule pour un jeton brut. */
function hashed(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

describe('refreshTokens — rotation atomique (R3bis.2)', () => {
  let fake: ReturnType<typeof makeFakePool>;
  beforeEach(() => { fake = makeFakePool(); });

  it('tourne le jeton : l’ancien est révoqué, un nouveau est émis', async () => {
    const { refreshTokens } = await loadAuth(fake);
    fake.insert(hashed('raw-1'));

    const out = await refreshTokens('raw-1');

    expect(out.refresh_token).toBeTruthy();
    expect(out.refresh_token).not.toBe('raw-1');
    expect(fake.tokens[0].revoked).toBe(true);
    expect(fake.tokens[0].rotated_at).not.toBeNull();
    expect(fake.live()).toHaveLength(1);
  });

  /**
   * LE cas que ce fichier existe pour couvrir. Avec l'ancien SELECT-puis-UPDATE,
   * les deux appels réussissaient ET créaient chacun un jeton : `live()` valait 2.
   */
  it('deux appels concurrents : personne n’est déconnecté, et UN SEUL jeton naît', async () => {
    const { refreshTokens } = await loadAuth(fake);
    fake.insert(hashed('raw-1'));

    const [a, b] = await Promise.all([refreshTokens('raw-1'), refreshTokens('raw-1')]);

    expect(a.refresh_token).toBe(b.refresh_token);
    expect(a.access_token).toBe(b.access_token);
    expect(fake.live()).toHaveLength(1);
  });

  it('l’onglet retardataire, encore dans la fenêtre, reçoit la MÊME paire', async () => {
    const { refreshTokens } = await loadAuth(fake);
    fake.insert(hashed('raw-1'));

    const first  = await refreshTokens('raw-1');
    const second = await refreshTokens('raw-1');

    expect(second.refresh_token).toBe(first.refresh_token);
    expect(fake.live()).toHaveLength(1);
  });

  /**
   * Cache perdu (redémarrage, ou une deuxième instance Railway) : la base sait
   * quand même que le jeton vient d'être tourné. On émet une paire fraîche
   * plutôt que de déconnecter — choix assumé, et borné à la fenêtre.
   */
  it('cache perdu mais rotation récente : paire fraîche, pas de 401', async () => {
    const { refreshTokens } = await loadAuth(fake);
    fake.insert(hashed('raw-1'));
    const first = await refreshTokens('raw-1');

    // Nouveau module = process redémarré, cache vide. La base est conservée.
    const { refreshTokens: afterRestart } = await loadAuth(fake);
    const second = await afterRestart('raw-1');

    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(fake.live()).toHaveLength(2); // le prix assumé du repli
  });

  it('passé la fenêtre de grâce, le jeton tourné est mort', async () => {
    const { refreshTokens } = await loadAuth(fake);
    fake.insert(hashed('raw-1'));
    await refreshTokens('raw-1');

    fake.advance(11_000);
    const { refreshTokens: later } = await loadAuth(fake); // cache vidé aussi

    await expect(later('raw-1')).rejects.toMatchObject({ status: 401 });
  });

  it('un jeton inconnu est refusé', async () => {
    const { refreshTokens } = await loadAuth(fake);
    await expect(refreshTokens('jamais-vu')).rejects.toMatchObject({ status: 401 });
  });

  /**
   * Une révocation par déconnexion ne pose PAS `rotated_at`, donc elle reste hors
   * de la fenêtre de grâce. Sans ce comportement, se déconnecter puis rejouer son
   * ancien jeton dans les dix secondes rouvrirait la session.
   */
  it('après logout, l’ancien jeton ne bénéficie d’aucune grâce', async () => {
    const { refreshTokens, logout } = await loadAuth(fake);
    fake.insert(hashed('raw-1'));

    await logout('raw-1');

    await expect(refreshTokens('raw-1')).rejects.toMatchObject({ status: 401 });
  });

  /**
   * « Se déconnecter de tous les appareils » doit vraiment tout fermer, y compris
   * l'onglet qui rejoue un jeton tourné une seconde plus tôt. C'est le contrôle
   * `sessionStillAlive` qui tient cette promesse.
   */
  it('logoutAll ferme la session même pour un onglet dans la fenêtre de grâce', async () => {
    const { refreshTokens, logoutAll } = await loadAuth(fake);
    fake.insert(hashed('raw-1'));

    await refreshTokens('raw-1');  // rotation légitime, la grâce est armée
    await logoutAll(USER.id);      // tout est révoqué

    await expect(refreshTokens('raw-1')).rejects.toMatchObject({ status: 401 });
  });

  it('la persistance « remember me » survit à la rotation', async () => {
    const { refreshTokens } = await loadAuth(fake);
    fake.insert(hashed('raw-1'), { remember: true });

    const out = await refreshTokens('raw-1');

    expect(out.refresh_expires_in).toBeGreaterThan(7 * 24 * 3600);
    expect(fake.live()[0].remember).toBe(true);
  });
});
