/**
 * pgUrl.ts — pin the meaning of `sslmode` in DATABASE_URL before pg v9 changes it.
 *
 * Today (pg 8 / pg-connection-string 2), `sslmode=prefer|require|verify-ca` in a
 * connection string are all treated as `verify-full`: the server certificate IS
 * checked. And they override the `ssl: { rejectUnauthorized: false }` object we
 * pass next to the URL (pg does `Object.assign(config, parse(url))`).
 *
 * pg v9 / pg-connection-string v3 switch those modes to libpq semantics, where
 * `require` means "encrypt but do not check the certificate". Neon's default URL
 * ends in `?sslmode=require`, so a routine `npm update` would silently turn off
 * certificate checking in production — no error, no log, nothing to notice.
 *
 * Rewriting the three aliases to `verify-full` keeps today's behaviour exactly,
 * keeps it after the upgrade, and silences pg's SECURITY WARNING at boot.
 * `uselibpqcompat=true` means someone opted into libpq semantics on purpose:
 * leave that URL alone. Anything that is not a parseable URL is returned as is.
 */
const ALIASES = new Set(['prefer', 'require', 'verify-ca']);

export function pinSslMode(url: string | undefined): string | undefined {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const mode = parsed.searchParams.get('sslmode');
  if (!mode || !ALIASES.has(mode)) return url;
  if (parsed.searchParams.get('uselibpqcompat') === 'true') return url;
  parsed.searchParams.set('sslmode', 'verify-full');
  return parsed.toString();
}
