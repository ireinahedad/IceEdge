/**
 * bench/harness.ts — démarre la VRAIE application Express en process, avec
 * l'amont et Postgres bouchonnés, et fournit un pilote HTTP.
 *
 * POURQUOI UN VRAI SERVEUR HTTP ET PAS UN APPEL DE FONCTION
 *
 * Le chemin qu'on veut mesurer passe par les middlewares : limiteur de débit,
 * en-têtes de cache, journalisation, gestion d'erreur. Un test qui appellerait
 * `getBestBets()` directement sauterait tout ça et raterait, par exemple, un
 * 429 qui rendrait le reste du run ininterprétable. Le banc écoute donc sur un
 * port éphémère et tire dessus avec le module `http` de Node.
 *
 * `http` et non `fetch` : `fetch` est bouchonné par `upstream.ts`, et le pilote
 * ne doit pas être compté comme un appel sortant.
 *
 * ORDRE D'IMPORT — NON NÉGOCIABLE. Les modules de l'application lisent leurs
 * variables d'environnement À L'IMPORT (`NHL_USE_MOCK`, `ODDS_API_KEY`,
 * `API_RATE_LIMIT`, `ML_DISABLED`…). `boot()` pose l'environnement, installe les
 * bouchons, PUIS importe l'app. C'est le piège documenté dans `loadtest/README.md`
 * §3.0, qui a coûté deux tirs complets en août 2026.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import * as upstream from './upstream';
import * as pgstub from './pgstub';

export interface BootOptions {
  /** Plafond du limiteur de débit. Relevé par défaut : sinon le banc mesure le
   *  limiteur et rend des latences faussement excellentes (README §2a). */
  rateLimit?: number;
  /** `true` pour couper le service ML et mesurer le seul chemin « règles ». */
  mlDisabled?: boolean;
  /** Latence simulée de la base, en ms par requête SQL. */
  sqlLatencyMs?: number;
  /**
   * Branche Socket.io sur le même serveur HTTP, comme le fait `server.ts`.
   *
   * Hors du défaut : `initSocket` installe des écouteurs et un adaptateur qui
   * n'ont rien à faire dans les bancs HTTP, et dont le compte de présence
   * programme des timers. Seul B11 en a besoin.
   */
  socket?: boolean;
}

export interface Booted {
  base: string;
  server: http.Server;
  metrics: typeof import('../../server/src/metrics');
  /** Le serveur Socket.io, si `boot({ socket: true })` l'a branché (B11). */
  io: import('socket.io').Server | null;
  close(): Promise<void>;
}

let booted: Booted | null = null;

export async function boot(opts: BootOptions = {}): Promise<Booted> {
  if (booted) return booted;

  // — 1. Environnement, avant tout import applicatif —
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET ||= 'bench-secret-not-for-production';
  process.env.EMAIL_VERIFICATION_DISABLED = 'true';
  process.env.LOG_LEVEL = 'silent';
  // Le limiteur est relevé À DESSEIN : on mesure l'application, pas le limiteur.
  process.env.API_RATE_LIMIT = String(opts.rateLimit ?? 1_000_000);
  // Une clé factice suffit : le bouchon intercepte l'appel. Sans clé, le proxy
  // odds répond `[]` sans rien appeler et le critère « ≤ 2 appels » serait
  // contourné, pas tenu — l'erreur exacte du tir du 2026-08-03.
  process.env.ODDS_API_KEY = 'bench-key';
  // Surtout PAS de mock NHL : on veut exercer le vrai client, son cache et sa
  // déduplication. Le mock court-circuite `fetchNHL` et ne mesure plus rien.
  delete process.env.NHL_USE_MOCK;
  if (opts.mlDisabled) process.env.ML_DISABLED = 'true';
  else delete process.env.ML_DISABLED;
  // Effets de bord qui sortent du serveur : coupés.
  process.env.PUSH_SCAN_ENABLED = 'false';
  process.env.ODDS_LOG_ENABLED = 'false';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  // Sans cette date, `publicSlipsSince()` rend `null` et les routes « coupons
  // d'autrui » court-circuitent en « échec fermé » — le banc mesurerait alors
  // un refus, pas la route. La valeur est arbitraire et locale ; en production
  // c'est une vraie décision de confidentialité (cf. `profile.service.ts`).
  process.env.PUBLIC_SLIPS_SINCE ||= '2024-01-01';

  // — 2. Bouchons —
  pgstub.setSqlLatency(opts.sqlLatencyMs ?? 1);
  await pgstub.prepare();
  pgstub.install();
  upstream.install();

  // — 3. L'application, importée seulement maintenant —
  const appModule = await import('../../server/src/app');
  const metrics = await import('../../server/src/metrics');
  const app = appModule.default;

  const server = http.createServer(app);

  let io: import('socket.io').Server | null = null;
  if (opts.socket) {
    // Exactement ce que fait `server.ts` : même fonction, même serveur HTTP.
    const { initSocket } = await import('../../server/src/socket');
    io = initSocket(server);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  booted = {
    base: `http://127.0.0.1:${port}`,
    server,
    metrics,
    io,
    async close() {
      if (io) await new Promise<void>((resolve) => io!.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      booted = null;
    },
  };
  return booted;
}

// ── Pilote HTTP ─────────────────────────────────────────────────────────────

export interface Reply { status: number; ms: number; body: string; bytes: number; cacheControl: string | null }

/**
 * `discardBody` — ne conserve pas le corps de la réponse, seulement sa taille.
 *
 * Ça n'est pas une micro-optimisation : un banc de charge garde des dizaines de
 * milliers de réponses, et `best-bets` en rend plusieurs kilo-octets. Les
 * conserver gonfle le RSS du PROCESSUS DE MESURE, qui est le même que celui de
 * l'application ici — on lirait alors la mémoire du banc en croyant lire celle
 * du serveur. Les bancs qui tirent longtemps passent donc `discardBody: true`.
 */
export function request(
  base: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; discardBody?: boolean } = {},
): Promise<Reply> {
  const url = new URL(base + path);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init.method ?? 'GET',
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(init.body) } : {}),
          ...(init.headers ?? {}),
        },
      },
      (res) => {
        let data = '';
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (!init.discardBody) data += c;
        });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          ms: Date.now() - started,
          body: data,
          bytes,
          cacheControl: (res.headers['cache-control'] as string) ?? null,
        }));
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** N requêtes lancées au MÊME instant : le pire cas, celui d'un redéploiement. */
export async function burst(n: number, fn: (i: number) => Promise<Reply>): Promise<Reply[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

/** `vus` utilisateurs virtuels qui bouclent pendant `durationMs`, chacun avec
 *  une pause entre deux itérations — un trafic, pas une rafale. */
export async function sustain(
  vus: number,
  durationMs: number,
  iteration: (vu: number) => Promise<Reply[]>,
  thinkMs = 200,
): Promise<{ replies: Reply[]; iterations: number }> {
  const until = Date.now() + durationMs;
  const replies: Reply[] = [];
  let iterations = 0;

  await Promise.all(Array.from({ length: vus }, async (_, vu) => {
    // Départs échelonnés : sans ça, `vus` requêtes tombent à la microseconde
    // près et on mesure une rafale, pas une charge tenue.
    await sleep((vu / vus) * Math.min(thinkMs, 400));
    while (Date.now() < until) {
      const out = await iteration(vu);
      replies.push(...out);
      iterations += 1;
      await sleep(thinkMs);
    }
  }));

  return { replies, iterations };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Statistiques ────────────────────────────────────────────────────────────

export function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function summarise(replies: Reply[]) {
  const ms = replies.map((r) => r.ms);
  const bad = replies.filter((r) => r.status >= 400);
  return {
    n: replies.length,
    errors: bad.length,
    errorRate: replies.length ? bad.length / replies.length : 0,
    rateLimited: replies.filter((r) => r.status === 429).length,
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    max: ms.length ? Math.max(...ms) : 0,
  };
}

/** Un jeton d'accès pour le compte de banc, obtenu par la vraie route de login. */
export async function loginToken(base: string): Promise<string> {
  const r = await request(base, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: pgstub.BENCH_USER.email, password: pgstub.BENCH_USER.password }),
  });
  if (r.status !== 200) throw new Error(`login ${r.status}: ${r.body.slice(0, 200)}`);
  const parsed = JSON.parse(r.body);
  return parsed.tokens?.access_token ?? parsed.accessToken ?? parsed.access_token;
}
