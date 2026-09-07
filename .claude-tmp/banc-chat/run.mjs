/**
 * Déroule les scénarios dans Chromium et imprime un verdict par assertion.
 *
 *   cd .claude-tmp/banc-chat && CLIENT=/tmp/cli PW=/tmp/mesure node build.mjs && node run.mjs
 *
 * PW = un dossier où `npm i playwright` a été fait. Le binaire Chromium est
 * déjà présent dans le conteneur cloud (/opt/pw-browsers/chromium) : ne PAS
 * lancer `playwright install`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const PW = process.env.PW ?? '/tmp/mesure';
const { chromium } = await import(join(PW, 'node_modules/playwright/index.mjs'));

const b = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium' });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('ERREUR PAGE:', e.message));
await p.goto('file://' + join(ICI, 'index.html'));

const etat = () => p.evaluate(() => JSON.parse(document.getElementById('etat').textContent));
const attendre = () => p.waitForTimeout(60);
const R = [];
const ok = (nom, cond, detail = '') => R.push({ nom, ok: !!cond, detail });

// 1. première connexion : pas de resynchro
await p.evaluate(() => window.__sockets[0].fire('connect'));
await attendre();
let e = await etat();
ok('1. 1re connexion → resyncKey reste 0', e.resyncKey === 0, 'resyncKey=' + e.resyncKey);
ok('1b. join_room émis', await p.evaluate(() => window.__sockets[0].emitted.some((x) => x[0] === 'join_room' && x[1] === 'salon-A')));

// 2. reconnexion → resynchro
await p.evaluate(() => { window.__sockets[0].fire('disconnect'); window.__sockets[0].fire('connect'); });
await attendre(); e = await etat();
ok('2. reconnexion → resyncKey = 1', e.resyncKey === 1, 'resyncKey=' + e.resyncKey);

// 3. retour au premier plan, socket morte
await p.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  window.__sockets[0].connected = false;
  document.dispatchEvent(new Event('visibilitychange'));
});
await attendre(); e = await etat();
const appels = await p.evaluate(() => window.__sockets[0].connectCalls);
ok('3. retour au 1er plan → resyncKey = 2', e.resyncKey === 2, 'resyncKey=' + e.resyncKey);
ok('3b. socket morte → connect() rappelé', appels === 1, 'connectCalls=' + appels);

// 3c. onglet caché → rien
await p.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await attendre(); e = await etat();
ok('3c. onglet caché → pas de resynchro', e.resyncKey === 2, 'resyncKey=' + e.resyncKey);

// 4. panne réseau → aucun refresh
await p.evaluate(() => window.__sockets[0].fire('connect_error', new Error('xhr poll error')));
await attendre();
let refresh = await p.evaluate(() => window.__refresh?.calls ?? 0);
ok('4. erreur réseau → aucun refresh', refresh === 0, 'calls=' + refresh);

// 5. jeton expiré → un refresh, puis reconnexion
await p.evaluate(() => window.__sockets[0].fire('connect_error', new Error('Invalid or expired token')));
await attendre();
refresh = await p.evaluate(() => window.__refresh.calls);
const c2 = await p.evaluate(() => window.__sockets[0].connectCalls);
e = await etat();
ok('5. jeton expiré → refresh appelé 1 fois', refresh === 1, 'calls=' + refresh);
ok('5b. refresh réussi → connect() relancé', c2 === 2, 'connectCalls=' + c2);
ok('5c. refresh réussi → pas de bandeau', e.authError === false);

// 6. second refus sans connect entre-temps
await p.evaluate(() => window.__sockets[0].fire('connect_error', new Error('Invalid or expired token')));
await attendre();
refresh = await p.evaluate(() => window.__refresh.calls);
e = await etat();
ok('6. 2e refus → PAS de 2e refresh', refresh === 1, 'calls=' + refresh);
ok('6b. 2e refus → authError levé', e.authError === true);

// 7. un connect réussi réarme le droit au refresh
await p.evaluate(() => window.__sockets[0].fire('connect'));
await p.evaluate(() => window.__sockets[0].fire('connect_error', new Error('Invalid or expired token')));
await attendre();
refresh = await p.evaluate(() => window.__refresh.calls);
e = await etat();
ok('7. connect réussi → refresh réarmé', refresh === 2, 'calls=' + refresh);
ok('7b. connect réussi → authError effacé', e.authError === false);

// 8. room_error
await p.evaluate(() => window.__sockets[0].fire('room_error', { roomId: 'salon-A', error: 'Access denied' }));
await attendre(); e = await etat();
ok('8. room_error remonté', e.roomError === 'Access denied', 'roomError=' + e.roomError);

// 9. fusion
await p.evaluate(() => {
  const h = window.__hook;
  h.initMessages([{ id: 'm1', sentAt: '2026-09-05T10:00:00Z', text: 'a' }]);
  h.appendOptimistic({ id: 'optimistic_9', sentAt: '2026-09-05T10:05:00Z', text: 'en vol' });
});
await attendre();
await p.evaluate(() => window.__hook.mergeMessages([
  { id: 'm0', sentAt: '2026-09-05T09:00:00Z', text: 'plus vieux' },
  { id: 'm1', sentAt: '2026-09-05T10:00:00Z', text: 'a' },
  { id: 'm2', sentAt: '2026-09-05T10:02:00Z', text: 'arrivé pendant l absence' },
]));
await attendre(); e = await etat();
ok('9. fusion garde optimiste + dédoublonne + trie',
   JSON.stringify(e.ids) === JSON.stringify(['m0', 'm1', 'm2', 'optimistic_9']), 'ids=' + JSON.stringify(e.ids));

// 10. changement de salon
await p.evaluate(() => window.__setRoom('salon-B'));
await attendre(); e = await etat();
ok('10. changement de salon → resyncKey remis à 0', e.resyncKey === 0, 'resyncKey=' + e.resyncKey);
const nb = await p.evaluate(() => window.__sockets.length);
ok('10b. un nouveau socket est créé', nb === 2, 'sockets=' + nb);
await p.evaluate(() => { window.__sockets[1].fire('connect'); window.__sockets[1].fire('disconnect'); window.__sockets[1].fire('connect'); });
await attendre(); e = await etat();
ok('10c. le compteur repart pour le nouveau salon', e.resyncKey === 1, 'resyncKey=' + e.resyncKey);

for (const r of R) console.log((r.ok ? 'VERT  ' : 'ROUGE ') + r.nom + (r.ok ? '' : '   << ' + r.detail));
console.log('\n' + R.filter((r) => r.ok).length + '/' + R.length + ' verts');
await b.close();
process.exit(R.every((r) => r.ok) ? 0 : 1);
