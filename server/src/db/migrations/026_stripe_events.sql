-- 026_stripe_events.sql
-- P1-13 (ligne P) — Déduplication des événements Stripe et garde d'ordonnancement.
--
-- DEUX PROBLÈMES DISTINCTS, DEUX MÉCANISMES.
--
-- 1. REJEUX. Stripe redélivre un événement tant qu'il n'a pas reçu de 2xx dans
--    son délai, et redélivre aussi après une panne réseau côté Stripe. Le
--    traitement est déjà idempotent (l'UPSERT écrit le même état), mais chaque
--    rejeu refaisait le `stripe.subscriptions.retrieve` et l'écriture. Un
--    registre des identifiants d'événements déjà traités transforme un rejeu en
--    un SELECT et un 200 immédiat, ce qui est aussi ce qui empêche Stripe de
--    finir par désactiver l'endpoint pour lenteur répétée.
--
-- 2. ORDRE. Stripe ne garantit PAS l'ordre de livraison. Un
--    `customer.subscription.updated` ancien qui arrive après un plus récent
--    écrasait l'abonnement avec un état périmé — typiquement, une résiliation
--    livrée en retard qui annule une réactivation déjà enregistrée. Le symptôme
--    est un compte qui perd son accès sans raison visible, et il est
--    irreproductible en test.
--
--    D'où `subscriptions.last_event_at` : l'horodatage de l'événement Stripe qui
--    a produit l'état courant. Une écriture d'origine Stripe n'est appliquée que
--    si son événement est PLUS RÉCENT que celui déjà enregistré.
--
--    La colonne est distincte de `updated_at` volontairement. `updated_at` est
--    l'heure de NOTRE écriture ; il vaut « maintenant » aussi bien pour un
--    webhook que pour un essai gratuit ou un code promo. Comparer l'horodatage
--    d'un événement Stripe à `updated_at` bloquerait donc les écritures locales
--    (qui n'ont pas d'événement) ou les laisserait passer par erreur. Seules les
--    écritures issues de Stripe participent à l'ordonnancement ; `last_event_at`
--    reste NULL pour les autres, et un NULL ne bloque jamais rien.

CREATE TABLE IF NOT EXISTS stripe_events (
  id            TEXT        PRIMARY KEY,          -- evt_… : identifiant Stripe
  type          TEXT        NOT NULL,
  event_created TIMESTAMPTZ,                      -- horodatage porté par l'événement
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purge : ces lignes ne servent qu'à la fenêtre de rejeu de Stripe (quelques
-- jours). L'index rend le DELETE du job de nettoyage trivial.
CREATE INDEX IF NOT EXISTS idx_stripe_events_processed
  ON stripe_events (processed_at);

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;
