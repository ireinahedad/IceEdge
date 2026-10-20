/**
 * Retard RÉEL du direct en production (`ml/EXPLICATION_ML.md` §10.2).
 *
 * À lancer pendant une soirée de matchs, depuis n'importe quelle machine qui
 * joint l'API NHL et le site :
 *
 *   npx ts-node --transpile-only scripts/measure-live-lag.ts --base https://api.arakice.com --minutes 180
 *
 * Toutes les `--interval` ms (2 000 par défaut), pour chaque match en cours :
 *   · la SOURCE : `api-web.nhle.com/v1/score/now` (score, période, horloge) ;
 *   · ce que SERT la production : `GET <base>/api/predict/game/:id/bundle`,
 *     exactement ce que rappelle la page de match (navigateur, CDN compris).
 *
 * Trois mesures, en secondes réelles :
 *   1. Âge de l'état servi — à chaque relevé, depuis quand l'API NHL montrait
 *      déjà le score et l'horloge que la production affiche (premier instant où
 *      la source a atteint ce score et ce temps écoulé). Mesure l'ensemble
 *      de la chaîne serveur + CDN.
 *   2. Âge déclaré — `now − live.asOf` quand la production le publie (lecture
 *      de la page `landing` par le serveur) : la même chose, vue du serveur.
 *   3. Buts — pour chaque but vu à la source, délai jusqu'au premier relevé où
 *      la production l'affiche.
 * Le retard AFFICHÉ ajoute le rythme de rappel du client (`live.refreshMs`) :
 * en moyenne la moitié, au plus la totalité ; le rapport le donne à part.
 *
 * Sortie : ml/models/live/live_lag_<date>.json et .md (tranche « fin de match »
 * = 3e période à ≤ 5 min, ou prolongation, comme `nhl/liveRefresh.ts`).
 */

import fs from 'fs';
import path from 'path';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BASE = arg('base', 'https://api.arakice.com').replace(/\/$/, '');
const MINUTES = Number(arg('minutes', '180'));
const INTERVAL = Number(arg('interval', '2000'));
const NHL = arg('nhl', 'https://api-web.nhle.com/v1/score/now');   // --nhl : source de test
const OUT_DIR = path.resolve(__dirname, '..', '..', 'ml', 'models', 'live');

interface Snap { at: number; period: number; elapsed: number; home: number; away: number; ot: boolean }
interface Sample { game: string; at: number; age: number | null; declared: number | null; endgame: boolean; refreshMs: number | null }
interface GoalLag { game: string; score: string; seenAtSource: number; lag: number | null; endgame: boolean }

const clockSec = (c: unknown) => {
  if (typeof c !== 'string' || !c.includes(':')) return null;
  const [m, s] = c.split(':').map(Number);
  return Number.isFinite(m) && Number.isFinite(s) ? m * 60 + s : null;
};
/** Temps ÉCOULÉ dans le match (s), depuis période + horloge restante de la période. */
const elapsedOf = (period: number, left: number | null) =>
  left == null ? null : (Math.min(period, 4) - 1) * 1200 + (1200 - left);
const isEndgame = (period: number, left: number | null, ot: boolean) =>
  ot || period > 3 || (period === 3 && (left == null || left <= 300));

/** Libellé du paquet en direct : « 2–1, 3e, 01:40 restantes » / « …, entracte après la 2e » / « …, prolongation ». */
function parseLabel(label: string): { home: number; away: number; period: number; left: number | null; ot: boolean } | null {
  const m = label.match(/^(\d+)–(\d+), (.*)$/);
  if (!m) return null;
  const home = Number(m[1]), away = Number(m[2]), rest = m[3];
  if (/prolongation|fusillade/.test(rest)) return { home, away, period: 4, left: null, ot: true };
  const ord = rest.match(/(1re|2e|3e)/);
  const period = ord ? (ord[1] === '1re' ? 1 : ord[1] === '2e' ? 2 : 3) : 0;
  if (!period) return null;
  if (/entracte/.test(rest)) return { home, away, period, left: 0, ot: false };
  const c = rest.match(/(\d{1,2}:\d{2}) restantes/);
  return { home, away, period, left: c ? clockSec(c[1]) : null, ot: false };
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { 'User-Agent': 'iceedge-live-lag/1' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
};
const mean = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null);

async function main(): Promise<void> {
  const until = Date.now() + MINUTES * 60_000;
  const source = new Map<string, Snap[]>();          // historique de la source, par match
  const samples: Sample[] = [];
  const goals: GoalLag[] = [];
  console.log(`Mesure du retard : ${BASE}, ${MINUTES} min, relevé toutes les ${INTERVAL} ms`);

  // Rapport écrit toutes les 10 min (rien n'est perdu si la mesure est coupée),
  // et arrêt 20 min après le dernier match en cours (`--idle`, minutes).
  const IDLE_MS = Number(arg('idle', '20')) * 60_000;
  let lastLive = 0, lastWrite = Date.now();
  while (Date.now() < until) {
    const tick = Date.now();
    if (lastLive && tick - lastLive > IDLE_MS) { console.log('Plus de match en cours : fin de la mesure.'); break; }
    if (samples.length && tick - lastWrite > 10 * 60_000) { writeReport(false); lastWrite = tick; }
    let live: any[] = [];
    try {
      const d = await getJson(NHL);
      live = (d.games ?? []).filter((g: any) => g.gameState === 'LIVE' || g.gameState === 'CRIT');
    } catch (e) { console.warn(String(e)); }
    if (live.length) lastLive = tick;

    await Promise.all(live.map(async (g) => {
      const id = String(g.id);
      const period = Number(g.periodDescriptor?.number ?? g.period ?? 0);
      const ot = String(g.periodDescriptor?.periodType ?? '') !== 'REG' || period > 3;
      const left = g.clock?.inIntermission ? 0 : clockSec(g.clock?.timeRemaining);
      const el = elapsedOf(period, left);
      const hist = source.get(id) ?? [];
      const snap: Snap = { at: tick, period, elapsed: el ?? -1, home: Number(g.homeTeam?.score ?? 0), away: Number(g.awayTeam?.score ?? 0), ot };
      const last = hist[hist.length - 1];
      if (!last || last.elapsed !== snap.elapsed || last.home !== snap.home || last.away !== snap.away) {
        if (last && (snap.home + snap.away > last.home + last.away)) {
          goals.push({ game: id, score: `${snap.home}–${snap.away}`, seenAtSource: tick, lag: null,
                       endgame: isEndgame(period, left, ot) });
        }
        hist.push(snap);
        source.set(id, hist);
      }

      try {
        const b = await getJson(`${BASE}/api/predict/game/${id}/bundle`);
        const now = Date.now();
        const st = b?.live?.label ? parseLabel(b.live.label) : null;
        const declared = b?.live?.asOf ? (now - Date.parse(b.live.asOf)) / 1000 : null;
        let age: number | null = null;
        if (st) {
          const pe = st.ot ? null : elapsedOf(st.period, st.left);
          // Premier instant où la source montrait ce score et au moins ce temps écoulé.
          const first = hist.find(h => h.home === st.home && h.away === st.away && (pe == null || h.elapsed >= pe));
          if (first) age = (now - first.at) / 1000;
          // Buts en attente : la production les montre-t-elle enfin ?
          for (const gl of goals) {
            if (gl.game !== id || gl.lag != null) continue;
            const [h, a] = gl.score.split('–').map(Number);
            if (st.home >= h && st.away >= a) gl.lag = (now - gl.seenAtSource) / 1000;
          }
        }
        samples.push({ game: id, at: now, age, declared, endgame: st ? isEndgame(st.period, st.left, st.ot) : false,
                       refreshMs: b?.live?.refreshMs ?? null });
      } catch (e) { console.warn(String(e)); }
    }));

    if (samples.length && samples.length % 200 < live.length) {
      const a = samples.filter(s => s.age != null).map(s => s.age!);
      console.log(`${new Date().toISOString()} : ${live.length} matchs, ${samples.length} relevés, âge médian ${pct(a, 50)} s`);
    }
    const wait = INTERVAL - (Date.now() - tick);
    if (!live.length) await new Promise(r => setTimeout(r, 60_000));      // pas de match : on attend
    else if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  writeReport(true);

  function writeReport(final: boolean): void {
  const part = (end: boolean) => {
    const ss = samples.filter(s => s.endgame === end);
    const age = ss.filter(s => s.age != null).map(s => s.age!);
    const dec = ss.filter(s => s.declared != null).map(s => s.declared!);
    const poll = ss.map(s => (s.refreshMs ?? 30_000) / 1000);
    const pollMean = mean(poll) ?? 0;
    return {
      samples: ss.length,
      ageSource: { mean: mean(age), p50: pct(age, 50), p90: pct(age, 90), max: age.length ? +Math.max(...age).toFixed(1) : null },
      ageDeclared: { mean: mean(dec), p50: pct(dec, 50), p90: pct(dec, 90) },
      clientPollSec: pollMean,
      displayedMeanEstimate: mean(age) != null ? +(mean(age)! + pollMean / 2).toFixed(1) : null,
      goals: (() => {
        const gg = goals.filter(g => g.endgame === end && g.lag != null).map(g => g.lag!);
        return { n: gg.length, mean: mean(gg), p50: pct(gg, 50), p90: pct(gg, 90), max: gg.length ? +Math.max(...gg).toFixed(1) : null };
      })(),
    };
  };
  const report = {
    generatedAt: new Date().toISOString(), base: BASE, intervalMs: INTERVAL, minutes: MINUTES,
    games: source.size, samples: samples.length, goalsSeen: goals.length,
    goalsNeverShown: goals.filter(g => g.lag == null).length,
    duringGame: part(false), endgame: part(true),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date(until - MINUTES * 60_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(OUT_DIR, `live_lag_${stamp}.json`), JSON.stringify({ ...report, goals }, null, 2));
  const row = (lab: string, p: any) =>
    `| ${lab} | ${p.samples} | ${p.ageSource.p50 ?? '—'} / ${p.ageSource.p90 ?? '—'} / ${p.ageSource.max ?? '—'} s | ${p.ageDeclared.p50 ?? '—'} s | ${p.clientPollSec} s | ${p.displayedMeanEstimate ?? '—'} s | ${p.goals.n} : ${p.goals.p50 ?? '—'} / ${p.goals.p90 ?? '—'} s |`;
  const md = [
    `# Retard du direct en production — ${stamp}`, '',
    `${BASE}, ${report.games} matchs, ${report.samples} relevés toutes les ${INTERVAL / 1000} s ; ${report.goalsSeen} buts vus à la source, ${report.goalsNeverShown} jamais affichés pendant la mesure.`, '',
    '| Moment | Relevés | Âge de l\'état servi, médiane / p90 / max | Âge déclaré (asOf), médiane | Rappel du client | Retard affiché moyen estimé | Buts : n, délai médian / p90 |',
    '|---|---:|---:|---:|---:|---:|---:|',
    row('En cours de match', report.duringGame),
    row('Fin de match (3e ≤ 5 min, prolongation)', report.endgame), '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, `live_lag_${stamp}.md`), md + (final ? '' : '\n_Mesure en cours : rapport partiel._\n') + '\n');
  if (final) console.log(md);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
