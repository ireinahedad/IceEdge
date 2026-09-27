/**
 * oddsTeamNames.ts — nom complet The Odds API → abréviation NHL (celle du spine).
 *
 * Sorti de `oddsLogger.service.ts` le 2026-09-27 : le proxy des prix de jambes
 * (`POST /api/odds/legs`) et les Meilleurs paris en ont besoin aussi. Apparier
 * sur l'ABRÉVIATION plutôt que sur un `includes` de noms : « Montréal » avec
 * accent, « Utah Hockey Club » devenu « Utah Mammoth »… un appariement flou
 * collerait le prix d'un autre match.
 */

// The Odds API renvoie les noms complets → abréviations NHL (= celles du spine).
export const NAME_TO_ABBR: Record<string, string> = {
  'anaheim ducks': 'ANA', 'arizona coyotes': 'UTA', 'utah hockey club': 'UTA',
  'utah mammoth': 'UTA', 'boston bruins': 'BOS', 'buffalo sabres': 'BUF',
  'calgary flames': 'CGY', 'carolina hurricanes': 'CAR', 'chicago blackhawks': 'CHI',
  'colorado avalanche': 'COL', 'columbus blue jackets': 'CBJ', 'dallas stars': 'DAL',
  'detroit red wings': 'DET', 'edmonton oilers': 'EDM', 'florida panthers': 'FLA',
  'los angeles kings': 'LAK', 'minnesota wild': 'MIN', 'montreal canadiens': 'MTL',
  'montréal canadiens': 'MTL', 'nashville predators': 'NSH', 'new jersey devils': 'NJD',
  'new york islanders': 'NYI', 'new york rangers': 'NYR', 'ottawa senators': 'OTT',
  'philadelphia flyers': 'PHI', 'pittsburgh penguins': 'PIT', 'san jose sharks': 'SJS',
  'seattle kraken': 'SEA', 'st louis blues': 'STL', 'st. louis blues': 'STL',
  'tampa bay lightning': 'TBL', 'toronto maple leafs': 'TOR', 'vancouver canucks': 'VAN',
  'vegas golden knights': 'VGK', 'washington capitals': 'WSH', 'winnipeg jets': 'WPG',
};

export function toAbbr(name: string): string | null {
  return NAME_TO_ABBR[(name || '').toLowerCase().trim()] ?? null;
}
