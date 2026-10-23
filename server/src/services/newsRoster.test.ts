import { describe, it, expect } from 'vitest';
import {
  parseRoster, diffRosters, encodeRoster, decodeRoster, excerptFor, externalIdFor,
  playerUrl, rosterDue, etParts, MAX_CHANGES_PER_TEAM, type RosterPlayer,
} from './newsRoster';

const P = (id: number, name = `P${id}`, pos = 'C', num: number | null = id % 99): RosterPlayer => ({ id, name, pos, num });
const T = (iso: string) => Date.parse(iso);

describe('parseRoster', () => {
  it('lit attaquants, défenseurs, gardiens ; ignore les entrées sans id et les doublons', () => {
    const json = {
      forwards: [
        { id: 8478483, firstName: { default: 'Mitch' }, lastName: { default: 'Marner' }, positionCode: 'R', sweaterNumber: 93 },
        { firstName: { default: 'Sans' }, lastName: { default: 'Id' } },
      ],
      defensemen: [{ id: 8476853, firstName: { default: 'Morgan' }, lastName: { default: 'Rielly' }, positionCode: 'D', sweaterNumber: 44 }],
      goalies: [
        { id: 8479361, firstName: { default: 'Joseph' }, lastName: { default: 'Woll' }, positionCode: 'G' },
        { id: 8478483, firstName: { default: 'Mitch' }, lastName: { default: 'Marner' } },
      ],
    };
    expect(parseRoster(json)).toEqual([
      { id: 8478483, name: 'Mitch Marner', pos: 'R', num: 93 },
      { id: 8476853, name: 'Morgan Rielly', pos: 'D', num: 44 },
      { id: 8479361, name: 'Joseph Woll', pos: 'G', num: null },
    ]);
  });
  it('réponse malformée → liste vide', () => {
    expect(parseRoster(null)).toEqual([]);
    expect(parseRoster({ forwards: 'x' })).toEqual([]);
  });
});

describe('état job_state', () => {
  it('aller-retour, trié par id', () => {
    const raw = encodeRoster([P(3), P(1)]);
    expect(decodeRoster(raw)!.map((p) => p.id)).toEqual([1, 3]);
  });
  it('absent ou illisible → null (rebase)', () => {
    expect(decodeRoster(null)).toBeNull();
    expect(decodeRoster('{pas du json')).toBeNull();
    expect(decodeRoster('{"a":1}')).toBeNull();
  });
});

describe('diffRosters', () => {
  it('équipe sans veille : base enregistrée, aucune nouvelle', () => {
    const d = diffRosters(new Map(), new Map([['TOR', [P(1), P(2)]]]));
    expect(d.events).toEqual([]);
    expect(d.baseline).toEqual(['TOR']);
  });

  it('ajout et retrait sur une équipe', () => {
    const d = diffRosters(
      new Map([['TOR', [P(1), P(2)]]]),
      new Map([['TOR', [P(1), P(3)]]]),
    );
    expect(d.events).toEqual([
      { kind: 'added', player: P(3), teams: ['TOR'] },
      { kind: 'removed', player: P(2), teams: ['TOR'] },
    ]);
  });

  it('échange : retiré de TOR, ajouté à VGK → UNE nouvelle « moved », arrivée d’abord', () => {
    const d = diffRosters(
      new Map([['TOR', [P(1), P(93)]], ['VGK', [P(5)]]]),
      new Map([['TOR', [P(1)]], ['VGK', [P(5), P(93)]]]),
    );
    expect(d.events).toEqual([{ kind: 'moved', player: P(93), teams: ['VGK', 'TOR'] }]);
  });

  it('équipe illisible aujourd’hui (absente de cur) : pas comparée, pas de faux retraits', () => {
    const d = diffRosters(new Map([['TOR', [P(1)]], ['VGK', [P(2)]]]), new Map([['VGK', [P(2)]]]));
    expect(d.events).toEqual([]);
  });

  it('écart trop grand (bascule de saison) : rebasé sans nouvelle', () => {
    const before = Array.from({ length: 23 }, (_, i) => P(i + 1));
    const after = Array.from({ length: 23 }, (_, i) => P(i + 100));
    const d = diffRosters(new Map([['TOR', before]]), new Map([['TOR', after]]));
    expect(d.events).toEqual([]);
    expect(d.rebased).toEqual(['TOR']);
  });

  it('juste au plafond : annoncé', () => {
    const n = MAX_CHANGES_PER_TEAM / 2;
    const before = Array.from({ length: 20 }, (_, i) => P(i + 1));
    const after = [...before.slice(n), ...Array.from({ length: n }, (_, i) => P(i + 100))];
    const d = diffRosters(new Map([['TOR', before]]), new Map([['TOR', after]]));
    expect(d.events).toHaveLength(MAX_CHANGES_PER_TEAM);
    expect(d.rebased).toEqual([]);
  });
});

describe('ligne news_items', () => {
  const marner = { id: 8478483, name: 'Mitch Marner', pos: 'R', num: 93 };
  it('extraits factuels, ≤ 200 caractères', () => {
    expect(excerptFor({ kind: 'moved', player: marner, teams: ['VGK', 'TOR'] }))
      .toBe('Roster move: Mitch Marner (R, #93) leaves TOR for VGK.');
    expect(excerptFor({ kind: 'added', player: { ...marner, num: null }, teams: ['VGK'] }))
      .toBe('Roster move: Mitch Marner (R) added to the VGK roster.');
    expect(excerptFor({ kind: 'removed', player: marner, teams: ['TOR'] }))
      .toBe('Roster move: Mitch Marner (R, #93) removed from the TOR roster.');
    const long = { ...marner, name: 'X'.repeat(150) };
    expect(excerptFor({ kind: 'moved', player: long, teams: ['VGK', 'TOR'] }).length).toBeLessThanOrEqual(200);
  });
  it('identité : jour + type + joueur + équipes ; lien nhl.com', () => {
    expect(externalIdFor({ kind: 'moved', player: marner, teams: ['VGK', 'TOR'] }, '2026-10-23'))
      .toBe('2026-10-23:moved:8478483:VGK-TOR');
    expect(playerUrl(8478483)).toBe('https://www.nhl.com/player/8478483');
  });
});

describe('échéance quotidienne (midi, heure de l’Est)', () => {
  it('heure ET, y compris le changement d’heure', () => {
    expect(etParts(T('2026-10-23T16:00:00Z'))).toEqual({ day: '2026-10-23', hour: 12 }); // EDT
    expect(etParts(T('2026-12-01T17:00:00Z'))).toEqual({ day: '2026-12-01', hour: 12 }); // EST
    expect(etParts(T('2026-10-24T03:30:00Z'))).toEqual({ day: '2026-10-23', hour: 23 });
  });
  it('avant midi : pas dû', () => {
    expect(rosterDue(T('2026-10-23T15:59:00Z'), null)).toBe(false);
  });
  it('à midi et après : dû une fois par jour', () => {
    expect(rosterDue(T('2026-10-23T16:00:00Z'), null)).toBe(true);
    expect(rosterDue(T('2026-10-23T16:00:00Z'), '2026-10-22')).toBe(true);
    expect(rosterDue(T('2026-10-23T22:00:00Z'), '2026-10-23')).toBe(false);
  });
});
