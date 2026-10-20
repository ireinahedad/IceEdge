/**
 * seed-community.ts — crée 10 membres ArakIce avec un historique complet.
 *
 *   npm run seed:community              → crée les membres absents
 *   npm run seed:community -- --dry-run → affiche les stats, n'écrit rien
 *   npm run seed:community -- --reset   → supprime ces 10 membres puis les recrée
 *
 * Chaque membre reçoit :
 *   - un compte `users` (email vérifié, date d'inscription étalée sur la saison)
 *   - un profil `user_profiles` (nom affiché, avatar, équipe favorite, bio)
 *   - des coupons `bet_slips` RÉGLÉS (win/loss) répartis sur les fenêtres de
 *     saison NHL, avec des jambes réalistes (vraies équipes, vrais joueurs)
 *   - l'XP et le tier recalculés exactement comme `settlement.service.ts`
 *     (`xpForOutcome` + plancher à 0 + seuils de tier), et les badges de tier
 *     datés du jour où le seuil a été franchi.
 *
 * Aucun coupon n'est laissé `pending` et aucune jambe ne porte de `gameId` :
 * le job de règlement et `purge-stale-slips` ne les toucheront jamais.
 *
 * Mot de passe : si COMMUNITY_PASSWORD est défini, les 10 comptes l'utilisent
 * (pratique pour se connecter en tant que l'un d'eux). Sinon, un mot de passe
 * aléatoire jamais affiché est utilisé.
 *
 * Génération déterministe (PRNG à graine fixe) : relancer avec --reset
 * redonne exactement les mêmes historiques.
 */
import 'dotenv/config';
import { randomBytes } from 'crypto';
import { pool } from '../src/db/connection';

/** Copie exacte de `xpForOutcome` (slip.service.ts) — importer le service
 *  entraînerait settlement.service et ses dépendances. */
function xpForOutcome(outcome: 'win' | 'loss', combinedProbability: number | null): number {
  const P = Math.max(1, Math.min(99, combinedProbability ?? 50));
  return outcome === 'win'
    ? Math.max(10, Math.round((100 - P) * 2))
    : -Math.max(5, Math.round(P / 2));
}

const DRY_RUN = process.argv.includes('--dry-run');
const RESET   = process.argv.includes('--reset');

// ─── Membres ────────────────────────────────────────────────────────────────

interface Member {
  username:    string;   // identifiant de connexion (minuscules, règle de l'app)
  displayName: string;   // nom affiché, tel que donné
  avatar:      string;
  team:        string;
  bio:         string;
  joined:      string;   // YYYY-MM-DD
  slips:       number;   // nombre de coupons
  hitRate:     number;   // taux de réussite visé
  parlayShare: number;   // part de parlays
  favMarkets:  string[]; // marchés de prédilection (plus fréquents)
}

const MEMBERS: Member[] = [
  { username: 'cestmimiquideadca', displayName: 'cestmimiquideadca', avatar: '🇨🇦', team: 'MTL',
    bio: 'Les props de joueurs, c\'est ma spécialité. Go Habs go 🔵⚪🔴',
    joined: '2025-10-12', slips: 184, hitRate: 0.68, parlayShare: 0.30, favMarkets: ['shots_ou', 'anytime_goal'] },
  { username: 'ricky', displayName: 'Ricky', avatar: '🇨🇦', team: 'TOR',
    bio: 'Moneyline & puck line. I follow the model, not my heart.',
    joined: '2025-10-24', slips: 152, hitRate: 0.64, parlayShare: 0.25, favMarkets: ['moneyline', 'puck_line'] },
  { username: 'abcdefg', displayName: 'ABCDEFG', avatar: '🧠', team: 'COL',
    bio: 'Low volume, high conviction. Only value bets.',
    joined: '2025-11-29', slips: 96, hitRate: 0.71, parlayShare: 0.10, favMarkets: ['moneyline', 'total_goals'] },
  { username: 'jamal', displayName: 'Jamal', avatar: '🏆', team: 'EDM',
    bio: 'McDavid + Draisaitl props every night. Oilers forever 🛢️',
    joined: '2025-10-08', slips: 213, hitRate: 0.62, parlayShare: 0.40, favMarkets: ['anytime_goal', 'assists_ou'] },
  { username: 'theo', displayName: 'Theo', avatar: '🇺🇸', team: 'BOS',
    bio: 'Totals guy. Goalie matchups tell you everything.',
    joined: '2025-12-13', slips: 131, hitRate: 0.66, parlayShare: 0.20, favMarkets: ['total_goals', 'moneyline'] },
  { username: 'xfine', displayName: 'XFine', avatar: '😎', team: 'VGK',
    bio: 'Parlays 2-3 legs max. Discipline > chance.',
    joined: '2026-01-08', slips: 167, hitRate: 0.60, parlayShare: 0.55, favMarkets: ['moneyline', 'shots_ou'] },
  { username: 'fatima', displayName: 'Fatima', avatar: '⭐', team: 'FLA',
    bio: 'Data first. Shots on goal props are the most underpriced market.',
    joined: '2025-11-02', slips: 122, hitRate: 0.69, parlayShare: 0.15, favMarkets: ['shots_ou', 'puck_line'] },
  { username: 'seb', displayName: 'Seb', avatar: '🇨🇦', team: 'MTL',
    bio: 'Montréal 🇨🇦 | Je joue les unders quand les gardiens sont chauds.',
    joined: '2025-10-18', slips: 143, hitRate: 0.63, parlayShare: 0.25, favMarkets: ['total_goals', 'anytime_goal'] },
  { username: 'phil', displayName: 'Phil', avatar: '🇺🇸', team: 'NYR',
    bio: 'Rangers fan. Picky with my bets, patient with my bankroll.',
    joined: '2026-02-20', slips: 78, hitRate: 0.65, parlayShare: 0.20, favMarkets: ['moneyline', 'assists_ou'] },
  { username: 'frenchmontana', displayName: 'frenchmontana', avatar: '💰', team: 'NJD',
    bio: 'Haan! Parlays du soir, props du matin.',
    joined: '2025-11-16', slips: 191, hitRate: 0.61, parlayShare: 0.45, favMarkets: ['anytime_goal', 'moneyline'] },
];

// ─── Données NHL ────────────────────────────────────────────────────────────

const TEAMS: Record<string, { name: string; emoji: string }> = {
  BOS: { name: 'Boston Bruins',         emoji: '🐻' },
  TOR: { name: 'Toronto Maple Leafs',   emoji: '🍁' },
  MTL: { name: 'Montreal Canadiens',    emoji: '🔵' },
  NYR: { name: 'New York Rangers',      emoji: '🗽' },
  NJD: { name: 'New Jersey Devils',     emoji: '😈' },
  FLA: { name: 'Florida Panthers',      emoji: '🐆' },
  TBL: { name: 'Tampa Bay Lightning',   emoji: '⚡' },
  DET: { name: 'Detroit Red Wings',     emoji: '🏒' },
  OTT: { name: 'Ottawa Senators',       emoji: '🛡️' },
  CAR: { name: 'Carolina Hurricanes',   emoji: '🌀' },
  CHI: { name: 'Chicago Blackhawks',    emoji: '🦅' },
  COL: { name: 'Colorado Avalanche',    emoji: '🏔️' },
  DAL: { name: 'Dallas Stars',          emoji: '⭐' },
  MIN: { name: 'Minnesota Wild',        emoji: '🌲' },
  WPG: { name: 'Winnipeg Jets',         emoji: '✈️' },
  EDM: { name: 'Edmonton Oilers',       emoji: '🛢️' },
  VGK: { name: 'Vegas Golden Knights',  emoji: '⚔️' },
  LAK: { name: 'Los Angeles Kings',     emoji: '👑' },
  VAN: { name: 'Vancouver Canucks',     emoji: '🐳' },
  SJS: { name: 'San Jose Sharks',       emoji: '🦈' },
};
const TEAM_CODES = Object.keys(TEAMS);

const PLAYERS: { name: string; team: string; shots: number; star: number }[] = [
  { name: 'Connor McDavid',    team: 'EDM', shots: 3.5, star: 1.0 },
  { name: 'Leon Draisaitl',    team: 'EDM', shots: 3.5, star: 0.95 },
  { name: 'Nathan MacKinnon',  team: 'COL', shots: 4.5, star: 1.0 },
  { name: 'Cale Makar',        team: 'COL', shots: 3.5, star: 0.85 },
  { name: 'David Pastrnak',    team: 'BOS', shots: 4.5, star: 0.95 },
  { name: 'Auston Matthews',   team: 'TOR', shots: 4.5, star: 0.95 },
  { name: 'William Nylander',  team: 'TOR', shots: 3.5, star: 0.8 },
  { name: 'Nikita Kucherov',   team: 'TBL', shots: 3.5, star: 0.95 },
  { name: 'Brayden Point',     team: 'TBL', shots: 2.5, star: 0.8 },
  { name: 'Matthew Tkachuk',   team: 'FLA', shots: 3.5, star: 0.85 },
  { name: 'Sam Reinhart',      team: 'FLA', shots: 2.5, star: 0.85 },
  { name: 'Nick Suzuki',       team: 'MTL', shots: 2.5, star: 0.75 },
  { name: 'Cole Caufield',     team: 'MTL', shots: 3.5, star: 0.8 },
  { name: 'Lane Hutson',       team: 'MTL', shots: 1.5, star: 0.7 },
  { name: 'Artemi Panarin',    team: 'NYR', shots: 3.5, star: 0.85 },
  { name: 'Jack Hughes',       team: 'NJD', shots: 3.5, star: 0.85 },
  { name: 'Jack Eichel',       team: 'VGK', shots: 3.5, star: 0.85 },
  { name: 'Mitch Marner',      team: 'VGK', shots: 2.5, star: 0.8 },
  { name: 'Mikko Rantanen',    team: 'DAL', shots: 3.5, star: 0.85 },
  { name: 'Jason Robertson',   team: 'DAL', shots: 3.5, star: 0.8 },
  { name: 'Kirill Kaprizov',   team: 'MIN', shots: 3.5, star: 0.9 },
  { name: 'Kyle Connor',       team: 'WPG', shots: 3.5, star: 0.8 },
  { name: 'Macklin Celebrini', team: 'SJS', shots: 3.5, star: 0.8 },
  { name: 'Connor Bedard',     team: 'CHI', shots: 3.5, star: 0.8 },
  { name: 'Dylan Larkin',      team: 'DET', shots: 3.5, star: 0.75 },
  { name: 'Brady Tkachuk',     team: 'OTT', shots: 4.5, star: 0.8 },
  { name: 'Sebastian Aho',     team: 'CAR', shots: 2.5, star: 0.75 },
  { name: 'Quinn Hughes',      team: 'VAN', shots: 2.5, star: 0.8 },
  { name: 'Adrian Kempe',      team: 'LAK', shots: 3.5, star: 0.7 },
];

const MARKETS = ['moneyline', 'puck_line', 'total_goals', 'shots_ou', 'anytime_goal', 'assists_ou'];

/** Fenêtres où des matchs NHL ont lieu (saison 25-26 + séries + début 26-27). */
const WINDOWS: [string, string][] = [
  ['2025-10-07', '2026-02-05'],   // saison régulière, avant la pause olympique
  ['2026-02-25', '2026-04-16'],   // saison régulière, après la pause
  ['2026-04-18', '2026-06-20'],   // séries éliminatoires
  ['2026-10-07', '2026-10-19'],   // saison 2026-27
];

// ─── PRNG déterministe ──────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

type Rng = () => number;
const pick  = <T>(r: Rng, a: T[]): T => a[Math.floor(r() * a.length)];
const range = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
const int   = (r: Rng, lo: number, hi: number) => Math.floor(range(r, lo, hi + 1));

// ─── Cotes ──────────────────────────────────────────────────────────────────

/** Probabilité (%) → cote américaine avec ~4,5 % de marge du livre. */
function americanFor(probPct: number): { label: string; decimal: number } {
  const implied = Math.min(0.95, (probPct / 100) * 1.045);
  const decimal = Math.round((1 / implied) * 100) / 100;
  const american = implied >= 0.5
    ? -Math.round((implied / (1 - implied)) * 100)
    : Math.round(((1 - implied) / implied) * 100);
  const rounded = Math.round(american / 5) * 5;
  return { label: rounded > 0 ? `+${rounded}` : String(rounded), decimal };
}

// ─── Génération d'une jambe ─────────────────────────────────────────────────

function opponentOf(r: Rng, team: string): string {
  let o = team;
  while (o === team) o = pick(r, TEAM_CODES);
  return o;
}

function makeLeg(r: Rng, market: string, favTeam: string) {
  // Un membre joue son équipe favorite un peu plus souvent.
  const team = r() < 0.2 ? favTeam : pick(r, TEAM_CODES);
  const opp  = opponentOf(r, team);
  let leg: any;

  switch (market) {
    case 'moneyline': {
      const p = int(r, 42, 72);
      leg = { subjectName: TEAMS[team].name, subjectLogo: TEAMS[team].emoji,
              selection: `${team} ML`, selectionValue: team, probability: p,
              matchup: `${team} vs ${opp}` };
      break;
    }
    case 'puck_line': {
      const fav = r() < 0.5;
      const p = fav ? int(r, 33, 48) : int(r, 62, 76);
      const line = fav ? -1.5 : 1.5;
      leg = { subjectName: TEAMS[team].name, subjectLogo: TEAMS[team].emoji,
              selection: `${team} ${line > 0 ? '+' : ''}${line}`, line, selectionValue: team,
              probability: p, matchup: `${team} vs ${opp}` };
      break;
    }
    case 'total_goals': {
      const line = pick(r, [5.5, 5.5, 6.5, 6.5, 6.0]);
      const over = r() < 0.5;
      const p = int(r, 46, 62);
      leg = { subjectName: `${team} vs ${opp}`, subjectLogo: '🥅',
              selection: `${over ? 'Over' : 'Under'} ${line}`, line,
              selectionValue: over ? 'over' : 'under', probability: p };
      break;
    }
    case 'shots_ou': {
      const pl = pick(r, PLAYERS);
      const over = r() < 0.75;
      const p = int(r, 48, 68);
      leg = { subjectName: pl.name, subjectLogo: TEAMS[pl.team]?.emoji ?? '🏒',
              selection: `${over ? 'Over' : 'Under'} ${pl.shots} SOG`, line: pl.shots,
              selectionValue: over ? 'over' : 'under', probability: p };
      break;
    }
    case 'anytime_goal': {
      const pl = pick(r, PLAYERS);
      const p = Math.round(range(r, 28, 46) * pl.star + 4);
      leg = { subjectName: pl.name, subjectLogo: TEAMS[pl.team]?.emoji ?? '🏒',
              selection: `${pl.name.split(' ').slice(-1)[0]} to score`,
              selectionValue: 'yes', probability: p };
      break;
    }
    case 'assists_ou': {
      const pl = pick(r, PLAYERS);
      const p = int(r, 45, 64);
      leg = { subjectName: pl.name, subjectLogo: TEAMS[pl.team]?.emoji ?? '🏒',
              selection: 'Over 0.5 assists', line: 0.5,
              selectionValue: 'over', probability: p };
      break;
    }
  }

  const odds = americanFor(leg.probability);
  return { marketType: market, ...leg, oddsLabel: odds.label, bookPrice: odds.decimal };
}

// ─── Dates ──────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

function bettingDays(joined: string): number[] {
  const start = Date.parse(`${joined}T00:00:00Z`);
  const days: number[] = [];
  for (const [a, b] of WINDOWS) {
    for (let t = Math.max(Date.parse(`${a}T00:00:00Z`), start); t <= Date.parse(`${b}T00:00:00Z`); t += DAY) {
      days.push(t);
    }
  }
  return days;
}

/** Heure de dépôt : en soirée heure de l'Est (≈ 21h-00h UTC), avant la mise au jeu. */
function placedAtOn(r: Rng, day: number): Date {
  const minutes = int(r, 20 * 60, 23 * 60 + 40);
  return new Date(day + minutes * 60_000);
}

// ─── Simulation d'un membre ─────────────────────────────────────────────────

const TIER_THRESHOLDS: [string, number][] = [['legend', 1500], ['sharp', 500], ['analyst', 100], ['rookie', 0]];
const tierFor = (xp: number) => TIER_THRESHOLDS.find(([, min]) => xp >= min)![0];

const TIER_BADGES: Record<string, { label: string; icon: string; description: string }> = {
  analyst: { label: 'Analyst',      icon: '📊', description: 'Reached Analyst tier' },
  sharp:   { label: 'Sharp Bettor', icon: '🎯', description: 'Reached Sharp tier'   },
  legend:  { label: 'Legend',       icon: '👑', description: 'Reached Legend tier'  },
};

function simulate(m: Member) {
  const r = mulberry32(seedOf(m.username));
  const days = bettingDays(m.joined);

  // Jours de jeu tirés au hasard (avec répétition possible : 2 coupons un soir).
  const placed = Array.from({ length: m.slips }, () => placedAtOn(r, pick(r, days)))
    .sort((a, b) => a.getTime() - b.getTime());

  // Les membres actifs cette saison : on force quelques coupons en octobre 2026.
  const recentDays = bettingDays('2026-10-07');
  for (let i = 0; i < Math.min(6, Math.round(m.slips / 25)); i++) {
    placed[placed.length - 1 - i] = placedAtOn(r, pick(r, recentDays));
  }
  placed.sort((a, b) => a.getTime() - b.getTime());

  // Nombre EXACT de victoires = taux visé. Les victoires vont de préférence aux
  // simples (un parlay gagne moins souvent), sans exclusivité.
  const parlayFlags = placed.map(() => r() < m.parlayShare);
  const targetWins  = Math.round(m.hitRate * placed.length);
  const winSet = new Set(
    parlayFlags
      .map((isParlay, i) => ({ i, score: r() + (isParlay ? 0.25 : 0) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, targetWins)
      .map((x) => x.i),
  );

  let xp = 0;
  let tier = 'rookie';
  const badges: { badgeId: string; earnedAt: string; tier: string }[] = [];
  const slips: any[] = [];

  for (const [idx, at] of placed.entries()) {
    const isParlay = parlayFlags[idx];
    const legCount = isParlay ? (r() < 0.7 ? 2 : 3) : 1;

    const legs = Array.from({ length: legCount }, () => {
      const market = r() < 0.55 ? pick(r, m.favMarkets) : pick(r, MARKETS);
      const leg = makeLeg(r, market, m.team);
      // Dans un parlay, on garde des jambes plutôt sûres (comme un vrai parieur).
      if (isParlay && leg.probability < 50) {
        leg.probability = int(r, 55, 72);
        const o = americanFor(leg.probability);
        leg.oddsLabel = o.label; leg.bookPrice = o.decimal;
      }
      return leg;
    });

    const combined = Math.round(legs.reduce((p, l) => p * (l.probability / 100), 1) * 100);

    const outcome: 'win' | 'loss' = winSet.has(idx) ? 'win' : 'loss';

    // Résultat par jambe : tout gagné si le coupon gagne, au moins une perdante sinon.
    const losingLeg = int(r, 0, legCount - 1);
    const settledLegs = legs.map((l, i) => {
      const { matchup, ...rest } = l;
      const result = outcome === 'win' ? 'win' : (i === losingLeg || r() < 0.35 ? 'loss' : 'win');
      return { ...rest, result };
    });

    const xpDelta = xpForOutcome(outcome, combined);
    xp = Math.max(0, xp + xpDelta);
    const newTier = tierFor(xp);
    const order = ['rookie', 'analyst', 'sharp', 'legend'];
    const resolvedAt = new Date(at.getTime() + int(r, 150, 260) * 60_000);
    if (order.indexOf(newTier) > order.indexOf(tier)) {
      // Badge pour chaque palier franchi (un gros gain peut en sauter un).
      for (let k = order.indexOf(tier) + 1; k <= order.indexOf(newTier); k++) {
        badges.push({ badgeId: `tier_${order[k]}`, earnedAt: resolvedAt.toISOString().slice(0, 10), tier: order[k] });
      }
    }
    tier = newTier;

    slips.push({
      placedAt: at,
      locksAt: new Date(at.getTime() + int(r, 10, 90) * 60_000),
      resolvedAt,
      legs: settledLegs,
      legCount,
      isParlay,
      combined,
      outcome,
      xpAwarded: xpDelta,
    });
  }

  // Badge « Early Adopter » pour ceux inscrits le premier mois.
  if (m.joined < '2025-11-07') {
    badges.push({ badgeId: 'early_adopter', earnedAt: m.joined, tier: 'platinum' });
  }

  const wins = slips.filter((s) => s.outcome === 'win').length;
  return { slips, xp, tier, badges, wins, hitRate: Math.round((wins / slips.length) * 1000) / 10 };
}

// ─── Écriture ───────────────────────────────────────────────────────────────

async function main() {
  const sims = MEMBERS.map((m) => ({ m, sim: simulate(m) }));

  console.table(sims.map(({ m, sim }) => ({
    membre:   m.displayName,
    coupons:  sim.slips.length,
    victoires: sim.wins,
    'réussite %': sim.hitRate,
    xp:       sim.xp,
    tier:     sim.tier,
    inscrit:  m.joined,
  })));

  if (DRY_RUN) {
    console.log('--dry-run : rien n\'a été écrit.');
    return;
  }

  const password = process.env.COMMUNITY_PASSWORD || randomBytes(24).toString('base64url');
  // Import dynamique : le --dry-run n'a pas besoin du module natif bcrypt.
  const { hash: bcryptHash } = await import('@node-rs/bcrypt');
  const passwordHash = await bcryptHash(password, 11);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (RESET) {
      const del = await client.query(
        `DELETE FROM users WHERE username = ANY($1::text[])`,
        [MEMBERS.map((m) => m.username)],
      );
      console.log(`--reset : ${del.rowCount} membre(s) supprimé(s) (cascade sur profils, coupons, badges).`);
    }

    let created = 0;
    for (const { m, sim } of sims) {
      const exists = await client.query('SELECT 1 FROM users WHERE username = $1', [m.username]);
      if (exists.rowCount) {
        console.log(`• ${m.displayName} existe déjà — ignoré (utilise --reset pour recréer).`);
        continue;
      }

      const joinedAt = new Date(`${m.joined}T${String(int(mulberry32(seedOf(m.joined)), 13, 23)).padStart(2, '0')}:14:00Z`);
      const { rows } = await client.query(
        `INSERT INTO users (email, username, password_hash, role, is_active, email_verified, created_at, updated_at)
         VALUES ($1, $2, $3, 'user', TRUE, TRUE, $4, $4)
         RETURNING id`,
        [`${m.username}@members.arakice.app`, m.username, passwordHash, joinedAt],
      );
      const userId = rows[0].id;

      await client.query(
        `INSERT INTO user_profiles
           (user_id, display_name, avatar, favorite_team, bio, is_public, show_slips,
            tier, xp, performance_score, joined_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, $6, $7, $7, $8)`,
        [userId, m.displayName, m.avatar, m.team, m.bio, sim.tier, sim.xp, m.joined],
      );

      // Insertion des coupons par lots de 50 (un seul aller-retour par lot).
      for (let i = 0; i < sim.slips.length; i += 50) {
        const chunk = sim.slips.slice(i, i + 50);
        const values: any[] = [];
        const tuples = chunk.map((s, j) => {
          const b = j * 10;
          values.push(userId, s.placedAt, JSON.stringify(s.legs), s.legCount, s.isParlay,
                      s.combined, s.outcome, s.resolvedAt, s.xpAwarded, s.locksAt);
          return `($${b + 1}, $${b + 2}, 'hockey', $${b + 3}::jsonb, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::bet_outcome, $${b + 8}, $${b + 9}, $${b + 10})`;
        });
        await client.query(
          `INSERT INTO bet_slips
             (user_id, placed_at, sport, legs, leg_count, is_parlay, combined_probability,
              outcome, resolved_at, xp_awarded, locks_at)
           VALUES ${tuples.join(', ')}`,
          values,
        );
      }

      for (const b of sim.badges) {
        const meta = TIER_BADGES[b.tier] ?? { label: 'Early Adopter', icon: '⭐', description: 'Joined ArakIce in its first month' };
        await client.query(
          `INSERT INTO user_badges (user_id, badge_id, label, description, icon, earned_at, tier)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, badge_id) DO NOTHING`,
          [userId, b.badgeId, meta.label, meta.description, meta.icon, b.earnedAt, b.tier],
        );
      }

      created++;
      console.log(`✓ ${m.displayName} — ${sim.slips.length} coupons, ${sim.hitRate} %, ${sim.xp} XP (${sim.tier})`);
    }

    await client.query('COMMIT');
    console.log(`\nTerminé : ${created} membre(s) créé(s). Le classement se rafraîchit en ≤ 60 s.`);
    if (process.env.COMMUNITY_PASSWORD) console.log('Connexion possible avec COMMUNITY_PASSWORD.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => { console.error('[seed-community] échec :', err); process.exitCode = 1; })
  .finally(() => pool.end());
