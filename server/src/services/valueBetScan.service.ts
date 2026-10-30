// ============================================================
//  Value-bet scan job
// ============================================================
// Periodically looks for a standout value bet and pushes it to Pro users who
// opted into value-bet notifications. Enabled via PUSH_SCAN_ENABLED=true.
//
// Le CRITÈRE n'est plus ici : il vit dans `valueBets.service.ts`, partagé avec
// la section Value Bets de l'accueil (décision du user, 2026-10-02 — l'accueil
// et l'alerte ne doivent plus pouvoir se contredire). Ce module ne fait que
// prendre le meilleur value bet du moment (le plus gros edge, critère dont le
// ROI a été mesuré), éviter de le repousser, et le diffuser aux abonnés dont
// le seuil personnel est atteint.

import { pool } from '../db/connection';
import { getCurrentValueBets, type ValueBet } from './valueBets.service';
import { logger } from '../logger';
import { sendToUsers, pushEnabled } from './push.service';
import { withJobLock, getJobState, setJobState } from './jobLock';
import { fetchGamesByDate } from './nhlApiClient';
import { onClockGrid, gridFor } from './clockGrid';

/**
 * Clé de la dernière alerte envoyée, en base et non en mémoire.
 *
 * En mémoire, elle avait deux défauts visibles par l'utilisateur final :
 *   • après chaque redéploiement le compteur repartait à zéro, donc la dernière
 *     alerte était renvoyée à tous les abonnés ;
 *   • en multi-instance, le verrou de job ne suffit pas : il n'est tenu que
 *     pendant l'exécution, donc deux instances dont les timers sont décalés le
 *     prennent l'une après l'autre et poussent la même alerte. Il faut que le
 *     « déjà envoyé » soit une mémoire commune.
 */
const LAST_ALERT_KEY = 'valueBetScan:lastAlertKey';
/** Un scan peut réveiller le paquet ML de chaque match éligible de la soirée. */
const LOCK_TTL_MS = 10 * 60 * 1000;

/** Le meilleur value bet encore prenable (match pas commencé), ou null. */
async function findTopValueBet(): Promise<ValueBet | null> {
  const bets = await getCurrentValueBets();   // trié par edge décroissant
  return bets[0] ?? null;
}

/** Libellé court d'une sélection, pour la notification. */
function labelOf(vb: ValueBet): string {
  return vb.market === 'puck_line'
    ? `${vb.team} ${vb.line ?? -1.5} vs ${vb.opponent}`
    : `${vb.team} gagne vs ${vb.opponent}`;
}

/** A recipient plus their personal minimum-EV threshold (in whole %). */
interface OptedInUser { userId: string; minEvPct: number; }

/**
 * Users who are Pro AND opted into value-bet notifications AND have a device.
 *
 * « Un appareil » = un abonnement Web Push OU un jeton APNs (app iOS). Jusqu'au
 * 2026-10-20 seule `push_subscriptions` était lue : un abonné Pro qui n'avait
 * que l'app iPhone n'était jamais sélectionné, alors que `sendToUsers` sait
 * pourtant livrer sur APNs.
 */
async function optedInUsers(): Promise<OptedInUser[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT d.user_id, up.value_bet_min_ev_pct
       FROM (SELECT user_id FROM push_subscriptions
             UNION
             SELECT user_id FROM apns_device_tokens) d
       JOIN user_profiles up ON up.user_id = d.user_id
       JOIN subscriptions  s ON s.user_id  = d.user_id
      WHERE up.notify_value_bets = TRUE
        AND s.plan = 'pro'
        AND s.status IN ('active','trialing')
        AND (s.current_period_end IS NULL OR s.current_period_end > NOW())`,
  );
  return rows.map((r) => ({ userId: r.user_id, minEvPct: Number(r.value_bet_min_ev_pct) || 0 }));
}

async function runScan(): Promise<void> {
  try {
    const vb = await findTopValueBet();
    if (!vb) return;

    // Lu à CHAQUE tour, et sous verrou : c'est ce qui rend l'anti-doublon
    // efficace entre instances et à travers les redéploiements.
    if (vb.id === (await getJobState(LAST_ALERT_KEY))) return;   // nothing new to alert

    // Marqué AVANT l'envoi, et l'échec d'écriture annule l'envoi. Ne pas pouvoir
    // mémoriser « déjà envoyé » et pousser quand même, c'est se garantir de
    // repousser la même alerte au tour suivant : mieux vaut une alerte manquée
    // qu'une alerte en boucle chez tous les abonnés.
    if (!(await setJobState(LAST_ALERT_KEY, vb.id))) {
      logger.warn({ key: vb.id }, '[ValueBetScan] état non persisté — envoi annulé pour éviter un doublon');
      return;
    }

    // Only notify users whose personal minimum-EDGE threshold is met by this bet.
    //
    // ⚠️ Comparé à l'EDGE, PAS à l'EV — c'était l'inverse jusqu'au 2026-09-08.
    // L'écran Réglages intitule le champ « Edge minimum » et son aide parle d'edge,
    // mais le filtre lisait l'EV : deux quantités différentes (edge = proba modèle
    // − proba marché dé-viggée ; EV = proba modèle × cote − 1), donc un seuil réglé
    // à 3 % ne coupait pas ce que l'utilisateur croyait couper. C'est aussi l'edge,
    // et non l'EV, dont le ROI est validé au backtest walk-forward, et c'est lui que
    // bornent les règles de `valueBets.service.ts` : le seuil personnel prolonge
    // donc le plancher global au lieu de le croiser. Comparaison exacte, sans
    // arrondi : un edge de 2,6 n'atteint pas un seuil de 3.
    const recipients = (await optedInUsers()).filter((u) => vb.edge * 100 + 1e-9 >= u.minEvPct);
    if (recipients.length === 0) return;

    const payload = {
      title: 'Value bet détecté',
      body: `${labelOf(vb)} · edge +${(vb.edge * 100).toFixed(1)} pts · cote ${vb.price.toFixed(2)} (${vb.bookTitle}) · rentable au-dessus de ${vb.minOdds.toFixed(2)} · modèle ${Math.round(vb.modelProb * 100)} %`,
      url: '/',
    };
    // Un seul appel pour tout le lot : une requête de lecture, un plafond
    // d'envois simultanés, une purge groupée (cf. `sendToUsers`). C'est ici que
    // la liste est la plus longue — elle vaut le nombre d'abonnés opt-in.
    const res = await sendToUsers(recipients.map((u) => u.userId), payload);
    logger.info({ recipients: recipients.length, ...res }, '[ValueBetScan] alerte diffusée');
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[ValueBetScan] scan failed');
  }
}

/** Ouverture de la fenêtre de scan : 7 h avant la 1re mise au jeu (≈ midi ET pour 19 h). */
export const SCAN_LEAD_MS = 7 * 60 * 60_000;

/**
 * Vrai si un value bet peut exister maintenant : entre 7 h avant le 1er match
 * du jour et la DERNIÈRE mise au jeu (après, plus rien n'est prenable). Hors de
 * cette fenêtre, ou un jour sans match, le tour ne touche pas la base — même
 * pas pour le verrou, qui est une écriture Postgres (`job_locks`) et suffisait
 * à réveiller Neon toutes les 30 min, jour et nuit.
 */
export function inScanWindow(now: number, startsUtc: number[]): boolean {
  if (startsUtc.length === 0) return false;
  return now >= Math.min(...startsUtc) - SCAN_LEAD_MS && now < Math.max(...startsUtc);
}

async function todaysStarts(): Promise<number[]> {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const games = await fetchGamesByDate(day);   // API NHL + cache mémoire, jamais la base
  return games.map((g: any) => Date.parse(g?.startTimeUTC ?? '')).filter(Number.isFinite);
}

/** Un tour de scan, sous verrou d'unicité — seulement dans la fenêtre des matchs. */
function tick(): void {
  void (async () => {
    if (!inScanWindow(Date.now(), await todaysStarts())) return;
    await withJobLock('value-bet-scan', LOCK_TTL_MS, runScan);
  })().catch((err: any) => logger.warn({ err: err?.message }, '[ValueBetScan] tick failed'));
}

export function startValueBetScan(): void {
  if (process.env.PUSH_SCAN_ENABLED !== 'true') return;
  if (!pushEnabled()) {
    logger.warn('[ValueBetScan] push not configured — scan not started.');
    return;
  }
  const periodMs = (Number(process.env.PUSH_SCAN_INTERVAL_MIN) || 30) * 60 * 1000;
  // Sur la grille d'horloge (:00 / :30), pas N min après le démarrage : le tour
  // partage ainsi la fenêtre Neon des autres jobs (clockGrid.ts).
  const schedule = () => {
    setTimeout(() => { schedule(); tick(); }, onClockGrid(periodMs, Date.now(), gridFor(periodMs))).unref();
  };
  schedule();
  // Kick off one scan shortly after boot.
  setTimeout(tick, 15_000);
}
