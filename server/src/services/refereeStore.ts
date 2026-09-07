/**
 * refereeStore.ts
 * Facteur ARBITRE pour les totaux (boîte de verre, hors ML).
 *
 * Deux sources :
 *   1. Tendance par arbitre  — table `manual_data` kind `ref_tendency`
 *      (semi-manuel, rempli depuis Scouting the Refs via
 *      `PUT /api/manual/referees`). Arbitre inconnu → moyenne (neutre).
 *   2. Assignation du jour    — scrappée sur Scouting the Refs (API WordPress
 *      wp-json, plus stable que le HTML), avec cache mémoire + repli gracieux.
 *      Une saisie manuelle optionnelle (kind `ref_assignment`) a la PRIORITÉ
 *      (belt-and-suspenders : si le scrape casse, on garde la main).
 *
 * ── La tendance venait de server/src/data/referees.json ─────────────────────
 * Ce fichier n'existait pas dans le conteneur : `tsc` n'émet pas les `.json` et
 * le Dockerfile ne copie que `dist/`. `loadTendencies()` retombait donc TOUJOURS
 * sur une table vide en production, en silence. Le symptôme était invisible
 * parce que le fichier ne contenait que des placeholders à la moyenne exacte :
 * il ne produisait aucun effet non plus. Le jour où les vrais chiffres y
 * auraient été saisis, ils n'auraient rien changé en production et rien ne
 * l'aurait dit. Voir `db/migrations/034_manual_data.sql`.
 *
 * Sortie : getGameRefFactor(home, away, date) → multiplicateur borné du volume
 * de PP (1.0 = neutre), la liste des arbitres et la source. Tolérant aux pannes :
 * toute erreur retombe sur un facteur neutre — jamais d'exception propagée.
 *
 * NB : le parseur cible le format actuel des billets « NHL Referees and
 * Linesmen » de Scouting the Refs. À valider une fois sur un vrai jour de match ;
 * si leur structure change, seule extractAssignments() est à ajuster.
 */
import { TtlCache } from './ttlCache';
import { getEntry, mapEntries, setEntry } from './manualData.service';
import { logger } from '../logger';

// ── Réglages ────────────────────────────────────────────────────────────────
const STR_BASE = 'https://scoutingtherefs.com/wp-json/wp/v2/posts';
const MULT_MIN = 0.85;   // borne basse du multiplicateur PP
const MULT_MAX = 1.20;   // borne haute
const REF_TTL  = 3 * 60 * 60_000; // 3 h

/**
 * Titre du billet quotidien. Il a DÉJÀ changé une fois — « Referees and
 * Linesmen » est devenu « Referees and Linespersons » — et les billets de
 * séries s'appellent « NHL Playoff Referees and Linespersons ». Le motif ne
 * porte donc que sur la partie qui n'a pas bougé.
 */
const TITLE_RE = /referees\s+and\s+lines/i;

/**
 * Nombre d'arbitres connus en dessous duquel on n'ose pas calculer la moyenne
 * de référence soi-même. La ligue compte ~40 arbitres actifs ; sous ce seuil la
 * moyenne dirait surtout qui a été de service cette semaine.
 */
const MIN_POP  = 10;

// ── Cache mémoire minimal, BORNÉ ────────────────────────────────────────────
// La clé est la date demandée : une entrée par jour consulté, jamais évincée
// sans plafond. Un process qui tourne des mois accumule une entrée par jour et
// par visiteur explorant le calendrier. 60 entrées ≈ deux mois de dates, très
// au-delà de ce qu'une page consulte réellement.
const _cache = new TtlCache<unknown>(REF_TTL, 60);
function getCached<T>(k: string): T | null {
  return _cache.get(k) as T | null;
}
function setCached(k: string, data: unknown, ttl: number) {
  _cache.set(k, data, ttl);
}

// ── Table de tendance (relue à chaud) ───────────────────────────────────────
interface RefTable { league: number; refs: Record<string, number> }

/**
 * Table de tendance depuis la base : `ref_tendency_auto` (relevé automatique
 * des billets STR) PUIS `ref_tendency` (saisie humaine), qui écrase. La saisie
 * de la carte admin reste donc le dernier mot, et le relevé automatique ne la
 * touche jamais — c'est la raison d'être des deux `kind` séparés.
 *
 * Les clés stockées sont DÉJÀ normalisées (`manual.routes.ts` applique
 * `normalizeRefName` à l'écriture), mais on renormalise ici : une ligne insérée
 * à la main en SQL ne passerait pas par la route, et une clé non normalisée ne
 * matcherait jamais un nom scrappé.
 *
 * ── LE DÉNOMINATEUR EST LE POINT DÉLICAT ────────────────────────────────────
 * `multiplier = moyenne(arbitres du match) / league`. Si `league` ne vient pas
 * de la MÊME mesure que le numérateur, le facteur n'est plus un écart entre
 * arbitres : c'est une remise constante déguisée en signal. Le 6,2 semé dans
 * `ref_config` est une moyenne de ligue générique ; les chiffres STR sont des
 * « PP Opp/Gm » par arbitre. Sur la colonne SAISON (5,1-6,2), diviser par 6,2
 * donnerait ≈ 0,90 à tout le monde, tous les soirs.
 *
 * D'où la règle : dès qu'on connaît assez d'arbitres, la référence est la
 * moyenne de CES chiffres-là. `ref_config` ne sert plus que de repli tant que
 * la population est trop petite pour qu'une moyenne veuille dire quelque chose.
 *
 * `getEntry`/`mapEntries` ne lèvent pas — base injoignable → table vide →
 * multiplicateur neutre, journalisé par `manualData.service`.
 */
async function loadTendencies(): Promise<RefTable> {
  const [auto, manual, config] = await Promise.all([
    mapEntries<{ name?: string; ppPerGame?: number }>('ref_tendency_auto'),
    mapEntries<{ name?: string; ppPerGame?: number }>('ref_tendency'),
    getEntry<{ avgPpPerGame?: number }>('ref_config', 'league'),
  ]);

  const refs: Record<string, number> = {};
  for (const rows of [auto, manual]) {            // le manuel passe en second
    for (const [key, v] of Object.entries(rows)) {
      const pg = Number(v?.ppPerGame);
      if (Number.isFinite(pg)) refs[normalizeRefName(v?.name ?? key)] = pg;
    }
  }

  const known  = Object.values(refs);
  const league = known.length >= MIN_POP
    ? known.reduce((sum, v) => sum + v, 0) / known.length
    : (Number(config?.avgPpPerGame) || 6.2);

  return { league, refs };
}

/**
 * Normalise un nom d'arbitre pour la comparaison (min., accents, ponctuation).
 *
 * Exporté parce que c'est aussi la CLÉ de stockage : `manual.routes.ts`
 * l'applique à l'écriture pour que « Wes McCauley », « wes mccauley » et
 * « Wes  McCauley » désignent la même ligne. Deux implémentations de cette
 * normalisation finiraient par diverger, et le symptôme serait un arbitre saisi
 * qui ne matche jamais.
 */
export function normalizeRefName(n: string): string {
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
  // « hockey club » a été retiré : l'alias matchait n'importe quelle phrase
  // contenant ces deux mots. « Utah Hockey Club » reste couvert par 'utah'.
  'utah': 'UTA', 'mammoth': 'UTA',
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

/** Saisie manuelle optionnelle (priorité). Clé "AWAY@HOME" → { refs: [...] }. */
async function manualAssignment(home: string, away: string): Promise<RefAssignment | null> {
  const entry = await getEntry<{ refs?: unknown }>('ref_assignment', gameKey(home, away));
  const refs = (Array.isArray(entry?.refs) ? entry!.refs : [])
    .filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0);
  return refs.length ? { refs, source: 'manual' } : null;
}


/** Un match tel qu'un billet STR le décrit. */
interface StrGame {
  /** `['STL','TOR']` — l'ancre du billet donne extérieur puis domicile. */
  abbrs: string[];
  /** 1-2 arbitres, numéro retiré. Jamais les juges de ligne. */
  refs: string[];
  /** nom normalisé → PP Opp/Gm **carrière** lu dans le tableau du billet. */
  career: Record<string, number>;
}

/** `<h1 id="#STLvsTOR">` — les deux abréviations, sans passer par les noms. */
const ANCHOR_RE   = /id="#?([A-Z]{3})vs([A-Z]{3})"/;
/** `<strong>Corey Syvret #23</strong>` — le numéro est ce qui distingue un
 *  nom d'officiel de n'importe quel autre texte en gras du billet. */
const REF_NAME_RE = /<strong>\s*([^<#]{2,40}?)\s*#\d+\s*<\/strong>/g;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse un billet STR en assignations.
 *
 * ── Pourquoi cette fonction a été réécrite le 2026-09-04 ────────────────────
 * La version précédente cherchait une ligne « Referees: A, B » après un
 * « matchup ». Ce format n'existe pas : STR met `REFEREES` seul dans un `<h3>`
 * et les noms plus loin, dans une cellule de tableau. Passée sur le vrai billet
 * du 18/11/2025 (8 matchs), elle ne rendait pas zéro arbitre — elle en rendait
 * DEUX, tous deux inventés : « Linesmen TBD » (extrait de « Referees and
 * Linesmen TBD », le match dont les officiels ne sont pas encore annoncés) et
 * « 's rank among active officials. » (extrait de la légende du tableau). Ces
 * chaînes seraient sorties à l'écran dans `RefFactor.note`. Un faux nom qui a
 * l'air d'un vrai est exactement ce que ce dépôt refuse ailleurs.
 *
 * ── La structure réelle, et pourquoi elle est fiable ────────────────────────
 * Un `<h1 id="#AWAYvsHOME">` par match, puis un `table.TOTable` contenant
 * `<h3>REFEREES</h3>` … `<h3>LINESPERSONS</h3>`. Le parsing s'appuie sur
 * l'ANCRE plutôt que sur les noms d'équipes : elle porte déjà les abréviations,
 * ce qui supprime tout un étage d'interprétation. `abbrsInText` ne sert plus
 * que de repli pour un `<h1>` sans ancre — c'est le cas du match « TBD ».
 *
 * Le tableau porte aussi `PP Opp/Gm` par arbitre, sous la forme
 * `5.7 (10) | 5.6 (37)` = **saison passée (rang) | carrière (rang)**. C'est la
 * tendance que `ref_tendency` attendait qu'on saisisse à la main. On lit la
 * colonne CARRIÈRE : vérifié sur deux billets à un mois d'écart, le bloc de
 * statistiques de STR n'est pas rafraîchi en cours de saison, et la colonne
 * carrière est la plus discriminante (les rangs vont jusqu'à ~42, contre une
 * plage plus resserrée sur la colonne saison).
 *
 * Un match sans section REFEREES, ou dont aucun nom ne porte de numéro, est
 * ignoré — pas deviné.
 */
function extractAssignments(html: string): StrGame[] {
  const out: StrGame[] = [];

  // ⚠️ Pas de `.slice(1)` : `split` sur une avant-garde ne produit pas
  // d'élément vide quand la coupure tombe en position 0, et le premier match
  // du billet se faisait manger. On garde les segments qui SONT un `<h1>`.
  for (const block of html.split(/(?=<h1[\s>])/i).filter(b => /^<h1[\s>]/i.test(b))) {
    // 1. Les équipes : l'ancre d'abord, les noms en dernier recours.
    const anchor = ANCHOR_RE.exec(block);
    const abbrs  = anchor
      ? [anchor[1], anchor[2]]
      : [...abbrsInText(stripTags(block.slice(0, block.indexOf('</h1>') + 1)))].slice(0, 2);
    if (abbrs.length < 2) continue;

    // 2. La section des ARBITRES, jamais celle des juges de ligne.
    const start = block.search(/>\s*REFEREES\s*</i);
    if (start === -1) continue;
    const rest    = block.slice(start);
    const end     = rest.search(/>\s*LINESPERSONS?\s*</i);
    const section = end === -1 ? rest : rest.slice(0, end);

    // 3. Les noms.
    const refs = [...section.matchAll(REF_NAME_RE)].map(m => m[1].trim()).slice(0, 2);
    if (!refs.length) continue;

    // 4. La ligne « PP Opp/Gm », une cellule par arbitre, colonne carrière.
    const career: Record<string, number> = {};
    const ppRow = /PP Opp\/Gm\s*<\/td>((?:\s*<td[\s\S]*?<\/td>)+)/i.exec(section);
    if (ppRow) {
      const cells = ppRow[1].match(/<td[\s\S]*?<\/td>/gi) ?? [];
      cells.forEach((cell, i) => {
        const m = /([\d.]+)[^|]*\|\s*([\d.]+)/.exec(stripTags(cell));
        const v = m ? Number(m[2]) : NaN;
        if (refs[i] && Number.isFinite(v)) career[normalizeRefName(refs[i])] = v;
      });
    }

    out.push({ abbrs, refs, career });
  }

  return out;
}

/**
 * Mémorise les PP Opp/Gm relevés, dans `ref_tendency_auto`.
 *
 * Le facteur arbitre devient ainsi le SEUL des quatre jeux de saisie manuelle
 * qui se remplit tout seul. Deux raisons de persister plutôt que de se
 * contenter du cache mémoire : la tendance survit à un redémarrage et à une
 * panne de Scouting the Refs un soir de match, et elle est visible en base.
 *
 * Écrit dans un `kind` SÉPARÉ de `ref_tendency` : la saisie humaine ne doit
 * jamais être écrasée par un relevé automatique. `loadTendencies` applique
 * l'ordre auto → manuel.
 *
 * Jamais attendu par la requête en cours, jamais fatal : au pire la tendance
 * sera relue au prochain billet.
 */
function rememberCareerRates(games: StrGame[]): void {
  const seen = new Map<string, { name: string; pp: number }>();
  for (const g of games) {
    for (const name of g.refs) {
      const key = normalizeRefName(name);
      const pp  = g.career[key];
      if (Number.isFinite(pp) && !seen.has(key)) seen.set(key, { name, pp });
    }
  }
  for (const [key, v] of seen) {
    void setEntry('ref_tendency_auto', key, { name: v.name, ppPerGame: v.pp, source: 'scoutingtherefs' })
      .catch((err: any) => logger.warn({ err: err?.message ?? err, ref: key },
        '[refs] tendance relevée non mémorisée'));
  }
}

/**
 * Assignations du jour (cache + repli gracieux).
 *
 * ⚠️ Le billet doit être CELUI DE LA DATE DEMANDÉE. L'ancien code retombait sur
 * `posts[0]` quand il ne le trouvait pas : un jour sans billet dans les cinq
 * derniers appliquait donc **les arbitres d'un autre soir**, en silence. Un
 * facteur neutre est infiniment préférable à un facteur faux.
 */
async function fetchDailyAssignments(date: string): Promise<StrGame[]> {
  const key = `str:${date}`;
  const cached = getCached<StrGame[]>(key);
  if (cached) return cached;
  try {
    const url = `${STR_BASE}?search=${encodeURIComponent('nhl referees')}`
              + '&per_page=15&_fields=date,title,content&orderby=date&order=desc';
    const res = await fetch(url, { headers: { 'User-Agent': 'IceEdge/1.0', Accept: 'application/json' } });
    if (!res.ok) throw new Error(`STR ${res.status}`);
    const posts = (await res.json()) as Array<any>;
    const post  = posts.find(p =>
      (p?.date ?? '').slice(0, 10) === date && TITLE_RE.test(p?.title?.rendered ?? ''));

    const parsed = post ? extractAssignments(post.content?.rendered ?? '') : [];
    // Pas de billet pour cette date : hors saison, ou pas encore publié. On
    // recache court pour re-tenter dans l'heure plutôt que dans trois.
    setCached(key, parsed, parsed.length ? REF_TTL : REF_TTL / 3);
    if (parsed.length) rememberCareerRates(parsed);
    return parsed;
  } catch (err: any) {
    // L'ancien `catch {}` était muet : une panne de STR ne se distinguait pas
    // d'un jour sans match.
    logger.warn({ err: err?.message ?? err, date },
      '[refs] billet Scouting the Refs illisible — facteur arbitre neutre');
    setCached(key, [], REF_TTL / 3);
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
  // Tendance et assignation manuelle sont deux lectures indépendantes : en
  // parallèle, pas en série. Toutes deux passent par le cache 30 s de
  // `manualData.service`, donc une soirée à douze matchs ne fait pas
  // vingt-quatre requêtes.
  const [{ league, refs: tend }, manual] = await Promise.all([
    loadTendencies(),
    manualAssignment(home, away),
  ]);

  // 1. Assignation : manuel prioritaire, sinon scrape.
  let assignment = manual;
  let scraped: StrGame | undefined;
  if (!assignment) {
    const day = await fetchDailyAssignments(date);
    scraped = day.find(g => g.abbrs.includes(home) && g.abbrs.includes(away));
    if (scraped) assignment = { refs: scraped.refs, source: 'scrape' };
  }
  if (!assignment || !assignment.refs.length) return { ...NEUTRAL };

  // 2. Tendance : moyenne des arbitres connus / moyenne de référence.
  //    La table passe en premier (elle porte la saisie humaine), le relevé du
  //    billet du soir sert au premier passage, avant que `rememberCareerRates`
  //    n'ait fini d'écrire.
  const rates = assignment.refs
    .map(r => tend[normalizeRefName(r)] ?? scraped?.career[normalizeRefName(r)])
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
