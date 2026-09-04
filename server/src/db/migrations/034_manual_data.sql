-- 034_manual_data.sql
-- Les quatre tables de saisie manuelle quittent le système de fichiers.
--
-- ── Pourquoi ────────────────────────────────────────────────────────────────
-- `injuryStore`, `refereeStore`, `scratches` et `startingGoalies` lisaient des
-- fichiers JSON à l'exécution. Or `npm run build` = `tsc`, et tsc n'émet PAS les
-- fichiers non-TypeScript : `dist/data/` ne contenait que les `.js`. Le
-- Dockerfile ne copie que `dist/`, et le dossier `ml/` n'est pas dans l'image du
-- tout. Conséquence en production, vérifiée le 2026-09-04 :
--
--   • `injuries.json`          → lecture `{}` ; l'écriture admin
--     (`PUT /api/injuries/:key`) faisait `writeFileSync` dans un dossier
--     inexistant → ENOENT → 500. La carte admin ne fonctionnait pas.
--   • `referees.json`          → table vide → tous les arbitres neutres.
--   • `scratches.json`
--     `starting_goalies.json`  → chemin `cwd/../ml/data` inexistant dans le
--     conteneur → zéro absent, zéro gardien partant.
--
-- Et le repli était SILENCIEUX dans les quatre cas (`try/catch` → valeur
-- neutre), donc rien ne le signalait. Quatre entrées du modèle mortes sans
-- symptôme.
--
-- Copier les JSON dans l'image n'aurait réglé que la lecture : le système de
-- fichiers d'un conteneur est éphémère, donc toute saisie faite depuis la carte
-- admin aurait disparu au redéploiement suivant, et deux instances n'auraient
-- pas vu les mêmes données. La base est la seule réponse qui tienne aux trois
-- problèmes à la fois (présence, persistance, partage).
--
-- ── Forme de la table ───────────────────────────────────────────────────────
-- Une seule table clé/valeur plutôt que quatre tables typées. C'est un choix,
-- pas une paresse : ces quatre jeux de données sont de la SAISIE, pas un modèle
-- de domaine. Ils changent de forme au rythme des idées de features (un champ
-- `lineupNote` ajouté, un barème d'impact revu), et chaque changement de forme
-- coûterait alors une migration. Le JSONB absorbe ça, la validation vit dans
-- `validation/schemas.ts` au point d'écriture, et il n'y a qu'un service à lire
-- pour comprendre l'ensemble.
--
-- `kind` / `entry_key` selon le jeu de données :
--
--   kind               entry_key                payload
--   ─────────────────  ───────────────────────  ──────────────────────────────
--   injuries           'AWAY@HOME'              { home[], away[], lineupAdj, lineupNote }
--   starting_goalies   'YYYY-MM-DD' (heure Est) { "TOR": "Joseph Woll", … }
--   scratches          'YYYY-MM-DD' (heure Est) { "TOR": ["Auston Matthews"], … }
--   ref_tendency       nom d'arbitre normalisé  { name, ppPerGame, note? }
--   ref_assignment     'AWAY@HOME'              { refs: ["…", "…"] }
--   ref_config         'league'                 { avgPpPerGame }
--
-- Les deux jeux datés gardent la date en clé plutôt qu'une ligne par équipe :
-- c'est ainsi qu'ils sont LUS (une journée entière, une fois par prédiction) et
-- ainsi qu'ils se purgent (supprimer les dates passées).
--
-- ── Ce qui n'est PAS repris de l'ancien `referees.json` ─────────────────────
-- Le fichier ne contenait que six arbitres « EXEMPLE placeholder », tous à
-- 6.2 pp/match — exactement la moyenne ligue, donc un multiplicateur de 1.0 et
-- aucun effet. Les recopier ici aurait produit une table qui a l'air remplie
-- sans l'être : c'est précisément le mode de panne que ce projet évite ailleurs
-- (cf. la suppression des prédictions mockées). Seule la moyenne ligue est
-- semée. Une table `ref_tendency` vide se lit « facteur arbitre inactif », ce
-- qui est la vérité tant que les vrais chiffres n'ont pas été saisis.

CREATE TABLE IF NOT EXISTS manual_data (
  kind        VARCHAR(30)  NOT NULL,
  entry_key   VARCHAR(64)  NOT NULL,
  payload     JSONB        NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Qui a saisi. `ON DELETE SET NULL` : supprimer un compte admin ne doit pas
  -- emporter les blessures du soir avec lui.
  updated_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (kind, entry_key)
);

-- La clé primaire (kind, entry_key) sert déjà les lectures par clé exacte.
-- Cet index-ci sert la lecture « tout un kind », qui est le mode d'accès des
-- écrans d'administration et de la table des tendances d'arbitres.
CREATE INDEX IF NOT EXISTS idx_manual_data_kind_updated
  ON manual_data (kind, updated_at DESC);

-- Moyenne ligue d'occasions de power-play par match (deux équipes cumulées).
-- Valeur reprise de l'ancien `referees.json`. Modifiable via
-- `PUT /api/manual/referees`.
INSERT INTO manual_data (kind, entry_key, payload)
VALUES ('ref_config', 'league', '{"avgPpPerGame": 6.2}'::jsonb)
ON CONFLICT (kind, entry_key) DO NOTHING;
