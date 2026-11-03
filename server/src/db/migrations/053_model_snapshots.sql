-- 053_model_snapshots.sql
-- X402_PLAN.md, phase 1 — le bilan public du modèle.
--
-- Aucune table ne gardait les probabilités d'avant-match de TOUS les matchs :
-- `pickem_model` ne fige que la victoire des matchs votés, `best_bet_log` que
-- les best bets. Sans journal complet, chaque match non figé est perdu pour le
-- bilan. On fige donc deux fois chaque match :
--
-- • `morning` : le matin (GitHub Actions, 15:00 UTC), avant le premier match.
--   Les mêmes chiffres sont commités dans le dépôt PUBLIC
--   `arakice-nhl-predictions` : l'heure du push prouve qu'ils précèdent le
--   match. Écrit UNE fois (ON CONFLICT DO NOTHING) : un second passage du
--   workflow rend la ligne d'origine, jamais un nouveau chiffre.
--   `proof_commit` = le commit public qui la porte ; NULL = hors bilan public
--   (commit raté, ou match commencé avant le push).
-- • `pregame` : dans l'heure avant la mise au jeu, aux tours de NewsSync
--   (15 min). Le dernier tour avant la mise au jeu gagne.
--
-- Probabilités en fraction 0–1 (pas en %), non arrondies à l'entier
-- d'affichage : `probability_exact` du paquet ML.
--   home_win   = P(domicile gagne), prolongation et tirs de barrage compris ;
--   home_minus = P(domicile gagne par 2+) — handicap −1,5 du domicile ;
--   away_minus = P(visiteur gagne par 2+) — handicap −1,5 du visiteur.
-- Pas de totaux (décision D3), aucune cote (D4) : rien ici ne vient d'un livre.
--
-- Règlement (passe horaire de `settlement.service.ts`) : scores finaux et
-- `outcome`. Une ligne réglée ne bouge plus, et une ligne `morning` ne change
-- jamais de chiffre : le déclencheur ci-dessous le garantit côté base, pas
-- seulement côté code.
--
-- Taille : 2 lignes par match, ~2 600 par saison, ~150 octets chacune. Pas de purge.

CREATE TABLE IF NOT EXISTS model_snapshots (
  game_id           TEXT         NOT NULL CHECK (game_id ~ '^[0-9]{6,12}$'),
  kind              TEXT         NOT NULL CHECK (kind IN ('morning', 'pregame')),
  home_team         TEXT         NOT NULL,
  away_team         TEXT         NOT NULL,
  start_time        TIMESTAMPTZ  NOT NULL,
  home_win          NUMERIC(6,5) NOT NULL CHECK (home_win > 0 AND home_win < 1),
  home_minus        NUMERIC(6,5)          CHECK (home_minus > 0 AND home_minus < 1),
  away_minus        NUMERIC(6,5)          CHECK (away_minus > 0 AND away_minus < 1),
  goalies_confirmed BOOLEAN      NOT NULL DEFAULT FALSE,
  model_version     TEXT,
  recorded_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  proof_commit      TEXT         CHECK (proof_commit ~ '^[0-9a-f]{40}$'),
  home_score        SMALLINT,
  away_score        SMALLINT,
  -- Équipe gagnante ; NULL = pas encore réglé.
  outcome           TEXT         CHECK (outcome IN ('home', 'away')),
  settled_at        TIMESTAMPTZ,
  PRIMARY KEY (game_id, kind),
  CHECK (recorded_at < start_time),
  CHECK (proof_commit IS NULL OR kind = 'morning'),
  CHECK ((outcome IS NULL) = (home_score IS NULL AND away_score IS NULL AND settled_at IS NULL))
);

-- Règlement : lignes ouvertes, par heure de match.
CREATE INDEX IF NOT EXISTS model_snapshots_unsettled_idx
  ON model_snapshots (start_time) WHERE outcome IS NULL;

-- Immuabilité, vérifiée par la base :
--   • ligne réglée : plus aucune modification ;
--   • ligne `morning` : chiffres, équipes, heure et version figés à l'insertion
--     (seuls `proof_commit`, posé une fois, et le règlement peuvent s'y ajouter) ;
--   • aucune suppression d'une ligne réglée ou prouvée.
CREATE OR REPLACE FUNCTION model_snapshots_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.outcome IS NOT NULL OR OLD.proof_commit IS NOT NULL THEN
      RAISE EXCEPTION 'model_snapshots: settled or published row % / % cannot be deleted', OLD.game_id, OLD.kind;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'model_snapshots: settled row % / % is immutable', OLD.game_id, OLD.kind;
  END IF;
  IF NEW.game_id IS DISTINCT FROM OLD.game_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'model_snapshots: key cannot change';
  END IF;
  IF OLD.proof_commit IS NOT NULL AND NEW.proof_commit IS DISTINCT FROM OLD.proof_commit THEN
    RAISE EXCEPTION 'model_snapshots: proof_commit of % is already set', OLD.game_id;
  END IF;
  IF OLD.kind = 'morning' AND (
       NEW.home_team         IS DISTINCT FROM OLD.home_team
    OR NEW.away_team         IS DISTINCT FROM OLD.away_team
    OR NEW.start_time        IS DISTINCT FROM OLD.start_time
    OR NEW.home_win          IS DISTINCT FROM OLD.home_win
    OR NEW.home_minus        IS DISTINCT FROM OLD.home_minus
    OR NEW.away_minus        IS DISTINCT FROM OLD.away_minus
    OR NEW.goalies_confirmed IS DISTINCT FROM OLD.goalies_confirmed
    OR NEW.model_version     IS DISTINCT FROM OLD.model_version
    OR NEW.recorded_at       IS DISTINCT FROM OLD.recorded_at
  ) THEN
    RAISE EXCEPTION 'model_snapshots: morning row % is frozen', OLD.game_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_model_snapshots_guard ON model_snapshots;
CREATE TRIGGER trg_model_snapshots_guard
  BEFORE UPDATE OR DELETE ON model_snapshots
  FOR EACH ROW EXECUTE PROCEDURE model_snapshots_guard();
