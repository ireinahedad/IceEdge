-- 043_apns_device_tokens.sql
-- Jetons APNs des iPhone — APPLE_PLAN 4.1 (notifications push natives).
--
-- ── POURQUOI UNE TABLE À PART (2026-10-10) ─────────────────────────────────
--
-- `push_subscriptions` décrit un abonnement Web Push (endpoint + clés VAPID).
-- Un iPhone, lui, n'a qu'un jeton d'appareil opaque délivré par Apple : rien à
-- mettre dans `p256dh` / `auth`. Deux canaux, deux tables ; `push.service`
-- lit les deux au moment d'envoyer.
--
-- ── CE QU'UNE LIGNE EST ────────────────────────────────────────────────────
--
-- Un appareil. Le jeton est UNIQUE : si un autre compte se connecte sur le même
-- iPhone, la ligne change de propriétaire (`ON CONFLICT (token) DO UPDATE`) —
-- sinon le premier compte recevrait les notifications du second.
-- `lang` est la langue de l'app au moment de l'enregistrement, pour écrire la
-- notification dans la langue que la personne lit.
-- La suppression du compte efface ses appareils (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS apns_device_tokens (
  token       TEXT        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lang        VARCHAR(2)  NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr', 'en')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apns_tokens_user ON apns_device_tokens (user_id);
