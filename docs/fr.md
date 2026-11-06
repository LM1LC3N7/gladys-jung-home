# JUNG HOME

Cette intégration relie votre installation JUNG HOME à Gladys par l'API locale
de la passerelle JUNG HOME (Bluetooth Mesh vers IP). Tout reste sur votre réseau
local. Non officiel, sans lien avec JUNG (Albrecht JUNG GmbH & Co. KG).

**Jamais testé avec un vrai appareil pour l'instant** : l'intégration a été
écrite d'après la documentation du protocole de la bibliothèque de référence
`junghome` (MIT) et testée contre une passerelle simulée. Vos retours sont les
bienvenus.

## Ce que vous obtenez

Dans l'onglet **Découverte** :

- **Lumières** (marche/arrêt) et **variateurs** (luminosité) ;
- **Volets roulants et stores** : ouvrir, fermer, arrêter, position (les
  lamelles ne sont pas encore pilotées) ;
- **Prises** : leur état, un bouton « Éteindre », et leur puissance quand la
  prise la mesure ; une prise déclarée sûre devient un interrupteur ;
- **Thermostats d'ambiance** : température ambiante, consigne, bouton « Hors
  gel » ;
- **Boutons à bascule** : un appui haut ou bas arrive à vos scènes Gladys ;
- **Capteurs** : température, luminosité, puissance ;
- **Scènes JUNG HOME** : un bouton « Lancer » chacune.

Les identifiants des appareils sont liés au numéro de série de la passerelle
et à l'identifiant de chaque fonction (`function:sn<série>_<fonction>`) : ils
ne changent pas avec une mise à jour, mais une fonction réappairée dans l'app
JUNG HOME devient un nouvel appareil. Sur un micrologiciel sans numéro de série,
l'adresse MAC le remplace.

## Configuration

1. Saisissez l'**adresse IP** de la passerelle (visible dans l'app JUNG HOME ou
   dans votre box) et **enregistrez**. Les noms en `.local` ne sont pas résolus
   dans le conteneur.
2. Cliquez sur **Demander l'accès**. L'intégration lit d'abord le certificat
   de la passerelle et l'épingle (son empreinte SHA-256 s'affiche), puis
   envoie une seule demande au nom de « Gladys ».
3. Dans l'app JUNG HOME : **Réglages, Passerelle, Autorisations d'accès,
   Demandes ouvertes**, acceptez « Gladys » dans les 3 minutes. Le jeton est
   enregistré tout seul et la connexion démarre.
4. Ajoutez les appareils voulus depuis l'onglet **Découverte**.

Le jeton est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement à la passerelle à l'adresse saisie, et seulement sur une connexion
dont le certificat est celui épinglé.

### Certificat de la passerelle

La passerelle a un certificat auto-signé. L'intégration n'accepte que celui
épinglé : appris à votre premier clic sur « Demander l'accès » ou « Tester la
connexion », ou saisi dans le champ **Empreinte du certificat**. Si un autre
certificat se présente (passerelle remplacée, carte réinstallée, ou un autre
appareil à cette adresse), rien n'est envoyé, pas même un arrêt, et le statut
affiche l'empreinte vue. Pour lui faire confiance : cliquez deux fois sur
**Faire confiance au nouveau certificat** (le second clic dans les 2 minutes),
ou saisissez cette empreinte dans la configuration.

## Ce qui part toujours, ce qui est désactivé par défaut

**Partent toujours** : éteindre une lumière ou une prise, arrêter un volet,
fermer un volet, le hors gel d'un thermostat. Ni une option, ni une pause 429,
ni une lecture ou une commande en cours, ni le numéro de série pas encore
relu ne les retiennent. Elles annulent les commandes de la même cible encore
en attente : rien de ce qui a été demandé avant un arrêt ne part après lui.

Un arrêt ne part pas seulement dans ces cas, et il est alors **gardé** (le
statut le dit) puis envoyé dès que possible :

- adresse ou jeton absent ou invalide, ou jeton refusé par la passerelle : il part en premier dès
  qu'un nouveau jeton est enregistré ou que « Tester la connexion » réussit ;
- pas de certificat épinglé, ou certificat changé : il part dès que le
  certificat est épinglé ou de nouveau reconnu ;
- passerelle injoignable, ou route refusée (401/403) alors que la liste des
  fonctions accepte encore le jeton : il est renvoyé toutes les 5 secondes,
  sans limite de durée (seul un refus de la liste des fonctions vaut jeton
  refusé) ;
- avant la première lecture de la configuration dans Gladys (démarrage du
  conteneur) : il est refusé, rien n'est envoyé (le jeton n'est pas encore
  connu).

Une extinction ou un hors gel reste gardé, aussi dans `/data` (un redémarrage
du conteneur le renvoie en premier, dès la configuration lue), jusqu'à ce
qu'une lecture partie après la réponse de la passerelle le montre appliqué.
Si la lecture montre le contraire, il est renvoyé ; seuls les envois auxquels
la passerelle a répondu comptent, 4 au plus (après un redémarrage du
conteneur, il part encore une fois au moins). Après
4 refus de la passerelle (appareil verrouillé, alarme vent) ou 4 envois non
appliqués, il reste gardé et affiché, sans nouvel envoi, jusqu'à une lecture
qui le montre appliqué ou une commande plus récente. Une commande plus récente de la
même cible, prise par la passerelle, le remplace. Un mouvement de volet
(fermer, arrêter) est terminé dès que la passerelle l'a pris, et n'est jamais
rejoué après un redémarrage. Une fermeture qui n'a pas atteint la passerelle
est d'abord retentée deux fois en 250 ms environ ; ensuite, elle n'est renvoyée
qu'après une lecture du volet : fermé ou en train de se fermer, c'est fait ;
lu plus ouvert qu'au clic deux fois de suite, il a été ouvert à la main
entre-temps et la fermeture est abandonnée (jamais refermé par-dessus, passé
ces premières 250 ms).

**Désactivé par défaut** :

- **Prises** : une prise peut alimenter n'importe quoi, et un « allume tout »
  d'un assistant vocal ou d'une scène atteint chaque interrupteur. Une prise
  n'est donc qu'un état et un bouton « Éteindre », tant que vous ne la
  déclarez pas sûre (champ **Prises déclarées sûres**, avec l'identifiant
  `JUNG_FUNCTION` affiché dans la Découverte) ; elle devient alors un
  interrupteur après un nouveau Scan.
- **Consignes de chauffage** : en lecture seule tant que vous ne les
  autorisez pas ; ensuite entre 5 et 30 °C (les bornes du thermostat), par pas
  de 0,5 °C arrondi vers le bas.
- **Scènes JUNG HOME** : une scène peut allumer n'importe quelle prise ; leur
  bouton ne fait rien tant que vous ne les autorisez pas.

L'option est relue juste avant l'envoi : décochée pendant qu'une commande
attend, la commande est refusée.

## Ce que dit une commande refusée

Une commande (autre qu'un arrêt) part dans les 3,5 secondes ou pas du tout :
« rien envoyé » dit qu'elle n'est jamais partie. « Refusée par la passerelle »
reprend sa raison (appareil verrouillé, alarme vent...). « Envoyée, sans
confirmation » dit qu'elle est partie sans réponse ; « pas encore appliquée »
qu'une relecture ne la montre pas encore. Dans ces deux derniers cas, l'appareil
est relu après 5 et 20 secondes et son badge le signale en attendant.

## Lectures et mises à jour en direct

Avec les **mises à jour en direct** (par défaut), la passerelle envoie chaque
changement par WebSocket ; la liste complète est relue toutes les 5 minutes.
Sans elles, ou si la connexion est perdue, la liste est relue à l'**intervalle**
choisi (60 s par défaut). Jamais plus vite : ni le bouton Scan, ni le bouton
« Tester la connexion » (qui dit alors quand il pourra tester), ni un
redémarrage du conteneur ne relisent avant l'intervalle après la dernière
lecture ; une lecture faite par le bouton Test repousse la lecture prévue à
l'intervalle après elle. Tant que le jeton est refusé ou qu'une autre
passerelle répond (aucune lecture ne tourne alors), le bouton Test essaie
tout de suite, une fois par 10 secondes.

Un appui sur un bouton à bascule est vu seulement en direct. Le micrologiciel
2.2.0 des boutons envoie chaque appui deux fois, à environ 1 s : un second
appui sur le même bouton dans les 1,2 s est ignoré.

## Limites connues

- Les lamelles des stores, la température de couleur et les stores bannes
  (sens inversé) ne sont pas encore pilotés.
- Le compteur d'énergie des prises (accessible seulement par une route
  expérimentale de la passerelle) n'est pas lu.
- Un appui long et un double appui ne sont pas distingués.
- La demande d'accès par mot de passe de la clé réseau n'est pas proposée :
  seulement par accord dans l'app JUNG HOME.

## Dépannage

- **« Le certificat de la passerelle a changé »** : voir plus haut.
- **« La passerelle a refusé le jeton »** : l'accès a été retiré dans l'app ;
  cliquez sur « Demander l'accès » de nouveau.
- **« Une autre passerelle répond à cette adresse »** : le numéro de série lu
  n'est plus celui appris ; « Tester la connexion » accepte la nouvelle
  passerelle.
- **« /data est illisible »** : l'intégration fonctionne, mais n'apprend ni ne
  garde rien (certificat, identité, arrêts) ; saisissez l'empreinte du
  certificat dans la configuration.
