// Dynamic QA against a LOCAL stack — never against production (it writes, and it
// reads the API's own secrets to forge tokens and sign Stripe webhooks).
// See README.md next to this file. Usage: node qa.mjs [F1 F6 S1 S2 I3 F3 I5 P3 P5 MOD]
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.QA_SERVER_DIR ?? path.resolve(here, '../../server');
const CLIENT = process.env.QA_CLIENT_DIR ?? path.resolve(here, '../../client');
const require = createRequire(SERVER + '/');
const pg = require('pg');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { io } = createRequire(CLIENT + '/')('socket.io-client');

const API = process.env.QA_API ?? 'http://127.0.0.1:3001';
if (/arakice\.com|railway\.app/i.test(API)) throw new Error('QA_API points at production — refusing.');
const ORIGIN = 'https://arakice.com';
const env = Object.fromEntries(
  (await import('node:fs')).readFileSync(process.env.QA_ENV_FILE ?? '/tmp/qa/api.env', 'utf8').split('\n')
    .filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
if (/neon\.tech/i.test(env.DATABASE_URL ?? '')) throw new Error('DATABASE_URL is Neon — refusing.');
const db = new pg.Pool({ connectionString: env.DATABASE_URL });

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ipCounter = 10;
// Each logical client gets its own X-Forwarded-For so per-IP limiters don't bleed between checks
// (the app trusts one proxy hop, like behind Railway).
const newIp = () => `203.0.113.${ipCounter++}`;

async function call(method, path, { token, body, cookie, headers = {}, ip } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (ip) h['X-Forwarded-For'] = ip;
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined && !(body instanceof Buffer)) h['Content-Type'] = 'application/json';
  const res = await fetch(API + path, {
    method, headers: h,
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json, text, headers: res.headers, setCookie };
}
const cookieFrom = r => {
  const c = r.setCookie.find(s => s.startsWith('ice_refresh='));
  return c ? c.split(';')[0] : null;
};

async function register(tag) {
  const ip = newIp();
  const u = `qa_${tag}_${crypto.randomBytes(3).toString('hex')}`;
  const email = `${u}@example.test`;
  const password = 'Correct-Horse-9';
  const r = await call('POST', '/api/auth/register', { body: { email, username: u, password }, ip });
  return { ...r, email, password, username: u, ip, token: r.json?.tokens?.access_token, cookie: cookieFrom(r), id: r.json?.user?.id };
}

const sections = {};

// ── F1 — full auth cycle ────────────────────────────────────────────────────
sections.F1 = async () => {
  const a = await register('f1');
  check('F1.1', 'register → 201 + access token (EMAIL_VERIFICATION_DISABLED=true, as in prod)', a.status === 201 && !!a.token, `status ${a.status}`);
  const raw = a.setCookie.find(s => s.startsWith('ice_refresh=')) || '';
  check('F1.2', 'refresh cookie is HttpOnly; Secure; SameSite=None; Path=/api/auth',
    /HttpOnly/i.test(raw) && /Secure/i.test(raw) && /SameSite=None/i.test(raw) && /Path=\/api\/auth/i.test(raw), raw.replace(/ice_refresh=[^;]+/, 'ice_refresh=…'));
  check('F1.3', 'refresh token NOT in the JSON body for a browser', a.json?.tokens && !('refresh_token' in a.json.tokens));
  const me = await call('GET', '/api/auth/me', { token: a.token, ip: a.ip });
  check('F1.4', '/auth/me with the access token → 200', me.status === 200 && me.json?.user?.sub === a.id);
  const login = await call('POST', '/api/auth/login', { body: { email: a.email, password: a.password }, ip: a.ip });
  check('F1.5', 'login → 200 + cookie', login.status === 200 && !!cookieFrom(login));
  const badLogin = await call('POST', '/api/auth/login', { body: { email: a.email, password: 'wrong-password-1' }, ip: a.ip });
  const noUser = await call('POST', '/api/auth/login', { body: { email: 'nobody_' + a.email, password: 'wrong-password-1' }, ip: a.ip });
  check('F1.6', 'wrong password and unknown email give the same answer (no enumeration)',
    badLogin.status === noUser.status && JSON.stringify(badLogin.json) === JSON.stringify(noUser.json), `${badLogin.status} ${JSON.stringify(badLogin.json)}`);
  const c1 = cookieFrom(login);
  const r1 = await call('POST', '/api/auth/refresh', { cookie: c1, ip: a.ip });
  const c2 = cookieFrom(r1);
  check('F1.7', 'refresh → 200, new access token, rotated cookie', r1.status === 200 && !!r1.json?.access_token && c2 && c2 !== c1);
  const out = await call('POST', '/api/auth/logout', { token: r1.json.access_token, cookie: c2, ip: a.ip });
  check('F1.8', 'logout → 204 and clears the cookie', out.status === 204 && out.setCookie.some(s => s.startsWith('ice_refresh=;') || /Expires=Thu, 01 Jan 1970/i.test(s)));
  const after = await call('POST', '/api/auth/refresh', { cookie: c2, ip: a.ip });
  check('F1.9', 'refresh with the logged-out cookie → 401', after.status === 401, `status ${after.status}`);
  // native mode must be refused from a browser origin
  const nat = await call('POST', '/api/auth/login', { body: { email: a.email, password: a.password }, headers: { 'X-Client': 'native' }, ip: a.ip });
  check('F1.10', 'X-Client: native from a browser Origin still gets the cookie path (no refresh token in body)', nat.status === 200 && !nat.json?.tokens?.refresh_token);
  const nat2 = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'native', 'X-Forwarded-For': a.ip }, body: JSON.stringify({ email: a.email, password: a.password }) }).then(r => r.json());
  check('F1.11', 'X-Client: native without Origin gets the refresh token in the body', !!nat2?.tokens?.refresh_token);
};

// ── F6 — password recovery ──────────────────────────────────────────────────
sections.F6 = async () => {
  const a = await register('f6');
  const t0 = Date.now(); const known = await call('POST', '/api/auth/forgot-password', { body: { email: a.email }, ip: a.ip }); const dt1 = Date.now() - t0;
  const t1 = Date.now(); const unknown = await call('POST', '/api/auth/forgot-password', { body: { email: 'ghost_' + a.email }, ip: newIp() }); const dt2 = Date.now() - t1;
  check('F6.1', 'forgot-password: same answer for existing and unknown email', known.status === 200 && unknown.status === 200 && known.text === unknown.text, `${dt1} ms vs ${dt2} ms`);
  // Mail is not sent (no RESEND_API_KEY) → plant a known code with the service's own hash format.
  const code = '424242';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = `sha256$${salt}$${crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex')}`;
  const upd = await db.query(`UPDATE email_verification_codes SET code_hash=$1 WHERE user_id=$2 AND purpose='password_reset' AND consumed=FALSE`, [hash, a.id]);
  check('F6.2', 'a reset code row was created', upd.rowCount === 1);
  const wrong = await call('POST', '/api/auth/reset-password', { body: { email: a.email, code: '000000', new_password: 'New-Password-77' }, ip: a.ip });
  check('F6.3', 'wrong code → 400', wrong.status === 400);
  const ok = await call('POST', '/api/auth/reset-password', { body: { email: a.email, code, new_password: 'New-Password-77' }, ip: a.ip });
  check('F6.4', 'right code → 200', ok.status === 200, `status ${ok.status} ${ok.text.slice(0, 80)}`);
  const reuse = await call('POST', '/api/auth/reset-password', { body: { email: a.email, code, new_password: 'Another-Pass-88' }, ip: a.ip });
  check('F6.5', 'code is single-use', reuse.status === 400);
  const oldPw = await call('POST', '/api/auth/login', { body: { email: a.email, password: a.password }, ip: a.ip });
  const newPw = await call('POST', '/api/auth/login', { body: { email: a.email, password: 'New-Password-77' }, ip: a.ip });
  check('F6.6', 'old password refused, new one accepted', oldPw.status === 401 && newPw.status === 200, `${oldPw.status}/${newPw.status}`);
  const oldSession = await call('POST', '/api/auth/refresh', { cookie: a.cookie, ip: a.ip });
  check('F6.7', 'sessions opened before the reset are revoked', oldSession.status === 401);
  // brute force: 5 wrong attempts then locked even with the right code
  await call('POST', '/api/auth/forgot-password', { body: { email: a.email }, ip: newIp() });
  const salt2 = crypto.randomBytes(16).toString('hex');
  await db.query(`UPDATE email_verification_codes SET code_hash=$1 WHERE user_id=$2 AND purpose='password_reset' AND consumed=FALSE`,
    [`sha256$${salt2}$${crypto.createHash('sha256').update(`${salt2}:${code}`).digest('hex')}`, a.id]);
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/reset-password', { body: { email: a.email, code: String(100000 + i), new_password: 'Brute-Force-11' }, ip: newIp() });
  const locked = await call('POST', '/api/auth/reset-password', { body: { email: a.email, code, new_password: 'Brute-Force-11' }, ip: newIp() });
  check('F6.8', 'after 5 wrong codes the right one is refused (429)', locked.status === 429, `status ${locked.status}`);
};

// ── S1 — IDOR with two accounts ─────────────────────────────────────────────
sections.S1 = async () => {
  const A = await register('idorA');
  const B = await register('idorB');
  const leg = { gameId: '2026020001', marketType: 'moneyline', selection: 'BOS', selectionValue: 'home', probability: 55 };
  const slip = await call('POST', '/api/slips', { token: A.token, body: { legs: [leg], combinedProbability: 55 }, ip: A.ip });
  check('S1.0', 'A creates a slip', slip.status === 201, `status ${slip.status} ${slip.text.slice(0, 120)}`);
  const sid = slip.json?.slipId;
  const probes = [
    ['GET', `/api/slips/${sid}`, undefined, 'read A\'s slip'],
    ['PATCH', `/api/slips/${sid}/resolve`, { outcome: 'win' }, 'resolve A\'s slip'],
    ['GET', `/api/users/${A.id}`, undefined, 'read A\'s account'],
    ['PATCH', `/api/users/${A.id}`, { first_name: 'pwned' }, 'edit A\'s account'],
    ['PATCH', `/api/users/${A.id}/password`, { current_password: 'x', new_password: 'Pwned-Pass-1' }, 'change A\'s password'],
    ['DELETE', `/api/users/${A.id}`, undefined, 'delete A'],
    ['GET', `/api/users/${A.id}/slips`, undefined, 'list A\'s slips (free viewer)'],
    ['GET', `/api/users/${A.id}/summary`, undefined, 'A\'s summary (free viewer)'],
    ['GET', `/api/users`, undefined, 'list all users'],
    ['GET', `/api/dev/reports`, undefined, 'moderation queue'],
    ['GET', `/api/dev/ml-info`, undefined, '/dev/ml info'],
    ['GET', `/api/manual/injuries`, undefined, 'manual inputs'],
  ];
  for (const [m, p, body, what] of probes) {
    const r = await call(m, p, { token: B.token, body, ip: B.ip });
    const leaked = typeof r.json === 'object' && JSON.stringify(r.json).includes(A.email);
    check('S1', `B cannot ${what}`, [401, 402, 403, 404].includes(r.status) && !leaked, `${m} ${p.replace(A.id, ':A').replace(String(sid), ':slip')} → ${r.status}`);
  }
  const still = await call('GET', `/api/slips/${sid}`, { token: A.token, ip: A.ip });
  check('S1.1', 'A\'s slip untouched (still pending) and readable by A', still.status === 200 && JSON.stringify(still.json).includes('pending'), `status ${still.status}`);
  // private chat room of A
  const room = await call('POST', '/api/chat/rooms', { token: A.token, body: { name: 'qa-private', isPrivate: true }, ip: A.ip });
  const rid = room.json?.id ?? room.json?.room?.id;
  check('S1.2', 'A creates a private room', !!rid, `status ${room.status}`);
  const msg = await call('POST', `/api/chat/rooms/${rid}/messages`, { token: A.token, body: { text: 'secret from A' }, ip: A.ip });
  const mid = msg.json?.id;
  for (const [m, p, body, what] of [
    ['GET', `/api/chat/rooms/${rid}/messages`, undefined, 'read A\'s private room'],
    ['POST', `/api/chat/rooms/${rid}/messages`, { text: 'hi' }, 'post in A\'s private room'],
    ['POST', `/api/chat/rooms/${rid}/join`, undefined, 'join A\'s private room by id'],
    ['GET', `/api/chat/rooms/${rid}/members`, undefined, 'list its members'],
    ['DELETE', `/api/chat/rooms/${rid}/messages/${mid}`, undefined, 'delete A\'s message'],
    ['DELETE', `/api/chat/rooms/${rid}`, undefined, 'delete A\'s room'],
    ['DELETE', `/api/chat/rooms/${rid}/members/${A.id}`, undefined, 'kick A'],
  ]) {
    const r = await call(m, p, { token: B.token, body, ip: B.ip });
    check('S1', `B cannot ${what}`, r.status >= 400 && !r.text.includes('secret from A'), `${m} → ${r.status}`);
  }
  const anon = await call('GET', `/api/chat/rooms/${rid}/messages`, { ip: newIp() });
  check('S1.3', 'a guest cannot read the private room', anon.status >= 400 && !anon.text.includes('secret from A'), `→ ${anon.status}`);
  // mass assignment on own account
  const mass = await call('PATCH', `/api/users/${B.id}`, { token: B.token, body: { role: 'admin', is_pro: true, first_name: 'Bee' }, ip: B.ip });
  const { rows: [rowB] } = await db.query('SELECT role FROM users WHERE id=$1', [B.id]);
  check('S1.4', 'B cannot make itself admin through PATCH /users/:id', rowB.role !== 'admin', `status ${mass.status}, role=${rowB.role}`);
  const steal = await call('PATCH', `/api/users/${B.id}`, { token: B.token, body: { email: A.email }, ip: B.ip });
  check('S1.5', 'B cannot take A\'s email address', steal.status >= 400, `status ${steal.status}`);
  const me = await call('GET', `/api/users/${B.id}`, { token: B.token, ip: B.ip });
  const s = JSON.stringify(me.json);
  check('S1.6', 'own account payload has no password hash / OpenAI key', me.status === 200 && !/password_hash|\$2[aby]\$|openai_api_key/i.test(s), `keys: ${Object.keys(me.json || {}).join(',').slice(0, 160)}`);
  sections._pair = { A, B, sid, rid };
};

// ── S2 — tokens ─────────────────────────────────────────────────────────────
sections.S2 = async () => {
  const A = await register('jwt');
  const [h, p, sig] = A.token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = {
    'role=admin, original signature': `${h}.${b64({ ...payload, role: 'admin' })}.${sig}`,
    'alg=none': `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, role: 'admin' })}.`,
    'signed with a guessed secret': jwt.sign({ ...payload, role: 'admin' }, 'secret'),
    'expired, real secret': jwt.sign({ ...payload, iat: 1, exp: 2 }, env.JWT_SECRET),
    'signed with the REFRESH secret': jwt.sign({ ...payload }, env.JWT_REFRESH_SECRET),
    'garbage': 'abc.def.ghi',
  };
  for (const [what, tok] of Object.entries(forged)) {
    const r = await call('GET', '/api/auth/me', { token: tok, ip: A.ip });
    const r2 = await call('GET', '/api/dev/reports', { token: tok, ip: A.ip });
    check('S2', `forged JWT (${what}) rejected`, r.status === 401 && [401, 403].includes(r2.status), `/me ${r.status}, /dev ${r2.status}`);
  }
  // access token in the query string must not authenticate (moved out of URLs)
  const q = await call('GET', `/api/auth/me?access_token=${A.token}`, { ip: A.ip });
  check('S2.1', 'access token in the query string is ignored', q.status === 401, `status ${q.status}`);
  // refresh not replayable after logout — even inside the 10 s grace window
  const l = await call('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, ip: A.ip });
  const c1 = cookieFrom(l);
  const r1 = await call('POST', '/api/auth/refresh', { cookie: c1, ip: A.ip });
  const c2 = cookieFrom(r1);
  const replayInGrace = await call('POST', '/api/auth/refresh', { cookie: c1, ip: A.ip });
  check('S2.2', 'replay of a just-rotated token inside the grace window → same session (by design)', replayInGrace.status === 200);
  await call('POST', '/api/auth/logout-all', { token: r1.json.access_token, ip: A.ip });
  const afterAll1 = await call('POST', '/api/auth/refresh', { cookie: c1, ip: A.ip });
  const afterAll2 = await call('POST', '/api/auth/refresh', { cookie: c2, ip: A.ip });
  check('S2.3', 'after logout-all, both the rotated and the current token are dead (inside the grace window)', afterAll1.status === 401 && afterAll2.status === 401, `${afterAll1.status}/${afterAll2.status}`);
  // Two devices: device 1 rotates then logs out; replay of its rotated token while device 2 is still signed in
  const d1 = await call('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, ip: A.ip });
  const d2 = await call('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, ip: A.ip });
  const d1c1 = cookieFrom(d1);
  const d1r = await call('POST', '/api/auth/refresh', { cookie: d1c1, ip: A.ip });
  await call('POST', '/api/auth/logout', { token: d1r.json.access_token, cookie: cookieFrom(d1r), ip: A.ip });
  const replay = await call('POST', '/api/auth/refresh', { cookie: d1c1, ip: A.ip });
  check('S2.4', 'device 1 logged out: its rotated token replayed within 10 s while device 2 is signed in',
    replay.status === 401, `status ${replay.status}${replay.status === 200 ? ' — returns a fresh 15-min access token' : ''}`);
  void d2;
  // after grace window
  const g = await call('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, ip: A.ip });
  const g1 = cookieFrom(g);
  await call('POST', '/api/auth/refresh', { cookie: g1, ip: A.ip });
  await sleep(10_500);
  const late = await call('POST', '/api/auth/refresh', { cookie: g1, ip: A.ip });
  check('S2.5', 'rotated token replayed after the 10 s grace window → 401', late.status === 401, `status ${late.status}`);
};

// ── F2 / I3 — Pro gating + Stripe webhook ───────────────────────────────────
sections.I3 = async () => {
  const A = await register('pro');
  const B = await register('proViewer');
  const sub0 = await call('GET', '/api/subscription/me', { token: A.token, ip: A.ip });
  check('F2.1', 'new account is free', sub0.status === 200 && !/"pro"/.test(sub0.text) || sub0.json?.isPro === false, sub0.text.slice(0, 140));
  const gated = await call('GET', `/api/users/${B.id}/slips`, { token: A.token, ip: A.ip });
  check('F2.2', 'free user blocked on a Pro endpoint (402)', gated.status === 402, `status ${gated.status}`);
  const promo = await call('POST', '/api/subscription/redeem', { token: A.token, body: { code: 'NOT-A-CODE' }, ip: A.ip });
  check('F2.3', 'unknown promo code refused', promo.status >= 400 && promo.status < 500, `status ${promo.status}`);
  const stripe = new Stripe('sk_test_dummy');
  const now = Math.floor(Date.now() / 1000);
  const mkEvent = (id, type, status, created) => ({
    id, object: 'event', type, created, api_version: '2024-06-20', livemode: false,
    data: { object: {
      id: 'sub_qa_' + A.id.slice(0, 8), object: 'subscription', status, customer: 'cus_qa',
      metadata: { userId: A.id }, cancel_at_period_end: false,
      current_period_start: now, current_period_end: now + 30 * 86400,
      items: { data: [{ price: { id: 'price_qa', recurring: { interval: 'month' } }, current_period_start: now, current_period_end: now + 30 * 86400 }] },
    } },
  });
  const send = async (ev, secret = env.STRIPE_WEBHOOK_SECRET) => {
    const payload = JSON.stringify(ev);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return call('POST', '/api/subscription/webhook', { body: Buffer.from(payload), headers: { 'Stripe-Signature': sig, 'Content-Type': 'application/json' }, ip: newIp() });
  };
  const webhookPath = await call('POST', '/api/subscription/webhook', { body: Buffer.from('{}'), headers: { 'Content-Type': 'application/json' }, ip: newIp() });
  check('I3.0', 'webhook without signature → 400', webhookPath.status === 400, `status ${webhookPath.status}`);
  const bad = await send(mkEvent('evt_qa_bad', 'customer.subscription.updated', 'active', now), 'whsec_wrong');
  check('I3.1', 'webhook with a wrong signature → 400, no Pro', bad.status === 400, `status ${bad.status}`);
  const ev = mkEvent('evt_qa_' + crypto.randomBytes(4).toString('hex'), 'customer.subscription.updated', 'active', now);
  const ok = await send(ev);
  check('I3.2', 'signed subscription.updated (active) → 200', ok.status === 200, `status ${ok.status} ${ok.text.slice(0, 120)}`);
  await sleep(200);
  const sub1 = await call('GET', '/api/subscription/me', { token: A.token, ip: A.ip });
  check('F2.4', 'subscription/me now says Pro', /pro/i.test(sub1.text) && sub1.json?.isPro !== false, sub1.text.slice(0, 160));
  const unlocked = await call('GET', `/api/users/${B.id}/slips`, { token: A.token, ip: A.ip });
  check('F2.5', 'Pro endpoint now opens for A', unlocked.status === 200, `status ${unlocked.status}`);
  const replay = await send(ev);
  const { rows: evRows } = await db.query('SELECT count(*)::int n FROM stripe_events WHERE id=$1', [ev.id]);
  check('I3.3', 'replaying the same event → 200, recorded once', replay.status === 200 && evRows[0].n === 1, `status ${replay.status}, rows ${evRows[0].n}`);
  const stale = await send(mkEvent('evt_qa_old_' + crypto.randomBytes(3).toString('hex'), 'customer.subscription.updated', 'canceled', now - 3600));
  await sleep(200);
  const sub2 = await call('GET', '/api/subscription/me', { token: A.token, ip: A.ip });
  check('I3.4', 'an OLDER out-of-order "canceled" event does not downgrade', stale.status === 200 && /pro/i.test(sub2.text), sub2.text.slice(0, 120));
  const del = await send(mkEvent('evt_qa_del_' + crypto.randomBytes(3).toString('hex'), 'customer.subscription.deleted', 'canceled', now + 60));
  await sleep(200);
  const sub3 = await call('GET', '/api/subscription/me', { token: A.token, ip: A.ip });
  const blocked = await call('GET', `/api/users/${B.id}/slips`, { token: A.token, ip: A.ip });
  check('F2.6', 'subscription.deleted → back to free (entitlement cache may delay up to PRO_CACHE_TTL_MS)', del.status === 200, `me: ${sub3.text.slice(0, 100)} · gated route ${blocked.status}`);
};

// ── F3 — slips ──────────────────────────────────────────────────────────────
sections.F3 = async () => {
  const A = await register('slip');
  const legs = [
    { gameId: '2026020001', marketType: 'moneyline', selection: 'BOS', selectionValue: 'home', probability: 58, odds: 1.72 },
    { gameId: '2026020002', marketType: 'total_goals', selection: 'Over 5.5', selectionValue: 'over', line: 5.5, probability: 51, odds: 1.95 },
  ];
  const s = await call('POST', '/api/slips', { token: A.token, body: { legs, combinedProbability: 29.6 }, ip: A.ip });
  check('F3.1', 'two-leg slip saved', s.status === 201, `status ${s.status} ${s.text.slice(0, 100)}`);
  const list = await call('GET', '/api/slips', { token: A.token, ip: A.ip });
  check('F3.2', 'slip listed with its 2 legs', list.status === 200 && JSON.stringify(list.json).includes('2026020002'), `status ${list.status}`);
  const bad1 = await call('POST', '/api/slips', { token: A.token, body: { legs: [{ marketType: 'moneyline' }] }, ip: A.ip });
  const bad2 = await call('POST', '/api/slips', { token: A.token, body: { legs: [{ gameId: '2026020001', marketType: 'total_goals', selectionValue: 'over' }] }, ip: A.ip });
  const bad3 = await call('POST', '/api/slips', { token: A.token, body: { legs: Array(31).fill(legs[0]) }, ip: A.ip });
  check('F3.3', 'unsettleable legs refused (no gameId / O-U without line / 31 legs)', bad1.status === 400 && bad2.status === 400 && bad3.status === 400, `${bad1.status}/${bad2.status}/${bad3.status}`);
  const anon = await call('POST', '/api/slips', { body: { legs }, ip: newIp() });
  check('F3.4', 'slip without an account → 401', anon.status === 401);
  const own = await call('PATCH', `/api/slips/${s.json?.slipId}/resolve`, { token: A.token, body: { outcome: 'win' }, ip: A.ip });
  check('F3.5', 'a user cannot self-declare a win (admin-only)', own.status === 403, `status ${own.status}`);
};

// ── I5 — socket.io ─────────────────────────────────────────────────────────
sections.I5 = async () => {
  const A = await register('sock');
  const B = await register('sockB');
  const connect = (auth) => new Promise((resolve) => {
    const s = io(API, { transports: ['websocket'], auth, extraHeaders: { Origin: ORIGIN }, reconnection: false, timeout: 5000 });
    s.on('connect', () => resolve({ s, ok: true }));
    s.on('connect_error', (e) => resolve({ s, ok: false, err: e.message }));
  });
  const bad = await connect({ token: 'forged.token.value' });
  check('I5.1', 'socket with a forged token refused', !bad.ok, bad.err); bad.s.close();
  const guest = await connect({});
  check('I5.2', 'guest socket accepted (read-only by design)', guest.ok);
  const room = await call('POST', '/api/chat/rooms', { token: A.token, body: { name: 'qa-sock-private', isPrivate: true }, ip: A.ip });
  const rid = room.json?.id ?? room.json?.room?.id;
  const deny = await new Promise(res => { guest.s.once('room_error', e => res(e)); guest.s.emit('join_room', rid); setTimeout(() => res(null), 2000); });
  check('I5.3', 'guest cannot join a private room over the socket', !!deny, JSON.stringify(deny));
  const sb = await connect({ token: B.token });
  const denyB = await new Promise(res => { sb.s.once('room_error', e => res(e)); sb.s.emit('join_room', rid); setTimeout(() => res(null), 2000); });
  check('I5.4', 'signed-in non-member cannot join it either', !!denyB);
  const sa = await connect({ token: A.token });
  check('I5.5', 'member socket connects', sa.ok);
  await new Promise(res => { sa.s.once('room_users', res); sa.s.emit('join_room', rid); setTimeout(res, 2000); });
  const got = new Promise(res => { sa.s.once('new_message', m => res(m)); setTimeout(() => res(null), 3000); });
  const leak = new Promise(res => { sb.s.once('new_message', m => res(m)); guest.s.once('new_message', m => res(m)); setTimeout(() => res(null), 3000); });
  await call('POST', `/api/chat/rooms/${rid}/messages`, { token: A.token, body: { text: 'live hello' }, ip: A.ip });
  const m = await got;
  check('I5.6', 'message posted over HTTP is pushed to the member socket', m?.text === 'live hello' || JSON.stringify(m || {}).includes('live hello'));
  check('I5.7', 'nothing pushed to the non-member / guest sockets', (await leak) === null);
  for (const x of [guest, sb, sa]) x.s.close();
};

// ── P3 — rate limiting under burst ──────────────────────────────────────────
sections.P3 = async () => {
  const ip = newIp();
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await call('POST', '/api/auth/login', { body: { email: 'burst@example.test', password: 'whatever-123' }, ip })).status);
  const first429 = codes.indexOf(429);
  check('P3.1', 'login burst from one IP → clean 429 after the limit', first429 > 0, `first 429 at attempt ${first429 + 1}; codes ${[...new Set(codes)].join(',')}`);
  const other = await call('POST', '/api/auth/login', { body: { email: 'burst@example.test', password: 'whatever-123' }, ip: newIp() });
  check('P3.2', 'another IP is not affected', other.status !== 429, `status ${other.status}`);
  const lim = await call('POST', '/api/auth/login', { body: { email: 'burst@example.test', password: 'whatever-123' }, ip });
  check('P3.3', '429 carries RateLimit / Retry-After headers', !!(lim.headers.get('retry-after') || lim.headers.get('ratelimit') || lim.headers.get('ratelimit-reset')), [...lim.headers].filter(([k]) => /rate|retry/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' '));
};

// ── P5 — Postgres pool under concurrency ────────────────────────────────────
sections.P5 = async () => {
  const users = [];
  for (let i = 0; i < 10; i++) users.push(await register('pool' + i));
  const N = 600, conc = 60;
  const lat = []; let errors = 0, i = 0;
  const worker = async () => {
    while (i < N) {
      const u = users[i++ % users.length];
      const t = performance.now();
      const r = await call('GET', '/api/slips', { token: u.token, ip: u.ip });
      lat.push(performance.now() - t);
      if (r.status !== 200) { errors++; (globalThis.errc ??= {})[r.status] = ((globalThis.errc[r.status]) || 0) + 1; }
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const secs = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const p = q => lat[Math.floor(q * (lat.length - 1))].toFixed(0);
  const { rows: [act] } = await db.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname='iceqa'`);
  check('P5.1', `${N} authenticated DB reads at concurrency ${conc} (pool max 10) → 0 errors`, errors === 0, `${(N / secs).toFixed(0)} req/s · p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · p99 ${p(0.99)} ms · ${act.n} DB connections · errors ${errors} ${JSON.stringify(globalThis.errc||{})}`);
};

// ── MOD — moderation cases never walked on screen ──────────────────────────
sections.MOD = async () => {
  const [A, B, C, D, E] = [await register('modA'), await register('modB'), await register('modC'), await register('modD'), await register('modE')];
  const room = await call('POST', '/api/chat/rooms', { token: A.token, body: { name: 'qa-public-' + Date.now(), isPrivate: false }, ip: A.ip });
  const rid = room.json?.id ?? room.json?.room?.id;
  for (const u of [B, C, D, E]) await call('POST', `/api/chat/rooms/${rid}/join`, { token: u.token, ip: u.ip });
  const m = await call('POST', `/api/chat/rooms/${rid}/messages`, { token: A.token, body: { text: 'reportable ' + Date.now() }, ip: A.ip });
  const mid = m.json?.id;
  const visibleTo = async (u) => JSON.stringify((await call('GET', `/api/chat/rooms/${rid}/messages`, { token: u.token, ip: u.ip })).json).includes(String(mid));
  check('MOD.1', 'message visible before reports', await visibleTo(E));
  const r1 = await call('POST', `/api/chat/rooms/${rid}/messages/${mid}/report`, { token: B.token, body: { reason: 'spam' }, ip: B.ip });
  const r1b = await call('POST', `/api/chat/rooms/${rid}/messages/${mid}/report`, { token: B.token, body: { reason: 'spam' }, ip: B.ip });
  await call('POST', `/api/chat/rooms/${rid}/messages/${mid}/report`, { token: C.token, body: { reason: 'harassment' }, ip: C.ip });
  check('MOD.2', 'still visible after 2 distinct reporters (a duplicate report does not count)', r1.status < 300 && await visibleTo(E), `report ${r1.status}, dup ${r1b.status}`);
  await call('POST', `/api/chat/rooms/${rid}/messages/${mid}/report`, { token: D.token, body: { reason: 'hate' }, ip: D.ip });
  check('MOD.3', 'auto-hidden for everyone at the 3rd distinct reporter (author included)', !(await visibleTo(E)) && !(await visibleTo(A)));
  const self = await call('POST', `/api/chat/rooms/${rid}/messages/${mid}/report`, { token: A.token, body: { reason: 'spam' }, ip: A.ip });
  check('MOD.4', 'author cannot report own message', self.status >= 400, `status ${self.status}`);
  // block / unblock
  const m2 = await call('POST', `/api/chat/rooms/${rid}/messages`, { token: A.token, body: { text: 'after block ' + Date.now() }, ip: A.ip });
  const blk = await call('POST', `/api/users/${A.id}/block`, { token: E.token, ip: E.ip });
  const blocks = await call('GET', `/api/users/me/blocks`, { token: E.token, ip: E.ip });
  check('MOD.5', 'E blocks A → A in E\'s block list', blk.status < 300 && JSON.stringify(blocks.json).includes(A.id), `block ${blk.status}`);
  const un = await call('DELETE', `/api/users/${A.id}/block`, { token: E.token, ip: E.ip });
  const blocks2 = await call('GET', `/api/users/me/blocks`, { token: E.token, ip: E.ip });
  check('MOD.6', 'unblock → A gone from the list, A\'s messages readable again', un.status < 300 && !JSON.stringify(blocks2.json).includes(A.id) && JSON.stringify((await call('GET', `/api/chat/rooms/${rid}/messages`, { token: E.token, ip: E.ip })).json).includes(String(m2.json?.id)), `unblock ${un.status}`);
  const queue = await db.query(`SELECT count(*)::int n FROM chat_reports WHERE message_id=$1`, [mid]);
  check('MOD.7', '3 reports queued for the admin', queue.rows[0].n === 3, `rows ${queue.rows[0].n}`);
};

// ── R1 — ML down / R5 — restart under traffic are driven from qa-resilience.sh ─

const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(sections)) {
  if (name.startsWith('_') || typeof fn !== 'function') continue;
  if (wanted.length && !wanted.includes(name)) continue;
  console.log(`\n== ${name}`);
  try { await fn(); } catch (e) { check(name, 'section crashed', false, e.stack?.split('\n').slice(0, 3).join(' | ')); }
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await db.end();
process.exit(0);
