require('dotenv').config({path: process.cwd()+'/.env'});
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)?false:{rejectUnauthorized:false}});
(async()=>{
 const q=async(n,s,a=[])=>{try{const r=await p.query(s,a);console.log('##',n);console.table(r.rows)}catch(e){console.log('##',n,'ERR',e.message)}};
 await q('log par jour',`SELECT game_date, count(*) n, round(max(first_edge)::numeric,3) max_edge FROM value_bet_log GROUP BY 1 ORDER BY 1 DESC LIMIT 15`);
 await q('job state',`SELECT * FROM job_state WHERE key ILIKE '%valueBet%'`);
 await q('moi',`SELECT u.id, u.email, up.notify_value_bets, up.value_bet_min_ev_pct, s.plan, s.status, s.current_period_end,
   (SELECT count(*) FROM push_subscriptions ps WHERE ps.user_id=u.id) web_push
   FROM users u LEFT JOIN user_profiles up ON up.user_id=u.id LEFT JOIN subscriptions s ON s.user_id=u.id
   WHERE u.email ILIKE 'ireina%' OR u.email ILIKE '%arakice%'`);
 await q('opt-in total',`SELECT count(DISTINCT ps.user_id) FROM push_subscriptions ps JOIN user_profiles up ON up.user_id=ps.user_id JOIN subscriptions s ON s.user_id=ps.user_id WHERE up.notify_value_bets AND s.plan='pro' AND s.status IN ('active','trialing')`);
 await p.end();
})();
