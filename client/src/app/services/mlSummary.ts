/**
 * mlSummary.ts — les trois chiffres ML d'un match pour l'accueil et le
 * calendrier, par lots (PERF_PLAN.md, P1.1 — 2026-10-23).
 *
 * L'accueil et le calendrier lisaient le PAQUET ML complet de chaque match
 * (`/predict/game/:id/bundle`, ~171 ko : taux de tous les joueurs, échelles de
 * pénalités…) pour n'en afficher que trois nombres. Ici, `GET /predict/summary`
 * rend ces trois nombres pour plusieurs matchs à la fois (~100 octets par match),
 * lus côté serveur dans les mêmes paquets en cache.
 *
 * Regroupement : les demandes faites dans la même fenêtre de `BATCH_WINDOW_MS`
 * (toutes les lignes d'une liste qui montent ensemble, ou que le calendrier
 * découvre au défilement) partent en UNE requête, par lots de `MAX_IDS`.
 *
 * Cache : la PROMESSE par match, comme `fetchGameMlBundle` — 5 min avant le
 * match, 25 s en direct (le serveur recalcule toutes les 30 s, 10 s en fin de
 * match). Un `null` (indisponible) n'est pas gardé : la prochaine demande retente.
 *
 * La page du match garde le paquet complet (`fetchGameMlBundle`).
 */
import { env } from "../env";
import { fetchWithTimeout } from "./http";

export interface GameMlSummary {
  /** P(victoire domicile), 0–100. */
  homeWin: number | null;
  /** P(domicile −1.5) et P(visiteur −1.5), 0–100. */
  homeMinus: number | null;
  awayMinus: number | null;
  live?: { final: boolean; refreshMs?: number };
}

const BASE = `${env.nhlServerUrl}/api/predict`;
/** Même plafond que la route (`SUMMARY_MAX_IDS`, ml.routes.ts). */
const MAX_IDS = 20;
const BATCH_WINDOW_MS = 16;
const TTL_MS = 5 * 60_000;
const LIVE_TTL_MS = 25_000;

type Entry = { at: number; ttl: number; promise: Promise<GameMlSummary | null> };
const cache = new Map<string, Entry>();

let queue: { id: string; resolve: (v: GameMlSummary | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const pending = queue;
  queue = [];
  for (let i = 0; i < pending.length; i += MAX_IDS) {
    const chunk = pending.slice(i, i + MAX_IDS);
    const ids = chunk.map((p) => p.id).join(",");
    fetchWithTimeout(`${BASE}/summary?ids=${ids}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { games?: Record<string, GameMlSummary | null> }) : null))
      .catch(() => null)
      .then((body) => {
        for (const p of chunk) p.resolve(body?.games?.[p.id] ?? null);
      });
  }
}

export function fetchGameMlSummary(gameId: string): Promise<GameMlSummary | null> {
  const hit = cache.get(gameId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;

  const entry: Entry = {
    at: Date.now(),
    ttl: TTL_MS,
    promise: new Promise((resolve) => {
      queue.push({ id: gameId, resolve });
      if (!timer) timer = setTimeout(flush, BATCH_WINDOW_MS);
    }),
  };
  entry.promise.then((s) => {
    if (s === null && cache.get(gameId) === entry) cache.delete(gameId);
    if (s?.live && !s.live.final) {
      entry.ttl = Math.min(LIVE_TTL_MS, Math.max(5_000, (s.live.refreshMs ?? 30_000) - 2_000));
    }
  });
  cache.set(gameId, entry);
  return entry.promise;
}
