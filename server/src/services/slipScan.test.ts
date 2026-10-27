import { describe, it, expect } from 'vitest';
import { fixtureNames, loadFixture } from './__fixtures__/slipScan/fixture';
import type { SlipScanExpected } from './__fixtures__/slipScan/fixture';
import {
  scanSlip, cleanLines, parseLegText, teamsIn, oddsToDecimal, impliedProbability, oddsFormatOf,
  resolvePlayer, normScan,
} from './slipScan';
import type { SlipContext, SlipGame, SlipPlayer } from './slipCommand';
import { MARKET_LINES } from './marketLines';

/**
 * SCAN_TICKET_PLAN § 3 / § 7 (S2) — le parseur sur les VRAIES lectures OCR figées
 * (`__fixtures__/slipScan/ocr/tesseract`), sans OCR, comme slipCommand.test.ts.
 */

// ── Contexte de test ─────────────────────────────────────────────────────────
// Joueurs des fixtures (équipe NHL réelle) + leurres : un AUTRE Sebastian Aho (NYI)
// et des homonymes de nom de famille, pour vérifier que le match du ticket départage.
const PLAYERS: [string, string, string?][] = [
  ['Nick Suzuki', 'MTL'], ['Martin Necas', 'COL'], ['Nathan MacKinnon', 'COL'], ['Nazem Kadri', 'COL'],
  ['Jason Robertson', 'DAL'], ['Matthew Schaefer', 'NYI'], ['Bo Horvat', 'NYI'],
  ['Sebastian Aho', 'CAR'], ['Andrei Svechnikov', 'CAR'], ['Tage Thompson', 'BUF'],
  ['Dylan Guenther', 'UTA'], ['Cutter Gauthier', 'ANA'],
  // leurres
  ['Sebastian Aho', 'NYI'], ['Jack Hughes', 'NJD'], ['Quinn Hughes', 'VAN'], ['Ryan Suzuki', 'CAR'],
];

/** Une partie par carte de match de la fixture, à sa date ; CAR @ PHI pour la carte coupée. */
function contextFor(e: SlipScanExpected): SlipContext {
  const today = e.gameDate ?? '2026-10-20';
  const games: SlipGame[] = [];
  e.groups.forEach((g, i) => {
    if (g.game) games.push({ id: `g${i}`, awayAbbr: g.game.away, homeAbbr: g.game.home, date: today });
  });
  if (e.groups.some((g) => !g.game)) games.push({ id: 'gcar', awayAbbr: 'CAR', homeAbbr: 'PHI', date: today });
  // Des matchs d'autres jours ne doivent pas être pris.
  games.push({ id: 'later', awayAbbr: 'TOR', homeAbbr: 'MTL', date: '2026-12-01' });
  const players: SlipPlayer[] = PLAYERS.map(([name, team], i) => ({ id: `p${i}`, name, teamAbbr: team, position: 'C' }));
  return { today, games, players, lines: MARKET_LINES };
}

const nameOf = (ctx: SlipContext, id: string) => ctx.players.find((p) => p.id === id)?.name;
const gameOf = (ctx: SlipContext, id: string) => ctx.games.find((g) => g.id === id);

// ── Fixtures réelles ─────────────────────────────────────────────────────────

describe('scanSlip sur les fixtures (Tesseract)', () => {
  const names = fixtureNames().filter((n) => loadFixture(n).ocr.tesseract);

  it.each(names)('%s : groupes, cotes, matchs et jambes', (name) => {
    const { expected: e, ocr } = loadFixture(name);
    const ctx = contextFor(e);
    const r = scanSlip(ocr.tesseract!, ctx);

    expect(r.book).toBe(e.book);
    expect(r.lang).toBe(e.lang);
    expect(r.oddsFormat).toBe(e.oddsFormat);
    expect(r.totalOdds).toBe(e.totalOdds);
    expect(r.groups.map((g) => g.kind)).toEqual(e.groups.map((g) => g.kind));

    e.groups.forEach((eg, gi) => {
      const g = r.groups[gi];
      expect(g.odds, `groupe ${gi} : cote`).toBe(eg.odds);
      expect(g.game, `groupe ${gi} : match lu`).toEqual(eg.game);
      expect(g.legs.length, `groupe ${gi} : nombre de jambes`).toBe(eg.legs.length);

      eg.legs.forEach((el, li) => {
        const leg = g.legs[li];
        const at = `groupe ${gi} jambe ${li} (${el.ticketText[0]})`;
        expect(leg.state, at).toBe(el.state);
        const i = leg.intent;
        const want = el.intent;
        if (!want) return;
        expect(i, at).toBeTruthy();
        expect(i!.marketType, at).toBe(want.marketType);
        if (want.line !== undefined) expect(i!.line, at).toBe(want.line);
        if (want.subjectType === 'player') {
          expect(nameOf(ctx, i!.subjectId), at).toBe(want.player);
          // Le joueur est bien de ce match (Sebastian Aho de CAR, pas celui de NYI).
          const game = gameOf(ctx, i!.gameId)!;
          const team = ctx.players.find((p) => p.id === i!.subjectId)!.teamAbbr;
          expect([game.awayAbbr, game.homeAbbr], at).toContain(team);
          expect(i!.selection, at).toBe(want.selection);
        } else if (want.subjectType === 'team') {
          expect(i!.subjectId, at).toBe(want.team!.toLowerCase());
          expect(i!.selection, at).toBe(want.selection.length === 3 ? want.selection.toLowerCase() : want.selection);
        } else {
          expect(i!.subjectId, at).toBe(i!.gameId);
          expect(i!.selection, at).toBe(want.selection);
        }
      });
    });
  });

  it.each(names)('%s : aucune donnée personnelle ne ressort', (name) => {
    const { expected: e, ocr } = loadFixture(name);
    const r = scanSlip(ocr.tesseract!, contextFor(e));
    const out = JSON.stringify(r);
    const kept = cleanLines(ocr.tesseract!).map((l) => l.text).join('\n');
    for (const p of e.personal) {
      expect(out, p).not.toContain(p);
      expect(kept, p).not.toContain(p);
    }
  });

  it('mesure : jambes reconnues et zéro jambe fausse présentée comme ok', () => {
    let total = 0, right = 0, wrongOk = 0;
    for (const name of names) {
      const { expected: e, ocr } = loadFixture(name);
      const ctx = contextFor(e);
      const r = scanSlip(ocr.tesseract!, ctx);
      e.groups.forEach((eg, gi) => eg.legs.forEach((el, li) => {
        total++;
        const leg = r.groups[gi]?.legs[li];
        if (!leg) return;
        const sameState = leg.state === el.state;
        const sameSubject = !el.intent || !leg.intent
          || (el.intent.subjectType === 'player' ? nameOf(ctx, leg.intent.subjectId) === el.intent.player : true);
        if (sameState && sameSubject) right++;
        else if (leg.state === 'ok') wrongOk++;
      }));
    }
    expect(wrongOk).toBe(0);
    expect(right / total).toBeGreaterThanOrEqual(0.9);
  });
});

// ── Briques ──────────────────────────────────────────────────────────────────

describe('parseLegText', () => {
  it('props bet365 : « N+ » = plus de N − 0.5, EN et FR', () => {
    expect(parseLegText('o Nathan MacKinnon: 2+ Shots on Goal')).toMatchObject({ subjectText: 'nathan mackinnon', marketType: 'shots_ou', selection: 'over', line: 1.5 });
    expect(parseLegText('Nicholas Suzuki - 1+ points')).toMatchObject({ subjectText: 'nicholas suzuki', marketType: 'points_ou', line: 0.5 });
    expect(parseLegText('Cole Caufield: 1+ Buts')).toMatchObject({ marketType: 'anytime_goal', selection: 'yes' });
    expect(parseLegText('Cole Caufield: 2+ Goals')).toMatchObject({ marketType: null });
  });
  it('props DraftKings : seuil avant le nom, barre lue « | », « I », « 1 »', () => {
    for (const s of ['3+ | Tage Thompson Shots on Goal', '(QO 3+ 1 Cutter Gauthier Shots on Goal', '3+ I Tage Thompson Shots on Goal']) {
      expect(parseLegText(s), s).toMatchObject({ subjectType: 'player', marketType: 'shots_ou', line: 2.5 });
    }
  });
  it('moneyline, total d’équipe, total du match', () => {
    expect(parseLegText('o Money Line - CAR Hurricanes EARLY PAYOUT |')).toMatchObject({ marketType: 'moneyline', subjectText: 'car hurricanes' });
    expect(parseLegText('o COL Avalanche Total: Over 1.5 Goals')).toMatchObject({ marketType: 'team_total_goals', selection: 'over', line: 1.5 });
    expect(parseLegText('Plus de 5.5 buts', 'Total de points')).toMatchObject({ subjectType: 'game', marketType: 'total_goals', line: 5.5 });
    expect(parseLegText('Moins de 6,5 buts')).toMatchObject({ selection: 'under', line: 6.5 });
    expect(parseLegText('OVER 6.5', 'Total FT (Incl OT)')).toMatchObject({ marketType: 'total_goals', selection: 'over' });
  });
  it('un total sans équipe sous « Team Total » n’est pas deviné', () => {
    expect(parseLegText('Over 2.5', 'Team Total')).toBeNull();
  });
  it('rien de reconnaissable → null', () => {
    expect(parseLegText('A Q (© ©@° @F')).toBeNull();
  });
});

describe('teamsIn', () => {
  it('lit les abréviations, surnoms et « WAS » de bet365', () => {
    expect(teamsIn('« WAS Capitals 16:37')).toEqual(['WSH']);
    expect(teamsIn('NJ Devils @ DET Red Wings')).toEqual(['NJD', 'DET']);
    expect(teamsIn('EDM Oilers @ CAR Hurricanes')).toEqual(['EDM', 'CAR']);
  });
  it('« NY » seul ne désigne personne ; « NY Islanders » oui', () => {
    expect(teamsIn('NY')).toEqual([]);
    expect(teamsIn('NY Islanders')).toEqual(['NYI']);
  });
});

describe('resolvePlayer', () => {
  const pool: SlipPlayer[] = [
    { id: '1', name: 'Nick Suzuki', teamAbbr: 'MTL' }, { id: '2', name: 'Jack Hughes', teamAbbr: 'NJD' },
    { id: '3', name: 'Luke Hughes', teamAbbr: 'NJD' }, { id: '4', name: 'Auston Matthews', teamAbbr: 'TOR' },
  ];
  it('nom complet, ou prénom long du ticket (« Nicholas » → Nick)', () => {
    expect(resolvePlayer('Nicholas Suzuki', pool)).toMatchObject({ ok: true, player: { id: '1' } });
  });
  it('deux Hughes du même match → ambigu, jamais un choix', () => {
    const r = resolvePlayer('Hughes', pool);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates.map((c) => c.id).sort()).toEqual(['2', '3']);
  });
  it('faute d’OCR → proposé, pas corrigé', () => {
    const r = resolvePlayer('Auston Mathews', pool);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates.map((c) => c.id)).toEqual(['4']);
  });
});

describe('cotes', () => {
  it('formats et décimales', () => {
    expect(oddsFormatOf('−130')).toBe('american');
    expect(oddsFormatOf('1.83')).toBe('decimal');
    expect(oddsFormatOf('10/11')).toBe('fractional');
    expect(oddsToDecimal('+195')).toBeCloseTo(2.95, 6);
    expect(oddsToDecimal('−130')).toBeCloseTo(1.7692, 4);
    expect(oddsToDecimal('10/11')).toBeCloseTo(1.9091, 4);
    expect(oddsToDecimal('+50')).toBeNull();
  });
  it('probabilité implicite brute', () => {
    expect(impliedProbability('1.83')).toBe(54.6);
    expect(impliedProbability('+600')).toBe(14.3);
  });
});

describe('nettoyage', () => {
  it('normScan : signes moins, virgule décimale, accents', () => {
    expect(normScan('Moins de 6,5 BUTS −1½')).toBe('moins de 6.5 buts -1.5');
  });
});
