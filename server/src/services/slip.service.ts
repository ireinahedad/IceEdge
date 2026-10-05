import { pool } from '../db/connection';
import { notifySlipPlaced } from './settlement.service';
import { fetchGameById } from './nhlApiClient';
import { mapLimit } from './concurrency';
import { logger } from '../logger';
import { profileAlreadyEnsured, markProfileEnsured } from './profileEnsured';

// ─── XP & Tier config ─────────────────────────────────────────────────────────

// Tier thresholds (minimum XP required)
const TIER_THRESHOLDS: Record<string, number> = {
  rookie:  0,
  analyst: 100,
  sharp:   500,
  legend:  1500,
};

// Ordered tiers lowest→highest
const TIER_ORDER = ['rookie', 'analyst', 'sharp', 'legend'] as const;
type Tier = typeof TIER_ORDER[number];

function tierForXp(xp: number): Tier {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    if (xp >= TIER_THRESHOLDS[TIER_ORDER[i]]) return TIER_ORDER[i];
  }
  return 'rookie';
}

/**
 * Risk-based XP.
 * Win : the riskier the bet (low probability), the more XP.
 *   P=80% → +40 XP · P=50% → +100 XP · P=15% → +170 XP
 * Loss : the safer the bet was, the more XP is lost.
 *   P=80% → −40 XP · P=50% → −25 XP · P=15% → −8 XP
 */
export function xpForOutcome(outcome: 'win' | 'loss', combinedProbability: number | null): number {
  const P = Math.max(1, Math.min(99, combinedProbability ?? 50));
  return outcome === 'win'
    ? Math.max(10, Math.round((100 - P) * 2))
    : -Math.max(5, Math.round(P / 2));
}

/**
 * Apply an XP delta (positive or negative) to a user.
 * XP is floored at 0. The tier is recomputed in both directions,
 * and a tier badge is awarded when the user moves up.
 */
export async function applyXpDelta(
  userId: string,
  delta: number,
): Promise<{ newXp: number; newTier: Tier; tieredUp: boolean }> {
  // Filet de création du profil — UNE FOIS par compte, pas à chaque règlement.
  //
  // C'est la TROISIÈME occurrence du même `INSERT … ON CONFLICT DO NOTHING`
  // inutile (après la connexion et la lecture de profil), et de loin la plus
  // coûteuse : elle partait une fois par TICKET RÉGLÉ. Mesuré par le banc
  // `loadtest/bench/b14-reglement.ts` le 2026-09-19 — 600 de ces écritures pour
  // 600 tickets, soit un quart des 4,01 requêtes SQL par règlement.
  //
  // Un soir de 2 000 tickets, c'est 2 000 allers-retours Neon et 2 000 places
  // prises dans un pool qui en compte dix, pour n'insérer aucune ligne — au
  // moment exact où la file doit se vider vite.
  //
  // La mémoire partagée (`profileEnsured.ts`) dit ce que le raccourci garantit
  // et ce qu'il ne garantit pas ; le `ON CONFLICT DO NOTHING` reste le filet
  // réel, et au pire on repaie une écriture inutile après un redémarrage.
  if (!profileAlreadyEnsured(userId)) {
    await pool.query(
      `INSERT INTO user_profiles (user_id, xp, tier, performance_score)
       SELECT id, 0, 'rookie', 0 FROM users WHERE id = $1
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    markProfileEnsured(userId);
  }

  const { rows: profileRows } = await pool.query<{ xp: number; tier: string }>(
    `SELECT xp, tier FROM user_profiles WHERE user_id = $1`,
    [userId],
  );
  const profile  = profileRows[0] ?? { xp: 0, tier: 'rookie' };
  const prevTier = (profile.tier ?? 'rookie') as Tier;
  const newXp    = Math.max(0, (profile.xp ?? 0) + delta);
  const newTier  = tierForXp(newXp);
  const tieredUp = TIER_ORDER.indexOf(newTier) > TIER_ORDER.indexOf(prevTier);

  await pool.query(
    `UPDATE user_profiles
     SET xp = $1, tier = $2, performance_score = $1
     WHERE user_id = $3`,
    [newXp, newTier, userId],
  );

  if (tieredUp) {
    const TIER_BADGES: Record<Tier, { label: string; icon: string; description: string }> = {
      analyst: { label: 'Analyst',      icon: '📊', description: 'Reached Analyst tier' },
      sharp:   { label: 'Sharp Bettor', icon: '🎯', description: 'Reached Sharp tier'   },
      legend:  { label: 'Legend',       icon: '👑', description: 'Reached Legend tier'  },
      rookie:  { label: 'Rookie',       icon: '🌱', description: 'Welcome!'             },
    };
    const badge = TIER_BADGES[newTier];
    await pool.query(
      `INSERT INTO user_badges (user_id, badge_id, label, description, icon, earned_at, tier)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6)
       ON CONFLICT (user_id, badge_id) DO NOTHING`,
      [userId, `tier_${newTier}`, badge.label, badge.description, badge.icon, newTier],
    );
  }

  return { newXp, newTier, tieredUp };
}

// ─── Submit slip ──────────────────────────────────────────────────────────────

export interface SlipLeg {
  marketType:   string;
  subjectId?:   string;
  subjectName:  string;
  subjectLogo:  string;
  selection?:   string;
  line?:        number;
  probability:  number;
  /** Prix AMÉRICAIN du livre au verrouillage ; absent si le livre ne cotait
   *  pas la jambe. Avant le 2026-09-30 : cote déduite du modèle. */
  oddsLabel?:   string;
  /** Prix DÉCIMAL du livre au verrouillage (depuis le 2026-09-30). */
  bookPrice?:   number;
  /** NHL game id — required for automatic settlement */
  gameId?:      string;
  /** Machine-readable selection (team id, 'over', 'under'…) */
  selectionValue?: string;
}

/** Bornes de la résolution du verrou. Voir `resolveLocksAt` juste en dessous. */
const LOCKS_AT_BUDGET_MS   = 6_000;
const LOCKS_AT_CONCURRENCY = 6;

/**
 * Heure de verrouillage d'un coupon = mise au jeu de son match le plus TÔT.
 *
 * Un parlay se déverrouille dès que son premier match commence : à partir de là
 * le contenu du ticket n'a plus de valeur pour un copieur, et le masquer plus
 * longtemps ne protégerait plus rien.
 *
 * Résolu ICI, au serveur, et figé en base — jamais accepté du client, qui
 * s'offrirait le déverrouillage instantané en éditant une requête, et jamais
 * recalculé à la lecture, qui coûterait un appel NHL par affichage de page.
 *
 * Renvoie `null` si aucune heure n'est exploitable (pas de `gameId`, pari
 * futures, API indisponible). Le NULL n'est pas « pas de verrou » : la lecture
 * le traite comme « masqué tant que le coupon est pending ». Une panne de
 * résolution doit rendre un coupon trop discret, pas le divulguer trop tôt.
 *
 * ⚠️ CE BLOC A ÉTÉ LA CAUSE D'UN COUPON DE 3 JAMBES IMPOSSIBLE À VERROUILLER
 * (2026-09-14). Il bouclait en SÉQUENTIEL sur les matchs distincts, et
 * `fetchGameById` non mis en cache attend jusqu'à `NHL_TIMEOUT_MS` (8 s) :
 *
 *   1 match  → ≤  8 s  · sous le délai client de 15 s (`http.ts`) ;
 *   2 matchs → ≤ 16 s  · déjà à la limite ;
 *   3 matchs → ≤ 24 s  · le client abandonne TOUJOURS avant la réponse.
 *
 * Le symptôme ne ressemblait pas à sa cause : le bouton « Verrouiller » partait
 * en « Envoi… » et revenait sans rien dire (l'erreur était avalée côté client,
 * voir `BetBuilderPage.tsx`), et le coupon, lui, finissait parfois par être
 * inséré — donc « ça ne marche pas au-delà de 2 paris ».
 *
 * Deux verrous pour que ça ne puisse plus arriver :
 *   - parallélisme BORNÉ (`mapLimit`, 6 de front) plutôt qu'une boucle : un
 *     coupon de 12 matchs coûte désormais deux vagues, pas douze ;
 *   - un BUDGET global. Passé ce délai, on insère avec ce qu'on a. L'insertion
 *     du pari ne doit jamais être l'otage d'une API tierce lente.
 *
 * Résoudre une PARTIE des matchs reste sûr : le minimum d'un sous-ensemble est
 * ≥ le vrai minimum, donc le coupon se dévoile plus TARD, jamais plus tôt —
 * le même sens que le `null`.
 *
 * ── Matchs déjà commencés (2026-09-28) ─────────────────────────────────────
 *
 * La même lecture dit aussi quels matchs ont COMMENCÉ, et `submitSlip` refuse
 * alors le coupon. Sans ça, une jambe posée en plein match gardait sa
 * probabilité d'AVANT-match : « MTL gagne » à 40 % quand MTL mène 4-0 en 3e
 * rapportait (100 − 40) × 2 = 120 XP presque à coup sûr (`xpForOutcome`).
 * Décision du user : pas de pari en direct, et le refus vit ICI, au serveur,
 * pour fermer aussi les autres chemins (page du match, requête forgée).
 *
 * « Commencé » = heure de mise au jeu PRÉVUE atteinte, ou statut live/final.
 * L'heure prévue et non le vrai coup d'envoi (quelques minutes plus tard) :
 * c'est déjà l'instant où `locks_at` dévoile le coupon, les deux règles
 * parlent donc du même moment.
 *
 * ⚠️ Ouvert en cas de panne, À DESSEIN : un match non résolu dans le budget
 * n'est pas refusé — même principe que plus haut, l'insertion n'est pas
 * l'otage de l'API NHL. La fenêtre qui reste (API NHL en panne pendant un
 * match) est étroite ; la fermer bloquerait tous les coupons pendant la panne.
 */
function gameHasStarted(game: any, now: number): boolean {
  const status = String(game?.status ?? '').toLowerCase();
  if (status === 'live' || status === 'final') return true;
  const ms = game?.startTimeUTC ? new Date(game.startTimeUTC).getTime() : NaN;
  return Number.isFinite(ms) && ms <= now;
}

async function resolveLocksAt(legs: SlipLeg[]): Promise<{ locksAt: Date | null; startedGameIds: string[] }> {
  const gameIds = [...new Set(legs.map((l) => l.gameId).filter(Boolean) as string[])];
  if (!gameIds.length) return { locksAt: null, startedGameIds: [] };
  const now = Date.now();
  const startedGameIds: string[] = [];

  // Objet plutôt que deux `let` : l'analyse de flot de TypeScript réduirait un
  // `let earliest: number | null = null` à `null` après la déclaration, sans
  // savoir que la fermeture ci-dessous y écrit — et `new Date(earliest)` ne
  // compilerait plus. Une propriété, elle, est « dé-narrowée » par tout appel.
  const acc: { earliest: number | null; resolved: number } = { earliest: null, resolved: 0 };

  const work = mapLimit(gameIds, LOCKS_AT_CONCURRENCY, async (id) => {
    try {
      const game = await fetchGameById(id);
      if (gameHasStarted(game, now)) startedGameIds.push(id);
      const ms = game?.startTimeUTC ? new Date(game.startTimeUTC).getTime() : NaN;
      if (Number.isFinite(ms)) {
        acc.resolved++;
        acc.earliest = acc.earliest == null ? ms : Math.min(acc.earliest, ms);
      }
    } catch {
      // Un match non résolu ne doit pas faire échouer la soumission : le pari
      // de l'utilisateur passe avant l'exactitude du verrou.
    }
  // `fn` n'échoue jamais (tout est attrapé au-dessus) ; ce `catch` n'est là que
  // pour qu'un rejet imprévu, perdu par la course ci-dessous, ne remonte pas en
  // `unhandledRejection` et ne tue pas le process.
  }).catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((r) => { timer = setTimeout(r, LOCKS_AT_BUDGET_MS); });
  try {
    await Promise.race([work, budget]);
  } finally {
    // Sans ça, le minuteur retient la boucle d'événements jusqu'à son terme
    // alors que la réponse est déjà partie.
    if (timer) clearTimeout(timer);
  }

  if (acc.earliest == null) {
    logger.warn({ gameIds }, '[slip] locks_at non résolu — le coupon restera masqué aux tiers jusqu\'à son règlement');
    return { locksAt: null, startedGameIds };
  }
  if (acc.resolved < gameIds.length) {
    logger.warn(
      { gameIds, resolved: acc.resolved, budgetMs: LOCKS_AT_BUDGET_MS },
      '[slip] locks_at partiel — verrou calculé sur les matchs résolus dans le budget (donc au plus tard, jamais au plus tôt)',
    );
  }
  return { locksAt: new Date(acc.earliest), startedGameIds };
}

export async function submitSlip(
  userId:              string,
  legs:                SlipLeg[],
  sport:               string = 'hockey',
  combinedProbability: number | null = null,
) {
  if (!legs.length) throw Object.assign(new Error('Slip must have at least one leg'), { status: 400 });
  if (legs.length > 12) throw Object.assign(new Error('Max 12 legs per slip'), { status: 400 });

  const isParlay = legs.length > 1;

  // ⚠️⚠️ `bet_slips.combined_probability` est un **INT** (migration 003) et `pg`
  // envoie le paramètre TEL QUEL, en texte : Postgres refuse « 37.7 » sur une
  // colonne integer (22P02) et la soumission repart en 500 côté client.
  // Depuis que la probabilité combinée est calculée localement par
  // `parlay.ts` côté client (2026-09-13), le client arrondit à UNE DÉCIMALE : tout
  // coupon de deux jambes ou plus cassait donc l'insertion.
  //
  // L'arrondi est fait ICI et pas côté client à dessein : un bundle déjà
  // déployé, un vieux build iOS ou n'importe quel autre appelant continueraient
  // sinon à faire tomber la route. Ne pas « simplifier » en supprimant cet
  // arrondi sous prétexte que le client envoie un entier.
  //
  // Le repli `null` (colonne nullable) couvre une jambe sans `probability`
  // exploitable : `NaN` partirait sinon dans la même erreur 22P02.
  // `xpForOutcome` traite déjà le `null` (→ 50 %).
  const rawCombined =
    combinedProbability ??
    legs.reduce((acc, l) => acc * (l.probability / 100), 1) * 100;
  const combined = Number.isFinite(rawCombined) ? Math.round(rawCombined) : null;

  const { locksAt, startedGameIds } = await resolveLocksAt(legs);

  // Pas de pari sur un match commencé — voir l'en-tête de `resolveLocksAt`.
  // `code` traverse `sendError` : le client le traduit (`slip.gameStarted`).
  if (startedGameIds.length) {
    const started = new Set(startedGameIds);
    const names = legs
      .filter((l) => l.gameId && started.has(l.gameId))
      .map((l) => l.selection ?? l.marketType);
    throw Object.assign(
      new Error(`Game already started: ${names.join(', ')}`),
      { status: 409, code: 'GAME_STARTED' },
    );
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bet_slips
       (user_id, sport, legs, leg_count, is_parlay, combined_probability, outcome, locks_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'pending', $7)
     RETURNING id`,
    [userId, sport, JSON.stringify(legs), legs.length, isParlay, combined, locksAt],
  );

  // Wake the settlement scheduler so it re-plans its wake horizon around this
  // bet's game(s) instead of waiting out a long idle sleep.
  notifySlipPlaced();

  return rows[0].id;
}

// ─── List slips for a user ────────────────────────────────────────────────────

export async function getSlips(userId: string, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", sport,
            legs, leg_count AS "legCount", is_parlay AS "isParlay",
            combined_probability AS "combinedProbability",
            outcome, resolved_at AS "resolvedAt", xp_awarded AS "xpAwarded"
     FROM bet_slips
     WHERE user_id = $1
     ORDER BY placed_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// ─── Resolve slip (win | loss) + award XP ────────────────────────────────────

export async function resolveSlip(
  slipId:  string,
  outcome: 'win' | 'loss',
  userId:  string,
): Promise<{ xpAwarded: number; newXp: number; newTier: Tier; tieredUp: boolean }> {
  // Load the slip
  const { rows: slipRows } = await pool.query(
    `SELECT id, user_id, is_parlay, leg_count, outcome,
            combined_probability AS "combinedProbability"
     FROM bet_slips
     WHERE id = $1`,
    [slipId],
  );
  const slip = slipRows[0];
  if (!slip) throw Object.assign(new Error('Slip not found'), { status: 404 });
  if (slip.user_id !== userId) throw Object.assign(new Error('Forbidden'), { status: 403 });
  if (slip.outcome !== 'pending') throw Object.assign(new Error('Slip already resolved'), { status: 400 });

  // Risk-based XP: wins earn more when the bet was risky,
  // losses cost more when the bet was "safe".
  const xpAwarded = xpForOutcome(outcome, slip.combinedProbability);

  // Update slip (guard: only if still pending — avoids double-award races)
  const upd = await pool.query(
    `UPDATE bet_slips
     SET outcome = $1, resolved_at = NOW(), xp_awarded = $2
     WHERE id = $3 AND outcome = 'pending'`,
    [outcome, xpAwarded, slipId],
  );
  if (!upd.rowCount) throw Object.assign(new Error('Slip already resolved'), { status: 400 });

  const { newXp, newTier, tieredUp } = await applyXpDelta(userId, xpAwarded);

  return { xpAwarded, newXp, newTier, tieredUp };
}

// ─── Cancel a pending slip ────────────────────────────────────────────────────

/**
 * Annuler un pari EN COURS (décision du user, 2026-10-05).
 *
 * ⚠️ Seulement AVANT la mise au jeu du premier match du coupon. Sans cette
 * borne, on annulerait un pari en train de perdre (MTL mené 0-4 en 3e) pour
 * échapper à la perte d'XP de `xpForOutcome` — le pendant exact de la règle
 * « pas de pari en direct » de `submitSlip`.
 *
 * Le coupon est SUPPRIMÉ, pas marqué : un pari annulé avant tout match n'a
 * jamais compté (aucun XP, rien à régler). Aucune table ne référence
 * `bet_slips` ; une carte déjà envoyée dans un salon garde son instantané
 * (migration 036).
 *
 * Fermé en cas de doute, à l'inverse de `submitSlip` : si l'heure du premier
 * match est inconnue et que l'API NHL ne répond pas, on refuse — une
 * annulation refusée se retente, une annulation abusive ne se défait pas.
 */
export async function cancelSlip(slipId: string, userId: string): Promise<void> {
  const { rows } = await pool.query<{ outcome: string; legs: SlipLeg[]; locks_at: Date | null }>(
    `SELECT outcome, legs, locks_at FROM bet_slips WHERE id = $1 AND user_id = $2`,
    [slipId, userId],
  );
  const slip = rows[0];
  if (!slip) throw Object.assign(new Error('Slip not found'), { status: 404 });
  if (slip.outcome !== 'pending') {
    throw Object.assign(new Error('Only pending slips can be cancelled'), { status: 409, code: 'NOT_PENDING' });
  }

  const legs = Array.isArray(slip.legs) ? slip.legs : [];
  // Une sélection déjà décidée = un match joué : trop tard.
  if (legs.some((l: any) => l?.result)) {
    throw Object.assign(new Error('A game in this slip has already started'), { status: 409, code: 'GAME_STARTED' });
  }

  if (slip.locks_at && new Date(slip.locks_at).getTime() <= Date.now()) {
    throw Object.assign(new Error('A game in this slip has already started'), { status: 409, code: 'GAME_STARTED' });
  }
  // Re-vérifier auprès de l'API NHL : l'heure enregistrée peut manquer, ou un
  // match peut avoir été avancé depuis le verrouillage.
  const { locksAt, startedGameIds } = await resolveLocksAt(legs);
  if (startedGameIds.length || (locksAt && locksAt.getTime() <= Date.now())) {
    throw Object.assign(new Error('A game in this slip has already started'), { status: 409, code: 'GAME_STARTED' });
  }
  if (!slip.locks_at && !locksAt && legs.some((l) => l.gameId)) {
    throw Object.assign(new Error('Could not verify game start times — try again'), { status: 503, code: 'UNVERIFIED' });
  }

  // Garde `outcome = 'pending'` : le règlement a pu passer entre-temps.
  const del = await pool.query(
    `DELETE FROM bet_slips WHERE id = $1 AND user_id = $2 AND outcome = 'pending'`,
    [slipId, userId],
  );
  if (!del.rowCount) {
    throw Object.assign(new Error('Only pending slips can be cancelled'), { status: 409, code: 'NOT_PENDING' });
  }
}

// ─── Get a single slip ────────────────────────────────────────────────────────

export async function getSlip(slipId: string, userId: string) {
  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", sport,
            legs, leg_count AS "legCount", is_parlay AS "isParlay",
            combined_probability AS "combinedProbability",
            outcome, resolved_at AS "resolvedAt", xp_awarded AS "xpAwarded"
     FROM bet_slips
     WHERE id = $1 AND user_id = $2`,
    [slipId, userId],
  );
  if (!rows[0]) throw Object.assign(new Error('Slip not found'), { status: 404 });
  return rows[0];
}
