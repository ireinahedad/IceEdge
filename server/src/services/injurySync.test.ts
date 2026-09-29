import { describe, it, expect } from 'vitest';
import {
  parseInjuryPage, classifyNote, normalizeNote, durationDays, toNhlAbbr, matchPlayer,
  foldSeasons, pickBaseSeason, computeImpact, nameKey, searchResultsToRoster, storedName, type RosterPlayer,
} from './injurySync';

/**
 * La partie pure de `npm run injuries:sync`.
 *
 * Les notes testées ici sont de VRAIES notes relevées sur la source le
 * 2026-09-29. Ce qu'on verrouille : une note périmée ne rend jamais un joueur
 * absent, une note d'incertitude ne l'écrit pas, et une durée explicite gagne.
 */

// HTML BRUT réel d'une page (relevé le 2026-09-29), réduit à deux lignes. Les
// attributs sont entre apostrophes : un premier parseur écrit d'après le DOM du
// navigateur (guillemets) ne lisait AUCUNE ligne de la vraie page.
const PAGE = `
<h1>NHL Liste des blessés</h1><div class='resTable' ><div class='resRow'><div class='resTHead rSm' align="left"><a class="HeaderLink" rel="nofollow" href="ginjuries.aspx?lid=1&sp=1" title="Joueur">Joueur</a></div><div class='resTHead rSt' align="center"><a class="HeaderLink" rel="nofollow" href="ginjuries.aspx?lid=1&sp=0" title="Position">Pos</a></div></div>
<div class='resRow r1' ><div class='resCellNoWrap rSm' align="left" itemscope itemtype='https://schema.org/Person'><a href='gplayer.aspx?h=23314' class='pex_kuitt' data-playerID='23314' data-date='10014' data-type='5' data-poolid='57146'  itemprop='url'><span itemprop='name'>Dakota Joshua</span></a></div><div class='resCell rSt' align="center">AG</div><div class='resCellNoWrap rSt' align="left">TOR</div><div class='resCellNoWrap s1 rSm' align="left">2026-09-28</div><div class='resCellNoWrap rSm' align="left">&Eacute;valu&eacute; sur une base hebdomadaire</div><div class='resCellNoWrap rSm' align="left">abdomen</div><div class='resCell rSt' align="center"><a href="#" onClick="showInjuryInfo(23314); return false;">détails</a></div></div>
<div class='resRow r0' ><div class='resCellNoWrap rSm' align="left" itemscope itemtype='https://schema.org/Person'><a href='gplayer.aspx?h=463' class='pex_kuitt' data-playerID='463'  itemprop='url'><span itemprop='name'>Damon Severson</span></a></div><div class='resCell rSt' align="center">D</div><div class='resCellNoWrap rSt' align="left">CBJ</div><div class='resCellNoWrap s1 rSm' align="left">2026-09-28</div><div class='resCellNoWrap rSm' align="left">[en] Set to miss first two regular-season games</div><div class='resCellNoWrap rSm' align="left">épaule</div><div class='resCell rSt' align="center"><a href="#" onClick="showInjuryInfo(463); return false;">détails</a></div></div>
</div>
<a href="ginjuries.aspx?g=2&lid=1">2</a> <a href="ginjuries.aspx?g=4&lid=1">4</a>`;

const CTX = { today: '2026-09-29', opener: '2026-10-07', seasonEnd: '2027-06-15' };
const verdict = (note: string, date = '2026-09-28') => classifyNote(note, date, CTX);

describe('parseInjuryPage', () => {
  it('lit les lignes et le nombre de pages, en-tête écartée', () => {
    const { rows, pageCount } = parseInjuryPage(PAGE);
    expect(pageCount).toBe(4);
    expect(rows).toEqual([
      { player: 'Dakota Joshua', position: 'AG', team: 'TOR', date: '2026-09-28', note: 'Évalué sur une base hebdomadaire' },
      { player: 'Damon Severson', position: 'D', team: 'CBJ', date: '2026-09-28', note: '[en] Set to miss first two regular-season games' },
    ]);
  });

  it('rend ZÉRO ligne si la mise en page change (le script s\'arrête alors)', () => {
    expect(parseInjuryPage('<table><tr><td>Dakota Joshua</td><td>TOR</td></tr></table>').rows).toEqual([]);
  });
});

describe('toNhlAbbr', () => {
  const known = new Set(['LAK', 'NJD', 'TOR', 'WPG']);
  it('traduit les abréviations qui diffèrent, refuse l\'inconnu', () => {
    expect(toNhlAbbr('LA', known)).toBe('LAK');
    expect(toNhlAbbr('WIN', known)).toBe('WPG');
    expect(toNhlAbbr('TOR', known)).toBe('TOR');
    expect(toNhlAbbr('', known)).toBeNull();
  });
});

describe('normalizeNote / durationDays', () => {
  it('prend l\'original anglais d\'une traduction automatique', () => {
    expect(normalizeNote('[Trad. auto.] Devrait manquer au moins un mois.\n[Original en] Expected to miss at least a month.'))
      .toBe('expected to miss at least a month.');
  });
  it('lit les fourchettes par leur borne haute, en chiffres et en lettres', () => {
    expect(durationDays('set to miss 7-10 days')).toBe(10);
    expect(durationDays('out 4-6 months after surgery')).toBe(180);
    expect(durationDays('facing two-week absence')).toBe(14);
    expect(durationDays('expect to miss another week or two')).toBe(14);
    expect(durationDays('manquera les 2 prochains matchs')).toBe(4);
    expect(durationDays('set to miss start of 2026-27 season')).toBeNull();
  });
});

describe('classifyNote', () => {
  it('une durée explicite donne la date de fin', () => {
    expect(verdict('[en] Set to miss 7-10 days', '2026-09-24')).toMatchObject({ kind: 'out', until: '2026-10-04' });
    expect(verdict('[en] Ruled out until December', '2026-09-10')).toMatchObject({ kind: 'out', until: '2026-11-30' });
    expect(verdict('[en] Will miss October', '2026-09-17')).toMatchObject({ kind: 'out', until: '2026-10-31' });
    expect(verdict('[en] Expected back in November', '2026-09-18')).toMatchObject({ kind: 'out', until: '2026-11-15' });
    expect(verdict('[en] Hopes to return by Christmas')).toMatchObject({ kind: 'out', until: '2026-12-25' });
  });

  it('« les deux premiers matchs » se comptent depuis le premier match de la saison', () => {
    expect(verdict('[en] Set to miss first two regular-season games')).toMatchObject({ kind: 'out', until: '2026-10-10' });
    expect(verdict("Va sûrement manquer le match d'ouverture", '2026-09-25')).toMatchObject({ kind: 'out', until: '2026-10-07' });
  });

  it('une note de fin de saison de l\'an dernier est PÉRIMÉE', () => {
    expect(verdict('Saison terminée', '2026-04-10').kind).toBe('stale');
    expect(verdict("[en] Won't be ready for playoffs", '2026-04-10').kind).toBe('stale');
    expect(verdict('[en] Out 8-10 weeks', '2026-03-01').kind).toBe('stale');
  });

  it('les notes de retour ne rendent pas absent', () => {
    expect(verdict("S'est entraîné normalement").kind).toBe('available');
    expect(verdict('A reçu le feu vert').kind).toBe('available');
    expect(verdict('[en] On track to be ready for season opener').kind).toBe('available');
  });

  it('« pas prêt » n\'est pas « prêt »', () => {
    expect(verdict("N'est pas prêt d'un retour au jeu").kind).toBe('out');
  });

  it('les incertains ne sont pas écrits', () => {
    expect(verdict('Son statut sera maintenant au jour le jour').kind).toBe('doubtful');
    expect(verdict('Une décision sera prise avant la rencontre').kind).toBe('doubtful');
    expect(verdict('Absent de la pratique').kind).toBe('doubtful');
    expect(verdict('[en] Doubtful for Opening Night').kind).toBe('doubtful');
  });

  it('« pourrait manquer » est une absence, pas une incertitude', () => {
    expect(verdict('[en] Could miss more than one week', '2026-09-26')).toMatchObject({ kind: 'out', until: '2026-10-03' });
  });

  it('un match nommé = absence courte, puis périmée', () => {
    expect(verdict("[en] Practices Wednesday, won't play", '2026-09-23')).toMatchObject({ kind: 'stale', until: '2026-09-25' });
  });

  it('opération ou durée indéterminée : 60 jours faute de mieux', () => {
    expect(verdict('[en] Out indefinitely after failing physical', '2026-09-16')).toMatchObject({ kind: 'out', until: '2026-11-15' });
    expect(verdict("Se fait opérer à l'épaule", '2026-09-26')).toMatchObject({ kind: 'out', until: '2026-11-25' });
  });

  it('camp et matchs préparatoires : absent jusqu\'à la veille du premier match', () => {
    expect(verdict('[en] Ruled out for preseason finale', '2026-09-25')).toMatchObject({ kind: 'out', until: '2026-10-06' });
    // Un INCIDENT pendant un match préparatoire n'est pas une absence du camp.
    expect(verdict('[en] Hurt in preseason game', '2026-09-24')).toMatchObject({ kind: 'out', until: '2026-09-29' });
  });

  it('cas relevés sur la vraie liste le 2026-09-29', () => {
    // « Unavailable » contient « available » : ce n'est pas un retour au jeu.
    expect(verdict('[en] Unavailable for preseason finale', '2026-09-24').kind).not.toBe('available');
    // Les matchs préparatoires s'arrêtent la veille du premier match.
    expect(verdict('[en] Ruled out for final two preseason games', '2026-10-05'))
      .toMatchObject({ kind: 'out', until: '2026-10-06' });
    expect(verdict('[en] Slated to miss time', '2026-09-28').kind).toBe('out');
  });

  it('une note inconnue n\'est pas devinée', () => {
    expect(verdict('Sur la bonne voie').kind).toBe('unknown');
    expect(verdict('').kind).toBe('unknown');
  });
});

describe('matchPlayer', () => {
  const p = (id: string, first: string, last: string, team: string, position = 'C'): RosterPlayer =>
    ({ id, name: `${first} ${last}`, firstName: first, lastName: last, team, position });
  const roster = [
    p('1', 'Juraj', 'Slafkovský', 'MTL', 'L'),
    p('2', 'Mitchell', 'Marner', 'VGK', 'R'),
    p('3', 'Quinn', 'Hughes', 'MIN', 'D'),
    p('4', 'Jack', 'Hughes', 'NJD'),
    p('5', 'Luke', 'Hughes', 'NJD', 'D'),
  ];

  it('ignore les accents et la casse', () => {
    expect(matchPlayer('Juraj Slafkovsky', 'MTL', roster)?.player.id).toBe('1');
  });
  it('accepte un diminutif, et suit un échange que la source n\'a pas vu', () => {
    expect(matchPlayer('Mitch Marner', 'TOR', roster)).toMatchObject({ player: { id: '2' }, how: 'autre équipe, diminutif' });
  });
  it('ne confond jamais deux frères', () => {
    expect(matchPlayer('Luke Hughes', 'NJD', roster)?.player.id).toBe('5');
    expect(matchPlayer('Hughes', 'NJD', roster)).toBeNull();
  });
  it('rend null pour un joueur hors effectif', () => {
    expect(matchPlayer('Joueur Inconnu', 'TOR', roster)).toBeNull();
  });
  it('nameKey retire suffixes et ponctuation', () => {
    expect(nameKey('Martin St. Louis Jr.')).toBe('martin st louis');
  });
});

describe('foldSeasons / pickBaseSeason', () => {
  const totals = [
    { leagueAbbrev: 'NHL', gameTypeId: 2, season: 20252026, gamesPlayed: 30, points: 20, avgToi: '20:00' },
    { leagueAbbrev: 'NHL', gameTypeId: 2, season: 20252026, gamesPlayed: 48, points: 53, avgToi: '26:00' },
    { leagueAbbrev: 'NHL', gameTypeId: 3, season: 20252026, gamesPlayed: 10, points: 9 },
    { leagueAbbrev: 'AHL', gameTypeId: 2, season: 20262027, gamesPlayed: 5, points: 5 },
    { leagueAbbrev: 'NHL', gameTypeId: 2, season: 20262027, gamesPlayed: 3, points: 4, avgToi: '25:00' },
  ];
  it('replie un échange en cours de saison, TOI pondéré par les matchs', () => {
    const lines = foldSeasons(totals);
    expect(lines.map((l) => l.season)).toEqual(['20262027', '20252026']);
    expect(lines[1]).toMatchObject({ gamesPlayed: 78, points: 73, avgToi: 23.7 });
  });
  it('3 matchs ne suffisent pas : on prend la saison complète précédente', () => {
    expect(pickBaseSeason(foldSeasons(totals), '20262027')?.season).toBe('20252026');
    expect(pickBaseSeason([], '20262027')).toBeNull();
  });
});

describe('computeImpact', () => {
  const line = (o: Partial<{ gamesPlayed: number; points: number; avgToi: number; gamesStarted: number }>) =>
    ({ season: '20252026', gamesPlayed: 82, points: 0, avgToi: 0, gamesStarted: 0, ...o });

  it('attaquant : les points par match', () => {
    expect(computeImpact('F', line({ points: 16 }), 82).impact).toBe(0.03);   // ~0.2 pt/m
    expect(computeImpact('F', line({ points: 66 }), 82).impact).toBe(0.06);   // ~0.8 pt/m
    expect(computeImpact('F', line({ points: 130 }), 82).impact).toBe(0.08);  // plafond
  });
  it('défenseur : le temps de glace, pas les points', () => {
    expect(computeImpact('D', line({ avgToi: 16, points: 40 }), 82).impact).toBe(0.03);
    expect(computeImpact('D', line({ avgToi: 22, points: 5 }), 82).impact).toBe(0.06);
    expect(computeImpact('D', line({ avgToi: 28 }), 82).impact).toBe(0.08);
  });
  it('gardien : la part des départs de l\'équipe', () => {
    expect(computeImpact('G', line({ gamesStarted: 55 }), 82).impact).toBe(0.12);
    expect(computeImpact('G', line({ gamesStarted: 37 }), 82).impact).toBe(0.09);
    expect(computeImpact('G', line({ gamesStarted: 5 }), 82).impact).toBe(0.03);
  });
  it('sans base statistique : 0.03, et on le dit', () => {
    expect(computeImpact('F', null, 82)).toEqual({ impact: 0.03, basis: 'moins de 10 matchs LNH' });
  });
});

describe('searchResultsToRoster', () => {
  it('les blessés absents des effectifs sont retrouvés par la recherche LNH', () => {
    const results = [
      { playerId: '8484144', name: 'Connor Bedard', teamAbbrev: 'CHI', positionCode: 'C', active: true },
      { playerId: '1', name: 'Vieux Retraité', teamAbbrev: 'CHI', positionCode: 'C', active: false },
    ];
    const roster = searchResultsToRoster(results);
    expect(roster).toEqual([{ id: '8484144', name: 'Connor Bedard', firstName: 'Connor', lastName: 'Bedard', team: 'CHI', position: 'C' }]);
    expect(matchPlayer('Connor Bedard', 'CHI', roster)?.player.id).toBe('8484144');
  });
});

describe('storedName', () => {
  it('range le nom sans accents, comme MoneyPuck', () => {
    expect(storedName('Isac Lundeström')).toBe('Isac Lundestrom');
    expect(storedName('Juraj  Slafkovský')).toBe('Juraj Slafkovsky');
  });
});
