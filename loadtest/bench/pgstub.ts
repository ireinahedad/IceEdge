/**
 * bench/pgstub.ts — Postgres bouchonné, et surtout COMPTÉ.
 *
 * CE QUE ÇA SERT À MESURER
 *
 * Le N+1 ne se voit pas dans une latence : une requête SQL locale coûte une
 * milliseconde, cent requêtes SQL coûtent cent millisecondes, et personne ne le
 * remarque tant que la base est à côté. En production la base est à Francfort
 * derrière PgBouncer, et les cent requêtes coûtent deux secondes et une place
 * dans le pool. Le seul chiffre qui prédit ça est **le nombre de requêtes SQL
 * par requête HTTP**, et il ne dépend pas de la base : il dépend du code.
 *
 * Ce module remplace donc `pg` par un bouchon qui :
 *   • compte chaque `query`, avec son texte normalisé ;
 *   • rend des lignes plausibles pour les quelques requêtes qu'exercent les
 *     endpoints critiques ;
 *   • simule une latence configurable — c'est elle qui traduit « 40 requêtes »
 *     en « 400 ms », ce qui rend le défaut visible au lieu d'abstrait.
 *
 * LIMITE ASSUMÉE : le bouchon ne vérifie pas le SQL. Il ne dira jamais qu'un
 * index manque. Il dit COMBIEN de fois le code parle à la base, et c'est la
 * question que les scénarios de l'audit posent (S4 : « le nombre de requêtes
 * Neon par ouverture de salon doit être ~1, pas ~100 »).
 */

import { benchGameId, benchGameTeams } from './upstream';

export interface SqlCall { sql: string; at: number }

export const sqlCalls: SqlCall[] = [];

let latencyMs = 1;

/**
 * Nombre de lignes rendues par les SELECT de collection (classement, listes).
 *
 * C'est l'axe du test N+1 : un code sain fait le même nombre de requêtes qu'il
 * ramène 5 lignes ou 500 ; un code en N+1 fait une requête de plus PAR LIGNE.
 * Sans ce réglage, un bouchon qui rend toujours une ligne ne peut pas
 * distinguer les deux — il rendrait « 2 requêtes » dans les deux cas.
 */
let rowCount = 1;

export function setSqlLatency(ms: number): void { latencyMs = ms; }
export function setRowCount(n: number): void { rowCount = Math.max(1, n); }

export function reset(): void { sqlCalls.length = 0; }

export function total(): number { return sqlCalls.length; }

/** Première ligne significative de chaque requête, pour un tableau lisible. */
export function byStatement(): Array<{ sql: string; n: number }> {
  const m = new Map<string, number>();
  for (const c of sqlCalls) {
    const key = c.sql.replace(/\s+/g, ' ').trim().slice(0, 90);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([sql, n]) => ({ sql, n }))
    .sort((a, b) => b.n - a.n);
}

// ── Le compte de test ───────────────────────────────────────────────────────

export const BENCH_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'bench@iceedge.local',
  password: 'BenchPassw0rd!',
  role: 'admin',
};

/**
 * Rôle servi par le bouchon — réglable, et ça compte.
 *
 * `requirePro` laisse passer un `admin` SANS consulter `isPro` :
 *
 *     if (req.user.role === 'admin' || (await isPro(req.user.sub)))
 *
 * Un banc connecté en admin traverse donc toutes les portes Pro sans jamais
 * toucher le cache d'entitlement — et conclut que le cache « n'est pas
 * exercé » alors que c'est le banc qui évite le chemin. B10 se connecte en
 * simple membre pour cette raison.
 */
let userRole: string = BENCH_USER.role;
export function setUserRole(role: 'admin' | 'user'): void { userRole = role; }

let passwordHash = '';

/**
 * Hache une fois le mot de passe du compte de banc — avec la fonction de
 * l'application, donc au VRAI coût (`SALT_ROUNDS` de `auth.service`). C'est ce
 * qui rend le banc « vague de connexions » honnête : bcrypt est le seul travail
 * lourd du chemin de login, et le mesurer à un coût inventé ne dirait rien.
 *
 * Import dynamique et tardif à dessein : `@node-rs/bcrypt` vit dans
 * `server/node_modules`, hors de portée d'un fichier de `loadtest/`. Passer par
 * un module de `server/src` laisse Node résoudre la dépendance depuis le bon
 * dossier, sans NODE_PATH ni chemin en dur.
 */
export async function prepare(): Promise<void> {
  if (passwordHash) return;
  const { hashPassword } = await import('../../server/src/services/auth.service');
  passwordHash = await hashPassword(BENCH_USER.password);
}

function userRow() {
  return {
    id: BENCH_USER.id,
    email: BENCH_USER.email,
    username: 'bench',
    password_hash: passwordHash,
    first_name: 'Bench',
    last_name: 'User',
    role: userRole,
    is_active: true,
    email_verified: true,
    google_id: null,
    avatar_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    // Les vues « autrui » refusent 403 quand le profil est privé ou masque ses
    // coupons. Un bouchon qui laisse ces champs vides mesure le refus, pas la
    // route — c'est ce qui a d'abord fait passer les deux routes Pro pour
    // cassées.
    displayName: 'Bench User',
    avatar: '👤',
    avatarUrl: null,
    tier: 'rookie',
    isPublic: true,
    is_public: true,
    showSlips: true,
    show_slips: true,
    performanceScore: 0,
    userId: BENCH_USER.id,
  };
}

/** Abonnement Pro actif — c'est lui qui rend le cache `isPro` observable. */
function subscriptionRow() {
  return {
    user_id: BENCH_USER.id,
    plan: 'pro',
    status: 'active',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    // Loin dans le futur : `isPro` borne son TTL par la fin de période, et une
    // date proche ferait expirer le cache pendant le banc — on mesurerait alors
    // l'expiration, pas le cache.
    current_period_end: new Date(Date.now() + 30 * 86_400_000),
    cancel_at_period_end: false,
    trial_used: false,
    last_event_at: null,
    updated_at: new Date(),
  };
}

/** Le salon que les bancs ouvrent — exporté pour qu'ils n'aient pas à le recopier. */
export const BENCH_ROOM_ID = '00000000-0000-4000-9000-000000000001';

/** Ligne de salon, avec les alias que `ROOM_VIEW_SELECT` produit. */
function roomRow(i: number) {
  return {
    id: i === 0 ? BENCH_ROOM_ID : `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
    name: `Salon ${i}`,
    icon: '🏒',
    description: 'salon de banc',
    color: '#86d1ea',
    isLive: i === 0,
    isPinned: false,
    isPrivate: false,
    joinCode: 'BENCH1',
    createdBy: BENCH_USER.id,
    createdAt: new Date(),
    role: 'member',
    pinned: false,
    isMember: true,
    memberCount: 42,
    lastMessage: 'dernier message',
    lastMessageAt: new Date(),
  };
}

/** Message de salon, avec les alias de `getMessages`. */
function messageRow(i: number) {
  return {
    id: `msg-${i}`,
    userId: BENCH_USER.id,
    username: `joueur${i % 7}`,
    displayName: `Joueur ${i % 7}`,
    avatar: '👤',
    avatarUrl: null,
    tier: 'rookie',
    text: `message ${i}`,
    sentAt: new Date(Date.now() - i * 1000),
    tag: null,
    attachment: null,
    replyToUsername: null,
    replyToText: null,
  };
}

/** Ticket, avec les alias de `getSlips`. */
function slipRow(i: number) {
  return {
    id: `slip-${i}`,
    user_id: BENCH_USER.id,
    placedAt: new Date(Date.now() - i * 60_000),
    sport: 'nhl',
    legs: [{ subjectName: 'BOS vs NYR', selection: 'BOS ML', probability: 58, marketType: 'moneyline' }],
    legCount: 1,
    isParlay: false,
    combinedProbability: 58,
    combined_probability: 58,
    outcome: 'pending',
    resolvedAt: null,
    xpAwarded: null,
    is_parlay: false,
    leg_count: 1,
  };
}

// ── File de tickets en attente (banc B14) ───────────────────────────────────

interface SlipEnAttente {
  id: string;
  userId: string;
  placedAt: Date;
  legs: any[];
  combinedProbability: number;
  outcome: 'pending' | 'win' | 'loss';
}

let filePending: SlipEnAttente[] = [];

/**
 * Prépare une soirée : `n` tickets en attente répartis sur `matchs` matchs.
 *
 * LA FILE EST ÉTATIQUE, et c'est indispensable. `settlePendingSlips` pagine par
 * CURSEUR `(placed_at, id)` et s'arrête quand un lot revient incomplet. Un
 * bouchon qui rendrait toujours les mêmes lignes ferait tourner la passe
 * jusqu'à son plafond de 5 000 et le banc mesurerait une boucle infinie en
 * croyant mesurer un débit. Ici les tickets se vident réellement à mesure que
 * l'UPDATE les règle — donc une pagination cassée se verrait, au lieu d'être
 * masquée.
 *
 * Une moitié des tickets parie sur l'équipe à domicile (qui gagne 4-2 dans le
 * bouchon amont), l'autre sur la visiteuse : la passe produit donc des gains ET
 * des pertes, et exerce les deux branches du calcul d'XP.
 */
export function seedPendingSlips(n: number, matchs: number): void {
  const base = Date.now() - n * 1000;
  filePending = Array.from({ length: n }, (_, i) => {
    const idxMatch = i % matchs;
    const gameId = benchGameId(idxMatch);
    const [dom, vis] = benchGameTeams(idxMatch);
    return {
      id: `00000000-0000-4000-b000-${String(i).padStart(12, '0')}`,
      userId: BENCH_USER.id,
      placedAt: new Date(base + i * 1000),
      legs: [{
        gameId,
        marketType: 'moneyline',
        selectionValue: i % 2 === 0 ? dom : vis,
        subjectId: null,
        line: null,
        subjectName: `${dom.toUpperCase()} vs ${vis.toUpperCase()}`,
      }],
      combinedProbability: 55,
      outcome: 'pending' as const,
    };
  });
}

/** Ce qu'il reste à régler — le banc le lit pour vérifier `exhausted`. */
export function pendingRestants(): number {
  return filePending.filter((s) => s.outcome === 'pending').length;
}

export function reglesParIssue(): { win: number; loss: number } {
  return {
    win:  filePending.filter((s) => s.outcome === 'win').length,
    loss: filePending.filter((s) => s.outcome === 'loss').length,
  };
}

// ── Aiguillage SQL → lignes ─────────────────────────────────────────────────

function resultFor(sql: string, params: any[]): { rows: any[]; rowCount: number } {
  const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();

  if (s.startsWith('SELECT 1') || s.startsWith('SET ') || s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
    return { rows: [{ '?column?': 1 }], rowCount: 1 };
  }

  // ── Chemins authentifiés (B10, B11) ───────────────────────────────────────
  //
  // ORDRE SIGNIFICATIF : ces tables sont testées AVANT `FROM USERS`, parce que
  // plusieurs de leurs requêtes joignent `users` (`LEFT JOIN users u`). Un
  // aiguillage moins spécifique en premier les capterait toutes et le banc
  // mesurerait un chemin qui n'existe pas.

  if (s.includes('FROM SUBSCRIPTIONS') || s.includes('INTO SUBSCRIPTIONS')) {
    return { rows: [subscriptionRow()], rowCount: 1 };
  }

  // Compte de membres : sous-requête corrélée `COUNT(*)::int AS n`.
  if (s.includes('COUNT(*)::INT AS N FROM CHAT_ROOM_MEMBERS')) {
    return { rows: [{ n: rowCount }], rowCount: 1 };
  }

  if (s.includes('FROM CHAT_ROOM_MEMBERS')) {
    // Appartenance du spectateur : présent, et simple membre.
    return { rows: [{ role: 'member', pinned: false, user_id: BENCH_USER.id }], rowCount: 1 };
  }

  if (s.includes('FROM CHAT_REACTIONS')) {
    // Une réaction sur un message sur deux : de quoi exercer le regroupement
    // par message sans prétendre à un salon réaliste.
    const rows = Array.from({ length: Math.ceil(rowCount / 2) }, (_, i) => ({
      messageId: `msg-${i * 2}`, emoji: '🔥', count: '3',
    }));
    return { rows, rowCount: rows.length };
  }

  if (s.includes('FROM CHAT_MESSAGES')) {
    const rows = Array.from({ length: rowCount }, (_, i) => messageRow(i));
    return { rows, rowCount: rows.length };
  }

  if (s.includes('FROM CHAT_ROOMS')) {
    // Vue d'UN salon (`r.id = $2`) ou liste : la clause décide du nombre de
    // lignes, et c'est ce nombre qui fait vivre ou non un N+1 dans le listing.
    const unSeul = s.includes('R.ID = $2') || s.includes('WHERE ID = $1');
    const n = unSeul ? 1 : rowCount;
    const rows = Array.from({ length: n }, (_, i) => roomRow(i));
    return { rows, rowCount: rows.length };
  }

  if (s.includes('FROM USER_BLOCKS')) {
    return { rows: [], rowCount: 0 };
  }

  // Passe de règlement : file réelle, curseur honoré (cf. `seedPendingSlips`).
  if (s.includes('FROM BET_SLIPS') && s.includes("OUTCOME = 'PENDING'") && filePending.length) {
    const limit = Number(params[0]) || 100;
    // Le curseur, quand il est là, occupe les deux derniers paramètres.
    let apresAt: number | null = null;
    let apresId: string | null = null;
    if (s.includes('(PLACED_AT, ID) >')) {
      apresAt = new Date(String(params[params.length - 2])).getTime();
      apresId = String(params[params.length - 1]);
    }
    const dispo = filePending
      .filter((sl) => sl.outcome === 'pending')
      .filter((sl) => {
        if (apresAt === null) return true;
        const t = sl.placedAt.getTime();
        return t > apresAt || (t === apresAt && sl.id > (apresId as string));
      })
      .slice(0, limit)
      .map((sl) => ({
        id: sl.id,
        userId: sl.userId,
        legs: sl.legs,
        placedAt: sl.placedAt,
        combinedProbability: sl.combinedProbability,
      }));
    return { rows: dispo, rowCount: dispo.length };
  }

  if (s.startsWith('UPDATE BET_SLIPS') && filePending.length) {
    const issue = String(params[0]);
    const id = String(params[params.length - 1]);
    const sl = filePending.find((x) => x.id === id);
    if (!sl || sl.outcome !== 'pending') return { rows: [], rowCount: 0 };
    sl.outcome = issue === 'win' ? 'win' : 'loss';
    return { rows: [], rowCount: 1 };
  }

  if (s.includes('FROM BET_SLIPS')) {
    const rows = Array.from({ length: rowCount }, (_, i) => slipRow(i));
    return { rows, rowCount: rows.length };
  }

  if (s.includes('FROM USERS')) {
    // Un identifiant inconnu doit rendre 0 ligne, sinon le banc de connexion
    // mesurerait un chemin qui n'existe pas (tout le monde se connecte).
    const wantsEmail = s.includes('EMAIL =');
    if (wantsEmail && params[0] && String(params[0]).toLowerCase() !== BENCH_USER.email) {
      return { rows: [], rowCount: 0 };
    }
    // Requête de COLLECTION (classement, recherche) → `rowCount` lignes, pour
    // que le test N+1 ait de quoi déclencher une boucle s'il y en a une.
    if (s.includes('JOIN USER_PROFILES') || s.includes('LIMIT 20') || s.includes('ORDER BY')) {
      const rows = Array.from({ length: rowCount }, (_, i) => ({
        ...userRow(),
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        username: `joueur${i}`,
        displayName: `Joueur ${i}`,
        avatar: '👤',
        avatarUrl: null,
        tier: 'rookie',
        performanceScore: 1000 - i,
      }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [userRow()], rowCount: 1 };
  }

  // Agrégats de paris du classement — `fetchBetStats` les demande en UN appel
  // pour tous les utilisateurs. Si un jour il redevenait une boucle, le compteur
  // de B4 le verrait tout de suite.
  if (s.includes('FROM USER_BETS') || s.includes('FROM BETS')) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      user_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      total: 10, won: 6, lost: 4, push: 0,
    }));
    return { rows, rowCount: rows.length };
  }

  if (s.includes('FROM REFRESH_TOKENS')) {
    return { rows: [], rowCount: 0 };
  }

  if (s.includes('FROM USER_PROFILES')) {
    return {
      rows: [{
        user_id: BENCH_USER.id, display_name: 'Bench', avatar: '👤', tier: 'rookie',
        performance_score: 0, is_public: true, joined_at: new Date(),
        total_bets: 0, wins: 0, losses: 0, roi: 0, bio: '', favorite_team: null,
        // Alias tels que les requêtes les nomment : `getPublicSlips` lit
        // `up.show_slips AS "showSlips"` et refuse 403 si la clé manque.
        showSlips: true, show_slips: true,
        isPublic: true, displayName: 'Bench', avatarUrl: null,
        // `applyXpDelta` lit ces deux-là après chaque règlement.
        xp: 0, tier: 'rookie',
      }],
      rowCount: 1,
    };
  }

  // Données manuelles (gardiens partants, absents) — la journée est vide.
  if (s.includes('MANUAL_')) return { rows: [], rowCount: 0 };

  // Écritures et tout le reste.
  return { rows: [], rowCount: 1 };
}

// ── Installation ────────────────────────────────────────────────────────────

let installed = false;

/**
 * Remplace `Pool.prototype.query` / `.connect` AVANT que `db/connection.ts`
 * n'instancie son pool. Le patch porte sur le prototype, donc il s'applique à
 * l'instance créée plus tard à l'import de l'application.
 */
export function install(): void {
  if (installed) return;
  installed = true;

  // `pg` est résolu depuis `server/` — ce fichier vit dans `loadtest/`, qui n'a
  // pas de `node_modules`. Le chemin résolu est le MÊME que celui qu'importe
  // `db/connection.ts`, donc le cache de modules de Node rend le même objet et
  // le patch de prototype porte bien sur le pool de l'application.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const serverDir = require('path').join(__dirname, '..', '..', 'server');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pg = require(require.resolve('pg', { paths: [serverDir] }));

  async function run(sql: any, params: any[] = []) {
    const text = typeof sql === 'string' ? sql : String(sql?.text ?? '');
    sqlCalls.push({ sql: text, at: Date.now() });
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    return resultFor(text, params);
  }

  pg.Pool.prototype.query = function (sql: any, params?: any) {
    return run(sql, Array.isArray(params) ? params : []);
  };

  pg.Pool.prototype.connect = async function () {
    return {
      query: (sql: any, params?: any) => run(sql, Array.isArray(params) ? params : []),
      release: () => {},
    };
  };

  pg.Pool.prototype.end = async function () {};
}
