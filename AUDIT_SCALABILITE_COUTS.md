# ARAKICE / ICEEDGE — Audit de scalabilité & de coûts

**Dernière mise à jour :** 2026-10-07 · **Cible :** 500 → 5 000 utilisateurs simultanés, sans refonte ni infrastructure coûteuse.

> Ne contient que ce qui est **ouvert**. Historique complet (lignes livrées, tirs, variables) :
> `git show 8ec98f0:AUDIT_SCALABILITE_COUTS.md` · campagne de charge :
> `git show 0916b52:RAPPORT_TESTS_CHARGE_2026-09-18.md`.

## État

**Plus de code à écrire pour aller de 500 à 5 000 simultanés.** Les alertes de budget sont posées.
La campagne de charge (14 bancs, scénarios S1-S7, 27 ✓ / 1 ✗ puis B12 vert avec Redis) a tourné
sur le poste de développement, amont et Postgres simulés : elle prouve la mécanique (caches,
déduplication, bornes), **pas la capacité réelle de Railway et Neon**.

| Domaine | 500 | 5 000 | Reste |
|---|---|---|---|
| Vercel | 🟢 | 🟢 | Plan Pro (ligne 9) |
| Service ML | 🟢 | 🟠 | RAM (ligne U) |
| Neon | 🟢 | 🟠 | Scale-to-zero ou permanent (ligne 7 bis) |
| Railway / Node | 🟢 | 🟠 | 2ᵉ instance (lignes D, Q) |
| CDN | 🟢 | 🟢 | Cloudflare (ligne 11) |
| Tout le reste | 🟢 | 🟢 | — |

## Reporté au lancement officiel

| # | Action | Effort | Coût |
|---|---|---|---|
| ⏸ 9 | **Vercel Pro** — Hobby interdit l'usage commercial ; le risque de suspension commence **à la première vente** | 10 min | ~20 $/mois |
| ⏸ 11 | **Cloudflare devant Railway** — les `Cache-Control` sont posés, il manque le CDN ; réduit l'egress facturé | 1 h | 0 € |

## À déclencher sur seuil

| # | Action | Déclencheur | Effort | Coût |
|---|---|---|---|---|
| ☐ U | Vérifier la RAM du service ML dans Railway : 2 workers uvicorn (~300-500 Mo chacun) ne tiennent pas dans 512 Mo | **avant le premier pic réel** | 15 min | variable |
| ☐ D | Provisionner Redis, poser `REDIS_URL` (`DEPLOYMENT.md` § 2 ter), vérifier `SOCKET_ADAPTER` et `RATE_LIMIT_STORE` dans la bannière. Code livré, inerte sans la variable | avant la 2ᵉ instance | 15 min | 0-10 €/mois |
| ☐ Q | 2ᵉ instance Railway — sans sticky sessions, client en `transports: ['websocket']` ; prérequis : D | CPU > ~70 % en régime | 4 h | +5-20 €/mois |
| ☐ E | Migrer les avatars data-URI historiques vers R2 (le code est en place) | ~500 utilisateurs avec avatar | 2 h | 0 € |
| ☐ I | TanStack Query côté client — aucune déduplication, l'accueil relance ~7 appels | facture Railway visible | 2 j | 0 € |
| ☐ 7 bis | Décider : scale-to-zero Neon (readiness sans DB, probes espacées) ou compute permanent assumé | hors-saison NHL | 2 h | −10 à −50 €/mois |
| ☐ S | `fetchGamesRange` : clé de cache sur semaines calendaires | prolifération de clés dans `/api/dev/metrics` | 2 h | 0 € |
| ☐ T | Cache des prompts LLM identiques (TTL 1 h) — baisse le coût réel, pas la garantie du plafond | usage LLM significatif | 4 h | 0 € |
| ☐ V | Échantillonner les logs 2xx | première facture de logs | 1 h | 0 € |
| ☐ W | Purge Tailwind (CSS à 124 ko) | — | 2 h | 0 € |

## Non vérifié

1. **Configuration Railway réelle** (RAM/vCPU, replicas) — décide la ligne U.
2. **Neon sous charge réelle**, et autosuspend activé ou non — décide la ligne 7 bis.
3. **Métriques de production** de la saison en cours : un export Railway/Sentry de 7 jours remplacerait les estimations par des mesures. Prochaine étape utile.
4. **Usage réel du LLM** (OpenAI) par utilisateur — sans effet sur la facture grâce au plafond, décide la ligne T.
