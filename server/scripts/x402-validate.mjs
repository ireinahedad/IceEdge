#!/usr/bin/env node
/**
 * x402-validate.mjs — passe les routes payantes au validateur Coinbase
 * (X402_PLAN.md, phase 3). Sans dépendance, sans clé API.
 *
 *   node scripts/x402-validate.mjs                       # https://agents.arakice.com
 *   node scripts/x402-validate.mjs https://agents.arakice.com
 *
 * Fait, pour chaque route payante : POST https://api.cdp.coinbase.com/platform/v2/x402/validate
 * { resource, method }. Coinbase appelle la route, attend une 402 avec l'extension
 * Bazaar et simule son indexation. Code de sortie 0 seulement si `valid: true`
 * ET `simulation.outcome: "accepted"` pour toutes les routes.
 *
 * Ce que ça ne contrôle PAS (docs Coinbase) : la politique de contenu. Une route
 * validée peut quand même ne pas être listée. L'indexation réelle n'arrive
 * qu'après un premier paiement réglé par le facilitateur CDP (jusqu'à ~15 min) ;
 * lire alors l'en-tête EXTENSION-RESPONSES (bazaar.status = success | processing).
 *
 * `/v1/nhl/results` est gratuit (pas de 402) : il n'est pas validé ici.
 */

const VALIDATE_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/validate';
const base = (process.argv[2] || 'https://agents.arakice.com').replace(/\/$/, '');
const ROUTES = [{ path: '/v1/nhl/games', method: 'GET' }];

if (!base.startsWith('https://')) {
  console.error('Le validateur exige une URL https:// publique.');
  process.exit(2);
}

let allOk = true;
for (const r of ROUTES) {
  const resource = `${base}${r.path}`;
  let res; let body;
  try {
    res = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ resource, method: r.method }),
      signal: AbortSignal.timeout(60_000),
    });
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error(`✗ ${r.method} ${resource} — appel au validateur impossible : ${err.message}`);
    allOk = false;
    continue;
  }

  if (!res.ok || !body) {
    console.error(`✗ ${r.method} ${resource} — HTTP ${res.status}`, body ? JSON.stringify(body) : '');
    allOk = false;
    continue;
  }

  const outcome = body.simulation?.outcome;
  const ok = body.valid === true && outcome === 'accepted';
  allOk &&= ok;
  console.log(`${ok ? '✓' : '✗'} ${r.method} ${resource}`);
  console.log(`  valid=${body.valid}  statusCode=${body.statusCode}  x402Version=${body.x402Version}  simulation=${outcome}`
    + (body.simulation?.rejectionReason ? ` (${body.simulation.rejectionReason})` : ''));
  for (const c of body.preflight ?? []) {
    const mark = c.passed ? '  ✓' : (c.severity === 'required' ? '  ✗' : '  !');
    console.log(`${mark} [${c.severity}] ${c.check}: ${c.detail}`
      + (c.expected || c.actual ? ` (attendu ${c.expected ?? '?'}, reçu ${c.actual ?? '?'})` : ''));
  }
  const req = body.paymentRequirements;
  const accepts = Array.isArray(req?.accepts) ? req.accepts : (req ? [req] : []);
  for (const a of accepts) {
    if (a?.network) console.log(`  paiement : ${a.scheme ?? '?'} sur ${a.network}, payTo ${a.payTo ?? '?'}, montant ${a.amount ?? a.maxAmountRequired ?? '?'}`);
  }
  if (body.index) {
    console.log(`  index : active=${body.index.active}  lastCrawledAt=${body.index.lastCrawledAt ?? '—'}`
      + (body.index.quality ? `  30 j : ${body.index.quality.l30DaysTotalCalls} appels, ${body.index.quality.l30DaysUniquePayers} payeurs` : ''));
  }
}

console.log(allOk
  ? '\nTout est valide. Étape suivante : un vrai appel payé via le facilitateur CDP (X402_PLAN.md phase 3).'
  : '\nAu moins une route n\'est pas valide : corriger avant tout appel payé.');
process.exit(allOk ? 0 : 1);
