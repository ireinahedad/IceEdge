/**
 * useNHLData
 * Fetches teams, games and players from the API and normalises
 * them into the flat shape that the existing components expect.
 *
 * Game-date fallback: today → tomorrow → next 7 days (une seule requête
 * `/games/range`, voir `fetchGamesWithFallback`).
 *
 * Les données sont PARTAGÉES entre tous les composants qui appellent le hook
 * (Stats, Prédictions NHL, feuille « More bets ») et gardées 5 min : voir
 * `loadShared`.
 */

import { useState, useEffect, useCallback } from 'react';
import { nhlApiService } from '../services/nhlApiService';
import { nhlLogoUrl } from '../data/teamEmoji';

// ─── Normalised shapes (what the UI components consume) ───────────────────────

export interface UITeam {
  id: string;       // abbreviation lowercase, e.g. "bos"
  name: string;
  abbr: string;
  logo: string;     // official NHL logo URL (SVG)
  conf: string;     // "East" | "West"
  record: string;   // "48-22-8"
  pts: number;
  /** `null` = le backend ne l'a pas fourni. Jamais 50 par défaut. */
  winPct: number | null;
  homeRecord: string;
  awayRecord: string;
  streak: string;
  ppPct: number;
  pkPct: number;
  goalsFor: number;
  goalsAgainst: number;
  color: string;
}

export interface UIGame {
  id: string;
  date: string;       // "Apr 27"
  /** Journée LNH du match, `YYYY-MM-DD` — pour le jour de semaine et les titres par jour. */
  gameDate: string;
  time: string;       // "7:00 PM ET"
  /** Mise au jeu, instant ISO — sert à dire « match en cours » sur le coupon. */
  startTimeUTC: string | null;
  status: string;
  team1Id: string;    // home, abbr lowercase
  team2Id: string;    // away, abbr lowercase
  odds1?: number;
  odds2?: number;
  overUnder?: number;
  venue?: string;
  /** Probabilités du modèle/moteur de règles. `null` = non fournies. */
  winPct1: number | null;
  winPct2: number | null;
}

export interface UIPlayer {
  id: string;
  name: string;
  teamId: string;     // abbr lowercase
  position: string;
  number: number;
  goals: number;
  assists: number;
  points: number;
  plusMinus: number;
  shots: number;
  shotPct: number;
  ppPoints: number;
  gamesPlayed: number;
  lastFive: number[];
  winImpact: number;
}

// ─── Transform helpers ────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  // "2026-04-27" → "Apr 27"
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function toUITeam(t: any): UITeam {
  return {
    id:           t.abbreviation?.toLowerCase() ?? String(t.id),
    name:         t.name,
    abbr:         t.abbreviation,
    logo:         t.abbreviation ? nhlLogoUrl(t.abbreviation) : '',
    conf:         t.conference === 'Eastern' ? 'East' : 'West',
    record:       `${t.wins ?? 0}-${t.losses ?? 0}-${t.otLosses ?? 0}`,
    pts:          t.points ?? 0,
    winPct:       t.winPct == null ? null : Math.round(Number(t.winPct)),
    homeRecord:   t.homeRecord ?? '',
    awayRecord:   t.awayRecord ?? '',
    streak:       t.streak ?? '',
    ppPct:        Number(t.ppPct ?? 0),
    pkPct:        Number(t.pkPct ?? 0),
    goalsFor:     Number(t.goalsFor ?? 0),
    goalsAgainst: Number(t.goalsAgainst ?? 0),
    color:        t.color ?? '#86d1ea',
  };
}

export function toUIGame(g: any): UIGame {
  return {
    id:        g.id,
    date:      formatDate(g.gameDate),
    gameDate:  String(g.gameDate ?? '').slice(0, 10),
    time:      g.startTime,
    startTimeUTC: g.startTimeUTC ?? null,
    status:    g.status,
    team1Id:   g.homeTeam?.abbreviation?.toLowerCase() ?? '',
    team2Id:   g.awayTeam?.abbreviation?.toLowerCase() ?? '',
    odds1:     g.homeTeam?.odds,
    odds2:     g.awayTeam?.odds,
    overUnder: g.overUnder ? Number(g.overUnder) : undefined,
    venue:     g.venue,
    winPct1:   g.homeWinPct ?? null,
    winPct2:   g.awayWinPct ?? null,
  };
}

function toUIPlayer(p: any): UIPlayer {
  return {
    id:          String(p.id),
    name:        p.name ?? p.fullName,
    teamId:      p.teamAbbr?.toLowerCase() ?? (p.teamId ? String(p.teamId) : ''),
    position:    p.position,
    number:      p.number ?? p.jerseyNumber ?? 0,
    goals:       p.goals ?? 0,
    assists:     p.assists ?? 0,
    points:      p.points ?? 0,
    plusMinus:   p.plusMinus ?? 0,
    shots:       p.shots ?? 0,
    shotPct:     Number(p.shotPct ?? p.shootingPct ?? 0),
    ppPoints:    p.ppPoints ?? 0,
    gamesPlayed: p.gamesPlayed ?? 0,
    lastFive:    p.lastFive ?? [],
    winImpact:   p.winImpact ?? 0,
  };
}

/** Shift a YYYY-MM-DD string by `days` days. */
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── Chargement partagé ───────────────────────────────────────────────────────

/**
 * Les matchs des DEUX PROCHAINS JOURS, sur UNE seule requête.
 *
 * Avant : « le premier jour qui a des matchs », et à défaut la semaine entière
 * d'un coup — la page Stats pouvait donc afficher sept jours de calendrier
 * dans une liste censée montrer ce qui se joue maintenant. La fenêtre est
 * désormais fixe : aujourd'hui + demain, triés par mise au jeu.
 *
 * Le repli reste, et il est nécessaire : de juin à septembre ces deux jours
 * sont vides, et rendre une liste vide viderait aussi la feuille « Plus de
 * paris », qui se sert de la même donnée. On montre alors la PROCHAINE journée
 * qui a des matchs dans les sept jours, avec sa date en étiquette — jamais
 * plus d'une journée à la fois.
 *
 * Avant le 2026-09-16 : `/games?date=` jour par jour — aujourd'hui, demain, puis
 * six appels pour J+2…J+7. Hors saison (l'état réel de septembre) chaque visite
 * de Stats ou de Prédictions NHL coûtait 8 requêtes, et chaque `catch {}`
 * transformait une panne de l'API en « Aucun match », sans bouton Réessayer.
 * `/games/range` existe et le serveur la sert depuis ses semaines en cache.
 *
 * ⚠️ Une erreur REMONTE désormais : elle fait échouer le chargement, et l'écran
 * affiche son erreur et son bouton au lieu d'un état vide mensonger.
 */
async function fetchGamesWithFallback(): Promise<{ games: UIGame[]; label: string }> {
  const today = new Date().toISOString().split('T')[0];
  const raw = await nhlApiService.getGamesRange(today, shiftDate(today, 7));

  const byDay = new Map<string, any[]>();
  for (const g of raw) {
    const day = String(g.gameDate ?? '').slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(g); else byDay.set(day, [g]);
  }

  // Mise au jeu la plus proche en premier. `startTimeUTC` est un instant ;
  // `startTime` est déjà localisée (« 7:00 PM ») et ne se trie pas.
  const byFaceoff = (a: any, b: any) => {
    const ms = (g: any) => {
      const t = g?.startTimeUTC ? new Date(g.startTimeUTC).getTime() : NaN;
      return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
    };
    const d = ms(a) - ms(b);
    return d !== 0 ? d : String(a?.id).localeCompare(String(b?.id));
  };

  const todayGames    = byDay.get(today) ?? [];
  const tomorrowGames = byDay.get(shiftDate(today, 1)) ?? [];
  const twoDays       = [...todayGames, ...tomorrowGames].sort(byFaceoff);

  if (twoDays.length > 0) {
    // Jeton, pas texte : la page le traduit (`gamesLabelText`, StatsPage).
    const label =
      todayGames.length > 0 && tomorrowGames.length > 0 ? "@todayTomorrow"
      : todayGames.length > 0                           ? "@today"
      :                                                   "@tomorrow";
    return { games: twoDays.map(toUIGame), label };
  }

  // Hors-saison : la prochaine journée qui a des matchs, elle seule.
  for (const n of [2, 3, 4, 5, 6, 7]) {
    const day   = shiftDate(today, n);
    const games = byDay.get(day) ?? [];
    if (games.length === 0) continue;
    // La date brute (AAAA-MM-JJ) : formatée dans la langue de l'app par la page.
    return { games: [...games].sort(byFaceoff).map(toUIGame), label: day };
  }

  return { games: [], label: "@none" };
}

interface SharedData {
  teams:      UITeam[];
  games:      UIGame[];
  players:    UIPlayer[];
  gamesLabel: string;
}

/**
 * Un seul chargement pour toute l'application, gardé `SHARED_TTL_MS`.
 *
 * Avant le 2026-09-16 chaque composant qui appelait `useNHLData()` refaisait
 * ses propres appels — dont `/nhl/players`, la plus grosse charge utile de
 * l'API. La feuille « More bets » monte le hook à CHAQUE ouverture : 5
 * ouvertures = 5 × équipes + matchs + joueurs (25 requêtes serveur une fois le
 * cache HTTP expiré).
 *
 * On garde la PROMESSE (deux composants montés ensemble partagent l'appel en
 * vol) et les tableaux DÉJÀ NORMALISÉS : rendre les mêmes références à chaque
 * lecteur est ce qui garde `getTeamById` stable (voir l'avertissement du hook).
 * Un échec vide l'entrée : le prochain montage ou `reload()` retente.
 */
const SHARED_TTL_MS = 5 * 60_000;
let shared: { at: number; promise: Promise<SharedData>; value?: SharedData } | null = null;

function freshShared(): SharedData | undefined {
  return shared?.value && Date.now() - shared.at < SHARED_TTL_MS ? shared.value : undefined;
}

function loadShared(force: boolean): Promise<SharedData> {
  if (!force && shared && (shared.value === undefined || Date.now() - shared.at < SHARED_TTL_MS)) {
    return shared.promise;
  }
  const entry = { at: Date.now() } as { at: number; promise: Promise<SharedData>; value?: SharedData };
  entry.promise = Promise.all([
    nhlApiService.getAllTeams(),
    fetchGamesWithFallback(),
    nhlApiService.getAllPlayers(),
  ]).then(
    ([rawTeams, { games, label }, rawPlayers]) => {
      const value: SharedData = {
        teams:      rawTeams.map(toUITeam),
        games,
        players:    rawPlayers.map(toUIPlayer),
        gamesLabel: label,
      };
      entry.value = value;
      return value;
    },
    (err) => {
      if (shared === entry) shared = null;
      throw err;
    },
  );
  shared = entry;
  return entry.promise;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface NHLData {
  teams:       UITeam[];
  games:       UIGame[];
  players:     UIPlayer[];
  /**
   * Jeton du jour affiché : "@today" | "@tomorrow" | "@todayTomorrow" | "@none",
   * ou une date AAAA-MM-JJ. À passer par `gamesLabelText` pour l'afficher.
   */
  gamesLabel:  string;
  loading:     boolean;
  error:       string | null;
  /**
   * Rejoue les trois appels. Rien d'autre ne relance ce hook : son effet est
   * monté une fois pour toute la vie de la page, donc sans ça un échec réseau
   * restait à l'écran jusqu'à un rechargement complet de l'application.
   */
  reload:      () => void;
  getTeamById:   (id: string) => UITeam | undefined;
  getGameById:   (id: string) => UIGame | undefined;
  getPlayerById: (id: string) => UIPlayer | undefined;
}

export function useNHLData(): NHLData {
  // Données déjà chargées par un autre écran : rendues au premier rendu, sans
  // squelette ni requête.
  const [initial] = useState(freshShared);
  const [teams,      setTeams]      = useState<UITeam[]>(initial?.teams ?? []);
  const [games,      setGames]      = useState<UIGame[]>(initial?.games ?? []);
  const [gamesLabel, setGamesLabel] = useState<string>(initial?.gamesLabel ?? "@today");
  const [players,    setPlayers]    = useState<UIPlayer[]>(initial?.players ?? []);
  const [loading,    setLoading]    = useState(!initial);
  const [error,      setError]      = useState<string | null>(null);
  const [reloadKey,  setReloadKey]  = useState(0);

  useEffect(() => {
    let alive = true;
    // `reload()` force un nouvel appel ; un montage simple lit le partagé.
    const force = reloadKey > 0;
    if (force || !freshShared()) setLoading(true);

    loadShared(force)
      .then((data) => {
        if (!alive) return;
        // Mêmes références que le partagé : un setState identique ne re-rend
        // pas, et `getTeamById` garde son identité.
        setTeams(data.teams);
        setGames(data.games);
        setGamesLabel(data.gamesLabel);
        setPlayers(data.players);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message ?? 'Failed to load NHL data');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => { alive = false; };
  }, [reloadKey]);

  // ⚠️ Ces quatre fonctions DOIVENT garder la même identité d'un rendu à
  // l'autre. `NHLPredictionsPage` met `getTeamById` dans les dépendances d'un
  // effet qui fait des appels réseau puis un `setState` : recréée à chaque
  // rendu, elle relançait l'effet sans fin — mesuré le 2026-09-16 en
  // production à ~500 `GET /api/nhl/teams/:id/stats` par seconde dès que des
  // matchs entraient dans la fenêtre. Ne pas retirer les `useCallback`.
  const getTeamById   = useCallback((id: string) => teams.find(t => t.id === id), [teams]);
  const getGameById   = useCallback((id: string) => games.find(g => g.id === id), [games]);
  const getPlayerById = useCallback((id: string) => players.find(p => p.id === id), [players]);

  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  return { teams, games, players, gamesLabel, loading, error, reload, getTeamById, getGameById, getPlayerById };
}

/** Texte affichable d'un `gamesLabel`, dans la langue de l'app. */
export function gamesLabelText(label: string, t: (k: string) => string, lang: "en" | "fr"): string {
  switch (label) {
    case "@today":         return t("stats.day.today");
    case "@tomorrow":      return t("stats.day.tomorrow");
    case "@todayTomorrow": return t("stats.day.todayTomorrow");
    case "@none":          return t("stats.day.none");
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (!m) return label;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}
