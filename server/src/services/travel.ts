/**
 * travel.ts
 * Logique PURE des « spots » de calendrier (voyage / fuseaux / altitude /
 * road-trip). Aucune I/O — testable et IDENTIQUE au miroir Python
 * (build_dataset.py::add_travel). Les callers fournissent la séquence ordonnée
 * des matchs d'une équipe ; ce module en dérive les features du match visé.
 *
 * Convention de signe : voir chaque champ. Le modèle apprend le sens ;
 * l'important est la COHÉRENCE avec la piste historique.
 */
import { getArena } from '../data/arenas';

/** Un match du point de vue d'UNE équipe, ordonné par date croissante. */
export interface TravelGame {
  date: string;       // 'YYYY-MM-DD'
  venueAbbr: string;  // abréviation de l'équipe à domicile = aréna hôte
  isHome: boolean;    // l'équipe suivie joue-t-elle à domicile ce soir-là ?
}

export interface TravelFeatures {
  distance_km:    number; // trajet aréna précédent → aréna courant (haversine)
  tz_shift:       number; // offset(courant) − offset(précédent), en heures (+ = vers l'est)
  days_away:      number; // jours depuis le dernier match à domicile (0 si domicile)
  road_trip_len:  number; // longueur totale du road trip en cours (0 si domicile)
  road_game_num:  number; // rang du match dans le trip (1er, 2e… ; 0 si domicile)
  getaway:        0 | 1;  // dernier match du road trip (le prochain est à domicile)
  alt_gain:       number; // altitude(courant) − altitude(précédent), en mètres
}

const R_EARTH_KM = 6371;

/** Distance grand-cercle entre deux arénas (km). 0 si l'un est inconnu. */
function haversine(aAbbr: string, bAbbr: string): number {
  const a = getArena(aAbbr);
  const b = getArena(bAbbr);
  if (!a || !b) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R_EARTH_KM * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime();
  return Math.round(ms / 86_400_000);
}

const ZERO: TravelFeatures = {
  distance_km: 0, tz_shift: 0, days_away: 0,
  road_trip_len: 0, road_game_num: 0, getaway: 0, alt_gain: 0,
};

/**
 * Calcule les features voyage du match `idx` dans la séquence `games`
 * (ordonnée par date). Logique volontairement identique à Python.
 */
export function computeTravel(games: TravelGame[], idx: number): TravelFeatures {
  if (idx < 0 || idx >= games.length) return { ...ZERO };
  const g = games[idx];
  const cur = getArena(g.venueAbbr);
  const prevArena = idx > 0 ? getArena(games[idx - 1].venueAbbr) : null;

  // ── Segment de vol depuis l'aréna précédent ──────────────────────────────
  let distance_km = 0, tz_shift = 0, alt_gain = 0;
  if (idx > 0 && cur && prevArena) {
    distance_km = haversine(games[idx - 1].venueAbbr, g.venueAbbr);
    tz_shift    = cur.tz  - prevArena.tz;
    alt_gain    = cur.alt - prevArena.alt;
  }

  // ── Métriques road-trip ──────────────────────────────────────────────────
  if (g.isHome) {
    return { distance_km, tz_shift, alt_gain, days_away: 0,
             road_trip_len: 0, road_game_num: 0, getaway: 0 };
  }

  // rang dans le trip : matchs away consécutifs jusqu'ici (inclus)
  let road_game_num = 0;
  for (let j = idx; j >= 0 && !games[j].isHome; j--) road_game_num++;
  // longueur totale : + matchs away consécutifs à venir
  let road_trip_len = road_game_num;
  for (let j = idx + 1; j < games.length && !games[j].isHome; j++) road_trip_len++;
  // get-away : le prochain match est à domicile
  const getaway: 0 | 1 = idx + 1 < games.length && games[idx + 1].isHome ? 1 : 0;
  // jours loin de la maison : depuis le dernier match à domicile
  let days_away = 0;
  let lastHome = -1;
  for (let j = idx - 1; j >= 0; j--) if (games[j].isHome) { lastHome = j; break; }
  if (lastHome >= 0) days_away = daysBetween(games[lastHome].date, g.date);
  else if (games.length) days_away = daysBetween(games[0].date, g.date);

  return { distance_km, tz_shift, alt_gain, days_away,
           road_trip_len, road_game_num, getaway };
}
