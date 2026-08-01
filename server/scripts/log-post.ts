/**
 * log-post.ts — étape 8, la boucle de retour
 * ===========================================
 * Enregistre ce qui a été RÉELLEMENT publié dans content/data/history.json.
 *
 * Usage :
 *   npm run content:log -- --date=2026-08-01 --posts=1,3
 *   npm run content:log -- --date=2026-08-01 --posts=suzuki,boston-bruins
 *   npm run content:log -- --date=2026-08-01 --list
 *
 * POURQUOI CE SCRIPT EXISTE. `mine-stories.ts` consacre 20 % du score de
 * sélection à la nouveauté : il pénalise une entité déjà couverte depuis moins
 * de 14 jours, une équipe depuis moins de 4, un gabarit depuis moins de 3. Cette
 * mécanique lit `history.json`. Tant que personne n'écrit ce fichier, elle
 * cherche dans le vide et ne pénalise rien — un cinquième du barème est inerte.
 *
 * Le défaut ne se voit pas le premier jour. Il se voit au bout de trois
 * semaines, quand le compte a parlé quatre fois du même joueur sans que rien ne
 * l'ait signalé.
 *
 * ON NE JOURNALISE QUE CE QUI EST PUBLIÉ, jamais tout le posts.json. Le pipeline
 * produit huit scripts pour une ou deux vidéos par jour : pénaliser les six
 * autres reviendrait à écarter des angles qui n'ont jamais été vus.
 */

import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'content', 'output');
const HISTORY_PATH = path.join(REPO_ROOT, 'content', 'data', 'history.json');

interface HistoryEntry {
  date: string;
  candidate_id: string;
  entity: string;
  team: string | null;
  template: string;
  hook_id: string;
  cta_id: string;
  /** Rempli à la main vers J+7. Après 30-40 posts, permet de recalibrer le
   *  barème sur des données réelles plutôt que sur des intuitions. */
  views: number | null;
}

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  const dateKey = arg('date') ?? new Date().toISOString().slice(0, 10);
  const dir = path.join(OUTPUT_ROOT, dateKey);

  const posts = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8'));
  const candidates = JSON.parse(await fs.readFile(path.join(dir, 'candidates.json'), 'utf8'));
  const byId = new Map<string, any>(candidates.candidates.map((c: any) => [c.id, c]));

  if (hasFlag('list') || !arg('posts')) {
    console.log(`\nPosts disponibles pour le ${dateKey} :\n`);
    posts.posts.forEach((p: any, i: number) => {
      const c = byId.get(p.candidate_id);
      console.log(`  ${String(i + 1).padStart(2)}. ${c?.entity.name ?? '?'} — ${c?.template ?? '?'} (hook ${p.hook_id})`);
    });
    console.log(`\nJournalise ceux que tu as publiés :`);
    console.log(`  npm run content:log -- --date=${dateKey} --posts=1,3\n`);
    return;
  }

  // Sélection par index (1-based) ou par fragment d'identifiant.
  const selectors = arg('posts')!.split(',').map((s) => s.trim()).filter(Boolean);
  const selected: any[] = [];
  for (const sel of selectors) {
    const asIndex = Number(sel);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= posts.posts.length) {
      selected.push(posts.posts[asIndex - 1]);
      continue;
    }
    const match = posts.posts.filter((p: any) => p.candidate_id.includes(sel));
    if (match.length === 0) throw new Error(`Aucun post ne correspond à "${sel}"`);
    if (match.length > 1) {
      throw new Error(`"${sel}" correspond à ${match.length} posts — précise davantage`);
    }
    selected.push(match[0]);
  }

  let history: HistoryEntry[] = [];
  try { history = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8')); } catch { /* premier passage */ }

  const already = new Set(history.map((h) => `${h.date}|${h.candidate_id}`));
  const added: HistoryEntry[] = [];

  for (const post of selected) {
    const key = `${dateKey}|${post.candidate_id}`;
    if (already.has(key)) {
      console.log(`  déjà journalisé, ignoré : ${post.candidate_id}`);
      continue;
    }
    const c = byId.get(post.candidate_id);
    added.push({
      date: dateKey,
      candidate_id: post.candidate_id,
      entity: c?.entity.name ?? post.candidate_id,
      team: c?.entity.team ?? null,
      template: c?.template ?? 'unknown',
      hook_id: post.hook_id,
      cta_id: post.cta_id,
      views: null,
    });
    already.add(key);
  }

  // Antéchronologique : mine-stories parcourt le fichier en cherchant les
  // occurrences récentes, autant qu'il les trouve tout de suite.
  const merged = [...added, ...history]
    .sort((a, b) => b.date.localeCompare(a.date));

  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(merged, null, 2), 'utf8');

  console.log(`\n  ${added.length} entrée(s) ajoutée(s), ${merged.length} au total.`);
  added.forEach((e) => console.log(`    ${e.date}  ${e.entity} (${e.template}, hook ${e.hook_id})`));
  console.log(`\n  content\\data\\history.json`);
  console.log(`  Pense à remplir "views" vers J+7 : après 30-40 posts, le barème`);
  console.log(`  se recalibre sur des chiffres réels plutôt que sur des intuitions.\n`);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
