# Build iOS dans le cloud → TestFlight (APPLE_PLAN Phase 7)

**Créé :** 2026-10-09 · Workflow : `.github/workflows/ios-release.yml`

Le workflow tourne sur un Mac de GitHub, construit l'app (`npm run build:ios` →
`cap sync` → `xcodebuild archive`), la signe avec **ton** certificat de distribution
et l'envoie directement dans TestFlight. Aucun Mac nécessaire de ton côté.

**Pourquoi la signature manuelle ?** La signature automatique « dans le cloud » exige une
clé API **Admin**, et l'archive demande en plus un certificat de développement sur la
machine. Avec un certificat de distribution et un profil créés une fois (valables 1 an),
la clé API **App Manager** créée en Phase 0 suffit : elle ne sert qu'à l'envoi.

---

## 1. Certificat Apple Distribution (une fois par an)

La clé privée et la demande (CSR) ont été générées sur ton ordinateur dans
`ios-signing/` (dossier ignoré par git — ne le commite jamais, ne l'envoie à personne).

1. developer.apple.com → Account → **Certificates, Identifiers & Profiles** → Certificates → **+**
2. Choisir **Apple Distribution** → Continue
3. Téléverser `ios-signing/distribution.csr` → Continue → **Download**
4. Enregistrer le fichier sous `ios-signing/distribution.cer`

## 2. Profil App Store (une fois par an, et après chaque nouveau certificat)

1. Même portail → **Profiles** → **+**
2. Distribution → **App Store Connect** → Continue
3. App ID : `com.arakice.iceedge` → Continue
4. Certificat : celui créé à l'étape 1 → Continue
5. Nom du profil : **`ArakIce App Store`** (exactement — le workflow vérifie le nom)
6. Generate → **Download** → enregistrer dans `ios-signing/`

## 3. Fabriquer les valeurs des secrets

Demande-le à Claude (il le fait dans ton dossier), ou dans **Git Bash** depuis
`ios-signing/` :

```bash
openssl x509 -inform DER -in distribution.cer -out distribution.pem
PASS=$(openssl rand -base64 24)
openssl pkcs12 -export -inkey distribution.key -in distribution.pem \
  -out distribution.p12 -passout pass:"$PASS" -name "ArakIce Distribution" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
echo "$PASS" > p12-password.txt
base64 -w0 distribution.p12 > p12.base64.txt
base64 -w0 ArakIce_App_Store.mobileprovision > profile.base64.txt
```

(Les options `PBE-SHA1-3DES` / `sha1` gardent le .p12 lisible par le trousseau macOS.)

Pour la clé API `.p8` (PowerShell, dans le dossier où elle est rangée) :

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXXXXXXXX.p8")) | Set-Clipboard
```

## 4. GitHub → dépôt IceEdge → Settings → Secrets and variables → Actions

**Secrets** (onglet *Secrets*) :

| Nom | Valeur |
|---|---|
| `IOS_DIST_P12_BASE64` | contenu de `p12.base64.txt` |
| `IOS_DIST_P12_PASSWORD` | contenu de `p12-password.txt` |
| `IOS_PROFILE_BASE64` | contenu de `profile.base64.txt` |
| `ASC_KEY_ID` | Key ID de la clé API (App Store Connect → Users and Access → Integrations) |
| `ASC_ISSUER_ID` | Issuer ID (même page, en haut) |
| `ASC_KEY_P8_BASE64` | le `.p8` en base64 (commande PowerShell ci-dessus) |

**Variables** (onglet *Variables* — valeurs publiques, déjà visibles dans le JS) :

| Nom | Valeur |
|---|---|
| `VITE_NHL_API_URL` | `https://api.arakice.com` |
| `VITE_PROFILE_API_URL` | `https://api.arakice.com` |
| `VITE_PREDICTION_API_URL` | `https://api.arakice.com` |
| `VITE_SOCKET_URL` | `https://api.arakice.com` |
| `VITE_SENTRY_DSN` | le même DSN que dans Vercel |
| `VITE_SUPPORT_EMAIL` | `support@arakice.com` |
| `APPLE_TEAM_ID` | Team ID (developer.apple.com → Account → Membership details) |
| `IOS_PROFILE_NAME` | `ArakIce App Store` |

Ensuite, tu peux supprimer `p12.base64.txt`, `profile.base64.txt` et `p12-password.txt`
(les garder dans ton gestionnaire de mots de passe si tu veux). Garde
`distribution.key` + `distribution.p12` en lieu sûr hors du dépôt : sans eux, il faut
refaire un certificat.

## 5. Lancer un build

GitHub → **Actions** → **iOS → TestFlight** → **Run workflow** (branche `master`).
Compter ~15–25 min. Le numéro de build = le numéro du run (toujours croissant).
Alternative : pousser un tag `ios-v1.0.0`.

Coût : sur un dépôt privé, les minutes macOS comptent ×10 (2 000 min gratuites/mois
≈ 200 min macOS ≈ 8–12 builds). Ne lance pas un build à chaque commit.

## 6. Installer sur ton iPhone

1. App Store Connect → ton app → **TestFlight** : le build apparaît après le traitement
   d'Apple (5–30 min). La question de conformité export ne se pose pas
   (`ITSAppUsesNonExemptEncryption = NO` dans l'Info.plist).
2. **Internal Testing** → **+** → crée un groupe, ajoute-toi (ton compte Apple de
   développeur), coche le build.
3. Sur l'iPhone : installe l'app **TestFlight** depuis l'App Store, accepte l'invitation
   reçue par courriel, installe ArakIce.

## 7. Si le workflow échoue

| Message | Cause probable |
|---|---|
| `Missing repository variables` | une variable de l'étape 4 manque |
| `Xcode NN is too old` | changer `runs-on: macos-15` en `macos-26` dans le workflow |
| `No 'Apple Distribution' identity` | mauvais `.p12`, ou mauvais mot de passe |
| `Profile is named …` | `IOS_PROFILE_NAME` ≠ nom du profil téléchargé |
| `No profiles for 'com.arakice.iceedge'` / `doesn't include signing certificate` | profil créé avec un autre certificat : refaire l'étape 2 |
| erreur d'envoi (401 / « authentication ») | `ASC_KEY_ID`, `ASC_ISSUER_ID` ou le `.p8` ne correspondent pas |
| `bundle version must be higher` | un build avec ce numéro existe déjà : relancer (nouveau run = nouveau numéro) |
| `✗ build:ios — …` | une URL non https (R7) ou une trace de bookmaker dans le bundle (2.2) |
