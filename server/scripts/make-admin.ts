/**
 * Grants admin role to a user by email.
 * Usage:  npx ts-node scripts/make-admin.ts your@email.com
 *
 * Run from server/ directory:
 *   cd server && npx ts-node -e "require('./scripts/make-admin')"
 * Or:
 *   cd server && npx ts-node scripts/make-admin.ts ireinahedad@icloud.com
 */

import { pool } from "../src/db/connection";

async function main() {
  const email = process.argv[2] || "ireinahedad@icloud.com";

  const { rowCount } = await pool.query(
    `UPDATE users SET role = 'admin' WHERE email = $1`,
    [email]
  );

  if ((rowCount ?? 0) === 0) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  console.log(`✅ ${email} is now admin`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
