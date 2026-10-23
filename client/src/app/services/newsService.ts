/**
 * newsService.ts — fil de nouvelles d'un match (NEWS_CONSENSUS_PLAN.md, F1).
 * Lecture publique de `GET /api/news?teams=…`. Échec → liste vide (fallback
 * silencieux, comme les autres services) : le fil est un plus, pas un prérequis.
 */

import { env } from '../env';
import { fetchWithTimeout } from './http';

export type NewsFlag = 'goalie' | 'lineup' | 'transaction';

export interface NewsItem {
  id: number;
  source: 'bluesky' | 'manual' | 'nhl_roster';
  teams: string[];
  author: string;
  url: string;
  excerpt: string;
  flags: NewsFlag[];
  postedAt: string;
}

export async function fetchMatchNews(teams: string[], signal?: AbortSignal): Promise<NewsItem[]> {
  const q = encodeURIComponent(teams.join(','));
  try {
    const res = await fetchWithTimeout(`${env.nhlServerUrl}/api/news?teams=${q}`, { signal });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.items) ? body.items : [];
  } catch {
    return [];
  }
}
