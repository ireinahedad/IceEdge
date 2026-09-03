/**
 * moderation.service.ts — R4.2a. Le filtre de contenu objectionnable.
 *
 * Guideline 1.2 d'Apple demande « un filtre pour le contenu objectionnable ».
 * Zéro dépendance : le serveur reste léger et la liste est lisible et modifiable
 * sans passer par npm.
 *
 * ── Pourquoi une normalisation, et pas un simple `includes()` ────────────────
 *
 * Un `text.includes(mot)` échoue des DEUX côtés à la fois :
 *
 *   • Faux négatifs — « f u c k », « f.u.c.k », « fvck », « pu55y », « FUUUCK »
 *     passent tous à travers. Un filtre contournable en trois secondes donne une
 *     fausse assurance, ce qui est pire que pas de filtre.
 *   • Faux positifs — et ici le cas est fatal : `assist` contient `ass`. C'est le
 *     mot le plus courant d'un chat de hockey. Viennent ensuite `passing`,
 *     `class`, `glass`, `Massachusetts`. Le filtre bloquerait « nice assist ».
 *
 * D'où deux passes :
 *
 *   1. Frontières de mots sur un texte normalisé. C'est elle qui fait tout le
 *      travail courant, et c'est elle qui sauve `assist` : `\bas\b` ne peut pas
 *      matcher au milieu de `asist`.
 *   2. Une passe « dé-espacée » qui ne s'applique QU'AUX suites de lettres
 *      isolées séparées par de la ponctuation (« f u c k », « f-u-c-k »). Ne
 *      jamais dé-espacer le texte entier : « class ass » deviendrait un seul mot
 *      et fabriquerait des correspondances qui n'existent pas.
 *
 * ── Bilingue, parce que l'app l'est ─────────────────────────────────────────
 * L'interface est EN + FR. Un filtre anglophone seul laisserait passer
 * exactement la moitié qui compte pour un produit de hockey francophone.
 */

/** Ce que le filtre a trouvé. `matches` sert au passage à blanc et aux tests. */
export interface ModerationVerdict {
  blocked: boolean;
  matches: string[];
}

/**
 * Confusables clavier. Appliqué APRÈS le passage en minuscules.
 * `1 → i` plutôt que `l` : « 1 » remplace bien plus souvent un i dans ce registre.
 */
const CONFUSABLES: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
};

/**
 * Normalise pour la comparaison. Appliqué au texte ET aux termes, sinon les deux
 * côtés ne parlent pas la même langue.
 *
 * L'effondrement des répétitions (`fuuuck` → `fuck`) déforme aussi les mots
 * ordinaires — `assist` devient `asist` — et c'est sans conséquence tant que les
 * termes subissent le même traitement : `ass` devient `as`, qui ne se trouve pas
 * dans `asist` une fois les frontières de mots exigées.
 */
function fold(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')       // accents : « enculé » → « encule »
    .toLowerCase()
    .replace(/[013457@$!|+]/g, (c) => CONFUSABLES[c] ?? c)
    .replace(/(.)\1+/g, '$1');                // « fuuuck » → « fuck »
}

/**
 * Termes bloqués, sous leur forme NON normalisée — `fold()` s'en charge au
 * chargement. Regroupés par famille pour que le réglage soit lisible.
 *
 * Volontairement ABSENTS : les jurons doux (`damn`, `hell`, `merde`). Apple
 * demande un filtre pour le contenu *objectionnable*, pas un cours de politesse,
 * et bloquer le juron ambiant d'un chat sportif ne produirait que de la
 * frustration et des signalements « c'est un bug ».
 *
 * ⚠️ AVANT D'AJOUTER UN TERME COURT, LE REPLIER MENTALEMENT.
 * `fold()` écrase les lettres répétées, donc `ass` devient `as` — un des mots
 * les plus courants de l'anglais, et « as » en français. L'ajouter ici
 * bloquerait une phrase sur deux. C'est pourquoi la liste porte `asshole` et
 * jamais `ass`. Un test de non-régression verrouille ce cas précis ; tout terme
 * dont la forme repliée descend sous quatre lettres mérite le même examen.
 */
const TERMS = {
  sexuel_en:   ['pussy', 'dick', 'cock', 'cum', 'blowjob', 'whore', 'slut'],
  injures_en:  ['fuck', 'motherfucker', 'cunt', 'bitch', 'asshole', 'bastard', 'shit'],
  slurs_en:    ['fag', 'faggot', 'nigger', 'nigga', 'retard', 'tranny', 'kike', 'spic', 'chink'],
  injures_fr:  ['enculé', 'connard', 'connasse', 'salope', 'pute', 'putain', 'batard',
                'niquer', 'nique', 'encule', 'trouduc', 'ducon'],
  sacres_qc:   ['tabarnak', 'tabarnac', 'câlisse', 'calisse', 'crisse', 'ostie', 'hostie',
                'ciboire', 'esti'],
  slurs_fr:    ['pédé', 'pede', 'tapette', 'bougnoule', 'négro', 'negro'],
} as const;

/**
 * Suffixes tolérés après un terme.
 *
 * Les terminaisons françaises sont indispensables et ne se devinent pas depuis
 * une liste anglophone : le terme replié `encule` doit attraper « enculer »
 * (infinitif), « enculez », « enculée ». Sans `r`, « va te faire enculer »
 * passait — c'est le premier test qui est tombé.
 */
const SUFFIXES = '(?:s|es|ed|ing|er|ers|in|a|y|r|z|e|ee|ent|ons|ez|ait)?';

/**
 * Exceptions. Un mot listé ici ne déclenche jamais, quoi qu'il contienne.
 *
 * ⚠️ Cette liste est faite pour être REMPLIE À PARTIR DU PASSAGE À BLANC, pas
 * devinée à l'avance. Le script `scripts/moderation-dry-run.ts` rejoue le filtre
 * sur les vrais messages et montre ce qu'il aurait bloqué ; tout faux positif
 * qui en sort atterrit ici AVANT que le filtre soit activé, jamais après.
 *
 * Les frontières de mots règlent déjà `assist`, `passing` et `class` — ils sont
 * cités dans les tests, pas ici.
 */
const ALLOWED = new Set<string>([
  // à compléter depuis le passage à blanc
].map(fold));

/** Termes normalisés, dédoublonnés, du plus long au plus court. */
const FOLDED_TERMS: string[] = [...new Set(
  Object.values(TERMS).flat().map(fold),
)].sort((a, b) => b.length - a.length);

const WORD_PATTERNS: RegExp[] = FOLDED_TERMS.map(
  (t) => new RegExp(`\\b${escapeRegExp(t)}${SUFFIXES}\\b`),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Suites de lettres isolées séparées par autre chose que des lettres :
 * « f u c k », « f.u.c.k », « f-u-c-k ». Au moins trois lettres, sinon des
 * initiales ordinaires (« J. M. » ) seraient recollées.
 */
const SPACED_RUN = /(?:[a-z][^a-z]{1,3}){2,}[a-z]/g;

/** Inspecte un texte. `matches` liste les termes déclenchés, pour le passage à blanc. */
export function inspect(text: string): ModerationVerdict {
  if (!text) return { blocked: false, matches: [] };

  const folded = fold(text);
  const matches = new Set<string>();

  // Passe 1 — frontières de mots. C'est elle qui protège « assist ».
  for (let i = 0; i < WORD_PATTERNS.length; i++) {
    const hit = folded.match(WORD_PATTERNS[i]);
    if (hit && !ALLOWED.has(hit[0])) matches.add(FOLDED_TERMS[i]);
  }

  // Passe 2 — uniquement à l'intérieur des suites délibérément espacées.
  const runs = folded.match(SPACED_RUN);
  if (runs) {
    for (const run of runs) {
      const squeezed = run.replace(/[^a-z]/g, '');
      if (ALLOWED.has(squeezed)) continue;
      for (const term of FOLDED_TERMS) {
        if (squeezed.includes(term)) matches.add(term);
      }
    }
  }

  return { blocked: matches.size > 0, matches: [...matches] };
}

/** Le prédicat utilisé par l'insertion de message (R4.2b). */
export function containsProhibited(text: string): boolean {
  return inspect(text).blocked;
}
