/**
 * discover-news-sources.ts — cherche des comptes Bluesky pour les équipes sans
 * source dédiée (NEWS_CONSENSUS_PLAN.md, étape 2).
 *
 *   npm run news:discover              toutes les équipes sans source
 *   npm run news:discover -- VGK STL   seulement ces équipes
 *
 * Deux façons de trouver des candidats :
 *   1. Recherche de profils (`searchActors`, public, sans clé) : surnom, ville,
 *      « beat writer », et depuis le 2026-10-25 les médias locaux
 *      (`LOCAL_OUTLETS`).
 *   2. Auteurs des mots-clics d'équipe sur 7 jours (`searchPosts`,
 *      `TEAM_HASHTAGS`) — ajouté le 2026-10-25. Bluesky peut exiger une
 *      connexion pour cette recherche : mettre dans server/.env
 *        BSKY_HANDLE=ton-compte.bsky.social
 *        BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
 *      (mot de passe d'application : Bluesky › Paramètres › Confidentialité et
 *      sécurité › Mots de passe d'application ; révocable, jamais le vrai mot
 *      de passe). Sans ces variables, l'étape 2 est tentée sans connexion et
 *      sautée si Bluesky refuse ; l'étape 1 tourne quand même.
 *
 * Écartés d'office depuis le 2026-10-26 : bots, balados, fans, blogues, comptes
 * de stats (`notAReporter`, sauf bio de journaliste), comptes proposés pour
 * plusieurs équipes au même passage (`multiTeamHandles`) et comptes qui citent
 * 5 équipes ou plus sans que la leur domine (verdict « plusieurs équipes »).
 *
 * Lecture seule : n'écrit rien en base ni dans le code. La sortie liste, par
 * équipe, les meilleurs candidats et des lignes prêtes à coller dans
 * `src/data/newsSources.ts`. Relire chaque compte avant de l'ajouter (les
 * mots-clics ramènent beaucoup de fans), refusés → `REJECTED_HANDLES`, puis
 * `npm run news:check`. Rien en production.
 */

import 'dotenv/config';
import { NEWS_SOURCES, REJECTED_HANDLES } from '../src/data/newsSources';
import { fetchAuthorFeed } from '../src/services/newsSync.service';
import {
  teamsToSearch, searchQueries, parseActors, profileMatches, profileExcluded, hashtagAuthors, multiTeamHandles,
  checkCandidate, bestCandidates, sourceLine, TEAM_HASHTAGS,
  type Actor, type CandidateCheck,
} from '../src/services/newsDiscover';

const PUBLIC = 'https://public.api.bsky.app/xrpc';
const PDS = (process.env.BSKY_PDS || 'https://bsky.social').replace(/\/$/, '');
const MAX_PROFILE_FEEDS = 12;
const MAX_HASHTAG_FEEDS = 8;
const HEADERS = { 'User-Agent': 'ArakIce/1.0 (+https://arakice.com)', Accept: 'application/json' };
const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s = '', n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);

async function getJson(url: string, token?: string): Promise<unknown> {
  const res = await fetch(url, { headers: token ? { ...HEADERS, Authorization: `Bearer ${token}` } : HEADERS });
  if (!res.ok) {
    const err: any = new Error(`Bluesky ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function searchProfiles(q: string): Promise<Actor[]> {
  return parseActors(await getJson(`${PUBLIC}/app.bsky.actor.searchActors?q=${encodeURIComponent(q)}&limit=25`));
}

/** Profils complets (bio comprise), 25 par appel, public. */
async function getProfiles(handles: string[]): Promise<Actor[]> {
  const out: Actor[] = [];
  for (let i = 0; i < handles.length; i += 25) {
    const qs = handles.slice(i, i + 25).map((h) => `actors=${encodeURIComponent(h)}`).join('&');
    out.push(...parseActors(await getJson(`${PUBLIC}/app.bsky.actor.getProfiles?${qs}`)));
  }
  return out;
}

/** Jeton de session si BSKY_HANDLE / BSKY_APP_PASSWORD sont posés, sinon undefined. */
async function login(): Promise<string | undefined> {
  const identifier = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!identifier || !password) return undefined;
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) {
    console.log(`  ✗ Connexion Bluesky refusée (${res.status}) — vérifier BSKY_HANDLE / BSKY_APP_PASSWORD. Mots-clics tentés sans connexion.\n`);
    return undefined;
  }
  return ((await res.json()) as any)?.accessJwt;
}

(async () => {
  const teams = teamsToSearch(NEWS_SOURCES, process.argv.slice(2));
  // Déjà dans la liste, ou refusés au tri (`REJECTED_HANDLES`) : jamais reproposés.
  const known = new Set([...NEWS_SOURCES.map((s) => s.handle), ...REJECTED_HANDLES].map((h) => h.toLowerCase()));
  const token = await login();
  // Avec connexion : searchPosts via le PDS (qui relaie vers l'AppView). Sans : API publique.
  const postsBase = token ? `${PDS}/xrpc` : PUBLIC;
  let hashtagsOn = true;
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

  console.log(`Recherche pour ${teams.length} équipe(s) : ${teams.join(', ')}`);
  console.log(`Mots-clics : ${token ? 'connecté' : 'sans connexion (BSKY_HANDLE / BSKY_APP_PASSWORD absents)'}\n`);
  const lines: string[] = [];
  const gathered = new Map<string, { seen: number; shortlist: Actor[]; origin: Map<string, string> }>();

  for (const team of teams) {
    process.stdout.write(`  recherche ${team}…\r`);
    // 1. Profils candidats, dédoublonnés, déjà connus écartés, pré-triés sur le profil.
    const seen = new Map<string, Actor>();
    for (const q of searchQueries(team)) {
      try {
        for (const a of await searchProfiles(q)) {
          const h = a.handle.toLowerCase();
          if (!known.has(h) && !seen.has(h)) seen.set(h, a);
        }
      } catch (err: any) {
        console.log(`  ✗ ${err?.message} pour « ${q} »`);
      }
      await sleep(250);
    }
    const shortlist = [...seen.values()].filter((a) => profileMatches(a, team)).slice(0, MAX_PROFILE_FEEDS);
    const origin = new Map<string, string>(shortlist.map((a) => [a.handle.toLowerCase(), 'profil']));

    // 2. Auteurs des mots-clics de l'équipe sur 7 jours.
    const tags = TEAM_HASHTAGS[team] ?? [];
    if (hashtagsOn && tags.length > 0) {
      const responses: unknown[] = [];
      for (const tag of tags) {
        try {
          responses.push(await getJson(
            `${postsBase}/app.bsky.feed.searchPosts?q=${encodeURIComponent(tag)}&sort=latest&limit=100&since=${encodeURIComponent(since)}`,
            token,
          ));
        } catch (err: any) {
          if (err?.status === 401 || err?.status === 403) {
            hashtagsOn = false;
            console.log(`  ✗ Bluesky exige une connexion pour chercher les publications (${err.status}).`);
            console.log('    Ajouter BSKY_HANDLE et BSKY_APP_PASSWORD dans server/.env pour cette étape.\n');
            break;
          }
          console.log(`  ✗ ${err?.message} pour ${tag}`);
        }
        await sleep(250);
      }
      const authors = hashtagAuthors(responses)
        .filter((a) => !known.has(a.handle.toLowerCase()) && !origin.has(a.handle.toLowerCase()))
        .slice(0, MAX_HASHTAG_FEEDS * 2);
      if (authors.length > 0) {
        try {
          const profiles = await getProfiles(authors.map((a) => a.handle));
          const byHandle = new Map(profiles.map((p) => [p.handle.toLowerCase(), p]));
          let added = 0;
          for (const a of authors) {
            if (added >= MAX_HASHTAG_FEEDS) break;
            const p = byHandle.get(a.handle.toLowerCase()) ?? { handle: a.handle, displayName: a.displayName };
            if (profileExcluded(p)) continue;
            shortlist.push(p);
            origin.set(a.handle.toLowerCase(), `${a.posts}× mot-clic`);
            added++;
          }
        } catch (err: any) {
          console.log(`  ✗ ${err?.message} (profils des mots-clics)`);
        }
      }
    }

    gathered.set(team, { seen: seen.size, shortlist, origin });
  }

  // 3. Un même compte proposé pour plusieurs équipes = compte de toute la ligue : écarté partout.
  const multi = multiTeamHandles(Object.fromEntries(
    [...gathered].map(([t, g]) => [t, g.shortlist.map((a) => a.handle)]),
  ));
  if (multi.size > 0) console.log(`Écartés (proposés pour plusieurs équipes) : ${[...multi].join(', ')}\n`);

  for (const team of teams) {
    const { seen: seenCount, origin } = gathered.get(team)!;
    const shortlist = gathered.get(team)!.shortlist.filter((a) => !multi.has(a.handle.toLowerCase()));

    // 4. Le même contrôle que news:check sur chaque candidat.
    const checks: CandidateCheck[] = [];
    const bios = new Map<string, string>(shortlist.map((a) => [a.handle.toLowerCase(), oneLine(a.description)]));
    for (const a of shortlist) {
      try {
        checks.push(checkCandidate(a, team, await fetchAuthorFeed(a.handle), Date.now()));
      } catch { /* compte illisible : ignoré */ }
      await sleep(150);
    }

    const best = bestCandidates(checks);
    console.log(`── ${team} — ${seenCount} profils, ${shortlist.length} lus, ${best.length} retenu(s)`);
    for (const c of checks.sort((x, y) => y.score - x.score).slice(0, 8)) {
      const top = c.top ? `${c.top[0]} ×${c.top[1]}` : '—';
      const from = origin.get(c.handle.toLowerCase()) ?? '';
      console.log(`   ${pad(c.handle, 34)} ${pad(c.active, 4)} actifs  ${pad(c.teamPosts, 3)} ${team}  ${pad(c.flagged, 3)} drap.  top ${pad(top, 9)} ${pad(c.verdict, 18)} ${from}`);
      const bio = bios.get(c.handle.toLowerCase());
      if (bio && c.verdict === 'ok') console.log(`      « ${bio} »`);
    }
    for (const c of best) lines.push(`${sourceLine(c)}  // ${origin.get(c.handle.toLowerCase()) ?? ''}`);
    console.log('');
  }

  console.log('── À relire, puis coller dans src/data/newsSources.ts (section Équipes) :\n');
  console.log(lines.length ? lines.join('\n') : '  (aucun candidat retenu)');
  console.log('\nRefusés → REJECTED_HANDLES. Ensuite : npm run news:check');
})();
