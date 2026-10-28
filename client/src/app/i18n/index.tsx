/**
 * i18n — lightweight English/French translation layer.
 *
 * Usage:
 *   const { t, lang, setLang } = useI18n();
 *   <span>{t("nav.home")}</span>
 *
 * The language is persisted in localStorage and applied app-wide.
 * Unknown keys fall back to English, then to the key itself.
 */

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { isIOS } from "../platform";

export type Lang = "en" | "fr";
const STORAGE_KEY = "iceedge_lang";

/**
 * La langue du navigateur, quand l'utilisateur n'a encore rien choisi.
 *
 * Jusqu'au 2026-09-08 le repli était `"en"` en dur : un iPhone configuré en
 * français démarrait en anglais, et il fallait trouver le sélecteur pour
 * revenir dans sa langue. Le choix explicite (localStorage) reste prioritaire —
 * quelqu'un qui a mis l'anglais sur un téléphone français le garde.
 *
 * `navigator.languages` avant `navigator.language` : la liste reflète l'ordre
 * de préférence réel, et sur iOS un appareil réglé en français avec l'anglais
 * en second y apparaît dans le bon ordre. Tout ce qui commence par `fr`
 * (`fr-CA`, `fr-FR`…) compte ; le reste tombe en anglais, qui est la langue
 * complète du dictionnaire.
 */
function detectLang(): Lang {
  try {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const tag of list) {
      if (typeof tag === "string" && tag.toLowerCase().startsWith("fr")) return "fr";
    }
  } catch { /* pas de navigator (rendu hors navigateur) */ }
  return "en";
}

const DICT: Record<string, { en: string; fr: string }> = {
  // ── Navigation ──
  "nav.home":    { en: "Home",    fr: "Accueil" },
  "nav.stats":   { en: "Stats",   fr: "Stats" },
  "nav.slip":    { en: "Slip",    fr: "Pari" },
  "nav.league":  { en: "Community",  fr: "Communauté" },
  "nav.profile": { en: "Profile", fr: "Profil" },

  // ── Common ──
  "common.save":    { en: "Save Changes", fr: "Enregistrer" },
  "common.saving":  { en: "Saving…",      fr: "Enregistrement…" },
  "common.saved":   { en: "Saved!",       fr: "Enregistré !" },
  "common.cancel":  { en: "Cancel",       fr: "Annuler" },
  "common.close":   { en: "Close",        fr: "Fermer" },
  "common.back":    { en: "Back",         fr: "Retour" },
  "common.loading": { en: "Loading…",     fr: "Chargement…" },
  "common.members": { en: "members",      fr: "membres" },
  "common.online":  { en: "online",       fr: "en ligne" },
  "common.retry":   { en: "Try again",    fr: "Réessayer" },
  "chat.sendFailed": { en: "Message not sent \u2014 your text is back in the box.", fr: "Message non envoyé \u2014 votre texte est revenu dans la zone de saisie." },
  // Les trois issues d'échec de la connexion Google. Le serveur les met dans
  // `?error=` ; jusqu'au 2026-09-08 l'écran de connexion les ignorait purement
  // et simplement, donc un refus Google ramenait sur un formulaire muet.
  "login.googleDenied":     { en: "Google sign-in was cancelled.", fr: "La connexion Google a été annulée." },
  "login.googleFailed":     { en: "Google sign-in failed. Try again, or use your e-mail and password.", fr: "La connexion Google a échoué. Réessayez, ou utilisez votre e-mail et votre mot de passe." },
  "login.googleUnverified": { en: "This Google account\u2019s e-mail address is not verified. Verify it with Google, or sign in with your e-mail and password.", fr: "L\u2019adresse de ce compte Google n\u2019est pas vérifiée. Vérifiez-la chez Google, ou connectez-vous avec votre e-mail et votre mot de passe." },
  // Les trois clés de l'état d'erreur partagé (`ErrorState`). Le titre reste
  // vague à dessein : l'utilisateur n'a rien à faire d'un code HTTP, et le
  // détail technique part déjà dans la console.
  "common.loadFailed":     { en: "Couldn\u2019t load this.", fr: "Impossible de charger ça." },
  "common.loadFailedHint": { en: "Check your connection, then try again.", fr: "Vérifiez votre connexion, puis réessayez." },
  "common.timedOut":       { en: "The connection is taking too long.", fr: "La connexion prend trop de temps." },

  // ── Profile ──
  "profile.title":        { en: "Profile",       fr: "Profil" },
  "profile.overview":     { en: "Overview",      fr: "Aperçu" },
  "profile.settings":     { en: "Settings",      fr: "Paramètres" },
  "profile.signout":      { en: "Sign Out",      fr: "Déconnexion" },
  "profile.security":     { en: "Security",      fr: "Sécurité" },
  "profile.signoutAll":   { en: "Log out of all devices", fr: "Se déconnecter de tous les appareils" },
  "profile.signoutAllDesc": { en: "Ends your session everywhere — you'll need to sign in again on each device.", fr: "Met fin à votre session partout — vous devrez vous reconnecter sur chaque appareil." },
  "profile.signoutAllConfirm": { en: "Log out of all devices?", fr: "Se déconnecter de tous les appareils ?" },
  "account.delete":        { en: "Delete my account", fr: "Supprimer mon compte" },
  "account.deleteDesc":    { en: "Permanently erases your account, slips, chat messages and AI key. This cannot be undone.", fr: "Efface définitivement votre compte, vos coupons, vos messages de chat et votre clé IA. C'est irréversible." },
  "account.deleteTitle":   { en: "Delete your account?", fr: "Supprimer votre compte ?" },
  "account.deleteWhat":    { en: "Deletion is immediate and permanent. Your account, slips, chat messages, AI key and settings are erased. There is no recovery.", fr: "La suppression est immédiate et définitive. Votre compte, vos coupons, vos messages de chat, votre clé IA et vos réglages sont effacés. Aucune récupération possible." },
  "account.deleteSub":     { en: "Your Pro subscription will be cancelled right away, with no further charge.", fr: "Votre abonnement Pro sera annulé immédiatement, sans autre prélèvement." },
  "account.deleteContinue":{ en: "Continue", fr: "Continuer" },
  "account.passwordPrompt":{ en: "Enter your password to confirm.", fr: "Entrez votre mot de passe pour confirmer." },
  "account.codePrompt":    { en: "We emailed you a 6-digit code. Enter it to confirm.", fr: "Nous vous avons envoyé un code à 6 chiffres par courriel. Entrez-le pour confirmer." },
  "account.password":      { en: "Password", fr: "Mot de passe" },
  "account.code":          { en: "Code", fr: "Code" },
  "account.deleteForever": { en: "Delete permanently", fr: "Supprimer définitivement" },
  "account.deleting":      { en: "Deleting…", fr: "Suppression…" },
  "account.wrongPassword": { en: "Incorrect password.", fr: "Mot de passe incorrect." },
  "account.wrongCode":     { en: "Invalid or expired code.", fr: "Code invalide ou expiré." },
  "account.deleted":       { en: "Your account has been deleted.", fr: "Votre compte a été supprimé." },
  "account.deleteFailed":  { en: "Deletion failed. Nothing was deleted — please try again.", fr: "La suppression a échoué. Rien n'a été supprimé — réessayez." },
  "profile.photo":        { en: "Profile Photo", fr: "Photo de profil" },
  "profile.changePhoto":  { en: "Change photo",  fr: "Changer la photo" },
  "profile.uploading":    { en: "Uploading…",    fr: "Envoi…" },
  "profile.photoHint":    { en: "JPG, PNG or WebP · large images are compressed automatically", fr: "JPG, PNG ou WebP · les grandes images sont compressées automatiquement" },
  "profile.iceAvatar":    { en: "Or pick an ice avatar", fr: "Ou choisissez un avatar glacé" },
  "profile.choosePhoto":  { en: "Profile photo",     fr: "Photo de profil" },
  "profile.chooseEmoji":  { en: "Choose an emoji",   fr: "Choisir un emoji" },
  "profile.chooseFlag":   { en: "Choose a flag",     fr: "Choisir un drapeau" },
  "profile.flagHint":     { en: "Shown next to your name in the podium and chat", fr: "Affiché à côté de votre nom dans le podium et le chat" },
  "profile.info":         { en: "Profile Info",  fr: "Infos du profil" },
  "profile.username":     { en: "Username",      fr: "Nom d'utilisateur" },
  "profile.usernameHint": { en: "3–20 characters · lowercase letters, numbers, underscores · must be unique", fr: "3–20 caractères · minuscules, chiffres, tirets bas · doit être unique" },
  "profile.displayName":  { en: "Display Name",  fr: "Nom affiché" },
  "profile.bio":          { en: "Bio",           fr: "Bio" },
  "profile.favTeam":      { en: "Favorite Team", fr: "Équipe favorite" },
  "profile.public":       { en: "Public Profile", fr: "Profil public" },
  // Formulé à la négative : la visibilité est le défaut, se retirer est le geste
  // délibéré. Les anciennes clés showSlips/showSlipsHint sont retirées avec le
  // toggle opt-in qu'elles servaient.
  "profile.privacy":      { en: "Privacy", fr: "Confidentialité" },
  "profile.hideSlips":    { en: "Hide my slips from other players", fr: "Masquer mes paris aux autres joueurs" },
  "profile.hideSlipsHint":{ en: "Pro members can browse your settled slips. Turning this on hides all of them — your leaderboard rank is unaffected.", fr: "Les membres Pro peuvent consulter vos paris réglés. Activer ceci les masque tous — votre rang au classement n'est pas touché." },
  "profile.language":     { en: "Language",      fr: "Langue" },
  "profile.bookmaker":    isIOS ? { en: "", fr: "" } : { en: "Sportsbook",    fr: "Site de paris" },
  "profile.bookmakerHint":isIOS ? { en: "", fr: "" } : { en: "Which site the “Place bet” buttons open", fr: "Le site que les boutons « Parier » ouvrent" },
  "profile.oddsSource":   { en: "Odds shown in the app come from DraftKings. If you pick another site above, its odds may differ.", fr: "Les cotes affichées dans l'app viennent de DraftKings. Si vous choisissez un autre site ci-dessus, sa cote peut être différente." },
  // Format d'affichage des cotes. Les clés `.percent` / `.decimal` / `.american`
  // sont construites à partir de l'identifiant du format
  // (`profile.oddsFormat.${f}`) : renommer un identifiant dans
  // `services/oddsFormat.ts` sans renommer la clé ici afficherait la clé brute.
  "profile.oddsFormat":          { en: "Bookmaker odds",  fr: "Cotes des bookmakers" },
  "profile.oddsFormat.percent":  { en: "Implied %",       fr: "Probabilité implicite" },
  "profile.oddsFormat.decimal":  { en: "Decimal",         fr: "Cote décimale" },
  "profile.oddsFormat.american": { en: "American",        fr: "Cote américaine" },
  // Le libellé DIT ce que le réglage ne touche pas, et ce n'est pas du zèle :
  // sans cette phrase, quelqu'un qui choisit « cote américaine » et voit ensuite
  // « 68 % » sur une prédiction croit que le réglage est cassé. Il ne l'est pas —
  // ce 68 % n'est pas un prix mais la confiance du modèle, et la garder en %
  // est exactement ce qui permet de la comparer à la cote du livre.
  "profile.oddsFormatHint":      { en: "How bookmaker odds are written across the app. The model's own probabilities always stay in %.", fr: "Comment s'écrivent les cotes des bookmakers dans l'app. Les probabilités du modèle, elles, restent toujours en %." },
  // Compteur d'analyses IA (carte des Réglages). Le TOTAL n'apparaît dans aucune
  // de ces chaînes : il vient du serveur, qui le dérive du prix de l'abonnement.
  // L'écrire ici le figerait, et c'est exactement comme ça que « analyse IA
  // illimitée » a pu rester faux pendant des mois.
  "profile.aiUsage":       { en: "LLM Analysis & AI bet builder", fr: "Analyse LLM et Bet builder IA" },
  // Titre de la carte quand le Bet builder IA est masqué (`features.aiBetBuilder`).
  "profile.aiUsageLlm":    { en: "LLM Analysis", fr: "Analyse LLM" },
  "profile.aiUsageReset":  { en: "Resets on {date}",   fr: "Remise à zéro le {date}" },
  "profile.aiUsageOver":   { en: "Past your monthly allowance, your requests use your own OpenAI key if you've added one.", fr: "Au-delà de votre forfait mensuel, vos requêtes utilisent votre propre clé OpenAI si vous en avez ajouté une." },
  "profile.aiUsageFree":   { en: "LLM Analysis: runs on your own OpenAI key, up to {n} requests a day. Go Pro to use the built-in model.", fr: "Analyse LLM : votre propre clé OpenAI, dans la limite de {n} requêtes par jour. Passez à Pro pour utiliser le modèle intégré." },
  // Un SEUL quota Pro pour les deux fonctions IA (Analyse LLM d'un pari et
  // Bet builder IA) : la carte le dit, pour qu'un abonné ne croie pas avoir
  // deux enveloppes. Côté gratuit, les essais du Bet builder IA réutilisent
  // les textes de la feuille (`cmd.aiFreeLeft`, `cmd.aiOwnKey`) ; depuis le
  // 2026-09-29, `cmd.aiFreeLeft` n'est plus affiché QUE dans les Réglages.
  "profile.aiUsageShared": { en: "One allowance for LLM Analysis and the AI bet builder.", fr: "Un seul quota pour l'Analyse LLM et le Bet builder IA." },
  "profile.aiUsageFailed": { en: "Counter unavailable right now.", fr: "Compteur indisponible pour l'instant." },
  "profile.dark":         { en: "Dark",          fr: "Sombre" },
  "profile.light":        { en: "Light",         fr: "Clair" },
  "profile.aiSettings":   { en: "AI Settings",   fr: "Paramètres IA" },
  "profile.parlayRecord": { en: "Parlay Record", fr: "Bilan des combinés" },
  "profile.parlayWins":   { en: "Parlay Wins",   fr: "Combinés gagnés" },
  "profile.parlayLosses": { en: "Parlay Losses", fr: "Combinés perdus" },
  "profile.parlayRate":   { en: "Parlay Rate",   fr: "Taux de combinés" },
  "profile.memberSince":  { en: "ArakIce member since {date}", fr: "Membre ArakIce depuis {date}" },
  "profile.aiSettingsDesc":{ en: "Enter your OpenAI API key to use the Ask LLM feature. Your key is stored securely and used only for your requests.", fr: "Entrez votre clé API OpenAI pour utiliser la fonction Ask LLM. Votre clé est stockée en toute sécurité et utilisée uniquement pour vos requêtes." },
  "profile.getKey":       { en: "Get a key →",   fr: "Obtenir une clé →" },
  "profile.openaiKey":    { en: "OpenAI API Key", fr: "Clé API OpenAI" },
  "profile.show":         { en: "Show",          fr: "Afficher" },
  "profile.hide":         { en: "Hide",          fr: "Masquer" },
  "profile.keyStored":     { en: "A key is saved on your account", fr: "Une clé est enregistrée sur votre compte" },
  "profile.replaceKey":    { en: "Replace",                       fr: "Remplacer" },
  "profile.keyNotShown":   { en: "For your security it is never displayed again — replace it or remove it.", fr: "Par sécurité elle n'est jamais réaffichée — remplacez-la ou retirez-la." },
  "profile.keyPendingRemoval": { en: "The key will be removed when you save.", fr: "La clé sera retirée à l'enregistrement." },
  "profile.removeKey":    { en: "Remove key",    fr: "Supprimer la clé" },
  "profile.hitRateTrend": { en: "Hit Rate Trend", fr: "Tendance du taux de réussite" },
  "profile.perfByMarket": { en: "Performance by Market", fr: "Performance par marché" },
  "profile.noTrendYet":   { en: "No settled slips yet — the trend appears once your first bets are graded.", fr: "Aucun pari réglé — la tendance apparaît dès que vos premières sélections sont tranchées." },
  "profile.noMarketYet":  { en: "No settled slips yet — each market appears once you have a graded bet on it.", fr: "Aucun pari réglé — chaque marché apparaît dès qu'une sélection y a été tranchée." },
  "profile.betHistory":   { en: "Bet History",    fr: "Historique des paris" },
  "profile.filterAll":    { en: "All",            fr: "Tous" },
  "profile.filterWins":   { en: "Wins",           fr: "Gagnés" },
  "profile.filterLosses": { en: "Losses",         fr: "Perdus" },
  "profile.filterLive":   { en: "Live",           fr: "En direct" },

  // ── League / leaderboard ──
  "league.rankings":   { en: "Rankings",             fr: "Classement" },
  "league.chat":       { en: "Chat",                 fr: "Chat" },
  "league.podium":     { en: "This Season's Podium", fr: "Podium de la saison" },
  "league.podiumTap":  { en: "Tap a player to view their profile", fr: "Touchez un joueur pour voir son profil" },
  "league.searchPlayer": { en: "Search a player…",   fr: "Rechercher un joueur…" },
  "league.noPlayerFound": { en: "No player found", fr: "Aucun joueur trouvé" },
  "league.score":      { en: "Score",                fr: "Score" },
  "league.hitRate":    { en: "Hit Rate",             fr: "Réussite" },
  "league.volume":     { en: "Volume",               fr: "Volume" },
  "league.player":     { en: "Player",               fr: "Joueur" },
  "league.recentSlips":{ en: "Recent slips",         fr: "Paris récents" },
  "league.slipsPrivate": { en: "This player keeps their slips private", fr: "Ce joueur garde ses paris privés" },
  "league.noSlips":    { en: "No slips yet",         fr: "Aucun pari pour l'instant" },
  "league.you":        { en: "you",                  fr: "vous" },
  "league.bets":       { en: "Bets",                 fr: "Paris" },
  "chat.noRoomsYet":   { en: "No rooms yet",         fr: "Aucun salon" },
  "chat.noRoomsHint":  { en: "Join a public room from Discover, enter a join code above, or create your own.", fr: "Rejoignez un salon public depuis Découvrir, entrez un code d'accès ci-dessus, ou créez le vôtre." },
  "chat.nothingDiscover": { en: "Nothing to discover", fr: "Rien à découvrir" },
  "chat.noPublicRooms":{ en: "No public rooms to join right now.", fr: "Aucun salon public à rejoindre pour le moment." },

  // ── Chat ──
  "chat.myRooms":      { en: "My Rooms",             fr: "Mes salons" },
  "chat.discover":     { en: "Discover",             fr: "Découvrir" },
  "chat.sectionPublic":  { en: "Public",             fr: "Public" },
  "chat.sectionPrivate": { en: "Private",            fr: "Privé" },
  "chat.noPrivateRooms": { en: "No private rooms yet — join one with a code.", fr: "Aucun salon privé — rejoignez-en un avec un code." },
  "chat.roomColor":    { en: "Room Color",           fr: "Couleur du salon" },
  "chat.deleteMessageConfirm": { en: "Delete this message?", fr: "Supprimer ce message ?" },

  // Les quatre confirmations qui passaient par `window.confirm()` jusqu'au
  // 2026-09-08. En WKWebView ce dialogue affiche le NOM DE DOMAINE en titre et
  // bloque le fil JavaScript ; il n'était de surcroît pas traduit — les trois
  // formulations vivaient en anglais en dur dans le code.
  "chat.deleteMessageConfirmCta": { en: "Delete",  fr: "Supprimer" },
  "chat.leaveRoomTitle":       { en: "Leave {name}?", fr: "Quitter {name} ?" },
  "chat.leaveRoomDescription": { en: "You can come back later with the room's join code.", fr: "Vous pourrez revenir plus tard avec le code d'accès du salon." },
  "chat.leaveRoomCta":         { en: "Leave",     fr: "Quitter" },
  "chat.deleteRoomTitle":      { en: "Delete {name} for everyone?", fr: "Supprimer {name} pour tout le monde ?" },
  "chat.deleteRoomDescription":{ en: "This cannot be undone — the room and all its messages disappear for every member.", fr: "C'est définitif — le salon et tous ses messages disparaissent pour tous les membres." },
  "chat.deleteRoomCta":        { en: "Delete",    fr: "Supprimer" },
  "chat.removeMemberTitle":    { en: "Remove {name} from the room?", fr: "Retirer {name} du salon ?" },
  "chat.removeMemberDescription": { en: "They can join again with the room's code.", fr: "Cette personne pourra revenir avec le code du salon." },
  "chat.removeMemberCta":      { en: "Remove",    fr: "Retirer" },
  "chat.charsLeft":            { en: "{n} left",  fr: "{n} restants" },
  "profile.avatarUploadFailed": { en: "Couldn\u2019t upload this picture", fr: "Impossible de téléverser cette image" },
  "slip.shareFailed":      { en: "Couldn\u2019t create the image", fr: "Impossible de créer l'image" },
  "slip.shareUnavailable": { en: "Sharing isn\u2019t available here — take a screenshot instead.", fr: "Le partage n'est pas disponible ici — faites plutôt une capture d'écran." },
  "chat.newRoom":      { en: "+ New Room",           fr: "+ Nouveau salon" },
  "chat.createRoom":   { en: "Create a new room",    fr: "Créer un nouveau salon" },
  "chat.createTitle":  { en: "New Chat Room",        fr: "Nouveau salon" },
  "chat.roomName":     { en: "Room Name",            fr: "Nom du salon" },
  "chat.description":  { en: "Description",          fr: "Description" },
  "chat.icon":         { en: "Icon",                 fr: "Icône" },
  "chat.create":       { en: "Create Room",          fr: "Créer le salon" },
  "chat.creating":     { en: "Creating…",            fr: "Création…" },
  "chat.private":      { en: "Private room",      fr: "Salon privé" },
  "chat.publicRoom":   { en: "Public room",       fr: "Salon public" },
  "chat.privateHint":  { en: "Only people with the join code can enter", fr: "Seules les personnes avec le code peuvent entrer" },
  "chat.publicHint":   { en: "Anyone can find and join this room", fr: "Tout le monde peut trouver et rejoindre ce salon" },
  "chat.searchRooms":  { en: "Search rooms or enter a join code…", fr: "Cherchez un salon ou entrez un code…" },
  "chat.join":         { en: "Join",                 fr: "Rejoindre" },
  "chat.joining":      { en: "Joining…",             fr: "Connexion…" },
  "chat.open":         { en: "Open",                 fr: "Ouvrir" },
  "chat.hide":         { en: "Hide",               fr: "Masquer" },
  "chat.pinned":       { en: "Pinned",               fr: "Épinglés" },
  "chat.rooms":        { en: "Rooms",                fr: "Salons" },
  "chat.otherRooms":   { en: "Other Rooms",          fr: "Autres salons" },
  "chat.joinCode":     { en: "Join code",            fr: "Code d'accès" },
  "chat.pinRoom":      { en: "Pin room",             fr: "Épingler le salon" },
  "chat.unpinRoom":    { en: "Unpin room",           fr: "Désépingler le salon" },
  "chat.membersMenu":  { en: "Members",              fr: "Membres" },
  "chat.leaveRoom":    { en: "Leave room",           fr: "Quitter le salon" },
  "chat.deleteRoom":   { en: "Delete room (admin)",  fr: "Supprimer le salon (admin)" },
  "chat.noCode":       { en: "No room found for this code", fr: "Aucun salon trouvé pour ce code" },
  "chat.joinFailed":   { en: "Could not join the room",    fr: "Impossible de rejoindre le salon" },
  "chat.roomNameRequired": { en: "Room name is required",  fr: "Le nom du salon est requis" },
  "chat.createFailed": { en: "Could not create room",      fr: "Impossible de créer le salon" },
  "chat.showHidden":   { en: "Show {n} hidden room(s)",    fr: "Afficher {n} salon(s) masqué(s)" },
  "chat.copyCode":     { en: "Copy code",            fr: "Copier le code" },
  "chat.codeCopied":   { en: "Join code copied",     fr: "Code d'accès copié" },
  "chat.codeCopyFailed": { en: "Couldn't copy — the code is {code}", fr: "Copie impossible — le code est {code}" },

  // ── Modération du chat — PRE_IOS_PLAN.md R4.3 ──
  "chat.messageActions": { en: "Message options",   fr: "Options du message" },
  "chat.report":       { en: "Report message",      fr: "Signaler le message" },
  // Coupon joint à un message de salon (migration 036).
  "chat.slipLegs":     { en: "{n} legs",              fr: "{n} sélections" },
  "chat.slipMore":     { en: "+ {n} more",            fr: "+ {n} autres" },
  "chat.blockUser":    { en: "Block user",          fr: "Bloquer l'utilisateur" },
  "chat.guidelines":   { en: "Community guidelines", fr: "Règles de la communauté" },

  // ── Pannes du socket de chat — audit pré-freeze iOS ──
  "chat.sessionExpired":  { en: "Your session expired — sign in again to keep chatting.",
                            fr: "Votre session a expiré — reconnectez-vous pour continuer à discuter." },
  "chat.accessDenied":    { en: "You no longer have access to this room.",
                            fr: "Vous n'avez plus accès à ce salon." },
  "chat.roomJoinFailed":  { en: "Could not join this room.",
                            fr: "Impossible de rejoindre ce salon." },

  "report.title":      { en: "Report this message", fr: "Signaler ce message" },
  "report.subtitle":   { en: "We read every report. Tell us what is wrong with it.", fr: "Nous lisons chaque signalement. Dis-nous ce qui ne va pas." },
  "report.reason.spam":       { en: "Spam or scam",        fr: "Pourriel ou arnaque" },
  "report.reason.harassment": { en: "Harassment or bullying", fr: "Harcèlement ou intimidation" },
  "report.reason.hate":       { en: "Hate speech",         fr: "Discours haineux" },
  "report.reason.sexual":     { en: "Sexual content",      fr: "Contenu sexuel" },
  "report.reason.other":      { en: "Something else",      fr: "Autre chose" },
  "report.noteLabel":  { en: "Anything to add? (optional)", fr: "Quelque chose à ajouter ? (facultatif)" },
  "report.notePlaceholder": { en: "Context helps us decide faster…", fr: "Un peu de contexte nous aide à trancher…" },
  "report.submit":     { en: "Send report",         fr: "Envoyer le signalement" },
  "report.sending":    { en: "Sending…",            fr: "Envoi…" },
  "report.sent":       { en: "Report sent — thank you.", fr: "Signalement envoyé — merci." },
  "report.already":    { en: "You already reported this message.", fr: "Vous avez déjà signalé ce message." },
  "report.failed":     { en: "Could not send the report", fr: "Impossible d'envoyer le signalement" },

  "block.title":       { en: "Block {name}?",       fr: "Bloquer {name} ?" },
  "block.description": { en: "You will no longer see their messages, and they will no longer see yours. You can undo this at any time in Settings.", fr: "Vous ne verrez plus ses messages, et il ne verra plus les vôtres. Vous pouvez annuler à tout moment dans les Paramètres." },
  "block.confirm":     { en: "Block",               fr: "Bloquer" },
  "block.done":        { en: "{name} is blocked.",  fr: "{name} est bloqué." },
  "block.failed":      { en: "Could not block this user", fr: "Impossible de bloquer cet utilisateur" },
  "block.self":        { en: "You can't block yourself.", fr: "Vous ne pouvez pas vous bloquer vous-même." },
  "block.unblockDone": { en: "{name} is unblocked.", fr: "{name} est débloqué." },
  "block.unblockFailed": { en: "Could not unblock", fr: "Impossible de débloquer" },

  "blocked.title":     { en: "Blocked users",       fr: "Utilisateurs bloqués" },
  "blocked.empty":     { en: "You have not blocked anyone.", fr: "Vous n'avez bloqué personne." },
  "blocked.hint":      { en: "Blocking hides messages both ways. Unblocking restores them.", fr: "Le blocage masque les messages dans les deux sens. Le déblocage les rétablit." },
  "blocked.unblock":   { en: "Unblock",             fr: "Débloquer" },
  "blocked.loadFailed": { en: "Could not load the blocked list", fr: "Impossible de charger la liste des blocages" },

  "user.viewProfile":  { en: "View full profile",   fr: "Voir le profil complet" },
  "user.blocked":      { en: "blocked",             fr: "bloqué" },
  "chat.openRoom":     { en: "Open room",            fr: "Ouvrir le salon" },
  "chat.shareCode":    { en: "Share this code so others can join:", fr: "Partagez ce code pour inviter d'autres joueurs :" },
  "chat.privateCreated": { en: "Private room created", fr: "Salon privé créé" },
  "chat.roomsAvailable": { en: "rooms available",    fr: "salons disponibles" },
  "chat.beFirst":      { en: "Be the first to say something!", fr: "Soyez le premier à écrire !" },
  "chat.replyingTo":   { en: "Replying to",          fr: "Réponse à" },
  "chat.message":      { en: "Message",              fr: "Message" },

  // ── Auth gate (guest write actions) ──
  "gate.title":        { en: "Sign in required",     fr: "Connexion requise" },
  "gate.message":      { en: "You need to be connected to {action}.", fr: "Vous devez être connecté pour {action}." },
  "gate.signIn":       { en: "Sign in",              fr: "Se connecter" },
  "gate.sendMessage":  { en: "send a message",       fr: "envoyer un message" },
  "gate.createRoom":   { en: "create a room",        fr: "créer un salon" },
  "gate.joinRoom":     { en: "join a room",          fr: "rejoindre un salon" },
  "gate.react":        { en: "react to a message",   fr: "réagir à un message" },
  "gate.pinRoom":      { en: "pin a room",           fr: "épingler un salon" },
  "gate.pickem":       { en: "make your pick",       fr: "faire votre choix" },
  "gate.leaveRoom":    { en: "leave a room",         fr: "quitter un salon" },
  "gate.deleteMessage":{ en: "delete a message",     fr: "supprimer un message" },
  "gate.deleteRoom":   { en: "delete a room",        fr: "supprimer un salon" },
  "gate.report":       { en: "report a message",     fr: "signaler un message" },
  "gate.block":        { en: "block a user",         fr: "bloquer un utilisateur" },
  "gate.searchPlayers":{ en: "search for a player",  fr: "rechercher un joueur" },

  // ── Slips / builder ──
  "slip.build":        { en: "Build",           fr: "Créer" },
  "slip.mySlips":      { en: "My Slips",        fr: "Mes paris" },
  "slip.pendingCount": { en: "{n} open slips",  fr: "{n} coupons en cours" },
  "slip.predictions":  { en: "Your Predictions", fr: "Vos prédictions" },
  "slip.add":          { en: "Add",             fr: "Ajouter" },
  "slip.clearTitle":   { en: "Clear this slip?", fr: "Vider ce pari ?" },
  "slip.clearBody":    { en: "All the bets in the slip will be removed.", fr: "Toutes les sélections du pari seront retirées." },
  "slip.clearConfirm": { en: "Clear", fr: "Vider" },
  "slip.active":       { en: "Active",          fr: "Actifs" },
  "slip.history":      { en: "History",         fr: "Historique" },
  "slip.checkResults": { en: "Check results",   fr: "Vérifier les résultats" },
  // Annuler un pari en cours (2026-10-05) — permis seulement avant le début
  // du premier match du coupon, voir `cancelSlip` côté serveur.
  "slip.cancel":         { en: "Cancel bet", fr: "Annuler le pari" },
  "slip.cancelTitle":    { en: "Cancel this bet?", fr: "Annuler ce pari ?" },
  "slip.cancelBody":     { en: "The bet will be removed from your slips. No XP is won or lost.", fr: "Le pari sera retiré de vos coupons. Aucun XP gagné ni perdu." },
  "slip.cancelConfirm":  { en: "Cancel bet", fr: "Annuler le pari" },
  "slip.cancelKeep":     { en: "Keep it", fr: "Le garder" },
  "slip.cancelled":      { en: "Bet cancelled", fr: "Pari annulé" },
  "slip.cancelStarted":  { en: "A game in this bet has already started — it can no longer be cancelled.", fr: "Un match de ce pari a déjà commencé — il ne peut plus être annulé." },
  "slip.cancelFailed":   { en: "Could not cancel the bet. Try again.", fr: "Impossible d'annuler le pari. Réessayez." },
  "slip.seeActive":    { en: "See my open bets", fr: "Voir mes paris en cours" },
  "slip.openGame":     { en: "Open the game for {bet}", fr: "Voir le match de {bet}" },
  "slip.visibilityNotice": {
    en: "Once settled, your slips are visible to Pro members — picks stay hidden until puck drop. You can hide them in Settings.",
    fr: "Une fois réglés, vos paris sont visibles aux membres Pro — les sélections restent cachées jusqu'à la mise au jeu. Vous pouvez les masquer dans Paramètres.",
  },
  "slip.pending":      { en: "Pending",         fr: "En attente" },
  "slip.won":          { en: "Won",             fr: "Gagné" },
  "slip.lost":         { en: "Lost",            fr: "Perdu" },
  // Coupon dont toutes les jambes ont été annulées — marché sans règle de
  // règlement automatique. Ni gagné ni perdu, et sans XP. Voir la migration
  // 037 côté serveur.
  "slip.void":         { en: "Void",            fr: "Annulé" },

  // Issue d'UNE sélection à l'intérieur d'un pari — ✓ / ✗ posés ligne par ligne
  // par `settlement.service.ts`, y compris sur un pari encore en cours. Sert
  // d'étiquette accessible : l'icône seule ne dit rien à un lecteur d'écran.
  "slip.legWon":       { en: "Pick won",        fr: "Sélection réussie" },
  "slip.legLost":      { en: "Pick lost",       fr: "Sélection manquée" },
  "slip.legVoid":      { en: "Pick voided",     fr: "Sélection annulée" },
  "slip.legPending":   { en: "Not settled yet", fr: "Pas encore décidée" },
  "slip.legUnknown":   { en: "Not evaluated",  fr: "Non évaluée" },

  // ── Page joueur (coupons d'un autre membre — réservé aux abonnés Pro) ──────
  "player.title":         { en: "Player",  fr: "Joueur" },
  "player.viewAll":       { en: "See all their bets →", fr: "Voir tous ses paris →" },
  "player.single":        { en: "Single",  fr: "Simple" },
  "player.parlayLegs":    { en: "Parlay · {n} legs", fr: "Combiné · {n} paris" },
  "player.unlocksAt":     { en: "Picks revealed at {time}", fr: "Sélections dévoilées à {time}" },
  "player.unlocksAtStart":{ en: "Picks revealed at puck drop", fr: "Sélections dévoilées à la mise au jeu" },
  "player.noLegDetail":   { en: "No breakdown available for this slip", fr: "Aucun détail disponible pour ce pari" },
  "player.formLine":      { en: "of {settled} bets won this month", fr: "des {settled} paris gagnés ce mois-ci" },
  "player.formTooFew":    { en: "{settled} bets this month — too few to rate", fr: "{settled} paris ce mois-ci — échantillon insuffisant" },
  "player.overallLine":   { en: "{settled} bets in total", fr: "{settled} paris au total" },
  "player.since":         { en: "since {date}", fr: "depuis le {date}" },
  "player.proTitle":      { en: "See other players' bets", fr: "Voir les paris des autres" },
  "player.proDesc":       { en: "Pro members can browse any player's slips, bet by bet.", fr: "Les membres Pro consultent les paris de n'importe quel joueur, sélection par sélection." },
  "player.hiddenTitle":   { en: "This player hides their slips", fr: "Ce joueur masque ses paris" },
  "player.hiddenDesc":    { en: "Nothing to do with your subscription — they chose to stay private.", fr: "Rien à voir avec votre abonnement — il a choisi de rester discret." },
  "player.notFound":      { en: "Player not found", fr: "Joueur introuvable" },
  "player.errorTitle":    { en: "Couldn't load this player", fr: "Impossible de charger ce joueur" },
  "player.noSlipsYet":    { en: "No slips yet", fr: "Aucun pari pour l'instant" },
  "slip.autoSettle":   { en: "Settled automatically when games finish — riskier bets earn more XP", fr: "Réglé automatiquement à la fin des matchs — plus le pari est risqué, plus il rapporte d'XP" },
  "slip.noSlips":      { en: "No slips yet",    fr: "Aucun pari" },
  "slip.noSlipsHint":  { en: "Lock your first prediction to see it here", fr: "Verrouillez votre première prédiction pour la voir ici" },
  "slip.empty":        { en: "No predictions yet", fr: "Aucune prédiction" },
  "slip.emptyHint":    { en: "Add predictions from the Stats page or tap below to browse all markets", fr: "Ajoutez des prédictions depuis la page Stats ou explorez les marchés ci-dessous" },
  "slip.browse":       { en: "Browse Markets",  fr: "Explorer les marchés" },
  "slip.signin":       { en: "Sign in to see your slips", fr: "Connectez-vous pour voir vos paris" },
  "slip.signinHint":   { en: "Your locked slips and history will appear here", fr: "Vos paris verrouillés et votre historique apparaîtront ici" },
  "slip.placeBet365":  isIOS ? { en: "", fr: "" } : { en: "Place on Bet365 ↗", fr: "Parier sur Bet365 ↗" },
  "slip.placeBet":     isIOS ? { en: "", fr: "" } : { en: "Place on {book} ↗", fr: "Parier sur {book} ↗" },
  "slip.bookCombined": { en: "Book parlay odds", fr: "Cote combinée du livre" },
  "slip.xpEarned":     { en: "XP earned",       fr: "XP gagnés" },
  "slip.sharePhoto":   { en: "Share",           fr: "Partager" },

  // ── Textes de l'IMAGE de partage (slipShareCanvas.ts) ──────────────────────
  // Le rendu ne traduit rien lui-même : il ne connaît ni React ni `useI18n`.
  // Ces clés sont composées dans MySlipsTab et passées au dessin.
  "share.lockedOn":    { en: "Locked {date}",   fr: "Verrouillé le {date}" },
  "share.settledOn":   { en: "Settled {date}",  fr: "Réglé le {date}" },
  "share.combined":    { en: "COMBINED",        fr: "COMBINÉ" },
  "share.summary":     { en: "{n} selections · odds {odds}", fr: "{n} sélections · cote {odds}" },
  "share.summaryOne":  { en: "1 selection · odds {odds}",    fr: "1 sélection · cote {odds}" },
  "share.summaryNoOdds":    { en: "{n} selections", fr: "{n} sélections" },
  "share.summaryOneNoOdds": { en: "1 selection",    fr: "1 sélection" },
  "share.moreLegs":    { en: "+ {n} more selections", fr: "+ {n} autres sélections" },
  "share.disclaimer":  { en: "Model probabilities · not betting advice", fr: "Probabilités du modèle · pas un conseil de pari" },

  // ── Envoyer un coupon dans une salle de chat ───────────────────────────────
  "slip.shareToRoom":     { en: "Send to a room",   fr: "Envoyer en salle" },
  "slip.pickRoom":        { en: "Which room?",      fr: "Dans quelle salle ?" },
  "slip.noRooms":         { en: "You haven't joined a room yet", fr: "Vous n'avez encore rejoint aucune salle" },
  "slip.roomMembers":     { en: "{n} members",      fr: "{n} membres" },
  // Le texte qui accompagne la carte. Il reste modifiable dans le salon comme
  // n'importe quel message, et il passe le filtre de modération du serveur.
  "slip.shareRoomMessage":{ en: "My slip · {n} legs · {pct} combined", fr: "Mon pari · {n} sélections · {pct} combiné" },
  "slip.sharedToRoom":    { en: "Shared in {room}",  fr: "Partagé dans {room}" },
  "slip.openRoom":        { en: "Open",             fr: "Ouvrir" },
  "slip.shareRoomFailed": { en: "Couldn't send it to that room", fr: "Impossible d'envoyer dans cette salle" },
  "slip.addToSee":     { en: "Add predictions to see probability", fr: "Ajoutez des prédictions pour voir la probabilité" },
  "slip.gaugeAddLegs": { en: "Add legs",        fr: "Ajoutez des paris" },
  "slip.gaugeStrong":  { en: "Strong",          fr: "Fort" },
  "slip.gaugeModerate":{ en: "Moderate",        fr: "Modéré" },
  "slip.gaugeRisky":   { en: "Risky",           fr: "Risqué" },
  "slip.gaugeLongShot":{ en: "Long Shot",       fr: "Peu probable" },
  "slip.signinRequired":{ en: "Sign in required to submit", fr: "Connexion requise pour soumettre" },
  "slip.legsReady":    { en: "{n} legs ready to lock", fr: "{n} paris prêts à verrouiller" },
  "slip.combined":     { en: "Combined",        fr: "Combiné" },
  "slip.addLeg":       { en: "Add Leg",         fr: "Ajouter un pari" },
  "slip.submitting":   { en: "Submitting...",   fr: "Envoi..." },
  "slip.lockSlip":     { en: "Lock Slip",       fr: "Verrouiller le pari" },
  // Échec du verrouillage. Jusqu'au 2026-09-14 l'erreur était mise dans un état
  // que RIEN n'affichait : le bouton revenait de « Envoi… » et il ne se passait
  // rien — indiscernable d'un bouton mort.
  "slip.lockFailed":   { en: "Couldn't lock the slip — try again", fr: "Impossible de verrouiller le pari — réessayez" },
  "slip.lockTimeout":  { en: "The server took too long — your slip wasn't locked. Try again.", fr: "Le serveur a mis trop de temps — le pari n'a pas été verrouillé. Réessayez." },
  "slip.gameStarted":  { en: "A game in your slip has already started — remove those bets to lock it.", fr: "Un match de votre coupon a déjà commencé — retirez ces paris pour le verrouiller." },
  "slip.chance":      { en: "chance",          fr: "de chance" },
  "slip.oddsWord":    { en: "odds",            fr: "cote" },
  "slip.noBookOdds":  { en: "no book odds",    fr: "pas de cote" },
  "slip.noBookCombined": { en: "Book odds unavailable for this combination", fr: "Cote du livre indisponible pour ce combiné" },
  "slip.liveTitle":   { en: "Game in progress", fr: "Match en cours" },
  "slip.liveBody":    { en: "Live betting isn't available: a game in your slip has already started. Remove those bets to lock it.", fr: "Les paris en direct ne sont pas disponibles : un match de votre coupon a déjà commencé. Retirez ces paris pour le verrouiller." },
  "slip.legLive":     { en: "Game in progress — can't be locked", fr: "Match en cours — impossible à verrouiller" },
  "slip.liveBlocked": { en: "This game has already started — live betting isn't available.", fr: "Ce match a déjà commencé — les paris en direct ne sont pas disponibles." },
  "slip.individualProb":{ en: "Individual prediction probability", fr: "Probabilité de prédiction individuelle" },
  // Ce que la combinaison a changé — affiché par `SlipNotices`. Ces trois faits
  // étaient calculés par `parlay.ts` et jetés : un coupon impossible tombait à
  // 0 % sans un mot, un doublon quittait le calcul en silence.
  "slip.impossibleTitle": { en: "These bets can't all happen", fr: "Ces paris ne peuvent pas tous se réaliser" },
  "slip.impossibleBody":  { en: "At least two of them contradict each other on the same game. You can keep them on the slip — the combined probability just reads 0%.", fr: "Au moins deux d'entre elles se contredisent sur le même match. Vous pouvez les garder au pari — la probabilité combinée affiche simplement 0 %." },
  "slip.redundantOne":    { en: "1 bet is a duplicate — or already contained in another one. It counts once in the combined probability.", fr: "1 pari est un doublon — ou est déjà contenu dans un autre. Il n'est compté qu'une fois dans la probabilité combinée." },
  "slip.redundantMany":   { en: "{n} bets are duplicates — or already contained in another one. They count once in the combined probability.", fr: "{n} paris sont des doublons — ou sont déjà contenus dans un autre. Ils ne sont comptés qu'une fois dans la probabilité combinée." },
  "slip.sameGameApprox":  { en: "Several bets are on the same game. Their link couldn't be computed, so the combined probability treats them as independent — read it as an approximation.", fr: "Plusieurs paris portent sur le même match. Leur lien n'a pas pu être calculé : la probabilité combinée les traite comme indépendants — à lire comme une approximation." },
  "slip.howProbTitle": { en: "How probability works", fr: "Comment fonctionne la probabilité" },
  "slip.howProbBody":  { en: "Bets on different games are multiplied together. A duplicate — or a bet already contained in another — counts once, two bets that can't both happen drop the slip to 0, and bets on the same game are adjusted for their link. More bets means a lower combined chance but a higher potential reward.", fr: "Les sélections sur des matchs différents se multiplient. Un doublon — ou une sélection déjà contenue dans une autre — ne compte qu'une fois, deux sélections qui ne peuvent pas se réaliser ensemble ramènent le pari à 0, et les sélections d'un même match sont ajustées selon leur lien. Plus il y a de sélections, plus la chance combinée est faible, mais plus la récompense potentielle est élevée." },

  // ── Stats ──
  "stats.title":       { en: "Stats & Predictions", fr: "Stats & prédiction" },
  "stats.subtitle":    { en: "AI-powered predictions", fr: "Prédictions par IA" },
  "stats.search":      { en: "Search team, player, game...", fr: "Cherchez une équipe, un joueur, un match..." },
  "stats.teams":       { en: "teams",           fr: "équipes" },
  "stats.futures":     { en: "Season Futures",  fr: "Paris de saison" },
  "stats.loadingTeams":{ en: "Loading team data...", fr: "Chargement des équipes..." },
  "stats.noGames":     { en: "No games scheduled today", fr: "Aucun match aujourd'hui" },
  "stats.byTeam":      { en: "By Team",   fr: "Par équipe" },
  "stats.byGame":      { en: "By Game",   fr: "Par match" },
  "stats.byPlayer":    { en: "By Player", fr: "Par joueur" },
  "stats.statistics":  { en: "Statistics", fr: "Statistiques" },
  "stats.tabPrediction": { en: "Prediction", fr: "Prédiction" },
  "stats.loadingNHL":  { en: "Loading NHL data...", fr: "Chargement des données LNH..." },
  "stats.matches":     { en: "{n} matches", fr: "{n} matchs" },
  "stats.players":     { en: "Players",   fr: "Joueurs" },
  "stats.loadingTeamsHint": { en: "The stats service is not responding. Try again in a moment.", fr: "Le service de statistiques ne répond pas. Réessayez dans un instant." },
  "stats.noGamesHint": { en: "Check back on game nights, or explore season futures below", fr: "Revenez les soirs de match, ou explorez les paris de saison ci-dessous" },
  "stats.loadingStandings": { en: "Loading standings data...", fr: "Chargement du classement..." },
  "stats.viewBets":    { en: "View bets ›", fr: "Voir les paris ›" },
  "stats.stanleyCup":  { en: "Stanley Cup", fr: "Coupe Stanley" },
  "stats.conference":  { en: "Conference", fr: "Conférence" },
  // Conférences et divisions — voir data/nhlDivisions.ts.
  "conf.east":           { en: "Eastern Conference", fr: "Conférence de l'Est" },
  "conf.west":           { en: "Western Conference", fr: "Conférence de l'Ouest" },
  "div.all":             { en: "All",          fr: "Toutes" },
  "div.atlantic":        { en: "Atlantic",     fr: "Atlantique" },
  "div.metropolitan":    { en: "Metropolitan", fr: "Métropolitaine" },
  "div.central":         { en: "Central",      fr: "Centrale" },
  "div.pacific":         { en: "Pacific",      fr: "Pacifique" },
  "div.atlantic.short":     { en: "ATL", fr: "ATL" },
  "div.metropolitan.short": { en: "MET", fr: "MÉT" },
  "div.central.short":      { en: "CEN", fr: "CEN" },
  "div.pacific.short":      { en: "PAC", fr: "PAC" },
  "div.filter":          { en: "Division",     fr: "Division" },
  "stats.futuresTag":  { en: "Futures",    fr: "Paris de saison" },
  "stats.winCup":      { en: "Win Stanley Cup 2026", fr: "Gagner la Coupe Stanley 2026" },

  // ── Home / landing ──
  "home.bestBets":       { en: "Best Bets",         fr: "Meilleurs paris" },
  "home.top":            { en: "Top {n}",           fr: "Top {n}" },
  "home.show":           { en: "Show",              fr: "Afficher" },
  "home.hide":           { en: "Hide",              fr: "Masquer" },
  "home.rules":          { en: "Rules",             fr: "Règles" },
  "home.ai":             { en: "AI",                fr: "IA" },
  "home.vsRules":        { en: "rules {pct} %",     fr: "règles {pct} %" },
  "home.vsAi":           { en: "AI {pct} %",        fr: "IA {pct} %" },
  "home.aiUnavailable":  { en: "The AI model isn't answering right now, so there's no AI score to show.", fr: "Le modèle IA ne répond pas pour le moment, il n'y a donc aucun score IA à afficher." },
  "home.showRules":      { en: "See the rules picks", fr: "Voir les paris des règles" },
  "home.noBetsTier":     { en: "No “{tier}” bets right now — try another tab.", fr: "Aucun pari « {tier} » pour le moment — essaie un autre onglet." },
  "home.bbExplainMl":    { en: "Ranked by win chance according to our AI model.", fr: "Classés selon leur chance de passer d'après notre modèle IA." },
  "home.bbExplainRules": { en: "Ranked by win chance according to our analysis rules.", fr: "Classés selon leur chance de passer d'après nos règles d'analyse." },
  "home.chance":         { en: "chance",            fr: "de chance" },
  "home.odds":           { en: "odds {odds}",       fr: "cote {odds}" },
  "home.noBets":         { en: "No bets right now — the list covers games in the next 48 hours", fr: "Aucun pari pour le moment — la liste couvre les matchs des 48 prochaines heures" },
  "home.prevDay":        { en: "Previous day",      fr: "Journée précédente" },
  "home.nextDay":        { en: "Next day",          fr: "Journée suivante" },
  "home.liveNow":        { en: "Live Now",          fr: "En direct" },
  "home.live":           { en: "Live",              fr: "En direct" },
  "home.noGames":        { en: "No games scheduled", fr: "Aucun match prévu" },
  "home.upcomingMatches":{ en: "Upcoming Matches",  fr: "Matchs à venir" },
  "home.noMatches":      { en: "No matches scheduled", fr: "Aucun match prévu" },
  "home.tonightGames":   { en: "Tonight's Games",   fr: "Matchs de ce soir" },
  "home.tomorrowGames":  { en: "Tomorrow's Games",  fr: "Matchs de demain" },
  "home.gamesOn":        { en: "{date} Games",      fr: "Matchs du {date}" },
  // `home.add` / `home.added` / `home.addToSlip` / `home.addedSlip` retirés le
  // 2026-09-20 avec l'ajout rapide des cartes de l'accueil : on ajoute une
  // sélection depuis « Plus de paris », qui montre ce qu'on choisit.
  "home.moreBets":       { en: "More bets",         fr: "Plus de paris" },
  "home.game":           { en: "Game",              fr: "Match" },
  "home.nhlGame":        { en: "NHL Game",          fr: "Match LNH" },
  "pred.fairOdds":       { en: "Fair odds (ML model)", fr: "Cote juste (modèle ML)" },
  "home.oddsFairHint":   { en: "Fair odds implied by our model — not a bookmaker price.", fr: "Cote équitable déduite de notre modèle — ce n'est pas un prix de bookmaker." },

  // ── Best bets tiers (sélecteur exclusif) ──
  "tier.all":      { en: "All",       fr: "Tous" },
  "tier.safe":     { en: "Safe",      fr: "Sûrs" },
  "tier.balanced": { en: "Balanced",  fr: "Équilibrés" },
  "tier.longshot": { en: "Big odds",  fr: "Grosses cotes" },

  // ── Best bets labels ──
  "bb.teamWin":   { en: "{abbr} to win",    fr: "Victoire de {abbr}" },
  "bb.playerWin": { en: "{name} to win",    fr: "Victoire de {name}" },
  "bb.over":      { en: "Over {line} goals", fr: "Plus de {line} buts" },
  "bb.under":     { en: "Under {line} goals", fr: "Moins de {line} buts" },
  "bb.vs":        { en: "vs {opp}",         fr: "contre {opp}" },
  "bb.puckLine":      { en: "{abbr} wins by 2+ goals",       fr: "{abbr} gagne par 2 buts ou plus" },
  "bb.anytimeGoal":   { en: "{name} scores a goal",          fr: "{name} marque un but" },
  "bb.shotsAtLeast":  { en: "{name}: {n}+ shots on goal",    fr: "{name} : au moins {n} tirs au but" },
  "bb.pointsAtLeast": { en: "{name}: {n}+ point(s)",         fr: "{name} : au moins {n} point(s)" },
  "bb.ppPoint":       { en: "{name}: power-play point",      fr: "{name} : point en avantage numérique" },

  // ── Noms de marchés (Meilleurs paris) ──
  "market.moneyline":    { en: "Game winner",   fr: "Vainqueur du match" },
  "market.total_goals":  { en: "Total goals",   fr: "Total de buts" },
  "market.puck_line":    { en: "Puck line",     fr: "Écart (puck line)" },
  "market.anytime_goal": { en: "Goal scorer",   fr: "Buteur" },
  "market.shots_ou":     { en: "Shots on goal", fr: "Tirs au but" },
  "market.points_ou":    { en: "Points",        fr: "Points" },
  "market.pp_point":     { en: "Power play",    fr: "Avantage numérique" },

  // ── NHL predictions page ──
  "nhl.title":         { en: "NHL Predictions", fr: "Prédictions NHL" },
  "nhl.subtitle":      { en: "Tonight's games · Rules + ML", fr: "Les matchs du jour · Règles + ML" },
  "nhl.analyzing":     { en: "Analyzing…",         fr: "Analyse en cours..." },
  "nhl.askLLM":        { en: "Ask LLM",          fr: "Demander au LLM" },

  // ── Prediction page ──
  "pred.title":          { en: "Prediction",            fr: "Prédiction" },
  "pred.calcPredictions":{ en: "Calculated Predictions", fr: "Prédictions calculées" },
  "pred.base":           { en: "Base: {n}%",            fr: "Base : {n} %" },
  "pred.aiPrediction":   { en: "AI Prediction",         fr: "Prédiction IA" },
  "pred.liveModel":      { en: "Live Model",            fr: "Modèle en direct" },
  "pred.rules":          { en: "Rules",                 fr: "Règles" },
  "pred.copy":           { en: "Copy",                  fr: "Copier" },
  "pred.copied":         { en: "Copied",                fr: "Copié" },
  "pred.view":           { en: "View",                  fr: "Voir" },
  // ── Carte « Règles » de la fiche d'un pari (RuleFactorEditor) ──
  "rules.weighting":     { en: "Weighting",             fr: "Pondération" },
  "rules.rule":          { en: "Rule",                  fr: "Règle" },
  "rules.pieHint":       { en: "Each factor’s share of the calculation (weight × value); “· %” = probability estimated by that factor.", fr: "Part de chaque facteur dans le calcul (poids × valeur) ; « · % » = probabilité estimée par ce facteur." },
  "rules.yourRule":      { en: "Your rule",             fr: "Votre règle" },
  "rules.yourRulePlaceholder": { en: "Your rule…",      fr: "Votre règle…" },
  "rules.includeYours":  { en: "Include your rule",     fr: "Inclure votre règle" },
  "rules.yourProb":      { en: "Your probability:",     fr: "Votre probabilité :" },
  "rules.yourRuleHint":  { en: "Add your own criterion: name it, give your probability for this bet, then its weight.", fr: "Ajoutez votre propre critère : donnez-lui un nom, votre probabilité pour ce pari, puis son poids." },
  "rules.total":         { en: "Total: {n} / 100",      fr: "Total : {n} / 100" },
  "rules.totalScaled":   { en: "Total: {n} → scaled to 100", fr: "Total : {n} → ramené à 100" },
  "rules.save":          { en: "Save",                  fr: "Enregistrer" },
  "rules.reset":         { en: "Reset",                 fr: "Réinitialiser" },
  "rules.footer":        { en: "Uncheck a factor to exclude it. Settings apply to this bet type, are kept on this device and linked to your account if you’re signed in.", fr: "Décochez un facteur pour l'exclure. Réglages propres à ce type de pari, gardés sur cet appareil et rattachés à votre compte si vous êtes connecté." },
  "rules.saved":         { en: "Weighting saved for this bet type.", fr: "Pondération enregistrée pour ce type de pari." },
  "rules.resetDone":     { en: "Weighting reset.",      fr: "Pondération réinitialisée." },
  "rules.syncFailed":    { en: "Saved on this device; account sync failed.", fr: "Enregistré sur cet appareil ; la synchro du compte a échoué." },
  // ── Jour des matchs affichés (page Stats, `gamesLabelText`) ──
  "stats.day.today":         { en: "Today",              fr: "Aujourd'hui" },
  "stats.day.tomorrow":      { en: "Tomorrow",           fr: "Demain" },
  "stats.day.todayTomorrow": { en: "Today and tomorrow", fr: "Aujourd'hui et demain" },
  "stats.day.none":          { en: "No games",           fr: "Aucun match" },
  "pred.liveNote":       {
    en: "Game in progress: figures in solid white are updated in real time. Paler ones — including bookmaker odds — were calculated before the game.",
    fr: "Partie en cours : les chiffres en blanc opaque sont mis à jour en temps réel. Les plus pâles, dont les cotes du bookmaker, ont été calculés avant le match.",
  },
  "pred.prematchValue":  { en: "Calculated before the game", fr: "Calculé avant le match" },
  "pred.chart":          { en: "Chart",                 fr: "Graphique" },
  // ── Charts page ──
  "chart.title":         { en: "Statistics",            fr: "Statistiques" },
  "chart.skaters":       { en: "Skaters",               fr: "Patineurs" },
  "chart.goalies":       { en: "Goalies",               fr: "Gardiens" },
  "chart.player":        { en: "Player",                fr: "Joueur" },
  "chart.noData":        { en: "No season data available.", fr: "Aucune donnée de saison disponible." },
  "chart.last6":         { en: "Last 6 seasons",        fr: "6 dernières saisons" },
  "chart.recordSeason":  { en: "{season} record:",      fr: "Fiche {season} :" },
  "chart.recordLegend":  { en: "(W-L-OTL)",             fr: "(V-D-DP)" },
  "chart.m.points":      { en: "Points",                fr: "Points" },
  "chart.m.goals":       { en: "Goals",                 fr: "Buts" },
  "chart.m.assists":     { en: "Assists",               fr: "Passes" },
  "chart.m.plusMinus":   { en: "+/-",                   fr: "+/-" },
  "chart.m.shots":       { en: "Shots",                 fr: "Tirs" },
  "chart.m.ppPoints":    { en: "PP Pts",                fr: "Pts AN" },
  "chart.m.gp":          { en: "Games",                 fr: "Matchs" },
  "chart.m.wins":        { en: "Wins",                  fr: "Victoires" },
  "chart.m.savePct":     { en: "SV%",                   fr: "%Arr" },
  "chart.m.gaa":         { en: "GAA",                   fr: "MBA" },
  "chart.m.shutouts":    { en: "Shutouts",              fr: "Blanchissages" },
  // Charts — controls & columns
  "chart.teamStats":     { en: "Team Averages & Stats", fr: "Moyennes et statistiques d'équipe" },
  "chart.playerStats":   { en: "Player Averages & Stats", fr: "Moyennes et statistiques des joueurs" },
  "chart.col.total":     { en: "Total",                 fr: "Total" },
  "chart.col.perGame":   { en: "Average / game",        fr: "Moyenne / match" },
  "chart.avgSuffix":     { en: "(avg / game)",          fr: "(moy. / match)" },
  "chart.col.vsTeam":    { en: "vs {team}",             fr: "c. {team}" },
  "chart.opponent":      { en: "Opponent",              fr: "Adversaire" },
  "chart.allOpponents":  { en: "Choose team",           fr: "Choisir équipe" },
  "chart.season":        { en: "Season",                fr: "Saison" },
  "chart.tm.goalsFor":     { en: "Goals For",           fr: "Buts pour" },
  "chart.tm.goalsAgainst": { en: "Goals Against",       fr: "Buts contre" },
  "chart.tm.points":       { en: "Points",              fr: "Points" },
  "chart.tm.wins":         { en: "Wins",                fr: "Victoires" },
  "chart.tm.ppPct":        { en: "Power Play %",        fr: "% Avantage num." },
  "chart.tm.pkPct":        { en: "Penalty Kill %",      fr: "% Désavantage num." },
  "chart.tm.shots":        { en: "Shots",               fr: "Tirs" },
  // Charts — team picker, position filter
  "chart.team":          { en: "Team",                  fr: "Équipe" },
  "chart.position":      { en: "Position",              fr: "Position" },
  "chart.pos.all":       { en: "All",                   fr: "Tous" },
  "chart.pos.forwards":  { en: "Forwards",              fr: "Attaquants" },
  "chart.pos.defense":   { en: "Defense",               fr: "Défense" },
  // Charts — team trends table
  "chart.teamTrends":    { en: "Team Trends",           fr: "Tendances d'équipe" },
  "chart.col.season":    { en: "Season",                fr: "Saison" },
  "chart.tm.goalDiff":   { en: "Goal Diff",             fr: "Diff. de buts" },
  "chart.tm.pointPct":   { en: "Point %",               fr: "% Points" },
  "chart.tm.faceoffPct": { en: "Faceoff %",             fr: "% Mises au jeu" },
  // Possession à 5 c. 5 : Corsi = toutes les tentatives de tir, Fenwick = les
  // tentatives non bloquées. Source MoneyPuck, créditée sous les tableaux.
  "chart.tm.corsiPct":   { en: "Corsi % (5v5)",         fr: "% Corsi (5 c. 5)" },
  "chart.tm.fenwickPct": { en: "Fenwick % (5v5)",       fr: "% Fenwick (5 c. 5)" },
  "chart.pl.corsiPct":   { en: "On-ice CF% (5v5)",      fr: "% Corsi sur la glace (5 c. 5)" },
  "chart.pl.fenwickPct": { en: "On-ice FF% (5v5)",      fr: "% Fenwick sur la glace (5 c. 5)" },
  "chart.mpCredit":      { en: "Corsi & Fenwick: MoneyPuck.com", fr: "Corsi et Fenwick : MoneyPuck.com" },
  "chart.tm.record":     { en: "Record",                fr: "Fiche" },
  "chart.tm.home":       { en: "Home",                  fr: "Domicile" },
  "chart.tm.away":       { en: "Away",                  fr: "Extérieur" },
  "chart.tm.last10":     { en: "Last 10",               fr: "10 derniers" },
  "chart.tm.streak":     { en: "Streak",                fr: "Séquence" },
  "chart.tm.oneGoal":    { en: "1-Goal Games",          fr: "Matchs à 1 but" },
  // Charts — line graph + pie breakdowns
  "chart.byGame":        { en: "by game",               fr: "par match" },
  "chart.cumNote":       { en: "Cumulative · top {n} players", fr: "Cumulé · {n} meilleurs joueurs" },
  "chart.game":          { en: "Game",                  fr: "Match" },
  "chart.breakdowns":    { en: "Breakdowns",            fr: "Répartitions" },
  "chart.pie.results":   { en: "Results (Home / Away)",  fr: "Résultats (dom. / ext.)" },
  "chart.pie.pointShare":{ en: "Points share by player", fr: "Part des points par joueur" },
  "chart.pie.goalShare": { en: "Goals share by player",  fr: "Part des buts par joueur" },
  "chart.pie.wonHome":   { en: "Won home",              fr: "Gagné dom." },
  "chart.pie.wonAway":   { en: "Won away",              fr: "Gagné ext." },
  "chart.pie.lostHome":  { en: "Lost home",             fr: "Perdu dom." },
  "chart.pie.lostAway":  { en: "Lost away",             fr: "Perdu ext." },
  "chart.others":        { en: "Others",                fr: "Autres" },
  "chart.noTeam":        { en: "No team",               fr: "Aucune équipe" },
  "chart.choosePrompt":  { en: "Choose a team to see its charts.", fr: "Choisissez une équipe pour voir ses graphiques." },
  "chart.noPlayer":      { en: "No player",             fr: "Aucun joueur" },
  "chart.choosePlayerPrompt": { en: "Choose a team and player to see their charts.", fr: "Choisissez une équipe et un joueur pour voir leurs graphiques." },
  "chart.m.shootingPct": { en: "Shooting %",            fr: "% Tirs" },
  "chart.m.pim":         { en: "PIM",                   fr: "Min. pén." },
  "chart.m.ppg":         { en: "PP Goals",              fr: "Buts AN" },
  "chart.m.shp":         { en: "SH Points",             fr: "Points DN" },
  "chart.m.toi":         { en: "TOI / Game",            fr: "Temps de jeu / match" },
  "chart.m.losses":      { en: "Losses",                fr: "Défaites" },
  "chart.m.otLosses":    { en: "OT Losses",             fr: "Défaites Prol." },
  "chart.pie.pointsBreakdown": { en: "Points Breakdown", fr: "Répartition des points" },
  "chart.pie.pts":       { en: "PTS",                   fr: "PTS" },
  "chart.compare.ctaPlayer": { en: "Compare to another player", fr: "Comparer à un autre joueur" },
  "chart.compare.ctaTeam":   { en: "Compare to another team",   fr: "Comparer à une autre équipe" },
  "chart.compare.chart":     { en: "Head to head",      fr: "Face à face" },
  "chart.compare.players":   { en: "Compare players",   fr: "Comparer des joueurs" },
  "chart.compare.teams":     { en: "Compare teams",     fr: "Comparer des équipes" },
  "chart.compare.playersDesc": { en: "Two players side by side, stat by stat.", fr: "Deux joueurs côte à côte, stat par stat." },
  "chart.compare.teamsDesc": { en: "Two clubs' seasons side by side.", fr: "La saison de deux clubs côte à côte." },
  "chart.compare.pickTwoPlayers": { en: "Pick two players to compare.", fr: "Choisissez deux joueurs à comparer." },
  "chart.compare.pickTwoTeams": { en: "Pick two teams to compare.", fr: "Choisissez deux équipes à comparer." },
  "chart.compare.mixed":     { en: "Compare a goalie with a goalie, and a skater with a skater.", fr: "Comparez un gardien avec un gardien, et un patineur avec un patineur." },
  "chart.compare.noCommonSeason": { en: "These two players have no season in common.", fr: "Ces deux joueurs n'ont aucune saison en commun." },
  "chart.compare.clear":     { en: "Remove",            fr: "Retirer" },
  "chart.compare.fellBack":  { en: "{team} hasn't played yet in {from} — showing {to}.", fr: "{team} n'a pas encore joué en {from} — affichage de la saison {to}." },
  "chart.compare.noGames":   { en: "{team} has no games in {season}.", fr: "{team} n'a aucun match en {season}." },
  "chart.allPlayers":        { en: "All players",       fr: "Tous les joueurs" },
  "chart.pie.assistShare":   { en: "Assists share by player", fr: "Part des passes par joueur" },
  "chart.bar.decisions":     { en: "Decisions breakdown", fr: "Répartition des décisions" },
  "chart.allTeams":          { en: "All teams",         fr: "Toutes les équipes" },
  "chart.allGames.title":    { en: "All Games",         fr: "Tous les matchs" },
  "chart.allGames.note":     { en: "{n} games · {month}", fr: "{n} matchs · {month}" },
  "chart.gm.date":           { en: "Date",              fr: "Date" },
  "chart.gm.score":          { en: "Score",             fr: "Pointage" },
  "chart.gm.total":          { en: "Total",             fr: "Total" },
  "chart.gm.diff":           { en: "Margin",            fr: "Écart" },
  "chart.gm.status":         { en: "Status",            fr: "Statut" },
  "chart.gm.records":        { en: "Records",           fr: "Fiches" },
  "chart.gm.next5":          { en: "Next 5 days",       fr: "5 prochains jours" },
  "chart.gm.next10":         { en: "Next 10 days",      fr: "10 prochains jours" },
  "chart.gm.month":          { en: "Month",             fr: "Mois" },
  "chart.gm.results":        { en: "Results",           fr: "Résultats" },
  "chart.gm.upcoming":       { en: "Upcoming",          fr: "À venir" },
  "chart.gm.time":           { en: "Time",              fr: "Heure" },
  "chart.gm.noResults":      { en: "No games played in this range.", fr: "Aucun match joué sur cette période." },
  "chart.gm.noUpcoming":     { en: "No upcoming games in this range.", fr: "Aucun match à venir sur cette période." },
  "chart.gm.allTeams":       { en: "All teams",         fr: "Toutes les équipes" },
  "chart.gm.future":         { en: "Future",            fr: "Futur" },
  "chart.gm.past":           { en: "Past",              fr: "Passé" },
  "chart.gm.season":         { en: "Season",            fr: "Saison" },
  "chart.gm.typePlayoff":    { en: "Playoffs",          fr: "Séries" },
  "chart.gm.typePre":        { en: "Preseason",         fr: "Préparatoire" },
  "chart.gm.anyOpp":         { en: "Pick an opponent", fr: "Choisir l'adversaire" },
  "chart.gm.venueAll":       { en: "Home + away",       fr: "Domicile + extérieur" },
  "chart.gm.venueHome":      { en: "Home",              fr: "À domicile" },
  "chart.gm.venueAway":      { en: "Away",              fr: "À l'étranger" },
  "chart.gm.resultAll":      { en: "Any result",        fr: "Tous les résultats" },
  "chart.gm.resultW":        { en: "Wins",              fr: "Victoires" },
  "chart.gm.resultL":        { en: "Losses",            fr: "Défaites" },
  "chart.gm.decAll":         { en: "Any ending",        fr: "Toutes les fins" },
  "chart.gm.decREG":         { en: "Regulation",        fr: "Temps réglementaire" },
  "chart.gm.decOT":          { en: "Overtime",          fr: "Prolongation" },
  "chart.gm.decSO":          { en: "Shootout",          fr: "Fusillade" },
  "chart.gm.end":            { en: "End",               fr: "Fin" },
  "chart.gm.reg":            { en: "Reg.",              fr: "Régl." },
  "chart.gm.pastNote":       { en: "{n} games · {scope}", fr: "{n} matchs · {scope}" },
  "chart.gm.noPast":         { en: "No games match these filters.", fr: "Aucun match ne correspond à ces critères." },
  "chart.gm.pickOpp":        { en: "Pick an opponent to see their games.", fr: "Choisissez un adversaire pour voir leurs matchs." },
  "chart.gm.nextDay":        { en: "Next day", fr: "Jour suivant" },
  "chart.gm.prevDay":        { en: "Previous day", fr: "Jour précédent" },
  "chart.gm.day":            { en: "Day", fr: "Jour" },
  "chart.gm.scopeOpp":       { en: "Opponent", fr: "Adversaire" },
  "chart.gm.allGames":       { en: "All games",         fr: "Tous les matchs" },
  "chart.gm.periodScoring":  { en: "Scoring by period", fr: "Pointage par période" },
  "chart.gm.teamStats":      { en: "Game Stats",        fr: "Stats du match" },
  "chart.gm.summary":        { en: "Scoring Summary",   fr: "Résumé du pointage" },
  "chart.gm.stars":          { en: "Three Stars",       fr: "Trois étoiles" },
  "chart.gm.skaters":        { en: "Skaters",           fr: "Patineurs" },
  "chart.gm.goalies":        { en: "Goalies",           fr: "Gardiens" },
  "chart.gm.seasonForm":     { en: "Season Comparison", fr: "Comparaison de saison" },
  "chart.gm.notStarted":     { en: "Stats available once the game starts.", fr: "Stats disponibles au début du match." },
  "chart.gm.shots":          { en: "Shots",             fr: "Tirs" },
  "chart.gm.hits":           { en: "Hits",              fr: "Mises en échec" },
  "chart.gm.blocks":         { en: "Blocked Shots",     fr: "Tirs bloqués" },
  "chart.gm.giveaways":      { en: "Giveaways",         fr: "Revirements" },
  "chart.gm.takeaways":      { en: "Takeaways",         fr: "Revirements provoqués" },
  "chart.gm.ppGoals":        { en: "PP Goals",          fr: "Buts en AN" },
  "chart.gm.pim":            { en: "PIM",               fr: "Min. pén." },
  "chart.gm.period":         { en: "Period",            fr: "Période" },
  "chart.gm.ot":             { en: "OT",                fr: "Prol." },
  "chart.gm.so":             { en: "SO",                fr: "Fusillade" },
  "chart.gm.scheduled":      { en: "Scheduled",         fr: "À venir" },
  "chart.gm.live":           { en: "Live",              fr: "En direct" },
  "chart.gm.final":          { en: "Final",             fr: "Terminé" },
  "chart.allTeams.title":    { en: "All Teams",         fr: "Toutes les équipes" },
  "chart.allTeams.note":     { en: "League performance · {n} teams", fr: "Performance de la ligue · {n} équipes" },
  "chart.searchPlayer":      { en: "Search a player…",  fr: "Rechercher un joueur…" },
  "chart.searchTeam":        { en: "Search a team…",    fr: "Rechercher une équipe…" },
  "chart.noResults":         { en: "No results",        fr: "Aucun résultat" },
  "chart.tm.gp":             { en: "GP",                fr: "PJ" },
  "chart.tm.losses":         { en: "Losses",            fr: "Défaites" },
  "chart.tm.otLosses":       { en: "OT Losses",         fr: "Défaites Prol." },
  "chart.tm.shotsAgainst":   { en: "Shots Against",     fr: "Tirs contre" },
  "chart.tm.shutouts":       { en: "Shutouts",          fr: "Blanchissages" },
  "chart.bar.note":          { en: "Top {n} · stacked", fr: "Top {n} · empilé" },
  "chart.bar.allNote":       { en: "All {n} · stacked", fr: "Les {n} · empilé" },
  "chart.pie.winShare":      { en: "Wins share by goalie",    fr: "Part des victoires par gardien" },
  "chart.pie.shutoutShare":  { en: "Shutouts share by goalie", fr: "Part des blanchissages par gardien" },
  "chart.pie.gpShare":       { en: "Games played share",      fr: "Part des matchs joués" },
  "chart.allPlayers.title":  { en: "Top Players",       fr: "Meilleurs joueurs" },
  "chart.allPlayers.note":   { en: "Top {n} by {metric}", fr: "Top {n} par {metric}" },
  "chart.rank":              { en: "#",                 fr: "#" },

  // ── Page d'accueil des statistiques (/stats/chart) ──
  // Les trois mêmes entrées que les pastilles de l'en-tête, en grand : c'est
  // le point de départ de la section, et le seul endroit où elles sont
  // expliquées. Les mêmes libellés servent aux pastilles (`chart.team`,
  // `chart.game`, `chart.player`) — un bouton ne doit pas changer de nom
  // entre l'accueil et l'en-tête.
  "chart.home":              { en: "Statistics home",   fr: "Accueil statistiques" },
  "chart.home.subtitle":     { en: "Pick where to start — then dig into a single club, game or player.",
                               fr: "Choisissez par où commencer — puis entrez dans un club, un match ou un joueur." },
  "chart.home.teamsDesc":    { en: "Standings, goal differential and special teams for all 32 clubs.",
                               fr: "Classement, différentiel de buts et unités spéciales des 32 clubs." },
  "chart.home.gamesDesc":    { en: "Results and upcoming games, with totals and margins.",
                               fr: "Résultats et matchs à venir, avec totaux et écarts." },
  "chart.home.playersDesc":  { en: "League leaders season by season, skaters and goalies.",
                               fr: "Meneurs de la ligue saison par saison, patineurs et gardiens." },
  "chart.home.pickTeam":     { en: "Or go straight into a club", fr: "Ou entrez directement dans un club" },
  "chart.home.pickTeamNote": { en: "Its games and its players stay inside that club's colours.",
                               fr: "Ses matchs et ses joueurs restent aux couleurs du club." },

  // ── Espace d'une équipe (/stats/chart/team/:abbr/…) ──
  "chart.teamSpace.games":   { en: "{team} · games",    fr: "{team} · matchs" },
  "chart.teamSpace.players": { en: "{team} · players",  fr: "{team} · joueurs" },
  "chart.teamSpace.only":    { en: "This club only",    fr: "Ce club seulement" },
  "pred.llmAnalysis":    { en: "LLM Analysis",          fr: "Analyse LLM" },
  "pred.an.decimal": { en: ".", fr: "," },
  "pred.an.model": { en: "Model", fr: "Modèle" },
  "pred.an.market": { en: "Market", fr: "Marché" },
  "pred.an.edge": { en: "Gap", fr: "Écart" },
  "pred.an.fair": { en: "Fair odds", fr: "Cote juste" },
  "pred.an.book": { en: "Book", fr: "Livre" },
  "pred.an.minor": { en: "{n} secondary factors", fr: "{n} facteurs secondaires" },
  "pred.an.tag.above_market": { en: "Above the market", fr: "Au-dessus du marché" },
  "pred.an.tag.below_market": { en: "Below the market", fr: "Sous le marché" },
  "pred.an.tag.with_market": { en: "In line with the market", fr: "Suit le marché" },
  "pred.an.tag.models_disagree": { en: "Models disagree", fr: "Modèles en désaccord" },
  "pred.an.tag.goalie_dependent": { en: "Depends on the goalie", fr: "Dépend du gardien" },
  "pred.an.tag.high_uncertainty": { en: "Uncertain estimate", fr: "Estimation incertaine" },
  "pred.an.tag.long_shot": { en: "Long shot", fr: "Faible probabilité" },
  "pred.an.tag.live": { en: "Live", fr: "En direct" },
  "pred.an.sol.stable": { en: "Stable estimate", fr: "Estimation stable" },
  "pred.an.sol.moderate": { en: "Moderate estimate", fr: "Estimation modérée" },
  "pred.an.sol.uncertain": { en: "Uncertain estimate", fr: "Estimation incertaine" },
  "pred.markets":        { en: "Markets",               fr: "Marchés" },
  "pred.top90":          { en: "Top 90% +",             fr: "Top 90% +" },
  "pred.tabPlayers":     { en: "Players",               fr: "Joueurs" },
  "pred.tabMarkets":     { en: "Teams / Game",          fr: "Équipes / Match" },
  "pred.top90Hint":      { en: "Bets on this page the ML model rates 90% or higher.", fr: "Les paris de cette page que le modèle ML met à 90 % ou plus." },
  "pred.top90Empty":     { en: "No bet at 90% or higher on this page.", fr: "Aucun pari à 90 % ou plus sur cette page." },
  "pred.top90Loading":   { en: "Loading predictions…",  fr: "Chargement des prédictions…" },
  "pred.foldAll":        { en: "Collapse all",          fr: "Tout plier" },
  "pred.unfoldAll":      { en: "Expand all",            fr: "Tout déplier" },
  "pred.hideAll":        { en: "Hide all",           fr: "Masquer tout" },
  "pred.revealAll":      { en: "Reveal all",         fr: "Révéler tout" },
  "pred.showingRules":   { en: "Rules — all",        fr: "Règles — tout" },
  "pred.showingMl":      { en: "ML — all",           fr: "ML — tout" },
  "pred.tap":            { en: "Tap",                   fr: "Toucher" },
  "pred.today":          { en: "Today",                 fr: "Aujourd'hui" },
  "pred.recommendedBet": { en: "Recommended Bet",       fr: "Pari recommandé" },
  "pred.goToBuilder":    { en: "Go to Bet Builder →",   fr: "Aller au créateur de pari →" },
  "pred.recentForm":     { en: "Recent Form",           fr: "Forme récente" },
  "pred.h2hTitle":       { en: "Head-to-head",          fr: "Confrontations directes" },
  "pred.h2hNone":        { en: "No meetings yet this season", fr: "Aucune confrontation cette saison" },
  "pred.h2hThisSeason":  { en: "This season",           fr: "Cette saison" },
  "pred.h2hPrev":        { en: "Last season",           fr: "Saison précédente" },
  "pred.h2hPrevNone":    { en: "No meetings last season", fr: "Aucune confrontation la saison précédente" },
  "pred.h2hError":       { en: "Couldn't load this season's meetings", fr: "Impossible de charger les confrontations de cette saison" },
  "pred.h2hPrevError":   { en: "Couldn't load last season's meetings", fr: "Impossible de charger la saison précédente" },
  "pred.h2hPlayoffs":    { en: "Playoffs",              fr: "Séries" },
  "pred.h2hOT":          { en: "OT",                    fr: "Prol." },
  "pred.h2hSO":          { en: "SO",                    fr: "TB" },
  "pred.win":            { en: "Win",                   fr: "Victoire" },
  "pred.loss":           { en: "Loss",                  fr: "Défaite" },
  "pred.ranking":        { en: "Ranking",               fr: "Classement" },
  "pred.points":         { en: "Points",                fr: "Points" },
  "pred.predFactors":    { en: "Prediction Factors",    fr: "Facteurs de prédiction" },
  "pred.notFound":       { en: "Not Found",             fr: "Introuvable" },
  "pred.notExist":       { en: "This prediction doesn't exist.", fr: "Cette prédiction n'existe pas." },
  "pred.goBack":         { en: "Go Back",               fr: "Retour" },
  "pred.slipShort":      { en: "In slip",             fr: "Dans le coupon" },
  "pred.slipAddShort":   { en: "+ Slip",                fr: "+ Pari" },
  "pred.addToSlip":      { en: "+ Add to slip",         fr: "+ Ajouter au pari" },
  "pred.addedToSlip":    { en: "Added to slip",       fr: "Ajouté au pari" },
  // Question de suivi après l'Analyse LLM (tâche serveur `ask_followup`, 2026-09-29).
  "pred.followupPlaceholder": { en: "Ask the AI another question…", fr: "Posez une autre question à l'IA…" },
  "pred.followupSend":   { en: "Ask",                   fr: "Envoyer" },
  "pred.lastN":          { en: "Last {n}",              fr: "{n} derniers" },
  "pred.formOverLast":   { en: "Form over last {n} games · {wl}", fr: "Forme sur les {n} derniers matchs · {wl}" },
  "pred.winRateL":       { en: "Win Rate (L{n})",       fr: "Taux de victoire (L{n})" },
  "pred.confHigh":       { en: "High Confidence",       fr: "Confiance élevée" },
  "pred.confModerate":   { en: "Moderate",              fr: "Modérée" },
  "pred.confEven":       { en: "Even Match",            fr: "Match serré" },
  "pred.confUnderdog":   { en: "Underdog Pick",         fr: "Choix outsider" },
  "pred.chooseTeam":     { en: "Which team are you betting on?", fr: "Sur quelle équipe pariez-vous ?" },
  "pred.bettingOn":      { en: "Betting on",            fr: "Pari sur" },
  "pred.change":         { en: "Change",                fr: "Changer" },
  "pred.odds":           { en: "Odds",                  fr: "Cote" },
  "pred.unavailable":               { en: "Model prediction unavailable",                       fr: "Prédiction du modèle indisponible" },
  "pred.rulesUnavailable":          { en: "Predictions unavailable",                            fr: "Prédictions indisponibles" },
  "pred.unavailableNotConfigured":  { en: "Prediction service not configured",                  fr: "Service de prédiction non configuré" },
  "pred.unavailableOffline":        { en: "Prediction service unreachable",                     fr: "Service de prédiction injoignable" },
  "pred.unavailableHint":           { en: "No estimate is shown rather than a made-up one. Try again shortly.", fr: "Aucune estimation n'est affichée plutôt qu'un chiffre inventé. Réessayez dans un instant." },
  "pred.unavailableLeg":            { en: "Can't add this leg — no model probability right now.", fr: "Impossible d'ajouter cette jambe — pas de probabilité du modèle pour l'instant." },
  "pred.unavailableParlay":         { en: "Combined probability unavailable",                   fr: "Probabilité combinée indisponible" },
  "lastn.noData":                   { en: "No data",                                            fr: "Pas de données" },
  "pred.viewPlayers":    { en: "View players",       fr: "Voir les joueurs" },
  // Game picker (player & team pages) + players table (game page)
  "pred.forGame":        { en: "Bets for game",         fr: "Paris pour le match" },
  "pred.chooseGame":     { en: "Choose a game",         fr: "Choisir un match" },
  "pred.viewGame":       { en: "View game →",           fr: "Voir le match →" },
  "pred.noUpcoming":     { en: "No game scheduled in the next 14 days", fr: "Aucun match prévu dans les 14 prochains jours" },
  "pred.playersTable":   { en: "Players",               fr: "Joueurs" },
  "pred.seasonStats":    { en: "Season stats",          fr: "Stats de la saison" },
  "pred.viewRoster":     { en: "View full roster stats →", fr: "Voir les stats de l'effectif →" },
  "news.title":         { en: "Latest news",           fr: "Dernières nouvelles" },
  "news.flag.goalie":   { en: "Goalie",                fr: "Gardien" },
  "news.flag.lineup":   { en: "Lineup",                fr: "Alignement" },
  "news.alerts":        { en: "{n} lineup/goalie",     fr: "{n} alignement/gardien" },
  "news.sourceNote":    { en: "Links to the original posts by teams and reporters.", fr: "Liens vers les publications d'origine des équipes et journalistes." },
  "pickem.title":       { en: "What users predict",    fr: "Ce que les utilisateurs prédisent" },
  "pickem.voters":      { en: "{n} voters",            fr: "{n} votants" },
  "pickem.closed":      { en: "Picks closed",          fr: "Votes fermés" },
  "pickem.yourPick":    { en: "Your pick",             fr: "Votre choix" },
  "pickem.note":        { en: "Users' picks, not the model's prediction.", fr: "Votes des utilisateurs, pas la prédiction du modèle." },
  "pickem.notEnough":   { en: "Not enough votes yet ({n}/{min}).", fr: "Pas encore assez de votes ({n}/{min})." },
  "pickem.error":       { en: "Your pick could not be saved. Try again.", fr: "Votre choix n'a pas pu être enregistré. Réessayez." },
  "pickem.day.title":       { en: "Today's picks",        fr: "Votes du jour" },
  "pickem.day.summary":     { en: "{n} votes · your picks {mine}/{games}", fr: "{n} votes · vos choix {mine}/{games}" },
  "pickem.day.votes":       { en: "{n}/{min} votes",      fr: "{n}/{min} votes" },
  "pickem.day.live":        { en: "Live",                 fr: "En cours" },
  "pickem.day.final":       { en: "Final",                fr: "Final" },
  "pickem.day.publicRight": { en: "The crowd was right",  fr: "Le public avait raison" },
  "pickem.day.publicWrong": { en: "The crowd was wrong",  fr: "Le public s'est trompé" },
  "pickem.board.title":     { en: "Weekly leaderboard",   fr: "Classement de la semaine" },
  "pickem.board.thisWeek":  { en: "This week",            fr: "Cette semaine" },
  "pickem.board.lastWeek":  { en: "Last week",            fr: "Semaine dernière" },
  "pickem.board.model":     { en: "Model",                fr: "Modèle" },
  "pickem.board.crowd":     { en: "Crowd",                fr: "Public" },
  "pickem.board.you":       { en: "You",                  fr: "Vous" },
  "pickem.board.sameGames": { en: "Model and crowd on the same games as the users' picks.", fr: "Modèle et public sur les mêmes matchs que les votes des utilisateurs." },
  "pickem.board.empty":     { en: "No one ranked yet: {min} settled picks needed this week.", fr: "Personne de classé : il faut {min} picks réglés dans la semaine." },
  "pickem.board.myRank":    { en: "You are {ord} of {n}.", fr: "Vous êtes {ord} sur {n}." },
  "pickem.board.notRanked": { en: "{n}/{min} settled picks: not ranked yet.", fr: "{n}/{min} picks réglés : pas encore classé." },
  "pickem.error.load":      { en: "The leaderboard could not be loaded.", fr: "Le classement n'a pas pu être chargé." },
  "pred.bookOdds":       { en: "Book odds",             fr: "Cote du livre" },

  // ── Grilles de paris joueur (buts / passes / tirs bloqués) ──────────────
  "prop.goals":          { en: "Goals",                 fr: "Buts" },
  "prop.assists":        { en: "Assists",               fr: "Passes" },
  "prop.points":         { en: "Points",                fr: "Points" },
  "prop.shots":          { en: "Shots on goal",         fr: "Tirs au but" },
  "prop.hits":           { en: "Hits",                  fr: "Mises en échec" },
  "prop.blocks":         { en: "Blocked shots",         fr: "Tirs bloqués" },
  "prop.saves":          { en: "Saves",                 fr: "Arrêts" },
  "prop.firstGoal":      { en: "First goal scorer",     fr: "Premier buteur" },
  "prop.firstShort":     { en: "1st",                   fr: "1er" },
  "prop.live":           { en: "LIVE",                  fr: "EN DIRECT" },
  "prop.tonight":        { en: "Tonight",               fr: "Ce soir" },
  "prop.reached":        { en: "Already reached this game", fr: "Déjà atteint dans ce match" },
  "prop.liveNote":       {
    en: "Live: {name} already has {done} tonight; {left} expected over the time left → P({k}+) = {pct}%.",
    fr: "En direct : {name} en a déjà {done} ce soir ; {left} attendus sur le temps restant → P({k}+) = {pct} %.",
  },
  "prop.firstNote":      {
    en: "{name} scores in a game {any}% of the time. Roughly one goal in six is the game's first, so opening the scoring is far rarer than scoring at all. Season rate: {rate} goals/game.",
    fr: "{name} marque dans {any} % de ses matchs. Environ un but sur six est le premier du match, donc ouvrir le score est bien plus rare que marquer. Cadence de saison : {rate} but/match.",
  },
  "prop.top5":           { en: "Top 5",                 fr: "Top 5" },
  "prop.mlNote":         {
    en: "Adjusted rate {rate}/game (season shrunk toward the position average over {gp} GP, adjusted for the opponent), spread k={k} → P({label}) = {pct}%.",
    fr: "Cadence ajustée {rate}/match (saison ramenée vers la moyenne du poste sur {gp} MJ, ajustée à l'adversaire), dispersion k={k} → P({label}) = {pct} %.",
  },
  "prop.mlFirstNote":    {
    en: "Share of the game's goals ({rate}/game of ~{game} expected) × chance of at least one goal → {pct}%.",
    fr: "Part des buts du match ({rate}/match sur ~{game} attendus) × chance qu'il y ait au moins un but → {pct} %.",
  },
  "prop.mlModel":        { en: "Adjusted rate", fr: "Cadence ajustée" },
  "prop.playerModel":    { en: "Player model", fr: "Modèle joueur" },
  "prop.shotsModel":     { en: "Shots model", fr: "Modèle de tirs" },
  "prop.shotsModelNote": {
    en: "Opponent's expected shots on goal × this goalie's save % (shots model, adjusted for games he doesn't finish): {rate} saves/game, k={k} → P({label}) = {pct}%.",
    fr: "Tirs cadrés attendus de l'adversaire × % d'arrêts de ce gardien (modèle de tirs, corrigé des matchs qu'il ne finit pas) : {rate} arrêts/match, k={k} → P({label}) = {pct} %.",
  },
  "prop.playerModelNote": {
    en: "Player model (ice time, power-play time, linemates' xG, per-60 production, opponent): {rate}/game, k={k} → P({label}) = {pct}%.",
    fr: "Modèle joueur (temps de glace, temps en avantage numérique, xG des coéquipiers, production par 60 min, adversaire) : {rate}/match, k={k} → P({label}) = {pct} %.",
  },
  "prop.starterConfirmed": { en: "Tonight's goalie",    fr: "Gardien du match" },
  "prop.starterProbable":  { en: "Probable starter",    fr: "Partant probable" },
  "prop.allPlayers":     { en: "All players",           fr: "Tous les joueurs" },
  "prop.showMore":       { en: "See more ({n}) ▼",      fr: "Voir plus ({n}) ▼" },
  "prop.showLess":       { en: "See less ▲",            fr: "Voir moins ▲" },
  "prop.noStat":         { en: "No data for this stat yet this season.", fr: "Pas encore de données pour cette statistique cette saison." },
  "prop.note":           {
    en: "Poisson model: {name} averages {rate} {metric}/game ({total} in {gp} games) → probability of {k}+ in a single game.",
    fr: "Modèle de Poisson : {name} tourne à {rate} {metric}/match ({total} en {gp} matchs) → probabilité de {k}+ sur un match.",
  },
  "pred.playerCharts":   { en: "Stats",                 fr: "Stats" },
  "pred.playerTeam":     { en: "Team",                  fr: "Équipe" },
  "pred.playerPreds":    { en: "Predictions",           fr: "Prédictions" },
  "pred.playerBackToStats": { en: "Back to his stats",  fr: "Revoir ses stats" },
  "pro.back":            { en: "Back",                  fr: "Retour" },
  // ── Market selector sheet ──
  "mkt.addPrediction": { en: "Add Prediction",   fr: "Ajouter une prédiction" },
  "mkt.selectMarket":  { en: "Select Market",    fr: "Choisir un marché" },
  "mkt.configure":     { en: "Configure",        fr: "Configurer" },
  "mkt.search":        { en: "Search team, player, or game…", fr: "Cherchez une équipe, un joueur ou un match…" },
  "mkt.games":         { en: "Games",         fr: "Matchs" },
  "mkt.teams":         { en: "Teams",         fr: "Équipes" },
  "mkt.players":       { en: "Players",        fr: "Joueurs" },
  "mkt.backToMarkets": { en: "← Back to markets", fr: "← Retour aux marchés" },
  "mkt.line":          { en: "Line ({unit})",    fr: "Ligne ({unit})" },
  "mkt.selection":     { en: "Selection",        fr: "Sélection" },
  "mkt.gameFor":       { en: "Game",             fr: "Match" },
  "mkt.noUpcomingGame":{ en: "No upcoming game for this team — a team bet needs one.", fr: "Aucun match à venir pour cette équipe — un pari d'équipe en exige un." },
  "mkt.noUpcomingGamePlayer":{ en: "No upcoming game for this player's team — a player bet needs one.", fr: "Aucun match à venir pour l'équipe de ce joueur — un pari joueur en exige un." },
  // ── Bet builder IA (SlipCommandSheet, 2026-09-28) — à ne JAMAIS confondre
  //    avec l'« Analyse LLM » d'un pari individuel (PredictionSheet, explain_bet). ──
  "cmd.open":          { en: "AI bet builder", fr: "Bet builder IA" },
  "cmd.title":         { en: "AI bet builder", fr: "Bet builder IA" },
  "cmd.close":         { en: "Close", fr: "Fermer" },
  "cmd.placeholder":   { en: "e.g. Habs win tonight", fr: "ex. Canadien gagne ce soir" },
  "cmd.submit":        { en: "Add", fr: "Ajouter" },
  "cmd.working":       { en: "Adding…", fr: "Ajout…" },
  "cmd.examples":      { en: "Try", fr: "Essayez" },
  "cmd.ex1":           { en: "Habs win tonight", fr: "Canadien gagne ce soir" },
  "cmd.ex2":           { en: "Suzuki over 2.5 shots", fr: "Suzuki plus de 2,5 tirs" },
  "cmd.ex3":           { en: "Leafs ML and over 6.5", fr: "Leafs ML et over 6.5" },
  "cmd.loading":       { en: "Loading games…", fr: "Chargement des matchs…" },
  "cmd.loadError":     { en: "The schedule is unavailable. Try again later.", fr: "Calendrier indisponible. Réessayez plus tard." },
  "cmd.noGames":       { en: "No NHL game in the next {days} days: nothing to bet on for now.", fr: "Aucun match LNH dans les {days} prochains jours : rien à parier pour l'instant." },
  "cmd.undo":          { en: "Undo", fr: "Annuler" },
  "cmd.undone":        { en: "Removed", fr: "Retiré" },
  "cmd.duplicate":     { en: "Already in your slip: {label}", fr: "Déjà dans le coupon : {label}" },
  "cmd.unavailable":   { en: "No probability for {label}: not added.", fr: "Probabilité indisponible pour {label} : pas ajouté." },
  "cmd.missing":       { en: "Couldn't prepare {label}: not added.", fr: "Impossible de préparer {label} : pas ajouté." },
  "cmd.empty":         { en: "Type a bet, e.g. “Habs win tonight”.", fr: "Tapez un pari, ex. « Canadien gagne ce soir »." },
  "cmd.unknown":       { en: "I didn't understand “{chunk}”.", fr: "Je n'ai pas compris « {chunk} »." },
  "cmd.whichTeam":     { en: "“{alias}”: which team?", fr: "« {alias} » : quelle équipe ?" },
  "cmd.whichPlayer":   { en: "Which {alias}?", fr: "Quel {alias} ?" },
  "cmd.didYouMean":    { en: "“{word}”: did you mean…", fr: "« {word} » : vouliez-vous dire…" },
  "cmd.whichLine":     { en: "Which line?", fr: "Quelle ligne ?" },
  "cmd.lineNotOffered":{ en: "Line {line} isn't offered. Pick one:", fr: "La ligne {line} n'est pas offerte. Choisissez :" },
  "cmd.whichTotal":    { en: "Game total or {team} total?", fr: "Total du match ou total de {team} ?" },
  "cmd.gameTotal":     { en: "Game total {line}", fr: "Total du match {line}" },
  "cmd.gameMissing":   { en: "Which game? Name a team, e.g. “Habs Leafs over 6.5”.", fr: "Quel match ? Nomme une équipe, ex. « Habs Leafs over 6.5 »." },
  "cmd.noGameToday":   { en: "{subject} doesn't play tonight.", fr: "{subject} ne joue pas ce soir." },
  "cmd.noGameTomorrow":{ en: "{subject} doesn't play tomorrow.", fr: "{subject} ne joue pas demain." },
  "cmd.noGameNext":    { en: "No upcoming game for {subject} in the next {days} days.", fr: "Aucun match à venir pour {subject} dans les {days} prochains jours." },
  "cmd.position":      { en: "That market doesn't fit this player (saves are for goalies).", fr: "Ce marché ne va pas à ce joueur (les arrêts, c'est pour un gardien)." },
  "cmd.tooLong":       { en: "Too long: {max} characters at most.", fr: "Trop long : {max} caractères au maximum." },
  "cmd.tooMany":       { en: "{max} bets at most per sentence.", fr: "{max} paris au maximum par phrase." },
  "cmd.aiWorking":     { en: "The AI bet builder is reading your bet…", fr: "Le Bet builder IA lit votre pari…" },
  "cmd.aiUnclear":     { en: "The AI bet builder couldn't read that sentence either.", fr: "Le Bet builder IA n'a pas su lire cette phrase non plus." },
  "cmd.aiError":       { en: "The AI bet builder is unavailable right now. The reader without AI still works.", fr: "Le Bet builder IA est indisponible pour le moment. La lecture sans IA reste disponible." },
  // « Scanner un ticket » — SCAN_TICKET_PLAN S3 (ScanSlipSheet).
  "scan.open":         { en: "Scan a slip", fr: "Scanner un ticket" },
  "scan.title":        { en: "Scan a slip", fr: "Scanner un ticket" },
  "scan.hint":         { en: "Import a screenshot of a bet365 or DraftKings slip. Each leg gets the model's probability.", fr: "Importez une capture d'écran d'un ticket bet365 ou DraftKings. Chaque jambe reçoit la probabilité du modèle." },
  "scan.pick":         { en: "Choose a screenshot", fr: "Choisir une capture" },
  "scan.privacy":      { en: "The image is read on your device and never uploaded. Stake and balance are ignored.", fr: "L'image est lue sur votre appareil et n'est jamais envoyée. La mise et le solde sont ignorés." },
  "scan.reading":      { en: "Reading the slip…", fr: "Lecture du ticket…" },
  "scan.loginNeeded":  { en: "Log in to scan a slip (3 free scans a day).", fr: "Connectez-vous pour scanner un ticket (3 scans gratuits par jour)." },
  "scan.login":        { en: "Log in", fr: "Se connecter" },
  "scan.freeLeft":     { en: "{n} of {limit} free scans left today", fr: "{n} scan(s) gratuit(s) sur {limit} restant(s) aujourd'hui" },
  "scan.errNotImage":  { en: "That file isn't an image.", fr: "Ce fichier n'est pas une image." },
  "scan.errTooLarge":  { en: "That image is too large for a screenshot.", fr: "Cette image est trop lourde pour une capture d'écran." },
  "scan.errFailed":    { en: "The slip couldn't be read. Try a sharper screenshot.", fr: "Le ticket n'a pas pu être lu. Essayez une capture plus nette." },
  "scan.empty":        { en: "No NHL bet found on this screenshot.", fr: "Aucun pari LNH trouvé sur cette capture." },
  "scan.quota":        { en: "You've used your {limit} free scans for today. Go Pro for unlimited scans.", fr: "Vous avez utilisé vos {limit} scans gratuits aujourd'hui. Passez Pro pour des scans illimités." },
  "scan.unavailable":  { en: "Scanning is unavailable right now. Try again in a moment.", fr: "Le scan est indisponible pour le moment. Réessayez dans un instant." },
  "scan.sgp":          { en: "Same game parlay", fr: "Pari personnalisé" },
  "scan.single":       { en: "Single", fr: "Simple" },
  "scan.partial":      { en: "{ok} of {total} legs can be added; the rest are shown as read.", fr: "{ok} jambe(s) sur {total} peuvent être ajoutées ; les autres sont montrées telles que lues." },
  "scan.askAi":        { en: "Let the AI read {n} unreadable leg(s)", fr: "Faire lire {n} jambe(s) illisible(s) par l'IA" },
  "scan.aiWorking":    { en: "The AI is reading the unreadable legs…", fr: "L'IA lit les jambes illisibles…" },
  "scan.aiRead":       { en: "Read by AI, check it", fr: "Lue par l'IA, vérifiez" },
  "scan.add":          { en: "Add {n} leg(s) to my slip", fr: "Ajouter {n} jambe(s) au coupon" },
  "scan.another":      { en: "Scan another slip", fr: "Scanner un autre ticket" },
  "scan.analyse":      { en: "Analyze this slip", fr: "Analyser ce ticket" },
  "scan.analysing":    { en: "Analyzing…", fr: "Analyse…" },
  "scan.ticket":       { en: "Whole slip", fr: "Ticket entier" },
  "scan.weakest":      { en: "Weakest leg", fr: "Maillon faible" },
  "scan.tax":          { en: "{pct}% parlay tax", fr: "Taxe de {pct} % sur le combiné" },
  "scan.value":        { en: "Pays {pct}% over fair", fr: "Paie {pct} % de plus que le juste prix" },
  "scan.fair":         { en: "Priced about fair", fr: "Prix à peu près juste" },
  "scan.verdictDetail":{ en: "Model {model}% · price implies {implied}% · fair odds {fair}", fr: "Modèle {model} % · le prix implique {implied} % · cote juste {fair}" },
  "scan.modelOnly":    { en: "Model {pct}% (no odds read for this bet)", fr: "Modèle {pct} % (aucune cote lue pour ce pari)" },
  "scan.partialGroup": { en: "Not every leg could be priced: no figure shown for this bet.", fr: "Toutes les jambes ne sont pas chiffrées : aucun chiffre pour ce pari." },
  "scan.share":        { en: "Share the card", fr: "Partager la carte" },
  "scan.shareError":   { en: "The card couldn't be shared on this device.", fr: "La carte n'a pas pu être partagée sur cet appareil." },
  "scan.shareBrand":   { en: "PARLAY GRADE", fr: "NOTE DU COMBINÉ" },
  "scan.sharePaid":    { en: "Paid", fr: "Payé" },
  "scan.shareFair":    { en: "Fair (arakiceML)", fr: "Juste (arakiceML)" },
  "scan.shareDetail":  { en: "arakiceML: {model}% to hit. The price implies {implied}%.", fr: "arakiceML : {model} % de chances. Le prix implique {implied} %." },
  "scan.shareDisclaimer": { en: "18+ (21+ US). Not betting advice. Gamble responsibly.", fr: "18+ (21+ É.-U.). Pas un conseil de pari. Jouez de façon responsable." },
  "scan.shareMore":    { en: "+ {n} more", fr: "+ {n} autre(s)" },
  "scan.state.ok":                 { en: "Ready", fr: "Prête" },
  "scan.state.ambiguous":          { en: "Which one?", fr: "Lequel ?" },
  "scan.state.unsupported_market": { en: "Market not covered", fr: "Marché non couvert" },
  "scan.state.unsupported_line":   { en: "Line not covered", fr: "Ligne non couverte" },
  "scan.state.no_game":            { en: "Game already played or not found", fr: "Match déjà joué ou introuvable" },
  "scan.state.unreadable":         { en: "Couldn't read", fr: "Illisible" },
  "cmd.aiFreeQuota":   { en: "You've used your {limit} free AI bet builder tries for today. Go Pro so the AI can understand more complex bets.", fr: "Vous avez utilisé vos {limit} essais gratuits du Bet builder IA aujourd'hui. Passez Pro pour que l'IA comprenne des paris plus complexes." },
  "cmd.aiFreeLeft":    { en: "AI bet builder free tries left today: {n} of {limit}", fr: "Essais gratuits restants du Bet builder IA aujourd'hui : {n} sur {limit}" },
  "cmd.aiProUsed":     { en: "Monthly AI allowance, shared with LLM Analysis: {used} of {limit}", fr: "Quota IA du mois, partagé avec l'Analyse LLM : {used} sur {limit}" },
  "cmd.aiOwnKey":      { en: "The AI bet builder uses your OpenAI key.", fr: "Le Bet builder IA utilise votre clé OpenAI." },
  "mkt.draw60":        { en: "Draw after 60 min", fr: "Nul après 60 min" },
  "mkt.orDraw":        { en: "{team} or draw (60 min)", fr: "{team} ou nul (60 min)" },
  "mkt.noDraw":        { en: "{a} or {b} — no draw (60 min)", fr: "{a} ou {b} — pas de nul (60 min)" },
  "mkt.addedSlip":     { en: "Added to Slip!", fr: "Ajouté au pari !" },
  "mkt.adding":        { en: "Adding…",          fr: "Ajout…" },
  "mkt.addToSlip":     { en: "Add to Prediction Slip", fr: "Ajouter au pari de prédiction" },

  // ── ML prediction card ──
  "ml.title":        { en: "ML Prediction",   fr: "Prédiction ML" },
  "ml.aiPrediction": { en: "AI Prediction",   fr: "Prédiction IA" },
  "ml.conf":         { en: "{n}% conf.",      fr: "{n} % conf." },
  "ml.confidence":   { en: "{n}% confidence", fr: "{n} % de confiance" },
  "ml.probability":  { en: "probability",     fr: "probabilité" },
  "ml.vsRules":      { en: "{d}% vs rules",   fr: "{d} % vs règles" },
  "ml.rules":        { en: "Rules",           fr: "Règles" },
  "ml.rulesColon":   { en: "Rules:",          fr: "Règles :" },
  "ml.sameSignal":   { en: "≈ same signal",   fr: "≈ même signal" },
  "ml.keyFactors":   { en: "Key model factors", fr: "Facteurs clés du modèle" },
  "ml.topFactors":   { en: "Top Factors",     fr: "Facteurs principaux" },
  // ── Facteurs du modèle de score (S4 ②) ─────────────────────────────────────
  // Le service ML renvoie une CLÉ (`factor.attack`, …) et non un libellé, pour
  // que le facteur soit traduit comme le reste. Un nom inconnu — les colonnes
  // brutes du repli classifieur — s'affiche tel quel, cf. `factorLabel`.
  "ml.factor.attack":        { en: "Attack",           fr: "Attaque" },
  "ml.factor.opp_defense":   { en: "Opponent defense", fr: "Défense adverse" },
  "ml.factor.goalie":        { en: "Goaltending",      fr: "Gardien" },
  "ml.factor.lineup":        { en: "Lineup",           fr: "Alignement" },
  "ml.factor.schedule":      { en: "Schedule",         fr: "Calendrier" },
  "ml.factor.team_strength": { en: "Team strength",    fr: "Force d'équipe" },
  "ml.factor.home_ice":      { en: "Home ice",         fr: "Avantage glace" },
  // Filet de `_factor_of` côté service : ne devrait jamais s'afficher.
  "ml.factor.other":         { en: "Other",            fr: "Autres" },
  "ml.verdictStrong":{ en: "Strong signal ▲", fr: "Fort signal ▲" },
  "ml.verdictPos":   { en: "Positive signal", fr: "Signal positif" },
  "ml.verdictNeutral":{ en: "Neutral signal", fr: "Signal neutre" },
  "ml.verdictWeak":  { en: "Weak signal ▼",   fr: "Signal faible ▼" },
  // ── Modèle indisponible ────────────────────────────────────────────────────
  // `ml.explainFallback` a été retiré avec le repli qu'il habillait : il servait
  // de légende à `rulePct ± 3` en le décrivant comme une « estimation ML basée
  // sur les statistiques de saison ». La phrase était bien plus crédible que le
  // chiffre.
  "ml.unavailable":     { en: "Model unavailable", fr: "Modèle indisponible" },
  "ml.unavailableHint": {
    en: "The prediction service didn't answer, so there's no model number for this bet. The rule-based score below is unaffected.",
    fr: "Le service de prédiction n'a pas répondu : il n'y a pas de chiffre du modèle pour ce pari. Le score de règles ci-dessous n'est pas affecté.",
  },

  // ── Mises en garde servies AVEC un chiffre (`caveat` de /api/predict/single) ─
  "ml.caveat.league_average": {
    en: "League average for this position — the NHL feed carries no per-player data for this stat, so every player at this position gets the same number.",
    fr: "Moyenne de ligue pour ce poste — le flux NHL ne fournit aucune donnée par joueur pour cette statistique : tous les joueurs du même poste reçoivent le même chiffre.",
  },
  "ml.caveat.shared_with_first_goal": {
    en: "Same estimate as first goal scorer: under this model every goal in the game is equally likely to be his, so first and last come out the same.",
    fr: "Même estimation que « premier buteur » : sous ce modèle, chaque but du match a la même chance d'être le sien, donc premier et dernier donnent le même chiffre.",
  },
  "ml.caveat.period_symmetric": {
    en: "Assumes all three periods score at the same rate — the app has no per-period data yet, so it can't model the busier third period.",
    fr: "Suppose les trois périodes équivalentes — l'application n'a pas encore de données par période et ne peut donc pas modéliser un 3e plus prolifique.",
  },

  // ── Last N games section ──
  "lastn.selectTeam":  { en: "Select a team",     fr: "Choisissez une équipe" },
  "lastn.chooseTeam":  { en: "Choose a team…",    fr: "Choisissez une équipe…" },
  "lastn.searchTeam":  { en: "Search team…",      fr: "Cherchez une équipe…" },
  "lastn.selectSpan":  { en: "Select span",       fr: "Choisissez une période" },
  "lastn.lastGames":   { en: "Last {n} Games",    fr: "{n} derniers matchs" },
  "lastn.loading":     { en: "Loading…",          fr: "Chargement…" },
  "lastn.explore":     { en: "Select a team above to explore their recent form", fr: "Choisissez une équipe ci-dessus pour explorer sa forme récente" },

  // ── Players tab ──
  "players.selectTeam":  { en: "Select a team",     fr: "Choisissez une équipe" },
  "players.loading":     { en: "loading…",          fr: "chargement…" },
  "players.count":       { en: "{n} players",       fr: "{n} joueurs" },
  "players.none":        { en: "No players found for {abbr}", fr: "Aucun joueur trouvé pour {abbr}" },
  "players.pickHint":    { en: "← Pick a team to see its players", fr: "← Choisissez une équipe pour voir ses joueurs" },

  // ── Share page ──
  // `share.title` / `heading` / `slipId` / `soon` retirées avec SharePage le
  // 2026-09-06 (Guideline 2.1 / 4.2). `share.goHome` reste : NotFoundPage s'en
  // sert, c'est son seul appelant.
  "share.goHome":     { en: "Go to Home",         fr: "Aller à l'accueil" },

  // ── Login ──
  "login.title":     { en: "Welcome back",     fr: "Bon retour" },
  "login.email":     { en: "Email",            fr: "Courriel" },
  "login.password":  { en: "Password",         fr: "Mot de passe" },
  "login.signin":    { en: "Sign In",          fr: "Se connecter" },
  "login.signup":    { en: "Create Account",   fr: "Créer un compte" },
  "login.google":    { en: "Continue with Google", fr: "Continuer avec Google" },
  "login.username":  { en: "Username",         fr: "Nom d'utilisateur" },
  "login.firstName": { en: "First name (optional)", fr: "Prénom (facultatif)" },
  "login.or":        { en: "or",               fr: "ou" },
  "login.error":     { en: "Something went wrong", fr: "Une erreur est survenue" },
  "login.disclaimer":{ en: "18+ · Gamble Responsibly · Not available in all jurisdictions", fr: "18+ · Jouez de manière responsable · Non disponible dans toutes les juridictions" },
  "login.codeSent":   { en: "We sent a 6-digit code to your email.", fr: "Nous avons envoyé un code à 6 chiffres à votre courriel." },
  "login.verifyPrompt":{ en: "Enter the confirmation code sent to", fr: "Entrez le code de confirmation envoyé à" },
  "login.verifyBtn":  { en: "Confirm",            fr: "Confirmer" },
  "login.resend":     { en: "Resend code",        fr: "Renvoyer le code" },
  "login.back":       { en: "← Back",             fr: "← Retour" },
  "login.remember":   { en: "Keep me logged in",  fr: "Rester connecté" },
  "login.forgot":     { en: "Forgot password?",   fr: "Mot de passe oublié ?" },
  "login.forgotPrompt":{ en: "Enter your email and we'll send you a reset code.", fr: "Entrez votre courriel et nous vous enverrons un code de réinitialisation." },
  "login.sendCode":   { en: "Send code",          fr: "Envoyer le code" },
  "login.newPassword":{ en: "New password",       fr: "Nouveau mot de passe" },
  "login.resetBtn":   { en: "Reset password",     fr: "Réinitialiser le mot de passe" },
  "login.resetDone":  { en: "Password updated — you can now sign in.", fr: "Mot de passe mis à jour — vous pouvez vous connecter." },
  "login.confirmPassword": { en: "Confirm password", fr: "Confirmez le mot de passe" },
  "login.pwdMismatch": { en: "Passwords do not match.", fr: "Les mots de passe ne correspondent pas." },
  "login.introTitle": { en: "Smarter bets, backed by data", fr: "Des paris plus malins, basés sur les données" },
  "login.introSubtitle": { en: "Sign in to unlock the full experience.", fr: "Connectez-vous pour débloquer toute l'expérience." },
  "login.continueGuest": { en: "Browse without signing in →", fr: "Parcourir sans se connecter →" },
  "login.feat1Title": { en: "AI predictions", fr: "Prédictions IA" },
  "login.feat1Body": { en: "Model-driven win probabilities on every market.", fr: "Probabilités de victoire par modèle sur chaque marché." },
  "login.feat2Title": { en: "Best bets & edges", fr: "Meilleurs paris & edges" },
  "login.feat2Body": { en: "Pre-ranked value picks across live and upcoming games.", fr: "Sélections de valeur classées pour les matchs en direct et à venir." },
  "login.feat3Title": { en: "Build & track slips", fr: "Créez & suivez vos paris" },
  "login.feat3Body": { en: "Combine legs, lock slips and follow your results.", fr: "Combinez vos sélections, verrouillez et suivez vos résultats." },

  // ── Pro / subscription ──
  "pro.title":        { en: "Go ArakIce Pro",  fr: "Passez à ArakIce Pro" },
  // « illimitée » retiré ici aussi le 2026-09-08 : ce sous-titre s'affiche sur
  // /pro ET dans la carte Abonnement des Réglages, donc corriger seulement le
  // bloc d'avantages aurait laissé la promesse fausse à deux endroits.
  "pro.subtitle":     { en: "Unlock the full edge: every prediction, the value-bet finder, and AI analysis.", fr: "Débloquez l'avantage complet : toutes les prédictions, le détecteur de value bets et l'analyse IA." },
  "pro.included":     { en: "Included in Pro", fr: "Inclus dans Pro" },
  "pro.badge":        { en: "Pro",             fr: "Pro" },
  "pro.unlock":       { en: "Unlock with Pro", fr: "Débloquer avec Pro" },
  "pro.perMonth":     { en: "/mo",             fr: "/mois" },
  "pro.perYear":      { en: "/yr",             fr: "/an" },
  "pro.billingPeriod":{ en: "Billing period",  fr: "Cadence de facturation" },
  "pro.planMonthly":  { en: "Monthly",         fr: "Mensuel" },
  "pro.planYearly":   { en: "Yearly",          fr: "Annuel" },
  // `{price}` est injecté depuis ProPage pour que le montant annuel ne soit
  // écrit qu'à UN endroit (les constantes de la page). Deux prix à tenir à jour
  // dans deux fichiers finissent toujours par diverger, et ici diverger veut
  // dire annoncer un montant que Stripe ne débitera pas.
  "pro.annualNote":   { en: "or {price}/yr — 2 months free", fr: "ou {price}/an — 2 mois offerts" },
  "pro.yearlyNote":   { en: "That's $5/mo — 2 months free vs monthly.", fr: "Soit 5 $/mois — 2 mois offerts par rapport au mensuel." },
  "pro.cta":          { en: "Upgrade to Pro",  fr: "Passer à Pro" },
  "pro.startTrial":   { en: "Start 7-day free trial", fr: "Commencer l'essai gratuit 7 jours" },
  "pro.trialNote":    { en: "Start with 7 days free, then billed monthly.", fr: "7 jours gratuits, puis facturé mensuellement." },
  "pro.trialNoteYearly": { en: "Start with 7 days free, then billed yearly.", fr: "7 jours gratuits, puis facturé annuellement." },
  "pro.trialActive":  { en: "Free trial active", fr: "Essai gratuit actif" },
  "pro.trialEnds":    { en: "Trial ends on",   fr: "Essai se termine le" },
  "pro.loginPrompt":  { en: "Sign in to subscribe", fr: "Connectez-vous pour vous abonner" },
  "pro.cancel":       { en: "Cancel subscription", fr: "Annuler l'abonnement" },
  "pro.isProTitle":   { en: "You're Pro",   fr: "Vous êtes Pro" },
  "pro.isProBody":    { en: "Thanks! You have access to everything.", fr: "Merci ! Vous avez accès à toutes les fonctionnalités." },
  "pro.renews":       { en: "Renews on",       fr: "Renouvellement le" },
  "pro.cancelScheduled": { en: "Your Pro access ends on", fr: "Votre accès Pro se termine le" },
  "pro.successTitle": { en: "Welcome to ArakIce Pro", fr: "Bienvenue dans ArakIce Pro" },
  "pro.successBody":  { en: "Your Pro access is active. Enjoy every prediction, alert and market — no limits.", fr: "Votre accès Pro est activé. Profitez de toutes les prédictions, alertes et marchés — sans limite." },
  "pro.successHome":  { en: "Back to home",    fr: "Retour à l'accueil" },
  "pro.getPro":       { en: "Get ArakIce Pro", fr: "Passer à ArakIce Pro" },
  "pro.manage":       { en: "Manage subscription", fr: "Gérer l'abonnement" },
  "pro.settingsCancel": { en: "Cancel subscription", fr: "Annuler l'abonnement" },
  "pro.canceling":    { en: "Canceling…",      fr: "Annulation…" },
  // Ce que « annuler » veut dire ici : on coupe le RENOUVELLEMENT, on ne coupe
  // pas l'accès. Le serveur pose `cancel_at_period_end` chez Stripe et en base
  // (`subscription.service.cancel`), donc le Pro court jusqu'à la fin de la
  // période déjà payée. Le dire dans la boîte de confirmation évite la seule
  // lecture coûteuse de ce bouton : « j'ai payé le mois et je perds tout ».
  "pro.cancelConfirmBody":       { en: "Your subscription won't renew. You keep full Pro access until {date}.", fr: "Votre abonnement ne sera pas renouvelé. Vous gardez l'accès Pro complet jusqu'au {date}." },
  "pro.cancelConfirmBodyNoDate": { en: "Your subscription won't renew. You keep full Pro access until the end of the period you already paid for.", fr: "Votre abonnement ne sera pas renouvelé. Vous gardez l'accès Pro complet jusqu'à la fin de la période déjà payée." },
  "pro.subscription": { en: "Subscription",    fr: "Abonnement" },
  "pro.promo.label":       { en: "Have a promo code?", fr: "Vous avez un code promo ?" },
  "pro.promo.placeholder": { en: "Enter code",         fr: "Entrez votre code" },
  "pro.promo.apply":       { en: "Apply",              fr: "Appliquer" },
  // ── iOS : abonnement via l'App Store (APPLE_PLAN Phase 5) ────────────────
  // Les prix ne sont JAMAIS écrits ici : ils viennent de la boutique Apple
  // (`displayPrice`), dans la devise de l'utilisateur.
  "pro.apple.subscribe":    { en: "Subscribe — {price}{per}", fr: "S'abonner — {price}{per}" },
  "pro.apple.trialCta":     { en: "Try it free for 7 days", fr: "Essayer gratuitement 7 jours" },
  "pro.apple.trialNote":    { en: "7 days free, then {price}{per}. Cancel anytime before the trial ends and you won't be charged.", fr: "7 jours gratuits, puis {price}{per}. Annulez avant la fin de l'essai et vous ne serez pas facturé." },
  "pro.apple.perMonthShort": { en: "/month", fr: "/mois" },
  "pro.apple.perYearShort":  { en: "/year",  fr: "/an" },
  "pro.apple.yearlyEquiv":  { en: "That's {price}/month.", fr: "Soit {price}/mois." },
  "pro.apple.restore":      { en: "Restore purchases", fr: "Restaurer les achats" },
  "pro.apple.restored":     { en: "Your subscription has been restored.", fr: "Votre abonnement a été restauré." },
  "pro.apple.nothingToRestore": { en: "No active subscription was found for this Apple ID.", fr: "Aucun abonnement en cours n'a été trouvé pour cet identifiant Apple." },
  "pro.apple.pending":      { en: "Your purchase is waiting for approval. Pro will turn on as soon as it's approved.", fr: "Votre achat attend une approbation. Pro s'activera dès qu'il sera approuvé." },
  "pro.apple.unavailable":  { en: "Subscriptions can't be loaded right now. Check your connection and try again.", fr: "Les abonnements ne peuvent pas être chargés pour le moment. Vérifiez votre connexion et réessayez." },
  "pro.apple.notAvailable": { en: "Subscriptions aren't available on the App Store yet. Please try again later.", fr: "Les abonnements ne sont pas encore disponibles sur l'App Store. Réessayez plus tard." },
  "pro.apple.retry":        { en: "Try again", fr: "Réessayer" },
  "pro.apple.otherAccount": { en: "This Apple subscription is already linked to another ArakIce account. Sign in with that account to use it.", fr: "Cet abonnement Apple est déjà lié à un autre compte ArakIce. Connectez-vous avec ce compte pour l'utiliser." },
  "pro.apple.verifyFailed": { en: "Your purchase went through but we couldn't activate Pro yet. It will activate automatically — or tap « Restore purchases ».", fr: "Votre achat est passé, mais Pro n'a pas encore pu être activé. Il s'activera automatiquement — ou touchez « Restaurer les achats »." },
  "pro.apple.manage":       { en: "Manage subscription", fr: "Gérer l'abonnement" },
  "pro.apple.managedOnIphone": { en: "This subscription was bought on iPhone. Manage or cancel it in iPhone Settings → your name → Subscriptions.", fr: "Cet abonnement a été acheté sur iPhone. Gérez-le ou annulez-le dans Réglages de l'iPhone → votre nom → Abonnements." },
  "pro.apple.legal":        { en: "Auto-renewing subscription: {monthly} per month or {yearly} per year. Payment is charged to your Apple account when you confirm the purchase (at the end of the free trial, if one applies). The subscription renews automatically unless it is cancelled at least 24 hours before the end of the current period; your account is charged for renewal within 24 hours before that. Manage or cancel it anytime in iPhone Settings → your name → Subscriptions.", fr: "Abonnement à renouvellement automatique : {monthly} par mois ou {yearly} par an. Le paiement est prélevé sur votre compte Apple à la confirmation de l'achat (à la fin de l'essai gratuit, le cas échéant). L'abonnement se renouvelle automatiquement sauf s'il est annulé au moins 24 heures avant la fin de la période en cours ; le renouvellement est prélevé dans les 24 heures qui précèdent. Gérez-le ou annulez-le à tout moment dans Réglages de l'iPhone → votre nom → Abonnements." },
  "pro.apple.terms":        { en: "Terms of Use", fr: "Conditions d'utilisation" },
  "pro.apple.eula":         { en: "Apple EULA", fr: "Licence Apple (EULA)" },
  "pro.apple.privacy":      { en: "Privacy Policy", fr: "Politique de confidentialité" },
  "account.deleteSubApple": { en: "Deleting your account does not cancel a subscription bought on iPhone. Cancel it first in iPhone Settings → your name → Subscriptions, or Apple will keep charging you.", fr: "Supprimer votre compte n'annule pas un abonnement acheté sur iPhone. Annulez-le d'abord dans Réglages de l'iPhone → votre nom → Abonnements, sinon Apple continuera de vous facturer." },
  // Pro-exclusive benefits (title + description)
  "pro.b.bestbets.t": { en: "Daily Best Bets",           fr: "Best Bets du jour" },
  "pro.b.bestbets.d": { en: "The day's top picks, selected and rated by the model.", fr: "Les meilleurs paris du jour, sélectionnés et notés par le modèle." },
  "pro.b.ev.t":       { en: "Value-bet finder (EV)",     fr: "Détecteur de value bets (EV)" },
  "pro.b.ev.d":       { en: "Automatically flags positive-EV bets where your edge beats the odds.", fr: "Repère automatiquement les paris à valeur positive (+EV) où votre edge dépasse la cote." },
  "pro.b.alerts.t":   { en: "Value-bet notifications",   fr: "Notifications value bets" },
  "pro.b.alerts.d":   { en: "Get alerted the moment a new +EV appears, before the odds move.", fr: "Recevez une alerte dès qu'un nouveau +EV apparaît, avant que la cote bouge." },
  // ⚠️ Ce bloc annonçait « Analyse IA illimitée » / « no daily limit » alors
  // qu'il existe un plafond MENSUEL par abonné, dérivé du prix
  // (`llmQuota.service`). C'était faux à 763 requêtes et plus visiblement faux
  // à 457. Corrigé le 2026-09-08 : on annonce le chiffre réel, et on dit ce qui
  // se passe au-delà — le repli sur la clé perso est justement ce qui rend le
  // plafond acceptable, donc le taire nuisait aussi à l'argumentaire.
  //
  // `{n}` est injecté depuis ProPage avec le plafond que le SERVEUR calcule
  // (`llmMonthlyQuota`), jamais une constante recopiée : c'est ce qui empêche
  // la promesse de redevenir fausse au prochain changement de prix.
  // `pro.b.llm.dNoCount` sert quand le serveur ne renvoie pas encore le champ.
  "pro.b.llm.t":        { en: "AI analysis included",     fr: "Analyse IA incluse" },
  "pro.b.llm.d":        { en: "The model's take on every game — {n} analyses a month. Past that, your own OpenAI key takes over.", fr: "L'avis du modèle sur tous les matchs — {n} analyses par mois. Au-delà, votre propre clé OpenAI prend le relais." },
  "pro.b.llm.dNoCount": { en: "The model's take on every game, within a generous monthly allowance. Past that, your own OpenAI key takes over.", fr: "L'avis du modèle sur tous les matchs, dans la limite d'un forfait mensuel confortable. Au-delà, votre propre clé OpenAI prend le relais." },
  "pro.b.markets.t":  { en: "All markets & full slate",  fr: "Tous les marchés & calendrier complet" },
  "pro.b.markets.d":  isIOS ? { en: "Beyond today's games: the full schedule and every market.", fr: "Au-delà des matchs du jour : tout le calendrier et tous les marchés." } : { en: "Beyond today's games: the full schedule and every bet365 market.", fr: "Au-delà des matchs du jour : tout le calendrier et chaque marché bet365." },
  "pro.b.others.t":   { en: "Other players' stats & bets", fr: "Stats & bets des autres joueurs" },
  "pro.b.others.d":   { en: "Compare yourself to the leaderboard and see their picks.", fr: "Comparez-vous aux meilleurs du classement et voyez leurs paris." },

  // ── Schedule (calendrier des matchs) ──
  "home.schedule":       { en: "Game calendar", fr: "Calendrier des matchs" },
  "schedule.title":      { en: "Schedule",      fr: "Calendrier" },
  "schedule.subtitle":   { en: "Every game of the season", fr: "Tous les matchs de la saison" },
  "schedule.loading":    { en: "Loading games…", fr: "Chargement des matchs…" },
  "schedule.noGames":    { en: "No games this month.", fr: "Aucun match ce mois-ci." },
  "schedule.error":      { en: "Couldn't load the schedule.", fr: "Impossible de charger le calendrier." },
  "schedule.at":         { en: "@", fr: "@" },

  // ── Home: Best Parlay (2026-10-04) ──
  "parlay.title":          { en: "Best Parlay", fr: "Best Parlay" },
  "parlay.explain":        { en: "Parlays of 3 to 5 picks built from our AI model's most likely bets, kept coherent by team and game. Every parlay here has bookmaker odds and at least a 25% chance.", fr: "Des combinés de 3 à 5 sélections, faits avec les paris les plus probables selon notre modèle IA et cohérents par équipe et par match. Chaque combiné ici a une cote du livre et au moins 25 % de chance." },
  "parlay.addShort":       { en: "Add to slip", fr: "Au coupon" },
  "parlay.inSlip":         { en: "In my slip", fr: "Dans le coupon" },
  "parlay.indepNote":      { en: "Player picks from the same game are treated as independent: the real chance may differ slightly.", fr: "Les paris joueur d'un même match sont supposés indépendants : la vraie chance peut légèrement différer." },
  "parlay.empty":          { en: "No parlay with bookmaker odds reaches 25% for this day. See more parlays for combos with unpriced picks.", fr: "Aucun combiné coté n'atteint 25 % pour ce jour. Voir plus de parlays pour des combinés avec des paris sans cote." },
  "parlay.proCard":        { en: "Pro parlay", fr: "Combiné Pro" },
  "parlay.prev":           { en: "Previous parlay", fr: "Combiné précédent" },
  "parlay.next":           { en: "Next parlay", fr: "Combiné suivant" },
  "parlay.more":           { en: "More parlays", fr: "Plus de parlays" },
  "parlays.title":         { en: "More parlays", fr: "Plus de parlays" },
  "parlays.subtitle":      { en: "2 to 8 picks · {day}", fr: "2 à 8 sélections · {day}" },
  "parlays.explain":       { en: "First the home-page parlays (all with bookmaker odds), then more varied ones: same game, same team, same bet type or mixed. Some picks have no bookmaker odds yet: those show the fair odds from our model. The longer the parlay, the lower the chance.", fr: "D'abord les combinés de l'accueil (tous cotés), puis d'autres plus variés : même match, même équipe, même type de pari ou mélangés. Certains paris n'ont pas encore de cote du livre : on affiche alors la cote juste selon notre modèle. Plus le combiné est long, plus la chance baisse." },
  "parlays.all":           { en: "All", fr: "Tous" },
  "parlays.anySize":       { en: "Any size", fr: "Toutes tailles" },
  "parlays.legs":          { en: "{n} picks", fr: "{n} sél." },
  "parlays.featured":      { en: "Home page · with odds", fr: "Accueil · avec cotes" },
  "parlays.kind.mixed":       { en: "Mixed", fr: "Mélangés" },
  "parlays.kind.same_game":   { en: "Same game", fr: "Même match" },
  "parlays.kind.same_team":   { en: "Same team", fr: "Même équipe" },
  "parlays.kind.same_market": { en: "Same bet type", fr: "Même type de pari" },
  "parlays.empty":         { en: "No parlay for this filter.", fr: "Aucun combiné pour ce filtre." },
  "parlays.noDay":         { en: "No upcoming game with strong picks for this day.", fr: "Aucun match à venir avec des paris solides pour ce jour." },
  "parlays.proTitle":      { en: "Pro parlays", fr: "Parlays Pro" },
  "parlays.proDesc":       { en: "More parlays — 2 to 8 picks, same game, same team, same bet type — are for Pro subscribers.", fr: "Plus de parlays — 2 à 8 sélections, même match, même équipe, même type de pari — est réservé aux abonnés Pro." },

  // ── Home: value bets (EV) + locked sections ──
  "home.evTitle":     { en: "Value Bets (EV)",  fr: "Value Bets (EV)" },
  "home.evEmpty":     { en: "No value bets right now. They show up once both starting goalies are confirmed, usually 1 to 2 hours before puck drop.", fr: "Aucun value bet pour l'instant. Ils apparaissent quand les deux gardiens partants sont confirmés, en général 1 à 2 h avant la mise au jeu." },
  "home.evSettings":  { en: "Alert settings", fr: "Réglages des alertes" },
  "home.bestBetsLockDesc": { en: "The day's top picks, selected and rated by the model. Upgrade to Pro to see them.", fr: "Les meilleurs paris du jour, sélectionnés et notés par le modèle. Passez à Pro pour les voir." },

  // ── Profile: notifications (Pro) ──
  "profile.notifications":      { en: "Notifications",         fr: "Notifications" },
  "profile.notifyValueBets":    { en: "Value-bet alerts",      fr: "Alertes value bets" },
  "profile.notifyValueBetsHint":{ en: "Get notified when a new +EV opportunity appears.", fr: "Soyez averti dès qu'un nouveau +EV apparaît." },
  "profile.minEv":              { en: "Minimum edge",           fr: "Edge minimum" },
  "profile.minEvHint":          { en: "Only alert me when the value bet's edge is at least this %.", fr: "Ne m'alerte que si l'edge du value bet atteint au moins ce %." },
  "profile.notifyDenied":       { en: "Notifications blocked — allow them in your browser.", fr: "Notifications bloquées — autorisez-les dans votre navigateur." },
  "profile.notifyDeniedIOS":    { en: "Notifications blocked — allow them in iPhone Settings → ArakIce.", fr: "Notifications bloquées — autorisez-les dans Réglages de l'iPhone → ArakIce." },
  "profile.notifyBets":         { en: "My bet results",        fr: "Résultats de mes paris" },
  "profile.notifyBetsHint":     { en: "Get notified when one of your bets is settled.", fr: "Soyez averti quand un de vos paris est réglé." },

  // ── Legal / support ──
  "legal.terms":   { en: "Terms",         fr: "CGU" },
  "legal.privacy": { en: "Privacy",       fr: "Confidentialité" },
  "legal.support": { en: "Support",       fr: "Support" },
  // Une seule source pour la mention de non-affiliation dans l'app ; les pages
  // SEO statiques portent la même dans client/scripts/seo-gen.mjs.
  "legal.notAffiliated": { en: "Not affiliated with or endorsed by the NHL or its teams. NHL and team names are trademarks of their respective owners.", fr: "Non affilié à la LNH ni à ses équipes, et non approuvé par elles. LNH et les noms d'équipes sont des marques de leurs propriétaires respectifs." },
  // APPLE_PLAN 2.5 — avertissement visible + lignes d'aide (web et iOS).
  "legal.disclaimer":   { en: "For information and entertainment only — ArakIce takes no bets and handles no money. 18+. Help with gambling:", fr: "À titre informatif et de divertissement seulement — ArakIce ne prend aucun pari et ne manipule aucun argent. 18+. Aide pour le jeu :" },
  "legal.helpQc":       { en: "Québec 1 800 461-0140", fr: "Québec 1 800 461-0140" },
  "legal.helpUs":       { en: "U.S. 1-800-GAMBLER", fr: "É.-U. 1-800-GAMBLER" },

  // ── 404 ──
  "notFound.title": { en: "Page not found", fr: "Page introuvable" },
  "notFound.body":  { en: "This page doesn't exist or has moved.", fr: "Cette page n'existe pas ou a été déplacée." },

  // ── Écran d'erreur (components/ErrorScreen.tsx) ──
  "error.title":        { en: "Something went wrong", fr: "Oups, quelque chose s'est mal passé" },
  "error.body":         { en: "An unexpected error occurred. Try again, or head back to the home page.", fr: "Une erreur inattendue est survenue. Réessayez, ou revenez à l'accueil." },
  "error.offlineTitle": { en: "You're offline", fr: "Vous êtes hors ligne" },
  "error.offlineBody":  { en: "Check your connection, then try again.", fr: "Vérifiez votre connexion, puis réessayez." },
  "error.updateTitle":  { en: "A new version of ArakIce is available", fr: "Une nouvelle version d'ArakIce est disponible" },
  "error.updateBody":   { en: "Reload to get the latest version.", fr: "Rechargez pour obtenir la dernière version." },
  "error.reload":       { en: "Reload", fr: "Recharger" },
  "error.code":         { en: "Error code: {id}", fr: "Code d'erreur : {id}" },

  // ── League: Pro lock on other players' bets ──
  "league.othersProTitle": { en: "See their bets with Pro", fr: "Voyez leurs paris avec Pro" },
  "league.othersProDesc":  { en: "Viewing other players' bet slips is a Pro feature.", fr: "Voir les paris des autres joueurs est réservé aux Pro." },

  // ── Home: rink layout (jersey carousel + centre-ice live zone) ──
  "home.allTeams":     { en: "All Teams",   fr: "Toutes les équipes" },
  "home.teamStats":    { en: "Stats",       fr: "Stats" },
  "home.teamPrediction": { en: "Prediction", fr: "Prédiction" },
  "home.teamOptions":  { en: "Open {team}", fr: "Ouvrir {team}" },
  "home.noLiveGames":  { en: "No game in progress", fr: "Aucun match en cours" },
  "home.scheduleCta":  { en: "View",           fr: "Voir" },

  // ── Home: refonte du 2026-09-27 (carrousel, tableau des matchs, Pro) ──
  "home.teamsPrev":    { en: "Previous teams", fr: "Équipes précédentes" },
  "home.teamsNext":    { en: "Next teams",     fr: "Équipes suivantes" },
  "home.livePrev":     { en: "Previous live game", fr: "Match en direct précédent" },
  "home.liveNext":     { en: "Next live game",     fr: "Match en direct suivant" },
  "home.colSpread":    { en: "Puck line",      fr: "Handicap" },
  "home.colWinner":    { en: "Winner",         fr: "Vainqueur" },
  "home.plPlus":       { en: "{abbr} +1.5 (doesn't lose by 2+)", fr: "{abbr} +1,5 (ne perd pas par 2 buts ou plus)" },
  "home.pickHint":     { en: "Tap to add to your slip, tap again to remove", fr: "Touchez pour ajouter au coupon, touchez encore pour retirer" },
  "home.homeTeam":     { en: "Home team", fr: "Équipe à domicile" },
  "home.noRealMoney":  { en: "No real money involved.", fr: "Aucun argent réel en jeu." },
  "home.noRealMoneyHint": { en: "ArakIce is an analytics tool: the bets in your slip are virtual, for fun and the leaderboard.", fr: "ArakIce est un outil d'analyse : les paris de votre coupon sont virtuels, pour le plaisir et le classement." },
  "home.proHeadline":  { en: "Go Pro",         fr: "Passez à Pro" },
  "home.proSub":       { en: "The model's best picks of the day and the value bets it spots, in one place.", fr: "Les meilleurs paris du jour et les value bets repérés par le modèle, réunis au même endroit." },
  "home.proBestBetsDesc": { en: "The day's strongest picks across every market, rated by the model.", fr: "Les paris les plus solides du jour, tous marchés confondus, notés par le modèle." },
  "home.proEvDesc":    { en: "Bets where our model sees a better chance than the bookmaker's odds imply.", fr: "Les paris où notre modèle voit plus de chances que ce que suppose la cote du bookmaker." },
  "home.proOnly":      { en: "Available to Pro subscribers.", fr: "Réservé aux abonnés Pro." },
  "home.evWhatTitle":  { en: "Value bet", fr: "Value bet" },
  "home.evWhat":       { en: "A bet where our model gives a better chance of winning than the bookmaker's odds suggest.", fr: "Un pari où notre modèle donne plus de chances de gagner que ce que la cote du bookmaker laisse croire." },
  "home.evWhat2":      { en: "When odds are too generous, that gap is the value.", fr: "Quand la cote est trop généreuse, cet écart, c'est la valeur." },
  "home.evWhat3":      { en: "A value bet isn't a sure win, it's a bet that pays better than it should.", fr: "Un value bet n'est pas gagné d'avance : c'est un pari mieux payé qu'il ne devrait l'être." },
  "home.evWhat4":      { en: "We only show one once both starting goalies are confirmed, and never during the game.", fr: "On n'en affiche qu'une fois les deux gardiens partants confirmés, et jamais pendant le match." },
  "home.evExampleLabel": { en: "Example", fr: "Exemple" },
  "home.evExample":    { en: "once the bookmaker's margin is removed, the odds imply a 40% chance. If the model sees 44%, that's +4 pts of value.", fr: "une fois la marge du bookmaker retirée, la cote suppose 40 % de chances. Si le modèle en voit 44 %, ça fait +4 pts de valeur." },
  "home.evEdge":       { en: "+{edge} pts value", fr: "+{edge} pts de valeur" },
  "home.evVs":         { en: "Model {model}% vs book {book}%", fr: "Modèle {model} % vs livre {book} %" },
  "home.evWinner":     { en: "{team} to win vs {opp}", fr: "{team} gagne vs {opp}" },
  "home.evWinnerShort": { en: "{team} to win", fr: "{team} gagne" },
  "home.evPrice":      { en: "{book}: {price}", fr: "{book} : {price}" },
  "handoff.title":      { en: "To find on {book}", fr: "À chercher sur {book}" },
  "handoff.why":        { en: "{book} can't open a specific bet from another app: we open its hockey page. Look for this bet there.", fr: "{book} ne permet pas d'ouvrir un pari précis depuis une autre app : on ouvre sa page hockey. Cherches-y ce pari." },
  "handoff.match":      { en: "Game", fr: "Match" },
  "handoff.market":     { en: "Market", fr: "Marché" },
  "handoff.selection":  { en: "Pick", fr: "Sélection" },
  "handoff.minLabel":   { en: "Minimum odds", fr: "Cote minimale" },
  "handoff.minOdds":    { en: "Profitable above {min}", fr: "Rentable au-dessus de {min}" },
  "handoff.minOddsPct": { en: "Profitable below {min}", fr: "Rentable sous {min}" },
  "handoff.minHint":    { en: "Below the minimum odds, the bet loses money according to our model. Odds can differ from one book to another.", fr: "Sous la cote minimale, le pari perd de l'argent selon notre modèle. Les cotes peuvent différer d'un livre à l'autre." },
  "handoff.shown":      { en: "Odds seen at {book}", fr: "Cote vue chez {book}" },
  "handoff.copy":       { en: "Copy", fr: "Copier" },
  "handoff.copied":     { en: "Copied", fr: "Copié" },
  "handoff.open":       { en: "Open {book}", fr: "Ouvrir {book}" },
  "handoff.mktWinner":  { en: "Winner (incl. OT)", fr: "Vainqueur (prolongation comprise)" },
  "handoff.mktPuck":    { en: "Puck line", fr: "Puck line (handicap)" },
};

type TParams = Record<string, string | number>;

function translate(key: string, lang: Lang, params?: TParams): string {
  const entry = DICT[key];
  let str = entry ? (entry[lang] ?? entry.en) : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: TParams) => string;
}

const I18nContext = createContext<I18nValue>({
  lang: "en",
  setLang: () => {},
  t: (k, p) => translate(k, "en", p),
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "fr" || stored === "en") return stored;
    } catch { /* navigation privée : on tombe sur la détection */ }
    return detectLang();
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  };

  /**
   * `<html lang>` suit la langue affichée.
   *
   * `index.html` est servi avec `lang="en"` en dur et ne bougeait jamais : les
   * lecteurs d'écran lisaient donc du français avec une voix anglaise, et la
   * correction orthographique du navigateur se trompait de dictionnaire. C'est
   * la seule écriture hors React de ce module, et elle est volontairement dans
   * un effet plutôt qu'au rendu — muter le document pendant le rendu est un
   * effet de bord que React se réserve le droit de rejouer.
   */
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t: (k, p) => translate(k, lang, p) }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
