# Registre des incidents de confidentialité

Loi 25 — _Loi sur la protection des renseignements personnels dans le secteur
privé_, art. 3.8, et _Règlement sur les incidents de confidentialité_.

**Tenu par :** Ireina Hedad, responsable de la protection des renseignements
personnels. Ce fichier n'est pas publié : il vit hors de `client/`, donc hors du
site déployé par Vercel. La Commission d'accès à l'information peut en demander
une copie.

**Qu'est-ce qui s'inscrit ici ?** TOUT incident, même sans gravité : accès,
utilisation ou communication non autorisés d'un renseignement personnel, perte,
ou toute autre atteinte à sa protection. Exemples : une base ou une sauvegarde
exposée, un secret (`DATABASE_URL`, clé Stripe, clé R2) divulgué, un courriel
envoyé à la mauvaise personne, un bogue qui montre les données d'un compte à
un autre.

**Conservation :** chaque entrée est gardée au moins **5 ans** après la date où
l'on a pris connaissance de l'incident.

**Risque de préjudice sérieux ?** Il faut alors aviser, avec diligence, la
Commission d'accès à l'information (formulaire sur cai.gouv.qc.ca) et les
personnes concernées. Pour évaluer le risque, on considère la sensibilité des
renseignements, les conséquences probables de leur utilisation et la
probabilité qu'ils soient mal utilisés.

---

## Modèle d'entrée

Copier ce bloc sous « Incidents », du plus récent au plus ancien.

```
### AAAA-MM-JJ — titre court

- Renseignements visés : (courriels, mots de passe hachés, messages de chat… — ou « inconnus » avec la raison)
- Circonstances : (ce qui s'est passé, la cause si connue)
- Date ou période de l'incident : (ou approximation)
- Date de prise de connaissance :
- Nombre de personnes concernées : (ou approximation)
- Évaluation du risque de préjudice sérieux : (sensibilité, conséquences, probabilité → oui / non, et pourquoi)
- Avis à la CAI : (date, ou « non requis » et pourquoi)
- Avis aux personnes concernées : (date et moyen, ou « non requis »)
- Mesures prises pour réduire le risque : (rotation de secrets — voir STATUS.md §6 —, correctif, révocation des sessions…)
```

---

## Incidents

_Aucun incident consigné._
