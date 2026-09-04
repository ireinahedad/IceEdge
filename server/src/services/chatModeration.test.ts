import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * La modération du chat — PRE_IOS_PLAN.md R4.4.
 *
 * Ce que ce fichier verrouille, et qu'aucun autre test ne verrouille :
 *
 *  • signaler deux fois ne crée pas de seconde ligne (`ON CONFLICT DO NOTHING`) ;
 *  • trois rapporteurs DISTINCTS masquent, un quatrième n'échoue pas et ne
 *    réécrit pas l'horodatage ;
 *  • un blocage cache dans les DEUX sens, et le débloquer rétablit ;
 *  • un message masqué disparaît pour tout le monde, son auteur COMPRIS —
 *    l'inverse serait un bannissement fantôme, et c'est le genre de détail qu'on
 *    « corrige » par erreur en croyant bien faire ;
 *  • la lecture rend les cent messages les plus RÉCENTS, pas les cent premiers.
 *    Ce bug a vécu en production ; sans ce test il revient à la première
 *    réécriture de la requête.
 *
 * `pool` est bouchonné par un mini-Postgres en mémoire, comme dans
 * `jobLock.test.ts` : il reproduit la SÉMANTIQUE des énoncés qui comptent, pas
 * Postgres. Toute requête non prévue lève, pour qu'un changement de SQL se voie
 * ici plutôt qu'en production.
 *
 * ⚠️ Ce que ce fichier NE prouve PAS : que le SQL est valide, ni que les types
 * passent. Un faux pool ne compile rien. Ça, c'est le rôle du PostgreSQL jetable
 * décrit dans le plan — les deux sont complémentaires, aucun ne remplace l'autre.
 */

// ── Le magasin ────────────────────────────────────────────────────────────────

interface MsgRow {
  id: string; room_id: string; user_id: string | null; username: string;
  text: string; sent_at: Date; hidden_at: Date | null; hidden_reason: string | null;
}
interface ReportRow {
  id: number; message_id: string; reporter_id: string; reason: string;
  note: string | null; status: string; created_at: Date;
  reviewed_by: string | null; reviewed_at: Date | null;
}
interface BlockRow { blocker_id: string; blocked_id: string; created_at: Date }

/**
 * Des UUID, pas des surnoms : `blockUser()` valide le format et rendrait 404
 * pour « a ». Utiliser de vraies formes ici, c'est aussi ce qui fait que le test
 * du non-UUID plus bas prouve quelque chose.
 */
const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const AUTEUR = uid('1');
const A      = uid('2');
const B      = uid('3');
const C      = uid('4');
const D      = uid('5');
const ADMIN  = uid('6');
const TIERS  = uid('7');

const ROOMS = {
  pub:  { id: 'pub',  name: 'Le salon', isPrivate: false },
  priv: { id: 'priv', name: 'Privé',    isPrivate: true  },
};

function makeFakePool() {
  const messages: MsgRow[] = [];
  const reports: ReportRow[] = [];
  const blocks: BlockRow[] = [];
  const members = new Set<string>();          // `${roomId}:${userId}`
  const users = new Set<string>([AUTEUR, A, B, C, D, ADMIN, TIERS]);
  let reportSeq = 0;
  let clock = Date.UTC(2026, 0, 1);

  function addMessage(id: string, opts: Partial<MsgRow> = {}): MsgRow {
    const row: MsgRow = {
      id, room_id: 'pub', user_id: AUTEUR, username: 'auteur',
      text: id, sent_at: new Date((clock += 1000)),
      hidden_at: null, hidden_reason: null, ...opts,
    };
    messages.push(row);
    return row;
  }

  /** La sémantique exacte de la requête d'historique (R4.2f + fenêtre récente). */
  function readMessages(roomId: string, viewerId: string | null): MsgRow[] {
    const visible = messages.filter((m) => {
      if (m.room_id !== roomId) return false;
      if (m.hidden_at !== null) return false;                 // masqué pour TOUT LE MONDE
      if (!viewerId || !m.user_id) return true;
      // Anti-jointure symétrique : bloqueur OU bloqué.
      return !blocks.some(
        (b) => (b.blocker_id === viewerId && b.blocked_id === m.user_id)
            || (b.blocked_id === viewerId && b.blocker_id === m.user_id),
      );
    });
    // ORDER BY sent_at DESC, id DESC · LIMIT 100 … puis remis en ordre croissant.
    const newest = [...visible]
      .sort((x, y) => (y.sent_at.getTime() - x.sent_at.getTime()) || (x.id < y.id ? 1 : -1))
      .slice(0, 100);
    return newest.sort((x, y) => (x.sent_at.getTime() - y.sent_at.getTime()) || (x.id < y.id ? -1 : 1));
  }

  const query = vi.fn(async (sql: string, params: any[] = []) => {
    // ── Salons et adhésions ────────────────────────────────────────────────
    if (sql.includes('FROM chat_rooms WHERE id')) {
      const room = (ROOMS as any)[params[0]];
      return room ? { rowCount: 1, rows: [{ ...room }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM chat_room_members WHERE room_id')) {
      const has = members.has(`${params[0]}:${params[1]}`);
      return { rowCount: has ? 1 : 0, rows: has ? [{ role: 'member', pinned: false }] : [] };
    }

    // ── Le message visé par un signalement ─────────────────────────────────
    if (sql.includes('SELECT room_id, user_id FROM chat_messages')) {
      const m = messages.find((x) => x.id === params[0]);
      return { rowCount: m ? 1 : 0, rows: m ? [{ room_id: m.room_id, user_id: m.user_id }] : [] };
    }

    // ── Historique ─────────────────────────────────────────────────────────
    if (sql.includes('FROM chat_messages m')) {
      const rows = readMessages(params[0], params[1] ?? null).map((m) => ({
        id: m.id, userId: m.user_id, username: m.username, displayName: m.username,
        avatar: '👤', tier: 'rookie', text: m.text, sentAt: m.sent_at,
        tag: null, replyToUsername: null, replyToText: null, avatarUrl: null,
      }));
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('FROM chat_reactions')) return { rowCount: 0, rows: [] };

    // ── La file d'admin ────────────────────────────────────────────────────
    if (sql.includes('FROM chat_reports r')) {
      const open = reports.filter((r) => r.status === 'open');
      const byMessage = new Map<string, ReportRow[]>();
      for (const r of open) byMessage.set(r.message_id, [...(byMessage.get(r.message_id) ?? []), r]);
      const rows = [...byMessage.entries()].map(([messageId, group]) => {
        const m = messages.find((x) => x.id === messageId)!;
        return {
          reportId: Math.min(...group.map((g) => g.id)),
          messageId,
          reportCount: group.length,
          reasons: [...new Set(group.map((g) => g.reason))],
          notes: group.map((g) => g.note).filter((n): n is string => n !== null),
          firstReportedAt: new Date(Math.min(...group.map((g) => g.created_at.getTime()))),
          lastReportedAt:  new Date(Math.max(...group.map((g) => g.created_at.getTime()))),
          roomId: m.room_id, roomName: (ROOMS as any)[m.room_id]?.name ?? null,
          text: m.text, sentAt: m.sent_at,
          authorId: m.user_id, authorUsername: m.username,
          hiddenAt: m.hidden_at, hiddenReason: m.hidden_reason,
        };
      }).sort((x, y) => y.lastReportedAt.getTime() - x.lastReportedAt.getTime());
      return { rowCount: rows.length, rows };
    }

    // ── Blocages ───────────────────────────────────────────────────────────
    if (sql.includes('SELECT 1 FROM users WHERE id')) {
      const ok = users.has(params[0]);
      return { rowCount: ok ? 1 : 0, rows: ok ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('INSERT INTO user_blocks')) {
      const [blocker, blocked] = params;
      if (!blocks.some((b) => b.blocker_id === blocker && b.blocked_id === blocked)) {
        blocks.push({ blocker_id: blocker, blocked_id: blocked, created_at: new Date(clock) });
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('DELETE FROM user_blocks')) {
      const i = blocks.findIndex((b) => b.blocker_id === params[0] && b.blocked_id === params[1]);
      if (i >= 0) blocks.splice(i, 1);
      return { rowCount: i >= 0 ? 1 : 0, rows: [] };
    }
    if (sql.includes('FROM user_blocks b')) {
      const rows = blocks
        .filter((b) => b.blocker_id === params[0])
        .map((b) => ({
          id: b.blocked_id, username: b.blocked_id, displayName: b.blocked_id,
          avatar: '👤', avatarUrl: null, createdAt: b.created_at,
        }));
      return { rowCount: rows.length, rows };
    }

    throw new Error(`SQL non bouchonné : ${sql}`);
  });

  /** Les écritures transactionnelles de reportMessage / reviewReport. */
  const clientQuery = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };

    if (sql.includes('INSERT INTO chat_reports')) {
      const [messageId, reporterId, reason, note] = params;
      // UNIQUE (message_id, reporter_id) — la contrainte EST la limite.
      if (reports.some((r) => r.message_id === messageId && r.reporter_id === reporterId)) {
        return { rowCount: 0, rows: [] };
      }
      const row: ReportRow = {
        id: ++reportSeq, message_id: messageId, reporter_id: reporterId, reason,
        note: note ?? null, status: 'open', created_at: new Date((clock += 1000)),
        reviewed_by: null, reviewed_at: null,
      };
      reports.push(row);
      return { rowCount: 1, rows: [{ id: row.id }] };
    }

    // Masquage automatique : COUNT(DISTINCT reporter_id) >= 3 AND hidden_at IS NULL
    if (sql.includes("SET hidden_at = NOW(), hidden_reason = 'auto'")) {
      const [messageId, threshold] = params;
      const m = messages.find((x) => x.id === messageId);
      if (!m || m.hidden_at !== null) return { rowCount: 0, rows: [] };
      const distinct = new Set(reports.filter((r) => r.message_id === messageId).map((r) => r.reporter_id));
      if (distinct.size < Number(threshold)) return { rowCount: 0, rows: [] };
      m.hidden_at = new Date((clock += 1000));
      m.hidden_reason = 'auto';
      return { rowCount: 1, rows: [{ id: m.id }] };
    }

    if (sql.includes('SELECT message_id FROM chat_reports')) {
      const r = reports.find((x) => x.id === Number(params[0]));
      return { rowCount: r ? 1 : 0, rows: r ? [{ message_id: r.message_id }] : [] };
    }
    if (sql.includes('UPDATE chat_reports')) {
      const [messageId, status, adminId] = params;
      const touched = reports.filter((r) => r.message_id === messageId && r.status === 'open');
      for (const r of touched) { r.status = status; r.reviewed_by = adminId; r.reviewed_at = new Date(clock); }
      return { rowCount: touched.length, rows: touched.map((r) => ({ id: r.id })) };
    }
    if (sql.includes("hidden_reason = 'admin'")) {
      const m = messages.find((x) => x.id === params[0]);
      if (m) { m.hidden_at = m.hidden_at ?? new Date(clock); m.hidden_reason = 'admin'; }
      return { rowCount: m ? 1 : 0, rows: [] };
    }
    if (sql.includes('SET hidden_at = NULL')) {
      const m = messages.find((x) => x.id === params[0]);
      if (m && m.hidden_reason === 'auto') { m.hidden_at = null; m.hidden_reason = null; }
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('SELECT hidden_at FROM chat_messages')) {
      const m = messages.find((x) => x.id === params[0]);
      return { rowCount: m ? 1 : 0, rows: m ? [{ hidden_at: m.hidden_at }] : [] };
    }

    throw new Error(`SQL client non bouchonné : ${sql}`);
  });

  return {
    pool: {
      query,
      connect: async () => ({ query: clientQuery, release: () => {} }),
    },
    messages, reports, blocks, members, users, addMessage, readMessages,
  };
}

type Fake = ReturnType<typeof makeFakePool>;

async function loadChat(fake: Fake) {
  vi.resetModules();
  vi.doMock('../db/connection', () => ({ pool: fake.pool }));
  return import('./chat.service');
}

async function loadUsers(fake: Fake) {
  vi.resetModules();
  vi.doMock('../db/connection', () => ({ pool: fake.pool }));
  return import('./user.service');
}

const texts = (r: { messages: Array<Record<string, unknown>> }) => r.messages.map((m) => String(m.text));

// ── Signalement ───────────────────────────────────────────────────────────────

describe('reportMessage (R4.2c)', () => {
  let fake: Fake;
  beforeEach(() => { fake = makeFakePool(); fake.addMessage('m1'); });

  it('crée un signalement', async () => {
    const { chatService } = await loadChat(fake);
    const out = await chatService.reportMessage('pub', 'm1', A, { reason: 'spam' });

    expect(out).toEqual({ alreadyReported: false, hidden: false });
    expect(fake.reports).toHaveLength(1);
  });

  it('signaler DEUX FOIS ne crée pas de seconde ligne, et n’est pas une erreur', async () => {
    const { chatService } = await loadChat(fake);
    await chatService.reportMessage('pub', 'm1', A, { reason: 'spam' });
    const out = await chatService.reportMessage('pub', 'm1', A, { reason: 'hate' });

    expect(out.alreadyReported).toBe(true);
    expect(fake.reports).toHaveLength(1);
    expect(fake.reports[0].reason).toBe('spam');   // le premier motif reste
  });

  it('refuse de signaler son propre message', async () => {
    const { chatService } = await loadChat(fake);
    await expect(chatService.reportMessage('pub', 'm1', AUTEUR, { reason: 'spam' }))
      .rejects.toMatchObject({ status: 400 });
    expect(fake.reports).toHaveLength(0);
  });

  it('refuse un motif hors liste', async () => {
    const { chatService } = await loadChat(fake);
    await expect(chatService.reportMessage('pub', 'm1', A, { reason: 'parce_que' } as any))
      .rejects.toMatchObject({ status: 400 });
  });

  /**
   * Le chemin est imbriqué sous /rooms/:roomId précisément pour ça : sans le
   * contrôle de lecture, n'importe quel compte confirmerait l'existence d'un
   * message d'un salon privé en devinant son identifiant.
   */
  it('refuse un salon privé dont on n’est pas membre', async () => {
    fake.addMessage('mp', { room_id: 'priv' });
    const { chatService } = await loadChat(fake);
    await expect(chatService.reportMessage('priv', 'mp', A, { reason: 'spam' }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('refuse un message qui n’appartient pas au salon annoncé', async () => {
    fake.addMessage('mp', { room_id: 'priv' });
    const { chatService } = await loadChat(fake);
    await expect(chatService.reportMessage('pub', 'mp', A, { reason: 'spam' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('tronque la note à 500 caractères au lieu de la refuser', async () => {
    const { chatService } = await loadChat(fake);
    await chatService.reportMessage('pub', 'm1', A, { reason: 'other', note: 'x'.repeat(900) });
    expect(fake.reports[0].note).toHaveLength(500);
  });

  it('une note vide devient NULL', async () => {
    const { chatService } = await loadChat(fake);
    await chatService.reportMessage('pub', 'm1', A, { reason: 'other', note: '   ' });
    expect(fake.reports[0].note).toBeNull();
  });
});

// ── Masquage automatique ──────────────────────────────────────────────────────

describe('masquage automatique à 3 rapporteurs (R4.2d)', () => {
  let fake: Fake;
  beforeEach(() => { fake = makeFakePool(); fake.addMessage('m1'); });

  it('trois rapporteurs DISTINCTS masquent, deux ne suffisent pas', async () => {
    const { chatService } = await loadChat(fake);
    expect((await chatService.reportMessage('pub', 'm1', A, { reason: 'spam' })).hidden).toBe(false);
    expect((await chatService.reportMessage('pub', 'm1', B, { reason: 'spam' })).hidden).toBe(false);
    expect((await chatService.reportMessage('pub', 'm1', C, { reason: 'spam' })).hidden).toBe(true);

    expect(fake.messages[0].hidden_reason).toBe('auto');
  });

  it('le même rapporteur trois fois ne masque RIEN', async () => {
    const { chatService } = await loadChat(fake);
    for (let i = 0; i < 3; i++) await chatService.reportMessage('pub', 'm1', A, { reason: 'spam' });
    expect(fake.messages[0].hidden_at).toBeNull();
  });

  it('un quatrième signalement n’échoue pas et ne réécrit pas l’horodatage', async () => {
    const { chatService } = await loadChat(fake);
    for (const u of [A, B, C]) await chatService.reportMessage('pub', 'm1', u, { reason: 'spam' });
    const stamp = fake.messages[0].hidden_at;

    const out = await chatService.reportMessage('pub', 'm1', D, { reason: 'spam' });

    expect(out).toEqual({ alreadyReported: false, hidden: false });
    expect(fake.messages[0].hidden_at).toBe(stamp);
    expect(fake.reports).toHaveLength(4);
  });
});

// ── Lectures filtrées ─────────────────────────────────────────────────────────

describe('lectures filtrées (R4.2f)', () => {
  let fake: Fake;
  beforeEach(() => {
    fake = makeFakePool();
    fake.addMessage('m_auteur', { user_id: AUTEUR, username: 'auteur', text: 'de auteur' });
    fake.addMessage('m_tiers',  { user_id: TIERS,  username: 'tiers',  text: 'de tiers'  });
  });

  it('un blocage cache dans les DEUX sens', async () => {
    const { chatService } = await loadChat(fake);
    const { blockUser } = await loadUsers(fake);
    await blockUser(TIERS, AUTEUR);

    expect(texts(await chatService.getRoomMessages('pub', TIERS))).toEqual(['de tiers']);
    expect(texts(await chatService.getRoomMessages('pub', AUTEUR))).toEqual(['de auteur']);
    // Un tiers non concerné voit tout.
    expect(texts(await chatService.getRoomMessages('pub', A))).toHaveLength(2);
  });

  it('le déblocage rétablit', async () => {
    const { chatService } = await loadChat(fake);
    const { blockUser, unblockUser } = await loadUsers(fake);
    await blockUser(TIERS, AUTEUR);
    await unblockUser(TIERS, AUTEUR);

    expect(texts(await chatService.getRoomMessages('pub', TIERS))).toHaveLength(2);
  });

  /** Pas de bannissement fantôme : masqué veut dire masqué pour tout le monde. */
  it('un message masqué disparaît AUSSI pour son propre auteur', async () => {
    const { chatService } = await loadChat(fake);
    for (const u of [A, B, C]) await chatService.reportMessage('pub', 'm_auteur', u, { reason: 'spam' });

    expect(texts(await chatService.getRoomMessages('pub', AUTEUR))).toEqual(['de tiers']);
    expect(texts(await chatService.getPublicRoomMessages('pub'))).toEqual(['de tiers']);
  });

  it('un invité n’a pas de liste de blocage mais subit le masquage', async () => {
    const { chatService } = await loadChat(fake);
    const { blockUser } = await loadUsers(fake);
    await blockUser(TIERS, AUTEUR);

    expect(texts(await chatService.getPublicRoomMessages('pub'))).toHaveLength(2);
  });

  it('un message dont l’auteur a été supprimé reste visible', async () => {
    fake.messages[0].user_id = null;
    const { chatService } = await loadChat(fake);
    expect(texts(await chatService.getRoomMessages('pub', TIERS))).toHaveLength(2);
  });
});

// ── La fenêtre des cent messages ──────────────────────────────────────────────

describe('fenêtre d’historique', () => {
  /**
   * Ce test existe parce que le bug a vécu en production : `ORDER BY sent_at ASC
   * LIMIT 100` rendait les cent PREMIERS messages, donc un salon actif affichait
   * son histoire d'ouverture pour toujours.
   */
  it('rend les cent messages les plus RÉCENTS, en ordre croissant', async () => {
    const fake = makeFakePool();
    for (let i = 1; i <= 150; i++) {
      fake.addMessage(`m${String(i).padStart(4, '0')}`, { text: `message ${i}` });
    }
    const { chatService } = await loadChat(fake);

    const out = texts(await chatService.getRoomMessages('pub', A));

    expect(out).toHaveLength(100);
    expect(out[0]).toBe('message 51');
    expect(out[99]).toBe('message 150');
  });
});

// ── File d'admin ──────────────────────────────────────────────────────────────

describe('file de modération (R4.2h)', () => {
  let fake: Fake;
  beforeEach(() => { fake = makeFakePool(); fake.addMessage('m1'); fake.addMessage('m2'); });

  it('groupe par MESSAGE, pas par signalement', async () => {
    const { chatService } = await loadChat(fake);
    await chatService.reportMessage('pub', 'm1', A, { reason: 'spam', note: 'note a' });
    await chatService.reportMessage('pub', 'm1', B, { reason: 'hate', note: 'note b' });
    await chatService.reportMessage('pub', 'm2', A, { reason: 'spam' });

    const file = await chatService.getOpenReports();
    const cible = file.find((f: any) => f.messageId === 'm1');

    expect(file).toHaveLength(2);
    expect(cible.reportCount).toBe(2);
    expect(cible.reasons.sort()).toEqual(['hate', 'spam']);
    expect(cible.notes).toHaveLength(2);
  });

  it('actioned masque le message et ferme TOUS ses signalements ouverts', async () => {
    const { chatService } = await loadChat(fake);
    await chatService.reportMessage('pub', 'm1', A, { reason: 'spam' });
    await chatService.reportMessage('pub', 'm1', B, { reason: 'spam' });
    const [entry] = await chatService.getOpenReports();

    const out = await chatService.reviewReport(entry.reportId, ADMIN, 'actioned');

    expect(out).toMatchObject({ messageId: 'm1', reportsUpdated: 2, hidden: true });
    expect(fake.messages[0].hidden_reason).toBe('admin');
    expect(await chatService.getOpenReports()).toHaveLength(0);
    expect(fake.reports.every((r) => r.reviewed_by === ADMIN)).toBe(true);
  });

  /** La sortie de secours du seuil à trois : trois complices, un admin rétablit. */
  it('dismissed retire un masquage AUTOMATIQUE', async () => {
    const { chatService } = await loadChat(fake);
    for (const u of [A, B, C]) await chatService.reportMessage('pub', 'm1', u, { reason: 'spam' });
    expect(fake.messages[0].hidden_reason).toBe('auto');
    const [entry] = await chatService.getOpenReports();

    const out = await chatService.reviewReport(entry.reportId, ADMIN, 'dismissed');

    expect(out.hidden).toBe(false);
    expect(fake.messages[0].hidden_at).toBeNull();
  });

  it('dismissed ne défait PAS un masquage posé par un admin', async () => {
    const { chatService } = await loadChat(fake);
    await chatService.reportMessage('pub', 'm1', A, { reason: 'spam' });
    const [first] = await chatService.getOpenReports();
    await chatService.reviewReport(first.reportId, ADMIN, 'actioned');

    await chatService.reportMessage('pub', 'm1', B, { reason: 'spam' });
    const [second] = await chatService.getOpenReports();
    const out = await chatService.reviewReport(second.reportId, ADMIN, 'dismissed');

    expect(out.hidden).toBe(true);
    expect(fake.messages[0].hidden_reason).toBe('admin');
  });

  it('refuse une décision hors liste, y compris « open »', async () => {
    const { chatService } = await loadChat(fake);
    await chatService.reportMessage('pub', 'm1', A, { reason: 'spam' });
    const [entry] = await chatService.getOpenReports();

    await expect(chatService.reviewReport(entry.reportId, ADMIN, 'open'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('refuse un signalement inexistant', async () => {
    const { chatService } = await loadChat(fake);
    await expect(chatService.reviewReport(999, ADMIN, 'actioned'))
      .rejects.toMatchObject({ status: 404 });
  });
});

// ── Blocages ──────────────────────────────────────────────────────────────────

describe('blocage (R4.2e)', () => {
  let fake: Fake;
  beforeEach(() => { fake = makeFakePool(); });

  it('bloquer est idempotent', async () => {
    const { blockUser } = await loadUsers(fake);
    await blockUser(A, B);
    await blockUser(A, B);
    expect(fake.blocks).toHaveLength(1);
  });

  it('refuse de se bloquer soi-même', async () => {
    const { blockUser } = await loadUsers(fake);
    await expect(blockUser(A, A)).rejects.toMatchObject({ status: 400 });
  });

  it('une cible inconnue rend 404', async () => {
    const { blockUser } = await loadUsers(fake);
    await expect(blockUser(A, uid('99'))).rejects.toMatchObject({ status: 404 });
  });

  /** Un identifiant non-UUID atteindrait une colonne `uuid` : 22P02, donc 500. */
  it('un identifiant non-UUID rend 404, jamais une erreur Postgres', async () => {
    const { blockUser } = await loadUsers(fake);
    await expect(blockUser(A, 'pas-un-uuid')).rejects.toMatchObject({ status: 404 });
  });

  it('débloquer ce qui ne l’est pas est silencieux', async () => {
    const { unblockUser } = await loadUsers(fake);
    await expect(unblockUser(A, B)).resolves.toBeUndefined();
  });

  /** « Untel vous a bloqué » se retourne immédiatement en harcèlement. */
  it('la liste ne révèle jamais qui vous a bloqué', async () => {
    const { blockUser, getBlockedUsers } = await loadUsers(fake);
    await blockUser(A, B);

    expect(await getBlockedUsers(A)).toHaveLength(1);
    expect(await getBlockedUsers(B)).toHaveLength(0);
  });
});
