/**
 * instagram-publish.mjs — publie le Reel des combinés (MARKETING_PLAN Phase D)
 * ------------------------------------------------------------------
 * L'API Instagram ne programme pas : `parlays-daily.ts` crée le conteneur Reel
 * le matin (06:00 UTC) et dépose `instagram/<date>.json` sur R2 ; ce script,
 * lancé toutes les heures le soir par `.github/workflows/instagram-reel.yml`,
 * le publie dès que l'heure visée (1er match − 2 h) est à moins de 30 min.
 *
 *   node scripts/instagram-publish.mjs             publie si c'est l'heure
 *   node scripts/instagram-publish.mjs --check     vérifie jeton + file, ne publie rien
 *   node scripts/instagram-publish.mjs --refresh   renouvelle le jeton (60 jours)
 *
 * Aucune dépendance (Node 18+, fetch intégré). IDEMPOTENT : l'état « publié »
 * se lit chez Meta (status_code PUBLISHED du conteneur), rien n'est écrit.
 * Le jeton n'est jamais affiché ; --refresh écrit le nouveau dans
 * $GITHUB_OUTPUT (masqué) pour que le workflow le range dans les secrets.
 *
 * Codes de sortie : 0 = fait ou rien à faire ; 1 = erreur.
 */

import { appendFileSync } from 'node:fs';

const EARLY_MS = 30 * 60_000;   // publier jusqu'à 30 min avant l'heure visée (cron horaire)
const LATE_MS = 6 * 3_600_000;  // au-delà de 6 h de retard, on ne publie plus : le match est fini

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REFRESH = args.includes('--refresh');

function need(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`variable ${name} absente`);
  return v;
}
function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}
const host = (t) => (t.startsWith('EAA') ? 'https://graph.facebook.com/v25.0' : 'https://graph.instagram.com/v25.0');
const bali = (iso) => new Date(iso).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });

async function graph(method, path, params = {}) {
  const token = need('INSTAGRAM_ACCESS_TOKEN');
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = `${host(token)}/${path}`;
  const res = method === 'GET'
    ? await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(60_000) })
    : await fetch(url, { method, body: qs, signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Instagram ${method} ${path.split('?')[0]} → HTTP ${res.status} ${body.error?.message ?? ''}`);
  return body;
}

/** Jour NHL (heure de New York) : avant 06:00 UTC, c'est encore la soirée d'hier. */
function etDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function queue(date) {
  const base = need('R2_PUBLIC_URL').replace(/\/+$/, '');
  const res = await fetch(`${base}/instagram/${date}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 : lecture de instagram/${date}.json → HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  const token = need('INSTAGRAM_ACCESS_TOKEN');
  if (token.startsWith('EAA')) {
    summary('- Jeton Facebook (EAA…) : pas de renouvellement automatique ici, à régénérer dans le tableau de bord Meta avant expiration.');
    return;
  }
  const qs = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Instagram : renouvellement refusé (HTTP ${res.status} ${body.error?.message ?? ''})`);
  const days = Math.round(Number(body.expires_in ?? 0) / 86400);
  if (process.env.GITHUB_OUTPUT) {
    console.log(`::add-mask::${body.access_token}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `token=${body.access_token}\nchanged=${body.access_token !== token}\n`);
  }
  summary(`- Jeton renouvelé : valable ${days} jours${body.access_token !== token ? ' (nouvelle valeur)' : ' (même valeur)'}`);
}

async function main() {
  if (REFRESH) return refresh();

  const userId = need('INSTAGRAM_USER_ID');
  if (CHECK) {
    // `user_id` = ID du compte professionnel (celui des publications), `id` = ID propre à l'app.
    const me = await graph('GET', 'me', { fields: 'id,user_id,username' });
    const ok = [me.user_id, me.id].map(String).includes(userId);
    summary(`- Jeton OK : @${me.username}${ok ? '' : ` ⚠️ INSTAGRAM_USER_ID (${userId}) ne correspond pas : mettre ${me.user_id ?? me.id}`}`);
    try {
      const lim = await graph('GET', `${userId}/content_publishing_limit`, { fields: 'quota_usage,config' });
      const d = lim.data?.[0];
      if (d) summary(`- Quota : ${d.quota_usage ?? 0} / ${d.config?.quota_total ?? '?'} publications sur 24 h`);
    } catch (e) { summary(`- Quota illisible (${e.message})`); }
  }

  // Le JSON du jour NHL, sinon celui de la veille (publication tard le soir en UTC).
  const today = etDay();
  const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  const dates = [today, d.toISOString().slice(0, 10)];
  for (const date of dates) {
    const q = await queue(date);
    if (!q) continue;
    const c = await graph('GET', q.containerId, { fields: 'status_code,status' });
    const at = Date.parse(q.publishAt);
    const now = Date.now();
    if (c.status_code === 'PUBLISHED') { summary(`- ${date} : Reel déjà publié.`); continue; }
    if (c.status_code === 'EXPIRED' || c.status_code === 'ERROR') {
      throw new Error(`${date} : conteneur ${c.status_code} (${c.status ?? ''}) — relancer « Contenu — combinés du jour » à la main pour en refaire un`);
    }
    if (CHECK) { summary(`- ${date} : conteneur ${c.status_code}, publication prévue vers ${bali(q.publishAt)} (Bali)`); continue; }
    if (now < at - EARLY_MS) { summary(`- ${date} : pas encore l'heure (vers ${bali(q.publishAt)} à Bali).`); continue; }
    if (now > at + LATE_MS) { summary(`- ${date} : trop tard (plus de 6 h de retard), pas publié.`); continue; }
    if (c.status_code !== 'FINISHED') throw new Error(`${date} : vidéo pas encore prête chez Meta (${c.status_code}) — prochain passage`);
    const pub = await graph('POST', `${userId}/media_publish`, { creation_id: q.containerId });
    let link = '';
    try { link = (await graph('GET', pub.id, { fields: 'permalink' })).permalink ?? ''; } catch { /* le lien n'est qu'un bonus */ }
    summary(`- ${date} : Reel publié ✅ ${link || pub.id}`);
    return;
  }
  if (!CHECK) summary('- Aucun Reel en attente.');
}

main().catch((e) => { console.error(`\n${e.message}\n`); summary(`- ❌ ${e.message}`); process.exit(1); });
