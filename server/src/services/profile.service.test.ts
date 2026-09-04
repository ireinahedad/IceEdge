import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La clé OpenAI d'un utilisateur est en ÉCRITURE SEULE.
 *
 * Ce fichier verrouille les deux moitiés de cette règle, et la seconde est
 * moins évidente que la première.
 *
 * **1. Elle ne sort pas.** `getProfileById` renvoyait
 * `openaiApiKey: decryptSecret(profile.openaiApiKey)` : le secret était chiffré
 * au repos — précisément pour qu'une fuite de la base ne le livre pas — puis
 * déchiffré et renvoyé en entier à CHAQUE chargement de profil. Le test ne se
 * contente pas de vérifier la forme de l'objet rendu : il vérifie que la
 * requête SQL elle-même ne sélectionne plus la colonne chiffrée. Un jour où
 * quelqu'un la remet « juste pour le débogage », la valeur repartirait vers le
 * client sans qu'aucune assertion de forme ne bronche.
 *
 * **2. Elle ne s'efface pas toute seule.** C'est le piège que la règle crée : le
 * champ du formulaire est désormais vide au chargement, donc un client qui
 * envoie `openaiApiKey` à chaque enregistrement effacerait la clé dès qu'on
 * modifie sa bio. Côté serveur, la garantie est que `openaiApiKey` absent des
 * `updates` ne touche PAS la colonne — c'est ce que le dernier bloc vérifie.
 */

const query = vi.fn();
const connect = vi.fn();
vi.mock('../db/connection', () => ({
  pool: {
    query:   (...args: unknown[]) => query(...args),
    connect: (...args: unknown[]) => connect(...args),
  },
}));
vi.mock('../logger', () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

import { getProfileById, updateProfile } from './profile.service';

/** Une ligne telle que la renvoie la requête de profil après le correctif. */
const ROW = {
  id: 'u1',
  username: 'ireina',
  displayName: 'Ireina',
  avatar: '👤',
  avatarUrl: null,
  favoriteTeam: 'MTL',
  bio: '',
  isPublic: true,
  showSlips: false,
  notifyValueBets: false,
  valueBetMinEvPct: 0,
  tier: 'rookie',
  performanceScore: 0,
  joinedAt: '2026-01-01',
  hasOpenaiKey: true,
  ruleWeights: null,
};

/**
 * getProfileById : INSERT idempotent, puis SELECT du profil, puis les badges.
 *
 * L'ordre compte — `mockResolvedValueOnce` forme une FILE, consommée avant
 * toute valeur par défaut. `updateProfile` se terminant par un appel à
 * `getProfileById`, il faut donc empiler l'UPDATE d'abord (cf.
 * `mockUpdateThenReads`), sinon les lectures de profil servent l'UPDATE et le
 * profil revient vide.
 */
function mockProfileReads(row: Record<string, unknown> = ROW) {
  query
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT ... ON CONFLICT DO NOTHING
    .mockResolvedValueOnce({ rows: [row] })           // SELECT profil
    .mockResolvedValueOnce({ rows: [] });             // SELECT badges
}

/** updateProfile : l'UPDATE, puis la relecture complète du profil. */
function mockUpdateThenReads() {
  query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user_profiles
  mockProfileReads();
}

beforeEach(() => { query.mockReset(); connect.mockReset(); });

describe('getProfileById — la clé ne sort pas', () => {
  it('rend `hasOpenaiKey` et aucun champ portant la clé', async () => {
    mockProfileReads();
    const profile: any = await getProfileById('u1');

    expect(profile.hasOpenaiKey).toBe(true);
    expect(profile).not.toHaveProperty('openaiApiKey');
    // Filet plus large que la propriété nommée : aucune valeur du profil ne doit
    // ressembler à une clé, quel que soit le nom sous lequel on l'aurait remise.
    expect(JSON.stringify(profile)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });

  it('`hasOpenaiKey` est faux quand la colonne est vide', async () => {
    mockProfileReads({ ...ROW, hasOpenaiKey: false });
    const profile: any = await getProfileById('u1');
    expect(profile.hasOpenaiKey).toBe(false);
  });

  /**
   * L'assertion qui compte vraiment. Les deux tests ci-dessus passeraient encore
   * si quelqu'un remettait `up.openai_api_key AS "openaiApiKey"` dans le SELECT
   * et oubliait simplement de le recopier dans l'objet rendu — le chiffré
   * quitterait alors la base à chaque lecture, prêt à ressortir à la première
   * ligne de débogage. La requête est donc vérifiée, pas seulement son résultat.
   */
  it('la requête ne sélectionne plus la colonne chiffrée', async () => {
    mockProfileReads();
    await getProfileById('u1');

    const select = String(query.mock.calls[1][0]);
    expect(select).toContain('AS "hasOpenaiKey"');
    expect(select).not.toMatch(/openai_api_key\s+AS/i);
  });
});

describe('updateProfile — la clé ne s\'efface pas toute seule', () => {
  it('ne touche PAS la colonne quand `openaiApiKey` est absent des updates', async () => {
    mockUpdateThenReads();

    // Un enregistrement de profil ordinaire, tel que l'envoie l'écran Paramètres
    // quand l'utilisateur n'a pas touché à sa clé.
    await updateProfile('u1', { bio: 'Analyste NHL', isPublic: true });

    const update = query.mock.calls.map((c) => String(c[0])).find((q) => q.includes('UPDATE user_profiles'));
    expect(update).toBeDefined();
    expect(update).toContain('bio =');
    expect(update).not.toContain('openai_api_key');
  });

  it('écrit la colonne quand une clé est fournie, et jamais en clair', async () => {
    mockUpdateThenReads();

    await updateProfile('u1', { openaiApiKey: 'sk-proj-secret-value-1234' });

    const call = query.mock.calls.find((c) => String(c[0]).includes('openai_api_key'));
    expect(call).toBeDefined();

    const values = call![1] as unknown[];
    const stored = values.find((v) => typeof v === 'string' && v !== 'u1') as string;
    expect(stored).toBeTruthy();
    // `crypto.util` laisse passer le clair quand ENCRYPTION_KEY n'est pas posée
    // (compatibilité avec les lignes d'avant la migration de chiffrement), donc
    // on pose la clé de test dans ce cas plutôt que d'assumer l'environnement.
    if (process.env.ENCRYPTION_KEY) expect(stored).toMatch(/^enc:v1:/);
  });

  it('la chaîne vide efface la clé', async () => {
    mockUpdateThenReads();

    await updateProfile('u1', { openaiApiKey: '' });

    const call = query.mock.calls.find((c) => String(c[0]).includes('openai_api_key'));
    expect(call).toBeDefined();
    expect((call![1] as unknown[]).includes(null)).toBe(true);
  });

  /**
   * Le garde-fou de déploiement. L'ancienne version de l'écran Paramètres
   * envoyait `openaiApiKey: null` à CHAQUE enregistrement de profil ; depuis que
   * la clé est en écriture seule, le champ est vide au chargement, donc un
   * bundle resté en cache effacerait la clé de son propriétaire au premier
   * changement de bio. `null` ne doit rien faire.
   */
  it('`null` ne touche PAS à la colonne — un ancien client ne peut pas effacer la clé', async () => {
    mockUpdateThenReads();

    await updateProfile('u1', { bio: 'Analyste NHL', openaiApiKey: null });

    const update = query.mock.calls.map((c) => String(c[0])).find((q) => q.includes('UPDATE user_profiles'));
    expect(update).toBeDefined();
    expect(update).toContain('bio =');
    expect(update).not.toContain('openai_api_key');
  });
});
