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
import { teamsForPost, teamsInText, flagsOf } from '../src/services/newsFeed';

const WEEK_MS = 7 * 24 * 60 * 60_000;
const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);

(async () => {
  // « top » : l'équipe la plus citée par le compte. Pour une source d'équipe,
  // elle doit être la sienne — sinon le journaliste a changé de poste ou l'équipe
  // saisie est fausse, et ses nouvelles seraient collées au mauvais club.
  console.log(`${pad('handle', 32)} ${pad('équipe', 6)} ${pad('7 j', 5)} ${pad('équipe', 7)} ${pad('drap.', 6)} ${pad('top', 9)} verdict`);
  let bad = 0;
  for (const src of NEWS_SOURCES) {
    try {
      const posts = (await fetchAuthorFeed(src.handle)).filter((p) => Date.now() - p.postedAt.getTime() < WEEK_MS);
      const withTeam = posts.filter((p) => teamsForPost(src.team, p.text).length > 0).length;
      const flagged  = posts.filter((p) => flagsOf(p.text).length > 0).length;
      const counts = new Map<string, number>();
      for (const p of posts) for (const t of teamsInText(p.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topLabel = top ? `${top[0]} ×${top[1]}` : '—';
      // Un journaliste attitré nomme rarement son équipe (« Kaprizov out tonight ») :
      // on ne signale que le compte qui ne la cite JAMAIS mais en cite une autre souvent.
      const wrongTeam = src.team !== null && top !== undefined && top[0] !== src.team && !counts.has(src.team) && top[1] >= 3;
      const verdict  = posts.length === 0 ? '⚠ inactif — retirer ?'
                     : wrongTeam          ? `⚠ cite surtout ${top![0]}, pas ${src.team}`
                     : withTeam === 0     ? '⚠ aucune équipe reconnue'
                     : 'ok';
      if (verdict !== 'ok') bad++;
      console.log(`${pad(src.handle, 32)} ${pad(src.team ?? 'ligue', 6)} ${pad(posts.length, 5)} ${pad(withTeam, 7)} ${pad(flagged, 6)} ${pad(topLabel, 9)} ${verdict}`);
    } catch (err: any) {
      bad++;
      console.log(`${pad(src.handle, 32)} ${pad(src.team ?? 'ligue', 6)} ✗ ${err?.message}`);
    }
  }
  console.log(`\n${NEWS_SOURCES.length} sources, ${bad} à revoir.`);
})();
