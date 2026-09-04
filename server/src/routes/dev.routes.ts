/**
 * dev.routes.ts
 * Developer-only endpoints — gated to admin role.
 * Mount at /api/dev  (only in non-production or for admins).
 *
 * GET  /api/dev/ml-info          — ML service health + model info + feature importances
 * POST /api/dev/ml-test          — Run a live test prediction and return the full response
 * GET  /api/dev/ml-reports       — Rapports d'entraînement/backtest + fraîcheur des artefacts
 * GET  /api/dev/data-health      — Fraîcheur des données : odds_log, quota, volumes
 * GET  /api/dev/live-performance — Calibration, hit rate et ROI des paris réellement réglés
 * GET  /api/dev/metrics          — Compteurs : appels sortants, caches, event loop, mémoire
 * POST /api/dev/metrics/reset    — Ouvre une nouvelle fenêtre de mesure
 * GET  /api/dev/reports          — File de modération du chat : signalements ouverts
 * POST /api/dev/reports/:id      — Trancher : actioned (masque) | dismissed (rétablit)
 */

import { Router, Request, Response } from 'express';
import { authenticate }   from '../middleware/auth.middleware';
import { requireRole }    from '../middleware/auth.middleware';
import { mlApiClient, mlHeaders, ML_URL, mlCircuitState } from '../services/mlApiClient';
import {
  buildGameFeatures,
  buildPlayerPropFeatures,
} from '../services/featureEngineering';
import { snapshotMetrics, resetMetrics } from '../metrics';
import { chatService } from '../services/chat.service';
import { pool } from '../db/connection';
import { sendError } from '../httpError';

const router = Router();

// All dev routes require a valid JWT + admin role
router.use(authenticate, requireRole('admin'));

// ── GET /api/dev/ml-info ──────────────────────────────────────────────────────
router.get('/ml-info', async (_req: Request, res: Response) => {
  try {
    // Ping the Python service health + feature endpoints in parallel
    const timeout = (ms: number) =>
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

    const [healthRaw, featuresRaw] = await Promise.all([
      Promise.race([
        fetch(`${ML_URL}/health`).then(r => r.json()),
        timeout(4000),
      ]).catch((e) => ({ error: e.message ?? 'ML service unreachable' })),

      // /features is token-protected on the ML service — send X-ML-Token.
      Promise.race([
        fetch(`${ML_URL}/features`, { headers: mlHeaders() }).then(r => r.json()),
        timeout(4000),
      ]).catch(() => null),
    ]);

    // Run a quick game test prediction for BOS vs NYR
    let gameSample: unknown = null;
    let playerSample: unknown = null;

    try {
      const gameFeats = await buildGameFeatures('bos', 'nyr', 'moneyline');
      gameSample = await mlApiClient.predictGame(gameFeats);
    } catch { /* service may be down */ }

    try {
      const playerFeats = await buildPlayerPropFeatures('8478402', 'goals', 0.5, 'over');
      playerSample = await mlApiClient.predictPlayer(playerFeats);
    } catch { /* service may be down */ }

    res.json({
      ml_url:        ML_URL,
      service_up:    !(healthRaw as any)?.error,
      health:        healthRaw,
      features:      featuresRaw,
      samples: {
        game:   gameSample,
        player: playerSample,
      },
      retrieved_at: new Date().toISOString(),
    });
  } catch (err: any) {
    sendError(res, err);
  }
});

// ── POST /api/dev/ml-test ─────────────────────────────────────────────────────
// Body: { type: "game"|"player"|"team", teamId?, opponentId?, playerId?, propType?, line?, selection? }
router.post('/ml-test', async (req: Request, res: Response) => {
  try {
    const { type, teamId, opponentId, playerId, propType, line, selection } = req.body as {
      type: 'game' | 'player' | 'team';
      teamId?: string;
      opponentId?: string;
      playerId?: string;
      propType?: string;
      line?: number;
      selection?: string;
    };

    let result: unknown;

    if (type === 'game') {
      const features = await buildGameFeatures(teamId ?? 'bos', opponentId ?? 'nyr', propType ?? 'moneyline', line);
      result = await mlApiClient.predictGame(features);
    } else if (type === 'player') {
      const features = await buildPlayerPropFeatures(playerId ?? '8478402', propType ?? 'goals', line ?? 0.5, selection ?? 'over');
      result = await mlApiClient.predictPlayer(features);
    } else if (type === 'team') {
      const { buildTeamFuturesFeatures } = await import('../services/featureEngineering');
      const features = await buildTeamFuturesFeatures(teamId ?? 'bos', propType ?? 'moneyline');
      result = await mlApiClient.predictTeam(features);
    } else {
      return res.status(400).json({ error: 'type must be game | player | team' });
    }

    res.json({ type, result, tested_at: new Date().toISOString() });
  } catch (err: any) {
    res.status(503).json({ error: err.message ?? 'ML test failed' });
  }
});

// ── GET /api/dev/ml-reports ───────────────────────────────────────────────────
//
// Proxy vers `GET /reports` du service Python. Les rapports d'entraînement et
// de backtest vivent dans MODELS_DIR, embarqué dans l'image ML uniquement : ce
// process-ci n'a pas ces fichiers sur son disque en production. Voir le
// commentaire en tête de l'endpoint côté Python.
//
// Même schéma que `/ml-info` : timeout explicite, échec renvoyé en 200 avec un
// champ `error`. Un dashboard qui affiche « service injoignable » est plus utile
// qu'un 503 qui vide la page de tout le reste.
router.get('/ml-reports', async (_req: Request, res: Response) => {
  const timeout = (ms: number) =>
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

  // 8 s et non 4 : la charge utile est plus grosse que /features, et un cold
  // start Railway du conteneur ML dépasse allègrement 4 s.
  const payload = await Promise.race([
    fetch(`${ML_URL}/reports`, { headers: mlHeaders() }).then(async (r) => {
      if (!r.ok) throw new Error(`ML /reports → ${r.status}`);
      return r.json();
    }),
    timeout(8000),
  ]).catch((e: any) => ({ error: e?.message ?? 'ML service unreachable' }));

  res.json({ ...(payload as object), retrieved_at: new Date().toISOString() });
});

// ── GET /api/dev/data-health ──────────────────────────────────────────────────
//
// « Le pipeline de données est-il vivant ? » — la question qu'aucun rapport de
// modèle ne pose. Un modèle parfaitement entraîné sert des prédictions fausses
// si la collecte de cotes s'est arrêtée il y a trois semaines sans rien lever.
//
// Trois signaux :
//  1. `odds_log` — volume, dernière date, et surtout la part de lignes qui ont
//     une clôture DIFFÉRENTE de l'ouverture. C'est le seul contrôle qui
//     distingue « la collecte tourne » de « la collecte tourne une seule fois
//     par jour et n'attrape jamais la clôture » : dans le second cas, open et
//     close sont égaux partout et le CLV est structurellement inmesurable.
//  2. `odds_quota_state` — crédits The Odds API restants et âge de la mesure.
//  3. Volumes de paris — dont l'arriéré de tickets en attente de règlement.
//  4. `odds_snapshots` — la série temporelle du CLV (A1bis). Voir le bloc.
//     C'est la seule des quatre dont l'absence ne se voit nulle part ailleurs.
//
// Toutes les requêtes sont bornées et indexées ; aucune ne scanne une table
// utilisateur en entier.
router.get('/data-health', async (_req: Request, res: Response) => {
  try {
    const [oddsLog, quota, slips, snapshots] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int                                            AS rows,
                MIN(game_date)                                           AS first_date,
                MAX(game_date)                                           AS last_date,
                MAX(updated_at)                                          AS last_write,
                COUNT(*) FILTER (WHERE home_ml_close IS NOT NULL)::int    AS with_ml_close,
                COUNT(*) FILTER (WHERE total_close  IS NOT NULL)::int     AS with_total_close,
                COUNT(*) FILTER (WHERE pl_home_price IS NOT NULL)::int    AS with_puckline_close,
                -- Mouvement réel : open et close capturés à des moments
                -- différents. Si ce compteur reste à 0 alors que with_ml_close
                -- grimpe, la collecte ne passe qu'une fois par jour.
                COUNT(*) FILTER (
                  WHERE home_ml_open IS NOT NULL
                    AND home_ml_close IS NOT NULL
                    AND home_ml_open <> home_ml_close
                )::int                                                    AS with_ml_movement
           FROM odds_log`,
      ).catch(() => null),

      pool.query(
        `SELECT remaining, used, observed_at FROM odds_quota_state WHERE id = 1`,
      ).catch(() => null),

      pool.query(
        `SELECT COUNT(*)::int                                                  AS total,
                COUNT(*) FILTER (WHERE outcome = 'pending')::int               AS pending,
                COUNT(*) FILTER (WHERE outcome <> 'pending')::int              AS settled,
                MAX(placed_at)                                                 AS last_placed,
                MAX(resolved_at)                                               AS last_resolved,
                -- Tickets en attente dont le dernier match est joué depuis
                -- plus de 24 h : le job de règlement les a manqués.
                COUNT(*) FILTER (
                  WHERE outcome = 'pending'
                    AND placed_at < NOW() - INTERVAL '2 days'
                )::int                                                         AS stale_pending
           FROM bet_slips`,
      ).catch(() => null),

      // 4. `odds_snapshots` (migration 031) — la SEULE table qu'A1bis existe
      //    pour remplir, et la seule dont l'échec est SILENCIEUX :
      //    `insertSnapshots` avale son erreur dans un `logger.warn` pour ne pas
      //    faire tomber la passe (odds_log prime). Table absente ou colonne
      //    manquante → la collecte tourne, les logs disent « ok », et la série
      //    temporelle reste vide. Sans ce bloc, rien dans le produit ne lit
      //    cette table : le trou ne se verrait qu'au moment de l'analyse, une
      //    saison trop tard.
      //
      //    `passes_today` est le chiffre qui compte : il doit atteindre 6 en
      //    fin de journée de saison (2 `full` + 4 `spreads`). S'il plafonne à 1
      //    ou 2, le calendrier ne se replanifie pas — l'instance redémarre.
      pool.query(
        `SELECT COUNT(*)::int                                    AS rows,
                COUNT(DISTINCT observed_at)::int                 AS passes,
                COUNT(DISTINCT observed_at) FILTER (
                  WHERE observed_at >= NOW() - INTERVAL '24 hours'
                )::int                                           AS passes_today,
                MIN(game_date)                                   AS first_date,
                MAX(game_date)                                   AS last_date,
                MAX(observed_at)                                 AS last_observed,
                COUNT(*) FILTER (WHERE markets = 'full')::int    AS rows_full,
                COUNT(*) FILTER (WHERE markets = 'spreads')::int AS rows_spreads,
                -- Une puck line absente partout = les passes 'spreads'
                -- ramenent des lignes vides, donc 4 credits/jour perdus.
                COUNT(*) FILTER (WHERE pl_home_price IS NOT NULL)::int AS with_puckline
           FROM odds_snapshots`,
      ).catch(() => null),
    ]);

    res.json({
      odds_log:  oddsLog?.rows[0] ?? { error: 'table indisponible (migration 027/028 ?)' },
      odds_quota: quota?.rows[0]  ?? { error: 'table indisponible (migration 028 ?)' },
      odds_snapshots: snapshots?.rows[0] ?? { error: 'table indisponible (migration 031 ?)' },
      slips:     slips?.rows[0]   ?? { error: 'table indisponible' },
      retrieved_at: new Date().toISOString(),
    });
  } catch (err: any) {
    sendError(res, err);
  }
});

// ── GET /api/dev/live-performance ─────────────────────────────────────────────
//
// Ce que le modèle vaut EN PRODUCTION, par opposition aux backtests. Source :
// les jambes réglées de `bet_slips`, qui portent depuis le lot du 2026-08-09 un
// `result` par jambe ('win' | 'loss' | 'unknown') en plus de l'outcome du
// ticket. Sans ce détail, un parlay perdu ne dirait rien de chacune de ses
// jambes ; avec lui, chaque jambe est une observation.
//
// CE QUI EST CALCULÉ ICI
//  • Calibration — « quand le modèle dit 70 %, ça passe combien de fois ? ».
//    C'est LE diagnostic honnête : il ne dépend d'aucune cote, seulement de la
//    probabilité affichée et du résultat. Brier et log-loss le résument.
//  • ROI à mise plate — depuis `oddsLabel` (prix américain au moment du pari).
//    Les jambes sans prix lisible sont comptées à part, jamais traitées comme
//    du 100 (ce qui gonflerait le ROI).
//  • Découpage simple / combiné — les jambes d'un combiné sont sélectionnées
//    autrement (on cherche du gros prix), et les mélanger fabrique une moyenne
//    qui ne décrit aucune stratégie réelle.
//
// CE QUI N'EST **PAS** CALCULÉ — le CLV. Il faudrait le prix de CLÔTURE du même
// marché, or `odds_log` est indexé par (date, domicile, extérieur) tandis
// qu'une jambe ne porte qu'un `gameId` NHL. `nhl_games` ferait le pont mais
// n'est peuplé que par le seed. Voir la note du dashboard : c'est une
// plomberie à poser, pas un affichage à ajouter.
//
// Lecture seule et bornée : fenêtre glissante + plafond de lignes.

/** Prix américain ("-150", "+120") → gain net pour 1 unité misée. */
function americanToProfit(label: string | null): number | null {
  if (!label) return null;
  const n = Number(String(label).replace(/[^0-9+-]/g, ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? n / 100 : 100 / Math.abs(n);
}

interface Bucket {
  n: number; wins: number; probSum: number;
  staked: number; profit: number; priced: number;
}
const emptyBucket = (): Bucket =>
  ({ n: 0, wins: 0, probSum: 0, staked: 0, profit: 0, priced: 0 });

function summarize(b: Bucket) {
  return {
    n:          b.n,
    hit_rate:   b.n ? +(100 * b.wins / b.n).toFixed(2) : null,
    // Probabilité moyenne annoncée par le modèle sur ces jambes : à comparer
    // au hit rate. L'écart entre les deux EST le biais de calibration.
    avg_prob:   b.n ? +(b.probSum / b.n).toFixed(2) : null,
    n_priced:   b.priced,
    roi_flat_pct: b.priced ? +(100 * b.profit / b.staked).toFixed(2) : null,
  };
}

router.get('/live-performance', async (req: Request, res: Response) => {
  // Fenêtre par défaut : 365 jours. Bornée à 5 ans pour que la requête reste
  // prévisible même si le paramètre vient d'un doigt qui a glissé.
  const days = Math.min(Math.max(Number(req.query.days) || 365, 1), 1825);
  const MAX_LEGS = 50_000;

  try {
    const { rows } = await pool.query<{
      leg_count: number;
      market_type: string | null;
      probability: string | null;
      odds_label: string | null;
      result: string;
    }>(
      `SELECT s.leg_count,
              leg->>'marketType'  AS market_type,
              leg->>'probability' AS probability,
              leg->>'oddsLabel'   AS odds_label,
              leg->>'result'      AS result
         FROM bet_slips s,
              LATERAL jsonb_array_elements(s.legs) AS leg
        WHERE s.outcome <> 'pending'
          -- Garde-fou : jsonb_array_elements lève sur un JSONB qui n'est pas
          -- un tableau, et une seule ligne malformée ferait échouer TOUTE la
          -- mesure. Le filtre la saute au lieu de rendre un 500.
          AND jsonb_typeof(s.legs) = 'array'
          AND s.resolved_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND leg->>'result' IN ('win', 'loss')
        ORDER BY s.resolved_at DESC
        LIMIT $2`,
      [days, MAX_LEGS],
    );

    const all     = emptyBucket();
    const singles = emptyBucket();
    const parlays = emptyBucket();
    const byMarket = new Map<string, Bucket>();
    // 10 tranches de 10 points de probabilité.
    const calib = Array.from({ length: 10 }, emptyBucket);

    let brierSum = 0, logLossSum = 0, scored = 0;
    let unparseableProb = 0;

    for (const r of rows) {
      const won  = r.result === 'win';
      const prob = r.probability == null ? NaN : Number(r.probability);
      const profit = americanToProfit(r.odds_label);

      const add = (b: Bucket) => {
        b.n++;
        if (won) b.wins++;
        if (Number.isFinite(prob)) b.probSum += prob;
        if (profit != null) {
          b.priced++;
          b.staked += 1;
          b.profit += won ? profit : -1;
        }
      };

      add(all);
      add(r.leg_count > 1 ? parlays : singles);

      const mkt = r.market_type || 'inconnu';
      if (!byMarket.has(mkt)) byMarket.set(mkt, emptyBucket());
      add(byMarket.get(mkt)!);

      if (Number.isFinite(prob) && prob >= 0 && prob <= 100) {
        const p = prob / 100;
        const y = won ? 1 : 0;
        brierSum += (p - y) ** 2;
        // Bornage : une probabilité de 0 ou 100 ferait diverger le log-loss et
        // un seul pari suffirait à rendre la métrique illisible.
        const pc = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
        logLossSum += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
        scored++;
        add(calib[Math.min(9, Math.floor(prob / 10))]);
      } else {
        unparseableProb++;
      }
    }

    res.json({
      window_days: days,
      truncated:   rows.length >= MAX_LEGS,
      n_legs:      rows.length,
      // Plancher explicite. En dessous, le bruit domine : le client doit
      // afficher « échantillon insuffisant » plutôt qu'un chiffre qui a l'air
      // d'un résultat. Même parti pris que le plancher de 10 paris de
      // `/users/:id/summary`.
      min_sample:  200,
      overall:  summarize(all),
      singles:  summarize(singles),
      parlays:  summarize(parlays),
      by_market: Object.fromEntries(
        [...byMarket.entries()]
          .sort((a, b) => b[1].n - a[1].n)
          .map(([k, v]) => [k, summarize(v)]),
      ),
      calibration: calib.map((b, i) => ({
        bucket: `${i * 10}-${i * 10 + 10}%`,
        ...summarize(b),
      })),
      brier:    scored ? +(brierSum / scored).toFixed(4) : null,
      log_loss: scored ? +(logLossSum / scored).toFixed(4) : null,
      n_scored: scored,
      n_unparseable_prob: unparseableProb,
      n_unpriced: all.n - all.priced,
      // Le CLV n'est pas un oubli : il n'est pas calculable en l'état.
      clv: {
        available: false,
        reason:
          "Aucune table ne relie une jambe pariée à la cote de clôture de son " +
          "marché : `odds_log` est indexé par (date, domicile, extérieur), une " +
          "jambe ne porte qu'un `gameId` NHL, et `nhl_games` n'est peuplé que " +
          "par le seed. Il faut soit enregistrer (game_date, home, away) sur la " +
          "jambe à la soumission, soit ajouter le gameId à `odds_log`.",
      },
      retrieved_at: new Date().toISOString(),
    });
  } catch (err: any) {
    sendError(res, err);
  }
});

// ── GET /api/dev/metrics ──────────────────────────────────────────────────────
//
// Instantané des compteurs : appels sortants par API externe, efficacité de
// chaque cache nommé, retard de l'event loop, mémoire du process.
//
// Existe pour rendre vérifiables les critères des tests de charge de l'audit,
// qui portent tous sur ce que le serveur ÉMET, pas sur ce qu'il répond — donc
// invisibles depuis k6. Voir `loadtest/README.md`.
//
// Lecture seule, et déjà doublement protégé : `authenticate` + `requireRole('admin')`
// en tête de ce routeur, lui-même non monté en production sans ENABLE_DEV_ROUTES.
router.get('/metrics', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  // Le disjoncteur ML est ajouté ici plutôt que dans `metrics.ts` : c'est un
  // état, pas un compteur, et il n'a pas à survivre à `resetMetrics`. Sans lui,
  // un tir de charge où le service Python est tombé montrerait « 0 appel ML »
  // sans dire si c'est le cache qui a bien travaillé ou le circuit qui est
  // ouvert — deux situations opposées, indiscernables sur les seuls compteurs.
  res.json({ ...snapshotMetrics(), mlCircuit: mlCircuitState() });
});

// ── POST /api/dev/metrics/reset ───────────────────────────────────────────────
//
// Ouvre une nouvelle fenêtre de mesure. À appeler juste avant un tir de charge
// pour que les chiffres ne portent que sur lui.
//
// Ne vide PAS les caches : un cache déjà chaud reste chaud. Pour mesurer un
// démarrage à froid (scénario S3), il faut redémarrer le service — sinon on
// lirait « 0 exécution » et on conclurait à tort que la déduplication marche.
// L'instantané d'avant remise à zéro est renvoyé, pour ne rien perdre si on
// oublie de le lire d'abord.
router.post('/metrics/reset', (_req: Request, res: Response) => {
  const before = snapshotMetrics();
  resetMetrics();
  res.json({ reset_at: new Date().toISOString(), before });
});

// ── File de modération du chat — R4.2h (Guideline 1.2) ───────────────────────
//
// ⚠️ À ne pas confondre avec `/ml-reports` juste au-dessus, qui parle des
// rapports d'entraînement du modèle. Ici il s'agit de contenu signalé par des
// utilisateurs.
//
// Tout ce routeur est déjà `authenticate` + `requireRole('admin')` (l.29), donc
// ces deux routes n'ajoutent aucun garde-fou : elles seraient redondantes.
//
// **Cette file doit être lue pour de vrai.** Apple ne demande pas seulement
// qu'un mécanisme existe, il demande le processus de réponse ; une file jamais
// ouverte est pire que pas de file, parce qu'elle promet une modération qui
// n'arrive jamais.

// GET /api/dev/reports — les signalements ouverts, groupés par message
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 100;
    res.json({ reports: await chatService.getOpenReports(limit) });
  } catch (err: any) { sendError(res, err); }
});

// POST /api/dev/reports/:id  { status: 'actioned' | 'dismissed' }
//
// `:id` est UN signalement, mais la décision porte sur le MESSAGE : tous les
// signalements ouverts du même message sont tranchés ensemble (voir
// chatService.reviewReport). C'est pour ça que la file rend un seul `reportId`
// par message.
router.post('/reports/:id', async (req: Request, res: Response) => {
  try {
    const { status } = req.body ?? {};
    if (!status) return res.status(400).json({ error: 'status is required' });
    const result = await chatService.reviewReport(
      Number(req.params.id), req.user!.sub, String(status),
    );
    res.json(result);
  } catch (err: any) { sendError(res, err); }
});

export default router;
