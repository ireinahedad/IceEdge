/**
 * fixture.ts — SCAN_TICKET_PLAN § 7 (S0). Format et chargement des fixtures du
 * scan de ticket. Voir README.md dans ce dossier pour la collecte.
 *
 *   images/<nom>.png|jpg          la capture (NON versionnée, .gitignore)
 *   expected/<nom>.json           la vérité attendue (versionnée) — `SlipScanExpected`
 *   ocr/<moteur>/<nom>.json       sortie OCR figée (versionnée) — `OcrResult`
 *
 * Le parseur (S2) se teste sur `ocr/` + `expected/`, sans OCR, comme
 * slipCommand.test.ts. Le banc OCR (client/scripts/ocr-bench) mesure, lui,
 * `images/` contre `expected/`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { SLIP_COMMAND_MARKETS } from '../../slipCommand';
import type { SlipMarket } from '../../slipCommand';
import type { OcrEngine, OcrResult } from '../../ocrTypes';

export const FIXTURE_DIR = __dirname;

export type Book = 'bet365' | 'draftkings' | 'other';

/** Ce que la jambe DOIT devenir. Les noms (pas les ids) : les ids changent d'une saison à l'autre. */
export interface ExpectedIntent {
  subjectType: 'team' | 'player' | 'game';
  /** Abréviation NHL (« WSH », pas le « WAS » du ticket) pour `team`. */
  team?: string;
  /** Nom complet tel que sur nhl.com pour `player`. */
  player?: string;
  marketType: SlipMarket;
  /** `over` / `under` / `yes`, ou l'abréviation de l'équipe choisie (moneyline, puck line…). */
  selection: string;
  line?: number;
}

/** État attendu (SCAN_TICKET_PLAN § 3.6). */
export type ExpectedState = 'ok' | 'unsupported_market' | 'unsupported_line';

export interface ExpectedLeg {
  /** Lignes du ticket qui décrivent la jambe, TELLES QU'AFFICHÉES (sert à mesurer l'OCR). */
  ticketText: string[];
  state: ExpectedState;
  /** Absent si `state` ≠ `ok`. */
  intent?: ExpectedIntent;
}

/**
 * Un groupe = ce qui porte UNE cote sur le ticket : une jambe simple, ou un
 * « Pari personnalisé » / SGP dont la cote couvre plusieurs jambes du même match.
 */
export interface ExpectedGroup {
  kind: 'single' | 'sgp';
  /** Cote telle qu'affichée (« 1.83 », « -110 », « 10/11 »), ou null si absente. */
  odds: string | null;
  game: { away: string; home: string };
  legs: ExpectedLeg[];
}

export interface SlipScanExpected {
  book: Book;
  lang: 'fr' | 'en';
  theme: 'dark' | 'light';
  oddsFormat: 'american' | 'decimal' | 'fractional';
  /** Date NHL des matchs (YYYY-MM-DD) — pour reconstruire le contexte de test. */
  gameDate: string;
  groups: ExpectedGroup[];
  /** Cote totale affichée, ou null si le ticket ne l'affiche pas. */
  totalOdds: string | null;
  /**
   * Textes PERSONNELS présents sur la capture (mise, gains, solde, n° de pari)
   * qui ne doivent JAMAIS sortir du nettoyage (§ 3.1, § 6).
   */
  personal: string[];
  notes?: string;
}

export interface Fixture {
  name: string;
  expected: SlipScanExpected;
  ocr: Partial<Record<OcrEngine, OcrResult>>;
  /** Chemin de la capture si elle est présente sur ce poste. */
  image?: string;
}

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

export function fixtureNames(): string[] {
  const dir = join(FIXTURE_DIR, 'expected');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json')).sort();
}

export function loadFixture(name: string): Fixture {
  const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, 'expected', `${name}.json`), 'utf8')) as SlipScanExpected;
  const ocr: Fixture['ocr'] = {};
  for (const engine of ['vision', 'tesseract'] as const) {
    const p = join(FIXTURE_DIR, 'ocr', engine, `${name}.json`);
    if (existsSync(p)) ocr[engine] = JSON.parse(readFileSync(p, 'utf8')) as OcrResult;
  }
  const image = IMAGE_EXT.map((e) => join(FIXTURE_DIR, 'images', name + e)).find(existsSync);
  return { name, expected, ocr, image };
}

const MARKETS: ReadonlySet<string> = new Set(SLIP_COMMAND_MARKETS);
const ODDS_RE = /^([+-]\d{3,5}|\d+\.\d{2,3}|\d+\/\d+)$/;
const ABBR_RE = /^[A-Z]{3}$/;

/** Erreurs de forme d'une vérité attendue (liste vide = valide). */
export function validateExpected(e: SlipScanExpected): string[] {
  const errs: string[] = [];
  if (!['bet365', 'draftkings', 'other'].includes(e.book)) errs.push(`book: ${e.book}`);
  if (!['fr', 'en'].includes(e.lang)) errs.push(`lang: ${e.lang}`);
  if (!['dark', 'light'].includes(e.theme)) errs.push(`theme: ${e.theme}`);
  if (!['american', 'decimal', 'fractional'].includes(e.oddsFormat)) errs.push(`oddsFormat: ${e.oddsFormat}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.gameDate)) errs.push(`gameDate: ${e.gameDate}`);
  if (e.totalOdds !== null && !ODDS_RE.test(e.totalOdds)) errs.push(`totalOdds: ${e.totalOdds}`);
  if (!Array.isArray(e.personal)) errs.push('personal: must be an array');
  if (!Array.isArray(e.groups) || !e.groups.length) errs.push('groups: at least one');
  (e.groups ?? []).forEach((g, gi) => {
    const at = `groups[${gi}]`;
    if (g.kind !== 'single' && g.kind !== 'sgp') errs.push(`${at}.kind: ${g.kind}`);
    if (g.odds !== null && !ODDS_RE.test(g.odds)) errs.push(`${at}.odds: ${g.odds}`);
    if (!ABBR_RE.test(g.game?.away ?? '') || !ABBR_RE.test(g.game?.home ?? '')) errs.push(`${at}.game: abréviations NHL`);
    if (!g.legs?.length) errs.push(`${at}.legs: at least one`);
    if (g.kind === 'single' && g.legs?.length !== 1) errs.push(`${at}: single = une jambe`);
    (g.legs ?? []).forEach((l, li) => {
      const lat = `${at}.legs[${li}]`;
      if (!l.ticketText?.length) errs.push(`${lat}.ticketText: at least one line`);
      if (l.state === 'ok') {
        const i = l.intent;
        if (!i) { errs.push(`${lat}.intent: required when ok`); return; }
        if (!MARKETS.has(i.marketType)) errs.push(`${lat}.marketType: ${i.marketType}`);
        if (i.subjectType === 'team' && !ABBR_RE.test(i.team ?? '')) errs.push(`${lat}.team`);
        if (i.subjectType === 'team' && i.team !== g.game.away && i.team !== g.game.home) errs.push(`${lat}.team: pas dans le match`);
        if (i.subjectType === 'player' && !i.player) errs.push(`${lat}.player`);
        if (!i.selection) errs.push(`${lat}.selection`);
      } else if (l.state !== 'unsupported_market' && l.state !== 'unsupported_line') {
        errs.push(`${lat}.state: ${l.state}`);
      }
    });
  });
  return errs;
}
