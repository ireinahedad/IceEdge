import { fetchWithTimeout, RequestTimeoutError, isRequestTimeout, DEFAULT_TIMEOUT_MS } from './http.mjs';

let pass = 0, fail = 0;
const ok  = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

// Un `fetch` sous notre contrôle : il honore le signal qu'on lui passe.
function stubFetch({ delayMs = 0, reject = null } = {}) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    return new Promise((resolve, rej) => {
      const sig = init?.signal;
      const timer = setTimeout(() => {
        if (reject) rej(reject);
        else resolve({ ok: true, status: 200, url });
      }, delayMs);
      if (sig) {
        if (sig.aborted) { clearTimeout(timer); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        sig.addEventListener('abort', () => {
          clearTimeout(timer);
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }
    });
  };
  return { fn, calls };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\nhttp.ts — banc jetable\n');

// 1 — le défaut est bien 15 s
ok('DEFAULT_TIMEOUT_MS vaut 15 000', DEFAULT_TIMEOUT_MS === 15000);

// 2 — une requête qui ne répond jamais est abandonnée au délai
{
  const s = stubFetch({ delayMs: 60000 });
  globalThis.fetch = s.fn;
  const t0 = Date.now();
  let caught;
  try { await fetchWithTimeout('/lent', { timeoutMs: 60 }); } catch (e) { caught = e; }
  const dt = Date.now() - t0;
  ok('délai dépassé → RequestTimeoutError', caught instanceof RequestTimeoutError);
  ok('isRequestTimeout() le reconnaît', isRequestTimeout(caught));
  ok('l’erreur porte le budget (60 ms)', caught?.timeoutMs === 60);
  ok('abandonné AU délai, pas après (mesuré ' + dt + ' ms)', dt >= 50 && dt < 400);
  ok('le signal a bien été passé à fetch', !!s.calls[0].init.signal);
  ok('timeoutMs ne fuit PAS dans le RequestInit', !('timeoutMs' in s.calls[0].init));
}

// 3 — une requête rapide passe, et RIEN ne l’abandonne après coup
{
  const s = stubFetch({ delayMs: 10 });
  globalThis.fetch = s.fn;
  const res = await fetchWithTimeout('/rapide', { timeoutMs: 80 });
  ok('réponse rendue telle quelle', res.ok === true && res.status === 200);
  const sig = s.calls[0].init.signal;
  await sleep(150);                       // au-delà du budget
  ok('le minuteur est désarmé après succès', sig.aborted === false);
}

// 4 — l’abandon de l’APPELANT reste un abandon de l’appelant
{
  const s = stubFetch({ delayMs: 60000 });
  globalThis.fetch = s.fn;
  const ctrl = new AbortController();
  const p = fetchWithTimeout('/annule', { timeoutMs: 5000, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  let caught;
  try { await p; } catch (e) { caught = e; }
  ok('abandon appelant → PAS un RequestTimeoutError', !(caught instanceof RequestTimeoutError));
  ok('abandon appelant → AbortError', caught?.name === 'AbortError');
}

// 5 — un signal DÉJÀ abandonné n’envoie rien
{
  const s = stubFetch({ delayMs: 60000 });
  globalThis.fetch = s.fn;
  const ctrl = new AbortController();
  ctrl.abort();
  let caught;
  try { await fetchWithTimeout('/deja', { timeoutMs: 5000, signal: ctrl.signal }); } catch (e) { caught = e; }
  ok('signal déjà abandonné → rejet immédiat', caught?.name === 'AbortError');
}

// 6 — timeoutMs: 0 désarme le délai et relaie le signal de l’appelant
{
  const s = stubFetch({ delayMs: 10 });
  globalThis.fetch = s.fn;
  const ctrl = new AbortController();
  const res = await fetchWithTimeout('/sans-delai', { timeoutMs: 0, signal: ctrl.signal });
  ok('timeoutMs 0 → la requête passe', res.ok === true);
  ok('timeoutMs 0 → c’est le signal de l’appelant qui est passé', s.calls[0].init.signal === ctrl.signal);
}

// 7 — une vraie erreur réseau remonte INCHANGÉE
{
  const boom = new TypeError('Failed to fetch');
  const s = stubFetch({ delayMs: 5, reject: boom });
  globalThis.fetch = s.fn;
  let caught;
  try { await fetchWithTimeout('/reseau', { timeoutMs: 5000 }); } catch (e) { caught = e; }
  ok('erreur réseau non déguisée en délai', caught === boom);
}

// 8 — pas d’écouteur laissé sur le signal de l’appelant (fuite mémoire)
{
  const s = stubFetch({ delayMs: 5 });
  globalThis.fetch = s.fn;
  const ctrl = new AbortController();
  const added = [], removed = [];
  const origAdd = ctrl.signal.addEventListener.bind(ctrl.signal);
  const origRem = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = (t, f, o) => { added.push(f); return origAdd(t, f, o); };
  ctrl.signal.removeEventListener = (t, f, o) => { removed.push(f); return origRem(t, f, o); };
  await fetchWithTimeout('/propre', { timeoutMs: 500, signal: ctrl.signal });
  ok('l’écouteur d’abandon est retiré après la requête',
     added.length === 1 && removed.length === 1 && added[0] === removed[0]);
}

console.log(`\n${pass} assertions vertes, ${fail} rouges\n`);
process.exit(fail ? 1 : 0);
