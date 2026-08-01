/**
 * check-posts.ts — garde-fou de l'étape 4
 * ========================================
 * Vérifie un posts.json contre candidates.json et les règles du guide de style.
 *
 * Usage :
 *   npm run content:check
 *   npm run content:check -- --date=2026-08-01
 *
 * POURQUOI CE SCRIPT EXISTE. L'étape 4 est la seule du pipeline qui passe par un
 * modèle de langage, et donc la seule où un chiffre peut apparaître sans venir
 * des données. Elle est aussi manuelle : rien ne garantit qu'une consigne du
 * prompt a été suivie. Ce script rejoue mécaniquement les contraintes qu'un
 * rédacteur — humain ou non — peut oublier.
 *
 * Il a été écrit après avoir trouvé six dépassements dans le tout premier lot de
 * scripts, dont un hook de la bibliothèque officielle qui violait sa propre
 * limite de mots. Une règle qu'on ne vérifie pas mécaniquement n'est pas une
 * règle, c'est une intention.
 */

import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'content', 'output');
const LIBRARY_ROOT = path.join(REPO_ROOT, 'content', 'library');
const HISTORY_PATH = path.join(REPO_ROOT, 'content', 'data', 'history.json');

/** Fenêtre minimale avant de réemployer un hook, en jours (STYLE-GUIDE §hooks). */
const HOOK_COOLDOWN_DAYS = 10;

interface LibraryEntry { id: string; text: string; templates: string[]; }

/**
 * Lit les tableaux markdown de hooks.md et ctas.md.
 *
 * Les bibliothèques sont en markdown parce qu'elles sont d'abord faites pour
 * être lues et enrichies à la main. Les analyser plutôt que de dupliquer leur
 * contenu en JSON évite la seule chose qui casse à coup sûr : deux sources de
 * vérité qui divergent au troisième mois.
 */
async function loadLibrary(file: string): Promise<Map<string, LibraryEntry>> {
  const text = await fs.readFile(path.join(LIBRARY_ROOT, file), 'utf8');
  const out = new Map<string, LibraryEntry>();
  for (const line of text.split('\n')) {
    const m = /^\|\s*([A-Z]\d{2})\s*\|([^|]+)\|([^|]*)\|/.exec(line.trim());
    if (!m) continue;
    const templates = (m[3].match(/`([^`]+)`/g) ?? []).map((s) => s.replace(/`/g, ''));
    out.set(m[1], { id: m[1], text: m[2].trim(), templates });
  }
  return out;
}

/** Budgets par gabarit de plan. Le plan 2 a deux zones, donc deux budgets. */
const WORD_BUDGET: Record<string, { text?: number; label?: number; sub?: number }> = {
  hook_card: { text: 8 },
  stat_card: { label: 4, sub: 6 },
  chart_card: { text: 12 },
  cta_card: { text: 6 },
  compare_card: { text: 12 },
};

/**
 * Une seule occurrence suffit à faire classer le compte comme promotion de jeu
 * d'argent, et la portée perdue ne revient pas. C'est la vérification qui compte
 * le plus de tout le fichier.
 */
const BANNED = [
  'bet', 'bets', 'betting', 'bettor', 'bettors', 'spread', 'parlay',
  'wager', 'wagers', 'lock', 'locks', 'guaranteed', 'edge', 'pick', 'picks',
  'tip', 'tips', 'prediction', 'predictions', 'sportsbook', 'bookmaker',
];

const DURATION_MIN = 12;
const DURATION_MAX = 28;

function words(s: unknown): number {
  return String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

async function main() {
  const dateKey = arg('date') ?? new Date().toISOString().slice(0, 10);
  // Réécrire une phrase à la main est un usage prévu et encouragé — c'est là
  // que ton oreille bat la bibliothèque. Mais la durée d'un plan se déduit du
  // nombre de mots et pilote ffmpeg à l'étape 6 : la laisser dériver produirait
  // des plans qu'on n'a pas le temps de lire. `--fix` la recalcule sur place.
  const fixDurations = process.argv.slice(2).includes('--fix');
  const dir = path.join(OUTPUT_ROOT, dateKey);

  const posts = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8'));
  const candidatesFile = JSON.parse(await fs.readFile(path.join(dir, 'candidates.json'), 'utf8'));
  const byId = new Map<string, any>(candidatesFile.candidates.map((c: any) => [c.id, c]));

  const hookLib = await loadLibrary('hooks.md');
  const ctaLib = await loadLibrary('ctas.md');

  let history: any[] = [];
  try {
    const all = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
    // Strictement antérieur au jour contrôlé. Sans ce filtre, relancer le
    // contrôle après avoir journalisé les publications du jour signale comme
    // doublons les posts qu'on vient justement de publier.
    history = all.filter((h: any) => h.date < dateKey);
  } catch { /* premier passage */ }

  const errors: string[] = [];
  const warnings: string[] = [];
  const fixed: string[] = [];
  const hooks: string[] = [];
  const ctas: string[] = [];

  for (const post of posts.posts) {
    const tag = post.candidate_id;
    const candidate = byId.get(tag);
    if (!candidate) { errors.push(`${tag} : candidat introuvable dans candidates.json`); continue; }

    // 1. Aucun chiffre ne peut venir d'ailleurs que du bloc facts.
    for (const key of post.numbers_used ?? []) {
      if (!(key in candidate.facts)) {
        errors.push(`${tag} : "${key}" déclaré dans numbers_used mais absent des facts`);
      }
    }
    if (!post.numbers_used || post.numbers_used.length === 0) {
      warnings.push(`${tag} : numbers_used vide — impossible de tracer les chiffres`);
    }

    // 2. Budgets de mots.
    let total = 0;
    let hasComparison = false;
    for (const slide of post.slides) {
      total += Number(slide.duration) || 0;
      const budget = WORD_BUDGET[slide.template];
      if (!budget) { errors.push(`${tag} plan ${slide.n} : gabarit inconnu "${slide.template}"`); continue; }
      for (const [field, max] of Object.entries(budget)) {
        const n = words(slide[field]);
        if (n > (max as number)) {
          errors.push(`${tag} plan ${slide.n} : ${field} = ${n} mots, maximum ${max}`);
        }
      }
      if (slide.template === 'stat_card' && words(slide.sub) > 0) hasComparison = true;

      // 3. Cohérence durée / longueur, la valeur pilotant ffmpeg à l'étape 6.
      const textWords = words(slide.text) || words(slide.label) + words(slide.sub);
      // Le plan CTA n'affiche plus que le logo et le domaine : sa durée ne peut
      // plus se déduire d'un texte qui n'apparaît pas. Le champ `text` reste
      // dans posts.json — il documente le CTA retenu et nourrit la légende —
      // mais 2.5 s suffisent pour lire un logo.
      const expected = slide.template === 'cta_card'
        ? 2.5
        : Math.round((2.0 + 0.3 * textWords) * 10) / 10;
      if (Math.abs(Number(slide.duration) - expected) > 0.05) {
        if (fixDurations) {
          fixed.push(`${tag} plan ${slide.n} : ${slide.duration}s → ${expected}s`);
          slide.duration = expected;
          total += expected - Number(slide.duration || 0);
        } else if (Math.abs(Number(slide.duration) - expected) > 0.6) {
          warnings.push(
            `${tag} plan ${slide.n} : durée ${slide.duration}s pour ${textWords} mots ` +
            `(formule : ${expected}s) — relance avec --fix pour corriger`,
          );
        }
      }
    }

    if (!hasComparison) {
      errors.push(`${tag} : aucun point de comparaison sur le plan chiffré`);
    }
    if (total < DURATION_MIN || total > DURATION_MAX) {
      errors.push(`${tag} : durée totale ${total.toFixed(1)}s hors de [${DURATION_MIN}, ${DURATION_MAX}]`);
    }

    // 4. Vocabulaire interdit, partout — plans, légendes, hashtags.
    const haystack = [
      ...post.slides.map((s: any) => `${s.text ?? ''} ${s.label ?? ''} ${s.sub ?? ''}`),
      post.caption_tiktok, post.caption_instagram, (post.hashtags ?? []).join(' '),
    ].join(' ').toLowerCase();
    for (const word of BANNED) {
      if (new RegExp(`\\b${word}\\b`).test(haystack)) {
        errors.push(`${tag} : mot interdit "${word}" — risque de classement gambling`);
      }
    }

    // 5. Mode rétrospectif : le millésime doit être présent.
    if (posts.retrospective && !post.season_label) {
      errors.push(`${tag} : season_label manquant alors que retrospective vaut true`);
    }

    // 6. Légendes.
    for (const field of ['caption_tiktok', 'caption_instagram']) {
      if (!post[field]) { errors.push(`${tag} : ${field} manquante`); continue; }
      if (!String(post[field]).includes('arakice.com')) {
        warnings.push(`${tag} : ${field} ne renvoie pas vers arakice.com`);
      }
    }
    const tags = post.hashtags ?? [];
    if (tags.length < 5 || tags.length > 8) {
      warnings.push(`${tag} : ${tags.length} hashtags, attendu entre 5 et 8`);
    }

    // 7. Les identifiants de bibliothèque existent-ils vraiment ?
    //
    // Sans ce contrôle, une coquille dans un hook_id passe sans bruit : le
    // texte du plan 1 est correct, la référence pointe dans le vide, et la
    // rotation des hooks devient impossible à vérifier.
    const hook = hookLib.get(post.hook_id);
    if (!hook) {
      errors.push(`${tag} : hook_id "${post.hook_id}" absent de hooks.md`);
    } else {
      if (hook.templates.length > 0 && !hook.templates.includes(candidate.template)) {
        errors.push(
          `${tag} : hook ${post.hook_id} incompatible avec le gabarit ${candidate.template} ` +
          `(prévu pour ${hook.templates.join(', ')})`,
        );
      }
      // Comparaison hors variables : le hook est un moule, pas un texte figé.
      const skeleton = (s: string) => s.toLowerCase().replace(/\{[^}]+\}/g, '')
        .replace(/[^a-z ]/g, '').split(/\s+/).filter((w) => w.length > 3);
      const expected = skeleton(hook.text);
      const actual = new Set(skeleton(post.slides[0]?.text ?? ''));
      const missing = expected.filter((w) => !actual.has(w));
      // Simple constat, pas un reproche : reformuler un hook est prévu. Le
      // signal ne sert qu'à repérer un hook_id resté sur une phrase entièrement
      // réécrite, auquel cas la rotation des hooks ne veut plus rien dire.
      if (expected.length > 0 && missing.length > expected.length / 2) {
        warnings.push(
          `${tag} : plan 1 reformulé, ne ressemble plus au hook ${post.hook_id} — ` +
          `vérifie que l'identifiant reste le bon`,
        );
      }
    }
    if (!ctaLib.has(post.cta_id)) {
      errors.push(`${tag} : cta_id "${post.cta_id}" absent de ctas.md`);
    }

    // 8. Fenêtre de réemploi, entre les jours cette fois.
    const recentHook = history.find(
      (h) => h.hook_id === post.hook_id
        && (Date.now() - new Date(h.date).getTime()) / 86_400_000 <= HOOK_COOLDOWN_DAYS,
    );
    if (recentHook) {
      errors.push(
        `${tag} : hook ${post.hook_id} déjà publié le ${recentHook.date} ` +
        `(délai minimum ${HOOK_COOLDOWN_DAYS} jours)`,
      );
    }
    const recentEntity = history.find(
      (h) => h.candidate_id === post.candidate_id
        && (Date.now() - new Date(h.date).getTime()) / 86_400_000 <= 14,
    );
    if (recentEntity) {
      warnings.push(`${tag} : sujet déjà publié le ${recentEntity.date}`);
    }

    hooks.push(post.hook_id);
    ctas.push(post.cta_id);
  }

  // 7. Répétitions à l'intérieur du lot.
  const dupes = (list: string[]) =>
    [...new Set(list.filter((v, i) => list.indexOf(v) !== i))];
  dupes(hooks).forEach((h) => errors.push(`hook ${h} utilisé plusieurs fois dans le même lot`));
  dupes(ctas).filter((c) => c !== 'T01')
    .forEach((c) => warnings.push(`CTA ${c} répété (seul T01 peut revenir librement)`));

  // Rapport
  console.log(`\ncheck-posts — ${dateKey}`);
  console.log(`  ${posts.posts.length} posts, ${(posts.skipped ?? []).length} écartés`);

  if (fixed.length > 0) {
    await fs.writeFile(path.join(dir, 'posts.json'), JSON.stringify(posts, null, 2), 'utf8');
    console.log(`\n  ${fixed.length} durée(s) recalculée(s) :`);
    fixed.forEach((f) => console.log(`    · ${f}`));
  }
  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} avertissement(s) :`);
    warnings.forEach((w) => console.log(`    · ${w}`));
  }
  if (errors.length > 0) {
    console.log(`\n  ${errors.length} ERREUR(S) :`);
    errors.forEach((e) => console.log(`    ✗ ${e}`));
    console.log('\n  Corrige avant de passer au rendu.\n');
    process.exit(1);
  }
  console.log(`\n  Aucune erreur. Prêt pour l'étape 5.\n`);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
