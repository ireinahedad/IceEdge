-- 023_job_locks.sql
-- P1-4 — Unicité des jobs planifiés en multi-instance, et état partagé entre eux.
--
-- ── POURQUOI PAS pg_try_advisory_lock ──────────────────────────────────────
--
-- L'audit (ligne C) recommandait un verrou consultatif Postgres. C'est la bonne
-- réponse sur une connexion directe, mais PAS sur celle que ce projet doit
-- utiliser : `pg_try_advisory_lock` est un verrou de SESSION, et l'endpoint
-- Neon `-pooler` est un PgBouncer en mode *transaction*. Le backend serveur y
-- est réassigné après chaque transaction, donc un verrou de session posé par
-- une requête n'existe plus à la suivante. Neon le documente explicitement :
-- les verrous consultatifs de session ne sont pas supportés sur les connexions
-- poolées.
--
-- Le piège est qu'un tel verrou FONCTIONNERAIT en développement (Postgres local,
-- connexion directe) et échouerait silencieusement en production — le mode de
-- défaillance étant précisément celui qu'on cherchait à empêcher : des jobs qui
-- tournent en double. `pg_try_advisory_xact_lock` (transactionnel) survit au
-- pooler, mais impose de tenir une transaction ouverte pendant toute la durée du
-- job, ce qui monopolise un backend pendant plusieurs minutes.
--
-- ── LE BAIL ────────────────────────────────────────────────────────────────
--
-- Une ligne par job, avec un propriétaire et une date d'expiration. L'acquisition
-- tient en UN énoncé atomique (voir jobLock.ts) et ne dépend d'aucun mode de
-- pooling. Avantage secondaire : l'état est observable — `SELECT * FROM
-- job_locks` dit qui tient quoi et jusqu'à quand, ce qu'un verrou consultatif ne
-- montre qu'à travers pg_locks.
--
-- Contrepartie assumée : un verrou consultatif se libère tout seul quand la
-- session meurt, alors qu'un bail doit expirer. Un job tué net garde donc son
-- bail jusqu'à `expires_at`. D'où des TTL généreux (voir jobLock.ts), et le fait
-- que les jobs restent idempotents indépendamment du verrou — le règlement
-- filtre déjà sur `outcome = 'pending'`, le log des cotes dédoublonne par clé,
-- le nettoyage est un DELETE conditionnel. Le verrou évite le travail en double,
-- il n'est la seule ligne de défense de personne.
CREATE TABLE IF NOT EXISTS job_locks (
  job_name    TEXT        PRIMARY KEY,
  -- Identifiant de l'instance détentrice. Sert au relâchement : une instance ne
  -- peut libérer que SON bail. Sans ce contrôle, une instance dont le bail a
  -- expiré pendant un job trop long supprimerait en partant le bail que son
  -- remplaçante vient de prendre.
  owner       TEXT        NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- État partagé des jobs, en clé/valeur.
--
-- Motivation immédiate : `lastAlertKey` du scan de value bets vivait en mémoire
-- du process. Deux conséquences, toutes deux visibles par l'utilisateur final :
--   • après chaque redéploiement, la dernière alerte était renvoyée à tous les
--     abonnés — le compteur repartait de zéro ;
--   • en multi-instance, le verrou ci-dessus ne suffit PAS à empêcher les
--     doublons : deux instances qui scannent à 30 s d'écart prennent le bail
--     l'une après l'autre (il n'est tenu que pendant l'exécution) et poussent
--     la même alerte. Il faut que la mémoire du « déjà envoyé » soit commune.
CREATE TABLE IF NOT EXISTS job_state (
  key        TEXT        PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
