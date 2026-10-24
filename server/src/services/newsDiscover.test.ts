import { describe, it, expect } from 'vitest';
import {
  TEAM_NAMES, teamsToSearch, searchQueries, parseActors, profileMatches, checkCandidate, bestCandidates, sourceLine,
} from './newsDiscover';
import { NEWS_SOURCES, REJECTED_HANDLES } from '../data/newsSources';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const post = (text: string, daysAgo = 1) => ({ text, postedAt: new Date(NOW - daysAgo * 24 * 3600_000) });

describe('équipes à chercher', () => {
  it('les 32 équipes ont ville et surnom', () => {
    expect(Object.keys(TEAM_NAMES)).toHaveLength(32);
  });
  it('par défaut : les équipes sans source dédiée (15 au 2026-10-24)', () => {
    const t = teamsToSearch(NEWS_SOURCES);
    expect(t).toEqual(['CBJ', 'DAL', 'DET', 'FLA', 'LAK', 'NJD', 'NSH', 'OTT', 'PIT', 'SEA', 'SJS', 'STL', 'TBL', 'UTA', 'WSH']);
  });
  it('liste des sources : pas de doublon, aucun compte refusé dedans', () => {
    const handles = NEWS_SOURCES.map((x) => x.handle.toLowerCase());
    expect(new Set(handles).size).toBe(handles.length);
    for (const r of REJECTED_HANDLES) expect(handles).not.toContain(r.toLowerCase());
  });
  it('en argument : seulement les équipes valides, sans doublon', () => {
    expect(teamsToSearch(NEWS_SOURCES, ['vgk', 'STL', 'XYZ', 'VGK'])).toEqual(['VGK', 'STL']);
  });
  it('recherches composées avec la ville et le surnom', () => {
    expect(searchQueries('VGK')).toEqual(['Golden Knights beat writer', 'Golden Knights reporter', 'Vegas hockey', 'Golden Knights']);
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
