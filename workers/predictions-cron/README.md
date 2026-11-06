# predictions-cron (Cloudflare Worker)

Lance à l'heure le workflow GitHub `predictions-morning.yml` (« Bilan — probabilités du matin »),
à **15:03 et 16:03 UTC** chaque jour. Le cron de GitHub Actions a été retardé d'environ 6 h les 3
et 4 novembre 2026 ; un samedi, les matchs de l'après-midi seraient sortis du bilan public.

- Un seul appel : `POST /repos/ireinahedad/IceEdge/actions/workflows/predictions-morning.yml/dispatches`.
- Deux passages sans risque : le workflow ne fait rien si le fichier du jour existe déjà.
- Le cron GitHub du workflow reste en place, en secours.
- Aucune URL publique (`workers_dev = false`).

## Mise en place (une fois)

1. **Jeton GitHub** : github.com → Settings → Developer settings → Fine-grained tokens → Generate.
   - Repository access : *Only select repositories* → `IceEdge` seulement.
   - Permissions → Repository → **Actions : Read and write** (rien d'autre).
   - Expiration : la plus longue proposée ; noter la date de renouvellement dans `STATUS.md`.
2. Dans ce dossier (PowerShell) :
   ```powershell
   cd C:\Users\irein\dev\ICEEDGE\workers\predictions-cron
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN    # coller le jeton
   ```
3. **Essai** sans attendre 15:03 :
   ```powershell
   npx wrangler dev --test-scheduled
   # dans un second terminal :
   curl.exe "http://localhost:8787/__scheduled?cron=3+15+*+*+*"
   ```
   `wrangler dev` lit le secret dans un fichier `.dev.vars` (`GITHUB_TOKEN=...`), à ne jamais commiter.
   Ensuite : GitHub → Actions → « Bilan — probabilités du matin » doit montrer un passage
   `workflow_dispatch`. S'il trouve le fichier du jour déjà là, il s'arrête sans rien faire : c'est normal.

## Suivi

Cloudflare → Workers → `arakice-predictions-cron` → Logs / Cron events. Un appel refusé par GitHub
(jeton expiré, mauvaise permission) apparaît en échec avec le code HTTP.

## Tests

`node --test` (Node 20+, sans dépendance).
