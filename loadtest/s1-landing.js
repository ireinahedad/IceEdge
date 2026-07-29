/**
 * S1 — Vague d'arrivée sur la landing.
 * « Le test qui décide du lancement » (AUDIT_SCALABILITE_COUTS.md, §5).
 *
 * Exécution :
 *   k6 run -e BASE_URL=http://localhost:3001 loadtest/s1-landing.js
 *
 * CE QUE CE SCRIPT NE PEUT PAS MESURER
 *
 * Les deux critères décisifs de S1 — « ≤ 2 appels Odds API » et « ≤ 5
 * exécutions complètes de getBestBets » — portent sur ce que le serveur ÉMET,
 * pas sur ce qu'il répond. k6 ne voit que la façade HTTP : un endpoint qui
 * répond 200 en 40 ms peut avoir appelé l'upstream 500 fois (facture) ou 1 fois
 * (cache), c'est indiscernable d'ici. Ces chiffres se lisent sur
 * `/api/dev/metrics`, avant et après le tir — voir loadtest/README.md.
 *
 * Les seuils ci-dessous ne couvrent donc que la moitié des critères. Un run
 * tout vert dont on n'a pas lu les compteurs ne prouve rien sur le coût.
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

/** Palier haut : 500 simultanés, le seuil que l'audit juge décisif. */
const PEAK    = Number(__ENV.PEAK_VUS)    || 500;
/** Montée en 60 s, puis maintien 5 min — profil imposé par le scénario S1. */
const RAMP    = __ENV.RAMP     || '60s';
const HOLD    = __ENV.HOLD     || '5m';

const errors = new Rate('landing_errors');

// Une tendance par endpoint : un p95 global masquerait un seul endpoint lent
// derrière cinq rapides — or c'est justement celui-là qu'on cherche.
const t = {
  bestBets:    new Trend('ep_best_bets',   true),
  live:        new Trend('ep_games_live',  true),
  gamesByDate: new Trend('ep_games_date',  true),
  oddsNhl:     new Trend('ep_odds_nhl',    true),
  oddsTennis:  new Trend('ep_odds_tennis', true),
  leaderboard: new Trend('ep_leaderboard', true),
};

export const options = {
  scenarios: {
    landing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: PEAK },
        { duration: HOLD, target: PEAK },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Critères explicites de S1.
    'http_req_duration': ['p(95)<800'],
    'landing_errors':    ['rate<0.005'],

    // Par endpoint : `abortOnFail` sur le seul cas qui ne mérite pas d'attendre
    // 6 minutes. Si best-bets dépasse 3 s au p95, son cache ne fait pas son
    // travail et le reste du run n'apprendra rien de plus.
    'ep_best_bets':   [{ threshold: 'p(95)<3000', abortOnFail: true, delayAbortEval: '90s' }],
    'ep_leaderboard': ['p(95)<800'],
    'ep_games_live':  ['p(95)<800'],
  },
};

/**
 * Dates consultées. Volontairement PEU nombreuses et fixes : un visiteur qui
 * arrive sur la landing regarde aujourd'hui, parfois demain. Faire varier la
 * date par utilisateur virtuel créerait une clé de cache par VU et mesurerait
 * un scénario qui n'existe pas — c'est le rôle de S5, pas de S1.
 */
function landingDates() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  return [iso(today), iso(tomorrow)];
}

const DATES = landingDates();

function get(name, path, trend) {
  const res = http.get(`${BASE}${path}`, {
    tags: { name },                 // agrège les URL paramétrées sous un seul nom
    timeout: '30s',
  });

  const ok = check(res, {
    [`${name}: 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });

  // Un 429 signale presque toujours que le limiteur n'a pas été relevé pour le
  // test (cf. API_RATE_LIMIT dans le README) : le run mesure alors le limiteur
  // et non l'application. On le dit une fois plutôt que de laisser un taux
  // d'erreur inexpliqué.
  if (res.status === 429) {
    console.warn(`[${name}] 429 — API_RATE_LIMIT est-il relevé sur la cible ?`);
  }

  errors.add(!ok);
  trend.add(res.timings.duration);
  return res;
}

export default function () {
  // Séquence réelle de HockeyLanding. Les appels partent quasi ensemble au
  // montage de la page, d'où un batch plutôt que six requêtes sérialisées :
  // sérialiser donnerait un p95 flatteur et une concurrence six fois trop basse.
  group('landing', () => {
    const date = DATES[Math.floor(Math.random() * DATES.length)];

    const responses = http.batch([
      ['GET', `${BASE}/api/predict/best-bets?limit=30&source=ml`, null, { tags: { name: 'best-bets' }, timeout: '30s' }],
      ['GET', `${BASE}/api/nhl/games/live`,                       null, { tags: { name: 'games-live' }, timeout: '30s' }],
      ['GET', `${BASE}/api/nhl/games?date=${date}`,               null, { tags: { name: 'games-date' }, timeout: '30s' }],
      ['GET', `${BASE}/api/odds/bet365/icehockey_nhl?markets=h2h,totals`, null, { tags: { name: 'odds-nhl' }, timeout: '30s' }],
      ['GET', `${BASE}/api/leaderboard`,                          null, { tags: { name: 'leaderboard' }, timeout: '30s' }],
    ]);

    const names = ['best-bets', 'games-live', 'games-date', 'odds-nhl', 'leaderboard'];
    const trends = [t.bestBets, t.live, t.gamesByDate, t.oddsNhl, t.leaderboard];

    responses.forEach((res, i) => {
      const ok = check(res, {
        [`${names[i]}: 2xx`]: (r) => r.status >= 200 && r.status < 300,
      });
      if (res.status === 429) {
        console.warn(`[${names[i]}] 429 — API_RATE_LIMIT est-il relevé sur la cible ?`);
      }
      errors.add(!ok);
      trends[i].add(res.timings.duration);
    });
  });

  // Le volet tennis n'est chargé que par une partie des visiteurs (section
  // paresseuse, montée à l'entrée dans le viewport). Le tirer à chaque
  // itération surestimerait la consommation du quota RapidAPI.
  if (Math.random() < 0.3) {
    get('odds-tennis', '/api/odds/bet365/tennis_atp_french_open?markets=h2h', t.oddsTennis);
  }

  // Temps de lecture. Sans pause, 500 VUs produisent un débit qu'aucun trafic
  // réel ne génère et le test devient un banc de stress, pas une simulation.
  sleep(3 + Math.random() * 4);
}

export function handleSummary(data) {
  const line = (k) => {
    const m = data.metrics[k];
    if (!m) return `${k}: —`;
    const v = m.values;
    return `${k}: p50=${Math.round(v['p(50)'] ?? 0)}ms p95=${Math.round(v['p(95)'] ?? 0)}ms max=${Math.round(v.max ?? 0)}ms`;
  };

  const summary = [
    '',
    '─── S1 · latences par endpoint ────────────────────────────────',
    line('ep_best_bets'),
    line('ep_games_live'),
    line('ep_games_date'),
    line('ep_odds_nhl'),
    line('ep_odds_tennis'),
    line('ep_leaderboard'),
    '',
    `taux d'erreur : ${((data.metrics.landing_errors?.values.rate ?? 0) * 100).toFixed(2)} %`,
    '',
    '⚠️  Ce résumé ne couvre que la moitié des critères de S1.',
    '    Les deux autres — « ≤ 2 appels Odds API » et « ≤ 5 exécutions de',
    '    getBestBets » — se lisent maintenant sur /api/dev/metrics.',
    '    Voir loadtest/README.md §4.',
    '',
  ].join('\n');

  return {
    stdout: summary,
    'loadtest/s1-summary.json': JSON.stringify(data, null, 2),
  };
}
