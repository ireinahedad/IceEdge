-- 045_apple_iap.sql
-- Abonnement Pro acheté dans l'app iOS (StoreKit 2) — APPLE_PLAN Phase 5.
--
-- ── UN DROIT, DEUX RAILS DE PAIEMENT ───────────────────────────────────────
--
-- `subscriptions` reste la seule source de vérité : une ligne par compte. Elle
-- peut maintenant être alimentée par Stripe (web) OU par Apple (iPhone). Un
-- abonné web est Pro sur iPhone et inversement (Guideline 3.1.3(b), autorisé
-- parce que le même abonnement s'achète aussi dans l'app).
--
-- `source` dit QUI a donné le Pro actuel :
--   'stripe' : webhook Stripe ;
--   'apple'  : transaction StoreKit vérifiée ou notification App Store V2 ;
--   'local'  : essai gratuit web, code promo, activation dev.
-- Elle sert à une seule règle (`upsert` dans subscription.service) : une
-- RÉTROGRADATION ne s'applique que si elle vient du rail qui donne le Pro en
-- cours. Sans elle, l'expiration d'un vieil abonnement Stripe retirerait le
-- Pro de quelqu'un qui paie maintenant par Apple.
--
-- `apple_original_transaction_id` est UNIQUE : un abonnement Apple appartient
-- à un seul compte ArakIce. Le restaurer depuis un autre compte est refusé (409)
-- au lieu de « déplacer » le Pro en silence.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS source                        TEXT
    CHECK (source IN ('stripe', 'apple', 'local')),
  ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS apple_product_id              TEXT,
  ADD COLUMN IF NOT EXISTS apple_environment             TEXT
    CHECK (apple_environment IN ('Production', 'Sandbox', 'Xcode', 'LocalTesting'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_apple_otid
  ON subscriptions (apple_original_transaction_id)
  WHERE apple_original_transaction_id IS NOT NULL;

-- Lignes existantes : un ID d'abonnement Stripe = rail Stripe ; le reste est
-- local (essai, promo, dev). Idempotent : ne touche que les `source` vides.
UPDATE subscriptions SET source = 'stripe'
 WHERE source IS NULL AND stripe_subscription_id IS NOT NULL;
UPDATE subscriptions SET source = 'local'
 WHERE source IS NULL AND plan = 'pro';

-- Déduplication des notifications App Store Server V2, comme `stripe_events`
-- (migration 026) : Apple redélivre jusqu'à recevoir un 200.
CREATE TABLE IF NOT EXISTS apple_notifications (
  notification_uuid TEXT        PRIMARY KEY,
  notification_type TEXT        NOT NULL,
  subtype           TEXT,
  signed_date       TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apple_notifications_processed
  ON apple_notifications (processed_at);
