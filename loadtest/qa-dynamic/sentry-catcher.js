// Minimal Sentry ingest stub for local QA: appends every envelope it receives to a file.
// Point the API at it with SENTRY_DSN=http://qapublickey@127.0.0.1:9999/1, then grep the
// log for secrets (a bearer token, an ice_refresh cookie) — there must be none.
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');

const LOG = process.env.SENTRY_STUB_LOG || '/tmp/sentry-envelopes.log';

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    try {
      if ((req.headers['content-encoding'] || '').includes('gzip')) body = zlib.gunzipSync(body);
    } catch { /* keep raw */ }
    fs.appendFileSync(LOG, `--- ${req.method} ${req.url}\n${body.toString()}\n`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(9999, '127.0.0.1', () => console.log(`[sentry-stub] :9999 → ${LOG}`));
