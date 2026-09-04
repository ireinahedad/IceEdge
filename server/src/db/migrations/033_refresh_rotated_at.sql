-- 033_refresh_rotated_at.sql
-- R3bis.2 — rendre la rotation d'un refresh token ATOMIQUE, sans déconnecter
-- l'onglet perdant.
--
-- Le problème : `refreshTokens()` faisait un SELECT puis un UPDATE séparés. Deux
-- appels concurrents lisaient tous les deux `revoked = FALSE` avant que le
-- moindre UPDATE ne soit validé, donc TOUS réussissaient : un refresh token en
-- engendrait plusieurs, chacun valide 7 à 30 jours, orphelins mais vivants.
--
-- La correction est un seul énoncé, `UPDATE … WHERE revoked = FALSE RETURNING *`,
-- qui ne peut désigner qu'un gagnant. Mais rendre la rotation atomique SANS
-- filet renverrait un 401 au perdant, et côté client un 401 sur /auth/refresh
-- vide le stockage : deux onglets ouverts se déconnecteraient à chaque
-- rafraîchissement silencieux. C'est précisément le piège documenté dans
-- PRE_IOS_PLAN.md, et la raison pour laquelle cet item était resté ouvert.
--
-- D'où cette colonne : elle date la rotation, ce que `revoked` seul ne dit pas.
-- Pendant quelques secondes après une rotation légitime, un jeton déjà tourné
-- est encore reconnu et le serveur rend une paire valide au lieu d'un 401.
-- Au-delà de la fenêtre, il est mort comme avant.
--
-- Purement ADDITIF : une colonne nullable, aucune lecture existante ne change.
-- Les jetons déjà révoqués gardent `rotated_at IS NULL`, donc ils restent hors
-- de la fenêtre de grâce — un jeton révoqué par une déconnexion ne doit jamais
-- redevenir utilisable, et c'est exactement ce que ce NULL garantit.

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

-- La fenêtre de grâce interroge « ce jeton précis, tourné récemment ? ». La
-- contrainte UNIQUE sur `token` sert déjà cette recherche ; aucun index de plus.
