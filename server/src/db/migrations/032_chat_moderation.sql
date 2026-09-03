-- 032_chat_moderation.sql
-- R4.1 — signalement, blocage et masquage. Guideline 1.2 d'Apple exige quatre
-- choses pour du contenu généré par les utilisateurs ; le produit en a zéro.
--
-- Purement ADDITIF : deux tables neuves et deux colonnes nullables. Aucune
-- lecture existante ne change tant que le serveur (R4.2) ne les interroge pas,
-- donc appliquer cette migration seule ne peut rien casser en production.
--
-- ── Ce que la suppression d'un message emporte avec elle ────────────────────
-- `message_id` est en ON DELETE CASCADE : supprimer un message abusif supprime
-- aussi ses signalements. C'est un choix assumé (2026-09-03) — la file de
-- modération se vide d'elle-même quand on agit. Le prix à connaître : un
-- utilisateur signalé cinq fois dont tous les messages ont été supprimés
-- apparaîtra vierge, et il ne reste aucune trace de ce qui a été modéré. Le jour
-- où la détection de récidive devient nécessaire, il faudra une migration qui
-- rend `message_id` nullable en ON DELETE SET NULL et ajoute `reported_user_id`
-- plus un instantané du texte signalé.

CREATE TABLE IF NOT EXISTS chat_reports (
  id           SERIAL       PRIMARY KEY,
  message_id   VARCHAR(50)  NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  reporter_id  UUID         NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  reason       VARCHAR(30)  NOT NULL,
  note         TEXT,
  status       VARCHAR(20)  NOT NULL DEFAULT 'open',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reviewed_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  -- Un signalement par personne et par message. Cette contrainte EST la
  -- limitation de débit : `ON CONFLICT DO NOTHING` côté route, et personne ne
  -- peut gonfler le compteur de masquage automatique tout seul.
  UNIQUE (message_id, reporter_id),
  -- Les valeurs autorisées vivent aussi dans le schéma, pas seulement dans zod
  -- côté route. Une écriture faite depuis un script, une console ou une future
  -- route qui oublie la validation ne peut pas polluer la file. Ajouter un motif
  -- demandera une migration : c'est le prix, et ces listes sont dictées par
  -- Apple, donc elles bougent peu.
  CONSTRAINT chat_reports_reason_valid
    CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'other')),
  CONSTRAINT chat_reports_status_valid
    CHECK (status IN ('open', 'actioned', 'dismissed'))
);

-- La file de modération se lit « les ouverts, du plus récent au plus ancien ».
CREATE INDEX IF NOT EXISTS idx_chat_reports_open
  ON chat_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- ── Pourquoi l'index n'est pas celui que le plan annonçait ──────────────────
-- Le plan demandait `idx_user_blocks_blocker (blocker_id)`. Il serait REDONDANT :
-- la clé primaire (blocker_id, blocked_id) porte déjà blocker_id en tête de
-- colonne et sert donc exactement ces recherches, pour rien de plus au moment
-- des écritures.
--
-- Celui qui manque vraiment est sur `blocked_id`. Le masquage est SYMÉTRIQUE —
-- un blocage cache les messages dans les deux sens — donc la lecture cherche
-- « les lignes où je suis bloqueur OU bloqué », et la seconde moitié n'aurait
-- aucun index sans ceci.
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks (blocked_id);

-- Masquage porté par le message lui-même : trois rapporteurs distincts et il
-- disparaît des lectures (`hidden_reason = 'auto'`), sans attendre une revue
-- humaine. C'est la « réponse rapide » qu'Apple demande.
--
-- Nullable et sans valeur par défaut : les millions de lignes existantes ne sont
-- pas réécrites, l'ALTER est instantané (Postgres 11+ pour un défaut, et ici il
-- n'y en a même pas).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS hidden_at     TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS hidden_reason VARCHAR(30);
