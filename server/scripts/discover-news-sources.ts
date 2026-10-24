/**
 * discover-news-sources.ts — cherche des comptes Bluesky pour les équipes sans
 * source dédiée (NEWS_CONSENSUS_PLAN.md, étape 2).
 *
 *   npm run news:discover              toutes les équipes sans source
 *   npm run news:discover -- VGK STL   seulement ces équipes
 *
 * Lecture seule : n'écrit rien en base ni dans le code. La sortie liste, par
 * équipe, les meilleurs candidats et des lignes prêtes à coller dans
 * `src/data/newsSources.ts`. Relire chaque compte avant de l'ajouter, puis
 * relancer `npm run news:check`. Coût : ~4 recherches + ≤ 12 fils par équipe,
 * API publique sans clé ; rien en production.
 */

import 'dotenv/config';
import { NEWS_SOURCES, REJECTED_HANDLES } from '../src/data/newsSources';
import { fetchAuthorFeed } from '../src/services/newsSync.service';
import {
  teamsToSearch, searchQueries, parseActors, profileMatches, checkCandidate, bestCandidates, sourceLine,
  type Actor, type CandidateCheck,
} from '../src/services/newsDiscover';

const SEARCH = 'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors';
const MAX_FEEDS_PER_TEAM = 12;
const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(q: string): Promise<Actor[]> {
  const res = await fetch(`${SEARCH}?q=${encodeURIComponent(q)}&limit=25`, {
    headers: { 'User-Agent': 'ArakIce/1.0 (+https://arakice.com)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Bluesky ${res.status} pour « ${q} »`);
  return parseActors(await res.json());
}

(async () => {
  const teams = teamsToSearch(NEWS_SOURCES, process.argv.slice(2));
  // Déjà dans la liste, ou refusés au tri (`REJECTED_HANDLES`) : jamais reproposés.
  const known = new Set([...NEWS_SOURCES.map((s) => s.handle), ...REJECTED_HANDLES].map((h) => h.toLowerCase()));
  console.log(`Recherche pour ${teams.length} équipe(s) : ${teams.join(', ')}\n`);
  const lines: string[] = [];

  for (const team of teams) {
    // 1. Profils candidats, dédoublonnés, déjà connus écartés, pré-triés sur le profil.
    const seen = new Map<string, Actor>();
    for (const q of searchQueries(team)) {
      try {
        for (const a of await search(q)) {
          const h = a.handle.toLowerCase();
          if (!known.has(h) && !seen.has(h)) seen.set(h, a);
        }
      } catch (err: any) {
        console.log(`  ✗ ${err?.message}`);
      }
      await sleep(250);
    }
    const shortlist = [...seen.values()].filter((a) => profileMatches(a, team)).slice(0, MAX_FEEDS_PER_TEAM);

    // 2. Le même contrôle que news:check sur chaque candidat.
    const checks: CandidateCheck[] = [];
    for (const a of shortlist) {
      try {
        checks.push(checkCandidate(a, team, await fetchAuthorFeed(a.handle), Date.now()));
      } catch { /* compte illisible : ignoré */ }
      await sleep(150);
    }

    const best = bestCandidates(checks);
    console.log(`── ${team} — ${seen.size} profils, ${shortlist.length} lus, ${best.length} retenu(s)`);
    for (const c of checks.sort((x, y) => y.score - x.score).slice(0, 6)) {
      const top = c.top ? `${c.top[0]} ×${c.top[1]}` : '—';
      console.log(`   ${pad(c.handle, 34)} ${pad(c.active, 4)} actifs  ${pad(c.teamPosts, 3)} ${team}  ${pad(c.flagged, 3)} drap.  top ${pad(top, 9)} ${c.verdict}`);
    }
    for (const c of best) lines.push(sourceLine(c));
    console.log('');
  }

  console.log('── À relire, puis coller dans src/data/newsSources.ts (section Équipes) :\n');
  console.log(lines.length ? lines.join('\n') : '  (aucun candidat retenu)');
  console.log('\nEnsuite : npm run news:check');
})();
