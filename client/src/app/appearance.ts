/**
 * appearance.ts — le thème clair/sombre, et l'unique interrupteur qui décide
 * s'il y a encore un choix à faire.
 *
 * Le mode clair est retiré de l'INTERFACE le 2026-09-18, pas du code. Il
 * n'était posé qu'à moitié — seuls le profil et le constructeur de coupon le
 * lisaient, tous les autres écrans restaient sombres — et un thème appliqué à
 * moitié se lit comme un bogue d'affichage, pas comme un réglage. Le CSS
 * (`profile-light`, `bet-light`, `home-light`, `league-light`) reste en place :
 * le remettre un jour est un booléen, pas une fouille archéologique.
 *
 * ⚠️ Tant que `LIGHT_MODE_ENABLED` est `false`, `readMode()` renvoie "dark"
 * QUOI QU'IL Y AIT dans localStorage. C'est volontaire : quelqu'un qui avait
 * laissé son app en clair resterait sinon coincé sur un thème dont
 * l'interrupteur a disparu. La clé n'est PAS effacée pour autant — le jour du
 * retour, son choix est toujours là.
 */

export type AppearanceMode = "dark" | "light";

/** Le mode clair est-il proposé à l'utilisateur ? La seule ligne à changer. */
export const LIGHT_MODE_ENABLED = false;

/** Clé partagée par tous les écrans qui s'habillent. */
const STORAGE_KEY = "iceedge_mode";

/** Le mode à appliquer maintenant. Toujours "dark" tant que le clair est off. */
export function readMode(): AppearanceMode {
  if (!LIGHT_MODE_ENABLED) return "dark";
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Enregistre le choix. Sans effet tant que le clair est off. */
export function writeMode(mode: AppearanceMode): void {
  if (!LIGHT_MODE_ENABLED) return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* mode privé, quota plein : le thème de la session reste celui à l'écran */
  }
}
