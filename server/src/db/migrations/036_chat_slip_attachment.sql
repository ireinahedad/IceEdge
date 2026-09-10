-- 036_chat_slip_attachment.sql
-- Partager un coupon dans une salle de chat, SANS toucher à la page joueur.
--
-- POURQUOI UNE COLONNE, ET PAS UNE LECTURE PAR ID
--
-- La demande : quelqu'un doit pouvoir montrer son coupon dans un salon sans que
-- ce coupon devienne pour autant consultable sur son profil. Les deux gestes
-- n'ont rien à voir :
--
--   * la page joueur, c'est un TIERS qui feuillette — d'où les trois filtres de
--     `getPublicSlips` : `show_slips` (le joueur peut se retirer),
--     `PUBLIC_SLIPS_SINCE` (rien d'antérieur à la mise en service) et
--     `locks_at` (les sélections restent cachées avant la mise au jeu) ;
--   * un partage en salon, c'est le PROPRIÉTAIRE qui montre, un coupon à la
--     fois, dans une salle qu'il a choisie.
--
-- Faire passer le second par une lecture de `bet_slips` obligerait à rouvrir une
-- surface de lecture pour des tiers, donc à rejouer ces trois filtres et à leur
-- ajouter une exception. C'est exactement le genre d'exception qui finit par
-- fuiter. On stocke donc l'INSTANTANÉ dans le message lui-même : le partage ne
-- lit jamais `show_slips`, ne l'écrit jamais, et n'ouvre aucune nouvelle route.
--
-- ⚠️ L'instantané est construit CÔTÉ SERVEUR à partir de `bet_slips`, à
-- l'insertion, à partir du seul `slipId` envoyé par le client — et la requête
-- filtre sur `user_id`. On ne peut donc partager que son propre coupon, et le
-- client ne peut pas fabriquer un « parlay à 96 % » de toutes pièces.
--
-- ⚠️ FIGÉ, volontairement : l'issue n'est pas relue après coup. Un coupon
-- partagé « en attente » restera « en attente » dans le fil. Le message est le
-- reflet de ce qui a été dit ce soir-là, pas une fenêtre vivante sur une ligne
-- de `bet_slips` — et c'est aussi ce qui garantit qu'aucun lecteur du salon
-- n'obtient jamais une lecture fraîche du coupon de quelqu'un d'autre.
--
-- Retour arrière : `ALTER TABLE chat_messages DROP COLUMN attachment;`. Les
-- messages restent, ils reperdent juste leur carte.
--
-- Safe to re-run.

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS attachment JSONB;

COMMENT ON COLUMN chat_messages.attachment IS
  'Instantané facultatif joint au message ({"kind":"slip",…}). Écrit par le serveur à l''insertion, jamais relu ni rafraîchi. NULL pour un message ordinaire.';
