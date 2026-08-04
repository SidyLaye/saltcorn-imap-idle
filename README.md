# imap-idle — relève IMAP en temps réel pour Saltcorn

Le module officiel `imap` fonctionne par sondage : on l'appelle, il récupère, il
s'arrête. Avec l'événement *Often*, la latence est de 5 minutes.

Ce plugin maintient une connexion **IDLE** ouverte : le serveur prévient dès
qu'un message arrive, et la ligne est écrite en table dans la seconde.

---

## Ce qu'il apporte en plus du module officiel

| | `imap` officiel | `imap-idle` |
|---|---|---|
| Déclenchement | sondage, 5 min minimum | **IDLE, temps réel** |
| Curseur UID | oui | oui |
| **Contrôle d'UIDVALIDITY** | **non** | **oui** |
| Ouverture du dossier | par défaut | **lecture seule explicite** |
| Reconnexion automatique | — | oui, avec délai |
| Relève de secours | — | oui, en parallèle |
| Pièces jointes | oui | non (hors périmètre) |
| OAuth2 | oui | non |

Le point qui justifie ce plugin : **le module officiel ne vérifie pas
l'UIDVALIDITY**. Si le serveur le réinitialise — dossier recréé, restauration de
sauvegarde, migration — les nouveaux messages repartent d'UID bas. Comme le
`max(uid)` stocké reste élevé, la requête `max+1:*` ne remonte plus rien.
**Silencieusement.** Le service tourne, il ne reçoit simplement plus jamais de
lead, et aucune alerte ne se déclenche.

Ici, l'UIDVALIDITY est comparé à chaque connexion. S'il a changé, on repart de
zéro et on journalise l'incident.

---

## Installation

Le plugin n'est pas dans le store : on l'installe depuis un dépôt Git ou en local.

### Par Git

1. Pousser ce dossier dans un dépôt Git accessible par le serveur.
2. Dans Saltcorn : *Réglages → Modules → Add module* → source **git**, URL du dépôt.

> Sur un tenant non racine, l'installation depuis Git est refusée par défaut. Il
> faut activer `tenants_install_git` dans la configuration du tenant racine, ou
> installer depuis le tenant racine.

### En local (le plus simple sur Dokploy)

Monter le dossier dans le conteneur, puis *Add module* → source **local**, en
donnant le chemin.

```yaml
# docker-compose.yml, service saltcorn
volumes:
  - saltcorn_files:/scfiles
  - ./plugin-imap-idle:/plugins/imap-idle:ro
```

---

## Configuration

Trois étapes.

**1. Compte IMAP**

```
Serveur IMAP : zimbra.immo-facile.com     (nom seul, sans https:// ni port)
Port         : 993
TLS          : ☑
Identifiant  : info@selectionhabitat.com
Mot de passe : ...
Dossier      : INBOX
```

**2. Table et champs** — la table doit exister avant, avec les bons types :

| Champ | Type Saltcorn |
|---|---|
| `uid` | **Integer** — c'est le curseur |
| `objet` | String |
| `expediteur` | String |
| `destinataire` | String |
| `date_envoi` | **Date** |
| `corps_texte` | String |
| `corps_html` | **HTML** |

**3. Temps réel**

```
Activer IDLE          : ☑
Renouvellement IDLE   : 240 s
Relève de secours     : 300 s     ← ne pas mettre 0
Délai de reconnexion  : 30 s
```

---

## Pourquoi garder la relève de secours

Ce n'est pas de la redondance. Une connexion IDLE peut tomber **sans bruit** :
coupure réseau, redémarrage du serveur de mail, pare-feu qui coupe une session
jugée inactive. Le plugin se reconnecte, mais entre la rupture et la
reconnexion, les messages arrivés seraient manqués — et si la reconnexion échoue
en boucle, le service tournerait sans plus rien recevoir.

La relève périodique récupère tout ce qui a été manqué, quelle qu'en soit la
cause. C'est le filet, et il coûte une requête toutes les cinq minutes.

---

## Ce qui déclenche la suite : l'événement `MailRecu`

Le plugin déclare son propre type d'événement. Il apparaît donc directement dans
la liste des événements de Saltcorn — **rien à créer à la main**.

```
[IDLE] message reçu ──► insertion en table ──► emitEvent("MailRecu", dossier, payload)
                                                          │
                                        [Déclencheur sur MailRecu] ──► filtrer_et_extraire
```

**Un événement par message, émis dès son insertion** — pas en fin de lot. Émettre
après le lot ferait attendre le premier message la fin du dernier, ce qui
annulerait l'intérêt du temps réel.

**Charge utile reçue par le déclencheur** (dans `row`) :

```json
{
  "id": 42,
  "uid": 1057,
  "objet": "Nouveau message pour \"Maison 5 pièces\" sur leboncoin",
  "expediteur": "no-reply@messagerie.leboncoin.fr",
  "destinataire": "info@selectionhabitat.com",
  "date_envoi": "2026-08-04T09:12:33.000Z",
  "corps_texte": "...",
  "corps_html": "..."
}
```

Le déclencheur sait donc exactement sur quoi travailler, sans relire la table.

**Le canal est le dossier surveillé.** Le jour où plusieurs boîtes sont relevées,
un déclencheur peut ne réagir qu'à l'une d'elles — sans filtrer dans le code.

### Créer le déclencheur

*Réglages → Événements → Déclencheurs → New*

```
Nom       : filtrer_et_extraire
Événement : MailRecu
Canal     : INBOX          (laisser vide pour réagir à tous les dossiers)
Action    : run_js_code
```

Le code de cette action est dans `saltcorn/02-triggers.md`, section
*filtrer_et_extraire*. Une seule adaptation : `row` contient déjà les champs du
message, il n'y a pas besoin de le relire.

> Le trigger `Insert` de la table se déclenche aussi, puisque le plugin utilise
> `table.insertRow()`. **Ne mets pas la même logique aux deux endroits** : elle
> s'exécuterait deux fois. Choisis `MailRecu` — il porte la charge utile et le
> canal.

Une action **`imap_idle_sync`** est également exposée : relève manuelle, utile
pour tester depuis un bouton. Elle émet les mêmes événements.

---

## Points de vigilance

**Une seule connexion par tenant.** Le plugin s'arrête sur les processus worker
du cluster (`cluster.isWorker`). Sans ce test, chaque worker ouvrirait sa propre
connexion et le même message serait traité plusieurs fois.

**Le dossier est ouvert en lecture seule.** Aucun flag n'est posé, aucun message
n'est déplacé. Un commercial qui ouvre un mail dans le webmail ne perturbe rien —
et réciproquement, le traitement ne modifie jamais sa boîte.

**Le mot de passe est stocké en base**, dans `_sc_plugins`. Les sauvegardes de la
base contiennent donc le mot de passe de la boîte du client. À intégrer aux
engagements RGPD.

**Le module officiel `imap` peut cohabiter** : les deux ont des `plugin_name`
distincts. Utile pour reprendre l'historique avec l'officiel — qui gère les
pièces jointes — puis laisser celui-ci prendre le flux en temps réel.
