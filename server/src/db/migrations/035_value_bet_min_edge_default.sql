-- ============================================================
--  Migration 035 — Edge minimum par défaut des alertes value bet
-- ============================================================
-- Run with:
--   psql -h localhost -p 5432 -U postgres -d IceedgeDB -f src/db/migrations/035_value_bet_min_edge_default.sql
--
-- La colonne (migration 018) était à DEFAULT 0, c'est-à-dire « alerte-moi sur
-- n'importe quel edge positif ». Cette promesse n'a jamais été tenue : le scan
-- serveur (`valueBetScan.service.ts`) refuse déjà tout edge sous MIN_EDGE
-- (0,02), plancher tiré du backtest walk-forward où le ROI ne devient positif
-- que vers 2 %. Un compte à 0 recevait donc exactement les mêmes alertes qu'un
-- compte à 2 ; seul l'écran Réglages racontait autre chose.
--
-- On aligne donc le défaut sur le plancher réel du scan.
--
-- ⚠️ Le UPDATE ne retire aucune alerte à personne, précisément parce que 0 et 2
-- donnaient déjà le même résultat côté serveur. Il ne touche QUE les lignes
-- restées sur l'ancien défaut : un utilisateur qui a délibérément choisi 1, 3
-- ou 5 garde son réglage.

ALTER TABLE user_profiles
  ALTER COLUMN value_bet_min_ev_pct SET DEFAULT 2;

UPDATE user_profiles
   SET value_bet_min_ev_pct = 2
 WHERE value_bet_min_ev_pct = 0;
