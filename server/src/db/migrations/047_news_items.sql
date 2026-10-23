-- 047_news_items.sql
-- Fil de nouvelles par match (NEWS_CONSENSUS_PLAN.md, F1).
--
-- ── POURQUOI (2026-10-23) ───────────────────────────────────────────────────
--
-- Les absents annoncés quelques heures avant le match (ex. « Marner ne jouera
-- pas ce soir », publié 32 min avant VGK@STL) n'arrivent dans l'API LNH qu'à
-- T−30 min, et le gardien partant n'y arrive jamais. Les journalistes et les
-- équipes, eux, le publient avant. Cette table garde ces publications :
--   • `bluesky` — lues par `newsSync.service.ts` (API publique, sans clé) ;
--   • `manual`  — un lien (X, Bluesky…) collé par un admin dans /dev/saisie.
--
-- ── RÈGLES ─────────────────────────────────────────────────────────────────
--
-- • On garde le LIEN, l'auteur, l'heure et un extrait court (≤ 200 car.) :
--   l'app renvoie toujours vers la publication d'origine.
-- • `team_abbrs` : une publication peut toucher deux équipes (un échange) ;
--   vide = nouvelle de ligue sans équipe reconnue.
-- • `flags` : 'goalie' | 'lineup' | 'transaction' — détectés par mots-clés
--   (`newsFeed.ts`). Ils servent à l'alerte admin, pas au modèle.
-- • Dédoublonnage par (source, external_id) : l'URI Bluesky, ou l'URL collée.
--
-- Purge : > 14 jours, par le job lui-même (une fois par jour).

CREATE TABLE IF NOT EXISTS news_items (
  id           BIGSERIAL    PRIMARY KEY,
  source       TEXT         NOT NULL CHECK (source IN ('bluesky', 'manual')),
  external_id  TEXT         NOT NULL,
  team_abbrs   TEXT[]       NOT NULL DEFAULT '{}',
  author       TEXT         NOT NULL,
  url          TEXT         NOT NULL,
  excerpt      TEXT         NOT NULL DEFAULT '' CHECK (char_length(excerpt) <= 200),
  flags        TEXT[]       NOT NULL DEFAULT '{}',
  posted_at    TIMESTAMPTZ  NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS news_items_teams_idx  ON news_items USING GIN (team_abbrs);
CREATE INDEX IF NOT EXISTS news_items_posted_idx ON news_items (posted_at DESC);
