import { describe, it, expect } from 'vitest';
import {
  nextDelayMs, inGameWindow, parseAuthorFeed, teamsInText, teamsForPost, flagsOf,
  excerptOf, normalizeManualUrl, authorFromManualUrl, HOUR_MS, QUARTER_MS,
} from './newsFeed';
import { sourcesFor, alertWorthy } from './newsSync.service';

const T = (iso: string) => Date.parse(iso);
// Soirée type : 1re mise au jeu 23:00 UTC (19:00 ET), dernière 02:00 UTC.
const starts = [T('2026-10-23T23:00:00Z'), T('2026-10-24T00:00:00Z'), T('2026-10-24T02:00:00Z')];

describe('cadence (1 h, 15 min dès 1 h avant le 1er match)', () => {
  it('sans match : toutes les heures', () => {
    expect(nextDelayMs(T('2026-10-23T12:00:00Z'), [])).toBe(HOUR_MS);
  });
  it('loin avant la fenêtre : 1 h', () => {
    expect(nextDelayMs(T('2026-10-23T15:00:00Z'), starts)).toBe(HOUR_MS);
  });
  it('moins d’une heure avant l’ouverture : on tombe pile à 22:00 UTC', () => {
    const now = T('2026-10-23T21:20:00Z');
    expect(now + nextDelayMs(now, starts)).toBe(T('2026-10-23T22:00:00Z'));
  });
  it('dans la fenêtre : 15 min', () => {
    expect(nextDelayMs(T('2026-10-23T22:00:00Z'), starts)).toBe(QUARTER_MS);
    expect(nextDelayMs(T('2026-10-24T01:59:00Z'), starts)).toBe(QUARTER_MS);
    expect(inGameWindow(T('2026-10-23T22:30:00Z'), starts)).toBe(true);
  });
  it('après la dernière mise au jeu : retour à 1 h', () => {
    expect(nextDelayMs(T('2026-10-24T02:00:00Z'), starts)).toBe(HOUR_MS);
    expect(inGameWindow(T('2026-10-24T03:00:00Z'), starts)).toBe(false);
  });
  it('jamais moins d’une minute', () => {
    expect(nextDelayMs(T('2026-10-23T21:59:50Z'), starts)).toBe(60_000);
  });
});

describe('parseAuthorFeed', () => {
  const feed = {
    feed: [
      { post: { uri: 'at://did:plc:x/app.bsky.feed.post/3abc', author: { handle: 'vgk.bsky.social', displayName: 'Vegas Golden Knights' },
                record: { text: 'Mitch Marner will be unavailable for tonight’s game.', createdAt: '2026-10-23T23:28:00Z' } } },
      { reason: { $type: 'app.bsky.feed.defs#reasonRepost' },
        post: { uri: 'at://did:plc:y/app.bsky.feed.post/9zz', author: { handle: 'other.bsky.social' }, record: { text: 'repost', createdAt: '2026-10-23T20:00:00Z' } } },
      { post: { uri: 'at://broken', author: {}, record: {} } },
    ],
  };
  it('garde les posts originaux et construit le lien bsky.app', () => {
    const out = parseAuthorFeed(feed);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://bsky.app/profile/vgk.bsky.social/post/3abc');
    expect(out[0].author).toBe('Vegas Golden Knights');
  });
  it('réponse inattendue → liste vide, pas d’exception', () => {
    expect(parseAuthorFeed(null)).toEqual([]);
    expect(parseAuthorFeed({ feed: 'x' })).toEqual([]);
  });
});

describe('équipes citées', () => {
  it('surnoms, villes, noms complets, abréviations', () => {
    expect(teamsInText('Mavrik Bourque will return to the Predators lineup tonight against the Bruins.')).toEqual(['NSH', 'BOS']);
    expect(teamsInText('The Toronto Maple Leafs acquire Aatu Räty from Vancouver')).toEqual(['TOR', 'VAN']);
    expect(teamsInText('Glendening deal with #NYR is worth $850,000')).toEqual(['NYR']);
    expect(teamsInText('Utah Mammoth recall a forward')).toEqual(['UTA']);
  });
  it('les mots courants en minuscules ne sont PAS des équipes', () => {
    expect(teamsInText('a wild game, the stars aligned, feeling the blues')).toEqual([]);
  });
  it('« New York » seul n’est rattaché à aucune équipe', () => {
    expect(teamsInText('Big night in New York')).toEqual([]);
  });
  it('source d’équipe : son équipe d’abord, puis les autres citées', () => {
    expect(teamsForPost('VGK', 'Holtz expected to draw in vs the Blues')).toEqual(['VGK', 'STL']);
    expect(teamsForPost(null, 'nothing here')).toEqual([]);
  });
});

describe('drapeaux', () => {
  it('absent / retour → lineup', () => {
    expect(flagsOf('Mitch Marner will be unavailable for tonight’s game')).toContain('lineup');
    expect(flagsOf('Bourque will return to the lineup tonight')).toContain('lineup');
  });
  it('gardien', () => {
    expect(flagsOf('Hill gets the start tonight vs CGY')).toContain('goalie');
    expect(flagsOf('Starting goalie: Vasilevskiy')).toContain('goalie');
  });
  it('transaction', () => {
    expect(flagsOf("We've agreed to terms with forward Luke Glendening")).toContain('transaction');
  });
  it('rien', () => {
    expect(flagsOf('Great atmosphere at the arena')).toEqual([]);
  });
});

describe('extrait et liens collés', () => {
  it('extrait ≤ 200 caractères, une ligne', () => {
    const e = excerptOf('a\n\n'.repeat(5) + 'x'.repeat(300));
    expect(e.length).toBeLessThanOrEqual(200);
    expect(e).not.toContain('\n');
  });
  it('normalise X / Twitter, refuse le reste', () => {
    expect(normalizeManualUrl('https://twitter.com/GoldenKnights/status/2113412282730324053?s=20'))
      .toBe('https://x.com/GoldenKnights/status/2113412282730324053');
    expect(normalizeManualUrl('https://mobile.x.com/a/status/1/')).toBe('https://x.com/a/status/1');
    expect(normalizeManualUrl('http://x.com/a/status/1')).toBeNull();
    expect(normalizeManualUrl('https://evil.example/a')).toBeNull();
    expect(normalizeManualUrl('pas une url')).toBeNull();
    expect(authorFromManualUrl('https://x.com/GoldenKnights/status/1')).toBe('@GoldenKnights');
  });
});

describe('sources lues et alertes', () => {
  const all = [
    { handle: 'league', team: null, label: '' },
    { handle: 'vgk', team: 'VGK', label: '' },
    { handle: 'tor', team: 'TOR', label: '' },
  ];
  it('dans la fenêtre : ligue + équipes qui jouent seulement', () => {
    expect(sourcesFor(all, true, new Set(['VGK', 'STL'])).map((s) => s.handle)).toEqual(['league', 'vgk']);
  });
  it('hors fenêtre : toutes', () => {
    expect(sourcesFor(all, false, new Set())).toHaveLength(3);
  });
  it('alerte : absent/gardien, récent, et match PAS ENCORE commencé', () => {
    const now = T('2026-10-23T21:00:00Z');
    const starts = new Map([['VGK', T('2026-10-24T00:00:00Z')], ['TOR', T('2026-10-23T20:00:00Z')]]);
    const fresh = '2026-10-23T20:30:00Z';
    expect(alertWorthy({ team_abbrs: ['VGK'], flags: ['lineup'], posted_at: fresh }, starts, now)).toBe(true);
    expect(alertWorthy({ team_abbrs: ['VGK'], flags: ['transaction'], posted_at: fresh }, starts, now)).toBe(false);
    // TOR a déjà commencé : trop tard pour saisir quoi que ce soit.
    expect(alertWorthy({ team_abbrs: ['TOR'], flags: ['goalie'], posted_at: fresh }, starts, now)).toBe(false);
    // Équipe qui ne joue pas aujourd'hui.
    expect(alertWorthy({ team_abbrs: ['BOS'], flags: ['goalie'], posted_at: fresh }, starts, now)).toBe(false);
    // Publication de plus de 3 h : historique du 1er tour, pas une nouvelle.
    expect(alertWorthy({ team_abbrs: ['VGK'], flags: ['lineup'], posted_at: '2026-10-23T17:00:00Z' }, starts, now)).toBe(false);
  });
});
