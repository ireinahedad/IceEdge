-- 025_pending_slips_index.sql
-- P1-8 (ligne H) — Index PARTIEL sur la file des tickets à régler.
--
-- Trois requêtes chaudes ne portent que sur `outcome = 'pending'` :
--
--   1. la pagination de `settlePendingSlips` :
--        WHERE outcome = 'pending' AND (placed_at, id) > ($1, $2)
--        ORDER BY placed_at ASC, id ASC LIMIT $3
--   2. la même, restreinte à un utilisateur (chemin interactif /api/slips/settle)
--   3. `pendingGameIds()`, qui déplie `legs` en JSONB toutes les 2 minutes quand
--      un match est en cours.
--
-- POURQUOI PARTIEL — les tickets réglés ne sont jamais relus par ces requêtes,
-- et ils représentent, passé quelques semaines, la quasi-totalité de la table.
-- Un index partiel ne contient que la file d'attente : quelques centaines de
-- lignes en régime établi, donc un index qui reste en cache mémoire quelle que
-- soit la taille de l'historique. Un index complet sur `placed_at` aurait, lui,
-- grossi indéfiniment pour un usage qui ne concerne jamais ses anciennes pages.
--
-- L'ordre des colonnes (placed_at, id) est exactement celui du `ORDER BY` et du
-- curseur : c'est ce qui permet à Postgres de reprendre la pagination sans trier
-- ni relire les lots déjà traités.
--
-- Note : pas de CREATE INDEX CONCURRENTLY — le runner exécute chaque migration
-- dans une transaction, ce que CONCURRENTLY interdit. Sur une table déjà
-- volumineuse en production, passer la variante CONCURRENTLY à la main.

CREATE INDEX IF NOT EXISTS idx_bet_slips_pending
  ON bet_slips (placed_at, id)
  WHERE outcome = 'pending';

CREATE INDEX IF NOT EXISTS idx_bet_slips_pending_user
  ON bet_slips (user_id, placed_at, id)
  WHERE outcome = 'pending';
