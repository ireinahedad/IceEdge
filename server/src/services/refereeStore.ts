/**
 * refereeStore.ts
 * Facteur ARBITRE pour les totaux (boîte de verre, hors ML).
 *
 * Deux sources :
 *   1. Tendance par arbitre  — server/src/data/referees.json (semi-manuel,
 *      rempli depuis Scouting the Refs). Arbitre inconnu → moyenne (neutre).
 *   2. Assignation du jour    — scrappée sur Scouting the Refs (API WordPress
 *      wp-json, plus stable que le HTML), avec cache mémoire + repli gracieux.
 *      Un fichier manuel optionnel data/ref_assignments.json a la PRIORITÉ
 *      (belt-and-suspenders : si le scrape casse, on garde la main).
 *
 * Sortie : getGameRefFactor(home, away, date) → multiplicateur borné du volume
 * de PP (1.0 = neutre), la liste des arbitres et la source. Tolérant aux pannes :
 * toute erreur retombe sur un facteur neutre — jamais d'exception propagée.
 *
 * NB : le parseur cible le format actuel des billets « NHL Referees and
 * Linesmen » de Scouting the Refs. À valider une fois sur un vrai jour de match ;
 * si leur structure change, seule extractAssignments() est à ajuster.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Réglages ────────────────────────────────────────────────────────────────
const STR_BASE = 'https://scoutingtherefs.com/wp-json/wp/v2/posts';
const MULT_MIN = 0.85;   // borne basse du multiplicateur PP
const MULT_MAX = 1.20;   // borne haute
const REF_TTL  = 3 * 60 * 60_000; // 3 h

const REFEREES_PATH   = join(__dirname, '..', 'data', 'referees.json');
const ASSIGNMENTS_PATH = join(__dirname, '..', 'data', 'ref_assignments.json');

// ── Cache mémoire minimal ───────────────────────────────────────────────────
interface CacheEntry { data: unknown; expiresAt: number }
const _cache = new Map<string, CacheEntry>();
function getCached<T>(k: string): T | null {
  const e = _cache.get(k);
  return e && Date.now() < e.expiresAt ? (e.data as T) : null;
}
function setCached(k: string, data: unknown, ttl: number) {
  _cache.set(k, { data, expiresAt: Date.now() + ttl });
}

// ── Table de tendance (relue à chaud) ───────────────────────────────────────
interface RefTable { league: number; refs: Record<string, number> }

function loadTendencies(): RefTable {
  try {
    const raw = JSON.parse(readFileSync(REFEREES_PATH, 'utf8'));
    const league = Number(raw.league_avg_pp_per_game) || 6.2;
    const refs: Record<string, number> = {};
    for (const [name, v] of Object.entries(raw.referees ?? {})) {
      const pg = Number((v as any)?.pp_per_game);
      if (name && Number.isFinite(pg)) refs[normalizeName(name)] = pg;
    }
    return { league, refs };
  } catch {
    return { league: 6.2, refs: {} };
  }
}

/** Normalise un nom d'arbitre pour la comparaison (min., accents, ponctuation). */
function normalizeName(n: string): string {
  return (n || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Correspondance nom d'équipe → abréviation (pour parser les matchups STR) ──
const TEAM_NAMES: Record<string, string> = {
  'anaheim': 'ANA', 'ducks': 'ANA',
  'boston': 'BOS', 'bruins': 'BOS',
  'buffalo': 'BUF', 'sabres': 'BUF',
  'calgary': 'CGY', 'flames': 'CGY',
  'carolina': 'CAR', 'hurricanes': 'CAR',
  'chicago': 'CHI', 'blackhawks': 'CHI',
  'colorado': 'COL', 'avalanche': 'COL',
  'columbus': 'CBJ', 'blue jackets': 'CBJ',
  'dallas': 'DAL', 'stars': 'DAL',
  'detroit': 'DET', 'red wings': 'DET',
  'edmonton': 'EDM', 'oilers': 'EDM',
  'florida': 'FLA', 'panthers': 'FLA',
  'los angeles': 'LAK', 'kings': 'LAK',
  'minnesota': 'MIN', 'wild': 'MIN',
  'montreal': 'MTL', 'canadiens': 'MTL',
  'nashville': 'NSH', 'predators': 'NSH',
  'new jersey': 'NJD', 'devils': 'NJD',
  'islanders': 'NYI', 'ny islanders': 'NYI',
  'rangers': 'NYR', 'ny rangers': 'NYR',
  'ottawa': 'OTT', 'senators': 'OTT',
  'philadelphia': 'PHI', 'flyers': 'PHI',
  'pittsburgh': 'PIT', 'penguins': 'PIT',
  'san jose': 'SJS', 'sharks': 'SJS',
  'seattle': 'SEA', 'kraken': 'SEA',
  'st. louis': 'STL', 'st louis': 'STL', 'blues': 'STL',
  'tampa bay': 'TBL', 'lightning': 'TBL',
  'toronto': 'TOR', 'maple leafs': 'TOR',
  'utah': 'UTA', 'mammoth': 'UTA', 'hockey club': 'UTA',
  'vancouver': 'VAN', 'canucks': 'VAN',
  'vegas': 'VGK', 'golden knights': 'VGK',
  'washington': 'WSH', 'capitals': 'WSH',
  'winnipeg': 'WPG', 'jets': 'WPG',
};

function abbrsInText(text: string): Set<string> {
  const t = text.toLowerCase();
  const found = new Set<string>();
  for (const [name, abbr] of Object.entries(TEAM_NAMES)) {
    if (t.includes(name)) found.add(abbr);
  }
  return found;
}

// ── Assignation : structure et sources ──────────────────────────────────────
export interface RefAssignment { refs: string[]; source: 'scrape' | 'manual'; }

function gameKey(home: string, away: string): string {
  return `${away.toUpperCase()}@${home.toUpperCase()}`;
}

/** Fichier manuel optionnel (priorité). Clé "AWAY@HOME" → { referees: [...] }. */
function manualAssignment(home: string, away: string): RefAssignment | null {
  try {
    const raw = JSON.parse(readFileSync(ASSIGNMENTS_PATH, 'utf8'));
    const g = (raw.games ?? {})[gameKey(home, away)];
    const refs = (g?.referees ?? g?.refs ?? []).filter((s: any) => typeof s === 'string');
    return refs.length ? { refs, source: 'manual' } : null;
  } catch {
    return null;
  }
}

/** Extrait 1-2 noms d'arbitres d'une ligne « Referees: #12 A B, #34 C D ». */
function parseRefNames(s: string): string[] {
  return s
    .split(/,|\band\b|\/|\n/i)
    .map(x => x.replace(/#?\d+/g, '').replace(/\(.*?\)/g, '').trim())
    .filter(x => /[a-z]/i.test(x) && x.split(/\s+/).length >= 2 && x.length <= 40)
    .slice(0, 2);
}

/**
 * Parse le contenu HTML d'un billet STR en assignations { abbrs, refs }.
 * Approche par BLOCS : une ligne « matchup » (2 équipes + « at/vs/@ ») ouvre un
 * bloc ; la 1re ligne « Referees … » du bloc fournit les arbitres. Robuste au
 * titre du billet (« NHL Referees and Linesmen ») car il n'a pas de matchup.
 * À ajuster ici seul si Scouting the Refs change de gabarit.
 */
function extractAssignments(html: string): Array<{ abbrs: string[]; refs: string[] }> {
  const lines = html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const out: Array<{ abbrs: string[]; refs: string[] }> = [];
  let cur: { abbrs: string[]; refs: string[] } | null = null;
  for (const line of lines) {
    const teams = [...abbrsInText(line)];
    const isMatchup = teams.length >= 2 && /\bat\b|\bvs\.?\b|@/i.test(line);
    if (isMatchup) {
      if (cur && cur.refs.length) out.push(cur);
      cur = { abbrs: teams.slice(0, 2), refs: [] };
      continue;
    }
    if (cur && !cur.refs.length) {
      const m = /Referees?\s*[:\-]?\s*(.+)/i.exec(line);
      if (m) cur.refs = parseRefNames(m[1]);
    }
  }
  if (cur && cur.refs.length) out.push(cur);
  return out;
}

/** Récupère les assignations STR du jour (cache + repli gracieux). */
async function fetchDailyAssignments(date: string): Promise<Array<{ abbrs: string[]; refs: string[] }>> {
  const key = `str:${date}`;
  const cached = getCached<Array<{ abbrs: string[]; refs: string[] }>>(key);
  if (cached) return cached;
  try {
    // Billet du jour : recherche par mot-clé + tri par date décroissante.
    const url = `${STR_BASE}?search=referees%20linesmen&per_page=5&_fields=date,title,content&orderby=date&order=desc`;
    const res = await fetch(url, { headers: { 'User-Agent': 'IceEdge/1.0', Accept: 'application/json' } });
    if (!res.ok) throw new Error(`STR ${res.status}`);
    const posts = (await res.json()) as Array<any>;
    // Billet dont la date correspond au jour visé, sinon le plus récent.
    const post = posts.find(p => (p.date ?? '').slice(0, 10) === date) ?? posts[0];
    const html = post?.content?.rendered ?? '';
    const parsed = html ? extractAssignments(html) : [];
    setCached(key, parsed, REF_TTL);
    return parsed;
  } catch {
    setCached(key, [], REF_TTL / 3);   // échec → re-tenter plus tôt
    return [];
  }
}

// ── API publique ────────────────────────────────────────────────────────────
export interface RefFactor {
  multiplier: number;         // volume de PP relatif (1.0 neutre), borné
  refs: string[];             // arbitres retenus
  source: 'manual' | 'scrape' | 'none';
  note: string;
}

const NEUTRAL: RefFactor = { multiplier: 1.0, refs: [], source: 'none', note: 'arbitres non renseignés' };

/** Aujourd'hui en heure de l'Est (les jours de match NHL sont référencés en ET). */
function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Multiplicateur de volume de PP pour un match donné (neutre si inconnu). */
export async function getGameRefFactor(
  homeAbbr: string,
  awayAbbr: string,
  date: string = todayET(),
): Promise<RefFactor> {
  const home = homeAbbr.toUpperCase();
  const away = awayAbbr.toUpperCase();
  const { league, refs: tend } = loadTendencies();

  // 1. Assignation : manuel prioritaire, sinon scrape.
  let assignment = manualAssignment(home, away);
  if (!assignment) {
    const day = await fetchDailyAssignments(date);
    const hit = day.find(g => g.abbrs.includes(home) && g.abbrs.includes(away));
    if (hit) assignment = { refs: hit.refs, source: 'scrape' };
  }
  if (!assignment || !assignment.refs.length) return { ...NEUTRAL };

  // 2. Tendance : moyenne des arbitres connus / moyenne ligue → multiplicateur.
  const rates = assignment.refs
    .map(r => tend[normalizeName(r)])
    .filter((v): v is number => Number.isFinite(v));
  if (!rates.length || league <= 0) {
    return { multiplier: 1.0, refs: assignment.refs, source: assignment.source,
             note: `arbitres ${assignment.refs.join(', ')} — tendance inconnue (neutre)` };
  }
  const avg = rates.reduce((s, v) => s + v, 0) / rates.length;
  const multiplier = Math.max(MULT_MIN, Math.min(MULT_MAX, avg / league));
  return {
    multiplier,
    refs: assignment.refs,
    source: assignment.source,
    note: `arbitres ${assignment.refs.join(', ')} — ${multiplier >= 1 ? '+' : ''}${((multiplier - 1) * 100).toFixed(0)}% PP vs moyenne`,
  };
}
