-- Migration 017: Add rule_weights (JSONB) to user_profiles
-- Stocke la pondération des facteurs des règles hockey, par utilisateur.
-- NULL = l'utilisateur utilise les poids par défaut.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS rule_weights JSONB;
