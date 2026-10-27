-- 051_slip_scan_daily.sql
-- Scans de ticket gratuits (SCAN_TICKET_PLAN § 9, D2).
--
-- Un compte GRATUIT a droit à SCAN_FREE_DAILY (3 par défaut) scans par jour UTC
-- (décision du user, 2026-10-27 : « 3 par jour »). Pro : illimité, rien n'est
-- compté ici. L'OCR tourne sur l'appareil : ce compteur n'achète aucun calcul,
-- il borne l'accès gratuit à une fonction Pro. Côté SERVEUR parce que le client
-- n'est pas une source de vérité.
--
-- Un scan est décompté quand l'ANALYSE démarre (« Ajouter au coupon »), pas à
-- l'import : une capture illisible ou abandonnée ne coûte rien.
--
-- Une ligne par (utilisateur, jour UTC), seulement les jours d'usage.
-- Purgée au-delà de 7 jours par `cleanup.service.ts`, comme `llm_free_daily`.
CREATE TABLE IF NOT EXISTS slip_scan_daily (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);
