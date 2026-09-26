// R5 — SIGTERM during traffic: in-flight requests must finish, no 5xx.
import { execSync } from 'node:child_process';
const pid = execSync("pgrep -f 'node dist/server.js' | head -1").toString().trim();
const res = { ok: 0, s5xx: 0, other: 0, refused: 0 };
let stop = false;
async function worker(i) {
  while (!stop) {
    try {
      const r = await fetch('http://127.0.0.1:3001/api/predict/best-bets', { headers: { 'X-Forwarded-For': `192.0.2.${i}` } });
      await r.arrayBuffer();
      if (r.status === 200) res.ok++; else if (r.status >= 500) res.s5xx++; else res.other++;
    } catch { res.refused++; await new Promise(r => setTimeout(r, 50)); }
  }
}
const ws = Array.from({ length: 20 }, (_, i) => worker(i + 1));
await new Promise(r => setTimeout(r, 1500));
const before = { ...res };
process.kill(Number(pid), 'SIGTERM');
const t = Date.now();
await new Promise(r => setTimeout(r, 3000));
stop = true; await Promise.all(ws);
console.log(JSON.stringify({ pid, before, after: res }));
