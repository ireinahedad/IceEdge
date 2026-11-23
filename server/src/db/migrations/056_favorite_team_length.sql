-- 056_favorite_team_length.sql
-- POURQUOI (2026-11-22) : `favorite_team` était VARCHAR(5) (prévu pour une
-- abréviation « MTL »), mais l'écran Paramètres en fait un champ texte libre
-- (maxLength 20) et `profileUpdateSchema` accepte jusqu'à 40 caractères.
-- Taper « Canadiens » → erreur pg 22001 (value too long) → 500 sur
-- PATCH /api/users/me, et RIEN du profil n'est enregistré (nom, bio…).
-- On aligne la colonne sur la borne du schéma zod.
ALTER TABLE user_profiles ALTER COLUMN favorite_team TYPE VARCHAR(40);
