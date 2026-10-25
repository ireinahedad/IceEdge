import { describe, it, expect } from 'vitest';
import {
  nextDelayMs, inGameWindow, parseAuthorFeed, teamsInText, teamsForPost, flagsOf,
  excerptOf, normalizeManualUrl, authorFromManualUrl, HOUR_MS, QUARTER_MS, IDLE_MS,
} from './newsFeed';
import { alertWorthy } from './newsSync.service';

const T = (iso: string) => Date.parse(iso);
// Soirée type : 1re mise au jeu 23:00 UTC (19:00 ET), dernière 02:00 UTC.
const starts = [T('2026-10-23T23:00:00Z'), T('2026-10-24T00:00:00Z'), T('2026-10-24T02:00:00Z')];

describe('cadence (2026-10-25) : 1 h de −12 h à −1 h, 15 min jusqu’à la dernière mise au jeu, 6 h sinon', () => {
  // starts : 1re mise au jeu 23:00 UTC → fenêtre ouverte à 11:00 UTC, 15 min dès 22:00 ; dernière 02:00 UTC.
  it('sans match : toutes les 6 h', () => {
    expect(nextDelayMs(T('2026-10-23T12:00:00Z'), [])).toBe(IDLE_MS);
  });
  it('loin avant la fenêtre : 6 h', () => {
    expect(nextDelayMs(T('2026-10-23T02:00:00Z'), starts)).toBe(IDLE_MS);
  });
  it('moins de 6 h avant l’ouverture : on tombe pile à 11:00 UTC', () => {
    const now = T('2026-10-23T08:20:00Z');
    expect(now + nextDelayMs(now, starts)).toBe(T('2026-10-23T11:00:00Z'));
  });
  it('de −12 h à −1 h : heures pile, même après un tour en retard', () => {
    expect(nextDelayMs(T('2026-10-23T11:00:00Z'), starts)).toBe(HOUR_MS);
    const late = T('2026-10-23T14:07:00Z');
    expect(late + nextDelayMs(late, starts)).toBe(T('2026-10-23T15:00:00Z'));
    expect(inGameWindow(T('2026-10-23T11:30:00Z'), starts)).toBe(true);
    expect(inGameWindow(T('2026-10-23T10:59:00Z'), starts)).toBe(false);
  });
  it('dès 1 h avant le 1er match et jusqu’à la dernière mise au jeu : 15 min', () => {
    expect(nextDelayMs(T('2026-10-23T22:00:00Z'), starts)).toBe(QUARTER_MS);
    const late = T('2026-10-23T23:21:00Z');
    expect(late + nextDelayMs(late, starts)).toBe(T('2026-10-23T23:30:00Z'));
    expect(nextDelayMs(T('2026-10-24T01:45:00Z'), starts)).toBe(QUARTER_MS);
  });
  it('une soirée complète : tour à −1 h (rappel de vote), un tour dans la dernière heure de chaque match, 27 tours', () => {
    let t = T('2026-10-23T11:00:00Z');
    const ticks: number[] = [];
    while (t < T('2026-10-24T02:00:00Z')) { ticks.push(t); t += nextDelayMs(t, starts); }
    expect(ticks).toContain(T('2026-10-23T22:00:00Z'));
    for (const s of starts) expect(ticks.some((x) => x < s && s - x <= HOUR_MS)).toBe(true);
    expect(ticks.filter((x) => x < T('2026-10-23T22:00:00Z'))).toHaveLength(11);
    expect(ticks).toHaveLength(27);
  });
  it('après la dernière mise au jeu : 6 h', () => {
    expect(nextDelayMs(T('2026-10-24T02:00:00Z'), starts)).toBe(IDLE_MS);
    expect(inGameWindow(T('2026-10-24T03:00:00Z'), starts)).toBe(false);
  });
  it('jamais moins d’une minute', () => {
    expect(nextDelayMs(T('2026-10-23T10:59:50Z'), starts)).toBe(60_000);
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

describe('alertes', () => {
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

// ── Étape 1 (2026-10-24) : erreurs relevées sur le fil réel de production ──
import { isRetro } from './newsFeed';

describe('fil réel du 2026-10-24 — absents repérés', () => {
  it.each([
    'Golden Knights’ Mitch Marner to miss game vs. Blues for birth of child',
    'Oilers place Devon Levi on injured reserve',
    'Capitals’ Vincent Desharnais out 4-6 weeks after emergency appendectomy',
    'Penguins’ Bryan Rust out at least six weeks with lower-body injury',
    'Sharks’ Igor Chernyshov leaves game with injury',
    'Jiri Kulich just left Sabres practice after taking a puck to the face.',
    'Wild’s Jared Spurgeon returns after four-game absence',
    'Senators could be in trouble if Linus Ullmark is out long-term.',
  ])('lineup : %s', (text) => {
    expect(flagsOf(text)).toContain('lineup');
  });

  it.each([
    'Instant Reaction: Flames special teams tame the Wild in Blake Coleman’s return to Calgary',
    'He missed the net twice in the third',
    'Great atmosphere at the arena',
  ])('pas un absent : %s', (text) => {
    expect(flagsOf(text)).not.toContain('lineup');
  });

  it('les retours au jeu restent repérés', () => {
    expect(flagsOf('Bourque will return to the lineup tonight')).toContain('lineup');
    expect(flagsOf('Mavrik Bourque will return to the Predators lineup tonight')).toContain('lineup');
  });
});

describe('fil réel du 2026-10-24 — équipes', () => {
  it('source d’équipe : une VILLE citée ne rattache pas un autre club', () => {
    expect(teamsForPost('VAN', 'Canada now thrashing England. Amazing stuff in Ottawa')).toEqual(['VAN']);
    expect(teamsForPost('VAN', 'Detroit hands Vancouver their 9th loss in a row.')).toEqual(['VAN']);
    // Un club NOMMÉ compte toujours (échange, adversaire).
    expect(teamsForPost('VAN', 'Where the Canucks got dominated again in loss to Red Wings')).toEqual(['VAN', 'DET']);
  });
  it('source de ligue : les villes comptent, sauf « Boston University »', () => {
    expect(teamsForPost(null, 'Detroit hands Vancouver their 9th loss in a row.')).toEqual(['DET', 'VAN']);
    expect(teamsInText('Aiden Celebrini has been off to a fantastic start at Boston University.')).toEqual([]);
    expect(teamsInText('Boston beats Toronto')).toEqual(['BOS', 'TOR']);
  });
  it('rétro écarté', () => {
    expect(isRetro('Flashback Friday: Flames defeat Red Wings in six during 2004 playoff run')).toBe(true);
    expect(isRetro('Throwback to the 2011 Cup run #tbt')).toBe(true);
    expect(isRetro('Oilers place Devon Levi on injured reserve')).toBe(false);
  });
});
