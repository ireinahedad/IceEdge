-- 030_slips_visible_by_default.sql
-- Coupons publics — la visibilité devient le défaut, le masquage devient un choix.
--
-- POURQUOI — `show_slips` était un opt-in à FALSE (migration 008). Un opt-in ne
-- se coche jamais : la fonctionnalité « voir les paris des autres » n'aurait eu
-- aucun contenu à montrer. À l'inverse, SUPPRIMER le choix n'est pas défendable —
-- un coupon est un renseignement personnel, et forcer sa publication sans porte
-- de sortie ne tient ni devant la Loi 25 ni devant les joueurs.
--
-- Inverser le défaut donne le même résultat pratique qu'une obligation, sans
-- l'exposition : les défauts gagnent, et qui veut se retirer le peut en un geste
-- (Paramètres → Confidentialité → « Masquer mes coupons aux autres joueurs »).
-- La colonne n'est donc PAS supprimée : elle porte désormais l'opt-out.
--
-- ⚠️ CE QUI REND L'`UPDATE` DE MASSE SÛR
--
-- Passer tout le monde à TRUE n'expose rien par soi-même. Deux verrous
-- indépendants restent fermés :
--
--   1. `PUBLIC_SLIPS_SINCE` (variable d'environnement) — tant qu'elle n'est pas
--      renseignée, `getPublicSlips` renvoie une liste vide à tout tiers, quel que
--      soit `show_slips`. C'est un échec fermé délibéré. Cette migration peut
--      donc être appliquée des semaines AVANT la mise en service.
--   2. Une fois la variable posée, seuls les coupons déposés APRÈS cette date
--      sont montrés. L'historique antérieur — saisi quand le produit promettait
--      l'inverse — reste privé de façon permanente.
--
-- C'est ce second verrou qui rend inutile une colonne `slips_optout_at` : il n'y
-- a rien de rétroactif à protéger. Quelqu'un qui avait désactivé l'ancien opt-in
-- se retrouve ici remis à TRUE, mais aucun de ses coupons passés ne devient
-- visible, et il dispose du nouveau réglage (et de l'avis qui l'accompagne) bien
-- avant que le moindre coupon futur ne le soit.
--
-- ORDRE D'ALLUMAGE — appliquer cette migration, PUIS renseigner
-- PUBLIC_SLIPS_SINCE. Le retour arrière est symétrique et immédiat : retirer la
-- variable referme tout, sans migration inverse ni redéploiement de schéma.

ALTER TABLE user_profiles
  ALTER COLUMN show_slips SET DEFAULT TRUE;

UPDATE user_profiles
   SET show_slips = TRUE
 WHERE show_slips = FALSE;

COMMENT ON COLUMN user_profiles.show_slips IS
  'Opt-OUT de la page joueur. TRUE = coupons consultables par les abonnés Pro (défaut). FALSE = le joueur s''est retiré. Sans effet tant que PUBLIC_SLIPS_SINCE n''est pas renseignée.';
