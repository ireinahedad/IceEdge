/**
 * arenas.ts
 * Miroir TYPÉ de ml/data/arenas.json (source de vérité côté ML).
 * Bundlé par tsc → toujours présent dans dist/ (contrairement à un .json).
 * Garder EN PHASE avec ml/data/arenas.json.
 *
 *  tz  = offset UTC STANDARD (heures, sans DST) — suffisant pour un delta
 *        RELATIF entre villes nord-américaines (elles basculent ensemble).
 *  alt = altitude du terrain en mètres.
 * Clés = abréviations canoniques NHL (cf. norm_team côté Python).
 */

export interface Arena {
  name: string;
  city: string;
  lat: number;
  lon: number;
  tz: number;   // offset UTC standard (h)
  alt: number;  // altitude (m)
}

export const ARENAS: Record<string, Arena> = {
  ANA: { name: 'Honda Center',            city: 'Anaheim',        lat: 33.8078,  lon: -117.8765, tz: -8, alt: 48 },
  BOS: { name: 'TD Garden',               city: 'Boston',         lat: 42.3662,  lon: -71.0621,  tz: -5, alt: 6 },
  BUF: { name: 'KeyBank Center',          city: 'Buffalo',        lat: 42.8750,  lon: -78.8765,  tz: -5, alt: 183 },
  CGY: { name: 'Scotiabank Saddledome',   city: 'Calgary',        lat: 51.0374,  lon: -114.0519, tz: -7, alt: 1045 },
  CAR: { name: 'Lenovo Center',           city: 'Raleigh',        lat: 35.8033,  lon: -78.7219,  tz: -5, alt: 123 },
  CHI: { name: 'United Center',           city: 'Chicago',        lat: 41.8807,  lon: -87.6742,  tz: -6, alt: 182 },
  COL: { name: 'Ball Arena',              city: 'Denver',         lat: 39.7487,  lon: -105.0077, tz: -7, alt: 1609 },
  CBJ: { name: 'Nationwide Arena',        city: 'Columbus',       lat: 39.9694,  lon: -83.0060,  tz: -5, alt: 230 },
  DAL: { name: 'American Airlines Center',city: 'Dallas',         lat: 32.7905,  lon: -96.8104,  tz: -6, alt: 131 },
  DET: { name: 'Little Caesars Arena',    city: 'Detroit',        lat: 42.3411,  lon: -83.0553,  tz: -5, alt: 183 },
  EDM: { name: 'Rogers Place',            city: 'Edmonton',       lat: 53.5469,  lon: -113.4979, tz: -7, alt: 668 },
  FLA: { name: 'Amerant Bank Arena',      city: 'Sunrise',        lat: 26.1585,  lon: -80.3255,  tz: -5, alt: 3 },
  LAK: { name: 'Crypto.com Arena',        city: 'Los Angeles',    lat: 34.0430,  lon: -118.2673, tz: -8, alt: 89 },
  MIN: { name: 'Xcel Energy Center',      city: 'Saint Paul',     lat: 44.9447,  lon: -93.1010,  tz: -6, alt: 213 },
  MTL: { name: 'Bell Centre',             city: 'Montreal',       lat: 45.4961,  lon: -73.5693,  tz: -5, alt: 40 },
  NSH: { name: 'Bridgestone Arena',       city: 'Nashville',      lat: 36.1593,  lon: -86.7785,  tz: -6, alt: 168 },
  NJD: { name: 'Prudential Center',       city: 'Newark',         lat: 40.7336,  lon: -74.1711,  tz: -5, alt: 2 },
  NYI: { name: 'UBS Arena',               city: 'Elmont',         lat: 40.7106,  lon: -73.7227,  tz: -5, alt: 24 },
  NYR: { name: 'Madison Square Garden',   city: 'New York',       lat: 40.7505,  lon: -73.9934,  tz: -5, alt: 10 },
  OTT: { name: 'Canadian Tire Centre',    city: 'Ottawa',         lat: 45.2969,  lon: -75.9272,  tz: -5, alt: 91 },
  PHI: { name: 'Wells Fargo Center',      city: 'Philadelphia',   lat: 39.9012,  lon: -75.1720,  tz: -5, alt: 5 },
  PIT: { name: 'PPG Paints Arena',        city: 'Pittsburgh',     lat: 40.4395,  lon: -79.9896,  tz: -5, alt: 223 },
  SJS: { name: 'SAP Center',              city: 'San Jose',       lat: 37.3327,  lon: -121.9013, tz: -8, alt: 26 },
  SEA: { name: 'Climate Pledge Arena',    city: 'Seattle',        lat: 47.6221,  lon: -122.3540, tz: -8, alt: 34 },
  STL: { name: 'Enterprise Center',       city: 'Saint Louis',    lat: 38.6268,  lon: -90.2027,  tz: -6, alt: 142 },
  TBL: { name: 'Amalie Arena',            city: 'Tampa',          lat: 27.9427,  lon: -82.4518,  tz: -5, alt: 4 },
  TOR: { name: 'Scotiabank Arena',        city: 'Toronto',        lat: 43.6435,  lon: -79.3791,  tz: -5, alt: 76 },
  UTA: { name: 'Delta Center',            city: 'Salt Lake City', lat: 40.7683,  lon: -111.9011, tz: -7, alt: 1288 },
  VAN: { name: 'Rogers Arena',            city: 'Vancouver',      lat: 49.2778,  lon: -123.1088, tz: -8, alt: 3 },
  VGK: { name: 'T-Mobile Arena',          city: 'Las Vegas',      lat: 36.1029,  lon: -115.1783, tz: -8, alt: 620 },
  WSH: { name: 'Capital One Arena',       city: 'Washington',     lat: 38.8981,  lon: -77.0209,  tz: -5, alt: 7 },
  WPG: { name: 'Canada Life Centre',      city: 'Winnipeg',       lat: 49.8927,  lon: -97.1436,  tz: -6, alt: 239 },
};

/** Le live ne concerne que la géographie ACTUELLE → pas de relocations ici
 *  (elles ne servent qu'à l'historique côté Python). */
export function getArena(abbr: string): Arena | null {
  return ARENAS[(abbr || '').toUpperCase()] ?? null;
}
