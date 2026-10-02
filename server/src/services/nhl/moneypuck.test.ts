import { describe, it, expect } from 'vitest';
import { mpSeasonOf, parseCsv, parseSkatersCsv, parseTeamsCsv } from './moneypuck';

/**
 * Lecture des CSV de saison MoneyPuck. Les en-têtes sont ceux des vrais
 * fichiers (2025-26), réduits aux colonnes lues — y compris la DEUXIÈME
 * colonne « team » de `teams.csv`, qui ne doit pas écraser la première.
 */

const TEAMS = [
  'team,season,name,team,position,situation,games_played,shotAttemptsFor,shotAttemptsAgainst,unblockedShotAttemptsFor,unblockedShotAttemptsAgainst',
  'T.B,2025,T.B,T.B,Team Level,all,2,120,100,90,70',
  'T.B,2025,T.B,T.B,Team Level,5on5,2,80,80,60,60',
  'MTL,2025,MTL,MTL,Team Level,all,0,0,0,0,0',
].join('\n');

const SKATERS = [
  'playerId,season,name,team,position,situation,games_played,OnIce_F_shotAttempts,OnIce_A_shotAttempts,OnIce_F_unblockedShotAttempts,OnIce_A_unblockedShotAttempts',
  '8478402,2025,Connor McDavid,EDM,C,all,82,1900,1500,1400,1100',
  '8478402,2025,Connor McDavid,EDM,C,5on5,82,1200,1000,900,700',
  '8480001,2025,"Doe, John",N.J,D,5on5,3,10,30,8,24',
].join('\r\n');

describe('moneypuck — lecture des CSV', () => {
  it('saison NHL → année MoneyPuck', () => {
    expect(mpSeasonOf('20262027')).toBe('2026');
  });

  it('parseCsv : guillemets et virgule dans un champ', () => {
    const { header, rows } = parseCsv('a,b\n"x, y",2\n');
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['x, y', '2']]);
  });

  it('équipes : volumes par match toutes situations, pourcentages 5 c. 5, abréviation normalisée', () => {
    const t = parseTeamsCsv(TEAMS);
    expect(Object.keys(t)).toEqual(['TBL']);              // MTL à 0 match : écarté
    expect(t.TBL).toEqual({
      gamesPlayed: 2,
      fenwickForPg: 45, fenwickAgainstPg: 35, corsiForPg: 60, corsiAgainstPg: 50,
      corsiPct: 54.5, fenwickPct: 56.3,
      corsiPct5v5: 50, fenwickPct5v5: 50,
    });
  });

  it('patineurs : CF%/FF% sur la glace à 5 c. 5, par identifiant NHL', () => {
    const s = parseSkatersCsv(SKATERS);
    expect(s['8478402']).toEqual({ team: 'EDM', gamesPlayed: 82, onIceCorsiPct: 54.5, onIceFenwickPct: 56.3 });
    expect(s['8480001'].team).toBe('NJD');
    expect(s['8480001'].onIceCorsiPct).toBe(25);
  });
});
