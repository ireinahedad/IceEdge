-- 029_slip_locks_at.sql
-- Coupons publics — heure de verrouillage d'un coupon.
--
-- POURQUOI — Les coupons d'un joueur deviennent consultables par les abonnés
-- Pro, mais leurs SÉLECTIONS doivent rester masquées tant que le match n'a pas
-- commencé. Sans ça, on offre du copiage en temps réel, et les joueurs
-- cesseront simplement de saisir leurs coupons — ce qui viderait le feature de
-- sa substance.
--
-- L'heure de mise au jeu n'existait nulle part en base : les `legs` portent un
-- `gameId`, jamais de `startTimeUTC`. Décider du masquage à la lecture aurait
-- imposé un appel à l'API NHL à chaque affichage de page. La valeur est donc
-- figée UNE fois, à la soumission, à partir du match le plus TÔT du coupon :
-- un parlay se déverrouille quand son premier match commence, pas quand le
-- dernier se termine.
--
-- NULL est volontairement autorisé — et n'est pas un « pas de verrou » :
--   * coupons antérieurs à cette migration ;
--   * `gameId` absent (paris futures / saison) ou API NHL indisponible.
-- Le service traite NULL comme « masqué tant que le coupon est pending ». Une
-- panne de résolution d'horaire doit produire un coupon trop discret, jamais un
-- coupon divulgué trop tôt : l'erreur inverse est irréversible.
--
-- Pas d'index : `locks_at` n'est jamais un prédicat de recherche, seulement une
-- comparaison sur des lignes déjà filtrées par `user_id`.

ALTER TABLE bet_slips
  ADD COLUMN IF NOT EXISTS locks_at TIMESTAMPTZ;

COMMENT ON COLUMN bet_slips.locks_at IS
  'Mise au jeu du match le plus tôt du coupon. Avant cette heure, les legs ne sont pas exposés aux tiers. NULL = inconnu → masqué tant que pending.';
