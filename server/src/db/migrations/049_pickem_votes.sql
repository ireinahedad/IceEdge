-- 049_pickem_votes.sql
-- F3, pick'em ICEEDGE (NEWS_CONSENSUS_PLAN.md, étape 5, session A).
--
-- Le remplaçant de #pickems (Hockey Chat) : les VRAIS utilisateurs ICEEDGE
-- votent pour une équipe, la page du match montre la répartition. Décision du
-- 2026-10-23 : pas de votes recopiés de Discord, pas de faux comptes.
--
-- ── RÈGLES ─────────────────────────────────────────────────────────────────
-- • Un vote par utilisateur et par match (clé primaire), modifiable jusqu'à la
--   mise au jeu PRÉVUE, refusé après — vérifié côté serveur (`pickem.service.ts`)
--   avec l'heure de l'API LNH, et fermé en cas de panne (voir le service).
-- • `game_start` : l'heure prévue au moment du vote. Sert au classement
--   hebdomadaire (session B, semaine lundi → dimanche, heure de l'Est) sans
--   relire l'API LNH pour chaque vote.
-- • `correct` : NULL tant que le match n'est pas réglé. Rempli en session B par
--   le job de règlement existant (`settlement.service.ts`) ; colonne posée dès
--   maintenant pour éviter une migration de plus.
-- • Compte supprimé → ses votes partent avec lui (CASCADE), comme ses coupons.
-- • Pas de clé étrangère vers `nhl_games` : la ligne du match n'y existe pas
--   forcément au moment du vote.

CREATE TABLE IF NOT EXISTS pickem_votes (
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id     TEXT         NOT NULL CHECK (game_id ~ '^[0-9]{6,12}$'),
  team_abbr   TEXT         NOT NULL CHECK (team_abbr ~ '^[A-Z]{2,4}$'),
  game_start  TIMESTAMPTZ  NOT NULL,
  correct     BOOLEAN,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, game_id)
);

-- Totaux d'un match (page du match).
CREATE INDEX IF NOT EXISTS pickem_votes_game_idx  ON pickem_votes (game_id, team_abbr);
-- Classement de la semaine (session B).
CREATE INDEX IF NOT EXISTS pickem_votes_start_idx ON pickem_votes (game_start);
