/**
 * mine-stories.ts — étape 2 (+ 3) du content engine
 * ==================================================
 * Transforme les fichiers d'insights en une liste courte d'angles de vidéo,
 * accompagnés des données de graphique prêtes à tracer.
 *
 * Entrées   : content/config/rules.json + content/data/*.csv + ml/data/*.json
 * Sorties   : content/output/<date>/candidates.json
 *             content/output/<date>/rejected.json
 *             content/output/<date>/review.html
 *             content/output/<date>/charts/<id>.csv
 *
 * Usage :
 *   npm run content:mine
 *   npm run content:mine -- --phase=mid        forcer une phase de saison
 *   npm run content:mine -- --date=2026-11-04  forcer la date de sortie
 *   npm run content:mine -- --top=20           plus de candidats qu'en config
 *
 * AUCUN LLM ICI, ET C'EST LE POINT CENTRAL. Un modèle à qui on donne 615 lignes
 * de CSV invente des chiffres, choisit toujours les mêmes vedettes et ne donne
 * pas deux fois le même résultat. Les règles sont ennuyeuses, et c'est
 * exactement la qualité recherchée : le même fichier donne toujours les mêmes
 * candidats, chaque sélection est justifiée par un champ `why` lisible, et
 * quand un choix déplaît on change un seuil au lieu de réécrire un prompt.
 * Le LLM intervient à l'étape 4, une fois les faits verrouillés : il rédige,
 * il ne sélectionne pas.
 *
 * Ne touche à aucun code de production : lecture de fichiers et écriture dans
 * content/output/ uniquement.
 */

import { promises as fs } from 'fs';
import path from 'path';

// ===========================================================================
// Chemins
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RULES_PATH = path.join(REPO_ROOT, 'content', 'config', 'rules.json');
const HISTORY_PATH = path.join(REPO_ROOT, 'content', 'data', 'history.json');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'content', 'output');

// ===========================================================================
// Types
// ===========================================================================

type Row = Record<string, string | number | boolean | null>;

interface Condition {
  field: string;
  op: '>' | '>=' | '<' | '<=' | '==' | '!=' | 'abs>' | 'in';
  value: unknown;
}

interface ScaleSpec {
  field: string;
  scale: [number | string, number | string];
  direction?: 'negative';
  absolute?: boolean;
}

interface ChartSpec {
  kind: 'bar_compare' | 'bar_rank' | 'scatter' | 'split_pair' | 'line_career';
  fields?: string[];
  field?: string;
  filter?: string;
  group?: string;
  top?: number;
  unit: string;
  /**
   * Libellé de ligne pour les classements dont les lignes ne portent ni `name`
   * ni `team` : `"{home} {score} {away}"` donne « BOS 3-4 ANA ». Sans lui, ces
   * graphiques sortaient avec cinq barres nommées « ? ».
   */
  label_from?: string;
  /**
   * Plancher d'échantillon appliqué au CLASSEMENT, distinct de celui qui filtre
   * les candidats.
   *
   * Trier un taux sans plancher sélectionne mécaniquement les plus petits
   * échantillons : le classement des mises au jeu s'ouvrait sur un joueur à
   * 100 % en deux matchs, au-dessus du candidat. Le graphique contredisait
   * alors la vidéo qu'il devait prouver. `"$gp_min"` suit la phase de saison,
   * comme les seuils des règles.
   */
  min?: { field: string; value: number | string };
  /**
   * Restreint le classement aux lignes qui partagent la valeur du candidat sur
   * ce champ. Les JSON de facteurs de ligue contiennent le même facteur mesuré
   * sur trois grandeurs : sans ce filtre, le graphique alignait « getaway game »
   * deux fois avec deux valeurs, l'une en points, l'autre en buts attendus. On
   * compare des facteurs entre eux, donc sur une seule grandeur à la fois.
   */
  peer_field?: string;
}

interface Rule {
  id: string;
  family: string;
  source: string;
  entity: string;
  enabled: boolean;
  expected_yield: number | null;
  conditions: Condition[];
  amplitude: ScaleSpec | null;
  robustness: ScaleSpec | null;
  chart: ChartSpec;
  headline_en: string;
  note: string | null;
  path?: string;
  identity_check?: boolean;
  prefer_active?: boolean;
  min_seasons?: number;
}

interface Candidate {
  id: string;
  rule: string;
  family: string;
  template: string;
  entity: { type: string; name: string; team: string | null };
  facts: Record<string, unknown>;
  score: number;
  score_breakdown: Record<string, number>;
  why: string[];
  headline_en: string;
  chart: ChartSpec & { file: string | null };
  source_file: string;
  retrospective: boolean;
}

interface HistoryEntry {
  date: string;
  candidate_id: string;
  entity: string;
  team: string | null;
  template: string;
  hook_id?: string;
  cta_id?: string;
  views?: number | null;
}

// ===========================================================================
// Lecture CSV
// ===========================================================================

/**
 * Analyseur CSV minimal mais conforme aux guillemets (RFC 4180).
 *
 * Écrit à la main plutôt qu'ajouté en dépendance : le projet n'embarque aucun
 * parseur, et `build-content-insights.ts` produit déjà ses CSV à la main. Une
 * dépendance de plus pour trente lignes ne se justifie pas, et celle-ci
 * tournerait dans un script hors production.
 */
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { record.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { record.push(field); rows.push(record); record = []; field = ''; continue; }
    field += c;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record); }

  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length === header.length && r.some((v) => v !== ''))
    .map((r) => {
      const obj: Row = {};
      header.forEach((h, idx) => { obj[h] = coerce(r[idx]); });
      return obj;
    });
}

/** Convertit une cellule CSV en nombre / booléen quand c'est sans ambiguïté. */
function coerce(raw: string): string | number | boolean | null {
  if (raw === '' || raw === 'null' || raw === 'undefined') return null;
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  // Le test sur la chaîne complète évite de transformer "3-2" ou "W4" en nombre.
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

// ===========================================================================
// Fraîcheur des sources
// ===========================================================================

/**
 * Contrôle strict, choisi délibérément : mieux vaut ne rien publier que publier
 * des chiffres périmés. Le seuil vit dans rules.json car il interagit avec la
 * cadence de la tâche planifiée — 3 jours de tolérance pour un rafraîchissement
 * tous les 3 jours ne laisse aucune marge.
 */
async function checkFreshness(
  sources: Record<string, string>,
  maxAgeDays: number,
  failOnMissing: boolean,
): Promise<Record<string, { path: string; ageDays: number }>> {
  const out: Record<string, { path: string; ageDays: number }> = {};
  const problems: string[] = [];

  for (const [key, rel] of Object.entries(sources)) {
    const abs = path.join(REPO_ROOT, rel);
    try {
      const st = await fs.stat(abs);
      const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
      if (ageDays > maxAgeDays) {
        problems.push(`  ${key} : ${ageDays.toFixed(1)} jours (max ${maxAgeDays}) — ${rel}`);
      }
      out[key] = { path: abs, ageDays };
    } catch {
      if (failOnMissing) problems.push(`  ${key} : ABSENT — ${rel}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Sources inutilisables :\n${problems.join('\n')}\n\n` +
      `  Régénère-les : content\\refresh-insights.cmd\n` +
      `  (l'app doit tourner pour les CSV : cd server && npm run dev)\n` +
      `  Pour assouplir, change freshness.max_source_age_days dans rules.json.`,
    );
  }
  return out;
}

// ===========================================================================
// Phase de saison
// ===========================================================================

interface Phase {
  name: string;
  gpMin: number;
  families: Set<string>;
  retrospective: boolean;
}

function resolvePhase(config: any, date: Date, forced: string | null): Phase {
  const month = date.getMonth() + 1;
  let name = forced ?? '';

  if (!name) {
    for (const [key, spec] of Object.entries<any>(config.season_phases)) {
      if (key === 'note') continue;
      if (Array.isArray(spec.months) && spec.months.includes(month)) { name = key; break; }
    }
  }
  if (!name || !config.season_phases[name]) {
    throw new Error(`Phase de saison introuvable pour le mois ${month}. Utilise --phase=`);
  }

  const spec = config.season_phases[name];
  return {
    name,
    gpMin: spec.gp_min,
    families: new Set<string>(spec.enabled_families),
    retrospective: spec.retrospective_mode === true,
  };
}

// ===========================================================================
// Champs dérivés
// ===========================================================================

/**
 * Champs absents des CSV mais nécessaires aux règles. Calculés ici plutôt
 * qu'ajoutés au générateur amont : ce sont des besoins purement éditoriaux, et
 * les faire remonter dans build-content-insights.ts mêlerait deux
 * responsabilités.
 */
function addDerivedFields(source: string, rows: Row[]): Row[] {
  if (source === 'player') {
    // `is_center` sert de garde-fou aux mises au jeu. Le CSV ne fournit pas le
    // nombre de tentatives, seulement le pourcentage : un ailier qui prend six
    // mises au jeu et en gagne six affiche 100 %. La position est le seul
    // substitut disponible au volume.
    return rows.map((r) => ({ ...r, is_center: r['position'] === 'C' }));
  }
  if (source !== 'team') return rows;

  return rows.map((r) => {
    const num = (k: string) => Number(r[k] ?? 0);
    const homeGp = num('home_w') + num('home_l') + num('home_otl');
    const awayGp = num('away_w') + num('away_l') + num('away_otl');
    const ogGp = num('one_goal_w') + num('one_goal_l') + num('one_goal_otl');

    const homePct = homeGp > 0 ? num('home_w') / homeGp : 0;
    const awayPct = awayGp > 0 ? num('away_w') / awayGp : 0;

    const streak = String(r['streak'] ?? '');
    const streakMatch = /^([WLO]+)(\d+)$/.exec(streak);

    return {
      ...r,
      home_win_pct: homePct,
      away_win_pct: awayPct,
      home_road_split_pp: (homePct - awayPct) * 100,
      one_goal_win_pct: ogGp > 0 ? num('one_goal_w') / ogGp : 0,
      last10_points: num('last10_w') * 2 + num('last10_otl'),
      streak_type: streakMatch ? streakMatch[1] : null,
      streak_len: streakMatch ? Number(streakMatch[2]) : 0,
    };
  });
}

// ===========================================================================
// Évaluation des conditions
// ===========================================================================

function resolveThreshold(value: unknown, phase: Phase): unknown {
  return value === '$gp_min' ? phase.gpMin : value;
}

function evaluate(row: Row, cond: Condition, phase: Phase): boolean {
  const raw = row[cond.field];
  const target = resolveThreshold(cond.value, phase);

  if (cond.op === 'in') return Array.isArray(target) && target.includes(raw as never);
  if (cond.op === '==') return raw === target || Number(raw) === Number(target);
  if (cond.op === '!=') return raw !== target;

  const a = Number(raw);
  const b = Number(target);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;

  switch (cond.op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case 'abs>': return Math.abs(a) > b;
    default: return false;
  }
}

// ===========================================================================
// Scoring
// ===========================================================================

/** Ramène une valeur sur 0-100 selon la plage déclarée par la règle. */
function scaleScore(row: Row, spec: ScaleSpec | null, phase: Phase): number {
  if (!spec) return 50; // absence de mesure : neutre, ni bonus ni pénalité
  let value = Number(row[spec.field]);
  if (!Number.isFinite(value)) return 0;
  if (spec.absolute) value = Math.abs(value);

  const lo = Number(resolveThreshold(spec.scale[0], phase));
  const hi = Number(resolveThreshold(spec.scale[1], phase));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return 50;

  // direction:negative — l'amélioration va vers le bas (gaa_delta, ga_per_game_delta).
  const t = (value - lo) / (hi - lo);
  return Math.max(0, Math.min(1, t)) * 100;
}

/**
 * Trois fenêtres, trois raisons distinctes.
 *
 * Une même personne à 14 jours : en deçà, l'audience a l'impression de revoir la
 * même vidéo. Une même équipe à 4 jours : une équipe a plusieurs joueurs, et
 * enchaîner trois vidéos sur Montréal en une semaine transforme le compte en
 * page de partisans. Un même gabarit à 3 jours : c'est le format qui devient
 * prévisible avant le sujet.
 */
function noveltyScore(
  entity: string, team: string | null, template: string,
  history: HistoryEntry[], today: Date, cfg: any,
): { score: number; reason: string | null } {
  const ageDays = (iso: string) => (today.getTime() - new Date(iso).getTime()) / 86_400_000;

  for (const h of history) {
    const age = ageDays(h.date);
    if (h.entity === entity && age <= cfg.repeat_window_days) {
      return { score: 0, reason: `déjà publié sur ${entity} il y a ${Math.round(age)} j` };
    }
  }
  for (const h of history) {
    const age = ageDays(h.date);
    if (team && h.team === team && age <= cfg.team_repeat_window_days) {
      return { score: 40, reason: `${team} déjà couverte il y a ${Math.round(age)} j` };
    }
  }
  for (const h of history) {
    const age = ageDays(h.date);
    if (h.template === template && age <= cfg.template_repeat_window_days) {
      return { score: 70, reason: `gabarit ${template} utilisé il y a ${Math.round(age)} j` };
    }
  }
  return { score: 100, reason: null };
}

function notorietyScore(team: string | null, tiers: any): number {
  if (!team) return 50; // contenu ligue : ni avantagé ni pénalisé
  for (const spec of Object.values<any>(tiers)) {
    if (spec && Array.isArray(spec.teams) && spec.teams.includes(team)) return spec.score;
  }
  return 25;
}

// ===========================================================================
// Chargement des sources
// ===========================================================================

/**
 * Les sources JSON n'ont pas toutes la même forme : tableau plat pour les
 * patineurs groupés, dictionnaire de tableaux pour les facteurs de ligue,
 * arborescence pour les insights avancés. On aplatit tout en `Row[]` pour que
 * le moteur de règles n'ait qu'un seul cas à gérer.
 */
function flattenJson(data: unknown, subPath?: string): Row[] {
  let node: any = data;
  if (subPath) {
    for (const key of subPath.split('.')) node = node?.[key];
  }
  if (Array.isArray(node)) return node as Row[];
  if (node && typeof node === 'object') {
    const out: Row[] = [];
    for (const [key, value] of Object.entries<any>(node)) {
      if (Array.isArray(value)) {
        for (const item of value) out.push({ ...item, _group: key });
      }
    }
    return out;
  }
  return [];
}

async function loadSources(
  sources: Record<string, string>,
  resolved: Record<string, { path: string; ageDays: number }>,
): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const [key, rel] of Object.entries(sources)) {
    const info = resolved[key];
    if (!info) { out[key] = []; continue; }
    const text = await fs.readFile(info.path, 'utf8');
    out[key] = rel.endsWith('.csv')
      ? addDerivedFields(key, parseCsv(text))
      : flattenJson(JSON.parse(text));
    // Les fichiers arborescents sont rechargés par règle via rule.path.
    if (rel.endsWith('.json')) (out as any)[`${key}__raw`] = JSON.parse(text);
  }
  return out;
}

// ===========================================================================
// Identité des entités
// ===========================================================================

function entityOf(rule: Rule, row: Row): { type: string; name: string; team: string | null } {
  const team = (row['team'] as string) ?? null;
  switch (rule.entity) {
    case 'player':
    case 'goalie':
      return { type: rule.entity, name: String(row['name'] ?? row['goalie'] ?? '?'), team };
    case 'team':
      return { type: 'team', name: String(row['name'] ?? team ?? '?'), team };
    case 'matchup':
      return { type: 'matchup', name: `${team} vs ${row['opponent']}`, team };
    case 'game':
      return { type: 'game', name: `${row['home']} ${row['score']} ${row['away']}`, team: null };
    default: {
      // La métrique fait partie de l'identité, sinon collision.
      //
      // `analyze_skaters` mesure le même découpage sur les points, les xG et les
      // tirs cadrés : trois lignes distinctes portant le même libellé et le même
      // bucket. Sans la métrique dans le nom, elles produisaient toutes le même
      // id — donc un seul fichier de graphique écrasé deux fois, et un
      // history.json incapable de distinguer les trois.
      const metric = row['metric_label'] ? ` · ${row['metric_label']}` : '';
      return {
        type: 'league',
        name: `${row['label'] ?? row['factor']} = ${row['bucket']}${metric}`,
        team: null,
      };
    }
  }
}

/**
 * Le CSV NHL fait autorité, décision du 2026-08-01.
 *
 * Les deux jeux ne définissent pas « actif » pareil : le Python retient qui a
 * joué en 2025-26 (98 gardiens), le CSV qui figure sur un alignement (63).
 * Andersen, Pickard et Tarasov ont bien joué mais ne sont sous contrat nulle
 * part — un agent libre non signé ne porte aucun contenu. Ne s'applique pas aux
 * analyses groupées, qui ne nomment personne, ni aux records de tous les temps,
 * qu'un filtre sur les actifs viderait de leur sens.
 */
function buildRoster(sources: Record<string, Row[]>): Set<string> {
  const roster = new Set<string>();
  for (const key of ['player', 'goalie']) {
    for (const row of sources[key] ?? []) {
      const name = String(row['name'] ?? '');
      if (name) roster.add(name.toLowerCase());
    }
  }
  return roster;
}

// ===========================================================================
// Moteur de règles
// ===========================================================================

function fillTemplate(tpl: string, row: Row): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, key) => {
    const v = row[key];
    if (v === null || v === undefined) return `{${key}}`;
    return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  });
}

function pickFacts(row: Row, rule: Rule): Record<string, unknown> {
  const keys = new Set<string>();
  rule.conditions.forEach((c) => keys.add(c.field));
  if (rule.amplitude) keys.add(rule.amplitude.field);
  if (rule.robustness) keys.add(rule.robustness.field);
  (rule.chart.fields ?? []).forEach((f) => keys.add(f));
  if (rule.chart.field) keys.add(rule.chart.field);
  // Champs descriptifs, ajoutés systématiquement quand ils existent.
  //
  // Découvert en testant le prompt de rédaction sur de vrais candidats :
  // `historical_upset` ne transmettait que `home_win_probability_pre_game`,
  // sans les équipes ni le score — le rédacteur ne pouvait pas écrire la vidéo.
  // Idem pour les insights de ligue, réduits à `delta_pct` sans le libellé qui
  // dit de quelle situation on parle. Le bloc `facts` est la SEULE chose que le
  // rédacteur verra : tout ce qui manque ici est un chiffre qu'il devra inventer
  // ou un angle qu'il devra abandonner.
  [
    'name', 'team', 'opponent', 'gp', 'season', 'n', 'position',
    'home', 'away', 'score', 'date', 'winner', 'goal_diff',
    'goalie', 'shots_faced', 'goals_allowed', 'gsax', 'is_active',
    'label', 'bucket', 'metric_label', 'value', 'base_value', 'delta_pct',
    'streak', 'streak_type', 'streak_len',
  ].forEach((f) => {
    if (row[f] !== undefined) keys.add(f);
  });

  const facts: Record<string, unknown> = {};
  for (const k of keys) if (row[k] !== undefined) facts[k] = row[k];
  return facts;
}

interface Rejected { rule: string; entity: string; reason: string; }

function mine(
  config: any, sources: Record<string, Row[]>, phase: Phase,
  history: HistoryEntry[], today: Date, roster: Set<string>,
): { candidates: Candidate[]; rejected: Rejected[] } {
  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];
  const dateKey = today.toISOString().slice(0, 10);

  for (const rule of config.rules as Rule[]) {
    if (!rule.enabled) continue;
    if (!phase.families.has(rule.family)) {
      rejected.push({ rule: rule.id, entity: '—', reason: `famille ${rule.family} fermée en phase ${phase.name}` });
      continue;
    }

    let rows: Row[];
    if (rule.path) {
      const raw = (sources as any)[`${rule.source}__raw`];
      rows = flattenJson(raw, rule.path);
    } else {
      rows = sources[rule.source] ?? [];
    }
    if (rows.length === 0) {
      rejected.push({ rule: rule.id, entity: '—', reason: `source ${rule.source} vide` });
      continue;
    }

    for (const row of rows) {
      if (!rule.conditions.every((c) => evaluate(row, c, phase))) continue;

      const entity = entityOf(rule, row);
      const identityRequired = rule.identity_check !== false
        && (rule.entity === 'player' || rule.entity === 'goalie');
      if (identityRequired && !roster.has(entity.name.toLowerCase())) {
        rejected.push({ rule: rule.id, entity: entity.name, reason: 'entité absente des alignements' });
        continue;
      }

      const amplitude = scaleScore(row, rule.amplitude, phase);
      const robustness = scaleScore(row, rule.robustness, phase);
      const novelty = noveltyScore(entity.name, entity.team, rule.id, history, today, config.novelty);
      const notoriety = notorietyScore(entity.team, config.notoriety_tiers);

      const w = config.scoring.weights;
      let score = amplitude * w.amplitude + robustness * w.robustness
        + novelty.score * w.novelty + notoriety * w.notoriety;

      // Un écart énorme sur un échantillon minuscule ne doit jamais finir
      // premier : le plafond agit après la pondération, pas avant.
      const cap = config.scoring.hard_cap_small_sample;
      if (cap?.enabled && rule.robustness && robustness < 20) {
        score = Math.min(score, cap.max_score);
      }

      // Records de tous les temps : le filtre d'alignement ne s'y applique pas,
      // sinon un record cesse d'en être un. Mais à amplitude comparable, un
      // joueur qu'on peut voir jouer la saison prochaine porte mieux la vidéo
      // qu'un retraité de 2011 — d'où une pénalité plutôt qu'une exclusion.
      let inactivePenalty = 0;
      if (rule.prefer_active && row['is_active'] === false) {
        inactivePenalty = 20;
        score -= inactivePenalty;
      }

      const why: string[] = rule.conditions.map((c) => {
        const target = resolveThreshold(c.value, phase);
        return `${c.field} ${c.op} ${JSON.stringify(target)} (valeur : ${row[c.field]})`;
      });
      if (novelty.reason) why.push(`pénalité nouveauté — ${novelty.reason}`);
      if (inactivePenalty > 0) why.push(`−${inactivePenalty} : joueur retraité, record conservé mais déclassé`);
      if (phase.retrospective) why.push('mode rétrospectif : bilan de la saison écoulée');

      const slug = entity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      candidates.push({
        id: `${dateKey}-${rule.id}-${slug}`.slice(0, 90),
        rule: rule.id,
        family: rule.family,
        template: rule.id,
        entity,
        facts: pickFacts(row, rule),
        score: Math.round(score),
        score_breakdown: {
          amplitude: Math.round(amplitude),
          robustesse: Math.round(robustness),
          nouveaute: novelty.score,
          notoriete: notoriety,
        },
        why,
        headline_en: fillTemplate(rule.headline_en, row)
          + (phase.retrospective ? config.retrospective.headline_suffix_en : ''),
        chart: { ...rule.chart, file: null },
        source_file: config.sources[rule.source],
        retrospective: phase.retrospective,
      });
    }
  }

  return { candidates, rejected };
}

/**
 * Sélection gloutonne sous quotas.
 *
 * Prendre simplement les 10 meilleurs scores donnerait dix variantes de la même
 * histoire — les règles à fort rendement écrasent les autres, et une bonne
 * journée de Toronto peut monopoliser la liste. Les quotas par gabarit et par
 * équipe coûtent quelques points de score et achètent une semaine de contenu
 * qui ne se répète pas.
 */
function select(candidates: Candidate[], config: any, limit: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const perTemplate = new Map<string, number>();
  const perTeam = new Map<string, number>();
  const chosen: Candidate[] = [];
  const taken = new Set<string>();

  const fits = (c: Candidate) => {
    if ((perTemplate.get(c.template) ?? 0) >= config.output.max_per_template) return false;
    if (c.entity.team && (perTeam.get(c.entity.team) ?? 0) >= config.output.max_per_team) return false;
    return true;
  };
  const take = (c: Candidate) => {
    chosen.push(c);
    taken.add(c.id);
    perTemplate.set(c.template, (perTemplate.get(c.template) ?? 0) + 1);
    if (c.entity.team) perTeam.set(c.entity.team, (perTeam.get(c.entity.team) ?? 0) + 1);
  };

  // Passe 1 — les places réservées. Les familles sont servies dans l'ordre de
  // leur meilleur candidat : la plus forte réserve en premier son budget
  // d'équipes et de gabarits, qui est partagé entre toutes.
  const quotas: Record<string, number> = config.output.family_quotas ?? {};
  const families = [...new Set(sorted.map((c) => c.family))]
    .filter((f) => (quotas[f] ?? 0) > 0)
    .sort((a, b) => {
      const bestA = sorted.find((c) => c.family === a)?.score ?? 0;
      const bestB = sorted.find((c) => c.family === b)?.score ?? 0;
      return bestB - bestA;
    });

  for (const family of families) {
    let placed = 0;
    for (const c of sorted) {
      if (placed >= quotas[family] || chosen.length >= limit) break;
      if (c.family !== family || taken.has(c.id) || !fits(c)) continue;
      take(c);
      placed++;
    }
  }

  // Passe 2 — redistribution. Un quota non pourvu (streak fermée hors saison,
  // famille sans candidat éligible) ne doit pas laisser une place vide : elle
  // revient au meilleur score restant, toutes familles confondues.
  for (const c of sorted) {
    if (chosen.length >= limit) break;
    if (taken.has(c.id) || !fits(c)) continue;
    take(c);
  }

  return chosen.sort((a, b) => b.score - a.score);
}

// ===========================================================================
// Données de graphique (étape 3)
// ===========================================================================

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const header = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Libellés
// ---------------------------------------------------------------------------

/**
 * Ce qui est écrit sous une barre, à l'écran.
 *
 * POURQUOI CE BLOC EXISTE. Les libellés étaient les noms de colonnes bruts : un
 * graphique de confrontation opposait `combined_gf_per_game` à
 * `combined_ga_per_game`, et un classement de fatigue affichait « jours loin de
 * la maison » — en français, sur un compte anglophone. Un spectateur ne saura
 * jamais qu'une colonne porte ce nom, et il ne devrait pas avoir à le deviner.
 *
 * Le vocabulaire vit dans `chart_labels` de rules.json : c'est une question de
 * ton éditorial, elle se règle sans toucher au TypeScript. Ce qui reste ici,
 * c'est la seule règle que le dictionnaire ne peut pas porter — les paires
 * `prev_X` / `X`, dont les deux barres mesurent la même chose et ne diffèrent
 * que par la saison.
 */
const missingLabels = new Set<string>();

/** 20252026 -> « 2025-26 ». */
function seasonLabel(season: unknown): string | null {
  const s = String(season ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(6, 8)}`;
}

/**
 * Libellé d'une colonne dans une paire.
 *
 * Une paire `prev_pp_pct` / `pp_pct` reçoit les millésimes plutôt que « Last
 * season » / « This season » : en août, « this season » désigne une saison
 * terminée en avril, exactement ce que le mode rétrospectif interdit de laisser
 * croire. La mesure, elle, est déjà nommée par la phrase du plan.
 */
function pairLabel(field: string, c: Candidate, labels: any): string {
  const season = seasonLabel(c.facts['season']);
  if (season) {
    const isPrev = field.startsWith('prev_');
    const base = isPrev ? field.slice(5) : field;
    // Ne vaut que si les deux moitiés de la paire existent : `ga_per_game` seul
    // n'est pas une comparaison de saisons.
    if (`prev_${base}` in c.facts && base in c.facts) {
      if (!isPrev) return season;
      const prev = seasonLabel(Number(c.facts['season']) - 10001);
      return prev ?? 'Before';
    }
  }
  const mapped = labels?.fields?.[field];
  if (mapped) return String(mapped);
  missingLabels.add(`chart_labels.fields.${field}`);
  // Repli lisible plutôt que du snake_case : « combined ga per game » reste
  // mauvais, mais il se lit, et l'avertissement dit quoi ajouter au dictionnaire.
  return field.replace(/_/g, ' ');
}

/** Libellé d'une ligne de classement. */
function rowLabel(r: Row, chart: ChartSpec, labels: any): string {
  if (chart.label_from) {
    return chart.label_from.replace(/\{(\w+)\}/g, (_m, k) => String(r[k] ?? '')).trim();
  }
  const named = r['name'] ?? r['team'];
  if (named) return String(named);
  // Lignes de facteurs de ligue : on traduit la clé `factor`, stable, et non le
  // texte français de `label`, qui change au gré des scripts d'analyse Python.
  const factor = r['factor'];
  if (factor) {
    const mapped = labels?.factors?.[String(factor)];
    if (mapped) return String(mapped);
    missingLabels.add(`chart_labels.factors.${factor}`);
  }
  return String(r['label'] ?? '?');
}

/**
 * Un fichier par graphique, 5 à 12 lignes, jamais les 615 de départ.
 * Le CSV existe aussi pour toi : il s'ouvre dans Figma, Excel ou Datawrapper si
 * tu veux soigner un visuel à la main sans dépendre du pipeline.
 */
function buildChart(c: Candidate, rows: Row[], labels: any, phase: Phase): Array<Record<string, unknown>> | null {
  const chart = c.chart;
  const top = chart.top ?? 10;

  switch (chart.kind) {
    case 'bar_compare':
    case 'split_pair': {
      const [a, b] = chart.fields ?? [];
      if (!a || !b) return null;
      return [
        { label: pairLabel(a, c, labels), value: c.facts[a] ?? null },
        { label: pairLabel(b, c, labels), value: c.facts[b] ?? null },
      ];
    }
    case 'bar_rank': {
      const field = chart.field;
      if (!field) return null;
      let pool = chart.filter ? rows.filter((r) => Boolean(r[chart.filter as string])) : rows;
      if (chart.min) {
        const floor = Number(resolveThreshold(chart.min.value, phase));
        pool = pool.filter((r) => Number(r[chart.min!.field]) >= floor);
      }
      if (chart.peer_field) {
        const mine = c.facts[chart.peer_field];
        pool = pool.filter((r) => r[chart.peer_field as string] === mine);
      }
      return pool
        .filter((r) => Number.isFinite(Number(r[field])))
        .sort((x, y) => Math.abs(Number(y[field])) - Math.abs(Number(x[field])))
        .slice(0, top)
        .map((r) => {
          const label = rowLabel(r, chart, labels);
          return {
            label,
            value: r[field],
            // Le libellé entre dans la comparaison : quand il est construit par
            // `label_from`, c'est lui qui porte l'identité de la ligne, et la
            // barre du candidat serait sinon la seule à ne pas être mise en
            // avant dans son propre graphique.
            highlight: label === c.entity.name || (r['name'] ?? r['team']) === c.entity.name ? 1 : 0,
          };
        });
    }
    case 'scatter': {
      const [x, y] = chart.fields ?? [];
      if (!x || !y) return null;
      return rows
        .filter((r) => Number.isFinite(Number(r[x])) && Number.isFinite(Number(r[y])))
        .slice(0, 200)
        .map((r) => ({
          label: r['name'] ?? r['team'] ?? '?',
          x: r[x], y: r[y],
          highlight: r['name'] === c.entity.name ? 1 : 0,
        }));
    }
    case 'line_career': {
      const field = chart.field;
      if (!field) return null;
      return rows
        .filter((r) => r['name'] === c.entity.name)
        .sort((p, q) => Number(p['season']) - Number(q['season']))
        .map((r) => ({ season: r['season'], value: r[field], gp: r['gp'] }));
    }
    default:
      return null;
  }
}

// ===========================================================================
// Page de revue
// ===========================================================================

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

/**
 * Page autonome : ni CDN, ni build, ni serveur. Elle s'ouvre par double-clic et
 * fonctionne hors ligne. C'est ce qui rend le réglage des seuils praticable —
 * sans elle, ajuster rules.json revient à lire du JSON brut en devinant.
 */
function buildReviewHtml(
  chosen: Candidate[], all: Candidate[], rejected: Rejected[],
  phase: Phase, dateKey: string,
): string {
  const bar = (value: number, max: number, color: string) => {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return `<div class="bar"><span style="width:${pct.toFixed(1)}%;background:${color}"></span></div>`;
  };

  const cards = chosen.map((c, i) => {
    const b = c.score_breakdown;
    return `
    <article class="card">
      <header>
        <span class="rank">#${i + 1}</span>
        <span class="score">${c.score}</span>
        <div>
          <h2>${esc(c.entity.name)}${c.entity.team ? ` <em>${esc(c.entity.team)}</em>` : ''}</h2>
          <p class="hook">${esc(c.headline_en)}</p>
        </div>
        <span class="tpl">${esc(c.family)} · ${esc(c.template)}</span>
      </header>
      <div class="cols">
        <div>
          <h3>Chiffres</h3>
          <table>${Object.entries(c.facts).map(([k, v]) =>
            `<tr><td>${esc(k)}</td><td class="num">${esc(typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)}</td></tr>`).join('')}</table>
        </div>
        <div>
          <h3>Score</h3>
          <table class="bd">
            <tr><td>amplitude</td><td class="num">${b.amplitude}</td><td>${bar(b.amplitude, 100, '#4ade80')}</td></tr>
            <tr><td>robustesse</td><td class="num">${b.robustesse}</td><td>${bar(b.robustesse, 100, '#60a5fa')}</td></tr>
            <tr><td>nouveauté</td><td class="num">${b.nouveaute}</td><td>${bar(b.nouveaute, 100, '#fbbf24')}</td></tr>
            <tr><td>notoriété</td><td class="num">${b.notoriete}</td><td>${bar(b.notoriete, 100, '#f472b6')}</td></tr>
          </table>
          <h3>Pourquoi</h3>
          <ul>${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
          ${c.chart.file ? `<p class="chart">graphique : <code>${esc(c.chart.file)}</code> (${esc(c.chart.kind)})</p>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');

  const byRule = new Map<string, number>();
  all.forEach((c) => byRule.set(c.rule, (byRule.get(c.rule) ?? 0) + 1));
  const yieldRows = [...byRule.entries()].sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `<tr><td>${esc(r)}</td><td class="num">${n}</td></tr>`).join('');

  const rejReasons = new Map<string, number>();
  rejected.forEach((r) => rejReasons.set(r.reason, (rejReasons.get(r.reason) ?? 0) + 1));
  const rejRows = [...rejReasons.entries()].sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `<tr><td>${esc(r)}</td><td class="num">${n}</td></tr>`).join('');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>ICEEDGE — candidats ${dateKey}</title>
<style>
*{box-sizing:border-box} body{margin:0;padding:28px;background:#0b0f14;color:#e6edf3;
  font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif}
h1{margin:0 0 4px;font-size:22px} .sub{color:#8b949e;margin:0 0 24px;font-size:13px}
.card{background:#111823;border:1px solid #1f2937;border-radius:10px;margin-bottom:14px;overflow:hidden}
.card header{display:flex;gap:14px;align-items:center;padding:14px 16px;background:#0e1520;border-bottom:1px solid #1f2937}
.rank{color:#6b7280;font-size:13px;min-width:28px}
.score{font-size:26px;font-weight:700;color:#4ade80;min-width:46px;text-align:right}
.card h2{margin:0;font-size:16px} .card h2 em{color:#8b949e;font-style:normal;font-size:13px}
.hook{margin:2px 0 0;color:#c9d1d9;font-size:13px;font-style:italic}
.tpl{margin-left:auto;background:#1f2937;color:#9ca3af;padding:3px 9px;border-radius:99px;font-size:11px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:14px 16px}
h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#6b7280}
table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px}
td{padding:2px 6px 2px 0;border-bottom:1px solid #161f2b;color:#c9d1d9}
.num{text-align:right;font-variant-numeric:tabular-nums;color:#e6edf3;width:80px}
.bar{background:#1f2937;height:6px;border-radius:3px;overflow:hidden;min-width:70px}
.bar span{display:block;height:100%}
ul{margin:0;padding-left:16px;color:#8b949e;font-size:12px} li{margin-bottom:2px}
.chart{color:#6b7280;font-size:12px;margin:8px 0 0} code{color:#9ca3af}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:26px}
.panel{background:#111823;border:1px solid #1f2937;border-radius:10px;padding:14px 16px}
</style></head><body>
<h1>Candidats du ${esc(dateKey)}</h1>
<p class="sub">Phase <strong>${esc(phase.name)}</strong>${phase.retrospective ? ' — mode rétrospectif, les chiffres décrivent la saison écoulée' : ''}
 · ${all.length} candidats bruts, ${chosen.length} retenus · ${rejected.length} rejets</p>
${cards}
<div class="panels">
  <div class="panel"><h3>Rendement par règle</h3><table>${yieldRows}</table></div>
  <div class="panel"><h3>Motifs de rejet</h3><table>${rejRows}</table></div>
</div>
</body></html>`;
}

// ===========================================================================
// Entrée
// ===========================================================================

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

async function main() {
  const config = JSON.parse(await fs.readFile(RULES_PATH, 'utf8'));

  const dateArg = arg('date');
  const today = dateArg ? new Date(`${dateArg}T12:00:00`) : new Date();
  const dateKey = today.toISOString().slice(0, 10);
  const phase = resolvePhase(config, today, arg('phase'));
  const limit = Number(arg('top') ?? config.output.candidates_per_run);

  console.log(`\nICEEDGE — story mining`);
  console.log(`  date  : ${dateKey}`);
  console.log(`  phase : ${phase.name}${phase.retrospective ? ' (rétrospectif)' : ''}, gp_min=${phase.gpMin}`);
  console.log(`  familles ouvertes : ${[...phase.families].join(', ')}`);

  const resolved = await checkFreshness(
    config.sources,
    config.freshness.max_source_age_days,
    config.freshness.fail_on_missing_source,
  );
  const sources = await loadSources(config.sources, resolved);
  const roster = buildRoster(sources);
  console.log(`  alignements : ${roster.size} joueurs sous contrat`);

  // L'historique est ce qui était connu AVANT le jour traité, jamais ce jour-là.
  //
  // Sans ce filtre, une entité publiée le jour même se pénalisait elle-même avec
  // un âge de zéro : le score d'un candidat dépendait alors de l'ordre dans
  // lequel on avait lancé les scripts, ce qui rend un barème invérifiable.
  //
  // À noter — cela rend le SCORE déterministe pour une date donnée, pas la
  // sélection entière : l'exclusion des sujets déjà publiés, juste en dessous,
  // reste volontairement globale et sans limite de date. Rejouer une date passée
  // ne reproduit donc pas le classement d'origine, et c'est le comportement
  // voulu — ne pas republier un sujet prime sur la commodité du rejeu.
  //
  // Pourquoi une exclusion et non une pénalité : « déjà publié » n'est pas une
  // question de degré. Une pénalité de score, même lourde, finit par être
  // compensée par une amplitude qui monte.
  let allHistory: HistoryEntry[] = [];
  try { allHistory = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8')); }
  catch { console.log('  history.json absent — aucune pénalité de répétition ce tour'); }

  const history = allHistory.filter((h) => h.date < dateKey);
  const alreadyPublished = new Set(allHistory.map((h) => h.candidate_id));
  if (allHistory.length > 0) {
    console.log(`  historique : ${history.length} entrées antérieures, ${alreadyPublished.size} sujets déjà publiés`);
  }

  const mined = mine(config, sources, phase, history, today, roster);
  const rejected = mined.rejected;

  // Exclusion ferme, distincte de la pénalité de nouveauté : un sujet déjà
  // publié ne doit pas pouvoir revenir parce que son amplitude a monté.
  const candidates = mined.candidates.filter((c) => {
    if (!alreadyPublished.has(c.id)) return true;
    rejected.push({ rule: c.rule, entity: c.entity.name, reason: 'déjà publié — voir history.json' });
    return false;
  });

  const chosen = select(candidates, config, limit);
  console.log(`\n  ${candidates.length} candidats bruts -> ${chosen.length} retenus (${rejected.length} rejets)`);

  const outDir = path.join(OUTPUT_ROOT, dateKey);
  const chartDir = path.join(outDir, 'charts');
  // Purge avant écriture : sans ça, deux exécutions le même jour laissent les
  // graphiques de candidats qui ne sont plus sélectionnés. On l'a constaté au
  // premier passage — les CSV de Lucas Raymond survivaient à la correction de
  // la règle qui l'avait fait entrer.
  // Tolérant à l'échec : un CSV ouvert dans Excel est verrouillé par Windows, et
  // c'est un scénario courant puisque ces fichiers sont faits pour être ouverts.
  // Un verrou ne doit pas faire tomber toute l'exécution.
  try {
    await fs.rm(chartDir, { recursive: true, force: true });
  } catch (e: any) {
    console.log(`  (purge des graphiques impossible : ${e.code} — d'anciens fichiers peuvent subsister)`);
  }
  await fs.mkdir(chartDir, { recursive: true });

  for (const c of chosen) {
    const rule = (config.rules as Rule[]).find((r) => r.id === c.rule)!;
    const rows = rule.path
      ? flattenJson((sources as any)[`${rule.source}__raw`], rule.path)
      : sources[rule.source] ?? [];
    const data = buildChart(c, rows, config.chart_labels, phase);
    if (data && data.length > 0) {
      const file = `charts/${c.id}.csv`;
      await fs.writeFile(path.join(outDir, file), toCsv(data), 'utf8');
      c.chart.file = file;
    }
  }

  // Un libellé absent du dictionnaire ne casse rien — il ressort en clair sur
  // une barre, ce qui est précisément le défaut qu'on vient de corriger. Le dire
  // ici est la seule façon que ce dictionnaire reste complet à mesure que des
  // règles s'ajoutent : personne ne relit rules.json pour vérifier une omission.
  if (missingLabels.size > 0) {
    console.log(`\n  ${missingLabels.size} libellé(s) de graphique absents de rules.json :`);
    [...missingLabels].sort().forEach((k) => console.log(`    · ${k}`));
    console.log('    Ces barres afficheront un nom de colonne. Ajoute-les à "chart_labels".');
  }

  await fs.writeFile(path.join(outDir, 'candidates.json'),
    JSON.stringify({ date: dateKey, phase: phase.name, retrospective: phase.retrospective,
      raw_count: candidates.length, candidates: chosen }, null, 2), 'utf8');
  await fs.writeFile(path.join(outDir, 'rejected.json'),
    JSON.stringify(rejected, null, 2), 'utf8');
  await fs.writeFile(path.join(outDir, 'review.html'),
    buildReviewHtml(chosen, candidates, rejected, phase, dateKey), 'utf8');

  console.log(`\n  Écrit dans content\\output\\${dateKey}\\`);
  console.log(`  Ouvre review.html pour relire les ${chosen.length} candidats.\n`);
  chosen.forEach((c, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${String(c.score).padStart(3)}] ${c.template.padEnd(26)} ${c.entity.name}`);
  });
  console.log('');
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
