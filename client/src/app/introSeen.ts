/**
 * « Le visiteur a déjà passé la patinoire d'accueil » (IntroLanding), retenu
 * pour la SESSION de l'onglet : le logo et les liens vers `/` ne le ramènent
 * plus sur la patinoire, mais une nouvelle visite la remontre.
 *
 * Module à part, et non dans IntroLanding.tsx : LoginPage (chargée d'office)
 * s'en sert aussi, et importer IntroLanding la ferait entrer dans le bundle
 * principal alors qu'elle est en lazy.
 */
const INTRO_SEEN_KEY = "arakice_intro_seen";

export function introSeen(): boolean {
  try { return sessionStorage.getItem(INTRO_SEEN_KEY) === "1"; } catch { return false; }
}

export function markIntroSeen(): void {
  try { sessionStorage.setItem(INTRO_SEEN_KEY, "1"); } catch { /* navigation privée */ }
}
