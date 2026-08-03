-- 027_odds_log.sql
-- P1-5 (ligne K) — Journal des cotes NHL en base, à la place du CSV.
--
-- POURQUOI — `oddsLogger` écrivait dans
-- `<cwd>/../ml/data/odds_live_log.csv`. Dans le conteneur, `WORKDIR /app` et
-- seul `dist/` est copié : ce dossier n'existe pas, il est donc créé à la racine
-- du conteneur, sur un système de fichiers ÉPHÉMÈRE. Chaque déploiement effaçait
-- la collecte. Le job paraissait fonctionner — il écrivait, il ne levait pas —
-- et son objectif (constituer un dataset de réentraînement, que The Odds API ne
-- vend pas rétroactivement) était en réalité inatteignable. Un mois de collecte
-- perdu ne se rattrape pas : la cote de clôture d'un match d'hier n'existe plus.
--
-- La clé primaire (game_date, home_team, away_team) porte l'idempotence :
-- plusieurs passes par jour ne créent pas de doublon, et la relecture complète
-- du fichier à chaque exécution — dont le coût croissait avec la saison —
-- disparaît.
--
-- OPEN vs CLOSE — le CSV remplissait les deux avec la même valeur, faute de
-- pouvoir relire ce qu'il avait écrit. Ici la première passe d'une journée pose
-- l'ouverture, les suivantes ne mettent à jour que la clôture : la ligne gagne
-- le mouvement de cote, qui est précisément le signal recherché.

CREATE TABLE IF NOT EXISTS odds_log (
  game_date     DATE        NOT NULL,
  home_team     TEXT        NOT NULL,          -- abréviation NHL (spine)
  away_team     TEXT        NOT NULL,
  home_ml_open  NUMERIC,
  away_ml_open  NUMERIC,
  home_ml_close NUMERIC,
  away_ml_close NUMERIC,
  total_open    NUMERIC,
  total_close   NUMERIC,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_date, home_team, away_team)
);

-- L'export vers le dataset se fait par plage de dates.
CREATE INDEX IF NOT EXISTS idx_odds_log_date ON odds_log (game_date);
