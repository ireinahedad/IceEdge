// ============================================================
//  Gardien partant : nom saisi → identifiant NHL
// ============================================================
// La saisie du jour (`starting_goalies`) stocke un NOM, choisi dans l'effectif
// NHL ou tapé à la main. Le service ML apparie le partant à son état
// d'inférence ; par nom, une orthographe différente (accents, surnom,
// changement de nom) faisait passer le titulaire pour un gardien de RELÈVE —
// 6e feature du modèle de score (ml/INCOHERENCES_ML.md §3). Par identifiant,
// l'appariement ne dépend plus de l'orthographe : MoneyPuck, qui produit
// l'état d'inférence, reprend les identifiants NHL.
//
// Le nom reste envoyé : il sert de repli tant que l'état d'inférence n'a pas
// encore d'identifiants de gardiens (états produits avant le 2026-10-02).

import { fetchTeamGoalies } from './nhlApiClient';
import { nameKeys } from './officialLineup';

/**
 * Identifiant NHL du gardien `name` dans l'effectif de `abbr`, ou `undefined`
 * (nom vide, effectif indisponible, gardien introuvable). Ne lève jamais :
 * sans identifiant, le service retombe sur le nom.
 *
 * Nom complet sans accents d'abord ; « initiale + nom » ensuite, mais seulement
 * s'il ne désigne qu'UN gardien de l'effectif (sinon on ne devine pas).
 */
export async function resolveGoalieId(abbr: string, name: string | undefined): Promise<number | undefined> {
  const keys = nameKeys(name ?? '');
  if (!abbr || keys.length === 0) return undefined;
  let goalies;
  try {
    goalies = await fetchTeamGoalies(abbr);
  } catch {
    return undefined;
  }
  const full = goalies.filter((g) => nameKeys(g.name)[0] === keys[0]);
  if (full.length === 1) return full[0].id;
  if (full.length > 1 || keys.length < 2) return undefined;
  const short = goalies.filter((g) => nameKeys(g.name).includes(keys[1]));
  return short.length === 1 ? short[0].id : undefined;
}
