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
 * FAUTES DE FRAPPE (2026-09-29, demande du user) : un nom de joueur ou
 * d'équipe mal écrit (« Suzuky », « Canadeins », « Torronto ») n'est JAMAIS
 * corrigé en silence. L'analyseur rend un échec `ambiguous` de type
 * `spelling`, avec les noms proches en choix cliquables — la même mécanique
 * que « quel Hughes ? ». Voir `findSpellingFixes`.
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
  | { kind: 'team'; alias: string; candidates: string[] }
  | { kind: 'player'; alias: string; candidates: { id: string; name: string; teamAbbr: string }[] }
  | { kind: 'line_missing'; market: SlipMarket; options: number[] }
  | { kind: 'game_missing' }
  | { kind: 'no_game'; subject: string; window: SlipWindow }
  | { kind: 'line'; market: SlipMarket; line: number; options: number[] }
  | { kind: 'position'; market: SlipMarket; playerId: string }
  /** « Habs over 6.5 » : ligne du total du MATCH sur une seule équipe — on demande lequel. */
  | { kind: 'total_scope'; team: string; line: number; gameId: string }
  | { kind: 'too_long'; max: number }
  | { kind: 'too_many'; max: number }
  /** Un nom mal écrit : `word` tel que tapé (normalisé), `fixes` les noms proches. */
  | { kind: 'spelling'; word: string; fixes: SpellingFix[] };

/**
 * Une correction proposée pour un nom mal écrit. `chunk` est le morceau de
 * phrase réécrit avec le bon nom ; `choicesFor` en fait une commande entière.
 */
export type SpellingFix =
  | { kind: 'team'; abbr: string; chunk: string }
  | { kind: 'player'; id: string; name: string; teamAbbr: string; chunk: string };

export type SlipFailureReason = 'unknown' | 'ambiguous' | 'no_game' | 'unsupported';

/**
 * Une réponse cliquable à une ambiguïté. `text` est la commande ENTIÈRE,
 * réécrite pour lever l'ambiguïté : l'écran la renvoie telle quelle à
 * `parseSlipCommand`. Le vocabulaire reste donc ici, pas dans l'interface.
 */
export type SlipChoice =
  | { kind: 'team'; abbr: string; text: string }
  | { kind: 'player'; id: string; name: string; teamAbbr: string; text: string }
  | { kind: 'line'; market: SlipMarket; line: number; text: string }
  | { kind: 'game_total'; line: number; text: string };

export interface SlipFailure {
  ok: false;
  reason: SlipFailureReason;
  /** Le morceau de phrase qui a échoué (normalisé). */
  chunk: string;
  detail?: SlipFailureDetail;
  /** Réponses cliquables, quand l'échec en admet (ambiguïté, ligne). */
  choices?: SlipChoice[];
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

function parseChunkExact(chunk: string, ctx: SlipContext, carry: Carry | null): ChunkResult {
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
    if (abbrs.length !== 1) return fail('ambiguous', { kind: 'team', alias: h.key, candidates: [...abbrs] });
    if (!teams.includes(abbrs[0])) teams.push(abbrs[0]);
  }
  if (teams.length > 2) return fail('unknown');

  // Un nom partagé se tranche par l'équipe nommée à côté (« Aho des Hurricanes »).
  const playerGroups = [
    ...fullHits.map((h) => ({ key: h.key, group: pidx.full.get(h.key) ?? [] })),
    ...surnameHits.map((h) => ({ key: h.key, group: pidx.surname.get(h.key) ?? [] })),
  ];
  const players: SlipPlayer[] = [];
  for (const { key, group } of playerGroups) {
    let cands = group;
    if (cands.length > 1) {
      const byTeam = cands.filter((p) => teams.includes(p.teamAbbr.toUpperCase()));
      if (byTeam.length === 1) cands = byTeam;
    }
    if (cands.length !== 1) {
      return fail('ambiguous', {
        kind: 'player',
        alias: key,
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

// ── Choix cliquables ────────────────────────────────────────────────────────

/** Un alias qui ne désigne QUE cette équipe (« nyr », « carolina »…). */
function uniqueAlias(abbr: string): string {
  const up = abbr.toUpperCase();
  const cands = [up.toLowerCase(), ...(TEAM_ALIASES[up] ?? [])];
  return cands.find((a) => TEAM_ALIAS_INDEX.get(a)?.length === 1) ?? up.toLowerCase();
}

/** Remplace le mot (ou groupe de mots) `key` dans le morceau. */
const replaceWord = (chunk: string, key: string, by: string) =>
  ` ${chunk} `.replace(` ${key} `, ` ${by} `).trim();

const OU_WITH_LINE = /((?:^| )(?:over|under|plus de|moins de|au dessus de|en dessous de) )(\d{1,2}(?:\.\d{1,2})?)(?= |$)/;
const OU_WITHOUT_LINE = /((?:^| )(?:over|under|plus de|moins de))(?= |$)/;

/**
 * Les réponses possibles à un échec, chacune sous forme de commande
 * réécrite. Seuls les échecs qui ADMETTENT une réponse en ont : équipe ou
 * joueur ambigu, ligne manquante ou refusée, total du match ou de l'équipe.
 */
function choicesFor(f: SlipFailure, chunks: readonly string[], i: number, ctx: SlipContext): SlipChoice[] {
  const chunk = chunks[i];
  const withChunk = (c: string) => chunks.map((x, j) => (j === i ? c : x)).join(' et ');
  const lineChoices = (market: SlipMarket, re: RegExp, lines: readonly number[]): SlipChoice[] =>
    lines.map((line) => ({ kind: 'line' as const, market, line, text: withChunk(chunk.replace(re, (_m, pre: string) => `${pre}${re === OU_WITHOUT_LINE ? ' ' : ''}${line}`)) }));
  const d = f.detail;
  if (!d) return [];
  switch (d.kind) {
    case 'team':
      return d.candidates.map((abbr) => ({ kind: 'team' as const, abbr, text: withChunk(replaceWord(chunk, d.alias, uniqueAlias(abbr))) }));
    case 'player':
      return d.candidates.map((p) => ({
        kind: 'player' as const, ...p,
        text: withChunk(replaceWord(chunk, d.alias, `${normalizeName(p.name)} ${uniqueAlias(p.teamAbbr)}`)),
      }));
    case 'line_missing':
      return lineChoices(d.market, OU_WITHOUT_LINE, d.options);
    case 'line':
      return lineChoices(d.market, OU_WITH_LINE, d.options);
    case 'spelling':
      return d.fixes.map((fx): SlipChoice => (fx.kind === 'team'
        ? { kind: 'team', abbr: fx.abbr, text: withChunk(fx.chunk) }
        : { kind: 'player', id: fx.id, name: fx.name, teamAbbr: fx.teamAbbr, text: withChunk(fx.chunk) }));
    case 'total_scope': {
      const g = ctx.games.find((x) => x.id === d.gameId);
      if (!g) return [];
      const opp = g.homeAbbr.toUpperCase() === d.team.toUpperCase() ? g.awayAbbr : g.homeAbbr;
      return [
        { kind: 'game_total', line: d.line, text: withChunk(`${chunk} ${uniqueAlias(opp)}`) },
        ...lineChoices('team_total_goals', OU_WITH_LINE, ctx.lines.team_total_goals ?? []),
      ];
    }
    default:
      return [];
  }
}

// ── Fautes de frappe (2026-09-29) ───────────────────────────────────────────

/**
 * Distance d'édition de Damerau-Levenshtein restreinte : une lettre ajoutée,
 * retirée, remplacée, ou deux lettres voisines inversées (« Caufeild ») comptent
 * chacune pour 1. Au-delà de `max`, rend `max + 1` sans calculer.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = b.length;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return Math.min(prev[m], max + 1);
}

/**
 * Fautes tolérées selon la longueur du mot tapé (lettres seules) : aucune
 * sous 4 lettres — « Aho », « ny », « oil » se tapent sans faute ou pas du
 * tout —, 1 jusqu'à 5, 2 jusqu'à 8, 3 au-delà.
 */
const typoBudget = (len: number) => (len < 4 ? 0 : len <= 5 ? 1 : len <= 8 ? 2 : 3);

/**
 * Mots de remplissage qu'on ne tente JAMAIS de corriger en nom : « ajoute
 * les Habs », « mets-moi Suzuki », « contre Toronto ».
 */
const FILLER_WORDS = new Set([
  ...SURNAME_STOPWORDS,
  'ajoute', 'ajouter', 'ajouts', 'add', 'mets', 'met', 'mettre', 'moi', 'me', 'my', 'mon', 'ma', 'mes',
  'je', 'veux', 'voudrais', 'want', 'i', 'please', 'pls', 'svp', 'stp', 'merci', 'thanks',
  'contre', 'against', 'avec', 'with', 'dans', 'in', 'a', 'un', 'une', 'on', 'at', 'for', 'of', 'to',
  'match', 'matchs', 'game', 'games', 'partie', 'equipe', 'team', 'joueur', 'player',
  'pari', 'paris', 'bet', 'bets', 'parlay', 'combine', 'coupon', 'slip',
  'prochain', 'prochaine', 'next', 'soiree', 'nuit', 'night', 'cette', 'this', 'is', 'est', 'va', 'vont', 'will',
  'total', 'totals', 'plus', 'yes', 'oui',
  // Mots courants à une lettre d'un surnom : « sans » / Sens, « stats » / Stars,
  // « leads » / Leafs, « cars » / Caps.
  'sans', 'stats', 'stat', 'start', 'starts', 'lead', 'leads', 'cars', 'blue', 'king', 'leaf', 'will', 'mild',
]);

interface NameTarget {
  /** Le nom tel qu'indexé, sans espaces (« redwings », « nicksuzuki »). */
  compact: string;
  team?: readonly string[];
  players?: readonly SlipPlayer[];
}

const targetsCache = new WeakMap<readonly SlipPlayer[], NameTarget[]>();

/**
 * Tout ce qu'un mot mal écrit peut viser : surnoms d'équipe d'au moins
 * 4 lettres (les abréviations sont trop courtes pour être corrigées sans
 * risque), noms complets et noms de famille des joueurs du contexte.
 */
function nameTargets(players: readonly SlipPlayer[]): NameTarget[] {
  const cached = targetsCache.get(players);
  if (cached) return cached;
  const out: NameTarget[] = [];
  const compact = (k: string) => k.replace(/ /g, '');
  for (const [key, abbrs] of TEAM_ALIAS_INDEX) {
    if (compact(key).length >= 4) out.push({ compact: compact(key), team: abbrs });
  }
  const pidx = playerIndex(players);
  for (const [key, group] of pidx.full) out.push({ compact: compact(key), players: group });
  for (const [key, group] of pidx.surname) out.push({ compact: compact(key), players: group });
  targetsCache.set(players, out);
  return out;
}

/**
 * Les groupes de mots que l'analyseur n'a PAS reconnus, dans l'ordre : les noms
 * exacts, les mots-clés, les nombres et le remplissage sont blanchis ; deux
 * mots restent voisins seulement si rien n'a été blanchi entre eux.
 */
function unrecognizedRuns(chunk: string, ctx: SlipContext): string[][] {
  const w: Work = { rest: ` ${chunk} ` };
  const pidx = playerIndex(ctx.players);
  extractKeys(w, pidx.fullKeys);
  extractKeys(w, TEAM_ALIAS_KEYS);
  extractKeys(w, pidx.surnameKeys);
  for (const re of [RE.negation, RE.today, RE.tomorrow, RE.btts, RE.firstGoal, RE.regulation, RE.ot, RE.puck,
    RE.over, RE.under, RE.ouWord, RE.shots, RE.points, RE.assists, RE.saves, RE.scoreVerb, RE.goalNoun, RE.win]) {
    takeFlag(w, re);
  }
  const runs: string[][] = [];
  let run: string[] = [];
  let lastEnd = -2;
  const tokRe = /\S+/g;
  for (let m = tokRe.exec(w.rest); m; m = tokRe.exec(w.rest)) {
    const tok = m[0];
    const usable = !HAS_DIGIT.test(tok) && !FILLER_WORDS.has(tok);
    // Un seul espace depuis le mot précédent = voisins ; plus = quelque chose a été blanchi entre eux.
    if (!usable || m.index !== lastEnd + 1) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (usable) run.push(tok);
    lastEnd = m.index + tok.length;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Même pari ? Sert à ne pas poser de question dont la réponse ne change rien. */
const sameIntent = (a: SlipIntent, b: SlipIntent) =>
  a.subjectType === b.subjectType && a.subjectId === b.subjectId && a.marketType === b.marketType
  && a.selection === b.selection && (a.line ?? null) === (b.line ?? null) && a.gameId === b.gameId;

/** Nombre maximal de noms proposés pour un mot mal écrit. */
const MAX_SPELLING_FIXES = 5;

/**
 * Cherche un nom mal écrit dans le morceau et rend les corrections plausibles.
 *
 * Chaque correction est VÉRIFIÉE : le morceau réécrit est ré-analysé, et elle
 * n'est gardée que s'il avance — `need: 'progress'` : il cesse d'être
 * incompris (un « ne joue pas ce soir » est une vraie réponse) ; `need: 'ok'` :
 * il devient un pari valide — et, si le morceau passait déjà, un pari
 * DIFFÉRENT de `current` : sinon la question ne changerait rien. Un mot sans voisin plausible ne rend rien — la phrase suit alors son
 * chemin normal (LLM compris).
 *
 * `strict` (le morceau a déjà été compris) : la première lettre doit
 * correspondre, pour ne pas questionner le joueur sur un mot de remplissage.
 */
function findSpellingFixes(
  chunk: string, ctx: SlipContext, carry: Carry | null,
  opts: { strict: boolean; need: 'ok' | 'progress'; current?: SlipIntent },
): { word: string; fixes: SpellingFix[] } | null {
  const targets = nameTargets(ctx.players);
  const pidx = playerIndex(ctx.players);

  // Chaque groupe d'1 à 3 mots voisins non reconnus, avec ses noms proches.
  type Hit = { d: number; target: NameTarget };
  const phrases: { phrase: string; score: number; hits: Hit[] }[] = [];
  for (const run of unrecognizedRuns(chunk, ctx)) {
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const phrase = run.slice(i, i + n).join(' ');
        const typed = phrase.replace(/ /g, '');
        // Morceau déjà compris : au moins 5 lettres, une seule faute tolérée
        // jusqu'à 8 — on dérange le joueur seulement pour un nom très probable.
        const budget = !opts.strict ? typoBudget(typed.length)
          : typed.length < 5 ? 0 : Math.min(typoBudget(typed.length), typed.length <= 8 ? 1 : 2);
        if (!budget) continue;
        const hits: Hit[] = [];
        for (const target of targets) {
          if (opts.strict && target.compact[0] !== typed[0]) continue;
          const d = editDistance(typed, target.compact, budget);
          if (d <= budget) hits.push({ d, target });
        }
        if (!hits.length) continue;
        const best = Math.min(...hits.map((h) => h.d));
        // Les plus proches seulement ; un cran de plus pour un mot long, où
        // deux fautes restent plausibles (« Vasilevsky », « Kucheruv »).
        const spread = typed.length >= 8 ? 1 : 0;
        phrases.push({ phrase, score: best / typed.length, hits: hits.filter((h) => h.d <= best + spread) });
      }
    }
  }
  // Le groupe le plus proche d'un nom d'abord ; à égalité, le plus long.
  phrases.sort((a, b) => a.score - b.score || b.phrase.length - a.phrase.length);

  for (const { phrase, hits } of phrases) {
    hits.sort((a, b) => a.d - b.d);
    const fixes: SpellingFix[] = [];
    const seen = new Set<string>();
    const tryFix = (fix: SpellingFix, key: string) => {
      if (seen.has(key) || fixes.length >= MAX_SPELLING_FIXES) return;
      seen.add(key);
      const r = parseChunkExact(fix.chunk, ctx, carry);
      if (opts.need === 'ok' ? !r.ok : !r.ok && r.reason === 'unknown') return;
      if (r.ok && opts.current && sameIntent(r.intent, opts.current)) return;
      fixes.push(fix);
    };
    for (const { target } of hits) {
      for (const abbr of target.team ?? []) {
        tryFix({ kind: 'team', abbr, chunk: replaceWord(chunk, phrase, uniqueAlias(abbr)) }, `t:${abbr}`);
      }
      for (const p of target.players ?? []) {
        const full = normalizeName(p.name);
        // Deux joueurs du même nom (« Sebastian Aho ») : l'équipe tranche.
        const name = (pidx.full.get(full)?.length ?? 0) > 1 ? `${full} ${uniqueAlias(p.teamAbbr)}` : full;
        tryFix({ kind: 'player', id: p.id, name: p.name, teamAbbr: p.teamAbbr.toUpperCase(), chunk: replaceWord(chunk, phrase, name) }, `p:${p.id}`);
      }
    }
    if (fixes.length) return { word: phrase, fixes };
  }
  return null;
}

/** Échecs où un nom mal écrit peut être la cause : phrase incomprise, match introuvable. */
const SPELLING_CAN_EXPLAIN = (f: SlipFailure) =>
  f.reason === 'unknown' || f.reason === 'no_game' || f.detail?.kind === 'game_missing';

/**
 * Analyse un morceau, puis cherche un nom mal écrit :
 *   - morceau en échec : un nom proche qui le rend lisible est proposé ;
 *   - morceau compris : un mot resté inconnu qui ressemble à un nom
 *     (« Habs gagne contre Torronto ») est signalé plutôt qu'ignoré, parce
 *     qu'il change le pari (le match contre Toronto, pas le prochain match).
 */
function parseChunk(chunk: string, ctx: SlipContext, carry: Carry | null): ChunkResult {
  const r = parseChunkExact(chunk, ctx, carry);
  if (!r.ok && !SPELLING_CAN_EXPLAIN(r)) return r;
  // Morceau compris : on ne questionne que si la correction mène à un AUTRE
  // pari valide (« Habs gagne contre Torronto » : le match contre Toronto, pas
  // le prochain match des Habs). Morceau « pas de match » : la correction doit
  // aboutir à un vrai pari, sinon la question n'avance à rien (« Oilers gagne
  // au Canada » ne doit pas proposer les Ducks — « canards »).
  const opts = r.ok ? { strict: true, need: 'ok' as const, current: r.intent }
    : r.reason === 'no_game' ? { strict: false, need: 'ok' as const }
    : { strict: false, need: 'progress' as const };
  const found = findSpellingFixes(chunk, ctx, carry, opts);
  if (!found) return r;
  return { ok: false, reason: 'ambiguous', chunk, detail: { kind: 'spelling', word: found.word, fixes: found.fixes } };
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
  for (const [i, chunk] of chunks.entries()) {
    const r = parseChunk(chunk, ctx, carry);
    if (!r.ok) {
      const choices = choicesFor(r, chunks, i, ctx);
      return choices.length ? { ...r, choices } : r;
    }
    const key = [r.intent.subjectType, r.intent.subjectId, r.intent.marketType, r.intent.selection, r.intent.line ?? '', r.intent.gameId].join('|');
    if (!seen.has(key)) { seen.add(key); intents.push(r.intent); }
    carry = r.carry;
  }
  return { ok: true, intents };
}
