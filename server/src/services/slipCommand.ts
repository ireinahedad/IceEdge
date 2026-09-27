/**
 * slipCommand.ts — « Canadien gagne ce soir » → intention de pari.
 *
 * CE QUE FAIT CE MODULE. Il traduit une phrase tapée par le joueur en une ou
 * plusieurs INTENTIONS (`qui`, `quel marché`, `quelle sélection`, `quelle
 * ligne`, `quel match`). Rien d'autre. Il ne produit AUCUN chiffre : la
 * probabilité d'une jambe vient toujours de `getSinglePrediction`, par
 * `buildLeg`, exactement comme depuis la feuille `MarketSelectorSheet`. Une
 * jambe ajoutée par commande doit être identique à la même jambe ajoutée à la
 * main (cf. SLIP_COMMANDE_PLAN.md).
 *
 * Deux fonctions publiques :
 *   - `parseSlipCommand` — l'analyseur local, gratuit et illimité (D3) ;
 *   - `validateIntent`   — le garde-fou, appliqué à la sortie de l'analyseur
 *     ET à celle du LLM (§ 5) : une intention qu'il refuse n'atteint jamais le
 *     coupon, d'où qu'elle vienne.
 *
 * RÈGLE D'OR : dans le doute, on ne devine pas. Un nom qui désigne deux équipes
 * (« New York »), deux joueurs (« Hughes ») ou une phrase qui porte deux
 * marchés sans séparateur rendent un échec explicite — jamais un choix au
 * hasard. Un match introuvable dans la fenêtre demandée rend `no_game` —
 * jamais un match inventé. Une négation (« ne gagne pas », « perd ») ou un
 * chiffre que l'analyseur n'a pas su lire rendent `unknown` : mieux vaut
 * passer la main au LLM que d'inscrire le contraire de ce qui a été demandé.
 *
 * CONVENTIONS D'IDENTIFIANTS — celles du client (`useNHLData`) :
 *   - équipe  : abréviation en minuscules (« mtl ») ;
 *   - joueur  : id NHL en chaîne ;
 *   - match   : id NHL en chaîne ; un sujet « game » a `subjectId === gameId`.
 * Sélections : l'id de l'équipe pour moneyline / 60 minutes / puck line ;
 * `over` / `under` pour les plus/moins ; `yes` pour les marchés sans sélection
 * (même valeur que la feuille).
 *
 * ⚠️ PARTAGÉ AVEC LE CLIENT, comme `parlay.ts` : le client l'importera tel
 * quel (le client n'a pas de runner de tests, ce module est testé ici). Donc
 * aucune dépendance Node ni base de données ; le seul import est
 * `oddsTeamNames.ts`, lui aussi sans dépendance. Le module ne fait aucun appel
 * réseau : l'appelant fournit les matchs, les joueurs, la date du jour NHL et
 * les lignes autorisées (`ctx`).
 */

import { NAME_TO_ABBR } from './oddsTeamNames';

// ── Marchés couverts (v1, § 3.4) ────────────────────────────────────────────

export const SLIP_COMMAND_MARKETS = [
  'moneyline', 'regulation_result', 'puck_line', 'team_total_goals',
  'total_goals', 'both_teams_score', 'game_to_ot',
  'anytime_goal', 'first_goal_scorer', 'shots_ou', 'points_ou', 'assists_ou', 'goalie_saves_ou',
] as const;

export type SlipMarket = typeof SLIP_COMMAND_MARKETS[number];

/** Marchés dont le sujet est UNE équipe. */
const TEAM_MARKETS: ReadonlySet<string> = new Set<SlipMarket>(['moneyline', 'regulation_result', 'puck_line', 'team_total_goals']);
/** Marchés dont le sujet est le match entier. */
const GAME_MARKETS: ReadonlySet<string> = new Set<SlipMarket>(['total_goals', 'both_teams_score', 'game_to_ot']);
/** Marchés dont le sujet est un joueur. */
const PLAYER_MARKETS: ReadonlySet<string> = new Set<SlipMarket>(['anytime_goal', 'first_goal_scorer', 'shots_ou', 'points_ou', 'assists_ou', 'goalie_saves_ou']);
/** Marchés plus/moins : sélection `over`/`under` et ligne obligatoire. */
const OU_MARKETS: ReadonlySet<string> = new Set<SlipMarket>(['team_total_goals', 'total_goals', 'shots_ou', 'points_ou', 'assists_ou', 'goalie_saves_ou']);
/** Marchés dont la sélection est l'équipe sujet elle-même. */
const TEAM_PICK_MARKETS: ReadonlySet<string> = new Set<SlipMarket>(['moneyline', 'regulation_result', 'puck_line']);

/** Longueur maximale d'une commande. Au-delà, ce n'est plus une commande. */
export const SLIP_COMMAND_MAX_LENGTH = 200;
/** Nombre maximal de demandes dans une même phrase. */
export const SLIP_COMMAND_MAX_PARTS = 6;

// ── Types ───────────────────────────────────────────────────────────────────

export interface SlipIntent {
  subjectType: 'team' | 'player' | 'game';
  subjectId: string;
  marketType: SlipMarket;
  selection: string;
  line?: number;
  gameId: string;
}

export interface SlipGame {
  id: string;
  homeAbbr: string;
  awayAbbr: string;
  /** YYYY-MM-DD, date NHL du match. */
  date: string;
  startTime?: string;
}

export interface SlipPlayer {
  id: string;
  name: string;
  teamAbbr: string;
  /** « G » pour un gardien. Facultatif : sans lui, le contrôle de poste est sauté. */
  position?: string;
}

export interface SlipContext {
  /** Matchs à venir (non commencés). */
  games: readonly SlipGame[];
  /** Joueurs des équipes de ces matchs. */
  players: readonly SlipPlayer[];
  /**
   * Date du jour NHL (YYYY-MM-DD), celle de `getScheduleAnchor().today` — PAS
   * l'horloge de l'appareil : à Bali, le « ce soir » nord-américain tombe le
   * lendemain matin.
   */
  today: string;
  /**
   * Lignes autorisées par marché plus/moins — celles de `MARKET_DEFINITIONS`
   * côté client. Un marché absent n'autorise AUCUNE ligne.
   */
  lines: Partial<Record<SlipMarket, readonly number[]>>;
}

export type SlipWindow = 'today' | 'tomorrow' | 'next';

export type SlipFailureDetail =
  | { kind: 'team'; candidates: string[] }
  | { kind: 'player'; candidates: { id: string; name: string; teamAbbr: string }[] }
  | { kind: 'line_missing'; market: SlipMarket; options: number[] }
  | { kind: 'game_missing' }
  | { kind: 'no_game'; subject: string; window: SlipWindow }
  | { kind: 'line'; market: SlipMarket; line: number; options: number[] }
  | { kind: 'position'; market: SlipMarket; playerId: string }
  /** « Habs over 6.5 » : ligne du total du MATCH sur une seule équipe — on demande lequel. */
  | { kind: 'total_scope'; team: string; line: number; gameId: string }
  | { kind: 'too_long'; max: number }
  | { kind: 'too_many'; max: number };

export type SlipFailureReason = 'unknown' | 'ambiguous' | 'no_game' | 'unsupported';

export interface SlipFailure {
  ok: false;
  reason: SlipFailureReason;
  /** Le morceau de phrase qui a échoué (normalisé). */
  chunk: string;
  detail?: SlipFailureDetail;
}

export type SlipParseResult = { ok: true; intents: SlipIntent[] } | SlipFailure;

export type SlipValidationCode = 'shape' | 'market' | 'game' | 'subject' | 'selection' | 'line' | 'position';

export type SlipValidation =
  | { ok: true; intent: SlipIntent }
  | { ok: false; code: SlipValidationCode; message: string };

// ── Normalisation (§ 3.1) ───────────────────────────────────────────────────

/** Minuscules, sans accents, apostrophes et tirets en espaces. Pour les noms propres. */
export function normalizeName(s: string): string {
  return (s || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalise une commande. En plus de `normalizeName` : `6,5` → `6.5`,
 * `o6.5` → `over 6.5`, `u6,5` → `under 6.5`, le signe de `-1.5` est gardé,
 * et `,` `+` `&` deviennent des séparateurs isolés.
 *
 * `MIN` et `CAR` sont des abréviations d'équipe, mais « min » (minutes) et
 * « car » (conjonction) sont des mots courants : on ne les lit comme équipes
 * qu'écrits en MAJUSCULES dans une phrase qui ne l'est pas entièrement.
 */
export function normalizeCommand(text: string): string {
  let s = text || '';
  const shouting = s === s.toUpperCase() && /[A-Z]/.test(s);
  if (!shouting) {
    s = s
      // « 60 MIN » reste des minutes. (Pas de lookbehind : Safari < 16.4 refuse
      // de charger un module qui en contient un.)
      .replace(/(\d\s?)?\bMIN\b/g, (m, digit?: string) => (digit ? m : ' minnesota '))
      .replace(/\bCAR\b/g, ' carolina ');
  }
  return s
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[−–—]/g, '-')          // signes moins typographiques
    .replace(/(\d),(\d)/g, '$1.$2')                  // virgule décimale
    .replace(/(^|[^\d])\.(\d)/g, '$10.$2')             // .5 → 0.5
    .replace(/\bo\s?(\d)/g, 'over $1')               // o6.5
    .replace(/\bu\s?(\d)/g, 'under $1')              // u6.5
    .replace(/(\d)\.(?!\d)/g, '$1 ')                 // point final après un nombre
    .replace(/(^|\D)\.|\.(?!\d)/g, (_m, pre?: string) => `${pre ?? ''} `) // points hors nombres (« st. louis »)
    .replace(/-(?!\d)/g, ' ')                        // tirets de mots, pas le signe de -1.5
    .replace(/\+(?!\d)/g, ' + ')
    .replace(/[,&]/g, (m) => ` ${m} `)
    .replace(/[^a-z0-9.+\-,&\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Équipes (§ 3.2) ─────────────────────────────────────────────────────────

/**
 * Villes et surnoms par équipe, déjà normalisés. Les noms complets viennent de
 * `NAME_TO_ABBR` et les abréviations sont ajoutées à la construction de
 * l'index. Un alias listé sous DEUX équipes est une collision : il rend
 * `ambiguous`, jamais un choix.
 */
export const TEAM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ANA: ['anaheim', 'ducks', 'canards'],
  BOS: ['boston', 'bruins', 'bruin', 'bs'],
  BUF: ['buffalo', 'sabres', 'sabers'],
  CGY: ['calgary', 'flames', 'flammes'],
  CAR: ['carolina', 'hurricanes', 'canes'],
  CHI: ['chicago', 'blackhawks', 'hawks'],
  COL: ['colorado', 'avalanche', 'avs'],
  CBJ: ['columbus', 'blue jackets', 'jackets'],
  DAL: ['dallas', 'stars', 'etoiles'],
  DET: ['detroit', 'red wings', 'wings'],
  EDM: ['edmonton', 'oilers', 'oil'],
  FLA: ['florida', 'floride', 'panthers', 'cats'],
  LAK: ['los angeles', 'kings', 'rois'],
  MIN: ['minnesota', 'wild'],
  MTL: ['montreal', 'canadiens', 'canadien', 'habs', 'ch', 'glorieux', 'tricolore'],
  NSH: ['nashville', 'predators', 'preds', 'predateurs'],
  NJD: ['new jersey', 'devils', 'diables', 'nj'],
  NYI: ['new york', 'ny', 'islanders', 'isles', 'insulaires'],
  NYR: ['new york', 'ny', 'rangers', 'blueshirts'],
  OTT: ['ottawa', 'senators', 'senateurs', 'sens'],
  PHI: ['philadelphia', 'philadelphie', 'philly', 'flyers'],
  PIT: ['pittsburgh', 'penguins', 'pens', 'pingouins'],
  SJS: ['san jose', 'sharks', 'requins', 'sj'],
  SEA: ['seattle', 'kraken'],
  STL: ['st louis', 'saint louis', 'blues'],
  TBL: ['tampa bay', 'tampa', 'lightning', 'bolts', 'eclair', 'tb'],
  TOR: ['toronto', 'maple leafs', 'leafs'],
  UTA: ['utah', 'mammoth', 'coyotes', 'yotes', 'arizona'],
  VAN: ['vancouver', 'canucks', 'nucks'],
  VGK: ['vegas', 'las vegas', 'golden knights', 'knights'],
  WSH: ['washington', 'capitals', 'caps'],
  WPG: ['winnipeg', 'jets'],
};

/** Abréviations qui sont aussi des mots courants : voir `normalizeCommand`. */
const RISKY_ABBRS = new Set(['MIN', 'CAR']);

/** alias normalisé → abréviations (une seule, sauf collision). */
export const TEAM_ALIAS_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const idx = new Map<string, string[]>();
  const add = (alias: string, abbr: string) => {
    const key = normalizeName(alias);
    if (!key) return;
    const cur = idx.get(key) ?? [];
    if (!cur.includes(abbr)) cur.push(abbr);
    idx.set(key, cur);
  };
  for (const [name, abbr] of Object.entries(NAME_TO_ABBR)) add(name, abbr);
  for (const [abbr, aliases] of Object.entries(TEAM_ALIASES)) {
    if (!RISKY_ABBRS.has(abbr)) add(abbr, abbr);
    for (const a of aliases) add(a, abbr);
  }
  return idx;
})();

const byLengthDesc = (a: string, b: string) => b.length - a.length || a.localeCompare(b);
const TEAM_ALIAS_KEYS = [...TEAM_ALIAS_INDEX.keys()].sort(byLengthDesc);

// ── Joueurs (§ 3.3) ─────────────────────────────────────────────────────────

/**
 * Mots qui ne désignent JAMAIS un joueur par son seul nom de famille : les
 * mots-clés des marchés et les mots outils. Brayden Point reste trouvable par
 * son nom complet ; « Suzuki over 1.5 points » ne doit pas y voir un deuxième
 * joueur.
 */
const SURNAME_STOPWORDS = new Set([
  'point', 'points', 'pts', 'but', 'buts', 'goal', 'goals', 'score', 'scores', 'over', 'under',
  'plus', 'moins', 'tir', 'tirs', 'shot', 'shots', 'passe', 'passes', 'assist', 'assists',
  'arret', 'arrets', 'save', 'saves', 'win', 'wins', 'premier', 'first', 'line', 'reg',
  'soir', 'demain', 'today', 'tonight', 'tomorrow', 'contre', 'versus', 'vs', 'le', 'la',
  'les', 'de', 'des', 'du', 'et', 'and', 'the', 'en', 'au', 'ce', 'sur', 'par', 'pour',
]);

interface PlayerIndex {
  full: Map<string, SlipPlayer[]>;
  surname: Map<string, SlipPlayer[]>;
  fullKeys: string[];
  surnameKeys: string[];
}

const playerIndexCache = new WeakMap<readonly SlipPlayer[], PlayerIndex>();

function playerIndex(players: readonly SlipPlayer[]): PlayerIndex {
  const cached = playerIndexCache.get(players);
  if (cached) return cached;
  const full = new Map<string, SlipPlayer[]>();
  const surname = new Map<string, SlipPlayer[]>();
  const push = (m: Map<string, SlipPlayer[]>, k: string, p: SlipPlayer) => {
    const cur = m.get(k) ?? [];
    if (!cur.some((q) => q.id === p.id)) cur.push(p);
    m.set(k, cur);
  };
  for (const p of players) {
    const n = normalizeName(p.name);
    if (!n) continue;
    push(full, n, p);
    const parts = n.split(' ');
    if (parts.length < 2) continue;
    // « eriksson ek », « van riemsdyk » : tout après le prénom…
    const rest = parts.slice(1).join(' ');
    if (rest.length >= 3 && !SURNAME_STOPWORDS.has(rest)) push(surname, rest, p);
    // … et le dernier mot seul, s'il est assez long pour ne pas être un mot outil.
    const last = parts[parts.length - 1];
    if (last !== rest && last.length >= 3 && !SURNAME_STOPWORDS.has(last)) push(surname, last, p);
  }
  const idx: PlayerIndex = {
    full, surname,
    fullKeys: [...full.keys()].sort(byLengthDesc),
    surnameKeys: [...surname.keys()].sort(byLengthDesc),
  };
  playerIndexCache.set(players, idx);
  return idx;
}

// ── Extraction ──────────────────────────────────────────────────────────────

/** Texte de travail : on BLANCHIT ce qui a été reconnu, à longueur égale. */
interface Work { rest: string }

/** Trouve chaque clé (mot entier), la blanchit, et rend les positions. */
function extractKeys(w: Work, keys: readonly string[]): { key: string; at: number }[] {
  const found: { key: string; at: number }[] = [];
  for (const key of keys) {
    const needle = ` ${key} `;
    let at = w.rest.indexOf(needle);
    while (at !== -1) {
      found.push({ key, at });
      w.rest = w.rest.slice(0, at + 1) + ' '.repeat(key.length) + w.rest.slice(at + 1 + key.length);
      at = w.rest.indexOf(needle, at + 1);
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

const words = (alts: string) => new RegExp(`(?:^| )(?:${alts})(?= |$)`, 'g');

/** Vrai si le motif apparaît ; toutes ses occurrences sont blanchies. */
function takeFlag(w: Work, re: RegExp): boolean {
  let hit = false;
  w.rest = w.rest.replace(re, (m) => { hit = true; return ' '.repeat(m.length); });
  return hit;
}

/** Nombres capturés par le motif ; toutes ses occurrences sont blanchies. */
function takeNumbers(w: Work, re: RegExp): number[] {
  const out: number[] = [];
  w.rest = w.rest.replace(re, (m: string, g1: string) => { out.push(Number(g1)); return ' '.repeat(m.length); });
  return out;
}

const NUM = '(\\d{1,2}(?:\\.\\d{1,2})?)';

// L'ordre de lecture compte : une expression longue est blanchie avant que ses
// mots ne puissent déclencher un motif plus court (« les deux équipes
// MARQUENT », « premier BUT », « TIRS de barrage »).
const RE = {
  negation:   words('ne|n|pas|not|no|dont|don t|won t|wont|perd|perdent|perdra|perdre|lose|loses|losing|defaite|sauf|except|ou|or|nul|draw|egalite|tie'),
  today:      words('ce soir|cette nuit|tonight|aujourd hui|auj|ajd|today'),
  tomorrow:   words('demain soir|demain|tomorrow|tmrw'),
  btts:       words('les (?:deux|2) equipes (?:vont )?marquer|les (?:deux|2) equipes marquent|(?:deux|2) equipes marquent|btts|both teams (?:to )?score'),
  firstGoal:  words('premier but|1er but|premier buteur|premier a marquer|first goal scorer|first goalscorer|first goal|first scorer|fgs'),
  regulation: words('temps reglementaire|temps regulier|en 60|60 minutes|60 min|regulation|reg|3 way'),
  ot:         words('prolongation|prolongations|prolo|en prol|overtime|ot|tirs de barrage|fusillade|shootout'),
  puck:       words('-1\\.5|puck line|puckline|pl'),
  over:       words(`(?:over|plus de|au dessus de) ${NUM}`),
  under:      words(`(?:under|moins de|en dessous de) ${NUM}`),
  ouWord:     words('over|under|plus de|moins de'),
  shots:      words('tirs au but|tirs au filet|tirs cadres|shots on goal|shots on target|tirs|tir|shots|shot|sog|lancers|lancer'),
  points:     words('points|point|pts|pt'),
  assists:    words('passes|passe|assists|assist|aides|aide|ast'),
  saves:      words('arrets|arret|saves|save|svs'),
  scoreVerb:  words('marque|marquera|marquer|marquent|compte|comptera|compter|scores|score|to score|anytime|ags|buteur|goalscorer|scorer'),
  goalNoun:   words('buts|but|goals|goal'),
  win:        words('gagne|gagnent|gagner|gagnera|gagneront|gagnant|victoire|bat|battent|battre|l emporte|l emportent|emporte|emportent|win|wins|winner|to win|beat|beats|ml|moneyline'),
};

/**
 * Les mots restants sont ignorés (« le », « contre », « ajoute »…), mais tout
 * CHIFFRE qui a survécu à la lecture veut dire quelque chose que l'analyseur
 * n'a pas compris (« 3-2 », « +1.5 », « le 12 ») : la phrase passe au LLM.
 */
const HAS_DIGIT = /\d/;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Prochain match qui oppose TOUTES ces équipes, dans la fenêtre. */
function findGame(ctx: SlipContext, teams: readonly string[], window: SlipWindow): SlipGame | null {
  const target = window === 'today' ? ctx.today : window === 'tomorrow' ? addDays(ctx.today, 1) : null;
  const up = teams.map((t) => t.toUpperCase());
  const cands = ctx.games
    .filter((g) => up.every((t) => g.homeAbbr.toUpperCase() === t || g.awayAbbr.toUpperCase() === t))
    .filter((g) => (target ? g.date === target : g.date >= ctx.today))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  return cands[0] ?? null;
}

// ── Validation (§ 3.7) ──────────────────────────────────────────────────────

const SUBJECT_TYPES = new Set(['team', 'player', 'game']);
const isGoalie = (p: SlipPlayer) => (p.position ?? '').toUpperCase() === 'G';
const sameLine = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * Contrôle une intention — de l'analyseur ou du LLM — contre le contexte.
 * L'entrée est traitée comme NON FIABLE : forme, marché, match, sujet,
 * sélection, ligne et poste. Rend une copie propre (champs connus seulement).
 */
export function validateIntent(raw: unknown, ctx: SlipContext): SlipValidation {
  const bad = (code: SlipValidationCode, message: string): SlipValidation => ({ ok: false, code, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('shape', 'intent must be an object');
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64;
  if (!str(r.subjectType) || !SUBJECT_TYPES.has(r.subjectType as string)) return bad('shape', 'subjectType');
  if (!str(r.subjectId) || !str(r.selection) || !str(r.gameId)) return bad('shape', 'subjectId, selection and gameId must be strings');
  if (r.line !== undefined && r.line !== null && (typeof r.line !== 'number' || !Number.isFinite(r.line))) return bad('shape', 'line');
  if (!str(r.marketType) || !(SLIP_COMMAND_MARKETS as readonly string[]).includes(r.marketType as string)) {
    return bad('market', `unsupported market ${String(r.marketType)}`);
  }

  const intent: SlipIntent = {
    subjectType: r.subjectType as SlipIntent['subjectType'],
    subjectId: r.subjectId as string,
    marketType: r.marketType as SlipMarket,
    selection: r.selection as string,
    gameId: r.gameId as string,
  };
  if (typeof r.line === 'number') intent.line = r.line;
  const m = intent.marketType;

  const game = ctx.games.find((g) => g.id === intent.gameId);
  if (!game) return bad('game', `unknown game ${intent.gameId}`);
  const sides = [game.homeAbbr.toLowerCase(), game.awayAbbr.toLowerCase()];

  if (TEAM_MARKETS.has(m)) {
    if (intent.subjectType !== 'team' || !sides.includes(intent.subjectId)) return bad('subject', 'team not in this game');
  } else if (GAME_MARKETS.has(m)) {
    if (intent.subjectType !== 'game' || intent.subjectId !== intent.gameId) return bad('subject', 'game subject must be the game');
  } else if (PLAYER_MARKETS.has(m)) {
    if (intent.subjectType !== 'player') return bad('subject', 'player market needs a player');
    const p = ctx.players.find((q) => q.id === intent.subjectId);
    if (!p || !sides.includes(p.teamAbbr.toLowerCase())) return bad('subject', 'player not in this game');
    if (p.position !== undefined && (m === 'goalie_saves_ou') !== isGoalie(p)) {
      return bad('position', m === 'goalie_saves_ou' ? 'saves need a goalie' : 'skater market on a goalie');
    }
  }

  if (TEAM_PICK_MARKETS.has(m)) {
    if (intent.selection !== intent.subjectId) return bad('selection', 'selection must be the subject team');
  } else if (OU_MARKETS.has(m)) {
    if (intent.selection !== 'over' && intent.selection !== 'under') return bad('selection', 'selection must be over or under');
  } else if (intent.selection !== 'yes') {
    return bad('selection', 'selection must be yes');
  }

  if (OU_MARKETS.has(m)) {
    const options = ctx.lines[m] ?? [];
    if (intent.line === undefined || !options.some((o) => sameLine(o, intent.line as number))) {
      return bad('line', `line not allowed for ${m}`);
    }
  } else if (intent.line !== undefined) {
    return bad('line', `${m} takes no line`);
  }

  return { ok: true, intent };
}

// ── Analyseur (§ 3.4 à 3.6) ─────────────────────────────────────────────────

/** Ce qu'un morceau transmet au suivant (« Habs ML et over 6.5 »). */
interface Carry { gameId: string; teamAbbr?: string; playerId?: string }

type ChunkResult = { ok: true; intent: SlipIntent; carry: Carry } | SlipFailure;

function parseChunk(chunk: string, ctx: SlipContext, carry: Carry | null): ChunkResult {
  const fail = (reason: SlipFailureReason, detail?: SlipFailureDetail): SlipFailure =>
    detail ? { ok: false, reason, chunk, detail } : { ok: false, reason, chunk };
  const w: Work = { rest: ` ${chunk} ` };

  // 1. Noms complets de joueurs, puis équipes, puis noms de famille seuls.
  const pidx = playerIndex(ctx.players);
  const fullHits = extractKeys(w, pidx.fullKeys);
  const teamHits = extractKeys(w, TEAM_ALIAS_KEYS);
  const surnameHits = extractKeys(w, pidx.surnameKeys);

  const teams: string[] = [];
  for (const h of teamHits) {
    const abbrs = TEAM_ALIAS_INDEX.get(h.key) ?? [];
    if (abbrs.length !== 1) return fail('ambiguous', { kind: 'team', candidates: [...abbrs] });
    if (!teams.includes(abbrs[0])) teams.push(abbrs[0]);
  }
  if (teams.length > 2) return fail('unknown');

  // Un nom partagé se tranche par l'équipe nommée à côté (« Aho des Hurricanes »).
  const playerGroups = [
    ...fullHits.map((h) => pidx.full.get(h.key) ?? []),
    ...surnameHits.map((h) => pidx.surname.get(h.key) ?? []),
  ];
  const players: SlipPlayer[] = [];
  for (const group of playerGroups) {
    let cands = group;
    if (cands.length > 1) {
      const byTeam = cands.filter((p) => teams.includes(p.teamAbbr.toUpperCase()));
      if (byTeam.length === 1) cands = byTeam;
    }
    if (cands.length !== 1) {
      return fail('ambiguous', {
        kind: 'player',
        candidates: cands.map((p) => ({ id: p.id, name: p.name, teamAbbr: p.teamAbbr.toUpperCase() })),
      });
    }
    if (!players.some((p) => p.id === cands[0].id)) players.push(cands[0]);
  }
  if (players.length > 1) return fail('unknown');

  // 2. Négations, alternatives, nul : jamais lus localement.
  if (takeFlag(w, RE.negation)) return fail('unknown');

  // 3. Fenêtre de temps.
  const today = takeFlag(w, RE.today);
  const tomorrow = takeFlag(w, RE.tomorrow);
  if (today && tomorrow) return fail('unknown');
  const window: SlipWindow = today ? 'today' : tomorrow ? 'tomorrow' : 'next';

  // 4. Mots-clés, du plus long au plus court.
  const f = {
    btts: takeFlag(w, RE.btts),
    firstGoal: takeFlag(w, RE.firstGoal),
    regulation: takeFlag(w, RE.regulation),
    ot: takeFlag(w, RE.ot),
    puck: takeFlag(w, RE.puck),
    over: takeNumbers(w, RE.over),
    under: takeNumbers(w, RE.under),
    ouWord: takeFlag(w, RE.ouWord),
    shots: takeFlag(w, RE.shots),
    points: takeFlag(w, RE.points),
    assists: takeFlag(w, RE.assists),
    saves: takeFlag(w, RE.saves),
    scoreVerb: takeFlag(w, RE.scoreVerb),
    goalNoun: takeFlag(w, RE.goalNoun),
    win: takeFlag(w, RE.win),
  };
  if (HAS_DIGIT.test(w.rest)) return fail('unknown');

  const ouCount = f.over.length + f.under.length;
  if (ouCount > 1) return fail('unknown');
  const ou: { selection: 'over' | 'under'; line: number } | null =
    f.over.length ? { selection: 'over', line: f.over[0] }
    : f.under.length ? { selection: 'under', line: f.under[0] }
    : null;

  const stats = (['shots', 'points', 'assists', 'saves'] as const).filter((k) => f[k]);
  const playerFlags = f.firstGoal || stats.length > 0 || f.scoreVerb || (f.goalNoun && !ou);

  // 5. Qui est le sujet ?
  let player: SlipPlayer | null = players[0] ?? null;
  if (!player && teams.length === 0 && carry?.playerId && playerFlags) {
    player = ctx.players.find((p) => p.id === carry.playerId) ?? null;
  }

  let market: SlipMarket;
  let intentBase: Omit<SlipIntent, 'gameId'>;
  let game: SlipGame | null;
  let subjectLabel: string;

  if (player) {
    // ── Pari joueur ──
    if (f.btts || f.regulation || f.ot || f.puck || f.win) return fail('unknown');
    if (f.firstGoal) {
      if (ou || stats.length) return fail('unknown');
      market = 'first_goal_scorer';
    } else if (stats.length === 1) {
      if (f.scoreVerb || f.goalNoun) return fail('unknown');
      market = ({ shots: 'shots_ou', points: 'points_ou', assists: 'assists_ou', saves: 'goalie_saves_ou' } as const)[stats[0]];
    } else if (stats.length === 0 && (f.scoreVerb || f.goalNoun) && !ou && !f.ouWord) {
      market = 'anytime_goal';
    } else {
      return fail('unknown');
    }
    if (OU_MARKETS.has(market) && !ou) {
      return f.ouWord
        ? fail('ambiguous', { kind: 'line_missing', market, options: [...(ctx.lines[market] ?? [])] })
        : fail('unknown');
    }
    intentBase = {
      subjectType: 'player', subjectId: player.id, marketType: market,
      selection: ou ? ou.selection : 'yes', ...(ou ? { line: ou.line } : {}),
    };
    const own = player.teamAbbr.toUpperCase();
    const opponents = teams.filter((t) => t !== own);
    if (opponents.length > 1) return fail('unknown');
    const inherited = !players.length && carry ? ctx.games.find((g) => g.id === carry.gameId) ?? null : null;
    game = inherited ?? findGame(ctx, [own, ...opponents], window);
    subjectLabel = player.name;
  } else {
    // ── Pari d'équipe ou de match ──
    if (f.firstGoal || stats.length || f.scoreVerb || (f.goalNoun && !ou)) return fail('unknown');
    const named = teams.length;
    const cands: SlipMarket[] = [];
    if (f.btts) cands.push('both_teams_score');
    if (f.ot) cands.push('game_to_ot');
    if (ou || f.ouWord) cands.push(named === 1 ? 'team_total_goals' : 'total_goals');
    if (f.regulation) cands.push('regulation_result');
    if (f.puck) cands.push('puck_line');
    // « gagne en 60 minutes », « gagne par la puck line » : le marché précis l'emporte.
    if (f.win && !f.regulation && !f.puck) cands.push('moneyline');
    if (cands.length !== 1) return fail('unknown');
    market = cands[0];
    if (OU_MARKETS.has(market) && !ou) {
      return fail('ambiguous', { kind: 'line_missing', market, options: [...(ctx.lines[market] ?? [])] });
    }

    if (TEAM_MARKETS.has(market)) {
      const subject = teams[0] ?? (named === 0 ? carry?.teamAbbr : undefined);
      if (!subject) return fail('unknown');
      game = named > 0
        ? findGame(ctx, teams, window)
        : ctx.games.find((g) => g.id === carry?.gameId) ?? null;
      const id = subject.toLowerCase();
      intentBase = {
        subjectType: 'team', subjectId: id, marketType: market,
        selection: ou ? ou.selection : id, ...(ou ? { line: ou.line } : {}),
      };
      subjectLabel = subject;
    } else {
      if (named === 0) {
        if (!carry) return fail('ambiguous', { kind: 'game_missing' });
        game = ctx.games.find((g) => g.id === carry.gameId) ?? null;
      } else {
        game = findGame(ctx, teams, window);
      }
      intentBase = {
        subjectType: 'game', subjectId: '', marketType: market,
        selection: ou ? ou.selection : 'yes', ...(ou ? { line: ou.line } : {}),
      };
      subjectLabel = teams.join(' / ');
    }
  }

  if (!game) return fail('no_game', { kind: 'no_game', subject: subjectLabel, window });

  // « Habs over 6.5 » : une équipe nommée, mais une ligne qui n'existe que pour
  // le total du match. Décision du user (2026-09-28) : ni refuser, ni choisir —
  // on demande au joueur « total du match ou total des Canadiens ? ».
  if (market === 'team_total_goals' && ou) {
    const has = (m: SlipMarket) => (ctx.lines[m] ?? []).some((o) => sameLine(o, ou.line));
    if (!has('team_total_goals') && has('total_goals')) {
      return fail('ambiguous', { kind: 'total_scope', team: subjectLabel, line: ou.line, gameId: game.id });
    }
  }

  const intent: SlipIntent = {
    ...intentBase,
    subjectId: intentBase.subjectType === 'game' ? game.id : intentBase.subjectId,
    gameId: game.id,
  };

  const v = validateIntent(intent, ctx);
  if (!v.ok) {
    if (v.code === 'line') {
      return fail('unsupported', { kind: 'line', market, line: intent.line as number, options: [...(ctx.lines[market] ?? [])] });
    }
    if (v.code === 'position') return fail('unsupported', { kind: 'position', market, playerId: intent.subjectId });
    return fail('unknown');
  }

  // L'équipe transmise au morceau suivant : celle d'un pari d'équipe, ou
  // l'équipe nommée d'un pari de match. Jamais celle d'un joueur : « Suzuki
  // marque et gagne » ne dit pas QUI gagne, ça part au LLM.
  const teamAbbr = intent.subjectType === 'team' ? intent.subjectId.toUpperCase()
    : intent.subjectType === 'player' ? undefined
    : teams.length === 1 ? teams[0]
    : carry && carry.gameId === game.id ? carry.teamAbbr : undefined;
  return {
    ok: true,
    intent: v.intent,
    carry: { gameId: game.id, teamAbbr, playerId: intent.subjectType === 'player' ? intent.subjectId : undefined },
  };
}

/**
 * Analyse une commande complète. Tout ou rien : si un morceau échoue, la
 * phrase entière échoue (on n'ajoute pas la moitié d'une demande), avec la
 * raison du PREMIER morceau en échec.
 */
export function parseSlipCommand(text: string, ctx: SlipContext): SlipParseResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.today)) throw new TypeError(`ctx.today must be YYYY-MM-DD, got ${ctx.today}`);
  const raw = (text || '').trim();
  if (raw.length > SLIP_COMMAND_MAX_LENGTH) {
    return { ok: false, reason: 'unsupported', chunk: '', detail: { kind: 'too_long', max: SLIP_COMMAND_MAX_LENGTH } };
  }
  const norm = normalizeCommand(raw);
  if (!norm) return { ok: false, reason: 'unknown', chunk: '' };

  const chunks = norm.split(/ (?:et|and|&|\+|,) |^(?:,|\+|&) | (?:,|\+|&)$/).map((c) => c.trim()).filter(Boolean);
  if (chunks.length === 0) return { ok: false, reason: 'unknown', chunk: '' };
  if (chunks.length > SLIP_COMMAND_MAX_PARTS) {
    return { ok: false, reason: 'unsupported', chunk: '', detail: { kind: 'too_many', max: SLIP_COMMAND_MAX_PARTS } };
  }

  const intents: SlipIntent[] = [];
  const seen = new Set<string>();
  let carry: Carry | null = null;
  for (const chunk of chunks) {
    const r = parseChunk(chunk, ctx, carry);
    if (!r.ok) return r;
    const key = [r.intent.subjectType, r.intent.subjectId, r.intent.marketType, r.intent.selection, r.intent.line ?? '', r.intent.gameId].join('|');
    if (!seen.has(key)) { seen.add(key); intents.push(r.intent); }
    carry = r.carry;
  }
  return { ok: true, intents };
}
