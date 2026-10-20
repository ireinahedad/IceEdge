// Diagnostic : pourquoi un compte ne reçoit pas d'alerte value bet.
// Usage (depuis server/) : node scripts/check-value-bets.cjs [email]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const email = process.argv[2] || 'ireina%';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const me = await pool.query(
      `SELECT u.email, up.notify_value_bets, up.value_bet_min_ev_pct, s.plan, s.status, s.current_period_end,
              (SELECT count(*) FROM apns_device_tokens t WHERE t.user_id = u.id)  AS ios,
              (SELECT count(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS web
         FROM users u
         JOIN user_profiles up ON up.user_id = u.id
         LEFT JOIN subscriptions s ON s.user_id = u.id
        WHERE u.email ILIKE $1`, [email]);
    console.log('\n== Mon compte ==');
    console.table(me.rows);

    const log = await pool.query(
      `SELECT game_date::text, count(*) AS n, round(max(first_edge)::numeric * 100, 1) AS max_edge_pct
         FROM value_bet_log
        WHERE game_date > now() - interval '14 days'
        GROUP BY 1 ORDER BY 1 DESC`);
    console.log('\n== Value bets detectes (14 derniers jours) ==');
    console.table(log.rows);
  } catch (e) {
    console.error('Erreur :', e.message);
  } finally {
    await pool.end();
  }
})();
