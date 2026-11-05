// -----------------------------------------------------------------------------
// The texts users read (status, action results, refusals, feature names), in
// English and French. A text never quotes a token nor anything typed by the
// user that was refused.
// -----------------------------------------------------------------------------

/** The text of a message in a language. */
export const word = (text, language) =>
  typeof text === 'string' ? text : (text?.[language] ?? text?.en ?? '');

const both = (en, fr) => ({ en, fr });

const NAMES = {
  on: both('On', 'Allumé'),
  brightness: both('Brightness', 'Luminosité'),
  state: both('State', 'État'),
  off: both('Turn off', 'Éteindre'),
  position: both('Position', 'Position'),
  setpoint: both('Setpoint', 'Consigne'),
  frost: both('Frost protection', 'Hors gel'),
  press_up: both('Press up', 'Appui haut'),
  press_down: both('Press down', 'Appui bas'),
  recall: both('Recall', 'Lancer'),
};

/** The name of a feature (quantities: "Measure 010"). */
export function featureName(key, language = 'fr') {
  const name = NAMES[key];
  if (name) return word(name, language);
  if (/^q[0-9a-f]{3}$/.test(key))
    return `${language === 'fr' ? 'Mesure' : 'Measure'} ${key.slice(1)}`;
  return key;
}

const CONFIG_ERRORS = {
  empty: both(
    'Type the address of your JUNG HOME gateway, save, then click "Request access".',
    "Saisissez l'adresse de votre passerelle JUNG HOME, enregistrez, puis cliquez sur « Demander l'accès ».",
  ),
  invalid: both(
    'The gateway address is not valid.',
    "L'adresse de la passerelle n'est pas valide.",
  ),
  scheme: both(
    'The gateway answers in HTTPS only: type its address alone.',
    'La passerelle répond en HTTPS seulement : saisissez son adresse seule.',
  ),
  credentials: both(
    'No user name nor password in the address.',
    "Pas d'identifiant ni de mot de passe dans l'adresse.",
  ),
  path: both('Type the address alone, without a path.', "Saisissez l'adresse seule, sans chemin."),
  broadcast: both(
    'This address is not one of a device (broadcast or multicast).',
    "Cette adresse n'est pas celle d'un appareil (diffusion ou multicast).",
  ),
  'local-name': both(
    'Names in .local do not resolve in the container: type the IP address of the gateway.',
    "Les noms en .local ne sont pas résolus dans le conteneur : saisissez l'adresse IP de la passerelle.",
  ),
  fingerprint: both(
    'The certificate fingerprint is not a SHA-256 one (64 hexadecimal digits).',
    "L'empreinte du certificat n'est pas une SHA-256 (64 caractères hexadécimaux).",
  ),
  'bad-token': both(
    'The saved token is not a token of the gateway: click "Request access" again.',
    "Le jeton enregistré n'est pas un jeton de la passerelle : cliquez de nouveau sur « Demander l'accès ».",
  ),
};

const FAILURES = {
  nopin: both('certificate not pinned yet', 'certificat pas encore épinglé'),
  auth: both('token refused by the gateway', 'jeton refusé par la passerelle'),
  rate: both('too many requests, paused', 'trop de requêtes, pause'),
  notfound: both('not found on the gateway', 'introuvable sur la passerelle'),
  refused: both('refused by the gateway', 'refusé par la passerelle'),
  server: both('error of the gateway', 'erreur de la passerelle'),
  redirect: both(
    'redirected (not a JUNG HOME gateway?)',
    'redirigé (pas une passerelle JUNG HOME ?)',
  ),
  network: both('gateway unreachable', 'passerelle injoignable'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  size: both('answer too large', 'réponse trop grande'),
  format: both(
    'answer not understood (not a JUNG HOME gateway?)',
    'réponse non comprise (pas une passerelle JUNG HOME ?)',
  ),
  aborted: both('stopped', 'arrêté'),
};

const GUARD_STATES = {
  waiting: both('waiting', 'en attente'),
  noToken: both('waiting for a token', 'en attente d’un jeton'),
  tokenRefused: both(
    'waiting: token refused, leaves as soon as a new one is saved or the Test succeeds',
    'en attente : jeton refusé, part dès qu’un nouveau est enregistré ou que le test réussit',
  ),
  noPin: both('waiting for the certificate pin', 'en attente de l’épinglage du certificat'),
  pinChanged: both('not sent: the certificate changed', 'pas envoyé : le certificat a changé'),
  sent: both('sent, waiting for the read back', 'envoyé, en attente de la relecture'),
  refused: both('refused by the gateway', 'refusé par la passerelle'),
  noAnswer: both('sent without answer, sent again', 'envoyé sans réponse, renvoyé'),
  notSent: both(
    'gateway unreachable, sent again every 5 s',
    'passerelle injoignable, renvoyé toutes les 5 s',
  ),
  contradicted: both('read back not applied, sent again', 'relu non appliqué, renvoyé'),
  notApplied: both('still not applied after 4 sends', 'toujours pas appliqué après 4 envois'),
  applied: both('applied', 'appliqué'),
  done: both('taken by the gateway', 'pris par la passerelle'),
  unknown: both('unknown on the gateway', 'inconnu de la passerelle'),
};

const MAX_STATUS = 900;

const guardLine = (g, lang) => {
  const state = word(GUARD_STATES[g.state] ?? GUARD_STATES.waiting, lang);
  const reason = g.reason ? ` (${g.reason})` : '';
  const sends =
    g.sends > 0
      ? lang === 'fr'
        ? `, ${g.sends} envoi(s) répondu(s)`
        : `, ${g.sends} answered send(s)`
      : '';
  return `${g.name}: ${state}${reason}${sends}`;
};

export const T = {
  join(parts) {
    const out = {};
    for (const lang of ['en', 'fr']) {
      out[lang] = parts
        .map((p) => word(p, lang))
        .filter(Boolean)
        .join(' ')
        .slice(0, MAX_STATUS);
    }
    return out;
  },
  configUnread: (s) =>
    both(
      `The configuration could not be read from Gladys; next try in ${s} s.`,
      `La configuration n'a pas pu être lue dans Gladys ; nouvel essai dans ${s} s.`,
    ),
  configError: (code) => CONFIG_ERRORS[code] ?? CONFIG_ERRORS.invalid,
  noToken: both(
    'No token yet: click "Request access", then approve "Gladys" in the JUNG HOME app.',
    "Pas encore de jeton : cliquez sur « Demander l'accès », puis acceptez « Gladys » dans l'app JUNG HOME.",
  ),
  noPin: both(
    'The certificate of the gateway is not pinned yet: click "Test the connection" (or type its fingerprint).',
    "Le certificat de la passerelle n'est pas encore épinglé : cliquez sur « Tester la connexion » (ou saisissez son empreinte).",
  ),
  pinChanged: (fp) =>
    both(
      `The certificate of the gateway changed: nothing is sent (seen: ${fp ?? '?'}). If you replaced the gateway, click "Trust the new certificate" twice or type this fingerprint.`,
      `Le certificat de la passerelle a changé : rien n'est envoyé (vu : ${fp ?? '?'}). Si vous avez remplacé la passerelle, cliquez deux fois sur « Faire confiance au nouveau certificat » ou saisissez cette empreinte.`,
    ),
  pinNotKept: (fp) =>
    both(
      `Certificate seen (${fp}) but /data could not keep it: type this fingerprint in the configuration.`,
      `Certificat vu (${fp}) mais /data n'a pas pu le garder : saisissez cette empreinte dans la configuration.`,
    ),
  tokenRefused: both(
    'The gateway refused the token: nothing is tried again until "Request access" gives a new one or "Test the connection" succeeds.',
    "La passerelle a refusé le jeton : rien n'est réessayé tant que « Demander l'accès » n'en donne pas un nouveau ou que « Tester la connexion » ne réussit pas.",
  ),
  paused: (min) =>
    both(
      `The gateway asked to slow down (429): reads paused for about ${min} min (stops still leave).`,
      `La passerelle a demandé de ralentir (429) : lectures en pause pour environ ${min} min (les arrêts partent quand même).`,
    ),
  connecting: both('Connecting to the gateway...', 'Connexion à la passerelle...'),
  connected: (counts, live, interval) => {
    const liveText =
      {
        live: both('live updates on', 'mises à jour en direct'),
        opening: both('live updates opening', 'mises à jour en direct en cours d’ouverture'),
        down: both(
          `live updates lost, read every ${interval} s`,
          `mises à jour en direct perdues, lecture toutes les ${interval} s`,
        ),
        off: both(`read every ${interval} s`, `lecture toutes les ${interval} s`),
      }[live] ?? both('', '');
    return both(
      `Connected: ${counts.offered} functions, ${counts.scenes} scenes; ${liveText.en}.`,
      `Connecté : ${counts.offered} fonctions, ${counts.scenes} scènes ; ${liveText.fr}.`,
    );
  },
  identityMismatch: both(
    'Another gateway answers at this address (serial number changed): commands refused. "Test the connection" accepts it.',
    "Une autre passerelle répond à cette adresse (numéro de série changé) : commandes refusées. « Tester la connexion » l'accepte.",
  ),
  identityUnknown: both(
    'The serial number of the gateway could not be read yet: devices offered once it is.',
    "Le numéro de série de la passerelle n'a pas encore pu être lu : appareils proposés dès qu'il le sera.",
  ),
  identityUnverified: both(
    'Serial number not read again yet: only stops are sent.',
    'Numéro de série pas encore relu : seuls les arrêts sont envoyés.',
  ),
  failure: (err) => {
    const what = FAILURES[err?.kind] ?? both('error', 'erreur');
    if (err?.kind === 'pin') return T.pinChanged(err.fingerprint);
    return both(`Gateway: ${what.en}.`, `Passerelle : ${what.fr}.`);
  },
  guards: (list) => ({
    en: `Stops kept: ${list.map((g) => guardLine(g, 'en')).join('; ')}.`,
    fr: `Arrêts gardés : ${list.map((g) => guardLine(g, 'fr')).join(' ; ')}.`,
  }),
  invalidSockets: (list) =>
    both(
      `Not function ids in "Sockets declared safe": ${list.length} entry(ies) ignored.`,
      `Pas des identifiants de fonction dans « Prises déclarées sûres » : ${list.length} entrée(s) ignorée(s).`,
    ),
  dataUnreadable: both(
    '/data is unreadable: nothing is learnt nor kept (pin, identity, stops) this run.',
    "/data est illisible : rien n'est appris ni gardé (épingle, identité, arrêts) pendant ce lancement.",
  ),
  badge: {
    stopKept: both(
      'A stop is kept until read back applied',
      'Un arrêt est gardé jusqu’à sa relecture appliquée',
    ),
    unconfirmed: both('Last command not confirmed yet', 'Dernière commande pas encore confirmée'),
    noLive: both(
      'Live updates lost: read at the interval',
      'Mises à jour en direct perdues : lecture à l’intervalle',
    ),
  },
  denied: {
    notCommand: both(
      'This feature cannot be commanded.',
      'Cette fonctionnalité ne se commande pas.',
    ),
    badValue: both(
      'Value refused (out of bounds), nothing sent.',
      'Valeur refusée (hors bornes), rien envoyé.',
    ),
    notConfigured: both(
      'Gateway not configured (address or token): nothing sent.',
      'Passerelle non configurée (adresse ou jeton) : rien envoyé.',
    ),
    tokenRefused: both(
      'Token refused by the gateway: nothing sent.',
      'Jeton refusé par la passerelle : rien envoyé.',
    ),
    paused: both(
      'Paused after a 429 of the gateway: nothing sent.',
      'En pause après un 429 de la passerelle : rien envoyé.',
    ),
    noPin: both('Certificate not pinned: nothing sent.', 'Certificat non épinglé : rien envoyé.'),
    notConnected: both(
      'Gateway not connected: nothing sent.',
      'Passerelle non connectée : rien envoyé.',
    ),
    identityMismatch: both(
      'Another gateway answers at this address: nothing sent.',
      'Une autre passerelle répond à cette adresse : rien envoyé.',
    ),
    identityUnverified: both(
      'Serial number of the gateway not read again yet: nothing sent.',
      'Numéro de série de la passerelle pas encore relu : rien envoyé.',
    ),
    scenesOff: both(
      'JUNG HOME scenes are not allowed in the configuration: nothing sent.',
      'Les scènes JUNG HOME ne sont pas autorisées dans la configuration : rien envoyé.',
    ),
    heatingOff: both(
      'Heating setpoints are not allowed in the configuration: nothing sent.',
      'Les consignes de chauffage ne sont pas autorisées dans la configuration : rien envoyé.',
    ),
    socketNotSafe: both(
      'This socket is not declared safe: nothing sent.',
      "Cette prise n'est pas déclarée sûre : rien envoyé.",
    ),
    stopInFlight: both(
      'A stop of this device is being sent: nothing sent.',
      'Un arrêt de cet appareil est en cours d’envoi : rien envoyé.',
    ),
    tooLate: both(
      'Not sent in time (3.5 s): nothing sent.',
      'Pas envoyée à temps (3,5 s) : rien envoyé.',
    ),
    cancelled: both(
      'Cancelled by a stop that came after it: nothing sent.',
      'Annulée par un arrêt arrivé après elle : rien envoyé.',
    ),
    notSent: (reason) => both(`Nothing sent (${reason}).`, `Rien envoyé (${reason}).`),
    refused: (reason) =>
      both(`Refused by the gateway: ${reason}.`, `Refusée par la passerelle : ${reason}.`),
    sentUnconfirmed: both(
      'Sent, without confirmation: read back in 5 s.',
      'Envoyée, sans confirmation : relue dans 5 s.',
    ),
    sceneUnconfirmed: both(
      'Scene sent, without confirmation.',
      'Scène envoyée, sans confirmation.',
    ),
    notYetApplied: both(
      'Sent, not applied yet at the read back: read again in 5 s.',
      'Envoyée, pas encore appliquée à la relecture : relue dans 5 s.',
    ),
    stopKept: (g) =>
      both(
        `Stop kept, sent until applied: ${guardLine(g, 'en')}.`,
        `Arrêt gardé, envoyé jusqu’à son application : ${guardLine(g, 'fr')}.`,
      ),
  },
  register: {
    busy: both(
      'An access request is already waiting for your approval in the JUNG HOME app.',
      "Une demande d'accès attend déjà votre accord dans l'app JUNG HOME.",
    ),
    started: (pin, learnt) =>
      both(
        `${learnt ? `Certificate pinned (SHA-256 ${pin}). ` : ''}Now open the JUNG HOME app: Settings, Gateway, Access permissions, Open requests, and accept "Gladys" within 3 minutes. The status changes once accepted.`,
        `${learnt ? `Certificat épinglé (SHA-256 ${pin}). ` : ''}Ouvrez maintenant l'app JUNG HOME : Réglages, Passerelle, Autorisations d'accès, Demandes ouvertes, et acceptez « Gladys » dans les 3 minutes. Le statut change une fois accepté.`,
      ),
  },
  test: {
    noToken: (pin, learnt) =>
      both(
        `Gateway reached${learnt ? `, certificate pinned (SHA-256 ${pin})` : ''}. No token yet: click "Request access".`,
        `Passerelle jointe${learnt ? `, certificat épinglé (SHA-256 ${pin})` : ''}. Pas encore de jeton : cliquez sur « Demander l'accès ».`,
      ),
    ok: ({ pin, learnt, api, release }) =>
      both(
        `Connection OK: token accepted, gateway ${release || '?'} (API ${api || '?'})${learnt ? `, certificate pinned (SHA-256 ${pin})` : ''}.`,
        `Connexion OK : jeton accepté, passerelle ${release || '?'} (API ${api || '?'})${learnt ? `, certificat épinglé (SHA-256 ${pin})` : ''}.`,
      ),
  },
  trust: {
    same: (fp) =>
      both(
        `This certificate is already the trusted one (${fp}).`,
        `Ce certificat est déjà celui de confiance (${fp}).`,
      ),
    typed: (fp) =>
      both(
        `The fingerprint typed in the configuration is the pin: replace it with ${fp} if you trust this one.`,
        `L'empreinte saisie dans la configuration est l'épingle : remplacez-la par ${fp} si vous faites confiance à celui-ci.`,
      ),
    confirm: (fp) =>
      both(
        `The gateway shows the certificate ${fp}. Click again within 2 minutes to trust it (only if you replaced the gateway).`,
        `La passerelle présente le certificat ${fp}. Cliquez de nouveau dans les 2 minutes pour lui faire confiance (seulement si vous avez remplacé la passerelle).`,
      ),
    done: (fp) =>
      both(`New certificate trusted (${fp}).`, `Nouveau certificat de confiance (${fp}).`),
  },
};
