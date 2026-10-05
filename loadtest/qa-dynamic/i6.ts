/**
 * I6 — pipeline NHL réelle → features → service ML local.
 *
 *   cd server && npx ts-node --transpile-only ../loadtest/qa-dynamic/i6.ts [AAAA-MM-JJ ...]
 *
 * Lit l'API NHL RÉELLE, n'écrit nulle part. Garde-fous : base injoignable
 * (127.0.0.1:1), clé Odds vide (aucun quota consommé), ML local uniquement.
 * Phases : A nominal · B source stats en panne · C un match invalide dans le lot.
 * QA_FAIL_STATS=1 : relance A avec api.nhle.com/stats/rest coupé dès le départ (cache vide) —
 * attendu : PP/PK absents (pas 20/80), tirs neutres, prédiction servie quand même.
 * Réseau du shell Cowork : NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://qa@127.0.0.1:1/none';
process.env.DB_CONNECT_TIMEOUT_MS = '500';
process.env.ODDS_API_KEY = '';
process.env.NHL_USE_MOCK = 'false';
process.env.ML_SERVICE_URL = process.env.QA_ML_URL || 'http://127.0.0.1:8000';
process.env.ML_API_TOKEN = process.env.QA_ML_TOKEN || 'qa-i6-token';
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(process.env.ML_SERVICE_URL)) throw new Error('ML non local : refus');

const realFetch = globalThis.fetch;
const STATS_DOWN = process.env.QA_FAIL_STATS === '1';
let failStats = STATS_DOWN;
const calls: Record<string, number> = {};
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? input);
  const host = new URL(url).host + (url.includes('/stats/rest') ? '/stats' : '');
  calls[host] = (calls[host] ?? 0) + 1;
  if (failStats && url.includes('api.nhle.com/stats/rest')) throw new Error('I6: panne simulée stats/rest');
  return realFetch(input, init);
}) as typeof fetch;

type Row = { phase: string; check: string; ok: boolean; detail: string };
const rows: Row[] = [];
const rec = (phase: string, check: string, ok: boolean, detail = '') => {
  rows.push({ phase, check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${phase}] ${check}${detail ? ' — ' + detail : ''}`);
};

const DEFAULTS: Record<string, number> = {
  home_goals_for_pg: 3, away_goals_for_pg: 3, home_shots_for_pg: 30, away_shots_for_pg: 30,
  home_faceoff_pct: 50, away_faceoff_pct: 50,
};

async function main() {
  const { fetchGameById } = await import('../../server/src/services/nhlApiClient');
  const fe = await import('../../server/src/services/featureEngineering');
  const bundle = await import('../../server/src/services/gameMlBundle');

  const dates = process.argv.slice(2);
  const ids: Array<{ id: string; date: string; label: string }> = [];
  const sched = await (await realFetch('https://api-web.nhle.com/v1/schedule/now', { redirect: 'follow' })).json() as any;
  for (const w of sched.gameWeek ?? []) {
    if (dates.length ? !dates.includes(w.date) : ids.length >= 8) continue;
    for (const g of w.games) if (g.gameType === 2)
      ids.push({ id: String(g.id), date: w.date, label: `${g.awayTeam.abbrev}@${g.homeTeam.abbrev} ${w.date} ${g.gameState}` });
  }
  rec('setup', 'matchs de saison régulière trouvés', ids.length > 0, `${ids.length}`);

  // ── A : nominal
  const featsA: Record<string, any> = {};
  for (const g of ids) {
    try {
      const game = await fetchGameById(g.id);
      const home = String(game?.homeTeam?.abbreviation ?? ''), away = String(game?.awayTeam?.abbreviation ?? '');
      const f = await fe.buildGameFeatures(home, away, 'moneyline', undefined, { subjectIsHome: true, gameDate: game?.gameDate });
      featsA[g.id] = f;
      const atDefault = Object.entries(DEFAULTS).filter(([k, v]) => (f as any)[k] === v).map(([k]) => k);
      const nan = Object.entries(f).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v)).map(([k]) => k);
      const ppKnown = STATS_DOWN ? (f.home_pp_pct == null && f.home_shots_for_pg === 30) : f.home_pp_pct != null && f.away_pp_pct != null && f.home_pk_pct != null && f.away_pk_pct != null;
      rec('A', `${g.label} features`, nan.length === 0 && (STATS_DOWN || atDefault.length <= 2) && ppKnown,
        `defaults=[${atDefault}] NaN=[${nan}] PP ${f.home_pp_pct?.toFixed?.(1)}/${f.away_pp_pct?.toFixed?.(1)} PK ${f.home_pk_pct?.toFixed?.(1)}/${f.away_pk_pct?.toFixed?.(1)} GF ${f.home_goals_for_pg}/${f.away_goals_for_pg} rest ${f.home_rest_days}/${f.away_rest_days} b2b ${f.home_b2b}/${f.away_b2b} odds=${f.home_odds_decimal ?? '∅'}`);
      const b = await bundle.getGameMlBundle(g.id);
      const res = Object.values(b.results).filter(Boolean) as any[];
      const bad = res.filter(r => typeof r.probability !== 'number' || !Number.isFinite(r.probability));
      const ml = Object.entries(b.byKey ?? {}).find(([k]) => /^moneyline/i.test(k)) ?? Object.entries(b.byKey ?? {})[0];
      rec('A', `${g.label} paquet ML`, res.length > 0 && bad.length === 0,
        `${res.length} marchés pricés, ${bad.length} invalides, source=${res[0]?.model_used ?? res[0]?.model ?? res[0]?.model_source ?? '?'}${ml ? `, ${ml[0]}=${(ml[1] as any)?.probability}` : ''}`);
    } catch (e: any) { rec('A', `${g.label}`, false, e?.message); }
  }

  // ── B : voir QA_FAIL_STATS=1 (processus neuf, sans cache) ; ici seulement un contrôle à chaud
  failStats = true;
  const fresh = await import('../../server/src/services/featureEngineering');
  for (const g of ids.slice(0, 2)) {
    try {
      const game = await fetchGameById(g.id);
      const f = await fresh.buildGameFeatures(String(game.homeTeam.abbreviation), String(game.awayTeam.abbreviation),
        'moneyline', undefined, { subjectIsHome: true, gameDate: game.gameDate });
      rec('B', `${g.label} features sans stats/rest`, Number.isFinite(f.home_win_pct) && Number.isFinite(f.home_rest_days),
        `PP ${f.home_pp_pct ?? '∅'} (cache possible) tirs ${f.home_shots_for_pg}`);
    } catch (e: any) { rec('B', `${g.label}`, false, e?.message); }
  }
  failStats = false;

  // ── C : un identifiant invalide au milieu du lot n'empêche pas les autres
  const batch = [ids[0]?.id, '2026029999', ids[1]?.id].filter(Boolean) as string[];
  const settled = await Promise.allSettled(batch.map(id => bundle.getGameMlBundle(id)));
  const okCount = settled.filter(s => s.status === 'fulfilled').length;
  rec('C', 'lot avec 1 match invalide', settled[1]?.status === 'rejected' && okCount === batch.length - 1,
    settled.map((s, i) => `${batch[i]}:${s.status}${s.status === 'rejected' ? '(' + (s.reason?.status ?? s.reason?.message) + ')' : ''}`).join(' '));

  console.log('\nAppels sortants :', calls);
  const fails = rows.filter(r => !r.ok).length;
  console.log(`\n${rows.length - fails}/${rows.length} PASS`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
