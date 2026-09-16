# Monitoring & Alerting (H2)

Goal: find out the app is down from a monitor, not from a user. Two layers —
uptime checks on the health endpoints, and error alerts from Sentry.

## Endpoints

The API exposes two health routes (see `server/src/app.ts`):

- `GET /health` — **liveness**. Returns `200 {"status":"ok"}` with no
  dependencies. Use this for the orchestrator's restart probe.
- `GET /health/ready` — **readiness**. Returns
  `200 {"status":"ok","checks":{"db":"ok"},"cached":false}` when Postgres is
  reachable, or `503 {"status":"unavailable","checks":{"db":"down"}}` when it
  isn't. Use this for uptime monitoring and the load balancer's routing probe.
  A successful `SELECT 1` is cached for `READINESS_DB_TTL_MS` (10 min by
  default); `"cached":true` means the answer came from that cache rather than a
  fresh round-trip. Failures are never cached, so an outage and a recovery are
  both seen at the real probe cadence.

The Python ML service exposes `GET /health`.

## Uptime monitoring (UptimeRobot or Better Stack)

Create HTTP(S) monitors, **5 min interval** (not 1 min — see the note on Neon
below):

1. **API readiness** — `https://<backend>/health/ready`, expect HTTP `200`.
   This is the important one: it goes red if the DB is down even while the
   process is up.
2. **API liveness** — `https://<backend>/health`, expect `200`. Distinguishes
   "process dead" from "DB down".
3. **ML service** — `https://<ml>/health`, expect `200`.
4. **Frontend** — `https://<vercel-domain>/`, expect `200`.

Set alert contacts (email/SMS/Slack) on each monitor. In Better Stack you can
assert on the response body (`"db":"ok"`) for a stricter readiness check.

## Sentry alerts

Sentry is already wired (`server/src/instrument.ts`, activated when
`SENTRY_DSN` is set). Add alert rules in the Sentry project:

- Notify on a **new** issue (first occurrence of an unseen error).
- Notify when an issue's **event rate spikes** (e.g. > N events / minute).
- Route to the same Slack/email channel as the uptime alerts.

## Alertes de budget (audit de scalabilité, ligne 12)

Les alertes ci-dessus disent que l'application est **cassée**. Celles-ci disent
qu'elle est **chère** — un mode de défaillance beaucoup plus discret, parce que
rien ne se dégrade : ça marche, et la facture arrive à la fin du mois.

Chaque seuil est posé à **~50 % du plafond acceptable**, pas à 90 %. Une alerte à
90 % arrive quand il est trop tard pour faire autre chose que payer ; à 50 % il
reste le temps de comprendre d'où vient la consommation.

| Fournisseur | Où | Seuil à poser | Ce que le dépassement signifie |
|---|---|---|---|
| **Railway** | Account → Usage → *Usage Limits* : email à un montant, et un *hard limit* au-dessus | alerte à **2× la facture d'un mois calme**, hard limit à 4× | Soit le trafic a réellement doublé, soit une boucle tourne (job sans verrou, redémarrages en boucle). Le hard limit est le seul garde-fou dur de toute la stack : à privilégier, quitte à couper |
| **Neon** | Organization → Billing → *Spending notifications*. **Il n'y a pas de quota de plan sur Launch** — l'ancienne consigne « Usage quotas, 50 % des CU-heures » visait le plan gratuit, que ce projet n'utilise pas | alerte en **dollars**, pas en CU-heures — **armée à 6 $ le 2026-08-29** (Neon prévient à 80 % puis 100 % du seuil) | **Neon n'a aucun plafond dur** : le dépassement ne coupe rien, il facture (0,106 $/CU-h, 0,35 $/Go-mois). Compute qui monte = la base ne dort pas (ligne 7 bis de l'audit) ; stockage qui monte = les data-URI d'avatars restées en base (ligne E). ⚠️ Le rythme normal **en saison** vaut déjà ≈ 6,5 $/mois : ce seuil sonnera de lui-même — le relever d'un cran une fois la consommation réelle mesurée, sinon il devient du bruit |
| **The Odds API** | pas d'alerte fournisseur — surveiller `x-requests-remaining`, déjà journalisé par `odds.routes.ts` | avertir sous **20 % du quota mensuel** | Le cache de 5 min a sauté, ou un tir de charge a été lancé contre la production. Sans cache, le coût est linéaire au nombre de visiteurs |
| **Provider LLM** (OpenAI / GitHub Models) | console du provider → *Usage limits* : soft à l'email, **hard limit mensuel** | hard limit = **part IA prévue × nombre d'abonnés + 30 %** | Le plafond par utilisateur (`llmQuota.service.ts`) rend ce dépassement théoriquement impossible : s'il se déclenche, c'est que le calcul du plafond a été contourné ou qu'un tarif a changé. À traiter comme un incident, pas comme une croissance |
| **Stripe** | Developers → Webhooks : alerte sur le **taux d'échec** de l'endpoint | > 1 % d'échecs sur 24 h | Stripe désactive un endpoint qui échoue de façon répétée, et un endpoint désactivé = des abonnés qui paient sans passer Pro. C'est la seule ligne de ce tableau où l'alerte protège une recette, pas une dépense |
| **Sentry** | Settings → Subscription → *Spend caps* | cap à **1× le quota inclus** (pas de dépassement facturé) | Le tracing de performance est échantillonné à 1 % en production par défaut (`instrument.ts`). Si le quota saute quand même, quelqu'un a posé `SENTRY_TRACES_SAMPLE_RATE` à la main et ne l'a pas retiré |
| **Cloudflare R2** | Dashboard → R2 → Usage · **alerte posée le 2026-09-16** : « Billing Budget Alert », 5 $ de dépense totale, sur le compte d'origine (`2216e2d9…`) | alerte à **5 Go** (sur 10 Go gratuits) — la console ne sait l'exprimer qu'en dollars | Les avatars ne sont pas redimensionnés, ou rien ne supprime les anciens objets à chaque changement d'avatar |

**Deux règles pour que ces alertes servent à quelque chose :**

1. **Les router au même endroit que les alertes d'incident.** Une alerte de coût
   envoyée sur une adresse qu'on ne lit pas est un accusé de réception, pas une
   alerte.
2. **Poser les hard limits là où ils existent** (Railway, provider LLM, Sentry).
   **Neon et R2 n'en offrent pas** : leurs alertes restent des e-mails, et rien
   ne s'y coupe tout seul. Ce sont les deux lignes à relire à la main.
   Une alerte suppose que quelqu'un lise et agisse dans l'heure ; un plafond dur
   agit tout seul. Pour un projet à une personne, c'est la différence entre une
   mauvaise surprise et une facture qui ne peut pas arriver.

Contexte chiffré et raisonnement complet : `AUDIT_SCALABILITE_COUTS.md`.

## Notes

- Health probes are excluded from request logging (see `logger.ts`) so they
  don't flood logs.
- **Probe interval vs. Neon scale-to-zero.** Neon suspends the compute after
  5 min of inactivity. This project is on the **Launch** plan, which includes no
  compute allowance and bills **$0.106/CU-hour with no hard cap** — so an
  uncached `SELECT 1` every 1–5 min would *not* suspend the database the way the
  free plan would: it would keep it awake 24/7 at roughly **$19/month**,
  indefinitely and silently. Hence
  `/health/ready` caches successful checks for `READINESS_DB_TTL_MS` (10 min).
  Keep the monitor at 5 min: it detects a dead process or a dead HTTP surface
  immediately, and a DB outage within at most 10 min. Real user traffic fails
  instantly and surfaces through Sentry, so the cache does not hide a
  user-visible outage. See `DEPLOYMENT.md` § "Budget compute".
