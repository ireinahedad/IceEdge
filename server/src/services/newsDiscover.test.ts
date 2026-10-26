import { describe, it, expect } from 'vitest';
import {
  TEAM_NAMES, teamsToSearch, searchQueries, parseActors, profileMatches, checkCandidate, bestCandidates, sourceLine,
  LOCAL_OUTLETS, TEAM_HASHTAGS, hashtagAuthors, profileExcluded, notAReporter, multiTeamHandles,
} from './newsDiscover';
import { NEWS_SOURCES, REJECTED_HANDLES } from '../data/newsSources';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const post = (text: string, daysAgo = 1) => ({ text, postedAt: new Date(NOW - daysAgo * 24 * 3600_000) });

describe('équipes à chercher', () => {
  it('les 32 équipes ont ville et surnom', () => {
    expect(Object.keys(TEAM_NAMES)).toHaveLength(32);
  });
  it('par défaut : les équipes sans source dédiée (12 au 2026-10-26)', () => {
    const t = teamsToSearch(NEWS_SOURCES);
    expect(t).toEqual(['CBJ', 'DET', 'FLA', 'LAK', 'NJD', 'NSH', 'OTT', 'PIT', 'SEA', 'SJS', 'TBL', 'UTA']);
  });
  it('liste des sources : pas de doublon, aucun compte refusé dedans', () => {
    const handles = NEWS_SOURCES.map((x) => x.handle.toLowerCase());
    expect(new Set(handles).size).toBe(handles.length);
    for (const r of REJECTED_HANDLES) expect(handles).not.toContain(r.toLowerCase());
  });
  it('en argument : seulement les équipes valides, sans doublon', () => {
    expect(teamsToSearch(NEWS_SOURCES, ['vgk', 'STL', 'XYZ', 'VGK'])).toEqual(['VGK', 'STL']);
  });
  it('recherches composées avec la ville et le surnom (celles du 1er passage d’abord)', () => {
    expect(searchQueries('VGK')).toEqual([
      'Golden Knights beat writer', 'Golden Knights reporter', 'Vegas hockey', 'Golden Knights',
      'Vegas Golden Knights', 'Golden Knights insider',
    ]);
  });
  it('2e passage : médias locaux ajoutés, sans doublon', () => {
    const q = searchQueries('TBL');
    expect(q.slice(0, 4)).toEqual(['Lightning beat writer', 'Lightning reporter', 'Tampa Bay hockey', 'Lightning']);
    expect(q).toContain('Tampa Bay Times Lightning');
    expect(q).toContain('Tampa Bay Times hockey');
    expect(new Set(q).size).toBe(q.length);
  });
  it('les 15 équipes sans source ont des médias locaux et des mots-clics', () => {
    for (const t of ['CBJ', 'DAL', 'DET', 'FLA', 'LAK', 'NJD', 'NSH', 'OTT', 'PIT', 'SEA', 'SJS', 'STL', 'TBL', 'UTA', 'WSH']) {
      expect(LOCAL_OUTLETS[t]?.length, t).toBeGreaterThan(0);
      expect(TEAM_HASHTAGS[t]?.length, t).toBeGreaterThan(0);
      for (const h of TEAM_HASHTAGS[t]) expect(h, t).toMatch(/^#\w+$/);
    }
    for (const t of [...Object.keys(LOCAL_OUTLETS), ...Object.keys(TEAM_HASHTAGS)]) expect(TEAM_NAMES[t], t).toBeDefined();
  });
});

describe('auteurs des mots-clics (searchPosts)', () => {
  const p = (handle: string, uri: string, displayName?: string) => ({ uri, author: { handle, displayName } });

  it('compte les publications distinctes par auteur, une seule publication = écarté', () => {
    const r1 = { posts: [p('beat.bsky.social', 'at://1', 'Beat'), p('beat.bsky.social', 'at://2'), p('fan.bsky.social', 'at://3'), p('Beat.bsky.social', 'at://4')] };
    expect(hashtagAuthors([r1])).toEqual([{ handle: 'beat.bsky.social', displayName: 'Beat', posts: 3 }]);
  });
  it('plusieurs mots-clics : totaux additionnés, une publication avec les deux comptée une fois', () => {
    const r1 = { posts: [p('a.bsky.social', 'at://1'), p('b.bsky.social', 'at://5'), p('b.bsky.social', 'at://6')] };
    const r2 = { posts: [p('a.bsky.social', 'at://1'), p('a.bsky.social', 'at://2'), p('a.bsky.social', 'at://3')] };
    expect(hashtagAuthors([r1, r2]).map((x) => [x.handle, x.posts])).toEqual([['a.bsky.social', 3], ['b.bsky.social', 2]]);
  });
  it('réponses malformées ou refusées : ignorées', () => {
    expect(hashtagAuthors([null, { posts: 'x' }, { posts: [{ uri: 'at://1' }, p('handle.invalid', 'at://2'), { author: { handle: 'x' } }] }])).toEqual([]);
  });
  it('profileExcluded : parodie et autre sport sans hockey ; une bio vide passe', () => {
    expect(profileExcluded({ handle: 'pens.bsky.social' })).toBe(false);
    expect(profileExcluded({ handle: 'x', description: 'Parody account' })).toBe(true);
    expect(profileExcluded({ handle: 'steelersfootball.bsky.social' })).toBe(true);
    expect(profileExcluded({ handle: 'x', description: 'Steelers, Pirates and Penguins hockey' })).toBe(false);
  });
  it('parseActors lit aussi la réponse de getProfiles', () => {
    expect(parseActors({ profiles: [{ handle: 'a.bsky.social', description: 'Penguins beat' }] }))
      .toEqual([{ handle: 'a.bsky.social', displayName: undefined, description: 'Penguins beat' }]);
  });
});

describe('profils', () => {
  it('parseActors : profils valides, handle.invalid écarté', () => {
    expect(parseActors({ actors: [
      { handle: 'jesse.bsky.social', displayName: 'Jesse Granger', description: 'Golden Knights for The Athletic' },
      { handle: 'handle.invalid' }, { displayName: 'sans handle' },
    ] })).toEqual([{ handle: 'jesse.bsky.social', displayName: 'Jesse Granger', description: 'Golden Knights for The Athletic' }]);
    expect(parseActors(null)).toEqual([]);
  });
  it('pré-tri : le profil doit parler de hockey ou de l’équipe ; la ville seule ne suffit pas', () => {
    expect(profileMatches({ handle: 'a', description: 'Covering the Golden Knights' }, 'VGK')).toBe(true);
    expect(profileMatches({ handle: 'd', description: 'Vegas hockey writer' }, 'VGK')).toBe(true);
    expect(profileMatches({ handle: 'b', displayName: 'Vegas Eats', description: 'Best tacos in town' }, 'VGK')).toBe(false);
    expect(profileMatches({ handle: 'c', description: 'Knitting and cats' }, 'VGK')).toBe(false);
  });
  it('faux positifs du 1er passage (2026-10-24) : écartés', () => {
    // Députée de Tampa Bay : la ville, pas le hockey.
    expect(profileMatches({ handle: 'usrepkathycastor.bsky.social', displayName: 'U.S. Rep. Kathy Castor', description: 'Proudly representing Tampa Bay in Congress' }, 'TBL')).toBe(false);
    // Carolina Panthers (NFL) : « Panthers » oui, mais football.
    expect(profileMatches({ handle: 'mikekayefootball.bsky.social', displayName: 'Mike Kaye - Panthers beat writer', description: 'Charlotte Observer' }, 'FLA')).toBe(false);
    // Parodie.
    expect(profileMatches({ handle: 'notnjdevils.bsky.social', displayName: 'New Jersey Devils', description: 'Parody account' }, 'NJD')).toBe(false);
    // Football ET hockey : gardé (un journaliste multisport qui couvre l'équipe).
    expect(profileMatches({ handle: 'x', description: 'Panthers hockey and Dolphins football' }, 'FLA')).toBe(true);
  });
});

describe('contrôle d’un candidat (mêmes règles que news:check)', () => {
  const vgkWriter = { handle: 'beat.bsky.social', displayName: 'Beat Writer', description: 'Golden Knights beat' };

  it('journaliste actif qui cite son équipe et les absents : ok, bien noté', () => {
    const c = checkCandidate(vgkWriter, 'VGK', [
      post('Golden Knights morning skate: Marner will not play tonight'),
      post('Hill gets the start for the Golden Knights'),
      post('Practice notes from City National Arena'),
      post('Vegas lines vs STL'),
    ], NOW);
    expect(c).toMatchObject({ verdict: 'ok', active: 4, teamPosts: 3, flagged: 2, profileMatch: true });
    expect(c.top?.[0]).toBe('VGK');
  });

  it('compte qui parle surtout d’une autre équipe : écarté', () => {
    const c = checkCandidate({ handle: 'x', description: 'hockey fan' }, 'VGK', [
      post('Oilers win'), post('Oilers lines'), post('McDavid and the Oilers'), post('Vegas next'),
    ], NOW);
    expect(c.verdict).toBe('autre équipe');
  });

  it('moins de 3 publications en 7 jours : inactif (les vieilles ne comptent pas)', () => {
    expect(checkCandidate(vgkWriter, 'VGK', [post('Golden Knights', 1), post('Golden Knights', 10), post('Vegas', 9)], NOW).verdict).toBe('inactif');
  });

  it('actif mais ne cite jamais l’équipe : écarté', () => {
    expect(checkCandidate({ handle: 'y' }, 'VGK', [post('a'), post('b'), post('c')], NOW).verdict).toBe('cite peu l\'équipe');
  });

  it('les meilleurs « ok » d’abord, au plus 3 ; ligne prête à coller, apostrophes échappées', () => {
    const mk = (handle: string, score: number, verdict: any = 'ok'): any => ({ handle, label: handle, team: 'VGK', score, verdict });
    expect(bestCandidates([mk('a', 3), mk('b', 9), mk('c', 5), mk('d', 7), mk('e', 99, 'inactif')]).map((c) => c.handle)).toEqual(['b', 'd', 'c']);
    expect(sourceLine({ handle: 'jg.bsky.social', label: "Jesse O'Granger", team: 'VGK' } as any))
      .toBe("  { handle: 'jg.bsky.social', team: 'VGK', label: 'Jesse O\\'Granger' },");
  });
});

describe('filtre automatique (2026-10-26)', () => {
  it('bots, balados, fans, blogues, comptes de buts : écartés', () => {
    expect(notAReporter({ handle: 'canucksgamebot.bsky.social', displayName: 'Canucks Game Bot' })).toBe(true);
    expect(notAReporter({ handle: 'hockeytownwpod.bsky.social', displayName: 'Hockeytown West Podcast' })).toBe(true);
    expect(notAReporter({ handle: 'nhlgoals.bsky.social', displayName: 'NHL Goals' })).toBe(true);
    expect(notAReporter({ handle: 'x.bsky.social', description: 'Lifelong Blues fan, Texas' })).toBe(true);
    expect(notAReporter({ handle: 'senstennial.bsky.social', description: 'A Senators blog since 2017' })).toBe(true);
    expect(notAReporter({ handle: 'someonebot.bsky.social' })).toBe(true);
  });
  it('journaliste qui anime aussi un balado : gardé ; nom contenant « fan » : gardé', () => {
    expect(notAReporter({ handle: 'jr.bsky.social', description: 'Blues beat writer for The Athletic. Co-host of a podcast.' })).toBe(false);
    expect(notAReporter({ handle: 'stefanmatteau.bsky.social', displayName: 'Stefan M' })).toBe(false);
    expect(notAReporter({ handle: 'vogscaps.bsky.social', displayName: 'Mike Vogel' })).toBe(false);
  });
  it('profileExcluded et profileMatches appliquent le filtre', () => {
    expect(profileExcluded({ handle: 'tealtown-usa.bsky.social', displayName: 'Teal Town USA, a San Jose Sharks podcast' })).toBe(true);
    expect(profileMatches({ handle: 'x', description: 'Die-hard Penguins fan' }, 'PIT')).toBe(false);
  });
  it('multiTeamHandles : un handle dans la liste de 2 équipes ou plus, casse ignorée', () => {
    const m = multiTeamHandles({
      LAK: ['pucksleuth.bsky.social', 'a.bsky.social'],
      PIT: ['PuckSleuth.bsky.social'],
      UTA: ['nhlgoals.bsky.social', 'b.bsky.social'],
      OTT: ['nhlgoals.bsky.social'],
    });
    expect([...m].sort()).toEqual(['nhlgoals.bsky.social', 'pucksleuth.bsky.social']);
  });
  it('compte qui cite 5 équipes ou plus sans que la sienne domine : « plusieurs équipes »', () => {
    const c = checkCandidate({ handle: 'stats.bsky.social', description: 'hockey' }, 'VGK', [
      post('Oilers win'), post('Bruins lose'), post('Maple Leafs lines'), post('Canucks trade'),
      post('Flames goal'), post('Golden Knights win'), post('Sabres call-up'), post('Jets shutout'),
    ], NOW);
    expect(c.verdict).toBe('plusieurs équipes');
  });
  it('journaliste attitré qui cite les adversaires : reste ok', () => {
    const c = checkCandidate({ handle: 'beat', description: 'Golden Knights beat writer' }, 'VGK', [
      post('Golden Knights vs Oilers tonight'), post('Golden Knights lines vs Bruins'), post('Golden Knights beat Flames'),
      post('Golden Knights: Hill starts vs Canucks'), post('Golden Knights host Jets'), post('Golden Knights recall a forward'),
    ], NOW);
    expect(c.verdict).toBe('ok');
  });
});
