/**
 * moderation-dry-run.ts — R4.2a, le passage à blanc EXIGÉ par PRE_IOS_PLAN.md.
 *
 * Rejoue le filtre sur les messages DÉJÀ en base et montre ce qu'il aurait
 * bloqué, sans rien modifier. Aucune écriture, aucun DDL : `SELECT` seulement.
 *
 * Pourquoi c'est obligatoire et pas optionnel : le filtre est la seule partie de
 * R4 qui change un comportement existant. Le jargon hockey fait sauter les
 * listes naïves — « assist » contient « ass » — et un faux positif découvert
 * après activation, c'est un utilisateur qui n'arrive plus à écrire et qui
 * signale un bug. Les exceptions se remplissent AVANT, jamais après.
 *
 *   cd server && npx ts-node scripts/moderation-dry-run.ts
 *   cd server && npx ts-node scripts/moderation-dry-run.ts --tout
 *
 * Sans `--tout`, seuls les messages qui déclenchent sont affichés.
 * DATABASE_URL (et DB_SSL=true pour Neon) sont lus comme partout ailleurs.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { pinSslMode } from '../src/db/pgUrl';
import { inspect } from '../src/services/moderation.service';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[dry-run] DATABASE_URL n\'est pas défini');
  process.exit(1);
}

const pool = new Pool({
  connectionString: pinSslMode(url),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 15_000,
});

const montrerTout = process.argv.includes('--tout');

async function main(): Promise<void> {
  const { rows } = await pool.query<{ id: string; username: string | null; text: string; sent_at: Date }>(
    'SELECT id, username, text, sent_at FROM chat_messages ORDER BY sent_at ASC',
  );

  console.log(`\n[dry-run] ${rows.length} messages en base\n`);

  // Combien de fois chaque terme a déclenché : c'est ce classement qui dit quel
  // terme est un vrai problème et lequel n'est qu'un faux positif bruyant.
  const parTerme = new Map<string, number>();
  let bloques = 0;

  for (const r of rows) {
    const v = inspect(r.text ?? '');
    if (v.blocked) {
      bloques += 1;
      for (const t of v.matches) parTerme.set(t, (parTerme.get(t) ?? 0) + 1);
      const quand = r.sent_at?.toISOString().slice(0, 16).replace('T', ' ') ?? '?';
      console.log(`BLOQUÉ  [${quand}] ${r.username ?? '—'} : ${JSON.stringify(r.text)}`);
      console.log(`        → termes : ${v.matches.join(', ')}`);
    } else if (montrerTout) {
      console.log(`ok      ${JSON.stringify(r.text)}`);
    }
  }

  const pct = rows.length ? ((bloques / rows.length) * 100).toFixed(1) : '0.0';
  console.log(`\n[dry-run] ${bloques} / ${rows.length} messages bloqués (${pct} %)`);

  if (parTerme.size) {
    console.log('\n[dry-run] déclenchements par terme :');
    for (const [terme, n] of [...parTerme].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${terme}`);
    }
  }

  console.log(
    '\nRelire chaque ligne BLOQUÉ. Toute ligne qui est en réalité une conversation\n' +
    'normale est un faux positif : ajouter le mot à ALLOWED dans\n' +
    'src/services/moderation.service.ts, puis relancer, AVANT de brancher le\n' +
    'filtre sur l\'insertion (R4.2b).\n',
  );
}

main()
  .catch((err) => { console.error('[dry-run]', err); process.exitCode = 1; })
  .finally(() => pool.end());
