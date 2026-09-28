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
  "chat.sendFailed": { en: "Message not sent \u2014 your text is back in the box.", fr: "Message non envoyé \u2014 ton texte est revenu dans la zone de saisie." },
  // Les trois issues d'échec de la connexion Google. Le serveur les met dans
  // `?error=` ; jusqu'au 2026-09-08 l'écran de connexion les ignorait purement
  // et simplement, donc un refus Google ramenait sur un formulaire muet.
  "login.googleDenied":     { en: "Google sign-in was cancelled.", fr: "La connexion Google a été annulée." },
  "login.googleFailed":     { en: "Google sign-in failed. Try again, or use your e-mail and password.", fr: "La connexion Google a échoué. Réessaie, ou utilise ton e-mail et ton mot de passe." },
  "login.googleUnverified": { en: "This Google account\u2019s e-mail address is not verified. Verify it with Google, or sign in with your e-mail and password.", fr: "L\u2019adresse de ce compte Google n\u2019est pas vérifiée. Vérifie-la chez Google, ou connecte-toi avec ton e-mail et ton mot de passe." },
  // Les trois clés de l'état d'erreur partagé (`ErrorState`). Le titre reste
  // vague à dessein : l'utilisateur n'a rien à faire d'un code HTTP, et le
  // détail technique part déjà dans la console.
  "common.loadFailed":     { en: "Couldn\u2019t load this.", fr: "Impossible de charger ça." },
  "common.loadFailedHint": { en: "Check your connection, then try again.", fr: "Vérifie ta connexion, puis réessaie." },
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
  "profile.iceAvatar":    { en: "Or pick an ice avatar", fr: "Ou choisis un avatar glacé" },
  "profile.choosePhoto":  { en: "Profile photo",     fr: "Photo de profil" },
  "profile.chooseEmoji":  { en: "Choose an emoji",   fr: "Choisir un emoji" },
  "profile.chooseFlag":   { en: "Choose a flag",     fr: "Choisir un drapeau" },
  "profile.flagHint":     { en: "Shown next to your name in the podium and chat", fr: "Affiché à côté de ton nom dans le podium et le chat" },
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
  "profile.hideSlipsHint":{ en: "Pro members can browse your settled slips. Turning this on hides all of them — your leaderboard rank is unaffected.", fr: "Les membres Pro peuvent consulter tes paris réglés. Activer ceci les masque tous — ton rang au classement n'est pas touché." },
  "profile.language":     { en: "Language",      fr: "Langue" },
  "profile.bookmaker":    { en: "Sportsbook",    fr: "Site de paris" },
  "profile.bookmakerHint":{ en: "Which site the “Place bet” buttons open", fr: "Le site que les boutons « Parier » ouvrent" },
  "profile.oddsSource":   { en: "Odds shown in the app come from Betano (Ontario). Tapping a price opens the site chosen above, where the odds may differ.", fr: "Les cotes affichées dans l'app viennent de Betano (Ontario). Toucher une cote ouvre le site choisi ci-dessus, où la cote peut être différente." },
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
  "profile.aiUsageReset":  { en: "Resets on {date}",   fr: "Remise à zéro le {date}" },
  "profile.aiUsageOver":   { en: "Past your monthly allowance, your requests use your own OpenAI key if you've added one.", fr: "Au-delà de ton forfait mensuel, tes requêtes utilisent ta propre clé OpenAI si tu en as ajouté une." },
  "profile.aiUsageFree":   { en: "LLM Analysis: runs on your own OpenAI key, up to {n} requests a day. Go Pro to use the built-in model.", fr: "Analyse LLM : ta propre clé OpenAI, dans la limite de {n} requêtes par jour. Passe à Pro pour utiliser le modèle intégré." },
  // Un SEUL quota Pro pour les deux fonctions IA (Analyse LLM d'un pari et
  // Bet builder IA) : la carte le dit, pour qu'un abonné ne croie pas avoir
  // deux enveloppes. Côté gratuit, les essais du Bet builder IA réutilisent
  // les textes de la feuille (`cmd.aiFreeLeft`, `cmd.aiOwnKey`).
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
  "profile.aiSettingsDesc":{ en: "Enter your OpenAI API key to use the Ask LLM feature. Your key is stored securely and used only for your requests.", fr: "Entre ta clé API OpenAI pour utiliser la fonction Ask LLM. Ta clé est stockée en toute sécurité et utilisée uniquement pour tes requêtes." },
  "profile.getKey":       { en: "Get a key →",   fr: "Obtenir une clé →" },
  "profile.openaiKey":    { en: "OpenAI API Key", fr: "Clé API OpenAI" },
  "profile.show":         { en: "Show",          fr: "Afficher" },
  "profile.hide":         { en: "Hide",          fr: "Masquer" },
  "profile.keyStored":     { en: "A key is saved on your account", fr: "Une clé est enregistrée sur ton compte" },
  "profile.replaceKey":    { en: "Replace",                       fr: "Remplacer" },
  "profile.keyNotShown":   { en: "For your security it is never displayed again — replace it or remove it.", fr: "Par sécurité elle n'est jamais réaffichée — remplace-la ou retire-la." },
  "profile.keyPendingRemoval": { en: "The key will be removed when you save.", fr: "La clé sera retirée à l'enregistrement." },
  "profile.removeKey":    { en: "Remove key",    fr: "Supprimer la clé" },
  "profile.hitRateTrend": { en: "Hit Rate Trend", fr: "Tendance du taux de réussite" },
  "profile.perfByMarket": { en: "Performance by Market", fr: "Performance par marché" },
  "profile.noTrendYet":   { en: "No settled slips yet — the trend appears once your first bets are graded.", fr: "Aucun pari réglé — la tendance apparaît dès que tes premières sélections sont tranchées." },
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
  "league.podiumTap":  { en: "Tap a player to view their profile", fr: "Touche un joueur pour voir son profil" },
  "league.searchPlayer": { en: "Search a player…",   fr: "Rechercher un joueur…" },
  "league.noPlayerFound": { en: "No player found", fr: "Aucun joueur trouvé" },
  "league.score":      { en: "Score",                fr: "Score" },
  "league.hitRate":    { en: "Hit Rate",             fr: "Réussite" },
  "league.volume":     { en: "Volume",               fr: "Volume" },
  "league.player":     { en: "Player",               fr: "Joueur" },
  "league.recentSlips":{ en: "Recent slips",         fr: "Paris récents" },
  "league.slipsPrivate": { en: "🔒 This player keeps their slips private", fr: "🔒 Ce joueur garde ses paris privés" },
  "league.noSlips":    { en: "No slips yet",         fr: "Aucun pari pour l'instant" },
  "league.you":        { en: "you",                  fr: "toi" },
  "league.bets":       { en: "Bets",                 fr: "Paris" },
  "chat.noRoomsYet":   { en: "No rooms yet",         fr: "Aucun salon" },
  "chat.noRoomsHint":  { en: "Join a public room from Discover, enter a join code above, or create your own.", fr: "Rejoins un salon public depuis Découvrir, entre un code d'accès ci-dessus, ou crée le tien." },
  "chat.nothingDiscover": { en: "Nothing to discover", fr: "Rien à découvrir" },
  "chat.noPublicRooms":{ en: "No public rooms to join right now.", fr: "Aucun salon public à rejoindre pour le moment." },

  // ── Chat ──
  "chat.myRooms":      { en: "My Rooms",             fr: "Mes salons" },
  "chat.discover":     { en: "Discover",             fr: "Découvrir" },
  "chat.sectionPublic":  { en: "Public",             fr: "Public" },
  "chat.sectionPrivate": { en: "Private",            fr: "Privé" },
  "chat.noPrivateRooms": { en: "No private rooms yet — join one with a code.", fr: "Aucun salon privé — rejoins-en un avec un code." },
  "chat.roomColor":    { en: "Room Color",           fr: "Couleur du salon" },
  "chat.deleteMessageConfirm": { en: "Delete this message?", fr: "Supprimer ce message ?" },

  // Les quatre confirmations qui passaient par `window.confirm()` jusqu'au
  // 2026-09-08. En WKWebView ce dialogue affiche le NOM DE DOMAINE en titre et
  // bloque le fil JavaScript ; il n'était de surcroît pas traduit — les trois
  // formulations vivaient en anglais en dur dans le code.
  "chat.deleteMessageConfirmCta": { en: "Delete",  fr: "Supprimer" },
  "chat.leaveRoomTitle":       { en: "Leave {name}?", fr: "Quitter {name} ?" },
  "chat.leaveRoomDescription": { en: "You can come back later with the room's join code.", fr: "Tu pourras revenir plus tard avec le code d'accès du salon." },
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
  "slip.shareUnavailable": { en: "Sharing isn\u2019t available here — take a screenshot instead.", fr: "Le partage n'est pas disponible ici — fais plutôt une capture d'écran." },
  "chat.newRoom":      { en: "+ New Room",           fr: "+ Nouveau salon" },
  "chat.createRoom":   { en: "Create a new room",    fr: "Créer un nouveau salon" },
  "chat.createTitle":  { en: "New Chat Room",        fr: "Nouveau salon" },
  "chat.roomName":     { en: "Room Name",            fr: "Nom du salon" },
  "chat.description":  { en: "Description",          fr: "Description" },
  "chat.icon":         { en: "Icon",                 fr: "Icône" },
  "chat.create":       { en: "Create Room",          fr: "Créer le salon" },
  "chat.creating":     { en: "Creating…",            fr: "Création…" },
  "chat.private":      { en: "🔒 Private room",      fr: "🔒 Salon privé" },
  "chat.publicRoom":   { en: "🌐 Public room",       fr: "🌐 Salon public" },
  "chat.privateHint":  { en: "Only people with the join code can enter", fr: "Seules les personnes avec le code peuvent entrer" },
  "chat.publicHint":   { en: "Anyone can find and join this room", fr: "Tout le monde peut trouver et rejoindre ce salon" },
  "chat.searchRooms":  { en: "Search rooms or enter a join code…", fr: "Cherche un salon ou entre un code…" },
  "chat.join":         { en: "Join",                 fr: "Rejoindre" },
  "chat.joining":      { en: "Joining…",             fr: "Connexion…" },
  "chat.open":         { en: "Open",                 fr: "Ouvrir" },
  "chat.hide":         { en: "Hide ✕",               fr: "Masquer ✕" },
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
                            fr: "Ta session a expiré — reconnecte-toi pour continuer à discuter." },
  "chat.accessDenied":    { en: "You no longer have access to this room.",
                            fr: "Tu n'as plus accès à ce salon." },
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
  "report.already":    { en: "You already reported this message.", fr: "Tu as déjà signalé ce message." },
  "report.failed":     { en: "Could not send the report", fr: "Impossible d'envoyer le signalement" },

  "block.title":       { en: "Block {name}?",       fr: "Bloquer {name} ?" },
  "block.description": { en: "You will no longer see their messages, and they will no longer see yours. You can undo this at any time in Settings.", fr: "Tu ne verras plus ses messages, et il ne verra plus les tiens. Tu peux annuler à tout moment dans les Paramètres." },
  "block.confirm":     { en: "Block",               fr: "Bloquer" },
  "block.done":        { en: "{name} is blocked.",  fr: "{name} est bloqué." },
  "block.failed":      { en: "Could not block this user", fr: "Impossible de bloquer cet utilisateur" },
  "block.self":        { en: "You can't block yourself.", fr: "Tu ne peux pas te bloquer toi-même." },
  "block.unblockDone": { en: "{name} is unblocked.", fr: "{name} est débloqué." },
  "block.unblockFailed": { en: "Could not unblock", fr: "Impossible de débloquer" },

  "blocked.title":     { en: "Blocked users",       fr: "Utilisateurs bloqués" },
  "blocked.empty":     { en: "You have not blocked anyone.", fr: "Tu n'as bloqué personne." },
  "blocked.hint":      { en: "Blocking hides messages both ways. Unblocking restores them.", fr: "Le blocage masque les messages dans les deux sens. Le déblocage les rétablit." },
  "blocked.unblock":   { en: "Unblock",             fr: "Débloquer" },
  "blocked.loadFailed": { en: "Could not load the blocked list", fr: "Impossible de charger la liste des blocages" },

  "user.viewProfile":  { en: "View full profile",   fr: "Voir le profil complet" },
  "user.blocked":      { en: "blocked",             fr: "bloqué" },
  "chat.openRoom":     { en: "Open room",            fr: "Ouvrir le salon" },
  "chat.shareCode":    { en: "Share this code so others can join:", fr: "Partage ce code pour inviter d'autres joueurs :" },
  "chat.privateCreated": { en: "🔒 Private room created", fr: "🔒 Salon privé créé" },
  "chat.roomsAvailable": { en: "rooms available",    fr: "salons disponibles" },
  "chat.beFirst":      { en: "Be the first to say something!", fr: "Sois le premier à écrire !" },
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
  "slip.predictions":  { en: "Your Predictions", fr: "Tes prédictions" },
  "slip.add":          { en: "Add",             fr: "Ajouter" },
  "slip.clearTitle":   { en: "Clear this slip?", fr: "Vider ce pari ?" },
  "slip.clearBody":    { en: "All the bets in the slip will be removed.", fr: "Toutes les sélections du pari seront retirées." },
  "slip.clearConfirm": { en: "Clear", fr: "Vider" },
  "slip.active":       { en: "Active",          fr: "Actifs" },
  "slip.history":      { en: "History",         fr: "Historique" },
  "slip.checkResults": { en: "Check results",   fr: "Vérifier les résultats" },
  "slip.seeActive":    { en: "See my open bets", fr: "Voir mes paris en cours" },
  "slip.visibilityNotice": {
    en: "Once settled, your slips are visible to Pro members — picks stay hidden until puck drop. You can hide them in Settings.",
    fr: "Une fois réglés, tes paris sont visibles aux membres Pro — les sélections restent cachées jusqu'à la mise au jeu. Tu peux les masquer dans Paramètres.",
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
  "player.hiddenDesc":    { en: "Nothing to do with your subscription — they chose to stay private.", fr: "Rien à voir avec ton abonnement — il a choisi de rester discret." },
  "player.notFound":      { en: "Player not found", fr: "Joueur introuvable" },
  "player.errorTitle":    { en: "Couldn't load this player", fr: "Impossible de charger ce joueur" },
  "player.noSlipsYet":    { en: "No slips yet", fr: "Aucun pari pour l'instant" },
  "slip.autoSettle":   { en: "Settled automatically when games finish — riskier bets earn more XP", fr: "Réglé automatiquement à la fin des matchs — plus le pari est risqué, plus il rapporte d'XP" },
  "slip.noSlips":      { en: "No slips yet",    fr: "Aucun pari" },
  "slip.noSlipsHint":  { en: "Lock your first prediction to see it here", fr: "Verrouille ta première prédiction pour la voir ici" },
  "slip.empty":        { en: "No predictions yet", fr: "Aucune prédiction" },
  "slip.emptyHint":    { en: "Add predictions from the Stats page or tap below to browse all markets", fr: "Ajoute des prédictions depuis la page Stats ou explore les marchés ci-dessous" },
  "slip.browse":       { en: "Browse Markets",  fr: "Explorer les marchés" },
  "slip.signin":       { en: "Sign in to see your slips", fr: "Connecte-toi pour voir tes paris" },
  "slip.signinHint":   { en: "Your locked slips and history will appear here", fr: "Tes paris verrouillés et ton historique apparaîtront ici" },
  "slip.placeBet365":  { en: "Place on Bet365 ↗", fr: "Parier sur Bet365 ↗" },
  "slip.placeBet":     { en: "Place on {book} ↗", fr: "Parier sur {book} ↗" },
  "slip.bookCombined": { en: "Book parlay odds", fr: "Cote combinée du livre" },
  "slip.xpEarned":     { en: "XP earned",       fr: "XP gagnés" },
  "slip.sharePhoto":   { en: "Share",           fr: "Partager" },

  // ── Textes de l'IMAGE de partage (slipShareCanvas.ts) ──────────────────────
  // Le rendu ne traduit rien lui-même : il ne connaît ni React ni `useI18n`.
  // Ces clés sont composées dans MySlipsTab et passées au dessin.
  "share.lockedOn":    { en: "Locked {date}",   fr: "Verrouillé le {date}" },
  "share.settledOn":   { en: "Settled {date}",  fr: "Réglé le {date}" },
  "share.combined":    { en: "COMBINED",        fr: "COMBINÉ" },
  "share.summary":     { en: "{n} selections · implied odds {odds}", fr: "{n} sélections · cote implicite {odds}" },
  "share.summaryOne":  { en: "1 selection · implied odds {odds}",    fr: "1 sélection · cote implicite {odds}" },
  "share.moreLegs":    { en: "+ {n} more selections", fr: "+ {n} autres sélections" },
  "share.disclaimer":  { en: "Model probabilities · not betting advice", fr: "Probabilités du modèle · pas un conseil de pari" },

  // ── Envoyer un coupon dans une salle de chat ───────────────────────────────
  "slip.shareToRoom":     { en: "Send to a room",   fr: "Envoyer en salle" },
  "slip.pickRoom":        { en: "Which room?",      fr: "Dans quelle salle ?" },
  "slip.noRooms":         { en: "You haven't joined a room yet", fr: "Tu n'as encore rejoint aucune salle" },
  "slip.roomMembers":     { en: "{n} members",      fr: "{n} membres" },
  // Le texte qui accompagne la carte. Il reste modifiable dans le salon comme
  // n'importe quel message, et il passe le filtre de modération du serveur.
  "slip.shareRoomMessage":{ en: "My slip · {n} legs · {pct} combined", fr: "Mon pari · {n} sélections · {pct} combiné" },
  "slip.sharedToRoom":    { en: "Shared in {room}",  fr: "Partagé dans {room}" },
  "slip.openRoom":        { en: "Open",             fr: "Ouvrir" },
  "slip.shareRoomFailed": { en: "Couldn't send it to that room", fr: "Impossible d'envoyer dans cette salle" },
  "slip.addToSee":     { en: "Add predictions to see probability", fr: "Ajoute des prédictions pour voir la probabilité" },
  "slip.gaugeAddLegs": { en: "Add legs",        fr: "Ajoute des paris" },
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
  "slip.lockFailed":   { en: "Couldn't lock the slip — try again", fr: "Impossible de verrouiller le pari — réessaie" },
  "slip.lockTimeout":  { en: "The server took too long — your slip wasn't locked. Try again.", fr: "Le serveur a mis trop de temps — le pari n'a pas été verrouillé. Réessaie." },
  "slip.gameStarted":  { en: "A game in your slip has already started — remove those bets to lock it.", fr: "Un match de ton coupon a déjà commencé — retire ces paris pour le verrouiller." },
  "slip.individualProb":{ en: "Individual prediction probability", fr: "Probabilité de prédiction individuelle" },
  // Ce que la combinaison a changé — affiché par `SlipNotices`. Ces trois faits
  // étaient calculés par `parlay.ts` et jetés : un coupon impossible tombait à
  // 0 % sans un mot, un doublon quittait le calcul en silence.
  "slip.impossibleTitle": { en: "These bets can't all happen", fr: "Ces paris ne peuvent pas tous se réaliser" },
  "slip.impossibleBody":  { en: "At least two of them contradict each other on the same game. You can keep them on the slip — the combined probability just reads 0%.", fr: "Au moins deux d'entre elles se contredisent sur le même match. Tu peux les garder au pari — la probabilité combinée affiche simplement 0 %." },
  "slip.redundantOne":    { en: "1 bet is a duplicate — or already contained in another one. It counts once in the combined probability.", fr: "1 pari est un doublon — ou est déjà contenu dans un autre. Il n'est compté qu'une fois dans la probabilité combinée." },
  "slip.redundantMany":   { en: "{n} bets are duplicates — or already contained in another one. They count once in the combined probability.", fr: "{n} paris sont des doublons — ou sont déjà contenus dans un autre. Ils ne sont comptés qu'une fois dans la probabilité combinée." },
  "slip.sameGameApprox":  { en: "Several bets are on the same game. Their link couldn't be computed, so the combined probability treats them as independent — read it as an approximation.", fr: "Plusieurs paris portent sur le même match. Leur lien n'a pas pu être calculé : la probabilité combinée les traite comme indépendants — à lire comme une approximation." },
  "slip.howProbTitle": { en: "How probability works", fr: "Comment fonctionne la probabilité" },
  "slip.howProbBody":  { en: "Bets on different games are multiplied together. A duplicate — or a bet already contained in another — counts once, two bets that can't both happen drop the slip to 0, and bets on the same game are adjusted for their link. More bets means a lower combined chance but a higher potential reward.", fr: "Les sélections sur des matchs différents se multiplient. Un doublon — ou une sélection déjà contenue dans une autre — ne compte qu'une fois, deux sélections qui ne peuvent pas se réaliser ensemble ramènent le pari à 0, et les sélections d'un même match sont ajustées selon leur lien. Plus il y a de sélections, plus la chance combinée est faible, mais plus la récompense potentielle est élevée." },

  // ── Stats ──
  "stats.title":       { en: "Statistics",      fr: "Statistiques" },
  "stats.subtitle":    { en: "AI-powered predictions", fr: "Prédictions par IA" },
  "stats.search":      { en: "Search team, player, game...", fr: "Cherche une équipe, un joueur, un match..." },
  "stats.teams":       { en: "teams",           fr: "équipes" },
  "stats.futures":     { en: "Season Futures",  fr: "Paris de saison" },
  "stats.loadingTeams":{ en: "Loading team data...", fr: "Chargement des équipes..." },
  "stats.noGames":     { en: "No games scheduled today", fr: "Aucun match aujourd'hui" },
  "stats.byTeam":      { en: "By Team",   fr: "Par équipe" },
  "stats.byGame":      { en: "By Game",   fr: "Par match" },
  "stats.byPlayer":    { en: "By Player", fr: "Par joueur" },
  "stats.statistics":  { en: "Statistics", fr: "Statistiques" },
  "stats.loadingNHL":  { en: "Loading NHL data...", fr: "Chargement des données LNH..." },
  "stats.matches":     { en: "{n} matches", fr: "{n} matchs" },
  "stats.players":     { en: "Players",   fr: "Joueurs" },
  "stats.tapToAdd":    { en: "Tap + to add to slip", fr: "Touche + pour ajouter au pari" },
  "stats.loadingTeamsHint": { en: "The stats service is not responding. Try again in a moment.", fr: "Le service de statistiques ne répond pas. Réessaie dans un instant." },
  "stats.noGamesHint": { en: "Check back on game nights, or explore season futures below", fr: "Reviens les soirs de match, ou explore les paris de saison ci-dessous" },
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
  "home.more":           { en: "More",              fr: "Plus" },
  "home.moreBets":       { en: "More bets",         fr: "Plus de paris" },
  "home.betOn":          { en: "Place a bet →",   fr: "Parier →" },
  "home.edge":           { en: "+{edge}% edge",     fr: "+{edge}% avantage" },
  "home.game":           { en: "Game",              fr: "Match" },
  "home.nhlGame":        { en: "NHL Game",          fr: "Match LNH" },
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
  "nhl.title":         { en: "🏒 NHL Predictions", fr: "🏒 Prédictions NHL" },
  "nhl.subtitle":      { en: "Tonight's games · Rules + ML", fr: "Les matchs du jour · Règles + ML" },
  "nhl.analyzing":     { en: "Analyzing…",         fr: "Analyse en cours..." },
  "nhl.askLLM":        { en: "✨ Ask LLM",          fr: "✨ Demander au LLM" },

  // ── Prediction page ──
  "pred.title":          { en: "Prediction",            fr: "Prédiction" },
  "pred.calcPredictions":{ en: "Calculated Predictions", fr: "Prédictions calculées" },
  "pred.base":           { en: "Base: {n}%",            fr: "Base : {n} %" },
  "pred.aiPrediction":   { en: "AI Prediction",         fr: "Prédiction IA" },
  "pred.liveModel":      { en: "Live Model",            fr: "Modèle en direct" },
  "pred.rules":          { en: "Rules",                 fr: "Règles" },
  "pred.chart":          { en: "Chart",                 fr: "Graphique" },
  // ── Charts page ──
  "chart.title":         { en: "Statistics",            fr: "Statistiques" },
  "chart.skaters":       { en: "Skaters",               fr: "Patineurs" },
  "chart.goalies":       { en: "Goalies",               fr: "Gardiens" },
  "chart.player":        { en: "Player",                fr: "Joueur" },
  "chart.noData":        { en: "No season data available.", fr: "Aucune donnée de saison disponible." },
  "chart.last6":         { en: "Last 6 seasons",        fr: "6 dernières saisons" },
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
  "chart.teamStats":     { en: "Team Stats",            fr: "Stats d'équipe" },
  "chart.playerStats":   { en: "Player Stats",          fr: "Stats des joueurs" },
  "chart.col.total":     { en: "Total",                 fr: "Total" },
  "chart.col.perGame":   { en: "Avg / Game",            fr: "Moy. / match" },
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
  "chart.choosePrompt":  { en: "Choose a team to see its charts.", fr: "Choisis une équipe pour voir ses graphiques." },
  "chart.noPlayer":      { en: "No player",             fr: "Aucun joueur" },
  "chart.choosePlayerPrompt": { en: "Choose a team and player to see their charts.", fr: "Choisis une équipe et un joueur pour voir leurs graphiques." },
  "chart.m.shootingPct": { en: "Shooting %",            fr: "% Tirs" },
  "chart.m.pim":         { en: "PIM",                   fr: "Min. pén." },
  "chart.m.ppg":         { en: "PP Goals",              fr: "Buts AN" },
  "chart.m.shp":         { en: "SH Points",             fr: "Points DN" },
  "chart.m.toi":         { en: "TOI / Game",            fr: "Temps de jeu / match" },
  "chart.m.losses":      { en: "Losses",                fr: "Défaites" },
  "chart.m.otLosses":    { en: "OT Losses",             fr: "Défaites Prol." },
  "chart.pie.pointsBreakdown": { en: "Points Breakdown", fr: "Répartition des points" },
  "chart.pie.pts":       { en: "PTS",                   fr: "PTS" },
  "chart.compare.title":     { en: "Compare Players",   fr: "Comparer les joueurs" },
  "chart.compare.search":    { en: "Search a player to compare…", fr: "Rechercher un joueur à comparer…" },
  "chart.compare.noResults": { en: "No players found",  fr: "Aucun joueur trouvé" },
  "chart.compare.column":    { en: "Compare",           fr: "Comparer" },
  "chart.allPlayers":        { en: "All players",       fr: "Tous les joueurs" },
  "chart.pie.assistShare":   { en: "Assists share by player", fr: "Part des passes par joueur" },
  "chart.bar.decisions":     { en: "Decisions breakdown", fr: "Répartition des décisions" },
  "chart.allTeams":          { en: "All teams",         fr: "Toutes les équipes" },
  "chart.allGames.title":    { en: "All Games",         fr: "Tous les matchs" },
  "chart.allGames.note":     { en: "{n} games · {month}", fr: "{n} matchs · {month}" },
  "chart.gm.date":           { en: "Date",              fr: "Date" },
  "chart.gm.matchup":        { en: "Matchup",           fr: "Match" },
  "chart.gm.score":          { en: "Score",             fr: "Pointage" },
  "chart.gm.total":          { en: "Total",             fr: "Total" },
  "chart.gm.diff":           { en: "Margin",            fr: "Écart" },
  "chart.gm.status":         { en: "Status",            fr: "Statut" },
  "chart.gm.venue":          { en: "Venue",             fr: "Aréna" },
  "chart.gm.next5":          { en: "Next 5 days",       fr: "5 prochains jours" },
  "chart.gm.next10":         { en: "Next 10 days",      fr: "10 prochains jours" },
  "chart.gm.month":          { en: "Month",             fr: "Mois" },
  "chart.gm.results":        { en: "Results",           fr: "Résultats" },
  "chart.gm.upcoming":       { en: "Upcoming",          fr: "À venir" },
  "chart.gm.time":           { en: "Time",              fr: "Heure" },
  "chart.gm.noResults":      { en: "No games played in this range.", fr: "Aucun match joué sur cette période." },
  "chart.gm.noUpcoming":     { en: "No upcoming games in this range.", fr: "Aucun match à venir sur cette période." },
  "chart.gm.allTeams":       { en: "All teams",         fr: "Toutes les équipes" },
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
                               fr: "Choisis par où commencer — puis entre dans un club, un match ou un joueur." },
  "chart.home.teamsDesc":    { en: "Standings, goal differential and special teams for all 32 clubs.",
                               fr: "Classement, différentiel de buts et unités spéciales des 32 clubs." },
  "chart.home.gamesDesc":    { en: "Results and upcoming games, with totals and margins.",
                               fr: "Résultats et matchs à venir, avec totaux et écarts." },
  "chart.home.playersDesc":  { en: "League leaders season by season, skaters and goalies.",
                               fr: "Meneurs de la ligue saison par saison, patineurs et gardiens." },
  "chart.home.pickTeam":     { en: "Or go straight into a club", fr: "Ou entre directement dans un club" },
  "chart.home.pickTeamNote": { en: "Its games and its players stay inside that club's colours.",
                               fr: "Ses matchs et ses joueurs restent aux couleurs du club." },

  // ── Espace d'une équipe (/stats/chart/team/:abbr/…) ──
  "chart.teamSpace.games":   { en: "{team} · games",    fr: "{team} · matchs" },
  "chart.teamSpace.players": { en: "{team} · players",  fr: "{team} · joueurs" },
  "chart.teamSpace.only":    { en: "This club only",    fr: "Ce club seulement" },
  "pred.llmAnalysis":    { en: "LLM Analysis",          fr: "Analyse LLM" },
  "pred.markets":        { en: "Markets",               fr: "Marchés" },
  "pred.hideAll":        { en: "👁 Hide all",           fr: "👁 Masquer tout" },
  "pred.revealAll":      { en: "👁 Reveal all",         fr: "👁 Révéler tout" },
  "pred.showingRules":   { en: "📐 Rules — all",        fr: "📐 Règles — tout" },
  "pred.showingMl":      { en: "🤖 ML — all",           fr: "🤖 ML — tout" },
  "pred.tap":            { en: "Tap",                   fr: "Toucher" },
  "pred.today":          { en: "Today",                 fr: "Aujourd'hui" },
  "pred.recommendedBet": { en: "Recommended Bet",       fr: "Pari recommandé" },
  "pred.goToBuilder":    { en: "Go to Bet Builder →",   fr: "Aller au créateur de pari →" },
  "pred.recentForm":     { en: "Recent Form",           fr: "Forme récente" },
  "pred.h2hTitle":       { en: "Head-to-head",          fr: "Confrontations directes" },
  "pred.h2hNone":        { en: "No meetings yet this season", fr: "Aucune confrontation cette saison" },
  "pred.win":            { en: "Win",                   fr: "Victoire" },
  "pred.loss":           { en: "Loss",                  fr: "Défaite" },
  "pred.ranking":        { en: "Ranking",               fr: "Classement" },
  "pred.points":         { en: "Points",                fr: "Points" },
  "pred.predFactors":    { en: "Prediction Factors",    fr: "Facteurs de prédiction" },
  "pred.notFound":       { en: "Not Found",             fr: "Introuvable" },
  "pred.notExist":       { en: "This prediction doesn't exist.", fr: "Cette prédiction n'existe pas." },
  "pred.goBack":         { en: "Go Back",               fr: "Retour" },
  "pred.slipShort":      { en: "✓ Slip",                fr: "✓ Pari" },
  "pred.slipAddShort":   { en: "+ Slip",                fr: "+ Pari" },
  "pred.addToSlip":      { en: "+ Add to slip",         fr: "+ Ajouter au pari" },
  "pred.addedToSlip":    { en: "✓ Added to slip",       fr: "✓ Ajouté au pari" },
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
  "pred.unavailableHint":           { en: "No estimate is shown rather than a made-up one. Try again shortly.", fr: "Aucune estimation n'est affichée plutôt qu'un chiffre inventé. Réessaie dans un instant." },
  "pred.unavailableLeg":            { en: "Can't add this leg — no model probability right now.", fr: "Impossible d'ajouter cette jambe — pas de probabilité du modèle pour l'instant." },
  "pred.unavailableParlay":         { en: "Combined probability unavailable",                   fr: "Probabilité combinée indisponible" },
  "lastn.noData":                   { en: "No data",                                            fr: "Pas de données" },
  "pred.viewPlayers":    { en: "👥 View players",       fr: "👥 Voir les joueurs" },
  // Game picker (player & team pages) + players table (game page)
  "pred.forGame":        { en: "Bets for game",         fr: "Paris pour le match" },
  "pred.chooseGame":     { en: "Choose a game",         fr: "Choisir un match" },
  "pred.viewGame":       { en: "View game →",           fr: "Voir le match →" },
  "pred.noUpcoming":     { en: "No game scheduled in the next 14 days", fr: "Aucun match prévu dans les 14 prochains jours" },
  "pred.playersTable":   { en: "Players",               fr: "Joueurs" },
  "pred.seasonStats":    { en: "Season stats",          fr: "Stats de la saison" },
  "pred.viewRoster":     { en: "View full roster stats →", fr: "Voir les stats de l'effectif →" },
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
  "mkt.search":        { en: "Search team, player, or game…", fr: "Cherche une équipe, un joueur ou un match…" },
  "mkt.games":         { en: "🏒 Games",         fr: "🏒 Matchs" },
  "mkt.teams":         { en: "🛡️ Teams",         fr: "🛡️ Équipes" },
  "mkt.players":       { en: "⭐ Players",        fr: "⭐ Joueurs" },
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
  "cmd.examples":      { en: "Try", fr: "Essaie" },
  "cmd.ex1":           { en: "Habs win tonight", fr: "Canadien gagne ce soir" },
  "cmd.ex2":           { en: "Suzuki over 2.5 shots", fr: "Suzuki plus de 2,5 tirs" },
  "cmd.ex3":           { en: "Leafs ML and over 6.5", fr: "Leafs ML et over 6.5" },
  "cmd.loading":       { en: "Loading games…", fr: "Chargement des matchs…" },
  "cmd.loadError":     { en: "The schedule is unavailable. Try again later.", fr: "Calendrier indisponible. Réessaie plus tard." },
  "cmd.noGames":       { en: "No NHL game in the next {days} days: nothing to bet on for now.", fr: "Aucun match LNH dans les {days} prochains jours : rien à parier pour l'instant." },
  "cmd.undo":          { en: "Undo", fr: "Annuler" },
  "cmd.undone":        { en: "Removed", fr: "Retiré" },
  "cmd.duplicate":     { en: "Already in your slip: {label}", fr: "Déjà dans le coupon : {label}" },
  "cmd.unavailable":   { en: "No probability for {label}: not added.", fr: "Probabilité indisponible pour {label} : pas ajouté." },
  "cmd.missing":       { en: "Couldn't prepare {label}: not added.", fr: "Impossible de préparer {label} : pas ajouté." },
  "cmd.empty":         { en: "Type a bet, e.g. “Habs win tonight”.", fr: "Tape un pari, ex. « Canadien gagne ce soir »." },
  "cmd.unknown":       { en: "I didn't understand “{chunk}”.", fr: "Je n'ai pas compris « {chunk} »." },
  "cmd.whichTeam":     { en: "“{alias}”: which team?", fr: "« {alias} » : quelle équipe ?" },
  "cmd.whichPlayer":   { en: "Which {alias}?", fr: "Quel {alias} ?" },
  "cmd.whichLine":     { en: "Which line?", fr: "Quelle ligne ?" },
  "cmd.lineNotOffered":{ en: "Line {line} isn't offered. Pick one:", fr: "La ligne {line} n'est pas offerte. Choisis :" },
  "cmd.whichTotal":    { en: "Game total or {team} total?", fr: "Total du match ou total de {team} ?" },
  "cmd.gameTotal":     { en: "Game total {line}", fr: "Total du match {line}" },
  "cmd.gameMissing":   { en: "Which game? Name a team, e.g. “Habs Leafs over 6.5”.", fr: "Quel match ? Nomme une équipe, ex. « Habs Leafs over 6.5 »." },
  "cmd.noGameToday":   { en: "{subject} doesn't play tonight.", fr: "{subject} ne joue pas ce soir." },
  "cmd.noGameTomorrow":{ en: "{subject} doesn't play tomorrow.", fr: "{subject} ne joue pas demain." },
  "cmd.noGameNext":    { en: "No upcoming game for {subject} in the next {days} days.", fr: "Aucun match à venir pour {subject} dans les {days} prochains jours." },
  "cmd.position":      { en: "That market doesn't fit this player (saves are for goalies).", fr: "Ce marché ne va pas à ce joueur (les arrêts, c'est pour un gardien)." },
  "cmd.tooLong":       { en: "Too long: {max} characters at most.", fr: "Trop long : {max} caractères au maximum." },
  "cmd.tooMany":       { en: "{max} bets at most per sentence.", fr: "{max} paris au maximum par phrase." },
  "cmd.aiWorking":     { en: "The AI bet builder is reading your bet…", fr: "Le Bet builder IA lit ton pari…" },
  "cmd.aiUnclear":     { en: "The AI bet builder couldn't read that sentence either.", fr: "Le Bet builder IA n'a pas su lire cette phrase non plus." },
  "cmd.aiError":       { en: "The AI bet builder is unavailable right now. The reader without AI still works.", fr: "Le Bet builder IA est indisponible pour le moment. La lecture sans IA reste disponible." },
  "cmd.aiFreeQuota":   { en: "You've used your {limit} free AI bet builder tries for today. Go Pro so the AI can understand more complex bets.", fr: "Tu as utilisé tes {limit} essais gratuits du Bet builder IA aujourd'hui. Passe Pro pour que l'IA comprenne des paris plus complexes." },
  "cmd.aiFreeLeft":    { en: "AI bet builder free tries left today: {n} of {limit}", fr: "Essais gratuits restants du Bet builder IA aujourd'hui : {n} sur {limit}" },
  "cmd.aiProUsed":     { en: "Monthly AI allowance, shared with LLM Analysis: {used} of {limit}", fr: "Quota IA du mois, partagé avec l'Analyse LLM : {used} sur {limit}" },
  "cmd.aiOwnKey":      { en: "The AI bet builder uses your OpenAI key.", fr: "Le Bet builder IA utilise ta clé OpenAI." },
  "mkt.draw60":        { en: "Draw after 60 min", fr: "Nul après 60 min" },
  "mkt.addedSlip":     { en: "✓ Added to Slip!", fr: "✓ Ajouté au pari !" },
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
  "lastn.selectTeam":  { en: "Select a team",     fr: "Choisis une équipe" },
  "lastn.chooseTeam":  { en: "Choose a team…",    fr: "Choisis une équipe…" },
  "lastn.searchTeam":  { en: "Search team…",      fr: "Cherche une équipe…" },
  "lastn.selectSpan":  { en: "Select span",       fr: "Choisis une période" },
  "lastn.lastGames":   { en: "Last {n} Games",    fr: "{n} derniers matchs" },
  "lastn.loading":     { en: "Loading…",          fr: "Chargement…" },
  "lastn.explore":     { en: "Select a team above to explore their recent form", fr: "Choisis une équipe ci-dessus pour explorer sa forme récente" },

  // ── Players tab ──
  "players.selectTeam":  { en: "Select a team",     fr: "Choisis une équipe" },
  "players.loading":     { en: "loading…",          fr: "chargement…" },
  "players.count":       { en: "{n} players",       fr: "{n} joueurs" },
  "players.none":        { en: "No players found for {abbr}", fr: "Aucun joueur trouvé pour {abbr}" },
  "players.pickHint":    { en: "← Pick a team to see its players", fr: "← Choisis une équipe pour voir ses joueurs" },

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
  "pro.title":        { en: "Go ArakIce Pro",  fr: "Passe à ArakIce Pro" },
  // « illimitée » retiré ici aussi le 2026-09-08 : ce sous-titre s'affiche sur
  // /pro ET dans la carte Abonnement des Réglages, donc corriger seulement le
  // bloc d'avantages aurait laissé la promesse fausse à deux endroits.
  "pro.subtitle":     { en: "Unlock the full edge: every prediction, the value-bet finder, and AI analysis.", fr: "Débloque l'avantage complet : toutes les prédictions, le détecteur de value bets et l'analyse IA." },
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
  "pro.trialActive":  { en: "Free trial active 🎉", fr: "Essai gratuit actif 🎉" },
  "pro.trialEnds":    { en: "Trial ends on",   fr: "Essai se termine le" },
  "pro.loginPrompt":  { en: "Sign in to subscribe", fr: "Connecte-toi pour t'abonner" },
  "pro.cancel":       { en: "Cancel subscription", fr: "Annuler l'abonnement" },
  "pro.isProTitle":   { en: "You're Pro 🎉",   fr: "Tu es Pro 🎉" },
  "pro.isProBody":    { en: "Thanks! You have access to everything.", fr: "Merci ! Tu as accès à toutes les fonctionnalités." },
  "pro.renews":       { en: "Renews on",       fr: "Renouvellement le" },
  "pro.cancelScheduled": { en: "Your Pro access ends on", fr: "Ton accès Pro se termine le" },
  "pro.successTitle": { en: "Welcome to ArakIce Pro 🎉", fr: "Bienvenue dans ArakIce Pro 🎉" },
  "pro.successBody":  { en: "Your Pro access is active. Enjoy every prediction, alert and market — no limits.", fr: "Ton accès Pro est activé. Profite de toutes les prédictions, alertes et marchés — sans limite." },
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
  "pro.cancelConfirmBody":       { en: "Your subscription won't renew. You keep full Pro access until {date}.", fr: "Ton abonnement ne sera pas renouvelé. Tu gardes l'accès Pro complet jusqu'au {date}." },
  "pro.cancelConfirmBodyNoDate": { en: "Your subscription won't renew. You keep full Pro access until the end of the period you already paid for.", fr: "Ton abonnement ne sera pas renouvelé. Tu gardes l'accès Pro complet jusqu'à la fin de la période déjà payée." },
  "pro.subscription": { en: "Subscription",    fr: "Abonnement" },
  "pro.promo.label":       { en: "Have a promo code?", fr: "Tu as un code promo ?" },
  "pro.promo.placeholder": { en: "Enter code",         fr: "Entre ton code" },
  "pro.promo.apply":       { en: "Apply",              fr: "Appliquer" },
  // Pro-exclusive benefits (title + description)
  "pro.b.bestbets.t": { en: "Daily Best Bets",           fr: "Best Bets du jour" },
  "pro.b.bestbets.d": { en: "The day's top picks, selected and rated by the model.", fr: "Les meilleurs paris du jour, sélectionnés et notés par le modèle." },
  "pro.b.ev.t":       { en: "Value-bet finder (EV)",     fr: "Détecteur de value bets (EV)" },
  "pro.b.ev.d":       { en: "Automatically flags positive-EV bets where your edge beats the odds.", fr: "Repère automatiquement les paris à valeur positive (+EV) où ton edge dépasse la cote." },
  "pro.b.alerts.t":   { en: "Value-bet notifications",   fr: "Notifications value bets" },
  "pro.b.alerts.d":   { en: "Get alerted the moment a new +EV appears, before the odds move.", fr: "Reçois une alerte dès qu'un nouveau +EV apparaît, avant que la cote bouge." },
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
  "pro.b.llm.d":        { en: "The model's take on every game — {n} analyses a month. Past that, your own OpenAI key takes over.", fr: "L'avis du modèle sur tous les matchs — {n} analyses par mois. Au-delà, ta propre clé OpenAI prend le relais." },
  "pro.b.llm.dNoCount": { en: "The model's take on every game, within a generous monthly allowance. Past that, your own OpenAI key takes over.", fr: "L'avis du modèle sur tous les matchs, dans la limite d'un forfait mensuel confortable. Au-delà, ta propre clé OpenAI prend le relais." },
  "pro.b.markets.t":  { en: "All markets & full slate",  fr: "Tous les marchés & calendrier complet" },
  "pro.b.markets.d":  { en: "Beyond today's games: the full schedule and every bet365 market.", fr: "Au-delà des matchs du jour : tout le calendrier et chaque marché bet365." },
  "pro.b.others.t":   { en: "Other players' stats & bets", fr: "Stats & bets des autres joueurs" },
  "pro.b.others.d":   { en: "Compare yourself to the leaderboard and see their picks.", fr: "Compare-toi aux meilleurs du classement et vois leurs paris." },

  // ── Schedule (calendrier des matchs) ──
  "home.schedule":       { en: "Game calendar", fr: "Calendrier des matchs" },
  "schedule.title":      { en: "Schedule",      fr: "Calendrier" },
  "schedule.subtitle":   { en: "Every game of the season", fr: "Tous les matchs de la saison" },
  "schedule.loading":    { en: "Loading games…", fr: "Chargement des matchs…" },
  "schedule.noGames":    { en: "No games this month.", fr: "Aucun match ce mois-ci." },
  "schedule.error":      { en: "Couldn't load the schedule.", fr: "Impossible de charger le calendrier." },
  "schedule.at":         { en: "@", fr: "@" },

  // ── Home: value bets (EV) + locked sections ──
  "home.evTitle":     { en: "Value Bets (EV)",  fr: "Value Bets (EV)" },
  "home.evSpot":      { en: "Our model rates it higher than the odds", fr: "Le modèle y croit plus que la cote" },
  "home.evEmpty":     { en: "No value bets right now — check back soon.", fr: "Aucun value bet pour l'instant — reviens bientôt." },
  "home.evLockDesc":  { en: "The detector flags bets where our model's probability beats the bookmaker's odds (+EV). Pro only.", fr: "Le détecteur repère les paris où la probabilité de notre modèle dépasse la cote (+EV). Réservé aux Pro." },
  "home.evSettings":  { en: "Alert settings", fr: "Réglages des alertes" },
  "home.bestBetsLockDesc": { en: "The day's top picks, selected and rated by the model. Upgrade to Pro to see them.", fr: "Les meilleurs paris du jour, sélectionnés et notés par le modèle. Passe à Pro pour les voir." },

  // ── Profile: notifications (Pro) ──
  "profile.notifications":      { en: "Notifications",         fr: "Notifications" },
  "profile.notifyValueBets":    { en: "Value-bet alerts",      fr: "Alertes value bets" },
  "profile.notifyValueBetsHint":{ en: "Get notified when a new +EV opportunity appears.", fr: "Sois averti dès qu'un nouveau +EV apparaît." },
  "profile.minEv":              { en: "Minimum edge",           fr: "Edge minimum" },
  "profile.minEvHint":          { en: "Only alert me when the value bet's edge is at least this %.", fr: "Ne m'alerte que si l'edge du value bet atteint au moins ce %." },
  "profile.notifyDenied":       { en: "Notifications blocked — allow them in your browser.", fr: "Notifications bloquées — autorise-les dans ton navigateur." },

  // ── Legal / support ──
  "legal.terms":   { en: "Terms",         fr: "CGU" },
  "legal.privacy": { en: "Privacy",       fr: "Confidentialité" },
  "legal.support": { en: "Support",       fr: "Support" },
  // Une seule source pour la mention de non-affiliation dans l'app ; les pages
  // SEO statiques portent la même dans client/scripts/seo-gen.mjs.
  "legal.notAffiliated": { en: "Not affiliated with or endorsed by the NHL or its teams. NHL and team names are trademarks of their respective owners.", fr: "Non affilié à la LNH ni à ses équipes, et non approuvé par elles. LNH et les noms d'équipes sont des marques de leurs propriétaires respectifs." },

  // ── 404 ──
  "notFound.title": { en: "Page not found", fr: "Page introuvable" },
  "notFound.body":  { en: "This page doesn't exist or has moved.", fr: "Cette page n'existe pas ou a été déplacée." },

  // ── Écran d'erreur (components/ErrorScreen.tsx) ──
  "error.title":        { en: "Something went wrong", fr: "Oups, quelque chose s'est mal passé" },
  "error.body":         { en: "An unexpected error occurred. Try again, or head back to the home page.", fr: "Une erreur inattendue est survenue. Réessaie, ou reviens à l'accueil." },
  "error.offlineTitle": { en: "You're offline", fr: "Tu es hors ligne" },
  "error.offlineBody":  { en: "Check your connection, then try again.", fr: "Vérifie ta connexion, puis réessaie." },
  "error.updateTitle":  { en: "A new version of ArakIce is available", fr: "Une nouvelle version d'ArakIce est disponible" },
  "error.updateBody":   { en: "Reload to get the latest version.", fr: "Recharge pour obtenir la dernière version." },
  "error.reload":       { en: "Reload", fr: "Recharger" },
  "error.code":         { en: "Error code: {id}", fr: "Code d'erreur : {id}" },

  // ── League: Pro lock on other players' bets ──
  "league.othersProTitle": { en: "See their bets with Pro", fr: "Vois leurs paris avec Pro" },
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
  "home.colSpread":    { en: "Puck line",      fr: "Handicap" },
  "home.colWinner":    { en: "Winner",         fr: "Vainqueur" },
  "home.plPlus":       { en: "{abbr} +1.5 (doesn't lose by 2+)", fr: "{abbr} +1,5 (ne perd pas par 2 buts ou plus)" },
  "home.pickHint":     { en: "Tap to add to your slip, double-tap to remove", fr: "Touche pour ajouter au coupon, touche deux fois pour retirer" },
  "home.noRealMoney":  { en: "No real money involved.", fr: "Aucun argent réel en jeu." },
  "home.noRealMoneyHint": { en: "ArakIce is an analytics tool: the bets in your slip are virtual, for fun and the leaderboard.", fr: "ArakIce est un outil d'analyse : les paris de ton coupon sont virtuels, pour le plaisir et le classement." },
  "home.proHeadline":  { en: "Go Pro",         fr: "Passe à Pro" },
  "home.proSub":       { en: "The model's best picks of the day and the value bets it spots, in one place.", fr: "Les meilleurs paris du jour et les value bets repérés par le modèle, réunis au même endroit." },
  "home.proBestBetsDesc": { en: "The day's strongest picks across every market, rated by the model.", fr: "Les paris les plus solides du jour, tous marchés confondus, notés par le modèle." },
  "home.proEvDesc":    { en: "Bets where our model sees a better chance than the bookmaker's odds imply.", fr: "Les paris où notre modèle voit plus de chances que ce que suppose la cote du bookmaker." },
  "home.proOnly":      { en: "Available to Pro subscribers.", fr: "Réservé aux abonnés Pro." },
  "home.evWhatTitle":  { en: "Value bet", fr: "Value bet" },
  "home.evWhat":       { en: "A bet where our model gives a better chance of winning than the bookmaker's odds suggest.", fr: "Un pari où notre modèle donne plus de chances de gagner que ce que la cote du bookmaker laisse croire." },
  "home.evWhat2":      { en: "When odds are too generous, that gap is the value.", fr: "Quand la cote est trop généreuse, cet écart, c'est la valeur." },
  "home.evWhat3":      { en: "A value bet isn't a sure win, it's a bet that pays better than it should.", fr: "Un value bet n'est pas gagné d'avance : c'est un pari mieux payé qu'il ne devrait l'être." },
  "home.evExampleLabel": { en: "Example", fr: "Exemple" },
  "home.evExample":    { en: "odds of 2.50 imply a 40% chance. If the model sees 48%, that's +8 pts of value.", fr: "une cote de 2.50 suppose 40 % de chances. Si le modèle en voit 48 %, ça fait +8 pts de valeur." },
  "home.evEdge":       { en: "+{edge} pts value", fr: "+{edge} pts de valeur" },
  "home.evVs":         { en: "Model {model}% vs book {book}%", fr: "Modèle {model} % vs livre {book} %" },
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
