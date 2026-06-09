/**
 * tennisApiClient.ts
 * Fetches real-time tennis data from Tennis Live Data (RapidAPI).
 * Docs: https://rapidapi.com/sportcontentapi/api/tennis-live-data
 *
 * Add to server/.env:
 *   RAPIDAPI_KEY=your_key_here
 */

const BASE = "https://tennis-live-data.p.rapidapi.com";
const KEY = process.env.RAPIDAPI_KEY;

// --- TTL cache ---------------------------------------------------------------

interface CacheEntry { data: unknown; expiresAt: number }
const _cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  const e = _cache.get(key);
  return e && Date.now() < e.expiresAt ? (e.data as T) : null;
}
function setCached(key: string, data: unknown, ttlMs: number) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function rapidGet<T>(path: string, ttlMs = 60_000): Promise<T> {
  if (!KEY) throw new Error("RAPIDAPI_KEY not set in server/.env");
  const cached = getCached<T>(path);
  if (cached) return cached;
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "x-rapidapi-host": "tennis-live-data.p.rapidapi.com",
      "x-rapidapi-key": KEY,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tennis RapidAPI ${res.status}: ${body}`);
  }
  const data = (await res.json()) as T;
  setCached(path, data, ttlMs);
  return data;
}

// --- Country code → flag emoji -----------------------------------------------

const FLAGS: Record<string, string> = {
  SRB: "🇷🇸", ESP: "🇪🇸", ITA: "🇮🇹", GER: "🇩🇪", RUS: "🇷🇺",
  POL: "🇵🇱", BLR: "🇧🇾", USA: "🇺🇸", KAZ: "🇰🇿", GBR: "🇬🇧",
  FRA: "🇫🇷", GRE: "🇬🇷", DEN: "🇩🇰", CAN: "🇨🇦", AUS: "🇦🇺",
  ARG: "🇦🇷", NOR: "🇳🇴", SUI: "🇨🇭", CRO: "🇭🇷", CZE: "🇨🇿",
  NED: "🇳🇱", BEL: "🇧🇪", SWE: "🇸🇪", FIN: "🇫🇮", POR: "🇵🇹",
  CHN: "🇨🇳", JPN: "🇯🇵", KOR: "🇰🇷", BRA: "🇧🇷", MEX: "🇲🇽",
  RSA: "🇿🇦", UKR: "🇺🇦", HUN: "🇭🇺", SVK: "🇸🇰", ROU: "🇷🇴",
  BUL: "🇧🇬", LAT: "🇱🇻", EST: "🇪🇪", LTU: "🇱🇹", SLO: "🇸🇮",
  MDA: "🇲🇩", GEO: "🇬🇪", ARM: "🇦🇲", AZE: "🇦🇿",
};

function toFlag(code: string): string {
  return FLAGS[code?.toUpperCase()] ?? "🌐";
}

const SURFACE_ICONS: Record<string, string> = {
  Clay: "🟫", Hard: "🟦", Grass: "🟩",
  Carpet: "🏟", Indoor: "🏟", Indoor_Hard: "🏟",
};

// --- Raw RapidAPI types ------------------------------------------------------

interface RawPlayer {
  id: number;
  name: string;
  country: string;
  flag: string;
}

interface RawTournament {
  id: number;
  name: string;
  surface?: string;
  gender?: string;
}

interface RawScore {
  sets?: { home?: number[]; away?: number[] };
  games?: { home?: number; away?: number };
}

interface RawStatus {
  type: string;           // "inprogress" | "notstarted" | "finished"
  set?: number;
  name?: string;          // "1st Set", "2nd Set", etc.
  serving?: string;       // "home" | "away"
}

interface RawMatch {
  id: number;
  tournament: RawTournament;
  home: RawPlayer;
  away: RawPlayer;
  score?: RawScore;
  status: RawStatus;
  scheduled?: string;     // ISO datetime string
}

interface RawResponse {
  results: RawMatch[];
}

// --- Normalized output type --------------------------------------------------

export interface TennisApiMatch {
  id: string;
  tournament: string;
  surface: string;
  surfaceIcon: string;
  isLive: boolean;
  liveSet?: string;
  scheduledIso?: string;
  player1: {
    id: string;
    name: string;
    country: string;      // flag emoji
    countryCode: string;  // e.g. "SRB" — used for odds matching
    sets?: number[];
    serving?: boolean;
  };
  player2: {
    id: string;
    name: string;
    country: string;
    countryCode: string;
    sets?: number[];
    serving?: boolean;
  };
}

function normalizeMatch(m: RawMatch): TennisApiMatch {
  const surface = m.tournament?.surface ?? "Hard";
  const isLive = m.status?.type === "inprogress";
  const setNum = m.status?.set;

  // "2nd Set" → "SET 2", or fall back to "SET {n}"
  let liveSet: string | undefined;
  if (isLive) {
    liveSet = setNum ? `SET ${setNum}` : "LIVE";
  }

  const homeSets = m.score?.sets?.home ?? [];
  const awaySets = m.score?.sets?.away ?? [];

  return {
    id: String(m.id),
    tournament: m.tournament?.name ?? "Unknown Tournament",
    surface,
    surfaceIcon: SURFACE_ICONS[surface] ?? "🎾",
    isLive,
    liveSet,
    scheduledIso: m.scheduled,
    player1: {
      id: String(m.home?.id ?? ""),
      name: m.home?.name ?? "Player 1",
      country: toFlag(m.home?.flag),
      countryCode: m.home?.flag ?? "",
      sets: homeSets.length ? homeSets : undefined,
      serving: isLive && m.status?.serving === "home" ? true : undefined,
    },
    player2: {
      id: String(m.away?.id ?? ""),
      name: m.away?.name ?? "Player 2",
      country: toFlag(m.away?.flag),
      countryCode: m.away?.flag ?? "",
      sets: awaySets.length ? awaySets : undefined,
      serving: isLive && m.status?.serving === "away" ? true : undefined,
    },
  };
}

// --- Public API functions ----------------------------------------------------

/** Currently live matches. Cached 30 s. */
export async function fetchLiveMatches(): Promise<TennisApiMatch[]> {
  const data = await rapidGet<RawResponse>("/matches/live", 30_000);
  return (data.results ?? []).map(normalizeMatch);
}

/** Fixtures for a given day (defaults to today). Cached 5 min. */
export async function fetchFixtures(date?: Date): Promise<TennisApiMatch[]> {
  const d = date ?? new Date();
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  const data = await rapidGet<RawResponse>(`/fixtures/${day}/${month}/${year}`, 5 * 60_000);
  return (data.results ?? [])
    .filter((m) => m.status?.type === "notstarted")
    .map(normalizeMatch);
}
