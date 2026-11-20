-- 055_growth_tracking.sql
-- Mesure de croissance : d'où viennent les comptes, qui revient, qui paie.
--
-- POURQUOI (2026-11-20, audit Growth). Trois questions n'avaient pas de réponse
-- en base :
--   1. D'où vient chaque compte ? La provenance « premier contact » vivait
--      seulement dans le localStorage du navigateur et dans Clarity (pas de SQL,
--      exports limités). `users.signup_*` la garde avec le compte.
--   2. Qui revient ? La seule trace d'activité était `refresh_tokens`, purgée
--      chaque jour par cleanup.service : l'historique de rétention se perdait.
--      `user_activity_days` = une ligne par compte et par jour actif. Petite
--      (≤ 365 lignes par compte et par an), jamais purgée.
--   3. Qui avance dans l'entonnoir ? `product_events` journalise les étapes
--      qui comptent pour l'argent : inscription, essai, passage au paiement,
--      abonnement, résiliation, courriels de fin d'essai, vues du paywall.
--
-- Les comptes ne sont pas tous réels : `account_kind` sépare
--   'real'      — un vrai visiteur ;
--   'internal'  — l'admin et les comptes de test de l'équipe ;
--   'synthetic' — les comptes communautaires générés (@members.arakice.app,
--                 créés à hh:14 avec des dates antidatées 2025-10 → 2026-02).
-- Sans ce tri, « 30 comptes » comptait 10 comptes générés et l'admin.
--
-- Vie privée : aucune donnée personnelle dans `props` (identifiants Stripe,
-- courriels, IP interdits). `product_events.user_id` passe à NULL quand le
-- compte est supprimé : on garde le compte agrégé, plus le lien à la personne.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_source   TEXT,
  ADD COLUMN IF NOT EXISTS signup_medium   TEXT,
  ADD COLUMN IF NOT EXISTS signup_campaign TEXT,
  ADD COLUMN IF NOT EXISTS signup_landing  TEXT,
  ADD COLUMN IF NOT EXISTS account_kind    TEXT NOT NULL DEFAULT 'real'
    CHECK (account_kind IN ('real', 'internal', 'synthetic'));

UPDATE users SET account_kind = 'synthetic'
 WHERE email LIKE '%@members.arakice.app' AND account_kind = 'real';
UPDATE users SET account_kind = 'internal'
 WHERE role = 'admin' AND account_kind = 'real';
-- Les autres comptes de l'équipe (mari, comptes de test) : à marquer à la main
--   UPDATE users SET account_kind = 'internal' WHERE email IN ('…', '…');

CREATE TABLE IF NOT EXISTS user_activity_days (
  user_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      DATE        NOT NULL,
  first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_activity_day ON user_activity_days (day);

CREATE TABLE IF NOT EXISTS product_events (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT        NOT NULL CHECK (name ~ '^[a-z0-9_]{2,60}$'),
  props      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_events_name_time ON product_events (name, created_at);
CREATE INDEX IF NOT EXISTS idx_product_events_user_time ON product_events (user_id, created_at);

-- ── Rattrapage : ce que la base sait déjà ────────────────────────────────────
-- Inscriptions (tous les comptes réels et internes).
INSERT INTO product_events (user_id, name, props, created_at)
SELECT u.id, 'signup', jsonb_build_object('method', CASE WHEN u.google_id IS NOT NULL THEN 'google' ELSE 'email' END, 'backfill', true), u.created_at
  FROM users u
 WHERE u.account_kind <> 'synthetic'
   AND NOT EXISTS (SELECT 1 FROM product_events e WHERE e.user_id = u.id AND e.name = 'signup');

-- Essais gratuits encore marqués « trialing » : début = fin − 7 jours.
INSERT INTO product_events (user_id, name, props, created_at)
SELECT s.user_id, 'trial_started', jsonb_build_object('backfill', true), s.current_period_end - INTERVAL '7 days'
  FROM subscriptions s
 WHERE s.status = 'trialing' AND s.source = 'local' AND s.current_period_end IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM product_events e WHERE e.user_id = s.user_id AND e.name = 'trial_started');

-- ── Vues de lecture (console Neon : SELECT * FROM growth_…) ─────────────────

-- Entonnoir hebdomadaire, comptes réels seulement.
CREATE OR REPLACE VIEW growth_funnel_weekly AS
WITH ev AS (
  SELECT date_trunc('week', e.created_at)::date AS week, e.name, e.user_id
    FROM product_events e
    JOIN users u ON u.id = e.user_id
   WHERE u.account_kind = 'real'
)
SELECT week,
       COUNT(DISTINCT user_id) FILTER (WHERE name = 'signup')               AS signups,
       COUNT(DISTINCT user_id) FILTER (WHERE name = 'trial_started')        AS trials,
       COUNT(DISTINCT user_id) FILTER (WHERE name = 'pro_page_view')        AS saw_pro_page,
       COUNT(DISTINCT user_id) FILTER (WHERE name = 'checkout_started')     AS checkouts,
       COUNT(DISTINCT user_id) FILTER (WHERE name = 'subscription_started') AS paid,
       COUNT(DISTINCT user_id) FILTER (WHERE name = 'subscription_canceled') AS canceled
  FROM ev
 GROUP BY week
 ORDER BY week DESC;

-- Rétention par cohorte d'inscription (semaine), en % de la cohorte active
-- la semaine N après l'inscription.
CREATE OR REPLACE VIEW growth_retention_weekly AS
WITH c AS (
  SELECT id AS user_id, date_trunc('week', created_at)::date AS cohort, created_at::date AS joined
    FROM users WHERE account_kind = 'real'
), a AS (
  -- Semaine N = jours 7N à 7N+6 après l'inscription (pas après le lundi).
  SELECT c.cohort, c.user_id,
         ((a.day - c.joined) / 7) AS week_n
    FROM c JOIN user_activity_days a ON a.user_id = c.user_id
)
SELECT c.cohort,
       COUNT(DISTINCT c.user_id) AS cohort_size,
       COUNT(DISTINCT a.user_id) FILTER (WHERE a.week_n = 1) AS w1,
       COUNT(DISTINCT a.user_id) FILTER (WHERE a.week_n = 2) AS w2,
       COUNT(DISTINCT a.user_id) FILTER (WHERE a.week_n = 4) AS w4
  FROM c LEFT JOIN a ON a.user_id = c.user_id
 GROUP BY c.cohort
 ORDER BY c.cohort DESC;

-- Abonnés payants réels, aujourd'hui (Stripe ou Apple, période en cours).
CREATE OR REPLACE VIEW growth_paying_now AS
SELECT s.source, COUNT(*) AS paying
  FROM subscriptions s
  JOIN users u ON u.id = s.user_id
 WHERE u.account_kind = 'real'
   AND s.source IN ('stripe', 'apple')
   AND s.status IN ('active', 'trialing')
   AND (s.current_period_end IS NULL OR s.current_period_end > NOW())
 GROUP BY s.source;

-- Provenance des comptes réels.
CREATE OR REPLACE VIEW growth_signups_by_source AS
SELECT COALESCE(signup_source, '(unknown)') AS source,
       COALESCE(signup_campaign, '')        AS campaign,
       COUNT(*)                             AS signups,
       MIN(created_at)::date                AS first_seen,
       MAX(created_at)::date                AS last_seen
  FROM users
 WHERE account_kind = 'real'
 GROUP BY 1, 2
 ORDER BY signups DESC;
