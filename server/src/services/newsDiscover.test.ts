import { describe, it, expect } from 'vitest';
import {
  TEAM_NAMES, teamsToSearch, searchQueries, parseActors, profileMatches, checkCandidate, bestCandidates, sourceLine,
} from './newsDiscover';
import { NEWS_SOURCES } from '../data/newsSources';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const post = (text: string, daysAgo = 1) => ({ text, postedAt: new Date(NOW - daysAgo * 24 * 3600_000) });

describe('équipes à chercher', () => {
  it('les 32 équipes ont ville et surnom', () => {
    expect(Object.keys(TEAM_NAMES)).toHaveLength(32);
  });
  it('par défaut : les équipes sans source dédiée (23 au 2026-10-23)', () => {
    const t = teamsToSearch(NEWS_SOURCES);
    expect(t).toHaveLength(23);
    for (const covered of ['CHI', 'BUF', 'MIN', 'PHI', 'MTL', 'VAN', 'TOR', 'EDM', 'CGY']) expect(t).not.toContain(covered);
    expect(t).toContain('VGK');
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
  it('pré-tri : le profil parle de l’équipe, de la ville ou de hockey', () => {
    expect(profileMatches({ handle: 'a', description: 'Covering the Golden Knights' }, 'VGK')).toBe(true);
    expect(profileMatches({ handle: 'b', displayName: 'Vegas Eats', description: 'Best tacos in town' }, 'VGK')).toBe(true);
    expect(profileMatches({ handle: 'c', description: 'Knitting and cats' }, 'VGK')).toBe(false);
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
