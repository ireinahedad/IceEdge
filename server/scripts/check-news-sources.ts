/**
 * check-news-sources.ts — vérifie les comptes de `src/data/newsSources.ts`.
 *
 *   npm run news:check
 *
 * Pour chaque handle : existe-t-il, combien de publications sur 7 jours, et
 * combien rattachées à une équipe / avec un drapeau. Lecture seule : n'écrit
 * rien en base. À lancer avant d'activer NEWS_SYNC_ENABLED, puis quand on
 * ajoute des sources.
 */

import 'dotenv/config';
import { NEWS_SOURCES } from '../src/data/newsSources';
import { fetchAuthorFeed } from '../src/services/newsSync.service';
import { teamsForPost, flagsOf } from '../src/services/newsFeed';

const WEEK_MS = 7 * 24 * 60 * 60_000;
const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);

(async () => {
  console.log(`${pad('handle', 32)} ${pad('équipe', 6)} ${pad('7 j', 5)} ${pad('équipe', 7)} ${pad('drap.', 6)} verdict`);
  let bad = 0;
  for (const src of NEWS_SOURCES) {
    try {
      const posts = (await fetchAuthorFeed(src.handle)).filter((p) => Date.now() - p.postedAt.getTime() < WEEK_MS);
      const withTeam = posts.filter((p) => teamsForPost(src.team, p.text).length > 0).length;
      const flagged  = posts.filter((p) => flagsOf(p.text).length > 0).length;
      const verdict  = posts.length === 0 ? '⚠ inactif — retirer ?' : withTeam === 0 ? '⚠ aucune équipe reconnue' : 'ok';
      if (verdict !== 'ok') bad++;
      console.log(`${pad(src.handle, 32)} ${pad(src.team ?? 'ligue', 6)} ${pad(posts.length, 5)} ${pad(withTeam, 7)} ${pad(flagged, 6)} ${verdict}`);
    } catch (err: any) {
      bad++;
      console.log(`${pad(src.handle, 32)} ${pad(src.team ?? 'ligue', 6)} ✗ ${err?.message}`);
    }
  }
  console.log(`\n${NEWS_SOURCES.length} sources, ${bad} à revoir.`);
})();
