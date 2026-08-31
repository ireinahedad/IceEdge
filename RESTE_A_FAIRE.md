# ARAKICE / ICEEDGE — Ce qui reste

**Créé le 2026-08-10 · mis à jour le 2026-08-31.**

> **Élagué le 2026-08-30.** Tout ce qui était clos ET sans leçon a été retiré
> (B7, B8, B9, le détail Sentry, le lot `npm audit`, le §7 soldé, la ligne 7 bis
> du §3, les contrôles du retrait tennis). Ce qui reste des points fermés, ce
> sont les avertissements — « ne pas refaire », « ne pas défaire », « ne pas
> rouvrir » — condensés à quelques lignes chacun. Le détail supprimé est dans
> l'historique Git, à partir du commit `15ecbb6`.
>
> **Second passage le 2026-08-30**, après trois contrôles passés au navigateur :
> le **§7 a disparu** (son dernier survivant, M6, est vert), et les trois cases
> fermées ce jour-là — CSP, synchro des poids, retrait tennis — sont réduites à
> leur seule leçon. Une ligne fermée ne reste dans ce document que si elle
> empêche quelqu'un de refaire une erreur.

> **Reprendre ici.** Décidé le 2026-08-24 : **mettre d'abord la collecte live en
> service** (A1bis, gratuit, échéance réelle à la pré-saison de fin septembre).
> La décision des **59 $** de backfill The Odds API reste ouverte et n'est pas
> urgente — le calcul complet, avec les arguments des deux côtés, est en **§2**.

Ce document regroupe **tout ce qui n'est pas fait**, tiré
des 6 plans et audits du dépôt. Il ne raconte pas ce qui a été livré — l'historique
Git et `PROJECT_CONTEXT.md` s'en chargent.

**Trois plans ont été supprimés** parce qu'ils étaient terminés ; leur restant est
ici et leur contenu durable a été déplacé (détail en dernière section) :

| Supprimé | Pourquoi | Où est parti le contenu durable |
|---|---|---|
| `PLAN.md` | Sections 1-5 livrées ; §6 (Share) livrée depuis, §7 (Opportunities) morte, §8 remplacée par les audits | rien à garder |
| `DEPLOY_PLAN.md` | Redondant avec `DEPLOYMENT.md` | `DEPLOYMENT.md` §4 (hôte canonique) et §6 (checklist) |
| `MARKETPLACE_PLAN.md` | Livré le 2026-08-09 | `DEPLOYMENT.md` §7 (invariants + annexe marketplace) |

**Toujours vivants, à tenir à jour :** `ml/REFACTOR_PLAN.md`, `QA_TEST_PLAN.md`,
`AUDIT_SCALABILITE_COUTS.md`. `PRODUCTION_READINESS_AUDIT.md` (2026-07-20) est
**intégralement soldé depuis le 2026-08-30** — H8, M2, M4, M7, M1 et enfin M6 :
il est conservé comme trace, il n'a plus rien à piloter.

---

## 1. Bloquant avant lancement

> **🧊 Gelé jusqu'au 2026-09-06 — tentative de récupération du compte Google.**
> Le compte `arakice.support@gmail.com` ne sert **pas** à R2 : R2 est refait et
> opérationnel sur `Ireinahedad@icloud.com's Account` (cf. § « R2 refait sur le
> compte accessible »). Il sert à deux autres choses — la **zone DNS
> `arakice.com`**, aujourd'hui servie par un compte perdu, et les **anciens
> avatars**, qui deviennent des orphelins dès que `R2_PUBLIC_URL` change.
>
> **Trois lignes seulement en dépendent. Ne pas y toucher avant que ce soit
> tranché :**
> 1. les quatre variables R2 sur Railway — surtout `R2_PUBLIC_URL`, à poser **une
>    seule fois** : chaque changement orpheline les avatars du préfixe précédent ;
> 2. connecter `cdn.arakice.com` et désactiver l'URL `pub-92ed72f7…r2.dev` ;
> 3. les étapes **3 et 4** de la bascule (serveurs de noms chez le registrar,
>    attente de l'état *Active*).
>
> **Cutoff au 2026-09-06.** Une récupération Google aboutit en quelques jours ou
> jamais ; la pré-saison est fin septembre et la bascule NS demande de la
> propagation. Passé cette date, prendre la branche icloud et migrer — ne pas
> laisser l'échéance trancher seule.
>
> **Faisable tout de suite, dans les deux branches :** l'**étape 1** de la bascule
> — relever les vraies origines chez Vercel et Railway et corriger les 13
> enregistrements de la zone en attente (sans risque si le compte revient, chemin
> critique sinon) ; et **mesurer si R2 écrit encore en production**, par un
> `HeadBucket` au démarrage, puisque `[avatarStorage] R2 actif` ne fait aucun
> appel réseau.
>
> **À retarder au contraire :** basculer le webhook Stripe sur `api.arakice.com`.
> Ce nom est servi par le compte perdu — ce serait échanger une panne muette
> contre une autre.
>
> **Le reste du document est indépendant de cette question** : B3, B4, B5, tout
> le §4 QA, la décision des 59 $ du §2, l'essai Sentry qui expire vers le
> 12 septembre. *(Le § « Budget compute » de `MONITORING.md` / `DEPLOYMENT.md`
> a été corrigé le 2026-08-30 — voir plus bas.)*
>
> **Point du 2026-08-31 : le compte Google est toujours inaccessible.** Décision
> prise ce jour : **on tient la date butoir**, on ne bascule pas en avance. Ce
> qui a été fait à la place, parce que c'est valable dans les deux branches :
> l'**étape 1 est terminée** — origines relevées, zone lue enregistrement par
> enregistrement, table de correction écrite (§ « Étape 1 de la bascule »). Il ne
> reste qu'une valeur inconnue, la cible CNAME de Railway.
>
> ⚠️ **Et le relevé du jour a montré que la production écrit toujours ses avatars
> dans l'ANCIEN R2**, pas dans celui qui a été refait le 2026-08-29
> (§ « Ce que les logs du conteneur en cours disent »). **Décision du même
> jour : on l'y laisse**, jusqu'à confirmation — et non supposition — de la
> perte d'accès au compte d'origine. Le jeton R2 ne passe pas par la connexion
> Google, il continue de fonctionner. Le prix à payer est connu : chaque avatar
> téléversé d'ici la bascule sera un orphelin non supprimable le jour où
> `R2_PUBLIC_URL` changera.

Rien ici ne demande de conception ; tout demande **ta machine ou une console**.

| # | Quoi | Où | Pourquoi ça bloque |
|---|---|---|---|
| B3 | Tir de charge **S1 de validation** : `NHL_USE_MOCK=true` vérifié dans les logs de démarrage, 50 VUs | préprod | Les deux premiers tirs ont mesuré une API NHL morte. Un critère vert peut vouloir dire que le code n'a pas tourné. `AUDIT_SCALABILITE_COUTS.md` §5. |
| B4 | Parcours critiques **F1, F2, I1, I2** en staging | staging | Auth complète, gating Pro, chaîne ML, CORS+cookie cross-site. **Runbooks exécutables écrits le 2026-08-30** : `QA_TEST_PLAN.md` § « Runbooks B4 » — séquence, assertions et pièges, plus un préflight de 4 variables sans lequel trois des quatre parcours échouent pour la mauvaise raison. |
| B5 | **C1** — parcours mobile iOS Safari (login → prédiction → paiement) | appareil réel | Safari iOS est la source n°1 de bugs cookies/`SameSite`/PWA. |
| B6 | Alertes de budget : **six fournisseurs sur sept sont clos** (détail plus bas), reste **R2** | console Cloudflare | Gelé avec le fork DNS ci-dessus. Seuils dans `MONITORING.md`. |

### État réel de la production — relevé du 2026-08-29, ce qu'il en reste

**La topologie est conforme.** Les deux services sont dans le même projet
`harmonious-perception`, environnement `production` : `courageous-analysis` (ML,
**Unexposed service**, aucun domaine public) et `IceEdge` (`api.arakice.com`),
reliés par `ML_SERVICE_URL = http://courageous-analysis.railway.internal:8080`,
`ML_API_TOKEN` des deux côtés, `ML_DISABLED=false`. Le §3 de `DEPLOYMENT.md` est
respecté sur toute la ligne. Le second projet Railway, `generous-fulfillment`,
est vide.

**Les trois anomalies trouvées ce jour-là sont refermées** : `NHL_USE_MOCK=true`
et `DORMANT=true` corrigés le 2026-08-29, `SENTRY_DSN` posée sur les deux
services (B7 ci-dessous). Le miroir des variables est complet — aucune variable
de production absente des `.env.example`, et les 46 non posées sont toutes des
réglages optionnels à défaut codé. `SENTRY_TRACES_SAMPLE_RATE` reste
**volontairement** absente : si le quota Sentry saute un jour, c'est que
quelqu'un l'a posée à la main et ne l'a pas retirée.

> ⚠️ **La leçon du mock, à garder même l'interrupteur refermé.** Le job de
> règlement lit ses résultats par `nhlApiClient`, donc par les mocks quand ils
> sont actifs : tant que `NHL_USE_MOCK` est à `true`, **il ne peut rien régler
> du tout**, même en pleine saison. Les paris resteraient « pending » pour
> toujours, **sans une seule erreur dans les logs**. Aucun règlement erroné n'a
> eu lieu — les six matchs simulés n'étaient jamais `final` — mais le risque
> évité était le moindre des deux.

> ⚠️ **Et la méthode, qui vaut pour tout ce document.** Ce relevé vient de la
> bannière `[Server] Réglages effectifs` imprimée **au démarrage du conteneur**,
> pas des variables lues une à une dans le dashboard : c'est la seule source qui
> dise ce que le processus *fait*. Corollaire : **une mesure porte une date, pas
> un état.** Un déploiement suivant peut défaire en silence ce qu'un contrôle a
> établi la veille — c'est exactement ce qui est arrivé à `DORMANT` (§2, A1bis).

**B6 — six lignes sur sept sont closes.** Railway (alerte 10 $, **hard limit
25 $**, posés au niveau du workspace donc valables pour les deux services) ·
Neon (notification à 6 $ — **aucun plafond dur chez Neon**, cf. `MONITORING.md`)
· GitHub, le provider LLM (5 budgets de compte à 0 $ avec « Stop usage », dont
« All AI Credit SKUs ») · The Odds API (clos **par le code** : `oddsQuota.ts` lit
`x-requests-remaining` et `ODDS_QUOTA_WARN=100` est posée — rien à faire en
console) · Sentry (sans objet : aucun moyen de paiement enregistré, le
dépassement est structurellement impossible) · Stripe (alerte « Échecs des
webhooks » cochée ; Stripe n'offre **pas** de seuil configurable à 1 %, cette
case *est* le mécanisme). **Reste R2**, ci-dessous.

### R2 refait sur le compte accessible — 2026-08-29, et ce que ça a révélé

L'ancien compte Cloudflare était rattaché à `arakice.support@gmail.com`, **bloqué
par Google et définitivement hors d'accès**. Tout a donc été reconstruit sur
`Ireinahedad@icloud.com's Account` (`bf7c6f89fb06ac6abd19927f43a95c30`).

**Fait :** abonnement R2 activé (palier gratuit : 10 Go, 1 M d'opérations classe A,
10 M classe B) ; bucket **`arakice-avatars`** créé — même nom que l'ancien, donc
`R2_BUCKET` ne bouge pas — en **Western North America (WNAM)**, classe Standard,
**sans juridiction**. Ces deux derniers points sont délibérés : WNAM parce que le
défaut proposé était *Asia Pacific* (choisi d'après la position de l'utilisateur,
pas celle de l'infrastructure) alors que Railway est en **US West** et Neon en
**AWS US East 1** ; et pas de juridiction parce que `avatarStorage.ts` prévient
qu'un bucket sous juridiction n'est **pas** joignable sur l'endpoint standard.
Alerte de budget posée à **1 $** (« R2 - sortie du palier gratuit »), faute de
mieux : l'alerte Cloudflare est **en dollars**, elle ne peut pas exprimer le
« 5 Go sur 10 » de `MONITORING.md` puisque 5 Go coûtent 0 $. Le seuil à 1 $ sonne
donc dès que le stockage cesse d'être gratuit, pas à mi-parcours du palier.
*(Création enregistrée mais non re-vérifiée dans la liste des notifications : la
console est devenue non réactive juste après.)*

> ⚠️ **L'URL de développement publique a été activée par erreur** —
> `https://pub-92ed72f782ab420fa7a71bade56eddca.r2.dev`. Un clic destiné à
> « Cancel » a atterri sur « Allow ». Sans conséquence (le bucket est vide) mais
> **à désactiver** une fois le domaine définitif en place, pour ne garder qu'une
> seule URL canonique.

**🔴 Le domaine `cdn.arakice.com` n'a PAS pu être connecté, et la raison est bien
plus grave que R2.** Cloudflare a refusé avec « The specified zone id is not
valid ». La zone `arakice.com` de ce compte est en état **pending** :

| | Serveurs de noms |
|---|---|
| **Chez le registrar aujourd'hui** | `gerardo.ns.cloudflare.com`, `serenity.ns.cloudflare.com` |
| **Attendus par le nouveau compte** | `love.ns.cloudflare.com`, `piers.ns.cloudflare.com` |

Les deux paires sont des serveurs Cloudflare — mais la première appartient à
**l'ancien compte, celui qui est perdu**. Autrement dit : **tout le DNS
d'`arakice.com` est actuellement servi par un compte auquel personne n'a plus
accès**, `api.arakice.com` et l'apex Vercel compris. Ça marche tant que rien n'y
touche ; le jour où ce compte est supprimé ou la zone retirée, **le site entier
devient injoignable**, et il n'y aura aucun moyen d'agir dessus.

**Le piège de la bascule, à ne surtout pas manquer.** Les 13 enregistrements ont
bien été importés dans la nouvelle zone (apex, `www`, `api`, en A et AAAA, plus le
TXT de vérification Google), **mais leurs adresses sont fausses** :
`104.21.56.11`, `172.67.175.172`, `2606:4700:3035::…` sont des **IP anycast de
Cloudflare**, pas les vraies origines. C'est ce que produit un scan de zone sur un
domaine *déjà* derrière Cloudflare : il relève les IP du proxy de l'ancien compte.
Basculer les serveurs de noms en l'état enverrait le nouveau proxy vers l'ancien —
boucle ou site hors ligne. **Les enregistrements doivent être corrigés AVANT la
bascule**, vers ce que dit `DEPLOYMENT.md` §4 : apex en A/ALIAS vers **Vercel**
(l'apex ne peut pas être un CNAME), `www` en redirection, `api` vers **Railway**.
Les valeurs exactes se lisent dans la console Vercel (Settings → Domains) et dans
Railway (domaine du service `IceEdge`).

**Ordre à respecter, parce qu'il n'est pas rattrapable dans le désordre :**
1. relever les vraies origines chez Vercel et Railway ;
2. corriger les 13 enregistrements dans la zone du **nouveau** compte ;
3. changer les serveurs de noms **chez le registrar** vers `love`/`piers` ;
4. attendre que la zone passe **Active** ;
5. seulement alors, connecter `cdn.arakice.com` au bucket et désactiver l'URL r2.dev.

**En attendant**, l'URL r2.dev fonctionne et débloque R2 : c'est elle qui va dans
`R2_PUBLIC_URL`. Elle est limitée en débit et déconseillée en production par
Cloudflare — donc provisoire, mais pas pire que l'ancienne configuration, qui
était exactement du même type.

**Les quatre variables Railway à changer sur le service `IceEdge`** (`R2_BUCKET`
reste `arakice-avatars`) : `R2_ACCOUNT_ID` → `bf7c6f89fb06ac6abd19927f43a95c30`,
`R2_PUBLIC_URL` → l'URL r2.dev ci-dessus (puis `https://cdn.arakice.com` après la
migration DNS), et `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` → issus d'un jeton
d'API R2 **à générer et à coller à la main** (des identifiants ne se saisissent
pas à ta place).

**Les avatars existants ne sont pas migrables.** `user_profiles.avatar_url` stocke
l'URL absolue : les anciennes continueront de s'afficher tant que l'ancien compte
sert son domaine public, et deviendront des orphelins non supprimables dès que
`R2_PUBLIC_URL` change (`deleteAvatarByUrl` compare au préfixe courant et sortira
sans rien faire). Rien ne casse, mais rien ne se récupère non plus.

⚠️ **Le webhook Stripe pointe sur le domaine Railway, pas sur `api.arakice.com`.**
La destination est `https://arakice-production-6005.u…way.app/api/subscription/webhook`
(Actif, 6 événements, 0 % d'erreur). Ça marche tant que ce sous-domaine généré
existe ; s'il disparaît — service recréé, domaine retiré — le webhook casse **en
silence**, et c'est la seule ligne du tableau qui protège une recette et non une
dépense. À basculer sur le domaine canonique, en pensant à ce que
`STRIPE_WEBHOOK_SECRET` suit la destination. **Mais pas avant que le fork DNS
soit tranché** : `api.arakice.com` est servi par le compte perdu, ce serait
échanger une panne muette contre une autre.

✅ **`[avatarStorage] R2 actif` ne prouvait rien — réglé le 2026-08-30.** Ce
contrôle ne faisait **aucun appel réseau** : il vérifiait la présence des cinq
variables, et le repli sur le stockage base64 est « volontairement silencieux à
l'exécution ». Des identifiants pointant sur un compte mort donnaient la même
ligne verte. Un `HeadBucket` au démarrage (`verifyAvatarStorage()`, appelée sans
`await` depuis `server.ts`) tranche désormais, avec trois issues distinctes dans
les logs. Il prouve la lecture, **pas le droit d'écrire** : un jeton en lecture
seule passerait et échouerait au premier `PutObject`.

⚠️ **Railway et GitHub s'inversent à la première vente.** Aujourd'hui une coupure
vaut mieux qu'une facture non bornée. Le jour où des abonnés paient, le hard limit
Railway met hors ligne des gens qui ont payé — et le budget GitHub à 0 $ **bloque**
les appels LLM des abonnés Pro au lieu de les facturer. Le repli existe
(`llm.routes.ts` renvoie l'utilisateur sur sa propre clé OpenAI) mais suppose
qu'il en ait renseigné une, ce que peu feront. Même déclencheur que Vercel Pro.

⚠️ **L'essai Sentry expire vers le 12 septembre 2026.** Le compte est en *Business
Plan Trial*, volume inclus **1 000 000 d'erreurs**. À l'échéance il retombe sur le
plan choisi — ou sur rien. À trancher avant cette date, sinon elle tranche seule.

⚠️ **`pg` : les modes SSL `prefer`, `require` et `verify-ca` sont aujourd'hui des
alias de `verify-full`** et changeront de sens en `pg` v9 / `pg-connection-string`
v3. Un avertissement le dit dans les logs. À traiter avant cette montée de
version, pas avant.

⚠️ **Ne pas suivre la suggestion du panneau *Agent* de Railway**
(`ML_SERVICE_URL=${{ …RAILWAY_PUBLIC_DOMAIN }}`) : ça exposerait publiquement le
service ML, l'exact inverse du §3 de `DEPLOYMENT.md`.

### Étape 1 de la bascule — faite le 2026-08-31

Ce que le § précédent laissait « faisable tout de suite, dans les deux branches »
est fait : origines relevées chez Vercel et Railway, zone du nouveau compte lue
enregistrement par enregistrement, résolution mesurée depuis l'extérieur.
**Rien n'a été modifié** — ni chez Vercel, ni chez Railway, ni dans la zone.

**Le diagnostic du 2026-08-29 est confirmé, et il est plus large qu'écrit.**

| Mesure | Résultat |
|---|---|
| Résolution de `arakice.com`, `www.arakice.com` **et `api.arakice.com`** | les trois rendent les **mêmes** `104.21.56.11` / `172.67.175.172` et `2606:4700:3035::6815:380b` / `::ac43:afac` |
| Vercel → projet `ice-edge` → Domains | `arakice.com` et `www.arakice.com` marqués **« Proxy Detected »** |
| Railway → `IceEdge` → Networking | `api.arakice.com` marqué **« Cloudflare proxy detected »** |
| Serveurs de noms qui font autorité | `gerardo` / `serenity.ns.cloudflare.com` — l'ancien compte |

Le document ne déduisait le point que pour l'apex. Les **trois** noms sont
concernés, et les deux hébergeurs le disent chacun de son côté : le proxy du
compte perdu est devant la **totalité** du produit, front et API. Confirmé aussi
par les en-têtes `cf-connecting-ip` / `cf-ray` reçus par le serveur Railway.

**Les 13 enregistrements de la zone en attente, relevés tels quels.** Les douze
premiers portent les IP anycast de l'ancien proxy et sont **tous « Proxied »** :

| Nom | Type | Contenu | Proxy |
|---|---|---|---|
| `arakice.com` | A ×2 | `104.21.56.11` · `172.67.175.172` | Proxied |
| `www.arakice.com` | A ×2 | `104.21.56.11` · `172.67.175.172` | Proxied |
| `api.arakice.com` | A ×2 | `104.21.56.11` · `172.67.175.172` | Proxied |
| `arakice.com` | AAAA ×2 | `2606:4700:3035::6815:380b` · `::ac43:afac` | Proxied |
| `www.arakice.com` | AAAA ×2 | idem | Proxied |
| `api.arakice.com` | AAAA ×2 | idem | Proxied |
| `arakice.com` | TXT | `google-site-verification=xWIbjFinrXaZ…` | DNS only |

**Ce qu'il faut poser à la place — et pourquoi ce ne sont pas des A.**

| Nom | Type | Contenu | Proxy |
|---|---|---|---|
| `arakice.com` | CNAME | `cname.vercel-dns.com` | **DNS only** |
| `www.arakice.com` | CNAME | `cname.vercel-dns.com` | **DNS only** |
| `api.arakice.com` | CNAME | **cible Railway — seule valeur encore inconnue, voir plus bas** | **DNS only** |
| `arakice.com` | TXT | inchangé | DNS only |

Les **12 A/AAAA sont à supprimer**, pas à corriger : trois CNAME remplacent six
noms d'enregistrement. Trois raisons, par ordre d'importance :

1. **Vercel ne publie pas d'IP stable.** Mesuré le 2026-08-31 :
   `cname.vercel-dns.com` rend `66.33.60.129` / `76.76.21.22`, alors que le
   déploiement du projet (`ice-edge-hazel.vercel.app`) rend `216.198.79.67` /
   `64.29.17.67`, et que la documentation cite encore `76.76.21.21`. Trois
   générations de valeurs coexistent. Figer une IP dans la zone, c'est refaire
   l'erreur qu'on est en train de réparer, avec une valeur juste au lieu d'une
   fausse. Un CNAME suit Vercel tout seul.
2. **Cloudflare aplatit les CNAME à l'apex** (*CNAME flattening*, actif d'office
   à la racine). L'objection « l'apex ne peut pas être un CNAME » de
   `DEPLOYMENT.md` §4 vise les hébergeurs DNS qui ne savent pas le faire ; elle
   ne s'applique pas ici. **L'hôte canonique reste l'apex sans `www`** — rien à
   changer côté code, et `www` garde sa redirection 308, déjà configurée chez
   Vercel.
3. **Aucun AAAA à écrire à la main** : la résolution suit le CNAME.

⚠️ **Proxy sur « DNS only », et ce n'est pas un réglage de confort.** Vercel
écrit qu'un proxy devant lui empêche ses protections DDoS et anti-bots de
fonctionner ; Railway lève le même drapeau. Remettre Cloudflare devant Railway
reste au programme (« reportés au lancement officiel », plus haut) — mais
**après** la bascule, sciemment, et avec le mode SSL en *Full (strict)*.
Basculer proxy allumé, ce serait recréer d'un coup l'état opaque dont on sort.

🔴 **La seule valeur qui manque : la cible CNAME de `api.arakice.com` chez
Railway.** Railway ne l'affiche **que** tant que l'enregistrement ne résout pas
déjà vers lui ; aujourd'hui l'écran montre « Cloudflare proxy detected » à la
place. À lire dans Railway → `IceEdge` → Settings → Networking **au moment de
l'étape 2**, avant d'écrire le CNAME. **Ne pas la deviner** : le domaine généré
du service, `arakice-production-6005.up.railway.app` (→ `69.46.46.43`), est une
valeur *plausible et non vérifiée* — et c'est exactement ce genre de valeur
plausible qui a rempli cette zone d'IP anycast.

**Trois risques cherchés et écartés — ils n'auront pas à l'être deux fois.**
L'ancienne zone, qui fait autorité aujourd'hui, a été interrogée directement :

- **aucun MX, aucun SPF, aucun DKIM, aucun DMARC.** Le domaine ne reçoit ni
  n'envoie de courrier : la bascule ne peut pas casser d'e-mail en silence, ce
  qui est le premier accident classique d'un changement de serveurs de noms ;
- **aucun CAA.** Rien n'empêchera Vercel, Railway ou Let's Encrypt d'émettre
  leurs certificats après la bascule ;
- **aucun autre sous-domaine** (`cdn`, `mail`, `ml`, `staging`, `blog`, `app`
  testés : NXDOMAIN). Les 13 enregistrements importés sont donc **la zone
  entière**, pas un échantillon — et `cdn.arakice.com` n'existe nulle part, il
  sera créé de zéro à l'étape 5.

⚠️ **Un fil à ne pas laisser pendre : le TXT `google-site-verification`.** Il
prouve la propriété du domaine auprès d'un compte Google — vraisemblablement
celui qui est perdu. **Le garder tel quel** (le supprimer ne rendrait rien),
mais en tirer la question : si la propriété Search Console est rattachée à ce
compte, alors le sitemap, la couverture d'indexation et les rapports des ~900
pages générées sont derrière la même porte fermée. À vérifier depuis un compte
Google accessible **avant** de conclure que le compte perdu ne coûte que le DNS
et les avatars.

### Ce que les logs du conteneur en cours disent — relevé du 2026-08-31

Bannière de démarrage du conteneur **actif** (déploiement `7da21c2c`, commit
`674b199`, démarré le 2026-08-30 15:43 GMT+8), relue en entier — la méthode
imposée plus haut : ce que le processus *fait*, pas ce que le dashboard *dit*.

**Vert, et vérifié :** `NHL_USE_MOCK: false` · `ML_DISABLED: false` ·
`[Sentry] ✅ armé — tracesSampleRate=0.01` · `[OddsLogger] calendrier armé —
slots: 6, creditsPerDay: 10` · `[OddsLogger] ✅ odds_snapshots présente` ·
`[avatarStorage] ✅ R2 joignable — HeadBucket OK`. Les deux interrupteurs qui
avaient déjà défait un contrôle en silence — `NHL_USE_MOCK` et `DORMANT` — sont
toujours du bon côté.

✅ **`ODDS_API_KEY` : refusée le matin, acceptée dans la foulée — clos le
2026-08-31.** Le conteneur `7da21c2c` imprimait `[OddsLogger] ⚠️ ODDS_API_KEY
REFUSÉE — clé révoquée, expirée, ou absente de ce compte. La collecte de cotes
et le proxy /api/odds sont hors service.`, status 401, au démarrage **et à
chaque créneau** (23:00, 05:00, 06:45, 07:45).

**La cause n'était pas dans le code.** Le service `IceEdge` portait une
modification de `ODDS_API_KEY` **saisie mais jamais déployée** : le bandeau
« Apply 1 change / Deploy » était resté ouvert, et le processus tournait avec
l'ancienne valeur. Le §6 affirmait que « `server/.env` comme Railway portent la
nouvelle » — c'était vrai du champ de saisie, faux du processus.

- [x] Modification déployée le 2026-08-31. **Conteneur `20f5b0ce`, démarré à
      09:50 GMT+8 : `[OddsLogger] ✅ ODDS_API_KEY acceptée par The Odds API`**,
      le reste de la bannière identique et vert. Déployer ne concluait pas ;
      c'est cette ligne qui conclut, et elle est là.

**Ce que la panne a coûté : rien.** Entre le 2026-08-30 15:43 et le 2026-08-31
09:50, aucune cote n'a été archivée — mais on est hors saison, il n'y avait rien
à archiver. **Le même incident en octobre aurait creusé un trou de dix-huit
heures dans `odds_snapshots`**, sans une erreur ailleurs que dans cette ligne et
sans qu'aucune alerte ne se déclenche.

> ⚠️ **La leçon, et c'est la quatrième fois.** Après `NHL_USE_MOCK`, `DORMANT`
> et `[avatarStorage] R2 actif` : **une valeur saisie n'est pas une valeur en
> service.** Railway met les modifications de variables en attente derrière un
> bouton ; tant qu'il n'est pas pressé, le dashboard montre la nouvelle valeur
> et le processus utilise l'ancienne. Un écran vert de plus qui ne prouve rien.

🔴 **Le même relevé a trouvé autre chose : la production écrit dans l'ANCIEN
R2.** La sonde imprime son endpoint et son URL publique, et ce ne sont pas ceux
du bucket refait le 2026-08-29 : l'endpoint porte l'identifiant de compte
`2216e2d9…`, pas `bf7c6f89…`, et l'URL publique est `pub-9cbc747d…r2.dev`, pas
le `pub-92ed72f7…` cité plus haut. Les quatre variables R2 n'ont donc jamais été
changées — c'est cohérent, elles sont gelées — mais il faut en tirer les deux
conséquences :

1. **`HeadBucket ✅` prouve que l'ancien bucket répond encore, pas que le nouveau
   est branché.** La sonde a été écrite pour distinguer « configuré » de
   « joignable » ; elle ne distingue pas « joignable » de « le bon ».
2. **Chaque avatar téléversé d'ici la bascule atterrit dans l'ancien compte**, où
   il deviendra un orphelin non supprimable dès que `R2_PUBLIC_URL` changera.

**Décision du 2026-08-31 : on garde l'ancien R2 en service**, jusqu'à ce que la
perte d'accès au compte d'origine soit **confirmée** et non seulement supposée.
Trois choses à savoir pour que ce choix reste tenable :

- **Il tient techniquement.** Le jeton d'API R2 ne passe pas par la connexion
  Google : il continuera de fonctionner tant que personne ne le révoque et que
  le compte n'est pas supprimé. `HeadBucket ✅` le vérifie à chaque démarrage —
  c'est la meilleure sonde de survie qu'on ait sur ce compte, autant la lire
  comme telle.
- **Ce qu'on ne peut plus faire dessus, en revanche :** révoquer ou faire tourner
  ce jeton, changer une politique du bucket, lire la facturation, réagir à un
  dépassement de palier. **L'alerte de budget à 1 $ posée le 2026-08-29 est sur
  le NOUVEAU compte** : elle ne surveille pas ce bucket-ci. Le seul poste du
  tableau B6 encore ouvert l'est donc doublement.
- **Le compteur d'orphelins tourne pendant ce temps.** Ce n'est pas une raison
  de basculer tout de suite ; c'en est une de ne pas laisser la confirmation
  traîner.

⚠️ **Une échéance de plus, notée au passage** (même famille que l'avertissement
`pg` ci-dessus) : le conteneur tourne sur **node v20.20.2**, et le SDK AWS v3 —
celui qui parle à R2 — **exigera node ≥ 22 pour ses versions publiées après
début janvier 2027**. Rien à faire maintenant ; tout à faire avant cette date.

### B7 — clos le 2026-08-29 : Sentry est armé des deux côtés

`SENTRY_DSN` est posée sur les **deux** services Railway. Organisation `arakice`,
deux projets distincts — `node-express` et `python-fastapi` — parce que les
erreurs XGBoost et les erreurs Express n'ont ni la même cadence ni les mêmes
destinataires, et qu'un second projet ne coûte rien (le quota se compte par
organisation). **Vérifié en production, pas seulement posé** :
`[ML] ✅ Sentry armé — environment=production, traces_sample_rate=0.01` lu dans
les logs de démarrage du conteneur `courageous-analysis`.

Les deux sondes (`ml_service.py`, `instrument.ts`) impriment maintenant leur état
— armé / inactif / non armé — au lieu de se taire, et sont protégées par un
`try/catch` : sans lui, poser la variable sur une image où le paquet manquerait
aurait **empêché le service de démarrer**, c'est-à-dire que le monitoring aurait
tué ce qu'il surveille. Les quatre branches ont été exécutées, code de retour 0
dans les quatre cas.

> ⚠️ **Ne pas suivre l'assistant « Configure Express SDK » de Sentry.** Le SDK
> Node est déjà entièrement câblé : `@sentry/node` 8.55.2, `instrument.ts`
> importé en ligne 2 de `server.ts` (avant `app`), et
> `Sentry.setupExpressErrorHandler(app)` dans `app.ts` après les routes. Suivre
> l'assistant ajouterait **un second `Sentry.init()`** et écraserait le
> `tracesSampleRate` à 1 %, choisi avec le calcul du §3 de l'audit. De cet écran,
> seule la DSN est utile.

### B9 — clos le 2026-08-29 : plus aucun nombre inventé côté client

Toute la couche de repli local de `predictionApiService.ts` est supprimée — six
fonctions et deux tables de taux écrits en dur (`bos: 68, nyr: 61…`), plus les
trois derniers gisements trouvés au second passage : `generateForm()` qui
fabriquait une suite W/L/OT au `Math.random()` sous le titre « Forme récente »,
les `?? 50` de `useNHLData`, et la probabilité de repli de `NHLPredictionsPage`.
Le service lève désormais un seul type d'erreur, `PredictionUnavailableError`,
qui porte sa cause (`not_configured`, `network`, `http`, `bad_response`).

**Ce qu'il faut en retenir pour la suite :** en panne, l'écran affiche « — » et
un bandeau d'indisponibilité, et `MarketSelectorSheet` **refuse d'ajouter la
jambe** — une jambe porte sa probabilité jusqu'au règlement, un chiffre inventé y
survivrait à la panne qui l'a produit. Donc **voir un chiffre suffit désormais à
conclure qu'il vient du modèle** : c'est ce qui rend le runbook I1 de
`QA_TEST_PLAN.md` aussi court.

> **La règle, écrite en tête de `predictionApiService.ts` pour qu'elle survive :**
> pas de repli local, jamais. Un nombre faux qui a l'air juste est pire que pas de
> nombre — et une cote fabriquée à partir d'une probabilité l'est doublement,
> parce que rien à l'écran ne la distingue d'un prix de bookmaker.

> ⚠️ **Le piège de vérification, à ne pas refaire.** Il a d'abord été écrit ici
> que le typecheck rendait « 0 erreur ». C'était un artefact : le `tsconfig`
> d'essai portait un `baseUrl`, que TypeScript 5.6 refuse avec l'erreur de
> configuration **TS5101** — et `tsc` s'arrête là, **sans rien vérifier**. Une
> sortie vide ne voulait pas dire « aucune erreur » mais « aucune vérification ».
> Depuis, un typecheck se prouve actif en y insérant une faute volontaire avant
> de conclure.

**Reportés au lancement officiel, sciemment** — pas des oublis :

- **Vercel Pro** (~20 $/mo). Le plan Hobby interdit l'usage commercial. Le risque
  commence **à la première vente**, pas au premier utilisateur.
- **Cloudflare devant Railway.** Les en-têtes de cache sont posés ; c'est ce qui
  manque pour qu'un CDN serve à quelque chose. Réduit aussi l'egress facturé.

---

## 2. ML — où reprendre

**Une seule décision est en attente, et elle commande tout le reste : payer ou
non un mois de The Odds API.** Le calcul est plus bas, avec les arguments des
deux côtés.

### L'état en une table

| Poste | État |
|---|---|
| **A5** — élaguer les features du modèle de score | ✅ **Clos.** Non tranchable avec 14 saisons. Conclusion en tête de `train_score.py`. **Ne pas recommencer.** |
| **A3** — outillage CLV | ✅ **Livré.** Mode `--clv` avec placebo, dissection et « ROI clôture ». Table `odds_snapshots` (migration 031). |
| **A3** — mesure moneyline et totaux | ✅ **Faite le 2026-08-23.** Résultats ci-dessous. |
| **A3** — mesure puck line | ⛔ **Impossible sur l'historique** : SBRO ne donne qu'un prix de puck line par match, pas de paire ouverture/clôture. |
| **A1bis** — collecte live gratuite | ✅ **En service, revérifié le 2026-08-31.** Panne de 18 h les 30-31 août (`ODDS_API_KEY` refusée, 401) refermée par le déploiement de la clé ; hors saison, rien de perdu. Reste **un seul contrôle**, à la pré-saison. |
| **S4** — servir le moneyline depuis le modèle de score | 🔸 **Livré et déployé**, sauf ⑤ (suppression du classifieur) et le correctif de calibration γ, tous deux reportés sciemment. |
| **A1** — backfill payant | ⏸️ **En attente de ta décision.** Le code est prêt et borné. |
| **A2** — règle puck line | ⏸️ Figée et falsifiable, non évaluable avant A1 ou une saison de collecte live. |
| **A4** — fenêtre de confirmation du gardien | ⏸️ Demande des snapshots serrés autour du coup d'envoi. |
| **A6** — team totals, prolongation, écarts ±2.5 | ⏸️ Après A1 et A2. |

---

### Ce que la mesure du 2026-08-23 a établi

Neuf saisons, 19 644 paris moneyline et 19 638 paris totaux aux **prix
d'ouverture**, chacun comparé à ce que la clôture en disait.

| edge ≥ | paris | ROI réalisé | ROI selon la clôture | écart | CLV net du placebo |
|---|---|---|---|---|---|
| 1 % | 8 103 | −1,13 % | −1,78 % | +0,52 σ | +0,0083 |
| 2 % | 6 475 | −0,93 % | −1,30 % | +0,25 σ | +0,0101 |
| 3 % | 4 988 | +2,11 % | −0,85 % | +1,76 σ | +0,0115 |
| **4 %** | 3 751 | **+4,30 %** | **−0,25 %** | +2,28 σ | **+0,0133** |
| 5 % | 2 760 | +4,30 % | **+0,44 %** | +1,61 σ | +0,0151 |

**Trois conclusions.** ① **Le CLV moneyline est réel** — le placebo (modèle
permuté, même sélection, même effectif) ne décroche que +0,0002. ② **Mais il
suffit tout juste à annuler la marge, pas à gagner** : la colonne « ROI selon la
clôture » monte de −1,78 % à +0,44 %, c'est-à-dire que le modèle trouve des
ouvertures que la clôture juge **à peu près équitables après la marge de
4,43 %**. On ne bat pas la clôture ; **on bat l'ouverture d'environ une marge.**
③ **Le +4,30 % réalisé est probablement de la chance** — 1,6 à 2,3 σ au-dessus
de ce que la clôture justifie, ROI par tercile d'edge à 1,60 / 0,36 / **10,93 %**
(l'edge ne trie pas le rendement), taux de réussite de 45,7 % seulement, et
retirer 44 paris sur 3 751 annule le résultat.

> **Les totaux sont morts pour de bon.** CLV net **inférieur à leur propre
> placebo** à tous les seuils (+0,0020 contre +0,0030) : c'était entièrement de
> la régression vers la moyenne. La clôture leur donne −3,2 % constant.

---

### La décision : payer 59 $ un mois, ou non

**L'argument, en un calcul** — le bloc que le mode imprime lui-même :

```
écart-type du rendement par pari : 1,1542
écart-type du CLV par pari       : 0,0317
paris pour détecter 2 % de ROI   : ~13 321
paris pour détecter 0,5 % de CLV : ~160        → rapport 83×
```

Le CLV converge **83 fois plus vite** que le ROI. Mais **le CLV de la puck line
n'est pas mesurable sur les données actuelles**, faute de paire
ouverture/clôture chez SBRO. Le levier existe et on ne peut pas l'appliquer là
où il servirait. Or la règle A2 produit **463 paris sur 9 saisons, ~51 par
saison** sur la jambe −1.5. D'où l'arithmétique qui décide :

| Chemin | Paris disponibles | Verdict CLV possible en |
|---|---|---|
| **Backfill payant** (2023-24 → 2025-26) | ~154 | **une semaine** |
| Collecte live seule (démarre en octobre) | ~51/an | **~2029** |

**Un mois à 59 $ achète précisément l'échantillon qui rend A2 décidable** — ~154
paris contre les ~160 nécessaires — maintenant au lieu de 2029. C'est la seule
chose que cet argent achète et qu'on ne peut pas obtenir autrement : l'archive
SBRO est close, le site injoignable, et l'endpoint historique n'est pas servi
aux clés gratuites.

**Ce que le mois donne aussi, sans coût supplémentaire :** ~3 900 matchs
vraiment hors échantillon (2023-24 → 2025-26) — il n'existe aujourd'hui
**aucune** donnée que le modèle n'ait pas vue, SBRO s'arrête au 2022-11-27 ;
+30 % de volume sur A2 en ROI ; **A4 devient mesurable** ; et un jeu de données
qui **reste sur ton disque après résiliation**. **Il débloque aussi le blend
marché**, aujourd'hui impossible à ajuster (voir l'encadré en fin de §2).

**Les arguments contre, et ils sont sérieux :**

- **Le résultat moneyline ci-dessus est un avant-goût du verdict probable.** Si
  la puck line se comporte pareil, le mois achète un **résultat négatif** —
  utile pour arrêter de chercher, pas pour gagner de l'argent.
- **Les ~160 paris sont une estimation empruntée au moneyline.** L'écart-type du
  CLV de la puck line est inconnu et pourrait être plus grand.
- **La collecte live est gratuite** et démarre dans cinq semaines. L'attente
  coûte du temps, pas de l'argent. Rien n'est urgent : on ne perd pas de données
  en août, la NHL est inactive.

**Ce qui n'est PAS un argument pour payer** : espérer que les saisons neuves
fassent réapparaître le +4,30 %. S'il revient, ce sera une surprise.

> **En une phrase :** 59 $ compriment une attente de trois ans en une semaine,
> sur la seule piste encore vivante du projet — et le résultat le plus probable
> est un « non » propre plutôt qu'un « oui ».

### Le chiffrage, exécuté le 2026-08-30 — et il change la marge

Le mode `--odds-api-dry-run` a été **joué** (aucun crédit, aucune clé) :
`1004 jours × ~4 appels × 30 crédits = ~120 480 crédits` en borne haute, et un
forfait de `186 jours/saison → 66 960`. **Aucun des deux n'est le bon chiffre** :
la borne haute facture 4 appels les jours sans match, le forfait n'en facture
aucun — alors que le code envoie **une reconnaissance à 15:30Z tous les jours**,
match ou pas, soit 30 crédits.

Le vrai compte se lit dans `ml/data/games_spine.csv`, qui vient d'`api.nhle.com`
(gratuit, à jour, 1 312 matchs par saison = les 32×82/2 de la saison régulière) :

| | jours | dont avec match | crédits |
|---|---|---|---|
| Fenêtre documentée `2023-10-01 → 2026-06-30` | 1 004 | **528** (+ 476 vides) | **77 640** |

**Mais 77 640 est encore trop bas, et c'est le point.** `games_spine.csv` ne
contient **que la saison régulière** (`game_id` en `…02`) : les ~40 à 60 jours
de séries d'avril-juin n'y sont pas, alors que l'API, elle, les facturera au
tarif d'un jour de match. Chaque jour qui passe de vide à jour de match coûte
+90 crédits :

| séries retenues | crédits | part des 100 000 qu'achètent 59 $ |
|---|---|---|
| 40 j/saison | 88 440 | **88 %** |
| 50 j/saison | 91 140 | **91 %** |
| 60 j/saison | 93 840 | **94 %** |

La marge réelle est donc de **6 à 12 %**, pas les 33 % que suggérait le forfait.
Et les crédits des séries n'achètent **rien d'utilisable** : le jeu de données
est en saison régulière, `build_dataset.py` ne peut pas joindre une cote de
série.

**Le correctif tient en une ligne : trois plages au lieu d'une.** En calant
chaque plage sur `1er octobre → 30 avril`, on récupère **exactement les mêmes
3 936 matchs** — le chiffre que ce § annonçait déjà — pour :

| Plage | jours | avec match | matchs | crédits |
|---|---|---|---|---|
| 2023-10-01 → 2024-04-30 | 213 | 183 | 1 312 | 22 860 |
| 2024-10-01 → 2025-04-30 | 212 | 178 | 1 312 | 22 380 |
| 2025-10-01 → 2026-04-30 | 212 | 167 | 1 312 | 21 390 |
| **Total** | | | **3 936** | **66 630 — 67 % du budget, marge 33 370** |

Soit **~22 000 à 27 000 crédits économisés** pour un jeu de données identique.
La commande du bloc ci-dessous a été corrigée en conséquence.

> ⚠️ **Le « ~4 appels par jour » reste une hypothèse, pas une mesure.** Il vient
> du docstring de `fetch_odds_api` (une reconnaissance + une par heure de début
> distincte) ; `games_spine.csv` n'a pas d'heure de coup d'envoi, donc rien ici
> ne le vérifie. À surveiller sur **2025-26 en particulier** : 1 312 matchs en
> **167 jours** au lieu de 178-183 (calendrier comprimé, probablement la coupure
> olympique de février 2026), donc plus de matchs par soirée et sans doute plus
> d'heures de début distinctes. La marge de 33 370 de la variante à trois plages
> absorbe cet écart ; celle de la fenêtre en une seule passe, non. **C'est une
> raison de plus de poser `--odds-api-budget`**, qui reste le seul plafond dur.

**Ce que ce chiffrage ne tranche pas :** il ne dit pas s'il faut payer. Il dit
seulement que si tu paies, la fenêtre documentée gaspillait un quart du budget.
La décision reste celle du § précédent, et elle reste la tienne.

---

### Reprendre : les commandes

Tout ce qui suit tourne sur ta machine (xgboost et `node_modules` sont
Windows-only pour ce dépôt).

```bash
cd ml/python

# Gratuit — chiffre le backfill sans dépenser ni clé.
# ⚠️ Ne donne qu'une borne haute et un forfait : les deux sont faux. Le vrai
#    chiffre est dans le § ci-dessus (66 630 crédits en trois plages).
python fetch_data_v4.py --only odds --odds-api-dry-run \
    --odds-api-from 2023-10-01 --odds-api-to 2026-06-30

# Si tu paies — dans l'ordre, et JAMAIS sans --from-local ni --only odds
#   1. la clé, pour cette fenêtre seulement (cmd.exe) :
#      for /f "tokens=1,* delims==" %a in ('findstr /b "ODDS_API_KEY=" ..\..\server\.env') do set ODDS_API_KEY=%b
#   2. ~300 crédits : comparer SBRO et l'API sur une plage couverte par les deux
python fetch_data_v4.py --only odds --from-local --odds-api-budget 300 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2021-11-01 --odds-api-to 2021-11-10
#   3. le backfill, EN TROIS PLAGES (66 630 cr au lieu de ~91 000 : voir §
#      « Le chiffrage »). Une seule plage continue paierait les étés et les
#      séries, que le jeu de données ne peut pas utiliser.
python fetch_data_v4.py --only odds --from-local --odds-api-budget 23000 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2023-10-01 --odds-api-to 2024-04-30
python fetch_data_v4.py --only odds --from-local --odds-api-budget 23000 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2024-10-01 --odds-api-to 2025-04-30
python fetch_data_v4.py --only odds --from-local --odds-api-budget 23000 \
    --odds-api-regions eu --odds-api-book bet365 \
    --odds-api-from 2025-10-01 --odds-api-to 2026-04-30
#      (le plafond par plage est volontairement au-dessus de l'estimation :
#       il borne la casse, il ne doit pas couper une plage correcte en deux)
#   4. python build_dataset.py, puis --clv et --derived sur des saisons neuves
#   5. résilier
```

> ⚠️ **`odds.csv` est irremplaçable et réécrit à chaque exécution.** Détruit une
> fois le 2026-08-23 par une commande sans `--from-local` (SBRO échoue en
> réseau, 17 lignes du log live ont écrasé 10 591) ; récupéré depuis les pages
> HTML de `ml/data/raw/odds/`. Un garde-fou refuse désormais toute écriture qui
> ferait perdre plus de 10 % des lignes, et `odds.csv.backup-2026-08-23` est posé
> à côté. **Toujours `--only odds --from-local`.**

**Cohérence de source à ne pas casser :** le collecteur live utilise
`regions: eu` et préfère Bet365. Le backfill doit utiliser les mêmes
(`--odds-api-regions eu --odds-api-book bet365`), sinon on recrée le mélange de
sources que la comparaison est censée détecter. Le défaut du script est `us`.

---

### A1bis — en service, revérifié le 2026-08-31. Un seul contrôle reste.

> ⚠️ **Deuxième démenti de cette section — refermé le jour même.** Le
> 2026-08-31 au matin, le calendrier était bien armé (`slots: 6,
> creditsPerDay: 10`) et `odds_snapshots` bien présente, mais **`ODDS_API_KEY`
> était refusée en production** : 401 au démarrage et à chaque créneau depuis le
> 2026-08-30 15:43. Chaque passe repartait les mains vides — A1bis était
> *déployé* sans être *en service*. La cause n'était pas dans le code mais dans
> une variable Railway saisie et jamais déployée ; une fois déployée, le
> conteneur `20f5b0ce` rend `[OddsLogger] ✅ ODDS_API_KEY acceptée par The Odds
> API`. Détail et leçon au §1, « Ce que les logs du conteneur en cours disent ».
>
> **Ce qu'il faut en retenir pour la pré-saison :** la panne a duré dix-huit
> heures sans qu'aucune alerte ne se déclenche — seule la relecture de la
> bannière l'a montrée. Le contrôle du 22 septembre doit donc **commencer** par
> cette ligne, avant même de regarder `passes_today`.


> ⚠️ **Correction du 2026-08-29, quelques heures après le paragraphe ci-dessous.**
> Ce paragraphe affirmait la mise en service « terminée », bannière vue en prod à
> l'appui. C'était vrai à l'instant où la bannière a été lue — et faux ensuite :
> le déploiement suivant a démarré avec **`DORMANT=true`**, un drapeau qui coupe
> `startOddsLogger()` avant qu'il n'arme quoi que ce soit. Le collecteur a donc
> été **éteint sans que rien ne le dise**, et les deux tâches planifiées du
> 22 septembre et du 13 octobre auraient trouvé `passes_today = 0` — en renvoyant
> vers un bug de la migration 031 qui n'y était pour rien.
> **`DORMANT=false` a été posé et déployé le 2026-08-29**, et la bannière est
> revenue dans les logs du nouveau conteneur, avec la sonde de la 031 :
> `[OddsLogger] calendrier armé — slots: 6, creditsPerDay: 10` et
> `[OddsLogger] ✅ odds_snapshots présente`.
>
> **La leçon, et elle est différente de celle du bas de section.** Celle-ci disait :
> *la cible doit être visible dans la sortie*. Celle-là dit : **une mesure porte
> une date, pas un état.** Un contrôle passé ne prouve rien du déploiement
> suivant, et un drapeau d'environnement peut défaire en silence ce qu'un contrôle
> a établi la veille. Avant de se fier à cette section, relire
> `[Server] Réglages effectifs` et l'absence de la ligne `DORMANT=true` dans les
> logs du conteneur **en cours**.

**Mise en service terminée le 2026-08-29.** Les migrations (dont 028 et 031) sont
appliquées sur **Neon** et vérifiées par rejoue idempotente ; `npm test` et
`npm run typecheck` sont verts ; `ODDS_LOG_ENABLED=true`, `ODDS_USER_RESERVE=150`,
`ODDS_QUOTA_WARN=100` et `ENABLE_DEV_ROUTES=true` sont posées sur Railway ; la
bannière `[OddsLogger] calendrier armé — slots: 6, creditsPerDay: 10` et la sonde
`[OddsLogger] ✅ odds_snapshots présente` ont été vues en prod. Le calendrier coûte
**10 crédits/jour, 300/mois** — deux passes complètes (11 h, 17 h ET) et quatre
passes `spreads` (18 h 45, 19 h 45, 21 h 45, 22 h 45 ET), sous les 350 disponibles.

**Où lire la mesure :** `https://arakice.com/dev/ml`, onglet **« Données »**, carte
**« Série temporelle des cotes (odds_snapshots) »**. **Par le dashboard, jamais par
l'URL de l'API** — les routes exigent un `Authorization: Bearer` qu'un onglet de
navigateur n'envoie pas. Compte **admin** obligatoire. Hors saison, 0 partout est
le succès ; le seul échec est la carte en « table indisponible ».

- [ ] **À la pré-saison, le seul contrôle qui compte** — *deux tâches planifiées
      posées le 2026-08-28 : le 22 septembre (pré-saison) et le 13 octobre (filet,
      saison régulière). Ne pas compter dessus seul : elles demandent le bloc
      `data-health`, elles ne le lisent pas à ta place.* Revenir sur `data-health`
      en fin de journée de matchs : `passes_today` doit valoir **6** et
      `with_puckline` être > 0. Si `rows` reste à 0 alors que `odds_log.rows`
      monte, la 031 est en place mais les snapshots échouent — chercher
      `[OddsLogger] snapshot non archivé` dans les logs.
- [ ] `ODDS_LOG_RUN_AT_BOOT=true` — **sans objet avant octobre** : `logTodaysOdds`
      sort sur le garde-fou `isSeasonActive()` avant la moindre écriture. À garder
      en tête pour la reprise, pas maintenant.

> **La leçon de la mise en service, en une ligne, parce qu'elle se repaiera.**
> La question « la 031 est-elle sur Neon ? » a été posée trois fois à trois
> mauvaises adresses — `db:migrate:all` avec le `.env` (→ le Postgres local),
> `curl localhost:3001` (→ le local via le serveur de dév), `arakice.com/api/dev/…`
> (→ le front Vercel) — et chacune a répondu de façon plausible sans jamais
> toucher Neon. La leçon n'est pas « faire attention » : c'est que **la cible doit
> être visible dans la sortie**. D'où la ligne `[migrate] Cible : hôte/base ssl=…
> ← BASE LOCALE`, et d'où la carte du dashboard, qui ne peut interroger que la
> base de son propre backend. Même principe pour les sondes : **un contrôle muet
> en cas de succès ne se distingue pas d'un contrôle qui n'a pas tourné** — c'est
> pourquoi la sonde `odds_snapshots` imprime désormais sa réussite.
>
> **Deux pièges du même run, à ne pas réintroduire.** `npm run db:migrate:all`
> n'applique pas « 028 et 031 » mais **tout l'arriéré**, dont la 030 et son
> `UPDATE user_profiles SET show_slips = TRUE` de masse — sans danger tant que
> `PUBLIC_SLIPS_SINCE` n'est pas renseignée sur Railway, **à vérifier avant, pas
> après**. Et `USER_RESERVE` se lisait avec `??`, qui n'attrape que `undefined` :
> une variable vide donnait 0 (plus de réserve visiteurs) et une valeur non
> numérique donnait `NaN` (collecte qui ne démarre jamais, sans un message). La
> lecture est désormais validée avec repli sur 150 et `logger.warn`.

---

### A2 — puck line

La règle est figée : miser la jambe qui **donne** les 1.5 buts quand
`p_modèle − p_marché ≥ 0.04`, mise à plat, critère **ROI > 0** et non « ≈ 20 % ».
**Ne rien miser d'ici là** — « non réfuté » n'est pas « établi ».

**A2 n'est pas biaisé par la calibration** (vérifié le 2026-08-26) : la puck line
−1.5 est calibrée dans tous ses bins d'effectif suffisant (ECE 0,0071 contre
0,0200 pour le moneyline) et la règle opère entre 0,15 et 0,55, précisément la
plage vérifiée. Nuance : la puck line n'a **aucune queue** (4 matchs au-dessus de
0,60, zéro au-dessus de 0,70), donc ce contrôle blanchit A2, **pas** la
distribution.

---

### S4 — servir le moneyline depuis le modèle de score

**Livré et déployé entre le 25 et le 26 août.** Ce qui est en service : le blend
`score ⊕ marché` écrit dans `train_score.py` ; `evaluate()` corrigée (elle
mesurait un autre modèle que celui servi) ; la décomposition λ des
`feature_importances` via `pred_contribs` (7 concepts, traduits EN/FR pour la
première fois) ; la `confidence` dérivée de |λ_dom − λ_ext| par rang dans les
déciles ; `base_prob = dist.p_home_win()` pour les **six** marchés non dérivables
(`last_team_score`, `period{1,2,3}_winner`, `winning_margin`, `double_chance`),
+1,5 à +3,1 points ; et les **deux estimateurs exposés côte à côte**
(`probability_score_model` / `probability_classifier`, avec leur Δ dans
`DevMLDashboard`), à coût de calcul nul. Détail complet dans
`ml/REFACTOR_PLAN.md` §S4.

**La prolongation dépendante de l'affiche est en service** depuis le run du
2026-08-26 : `σ(+0,264466·Δλ − 0,06097)` sur 3 427 prolongations, `mean_fitted`
0,49956, cinq garde-fous qui font retomber sur le scalaire sans bruit. Cause
mesurée, pas déduite : quand le modèle fait du domicile un favori ≥ 0,65 il gagne
**61,7 %** de ses prolongations (n = 149), et la constante 0,4996 est hors de
l'IC. Confirmé hors échantillon (log-loss 0,66368, ECE 0,02146, pente 1,1045 ±
0,0753) et vu au démarrage en prod :
`[ML] ✅ Prolongation dépendante de l'affiche — σ(+0.2645·Δλ -0.0610)`.

> **La mesure qui compte, et sa conséquence encore ouverte.** `backtest.py
> --reliability` (2026-08-26) a établi que **c'est le classifieur qui a raison
> dans les extrêmes** : sur ses propres bins, le modèle de score sort de l'IC là
> où ça compte — bin 0,7-0,8, il annonce 0,726 pour un observé de **0,821** sur
> 240 matchs. La compression est symétrique et mécanique (écart-type 0,095 contre
> 0,120, maximum 0,804 contre 0,877). La log-loss globale reste à parité (Δ
> apparié −0,00111 ± 0,00186, l'IC contient 0) : le modèle de score n'est pas
> moins bon, il est **mal calibré** — un autre défaut, et réparable.
>
> ⚠️ **La correction de prolongation ne referme pas la queue.** Après elle, le bin
> 0,7-0,8 annonce 0,7295 pour un observé de 0,8018 : toujours hors de son IC. La
> prolongation n'expliquait que ~2 points sur les 9,5. **Conséquence directe : les
> six marchés basculés sur `base_prob` sortent une probabilité de favori trop
> basse de ~7 points sur les affiches tranchées, donc une EV faussée dans le sens
> qui pousse vers l'outsider. Ne pas miser dessus** tant que γ n'est pas posé.

- [ ] **Étirer l'écart de λ (γ) — REPORTÉ, sciemment, après la saison 2026-27.**
      Le correctif de fond : `S = λ_dom + λ_ext` conservé, `δ = log λ_dom −
      log λ_ext` remplacé par `γ·δ`, un seul paramètre ajusté sur la validation.
      Les totaux sont intacts par construction et tous les marchés dérivés
      héritent de la correction. **Pourquoi on attend :** la pente vaut 1,105 ±
      0,075 — elle n'est **plus** significativement > 1, alors que le bin de queue
      échoue encore. Les deux tests se contredisent faute de matchs au-dessus de
      0,75 : il y en a 228. Poser γ là-dessus serait ajuster un paramètre sur du
      bruit. `backtest.py --reliability` mesure déjà tout ce qu'il faut.
- [ ] **⑤ Suppression du classifieur — REPORTÉE À APRÈS LE LANCEMENT**, et alors
      en « option 1 » : classifieur rétrogradé en **repli pur**, `_blend_w` et le
      chemin nominal supprimés, `game_model.json` gardé **une release de plus**.
      Réversible ; suppression définitive au déploiement suivant si rien n'a bougé.
- [ ] **La mesure qui tranchera ⑤ — quand la saison 2026-27 sera dans le
      dataset.** `python build_dataset.py`, puis `train.py` et `train_score.py` :
      la comparaison porte alors sur des matchs qu'**aucun des deux modèles n'a
      vus**, au lieu des 0,0011 de log-loss actuels qui sont dans le bruit. C'est
      la vraie raison de garder `game_model.json` une release de plus — la mesure
      a besoin des deux modèles.

> ### 🔍 Le blend marché n'a jamais tourné, et c'est un argument pour A1
>
> `_blend_w` se lit dans `training_report.json → game_model.baselines.market.
> blend_weights` — clé **absente** du rapport. Cause : le découpage est
> chronologique et les cotes SBRO s'arrêtent en 2022-23, donc la tranche de
> **test (4 304 matchs, 2023-02-26 → 2026-04-16) ne contient AUCUNE cote**.
> `train.py` bute sur le même mur depuis toujours. **Aucun blend marché n'est
> ajustable tant qu'A1 ou A1bis n'a pas comblé 2023-2026.**
>
> Conséquence : la crainte qui bloquait ④ et ⑤ portait sur un blend inexistant.
> Sur la même tranche de test, **modèle de score + τ 0,6642 contre classifieur +
> Platt 0,6653** — le modèle de score est déjà devant. S4 est une simplification
> **à parité**, pas un compromis. Le blend reste écrit et juste : ses poids
> s'appliqueront par-dessus `dist.p_home_win()` le jour où il y aura des cotes.
> Attention en attendant : le blend marché est **vivant** côté serveur
> (`featureEngineering.ts:238` passe les cotes), et P1 a mesuré le marché seul
> meilleur que les deux modèles nus — d'où le réajustement plutôt que la perte.

---

### A4 et A6

**A4 — fenêtre de confirmation du gardien.** Mesure préalable, pas une stratégie :
elle dit s'il y a lieu de construire.

- [ ] Extraire la trajectoire des lignes autour de l'heure de confirmation

**A6 — team totals, prolongation, écarts ±2.5.** Priçables par `score_model.py`,
jamais confrontés à des prix réels. Après A1 et A2.

---

## 3. Scalabilité — déclenchés sur seuil

Source : `AUDIT_SCALABILITE_COUTS.md` §3. **Rien ici n'est requis pour 500
simultanés.**

| # | Quoi | Déclencheur | Effort |
|---|---|---|---|
| **D** 🔴 | **Redis (Upstash)** : adapter Socket.io + `RedisRateLimitStore` (déjà écrit, à brancher) + quota LLM Free | **avant la 2ᵉ instance** | 1 j |
| E | Migrer les data-URI d'avatars déjà en base vers R2 — code et variables en place | ~500 utilisateurs avec avatar | 2 h |
| Q | 2ᵉ instance Railway + sticky sessions | CPU > ~70 % en régime | 4 h |
| U | RAM du service ML : 2 workers uvicorn à ~300-500 Mo RSS chacun ne tiennent pas dans 512 Mo | avant le premier pic réel | 15 min |
| I | TanStack Query côté client — `fetch` brut partout, aucune déduplication | quand la facture Railway devient visible | 2 j |
| T | Cache de prompts LLM identiques | quand l'usage LLM devient significatif | 4 h |
| V | Échantillonner les logs 2xx | à la première facture de logs | 1 h |
| W | Purge Tailwind — le CSS pèse **90,5 ko brut / 21 ko gzip** (mesuré le 2026-08-29 ; le JS est déjà découpé par route, et le gros morceau est le chunk `charts` à 537 ko / 154 ko gzip, chargé seulement sur les routes qui l'utilisent) | — | 2 h |

**Écarté sciemment** — décision produit, pas oubli : Redis tant qu'il n'y a
qu'une instance. (La ligne O, TTL différenciés Tennis, est sans objet depuis le
retrait du tennis.)

**Question ouverte, laissée exprès :** `writeLimiter` (30 écritures/min, monté
sur `/api/chat` et les routes d'écriture) est encore classé **par IP** et souffre
donc du NAT mobile que `apiLimiter` ne subit plus. Passer les écritures « par
compte » affaiblirait l'anti-spam là où il sert le plus, et les salons ont déjà
leur propre limiteur par action. À trancher.

**Ne pas « corriger » :** `fetchSpreadsOnly` (`oddsClient`) renvoie `[]` en cas de
panne au lieu de servir un prix périmé. C'est voulu — un collecteur qui rate un
cycle perd un point de mesure, alors qu'un snapshot réécrit avec un prix ancien
fabriquerait un faux mouvement de ligne.

- [x] Suite serveur : **17 fichiers, 155 tests verts** + `npm run typecheck` à 0
      erreur (2026-08-29), rejoués dans un Linux propre depuis le lock seul,
      sans base de données.

---

## 4. QA — campagnes à exécuter

Source : `QA_TEST_PLAN.md`, qui garde le détail (résultat attendu, notes, pièges).
Sécurité et résilience sont **validées en statique** ; ce qui reste est dynamique.

> **F1, F2, I1 et I2 ont un runbook** depuis le 2026-08-30 :
> `QA_TEST_PLAN.md` § « Runbooks B4 ». Les autres lignes ci-dessous n'en ont pas
> encore.

**Fonctionnel** — F1 auth complète · F2 gating Pro bout en bout · F3 slip +
settlement · F4 prédictions NHL du jour · F5 Best Bets / value bet scan ·
F6 récupération de mot de passe

**Intégration** — I1 chaîne ML Front→Node→FastAPI · I2 CORS + cookie cross-site ·
I3 webhook Stripe idempotent · I4 Google OAuth · I5 socket.io · I6 pipeline
données externes → features

**Performance** — P1 charge sur l'endpoint ML (définir le p95 accepté) ·
P2 cache et quotas externes · P4 Lighthouse mobile · P5 pool Postgres
(**vérifier d'abord que `DATABASE_URL` pointe sur `-pooler`**, sinon le test
échoue pour la mauvaise raison) · P3 rate limiting en multi-instance

**Compatibilité** — C1 mobile iOS/Android · C4 pages SEO statiques sur crawlers ·
C2 cross-navigateur desktop · C3 push web

**Vérifications dynamiques de sécurité** (le statique est passé) — test IDOR à
2 comptes · JWT expiré/altéré rejeté et refresh non rejouable après logout

✅ **CSP réellement servie par Vercel — mesurée verte le 2026-08-30**, les six
en-têtes de `client/vercel.json` présents et la valeur identique au caractère
près. Clôt M6, et avec lui l'audit de production en entier.

> ⚠️ **Ce que la même mesure a montré, et qui n'était pas cherché.** La réponse
> porte `server: cloudflare` et un `cf-ray`, avec `x-vercel-cache: HIT` derrière.
> Le trafic de l'apex passe donc bien par le proxy de **l'ancien compte
> Cloudflare** — celui qui est perdu. C'est la confirmation *par la mesure* de ce
> que le §1 ne faisait que déduire des serveurs de noms, et Vercel n'est que
> l'origine derrière lui : seule la couche DNS/proxy est en jeu.

**`npm audit` est vide des deux côtés — clos le 2026-08-29.** `npm audit fix`
plus les deux montées de version (`react-router` 7.13.0 → 7.18.3, `vite`
6.3.5 → 6.4.3) ; joué sur la machine Windows, vérifié autrement que par une
console verte (versions relues dans `node_modules`, six routes chargées dans
Chromium avant/après avec des DOM identiques au caractère près). Commité en
`4c8c97e`.

> ✅ **Le CRLF est neutralisé — 2026-08-30.** Il est bien revenu comme annoncé,
> mais **beaucoup plus large que prévu** : 60 fichiers de `client/`, `server/` et
> `ml/` réécrits en CRLF sans un caractère de contenu changé. `git diff`
> annonçait **26 292 lignes touchées pour 745 réelles** — cinq fichiers portaient
> tout le vrai travail, soixante ne portaient que du bruit.
>
> **Le remède posé n'est pas celui que cette ligne prévoyait.** Au lieu du
> `.gitattributes`, `git config core.autocrlf input` : un réglage **local**, qui
> normalise CRLF→LF au moment du commit sans toucher ni le disque ni le dépôt.
> Les 60 fantômes ont disparu de `git status` sur-le-champ et ne reviendront plus
> au prochain `npm ci`. **Pourquoi ce choix :** couvrir 60 fichiers de trois
> dossiers aurait demandé une règle large, or `* text=auto` renormalise des
> centaines de fichiers d'un coup — exactement ce que cette ligne interdisait. Le
> réglage local obtient le même résultat sans commit de renormalisation.
>
> ⚠️ **Ce qu'il ne couvre PAS : une autre machine.** `core.autocrlf` n'est pas
> versionné. Un second poste Windows, ou un clone frais, retrouverait le problème
> intact. C'est là — et seulement là — qu'un `.gitattributes` ciblé par extension
> deviendrait justifié.
>
> ⚠️ **Et la leçon de méthode, qui vaut au-delà du CRLF :** `git diff --shortstat
> --ignore-all-space` face à `git diff --shortstat` répond en une seconde à « ce
> gros diff contient-il du vrai travail ? ». Sans ce réflexe, 25 000 lignes de
> bruit partent dans un commit et rendent illisible tout ce qu'il contient.
>
> **Et toujours `npm ci`, jamais `npm install`** : les locks livrés sont
> exactement ceux qui ont été testés.

**Tests de résilience à provoquer** — couper le ML · couper The Odds API et
retirer `scratches.json` · redeploy Railway sous trafic · webhook Stripe rejoué

**Reprise** — exécuter un **vrai test de restauration** de la base (`BACKUP_DR.md`
existe, il n'a jamais été joué) et **documenter + tester une fois** le rollback
Railway/Vercel.

---

## 5. Décisions tranchées — il n'en reste qu'un contrôle

**Purge de l'historique Git : abandonnée (2026-08-10).** Le mot de passe présent
dans l'historique est celui d'une base **locale**, sans valeur pour un attaquant.
**Point clos, ne pas le rouvrir** — et ne pas le confondre avec la clé The Odds
API du §6, qui est un cas différent et, lui, réel.

✅ **Le scanner gitleaks du CI ne couvrait pas ce qu'on croyait** — trouvé et
corrigé le 2026-08-30. Il se déclenchait sur `push` vers `main`, une branche qui
n'existe pas ici (la branche par défaut est `master`) : il ne protégeait donc
que les pull requests. `master` est ajouté ; le garde-fou invoqué ci-dessus est
désormais réel. Détail et règle de non-régression au §6.

**Synchro des poids de règles : câblée le 2026-08-24** (`ruleWeightsService` ;
`PATCH /users/me` borné par `profileUpdateSchema`, liste blanche zod sur la route
et double barrière dans le service).

✅ **Vérifiée à 2 navigateurs le 2026-08-30** : les poids enregistrés sur A
arrivent sur B au même compte, et en invité le réglage ne sort pas de l'appareil.

> Portée exacte, pour ne pas relire ce vert plus large qu'il n'est : c'est le
> **comportement** qui a été observé, pas le compteur de requêtes. L'enjeu était
> qu'un invité n'écrive nulle part, et c'est établi — mais l'absence d'un
> `GET /users/me` inutile au chargement ne l'est que par le code
> (`ensureFamilyWeightsHydrated` sort sur `isSignedIn()` avant tout appel). Si
> une facture de requêtes surprend un jour, c'est là qu'il faut regarder.

**Codes promo : pas de changement de schéma (2026-08-10).** `promoCatalog()`
lit `PRO_PROMO_CODES` ; variable absente **en production** → catalogue vide, tout
code rejeté en 400 avec un `logger.warn`. Retirer les codes = vider la variable
et redéployer. Rien à coder, pas de table `promo_redemptions`.

> Ce qu'il faut accepter en attendant : tant que la variable porte un code, il
> reste utilisable par **plusieurs comptes** — il n'y a pas de plafond d'usage.
> Sans conséquence pour des codes de lancement distribués sciemment ; le jour où
> les codes deviennent individuels, il faudra la table (`max_uses` /
> `expires_at`), et ce sera un changement de schéma.

- [ ] **Après le lancement :** vider `PRO_PROMO_CODES` sur Railway, redéployer,
      et vérifier qu'un ancien code renvoie bien 400.

---

## 6. Ménage du 2026-08-10 — ce qu'il en reste

Le détail de ce qui a été supprimé (kit shadcn de 49 fichiers, 7 fichiers morts,
42 dépendances sur 50, 15 exports) est dans l'historique Git. Ne restent ici que
les points encore vivants.

### Reste à faire

✅ **Lot sécurité du 2026-08-30 : commité et poussé en entier.** Le code dans
`528b844`, puis `ci.yml` et les documents dans `674b199` — ce dernier avait
d'abord été oublié, noyé dans les 60 fichiers de bruit CRLF au moment de choisir
quoi ajouter. C'est précisément ce que le réflexe `--ignore-all-space` du §4 sert
à éviter.

> **La preuve reste à venir, et elle est gratuite :** le premier déclenchement du
> job `Secret scan — gitleaks` sur une poussée vers `master` — celle-ci — est ce
> qui établit que le correctif marche. Jusque-là, on sait seulement que le
> fichier est correct, pas que GitHub l'exécute.

✅ **Sonde relue, corrigée et vérifiée verte — clos le 2026-08-31.** Elle a
d'abord répondu **rouge** (`[OddsLogger] ⚠️ ODDS_API_KEY REFUSÉE`, 401) : la clé
était bien régénérée, mais la nouvelle valeur était restée **en attente** sur
Railway derrière le bouton « Deploy », et le processus tournait avec l'ancienne.
Une fois la modification déployée, le conteneur `20f5b0ce` imprime
`[OddsLogger] ✅ ODDS_API_KEY acceptée par The Odds API`. Détail et leçon au §1,
« Ce que les logs du conteneur en cours disent ». **La sonde a fait exactement
son travail** — sans elle, la collecte serait restée muette jusqu'au
22 septembre.

- [ ] **Découpage > 500 lignes**, si on le poursuit :

| Fichier | Lignes | Pourquoi ce n'est pas un découpage mécanique |
|---|---|---|
| `i18n/index.tsx` | 855 | Dictionnaire de traductions. Le découper par domaine est du rangement, pas de la structure. |
| `data/betMarkets.ts` | 628 | Table de données. Même remarque. |
| `pages/NHLPredictionsPage.tsx` | 589 | Jamais analysé — le candidat le plus sérieux. |
| `components/MLPredictionCard.tsx` | 541 | Candidat. |
| `components/MarketSelectorSheet.tsx` | 519 | Candidat. |
| `profile/SettingsTab.tsx` | 509 | **453 lignes réelles**, un seul composant portant ~20 `useState` partagés. Les séparer = faire descendre ces états en props : un vrai refactoring, à faire avec le navigateur ouvert. |

### Sécurité — le lot du 2026-08-30, et les quatre règles qui en restent

**Fait, plus rien à faire dessus :** la clé The Odds API est régénérée — la
valeur littérale de `DEPLOYMENT.md` (`5333eb4e…`, du commit `9197b31` à
`89ee8bb`) **était bien réelle**, elle est morte, et `server/.env` comme Railway
portent la nouvelle. Le CI scanne enfin les poussées sur `master`. Une clé
refusée sort désormais en rouge au démarrage (`verifyOddsApiKey()`, calquée sur
`verifyAvatarStorage()`).

Ce qui vaut d'être gardé, ce sont les règles :

1. **Jamais un secret derrière un préfixe `VITE_`.** Vite les **inline** dans le
   bundle au build : tant que ce nom a servi, la clé était lisible par n'importe
   quel visiteur dans le JS servi. C'est ça qui rendait la purge de l'historique
   Git secondaire, et non l'inverse — d'où la décision assumée de **ne pas**
   réécrire l'historique : dépôt privé, clé morte, et une réécriture casserait
   les SHA que ce document cite (`15ecbb6`, `4c8c97e`, `89ee8bb`). Corrigé à la
   source, le serveur proxifie The Odds API. **Il n'y a pas de secret côté
   client.**
2. **Un contrôle de présence n'est pas un contrôle de validité.** Troisième
   occurrence du même défaut, après `[avatarStorage] R2 actif` et
   `NHL_USE_MOCK` : une clé révoquée passait les trois contrôles au vert. La
   bannière dit maintenant `présente (validité vérifiée par verifyOddsApiKey)`,
   pour que le mot ne puisse plus se relire comme « valide ».
3. **Ne jamais journaliser l'URL de The Odds API** — elle porte la clé en clair
   dans sa query string. Statut HTTP et `err.name` uniquement ; jamais l'erreur
   brute ni `err.cause`. Le fichier respectait déjà cette discipline
   (`err?.message` seul) : c'est elle qu'il ne faut pas casser.
4. **Ne pas retirer `master` de `ci.yml`** — et ne pas non plus élargir à toutes
   les branches. `pull_request` n'a volontairement aucun filtre : tout ce qui
   *entre* dans `master` est scanné par l'un ou l'autre déclencheur, sans faire
   tourner le build et les 155 tests sur chaque branche de travail.

> ⚠️ **Le repli d'`isSeasonActive()` n'a PAS été touché, et c'est délibéré.**
> `!res.ok` continue de répondre « en saison » : mieux vaut une passe inutile
> qu'une saison entière ratée sur une erreur transitoire. Le lot a ajouté de la
> **parole**, pas un garde-fou — un échec réseau reste « non concluant », il ne
> devient pas rouge. Ne pas « durcir » ça plus tard sans relire cette ligne.

### Retrait du tennis — fait le 2026-08-24, à ne pas réintroduire

Les 5 fichiers dédiés sont supprimés du disque et de l'index Git, 18 fichiers
nettoyés, contrôle statique passé (zéro référence vivante), build Windows rejoué
vert. `SportContext` **reste**, en mono-sport : il porte le thème que consomment
une vingtaine d'écrans ; le supprimer aurait disséminé trois constantes partout.

✅ **Vérifié à l'écran le 2026-08-30** — accueil, onglet Stats et `/league` : plus
aucune trace visible, aucun trou laissé par ce qui est parti. Les seules mentions
restantes sont des commentaires de code : **ne pas les retirer**, ce sont eux qui
empêchent de réintroduire le tennis par distraction.

> **Les paris tennis déjà en base ne bougent pas.** `settlement.service` les
> laissait déjà en attente (aucune logique de règlement tennis n'a jamais
> existé) et un coupon affiche des libellés stockés, pas des définitions de
> marché : rien ne casse, ils restent « pending » pour toujours. Si tu veux les
> solder, c'est une requête SQL manuelle, à décider séparément.

> ⚠️ **`client` a désormais son propre `tsconfig.json` en `strict` et un
> `npm run typecheck`** — il n'en avait pas, et `vite build` seul ne typecheck
> rien. Le lock livré porte les trois devDependencies nécessaires : un seul
> `npm ci` suffit.

### À ne pas défaire

- **`server/src/middleware/redisRateLimitStore.ts`** paraît orphelin : c'est le
  stub de la ligne D (§3). Le brancher est « une ligne par limiteur » *parce
  qu'il existe déjà*.
- **5 exports sans appelant sont gardés exprès**, chacun commenté :
  `clearBestBetsCache`, `clearLeaderboardCache`, `stopOddsLogger`, `snapshot`
  (oddsQuota) — points d'entrée dont un test d'intégration a besoin — et
  `applyServerFamilyWeights`, désormais appelée (§5).

### Méthode de découpage — les trois pièges, si on reprend

Extraction de plages de lignes **par script**, jamais à la main, avec trois
contrôles : syntaxe, résolution de chaque import interne, et comparaison des
multiensembles de lignes avant/après (c'est celui qui prouve qu'aucune ligne n'a
été perdue). Les trois pièges rencontrés, tous attrapés par les contrôles et
aucun par la relecture :

1. le script écrasait son propre fichier source (il lit une copie depuis) ;
2. l'extraction d'identifiants attrapait les noms **cités dans les commentaires**
   et fabriquait des imports circulaires imaginaires (elle passe par l'AST) ;
3. les imports **à effet de bord** (`import "x.css"`) n'ont aucun binding : ils
   étaient silencieusement supprimés — la page aurait perdu ses styles sans
   qu'aucun test ne bronche. Le script les réinjecte et refuse de tourner s'il en
   trouve un sans coquille désignée.

Pour réintroduire un composant shadcn : `npx shadcn@latest add <nom>`.
