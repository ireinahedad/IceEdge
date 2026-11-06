// node --test workers/predictions-cron/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { dispatch, WORKFLOW } from './src/index.js';

const env = { GITHUB_TOKEN: 'github_pat_test', GITHUB_OWNER: 'ireinahedad', GITHUB_REPO: 'IceEdge', GITHUB_REF: 'master' };

test('dispatch: POST workflow_dispatch au bon workflow, sur master, sans date', async () => {
  let seen;
  const r = await dispatch(env, async (url, init) => { seen = { url, init }; return new Response(null, { status: 204 }); });
  assert.deepEqual(r, { ok: true, status: 204, body: '' });
  assert.equal(seen.url, `https://api.github.com/repos/ireinahedad/IceEdge/actions/workflows/${WORKFLOW}/dispatches`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer github_pat_test');
  assert.deepEqual(JSON.parse(seen.init.body), { ref: 'master' });
});

test('dispatch: erreur GitHub, réseau ou config → ok false, sans lever', async () => {
  const r403 = await dispatch(env, async () => new Response('{"message":"Resource not accessible"}', { status: 403 }));
  assert.equal(r403.ok, false); assert.equal(r403.status, 403); assert.match(r403.body, /not accessible/);
  const net = await dispatch(env, async () => { throw new Error('boom'); });
  assert.deepEqual([net.ok, net.status, net.body], [false, 0, 'boom']);
  const cfg = await dispatch({ ...env, GITHUB_TOKEN: '' }, async () => assert.fail('pas d’appel sans jeton'));
  assert.equal(cfg.ok, false);
});

test('scheduled: un échec fait échouer l’exécution (visible chez Cloudflare)', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('nope', { status: 404 });
    await assert.rejects(worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 7, 15, 3) }, env, {}), /HTTP 404/);
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 7, 15, 3) }, env, {});
  } finally { globalThis.fetch = orig; }
});
