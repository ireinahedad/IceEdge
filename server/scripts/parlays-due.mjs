/**
 * parlays-due.mjs — « est-ce l'heure ? » (MARKETING_PLAN Phase D)
 * ------------------------------------------------------------------
 * Appelé toutes les 30 min par `.github/workflows/content-parlays.yml`, AVANT
 * tout `npm ci` : aucune dépendance (Node 18+, fetch intégré), quelques
 * secondes. Le gros du travail (Chromium, ffmpeg) ne démarre que si la
 * réponse est oui.
 *
 *   node scripts/parlays-due.mjs --mode=pick      combinés du soir
 *   node scripts/parlays-due.mjs --mode=result    résultat de la veille
 *   node scripts/parlays-due.mjs --mode=pick --date=2026-10-23
 *
 * Écrit `due=true|false` et `date=YYYY-MM-DD` dans $GITHUB_OUTPUT (et sur la
 * console). Ne modifie RIEN : lecture seule de l'API publique et du calendrier NHL.
 *
 * RÈGLE « pick » — due si la vidéo du jour n'est pas encore entièrement publiée
 * ET l'une des deux :
 *   • les combinés sont déjà gelés (un run précédent a échoué en route : on
 *     reprend, sans attendre) ;
 *   • on est dans la fenêtre [1re mise au jeu − 2 h, dernière mise au jeu − 5 min].
 *     Avec un cron aux 30 min et jusqu'à 1 h de retard chez GitHub, le gel
 *     tombe entre −2 h et −1 h : toujours avant le premier match.
 * RÈGLE « result » — due si des combinés existent pour la veille et que la
 * vidéo résultat n'est pas entièrement publiée. Le règlement lui-même est
 * vérifié plus loin (build-parlays sort avec le code 3 si ce n'est pas prêt).
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = (process.env.CONTENT_API_URL ?? 'https://api.arakice.com/api').replace(/\/+$/, '');
const NHL = 'https://api-web.nhle.com/v1';

export const FREEZE_LEAD_MS = 2 * 3_600_000;
export const LAST_CALL_MS = 5 * 60_000;

/** Jour NHL (heure de l'Est) de `now`, décalé de `n` jours. */
export function etDay(now = new Date(), n = 0) {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Vrai si les deux publications d'un mode sont faites sur TOUS les combinés du jour. */
export function fullyPosted(parlays, mode) {
  if (!parlays.length) return false;
  return parlays.every((p) => mode === 'pick'
    ? Boolean(p.youtubePickId && p.tiktokPickSentAt)
    : Boolean(p.youtubeResultId && p.tiktokResultSentAt));
}

/**
 * Décision pure, testée dans `src/services/content/parlaysDue.test.ts`.
 * `starts` : mises au jeu (ISO) des matchs du jour ; `parlays` : ce que
 * `/api/content/parlays?date=` renvoie.
 */
export function decide({ mode, now, starts, parlays }) {
  if (fullyPosted(parlays, mode)) return { due: false, reason: 'déjà publié' };
  if (mode === 'result') {
    return parlays.length ? { due: true, reason: 'combinés à régler / publier' } : { due: false, reason: 'aucun combiné gelé ce jour-là' };
  }
  if (parlays.length) return { due: true, reason: 'déjà gelé, publication à terminer' };
  const times = starts.map((s) => Date.parse(s)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!times.length) return { due: false, reason: 'aucun match ce jour-là' };
  const t = now.getTime();
  const open = times[0] - FREEZE_LEAD_MS;
  const close = times[times.length - 1] - LAST_CALL_MS;
  if (t < open) return { due: false, reason: `trop tôt (gel à partir de ${new Date(open).toISOString()})` };
  if (t > close) return { due: false, reason: 'tous les matchs ont commencé' };
  return { due: true, reason: `fenêtre de gel (1er match ${new Date(times[0]).toISOString()})` };
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

async function startsFor(date) {
  const sched = await getJson(`${NHL}/schedule/${date}`);
  const day = (sched.gameWeek ?? []).find((d) => d.date === date);
  // Saison régulière (2) et séries (3) seulement : pas de combinés en préparatoire.
  return (day?.games ?? []).filter((g) => g.gameType === 2 || g.gameType === 3).map((g) => g.startTimeUTC);
}

async function main() {
  const arg = (n) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  const mode = arg('mode');
  if (mode !== 'pick' && mode !== 'result') throw new Error('--mode=pick ou --mode=result');
  const now = new Date();
  const date = arg('date') ?? etDay(now, mode === 'pick' ? 0 : -1);

  const { parlays } = await getJson(`${API}/content/parlays?date=${date}`);
  const starts = mode === 'pick' && !parlays.length ? await startsFor(date) : [];
  const { due, reason } = decide({ mode, now, starts, parlays });

  console.log(`${mode} ${date} → ${due ? 'OUI' : 'non'} (${reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\ndate=${date}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
