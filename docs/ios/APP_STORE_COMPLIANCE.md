# App Store Connect — réponses de conformité (APPLE_PLAN Phase 1)

**Créé :** 2026-10-09 · Relevé dans le code, pas estimé. Concerne le **build iOS v1** :
pas de Google Sign-In, pas de Stripe ni d'achat Pro, pas de clé OpenAI personnelle,
pas de liens bookmakers, pas de Web Push (`client/src/app/platform.ts`).
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
Quand l'IAP arrivera (Phase 5), le lien Terms devra aussi apparaître sur l'écran d'achat.

## 3. Divulgation d'abonnement (1.3)

**Sans objet pour la v1** : aucun achat dans l'app iOS (`proUpgrade: isWeb`).
À faire en Phase 5 avec l'écran StoreKit.

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
| Diagnostics → Crash Data | Sentry (`sendDefaultPii: false`, pas de `setUser`) | App Functionality | **No** | No |
| Diagnostics → Performance Data | Sentry traces (10 %) | App Functionality | **No** | No |

Non déclaré, et pourquoi :
- **Purchases** : rien n'est acheté dans l'app iOS v1. À ajouter en Phase 5.
- **Financial Info** : la clé OpenAI personnelle est coupée sur iOS (`byokOpenAI: isWeb`).
- **Usage Data / Location** : aucun SDK d'analytics ; l'IP n'apparaît que dans les journaux
  serveur (sécurité, anti-abus), sans profilage ni géolocalisation.
- **Contacts, Health, Browsing History, Search History, Sensitive Info** : jamais collectés.

Quand les notifications APNs arriveront (Phase 4), le jeton d'appareil n'est pas un type
de donnée Apple à déclarer en soi, mais la politique de confidentialité doit le mentionner
(voir §8).

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

Brouillon : `docs/ios/PrivacyInfo.xcprivacy`. À copier en Phase 3 dans
`client/ios/App/App/PrivacyInfo.xcprivacy`, l'ajouter à la cible App dans Xcode
(ou via le projet généré par Capacitor), puis vérifier dans le rapport de confidentialité
de l'archive (Xcode → Organizer → Generate Privacy Report) que les plugins Capacitor
apportent bien leurs propres manifestes.

## 8. Mises à jour de la politique à faire plus tard

| Quand | Section de `/privacy` | Changement |
|---|---|---|
| Phase 3 (Capacitor) | 10. Sécurité | sur iOS, la session est gardée dans le Trousseau (Keychain), pas dans un cookie httpOnly |
| Phase 3 | 2 et 6 | préciser que la connexion Google n'existe que sur le web |
| Phase 4 (APNs) | 2, 6, 8 | « l'adresse que votre navigateur **ou appareil** nous donne » ; Apple Push Notification service comme fournisseur |
| Phase 5 (IAP) | 2, 6, 9 | Apple comme fournisseur de paiement ; un abonnement Apple ne s'annule pas en supprimant le compte (6.4) |

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
