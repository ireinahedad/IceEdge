# App Store Connect — réponses de conformité (APPLE_PLAN Phase 1)

**Créé :** 2026-10-09 · **Mis à jour :** 2026-10-11 (abonnement Pro par achat intégré).
Relevé dans le code, pas estimé. Concerne le **build iOS v1** : pas de Google Sign-In,
pas de Stripe, Pro **uniquement par achat intégré Apple** (StoreKit 2), pas d'essai web ni
de code promo, pas de clé OpenAI personnelle, pas de liens bookmakers, pas de Web Push
(`client/src/app/platform.ts`).
Si une de ces options change, ce fichier change avec elle.

---

## 1. URLs (App Information / version)

| Champ App Store Connect | Valeur |
|---|---|
| Privacy Policy URL | `https://arakice.com/privacy` |
| Support URL | `https://arakice.com/support` |
| Marketing URL | `https://arakice.com` — voir R10 (cadrage paris du site) avant de la remplir |
| Terms of Use | `https://arakice.com/terms` (ajouter le lien en fin de description) |

## 2. EULA (1.2)

Garder la **licence standard d'Apple** (champ « License Agreement » laissé par défaut).
Nos conditions (`/terms`) s'appliquent au service et sont liées dans la description.
L'écran d'achat iOS (`AppleProSection.tsx`) lie nos Conditions, l'EULA standard d'Apple et
la Politique de confidentialité, sous le bouton d'abonnement.

## 3. Divulgation d'abonnement (1.3)

L'écran d'achat iOS (`AppleProSection.tsx`) affiche déjà tout ce qu'Apple exige. Reste, dans App
Store Connect : ajouter à la fin de la **description** de l'app une ligne :
« Abonnement ArakIce Pro : 5,99 $/mois ou 59,99 $/an, essai gratuit de 7 jours. Conditions :
https://arakice.com/terms — EULA : https://www.apple.com/legal/internet-services/itunes/dev/stdeula/ »

## 4. Classification d'âge (1.4) → **18+**

App Store Connect → App Information → Age Rating.

| Section | Question | Réponse | Pourquoi |
|---|---|---|---|
| In-App Controls | Parental Controls | No | |
| | Age Assurance | No | |
| Capabilities | Unrestricted Web Access | No | les liens externes ouvrent des URLs précises (Safari View Controller), pas un navigateur libre |
| | User-Generated Content | **Yes** | chat, bio, photo de profil, paris visibles aux membres Pro |
| | Social Media | **Yes** | les membres interagissent avec le contenu des autres (salons, paris des joueurs) |
| | Messaging and Chat | **Yes** | salons de chat |
| | Advertising | No | aucune pub |
| Mature Themes | Profanity or Crude Humor | None | le contenu de l'app n'en contient pas ; le chat filtré relève de UGC |
| | Horror/Fear · Alcohol, Tobacco, Drugs | None | |
| Medical or Wellness | les deux | None | |
| Sexuality or Nudity | toutes | None | |
| Violence | toutes | None | |
| Chance-Based Activities | Gambling | **No** | aucun pari en argent réel, aucun fonds détenu |
| | Simulated Gambling | **Frequent** | suivi de paris, cotes, probabilités et classements sont au cœur de l'app |
| | Contests | Infrequent | classements des ligues |
| | Loot Boxes | No | |

« Simulated Gambling: Frequent » donne **18+**, ce qui correspond à l'âge minimum de nos
conditions (section 4) et au cadrage « analytique, sans argent » des notes de revue.
Répondre « No » pour baisser le classement contredirait les conditions et ouvrirait un
débat 5.3 que l'on ne veut pas avoir.

## 5. App Privacy — « nutrition labels » (1.6)

App Store Connect → App Privacy. **Tracking : No** (aucune donnée partagée avec des
annonceurs ou courtiers, aucun SDK publicitaire).

| Type de donnée | Collectée par | Usage | Liée à l'identité | Tracking |
|---|---|---|---|---|
| Contact Info → Email Address | compte | App Functionality | Yes | No |
| Contact Info → Name | nom affiché (facultatif) | App Functionality | Yes | No |
| User Content → Photos or Videos | photo de profil (R2) | App Functionality | Yes | No |
| User Content → Other User Content | messages de chat, paris, bio, signalements | App Functionality | Yes | No |
| Identifiers → User ID | identifiant et nom d'utilisateur | App Functionality | Yes | No |
| Purchases → Purchase History | abonnement Pro acheté dans l'app : produit, dates, identifiants de transaction Apple (migration 045) | App Functionality | **Yes** | No |
| Identifiers → Device ID | jeton APNs (`apns_device_tokens`, migration 043), envoyé au serveur pour les notifications | App Functionality | **Yes** (lié au `user_id`) | No |
| Diagnostics → Crash Data | Sentry (`sendDefaultPii: false`, pas de `setUser`) | App Functionality | **No** | No |
| Diagnostics → Performance Data | Sentry traces (10 %) | App Functionality | **No** | No |

Non déclaré, et pourquoi :
- **Financial Info → Payment Info** : Apple traite le paiement ; nous ne recevons aucune
  donnée de paiement (seulement la transaction signée).
- **Financial Info** : la clé OpenAI personnelle est coupée sur iOS (`byokOpenAI: isWeb`).
- **Usage Data / Location** : aucun SDK d'analytics ; l'IP n'apparaît que dans les journaux
  serveur (sécurité, anti-abus), sans profilage ni géolocalisation.
- **Contacts, Health, Browsing History, Search History, Sensitive Info** : jamais collectés.

**Jeton d'appareil (mis à jour 2026-10-11).** Depuis 4.1, l'app envoie son jeton APNs au
serveur, qui le garde lié au compte (table `apns_device_tokens`, effacée avec le compte).
Apple ne cite pas les jetons push dans ses exemples de « Device ID », mais c'est un
identifiant d'appareil lié à l'utilisateur : on le **déclare** (ligne ci-dessus), c'est le
choix sans risque. La politique de confidentialité doit aussi le mentionner (voir §8, Phase 4).
Le jeton du widget (migration 044) est créé par notre serveur, pas collecté sur l'appareil :
rien à déclarer en plus.

## 6. Export compliance (1.5)

Réponse : l'app utilise **uniquement du chiffrement exempté** (HTTPS/TLS via les API
d'Apple). Le chiffrement AES-256-GCM des clés OpenAI est côté serveur, pas dans l'app.
En Phase 3, ajouter dans `client/ios/App/App/Info.plist` :

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

Avec cette clé, App Store Connect ne pose plus la question à chaque build.

## 7. Privacy manifest (1.6)

`client/ios/App/App/PrivacyInfo.xcprivacy` est dans la cible App. Avant la soumission : Xcode →
Organizer → Generate Privacy Report sur l'archive, pour vérifier que les plugins Capacitor
apportent bien leurs propres manifestes.

## 8. Mises à jour de la politique encore à faire (suivi : `STATUS.md` §3.4)

| Quand | Section de `/privacy` | Changement |
|---|---|---|
| Avant la soumission | 10. Sécurité | sur iOS, la session est gardée dans le Trousseau (Keychain), pas dans un cookie httpOnly |
| Avant la soumission | 2 et 6 | préciser que la connexion Google n'existe que sur le web |

## 9. Risque à trancher avant la soumission — R18 · logos et photos de la LNH

App Store Connect demande si l'app « contient, affiche ou accède à du contenu tiers »,
et la règle 5.2.1 exige d'avoir les droits sur les marques et images utilisées. L'app
affiche les **logos d'équipes et photos de joueurs** chargés depuis les serveurs de la LNH,
sans licence. Les conditions disent déjà que l'app n'est pas affiliée à la LNH, mais ce
n'est pas une licence.

Options : (a) garder et répondre honnêtement « Yes », en assumant le risque d'un rejet
5.2.1 ; (b) dans le build iOS, remplacer logos et photos par des pastilles de couleur
d'équipe et des initiales (le partage d'image le fait déjà, voir `slipShareCanvas.ts`).
L'option (b) supprime le risque pour peu d'effort ; à décider avant la Phase 8 (captures).

