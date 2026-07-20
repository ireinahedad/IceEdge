# Secret Rotation & Hygiene

The database password was previously committed in plaintext inside `PROJECT_CONTEXT.md`. It has been scrubbed from the current file, **but it still exists in git history** and must be treated as compromised. This document is the checklist for rotating it (and every other secret) and preventing recurrence.

## 1. Rotate everything that was ever committed or shared

Treat any secret that appeared in the repo, a chat, or a screenshot as burned. Rotate:

| Secret | Where to rotate | Then update |
|---|---|---|
| **Postgres password** (`mike1970`) | Your DB provider (Supabase/Railway) → reset password | `DATABASE_URL` / `DB_PASSWORD` in `server/.env` and the host's env |
| `JWT_SECRET` | Generate new: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` | `server/.env` (note: rotating invalidates all existing access tokens — users re-login) |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → Credentials → reset | `server/.env` |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → API keys / Webhooks | `server/.env` |
| `GITHUB_MODELS_TOKEN` | GitHub → Settings → Developer settings → PATs | `server/.env` |
| `RESEND_API_KEY` | Resend dashboard | `server/.env` |
| `ODDS_API_KEY`, `RAPIDAPI_KEY` | Respective provider dashboards | `server/.env` |
| `VAPID_*` | Regenerate: `npx web-push generate-vapid-keys` (note: invalidates existing push subs) | `server/.env` + client public key |

## 2. Generate the new at-rest encryption key (new requirement)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set it as `ENCRYPTION_KEY` in `server/.env` (and the host's env), then encrypt any existing plaintext OpenAI keys:

```bash
cd server && npm run db:encrypt-keys
```

> ⚠️ Once secrets are stored with a given `ENCRYPTION_KEY`, changing that key makes them undecryptable. To rotate it you must decrypt-with-old then re-encrypt-with-new. Store it in your host's secret manager, not just `.env`.

## 3. Purge the old secret from git history

Scrubbing the file only removes it from the current commit. To remove it from history (recommended, since the repo may be shared or pushed):

```bash
# Option A — git filter-repo (recommended)
pip install git-filter-repo
git filter-repo --replace-text <(echo 'mike1970==>REDACTED')

# Option B — BFG Repo-Cleaner
bfg --replace-text replacements.txt   # replacements.txt: mike1970==>REDACTED
```

After rewriting history you must **force-push** and have every collaborator re-clone. (This is why rotation in step 1 matters more than the purge — assume the old value is already exposed.)

## 4. Prevent recurrence

- `.env` and `.env.*` are already git-ignored (`server/.gitignore`, `client/.gitignore`); `.env.example` files carry only placeholders. ✅
- Never paste real connection strings into `*.md` docs — use `<DB_PASSWORD>` placeholders.
- Add a pre-commit secret scanner (e.g. `gitleaks`) to CI so a committed secret fails the build.
- Store production secrets in the host's secret manager (Railway/Render/Vercel env), not in a file on disk.

## 5. Verify

- [ ] App boots with the new `DATABASE_URL`.
- [ ] Login works after `JWT_SECRET` rotation (users are logged out once — expected).
- [ ] `npm run db:encrypt-keys` reports rows encrypted; LLM (free tier) still works.
- [ ] `git log -p -S mike1970` returns nothing after history purge.
