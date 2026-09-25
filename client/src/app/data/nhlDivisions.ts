/**
 * nhlDivisions.ts — conférences et divisions de la LNH, par abréviation.
 *
 * Table STATIQUE plutôt que le champ `division` des réponses du serveur : ce
 * champ vient du classement (`divisionName`), vide hors saison et absent des
 * lignes de `getAllTeamsSeason`. Or le regroupement doit tenir toute l'année,
 * et sur les trois écrans qui s'en servent (Stats · accueil Statistiques ·
 * toutes les équipes). L'alignement ne bouge qu'à une expansion ou un
 * déménagement — ARI est gardé pour les saisons archivées (Utah = UTA depuis
 * 2024-25).
 *
 * Ordre d'affichage = ordre de ce tableau : Est (Atlantique, Métropolitaine)
 * puis Ouest (Centrale, Pacifique).
 */

export type Conference = "east" | "west";
export type Division = "atlantic" | "metropolitan" | "central" | "pacific";

export const DIVISIONS: { key: Division; conference: Conference; teams: string[] }[] = [
  { key: "atlantic",     conference: "east", teams: ["BOS", "BUF", "DET", "FLA", "MTL", "OTT", "TBL", "TOR"] },
  { key: "metropolitan", conference: "east", teams: ["CAR", "CBJ", "NJD", "NYI", "NYR", "PHI", "PIT", "WSH"] },
  { key: "central",      conference: "west", teams: ["ARI", "CHI", "COL", "DAL", "MIN", "NSH", "STL", "UTA", "WPG"] },
  { key: "pacific",      conference: "west", teams: ["ANA", "CGY", "EDM", "LAK", "SEA", "SJS", "VAN", "VGK"] },
];

export const CONFERENCES: Conference[] = ["east", "west"];

const BY_ABBR = new Map<string, Division>(
  DIVISIONS.flatMap((d) => d.teams.map((abbr) => [abbr, d.key] as const)),
);

/** Division d'un club (`undefined` si l'abréviation est inconnue). */
export function divisionOf(abbr?: string): Division | undefined {
  return abbr ? BY_ABBR.get(abbr.toUpperCase()) : undefined;
}

/** Conférence d'une division. */
export function conferenceOf(division: Division): Conference {
  return DIVISIONS.find((d) => d.key === division)!.conference;
}

/** Clés i18n — libellé long (en-têtes, filtres) et court (étiquette à côté d'un club). */
export const divisionLabelKey = (d: Division) => `div.${d}`;
export const divisionShortKey = (d: Division) => `div.${d}.short`;
export const conferenceLabelKey = (c: Conference) => `conf.${c}`;
