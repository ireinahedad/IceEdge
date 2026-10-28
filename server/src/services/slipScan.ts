/**
 * slipScan.ts — SCAN_TICKET_PLAN § 3 (S2). Lecture OCR d'une capture de ticket → jambes.
 *
 *   capture ──OCR appareil──► OcrResult (lignes + boîtes)
 *           ──scanSlip──────► groupes (1 cote = 1 groupe) de jambes, chacune avec un ÉTAT (§ 3.6)
 *                             et, si elle est lisible, une `SlipIntent` passée par `validateIntent`.
 *
 * Ce module NE chiffre rien : la probabilité d'une jambe vient toujours de `buildLeg`
 * (comme une jambe ajoutée à la main), celle du coupon de `/predict/parlay`.
 *
 * ⚠️ PARTAGÉ AVEC LE CLIENT, comme `slipCommand.ts` : aucune dépendance Node, aucun
 * appel réseau, pas de lookbehind dans les regex (Safari < 16.4). Le client
 * l'importera tel quel ; il est testé ici (`slipScan.test.ts`, sur les fixtures).
 * ⚠️ Le mot du nom de l'onglet principal de DraftKings (« S…BOOK ») est interdit dans
 * le bundle iOS (garde de `build-ios.mjs`) : il ne doit pas apparaître en clair ici.
 * Sa barre d'onglets est reconnue par « quick parlay » / « flash bet ».
 *
 * RÈGLE D'OR, reprise de `slipCommand.ts` : dans le doute, on ne devine pas. Une jambe
 * mal lue ressort `unreadable` ou `ambiguous`, jamais `ok` avec une mauvaise intention.
 *
 * VIE PRIVÉE (§ 3.1, § 6) : mise, gains, solde, n° de pari, heure du pari et nom de
 * l'auteur d'un partage sont jetés au nettoyage. Aucune ligne jetée ne ressort.
 *
 * Gabarits : bet365 (FR + EN), DraftKings (carte de partage, onglet social, « My Activity »)
 * et FanDuel (2026-10-28). Un autre bookmaker passe par le gabarit bet365, sans garantie.
 */

import type { OcrLine, OcrResult } from './ocrTypes';
import {
  SLIP_COMMAND_MARKETS, TEAM_ALIAS_INDEX, editDistance, normalizeName, validateIntent,
} from './slipCommand';
import type { SlipContext, SlipGame, SlipIntent, SlipMarket, SlipPlayer } from './slipCommand';

// ── Types publics ────────────────────────────────────────────────────────────

export type ScanBook = 'bet365' | 'draftkings' | 'fanduel' | 'other';
export type ScanLang = 'fr' | 'en';
export type OddsFormat = 'american' | 'decimal' | 'fractional';

/** États d'une jambe scannée (SCAN_TICKET_PLAN § 3.6). */
export type ScanLegState =
  | 'ok' | 'ambiguous' | 'unsupported_market' | 'unsupported_line' | 'no_game' | 'unreadable';

/** Ce que le texte d'une jambe dit, avant toute résolution contre le contexte. */
export interface ParsedLeg {
  subjectType: 'team' | 'player' | 'game';
  /** Texte qui désigne l'équipe ou le joueur, normalisé (vide pour `game`). */
  subjectText: string;
  /** `null` = marché reconnu mais non couvert par ICEEDGE (« 2+ goals »…). */
  marketType: SlipMarket | null;
  /** `over` / `under` / `yes`, ou `team` = « l'équipe sujet » (moneyline, puck line). */
  selection: 'over' | 'under' | 'yes' | 'team';
  line?: number;
}

export interface ScanCandidate { id: string; name: string; teamAbbr: string }

export interface ScanLeg {
  /** Lignes du ticket qui décrivent la jambe (texte OCR, données personnelles exclues). */
  text: string[];
  state: ScanLegState;
  parsed?: ParsedLeg;
  /**
   * `ok` : l'intention validée. `unsupported_line` : l'intention qu'elle SERAIT si la
   * ligne était couverte (pour S8) — jamais à charger dans le coupon.
   */
  intent?: SlipIntent;
  /** `ambiguous` : les choix à proposer (même UI que « quel Hughes ? »). */
  candidates?: ScanCandidate[];
}

export interface ScanGroup {
  /** `sgp` = « Same Game Parlay » / « Pari personnalisé » : UNE cote pour plusieurs jambes. */
  kind: 'single' | 'sgp';
  /** Cote telle qu'affichée (signe moins ASCII), ou null. */
  odds: string | null;
  /** Match lu SUR LE TICKET (away @ home), ou null s'il n'y est pas (carte coupée). */
  game: { away: string; home: string } | null;
  /** Match résolu dans le contexte (lu ou déduit des jambes), ou null → jambes `no_game`. */
  gameId: string | null;
  legs: ScanLeg[];
}

export interface SlipScanResult {
  book: ScanBook;
  lang: ScanLang;
  oddsFormat: OddsFormat | null;
  groups: ScanGroup[];
  /** Cote totale affichée, ou celle de l'unique groupe ; null sinon. */
  totalOdds: string | null;
  /**
   * Cote boostée (« Profit Boost ») sur le ticket. Si `totalOdds` est null, la cote
   * réellement payée n'a pas été lue : le ticket ne doit PAS être chiffré avec le
   * produit des jambes (ce serait le prix d'avant le boost).
   */
  boosted: boolean;
}

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Minuscules, sans accents, signes moins typographiques → « - », espaces insécables,
 * virgule décimale → point, « ½ » → « .5 ». Garde « + : - . | @ » utiles au parseur.
 */
export function normScan(s: string): string {
  return (s || '')
    .replace(/½/g, '.5')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/[  ]/g, ' ')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Signe moins typographique → ASCII, espaces retirés (« −130 » → « -130 »). */
const asciiOdds = (s: string) => s.replace(/[−–—]/g, '-').replace(/\s+/g, '').replace(/^~(?=\d)/, '-');

/**
 * Cote américaine EN FIN de ligne (« -390 », « : +114 », « EDM Oilers ~180 » : l'OCR lit
 * parfois « − » comme « ~ »). Sans signe (« 172 »), ce n'est pas une cote : null —
 * mieux vaut une cote manquante qu'une cote fausse.
 */
export function trailingAmerican(raw: string): string | null {
  const m = (raw || '').trim().match(/(?:^|[\s:])([+\-−–~])\s?(\d{3,4})$/);
  return m ? `${m[1] === '+' ? '+' : '-'}${m[2]}` : null;
}

/** Toutes les cotes américaines d'un texte, dans l'ordre (« +233 +302 » → les deux). */
function americanTokens(raw: string): string[] {
  return [...(raw || '').matchAll(/(?:^|\s)([+\-−–~])(\d{3,5})(?=\s|$)/g)].map((m) => `${m[1] === '+' ? '+' : '-'}${m[2]}`);
}

// ── Cotes (§ 3.2) ────────────────────────────────────────────────────────────

const AMERICAN = /^[+-]\d{3,5}$/;
const DECIMAL = /^\d{1,3}\.\d{2,3}$/;
const FRACTIONAL = /^\d{1,3}\/\d{1,3}$/;

export function oddsFormatOf(odds: string): OddsFormat | null {
  const o = asciiOdds(odds);
  if (AMERICAN.test(o)) return 'american';
  if (DECIMAL.test(o)) return 'decimal';
  if (FRACTIONAL.test(o)) return 'fractional';
  return null;
}

/** Cote affichée → décimale (null si illisible ou absurde). */
export function oddsToDecimal(odds: string): number | null {
  const o = asciiOdds(odds);
  const f = oddsFormatOf(o);
  if (f === 'american') {
    const n = Number(o);
    if (Math.abs(n) < 100) return null;
    return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  }
  if (f === 'decimal') {
    const d = Number(o);
    return d > 1 ? d : null;
  }
  if (f === 'fractional') {
    const [a, b] = o.split('/').map(Number);
    return b > 0 ? 1 + a / b : null;
  }
  return null;
}

/** Probabilité implicite BRUTE (marge incluse : le prix que le joueur paie), 0–100. */
export function impliedProbability(odds: string): number | null {
  const d = oddsToDecimal(odds);
  return d ? Math.round((1000 / d)) / 10 : null;
}

// ── Nettoyage (§ 3.1) ───────────────────────────────────────────────────────

/** Montants d'argent : mise, gains, solde. Une ligne qui en porte est jetée entière. */
const MONEY = /(\$\s?\d)|(\d[\d\s]*[.,]\d{2}\s?\$)|(\d[.,]\d{2}\s?(€|eur))|(€\s?\d)/i;
/** Heure d'horloge (barre d'état, heure du pari, heure du match). */
const CLOCK = /\b\d{1,2}[:h]\d{2}(?:\s?[ap]m)?\b/;

/**
 * Bruit d'interface (normalisé). Une ligne qui en contient un est jetée entière :
 * aucun de ces mots ne fait partie d'un libellé de jambe.
 */
const NOISE = [
  // bet365
  'reuse selections', 'reutiliser', 'selections', 'share', 'track', 'cash out', 'suivre',
  'mes paris', 'my bets', 'en cours', 'en direct', 'termine', 'all sports', 'casino',
  'mise', 'gains', 'potential', 'stake', 'to return', 'bet placed', 'pari place',
  // DraftKings
  'quick parlay', 'flash bet', 'betting groups', 'my friends', 'dk network', 'show chat',
  'show bets', 'invite a friend', 'more bets', 'morebets', 'view picks', 'dkn picks',
  'people placed', 'odds are subject', 'subject to change', 'my activity', 'horse bets', 'pick em',
  // FanDuel
  'rewards', 'pts pending', 'profit boost',
];
const NOISE_RE = new RegExp(`(?:^|[^a-z])(?:${NOISE.map((w) => w.replace(/ /g, '\\s?')).join('|')})(?:[^a-z]|$)`);

/** Mots qui disent « ceci est un marché » : une ligne qui en porte n'est pas une carte de match. */
const MARKET_HINT = /(money ?line|ligne d argent|total|over|under|plus de|moins de|\d\+|points?|shots?|goals?|buts?|assists?|passes|saves|arrets|puck ?line|spread|ecart|handicap|score|buteur|tirs?)/;

export interface CleanLine extends OcrLine {
  /** Texte normalisé (`normScan`). */
  n: string;
}

/**
 * Lignes gardées pour l'analyse. Jetées : argent (mise, gains, solde), bruit
 * d'interface, horloge sans équipe (barre d'état, heure du pari, auteur d'un partage),
 * lignes trop pauvres pour porter un libellé.
 */
export function cleanLines(ocr: OcrResult): CleanLine[] {
  const out: CleanLine[] = [];
  for (const l of [...ocr.lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const raw = (l.text || '').trim();
    if (!raw) continue;
    if (MONEY.test(raw)) continue;
    const n = normScan(raw);
    if (NOISE_RE.test(n)) continue;
    const letters = (n.match(/[a-z]/g) || []).length;
    const isOdds = oddsFormatOf(raw) !== null || trailingAmerican(raw) !== null;
    if (!isOdds && letters < 3) continue;
    if (CLOCK.test(n) && !teamsIn(n).length && !/@/.test(n)) continue;
    out.push({ ...l, text: raw, n });
  }
  return out;
}

// ── Équipes ─────────────────────────────────────────────────────────────────

/**
 * Alias propres aux tickets : bet365 écrit « WAS » pour Washington. Ajoutés ici
 * seulement — dans une phrase tapée, « was » est un mot anglais.
 */
const SCAN_ALIASES: Record<string, string> = { was: 'WSH' };

const ALIAS_KEYS = [...TEAM_ALIAS_INDEX.keys(), ...Object.keys(SCAN_ALIASES)]
  .sort((a, b) => b.length - a.length || a.localeCompare(b));

/**
 * Équipes nommées dans un texte, dans l'ordre d'apparition (abréviations NHL).
 * Les alias à collision (« ny », « new york ») ne comptent que si rien d'autre ne
 * départage ; un texte qui ne désigne que des collisions ne rend rien.
 */
export function teamsIn(text: string): string[] {
  let rest = ` ${normalizeName(text)} `;
  const hits: { at: number; abbrs: readonly string[] }[] = [];
  for (const key of ALIAS_KEYS) {
    const needle = ` ${key} `;
    let at = rest.indexOf(needle);
    while (at !== -1) {
      const abbrs = TEAM_ALIAS_INDEX.get(key) ?? (SCAN_ALIASES[key] ? [SCAN_ALIASES[key]] : []);
      hits.push({ at, abbrs });
      rest = rest.slice(0, at + 1) + ' '.repeat(key.length) + rest.slice(at + 1 + key.length);
      at = rest.indexOf(needle, at + 1);
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const sure = hits.filter((h) => h.abbrs.length === 1).map((h) => h.abbrs[0]);
  const out: string[] = [];
  for (const a of sure) if (!out.includes(a)) out.push(a);
  return out;
}

// ── Vocabulaire bookmaker → marchés (§ 3.4, EN + FR fusionnés) ─────────────

/** Mot de marché d'un prop « N+ … » → marché ICEEDGE. */
const PROP_WORDS: [RegExp, SlipMarket][] = [
  [/^(shots on goal|shots on target|shots|sog|tirs au but|tirs cadres|tirs au filet|tirs)$/, 'shots_ou'],
  [/^(points|point|pts)$/, 'points_ou'],
  [/^(assists|assist|passes|passe|aides|aide)$/, 'assists_ou'],
  [/^(saves|save|goalie saves|arrets|arret|arrets du gardien)$/, 'goalie_saves_ou'],
  [/^(goals|goal|buts|but)$/, 'anytime_goal'],
];

/** Sous-titres de catégorie (ligne sous la jambe chez bet365, « Total FT » chez DraftKings). */
const CATEGORY = /^(m?oneyline|money ?line|moneyline|ligne d argent|team total|total de l equipe|total|total de points|total de buts|total ft.*|game total|points|shots on goal|tirs au but|tirs|assists|passes|saves|arrets|anytime goal ?scorer|buteur a tout moment|first goal ?scorer|premier buteur|puck ?line|spread|ecart|handicap|60 min line|3 way|resultat 60 min)$/;

const PROP_ALT = 'shots on goal|shots on target|shots|sog|tirs au but|tirs cadres|tirs|points|point|pts|assists|assist|passes|aides|saves|arrets|goals|goal|buts|but';
const NUM = '(\\d{1,2}(?:\\.\\d{1,2})?)';
const OU = '(over|under|plus de|moins de|o|u)';

const ouSel = (w: string): 'over' | 'under' => (/^(over|plus de|o)$/.test(w) ? 'over' : 'under');

/** Puces et débris d'OCR en tête de ligne (« o », « © », « ® », « (QO », « « »…). */
function stripBullet(n: string): string {
  return n
    .replace(/^[^a-z0-9]+/, '')
    .replace(/^(?:[oa]|qo|oo|ooo)\s+(?=[a-z0-9])/, '')
    .replace(/^[^a-z0-9]+/, '')
    .trim();
}

/** Débris de fin de ligne : « EARLY PAYOUT », barres, parenthèses orphelines. */
function stripTail(n: string): string {
  return n
    .replace(/\s+early payout.*$/, '')
    .replace(/\s+boost(?:ed)?.*$/, '')
    .replace(/[\s|()\]}>»«*+]+$/, (m) => (/\d\+$/.test(n) ? m : ''))
    .trim();
}

/**
 * Lit le texte d'UNE jambe (ligne principale + sous-titre de catégorie éventuel).
 * Rend null si rien n'est reconnu. Aucune résolution : pas de contexte ici.
 */
export function parseLegText(main: string, subtitle = ''): ParsedLeg | null {
  const m0 = stripTail(stripBullet(normScan(main)));
  const sub = normScan(subtitle);
  let m: RegExpMatchArray | null;

  // « Nathan MacKinnon: 1+ Points » / « Nicholas Suzuki - 1+ points » (bet365)
  if ((m = m0.match(new RegExp(`^(.+?)\\s*(?::|\\s-\\s)\\s*(\\d{1,2})\\s?\\+\\s+(${PROP_ALT})$`)))) {
    return prop(m[1], Number(m[2]), m[3]);
  }
  // « 3+ | Tage Thompson Shots on Goal » (DraftKings, seuil AVANT le nom ; « | » lu « I », « l », « 1 »)
  if ((m = m0.match(new RegExp(`(\\d{1,2})\\s?\\+\\s*(?:[|il1!]\\s+)?([a-z].+?)\\s+(${PROP_ALT})$`)))) {
    return prop(m[2], Number(m[1]), m[3]);
  }
  // « Money Line - UTA Mammoth »
  if ((m = m0.match(/^(?:money ?line|moneyline|ligne d argent|to win|vainqueur du match)\s*[-:]\s*(.+)$/))) {
    return { subjectType: 'team', subjectText: m[1], marketType: 'moneyline', selection: 'team' };
  }
  // « UTA Mammoth Total: Over 2.5 Goals »
  if ((m = m0.match(new RegExp(`^(.+?)\\s+total\\s*:?\\s+${OU}\\s?${NUM}(?:\\s+(?:goals?|buts?))?$`)))) {
    return { subjectType: 'team', subjectText: m[1], marketType: 'team_total_goals', selection: ouSel(m[2]), line: Number(m[3]) };
  }
  // « Over 6.5 » / « Plus de 5.5 buts » / « o6.5 » : total du MATCH (le sous-titre peut dire « Team Total »)
  if ((m = m0.match(new RegExp(`^${OU}\\s?${NUM}(?:\\s+(?:goals?|buts?))?$`)))) {
    if (/team total|total de l equipe/.test(sub)) return null; // l'équipe est sur une autre ligne : pas deviné
    return { subjectType: 'game', subjectText: '', marketType: 'total_goals', selection: ouSel(m[1]), line: Number(m[2]) };
  }
  // « TOR Maple Leafs -1.5 » + sous-titre Puck Line / Spread
  if ((m = m0.match(/^(.+?)\s+([+-]\d(?:\.\d)?)$/)) && /puck ?line|spread|ecart|handicap/.test(sub)) {
    return { subjectType: 'team', subjectText: m[1], marketType: 'puck_line', selection: 'team', line: Number(m[2]) };
  }
  // Nom d'équipe seul + sous-titre Money Line (DraftKings, FanDuel)
  if (sub && isMoneylineCategory(sub)) {
    const team = m0.replace(/\s+\d[\d\s.]*$/, '').trim();
    if (teamsIn(team).length === 1) return { subjectType: 'team', subjectText: team, marketType: 'moneyline', selection: 'team' };
    // Une équipe d'un AUTRE sport (« CLE Cavaliers ») : lisible, mais pas un pari LNH.
    if (teamsIn(team).length === 0 && /[a-z]{3,}\s+[a-z]{3,}/.test(team)) {
      return { subjectType: 'team', subjectText: team, marketType: null, selection: 'team' };
    }
  }
  // Buteur : « Auston Matthews - Anytime Goalscorer » ou nom seul + sous-titre
  if ((m = m0.match(/^(.+?)\s*[-:]?\s*(?:anytime goal ?scorer|to score|anytime goal|buteur a tout moment|marquer un but)$/))) {
    return { subjectType: 'player', subjectText: m[1], marketType: 'anytime_goal', selection: 'yes' };
  }
  if (/^(anytime goal ?scorer|buteur a tout moment|to score)$/.test(sub) && /^[a-z .'-]{4,}$/.test(m0)) {
    return { subjectType: 'player', subjectText: m0, marketType: 'anytime_goal', selection: 'yes' };
  }
  return null;
}

/** « N+ marché » → plus de N − 0.5 (« 1+ points » = plus de 0.5 point). */
function prop(name: string, n: number, word: string): ParsedLeg {
  const market = PROP_WORDS.find(([re]) => re.test(word))?.[1] ?? null;
  const subjectText = name.replace(/[^a-z .'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (market === 'anytime_goal') {
    // « 1+ goal » = marque ; « 2+ goals » n'est pas un marché ICEEDGE.
    return n === 1
      ? { subjectType: 'player', subjectText, marketType: 'anytime_goal', selection: 'yes' }
      : { subjectType: 'player', subjectText, marketType: null, selection: 'over', line: n - 0.5 };
  }
  return { subjectType: 'player', subjectText, marketType: market, selection: 'over', line: n - 0.5 };
}

/** Sous-titre de catégorie, débris d'OCR de 1 à 3 lettres en tête tolérés (« Nid Moneyline »). */
const isCategory = (n: string) => {
  const s = stripTail(stripBullet(n)).replace(/[^a-z0-9 ()]+$/, '').trim();
  return CATEGORY.test(s) || CATEGORY.test(s.replace(/^(?:[a-z]{1,3}\s+)+(?=[a-z]{4,})/, ''));
};
const isMoneylineCategory = (n: string) => isCategory(n) && /m?oneyline|money ?line|ligne d argent/.test(n);

// ── Détection du bookmaker et de la langue ──────────────────────────────────

const FR_WORDS = /\b(pari|personnalise|mise|gains|effectuer|plus de|moins de|buts|mer|jeu|ven|sam|dim|lun|mar|oct|nov|dec|janv|fevr|avr|arrets|tirs|passes)\b/g;
const EN_WORDS = /\b(same game parlay|money line|goals|shots|today|picks|parlay|over|under|stake|tue|wed|thu|fri|sat|sun|mon)\b/g;

function detect(ocr: OcrResult): { book: ScanBook; lang: ScanLang } {
  const all = ocr.lines.map((l) => normScan(l.text)).join('\n');
  const book: ScanBook =
    /bet365|same game parlay|pari personnalise|early payout|reuse selections|reutiliser les|effectuer un cash out/.test(all) ? 'bet365'
      : /fanduel|profit boost|\d+ leg parlay|pts pending/.test(all) ? 'fanduel'
        : /\d+ pick parlay|my activity|wager:/.test(all) ? 'draftkings'
          : /draftkings|\bdk\b|quick parlay|picks?\b.*\n?|total ft|odds are subject|people placed/.test(all) && /@/.test(all) ? 'draftkings'
            : 'other';
  const fr = (all.match(FR_WORDS) || []).length;
  const en = (all.match(EN_WORDS) || []).length;
  // Un ticket bet365 français garde des libellés anglais : les mots d'interface
  // français (« Mise », « Effectuer un Cash Out ») départagent.
  const lang: ScanLang = fr > en || /effectuer un|pari personnalise|gains potentiels|mes paris/.test(all) ? 'fr' : 'en';
  return { book, lang };
}

// ── Segmentation ─────────────────────────────────────────────────────────────

interface RawLeg { text: string[]; main: string; subtitle: string }
interface RawGroup { kind: 'single' | 'sgp'; odds: string | null; game: { away: string; home: string } | null; legs: RawLeg[]; closed: boolean }

const SGP_HEADER = /(same game parlay|pari personnalise|sgp)\b.*?(\d{1,3}\.\d{2})\s*$/;
const TRAILING_DECIMAL = /\s(\d{1,3}\.\d{2})$/;

/** Gabarit bet365 : en-tête SGP + cote, jambes à puce + sous-titre, carte du match APRÈS. */
function segmentBet365(lines: CleanLine[]): RawGroup[] {
  const groups: RawGroup[] = [];
  let cur: RawGroup | null = null;
  let pendingCard: string[] = [];

  const flushCard = () => {
    if (pendingCard.length >= 2) {
      const [away, home] = [teamsIn(pendingCard[0])[0], teamsIn(pendingCard[1])[0]];
      const target = [...groups].reverse().find((g) => !g.game);
      if (target && away && home && away !== home) { target.game = { away, home }; target.closed = true; }
    }
    pendingCard = [];
  };

  for (const l of lines) {
    const n = l.n;
    const h = n.match(SGP_HEADER);
    if (h) {
      flushCard();
      cur = { kind: 'sgp', odds: h[2], game: null, legs: [], closed: false };
      groups.push(cur);
      continue;
    }
    if (isCategory(n)) {
      const last = cur?.legs[cur.legs.length - 1];
      if (last && !last.subtitle) { last.subtitle = l.text; last.text.push(l.text); }
      continue;
    }
    // Carte de match : une équipe, aucun mot de marché.
    const teams = teamsIn(n);
    if (teams.length === 1 && !MARKET_HINT.test(stripBullet(n).replace(/\b\d{1,2}[:h-]\d{2}\b.*$/, ''))) {
      pendingCard.push(n);
      if (pendingCard.length === 2) flushCard();
      continue;
    }
    flushCard();

    let main = l.text;
    let odds: string | null = null;
    const t = n.match(TRAILING_DECIMAL);
    if (t) { odds = t[1]; main = main.replace(/\s\d{1,3}[.,]\d{2}\s*$/, ''); }
    if (!parseLegText(main) && !looksLikeLeg(n)) continue;

    if (odds || !cur || cur.closed) {
      cur = { kind: 'single', odds, game: null, legs: [], closed: false };
      groups.push(cur);
    }
    cur.legs.push({ text: [main], main, subtitle: '' });
  }
  flushCard();
  return groups.filter((g) => g.legs.length);
}

/** Une ligne illisible mais assez riche pour être une jambe (→ `unreadable`, repli LLM). */
function looksLikeLeg(n: string): boolean {
  const s = stripBullet(n);
  return (s.match(/[a-z]/g) || []).length >= 6 && MARKET_HINT.test(s);
}

const AT_GAME = /^(.+?)\s@\s(.+?)(?:\s*\|.*)?$/;

/** Équipes d'une ligne « AWAY … @ HOME … », avec la ligne suivante si le nom est coupé. */
function gameFrom(line: string, next?: string): { away: string; home: string } | null {
  const tryOne = (s: string) => {
    const m = normScan(s).match(AT_GAME);
    if (!m) return null;
    const away = teamsIn(m[1]);
    const home = teamsIn(m[2]);
    return away.length === 1 && home.length === 1 && away[0] !== home[0] ? { away: away[0], home: home[0] } : null;
  };
  return tryOne(line) ?? (next ? tryOne(`${line} ${next}`) : null);
}

/** Gabarit DraftKings : carte de partage (match AU-DESSUS) ou onglet social (cote → marché → match). */
function segmentDraftKings(lines: CleanLine[], width: number): { groups: RawGroup[]; total: string | null } {
  const header = lines.findIndex((l) => /parlay\s*\(\d+\s*picks?\)/.test(l.n));
  if (header !== -1) return segmentDkSocial(lines, header, width);

  // Carte de partage : « BUF Sabres @ FLA Panthers | Today » puis « 3+ | Tage Thompson Shots on Goal ».
  const groups: RawGroup[] = [];
  let total: string | null = null;
  let cur: RawGroup | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const odds = asciiOdds(l.text);
    if (AMERICAN.test(odds)) { total = odds; continue; }
    const g = gameFrom(l.text);
    if (g) { cur = { kind: 'single', odds: null, game: g, legs: [], closed: false }; groups.push(cur); continue; }
    if (!cur) continue;
    if (isCategory(l.n) && cur.legs.length) { const last = cur.legs[cur.legs.length - 1]; last.subtitle = l.text; last.text.push(l.text); continue; }
    if (parseLegText(l.text) || looksLikeLeg(l.n)) cur.legs.push({ text: [l.text], main: l.text, subtitle: '' });
  }
  return { groups: groups.filter((gr) => gr.legs.length), total };
}

function segmentDkSocial(lines: CleanLine[], header: number, width: number): { groups: RawGroup[]; total: string | null } {
  const h = lines[header];
  // Cote totale : la cote américaine à hauteur de l'en-tête.
  let total: string | null = null;
  const anchors: number[] = [];
  lines.forEach((l, i) => {
    if (!AMERICAN.test(asciiOdds(l.text))) return;
    if (Math.abs(l.box.y - h.box.y) <= h.box.h * 2 + 20 && total === null) total = asciiOdds(l.text);
    else if (l.box.x > width * 0.5) anchors.push(i);
  });
  // Résumé « Over 6.5, Over 6.5, Over 6.5 » : la sélection de chaque jambe, dans l'ordre
  // (l'OCR rate souvent la sélection dans la carte de la jambe). Ce n'est PAS une jambe.
  const summaryIdx = lines.findIndex((l, i) => i > header && i < (anchors[0] ?? lines.length) && l.n.includes(','));
  const summary = summaryIdx === -1 ? [] : lines[summaryIdx].text.split(',').map((s) => s.trim()).filter(Boolean);

  const groups: RawGroup[] = anchors.map((a, k) => {
    const end = anchors[k + 1] ?? lines.length;
    const block = lines.slice(a + 1, end);
    const sub = block.find((l) => isCategory(l.n));
    const gi = block.findIndex((l) => /\s@\s/.test(l.n));
    const game = gi === -1 ? null : gameFrom(block[gi].text, block[gi + 1]?.text);
    const own = block.find((l) => l !== sub && !/\s@\s/.test(l.n) && parseLegText(l.text, sub?.text ?? ''));
    const main = own?.text ?? summary[k] ?? '';
    const text = [main, sub?.text].filter((s): s is string => !!s);
    return { kind: 'single', odds: asciiOdds(lines[a].text), game, legs: [{ text, main, subtitle: sub?.text ?? '' }], closed: true };
  });
  return { groups, total };
}

/** Nom propre en fin de ligne, débris d'OCR en tête retirés (« fa Artemi Panarin » → « Artemi Panarin »). */
function personName(raw: string): string | null {
  const clean = (raw || '').replace(/[^A-Za-zÀ-ÿ' .-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = clean.match(/([A-ZÀ-Ý][a-zà-ÿ'.-]+(?:\s+[A-ZÀ-Ý][A-Za-zà-ÿ'.-]+){1,3})$/);
  return m ? m[1] : null;
}

/** « 2+ SHOTS ON GOAL » seul sur sa ligne (le nom est sur la ligne d'au-dessus) ; débris de ≤ 4 caractères tolérés. */
function propOnly(n: string): { n: number; word: string } | null {
  const s = stripBullet(n);
  const m = s.match(new RegExp(`^(.{0,4}?)\\s*(\\d{1,2})\\s?\\+\\s+(${PROP_ALT})$`));
  return m && !/[a-z]{3,}/.test(m[1]) ? { n: Number(m[2]), word: m[3] } : null;
}

/** Cotes américaines des lignes d'en-tête ; avec un boost, seule une 2e cote (la boostée) est sûre. */
function headerTotal(header: CleanLine[], boosted: boolean): string | null {
  const tokens = header.flatMap((l) => americanTokens(asciiOddsLine(l.text)));
  if (boosted) return tokens.length >= 2 ? tokens[tokens.length - 1] : null;
  return tokens[0] ?? null;
}
const asciiOddsLine = (s: string) => s.replace(/[−–—]/g, '-');

/**
 * Gabarit FanDuel : en-tête (« 6 leg parlay », cote, boost, résumé des jambes), puis par jambe :
 * cote, nom, marché (« 2+ SHOTS ON GOAL ») sur sa propre ligne, match « A @ B » en noms
 * complets, heure. Le match FERME la jambe.
 */
function segmentFanDuel(lines: CleanLine[], boosted: boolean): { groups: RawGroup[]; total: string | null } {
  const gameIdx = lines.map((l, i) => (gameFrom(l.text) ? i : -1)).filter((i) => i !== -1);
  const first = gameIdx[0] ?? lines.length;
  let headerEnd = -1;
  for (let i = 0; i < first; i++) {
    const n = lines[i].n;
    if (/parlay|\.\.\.|…/.test(n) || (n.includes(',') && /\d\s?\+/.test(n))) headerEnd = i;
  }
  const total = headerTotal(lines.slice(0, headerEnd + 1), boosted);
  const groups: RawGroup[] = [];
  let start = headerEnd + 1;
  for (const gi of gameIdx) {
    const seg = lines.slice(start, gi);
    start = gi + 1;
    const odds = seg.map((l) => trailingAmerican(l.text)).find((o): o is string => !!o) ?? null;
    const prop = seg.map((l) => ({ l, p: propOnly(l.n) })).find((x) => x.p);
    const cat = seg.find((l) => isCategory(l.n));
    let leg: RawLeg | null = null;
    if (prop) {
      const nameLine = seg.slice(0, seg.indexOf(prop.l)).reverse().find((l) => personName(l.text) && !trailingAmerican(l.text));
      const name = nameLine ? personName(nameLine.text) : null;
      if (name) leg = { text: [nameLine!.text, prop.l.text], main: `${name}: ${prop.p!.n}+ ${prop.p!.word}`, subtitle: '' };
    } else if (cat) {
      const main = seg.slice(0, seg.indexOf(cat)).reverse().find((l) => !trailingAmerican(l.text) || teamsIn(l.n).length);
      if (main) leg = { text: [main.text, cat.text], main: main.text.replace(/\s[+\-−–~]\d{3,4}\s*$/, ''), subtitle: cat.text };
    } else {
      const own = seg.find((l) => parseLegText(l.text));
      if (own) leg = { text: [own.text], main: own.text, subtitle: '' };
      else {
        const any = seg.find((l) => looksLikeLeg(l.n));
        if (any) leg = { text: [any.text], main: any.text, subtitle: '' };
      }
    }
    if (leg) groups.push({ kind: 'single', odds, game: gameFrom(lines[gi].text), legs: [leg], closed: true });
  }
  return { groups, total };
}

/**
 * Gabarit DraftKings « My Activity » : en-tête « 5 Pick Parlay | +2127 », résumé des équipes,
 * puis par jambe : (cote) · équipe ou joueur · catégorie (« Moneyline ») · carte de score
 * (« Final P1 P2 P3 T » + deux équipes, VISITEUR EN HAUT) ou ligne « A @ B ».
 */
function segmentDkActivity(lines: CleanLine[]): { groups: RawGroup[]; total: string | null } {
  const h = lines.findIndex((l) => /\d+\s*pick parlay/.test(l.n));
  const total = h === -1 ? null : (americanTokens(asciiOddsLine(lines[h].text))[0] ?? null);
  const groups: RawGroup[] = [];
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i];
    const prop = propOnly(l.n);
    if (!isCategory(l.n) && !prop) continue;
    // La ligne de la jambe : juste au-dessus (on saute une ligne qui n'est qu'une cote).
    let k = i - 1;
    while (k > h && /^[^a-z]*$/.test(lines[k].n)) k--;
    if (k <= h) continue;
    const mainLine = lines[k];
    if (mainLine.n.includes(',')) continue; // le résumé de l'en-tête n'est pas une jambe
    const odds = trailingAmerican(mainLine.text) ?? (k - 1 > h ? trailingAmerican(lines[k - 1].text) : null);
    const mainText = mainLine.text.replace(/\s[+\-−–~]\d{3,4}\s*$/, '');
    let leg: RawLeg;
    if (prop) {
      const name = personName(mainText);
      if (!name) continue;
      leg = { text: [mainLine.text, l.text], main: `${name}: ${prop.n}+ ${prop.word}`, subtitle: '' };
    } else {
      leg = { text: [mainLine.text, l.text], main: mainText, subtitle: l.text };
    }
    // Le match : carte de score (« Final ») ou ligne « A @ B » dans les 4 lignes suivantes.
    let game: { away: string; home: string } | null = null;
    const ahead = lines.slice(i + 1, i + 5);
    const at = ahead.findIndex((x) => /\s@\s/.test(x.n));
    const fin = ahead.findIndex((x) => /^\W*final\b/.test(x.n));
    if (at !== -1) game = gameFrom(ahead[at].text, ahead[at + 1]?.text);
    else if (fin !== -1) {
      const t1 = teamsIn(ahead[fin + 1]?.n ?? '')[0];
      const t2 = teamsIn(ahead[fin + 2]?.n ?? '')[0];
      const legTeam = teamsIn(mainText)[0];
      // Une ligne de la carte illisible (« LAKings ») : l'équipe de la jambe est l'autre côté.
      const away = t1 ?? (t2 && legTeam && legTeam !== t2 ? legTeam : undefined);
      const home = t2 ?? (t1 && legTeam && legTeam !== t1 ? legTeam : undefined);
      if (away && home && away !== home) game = { away, home };
    }
    groups.push({ kind: 'single', odds, game, legs: [leg], closed: true });
  }
  return { groups, total };
}

// ── Résolution contre le contexte (§ 3.5) ────────────────────────────────────

const lower = (s: string) => s.toLowerCase();

/** Match du jour (ou le prochain) qui oppose ces équipes. */
function findGameFor(ctx: SlipContext, teams: readonly string[]): SlipGame | null {
  const up = teams.map((t) => t.toUpperCase());
  const c = ctx.games
    .filter((g) => up.every((t) => g.homeAbbr.toUpperCase() === t || g.awayAbbr.toUpperCase() === t))
    .filter((g) => g.date >= ctx.today)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  return c[0] ?? null;
}

/**
 * Joueur désigné par un nom de ticket, parmi `pool`. Nom complet exact d'abord, puis
 * nom de famille (« Nicholas Suzuki » → Nick Suzuki ; « Sebastian Antero Aho » → Aho),
 * puis faute d'OCR proche → toujours `ambiguous`, jamais corrigé en silence.
 */
export function resolvePlayer(text: string, pool: readonly SlipPlayer[]):
  { ok: true; player: SlipPlayer } | { ok: false; candidates: SlipPlayer[] } {
  const t = normalizeName(text);
  if (!t) return { ok: false, candidates: [] };
  const exact = pool.filter((p) => normalizeName(p.name) === t);
  if (exact.length === 1) return { ok: true, player: exact[0] };
  if (exact.length > 1) return { ok: false, candidates: exact };

  const parts = t.split(' ');
  const last = parts[parts.length - 1];
  const first = parts[0];
  const bySurname = pool.filter((p) => {
    const pp = normalizeName(p.name).split(' ');
    return pp[pp.length - 1] === last;
  });
  // Même nom de famille : le prénom départage (« Nick » / « Nicholas » commencent pareil).
  const sameStart = bySurname.filter((p) => normalizeName(p.name).split(' ')[0].slice(0, 3) === first.slice(0, 3));
  if (sameStart.length === 1) return { ok: true, player: sameStart[0] };
  if (bySurname.length === 1 && parts.length >= 2) return { ok: true, player: bySurname[0] };
  if (bySurname.length > 1) return { ok: false, candidates: bySurname };

  // Faute d'OCR : on propose, on ne choisit pas.
  const budget = t.length <= 8 ? 1 : 2;
  const near = pool.filter((p) => editDistance(normalizeName(p.name), t, budget) <= budget);
  return { ok: false, candidates: near };
}

const MARKETS: ReadonlySet<string> = new Set(SLIP_COMMAND_MARKETS);

function resolveGroup(raw: RawGroup, ctx: SlipContext): ScanGroup {
  const parsed = raw.legs.map((l) => parseLegText(l.main, l.subtitle));

  // Le match : lu sur le ticket, sinon déduit des jambes (équipes nommées, joueurs connus).
  let game: SlipGame | null = raw.game ? findGameFor(ctx, [raw.game.away, raw.game.home]) : null;
  if (!game && !raw.game) {
    const teams = new Set<string>();
    parsed.forEach((p) => {
      if (!p) return;
      if (p.subjectType === 'team') teamsIn(p.subjectText).forEach((t) => teams.add(t));
      if (p.subjectType === 'player') {
        const r = resolvePlayer(p.subjectText, ctx.players);
        if (r.ok) teams.add(r.player.teamAbbr.toUpperCase());
      }
    });
    const cands = ctx.games.filter((g) => g.date >= ctx.today && [...teams].some((t) => g.homeAbbr === t || g.awayAbbr === t));
    const firstDate = cands.map((g) => g.date).sort()[0];
    const sameDay = cands.filter((g) => g.date === firstDate);
    if (sameDay.length === 1) game = sameDay[0];
  }

  const legs = raw.legs.map((l, i): ScanLeg => {
    const p = parsed[i];
    const base = { text: l.text };
    if (!p) return { ...base, state: 'unreadable' };
    if (p.marketType === null || !MARKETS.has(p.marketType)) return { ...base, state: 'unsupported_market', parsed: p };
    // Un sujet d'équipe qui ne nomme aucune équipe LNH n'est pas un pari LNH.
    if (p.subjectType === 'team' && !teamsIn(p.subjectText).length) return { ...base, state: 'unsupported_market', parsed: p };
    if (!game) return { ...base, state: 'no_game', parsed: p };

    const sides = [game.awayAbbr.toUpperCase(), game.homeAbbr.toUpperCase()];
    let subjectId: string;
    let selection: string;
    if (p.subjectType === 'game') {
      subjectId = game.id;
      selection = p.selection;
    } else if (p.subjectType === 'team') {
      const t = teamsIn(p.subjectText).filter((a) => sides.includes(a));
      if (t.length !== 1) return { ...base, state: 'ambiguous', parsed: p, candidates: sides.map((a) => ({ id: lower(a), name: a, teamAbbr: a })) };
      subjectId = lower(t[0]);
      selection = p.selection === 'team' ? subjectId : p.selection;
    } else {
      const pool = ctx.players.filter((q) => sides.includes(q.teamAbbr.toUpperCase()));
      const r = resolvePlayer(p.subjectText, pool);
      if (!r.ok) {
        return { ...base, state: 'ambiguous', parsed: p, candidates: r.candidates.map((c) => ({ id: c.id, name: c.name, teamAbbr: c.teamAbbr })) };
      }
      subjectId = r.player.id;
      selection = p.selection;
    }

    const draft: SlipIntent = { subjectType: p.subjectType, subjectId, marketType: p.marketType, selection, gameId: game.id };
    if (p.line !== undefined && p.marketType !== 'puck_line') draft.line = p.line;
    const v = validateIntent(draft, ctx);
    if (v.ok) return { ...base, state: 'ok', parsed: p, intent: v.intent };
    if (v.code === 'line') return { ...base, state: 'unsupported_line', parsed: p, intent: draft };
    if (v.code === 'game') return { ...base, state: 'no_game', parsed: p };
    return { ...base, state: 'unreadable', parsed: p };
  });

  return { kind: raw.kind, odds: raw.odds, game: raw.game, gameId: game?.id ?? null, legs };
}

// ── Point d'entrée ───────────────────────────────────────────────────────────

/**
 * Lecture OCR d'un ticket → groupes de jambes résolues contre `ctx`.
 * Pur et synchrone ; aucune ligne jetée au nettoyage ne ressort.
 */
export function scanSlip(ocr: OcrResult, ctx: SlipContext): SlipScanResult {
  const { book, lang } = detect(ocr);
  const lines = cleanLines(ocr);

  const boosted = ocr.lines.some((l) => /boost/i.test(l.text));
  let raws: RawGroup[];
  let total: string | null = null;
  if (book === 'fanduel') {
    const r = segmentFanDuel(lines, boosted);
    raws = r.groups;
    total = r.total;
  } else if (book === 'draftkings' && lines.some((l) => /\d+\s*pick parlay/.test(l.n))) {
    const r = segmentDkActivity(lines);
    raws = r.groups;
    total = r.total;
  } else if (book === 'draftkings') {
    const r = segmentDraftKings(lines, ocr.width);
    raws = r.groups;
    total = r.total;
  } else {
    raws = segmentBet365(lines);
  }

  const groups = raws.map((g) => resolveGroup(g, ctx));
  if (total === null && groups.length === 1 && !boosted) total = groups[0].odds;

  const shown = [total, ...groups.map((g) => g.odds)].find((o): o is string => !!o);
  return { book, lang, oddsFormat: shown ? oddsFormatOf(shown) : null, groups, totalOdds: total, boosted };
}
