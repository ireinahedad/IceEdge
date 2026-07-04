// ============================================================
//  Value-bet scan job
// ============================================================
// Periodically looks for a standout value bet and pushes it to Pro users who
// opted into value-bet notifications. Enabled via PUSH_SCAN_ENABLED=true.
//
// NOTE: True +EV requires live bookmaker odds. Until a server-side odds feed is
// wired, this uses the model's top-ranked pick (getBestBets) above a confidence
// threshold as the alert source — swap `findTopValueBet` when odds are available.

import { pool } from '../db/connection';
import { getBestBets } from './bestBets.service';
import { sendToUser, pushEnabled } from './push.service';

const SCORE_THRESHOLD = 65;           // only alert on strong picks
let lastAlertKey: string | null = null;
let timer: NodeJS.Timeout | null = null;

interface ValueBet { key: string; label: string; context: string; score: number; }

async function findTopValueBet(): Promise<ValueBet | null> {
  const { bets } = await getBestBets({ limit: 5, source: 'ml' });
  const top = bets[0];
  if (!top || top.score < SCORE_THRESHOLD) return null;
  return { key: top.id, label: top.label, context: top.context, score: Math.round(top.score) };
}

/** Users who are Pro AND opted into value-bet notifications AND have a device. */
async function optedInUserIds(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ps.user_id
       FROM push_subscriptions ps
       JOIN user_profiles up ON up.user_id = ps.user_id
       JOIN subscriptions  s ON s.user_id  = ps.user_id
      WHERE up.notify_value_bets = TRUE
        AND s.plan = 'pro'
        AND s.status IN ('active','trialing')
        AND (s.current_period_end IS NULL OR s.current_period_end > NOW())`,
  );
  return rows.map((r) => r.user_id);
}

async function runScan(): Promise<void> {
  try {
    const vb = await findTopValueBet();
    if (!vb || vb.key === lastAlertKey) return;   // nothing new to alert
    lastAlertKey = vb.key;

    const userIds = await optedInUserIds();
    if (userIds.length === 0) return;

    const payload = {
      title: '🔥 Value bet détecté',
      body: `${vb.label} · ${vb.score}% · ${vb.context}`,
      url: '/',
    };
    await Promise.all(userIds.map((id) => sendToUser(id, payload)));
    console.log(`[ValueBetScan] Alerted ${userIds.length} user(s): ${vb.label}`);
  } catch (err: any) {
    console.warn('[ValueBetScan] scan failed:', err?.message);
  }
}

export function startValueBetScan(): void {
  if (process.env.PUSH_SCAN_ENABLED !== 'true') return;
  if (!pushEnabled()) {
    console.warn('[ValueBetScan] push not configured — scan not started.');
    return;
  }
  const minutes = Number(process.env.PUSH_SCAN_INTERVAL_MIN) || 30;
  console.log(`[ValueBetScan] Scanning every ${minutes} min for value bets.`);
  timer = setInterval(runScan, minutes * 60 * 1000);
  // Kick off one scan shortly after boot.
  setTimeout(runScan, 15_000);
}

export function stopValueBetScan(): void {
  if (timer) clearInterval(timer);
}
