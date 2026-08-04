/**
 * Récupération des messages et écriture en table.
 *
 * Trois garanties, chacune couvrant une défaillance que les autres ne couvrent pas :
 *
 *   1. Lecture seule    — le dossier est ouvert en readOnly. Ni flag « lu », ni
 *                         déplacement. S'appuyer sur \Seen est le piège classique :
 *                         un commercial qui ouvre un mail dans le webmail le ferait
 *                         disparaître du traitement, sans alerte.
 *   2. Curseur UID      — on ne redemande que ce qui est nouveau.
 *   3. UIDVALIDITY      — si le serveur le change, tous les UID redeviennent
 *                         invalides. Sans ce contrôle, le curseur pointerait
 *                         au-delà des nouveaux messages et plus rien ne
 *                         remonterait, en silence. C'est le défaut du module
 *                         officiel, et la raison principale de ce plugin.
 */
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");

const FETCH_BATCH = 50;

const log = (level, msg) => {
  try {
    getState().log(level, `[imap-idle] ${msg}`);
  } catch (e) {
    console.log(`[imap-idle] ${msg}`);
  }
};

/** Construit un client ImapFlow depuis la configuration du plugin. */
const makeClient = (cfg, withLogger = false) =>
  new ImapFlow({
    host: cfg.host,
    port: cfg.port || 993,
    secure: cfg.tls !== false,
    auth: { user: cfg.username, pass: cfg.password },
    ...(withLogger ? {} : { logger: false }),
    tls: cfg.allow_self_signed ? { rejectUnauthorized: false } : undefined,
  });

/** Clé de stockage de l'UIDVALIDITY — par dossier, dans la config du tenant. */
const validityKey = (cfg) => `imap_idle_uidvalidity_${cfg.folder || "INBOX"}`;

/**
 * Dernier UID traité, lu depuis la table de destination.
 *
 * On ne tient pas de compteur séparé : la table EST le curseur. Si une ligne
 * est supprimée manuellement, le message sera relu — comportement souhaitable.
 */
const lastUid = async (cfg) => {
  const table = Table.findOne({ name: cfg.table_dest });
  if (!table) throw new Error(`table introuvable : ${cfg.table_dest}`);
  const rows = await table.getRows(
    {},
    { orderBy: cfg.f_uid || "uid", orderDesc: true, limit: 1 }
  );
  return rows.length ? Number(rows[0][cfg.f_uid || "uid"]) || 0 : 0;
};

/**
 * Vérifie l'UIDVALIDITY et retourne le curseur à utiliser.
 * Retourne 0 (tout relire) si le serveur a resynchronisé.
 */
const resolveCursor = async (client, cfg) => {
  const serverValidity = Number(client.mailbox.uidValidity);
  const state = getState();
  const stored = Number(state.getConfig(validityKey(cfg), 0));

  if (!stored) {
    await state.setConfig(validityKey(cfg), serverValidity);
    return await lastUid(cfg);
  }
  if (stored !== serverValidity) {
    log(2,
      `UIDVALIDITY changé (${stored} → ${serverValidity}) : resynchronisation. ` +
      `Les UID mémorisés ne désignent plus rien, on repart de zéro.`);
    await state.setConfig(validityKey(cfg), serverValidity);
    return 0;
  }
  return await lastUid(cfg);
};

/** Extrait les champs d'un message analysé vers une ligne de table. */
const toRow = (cfg, uid, parsed) => {
  const row = { [cfg.f_uid || "uid"]: uid };
  const put = (field, value) => {
    if (field && value !== undefined && value !== null) row[field] = value;
  };
  put(cfg.f_subject, parsed.subject || "");
  put(cfg.f_from, parsed.from?.value?.[0]?.address || parsed.from?.text || "");
  put(cfg.f_to, parsed.to?.text || "");
  put(cfg.f_date, parsed.date || new Date());
  put(cfg.f_text, parsed.text || "");
  put(cfg.f_html, parsed.html || parsed.textAsHtml || "");
  return row;
};

/**
 * Une passe de récupération. Idempotente : rejouable sans risque, le curseur
 * empêche de relire ce qui l'a déjà été.
 */
const runSync = async (cfg, onMessage) => {
  if (!cfg?.host || !cfg?.username || !cfg?.table_dest) {
    log(2, "configuration incomplète, relève ignorée");
    return { fetched: 0, inserted: 0, errors: 0 };
  }

  const client = makeClient(cfg);
  const counts = { fetched: 0, inserted: 0, errors: 0 };
  await client.connect();

  // ★ readOnly : le serveur ne posera aucun flag. La boîte du client n'est
  //   jamais modifiée, quoi qu'il arrive.
  const lock = await client.getMailboxLock(cfg.folder || "INBOX", {
    readOnly: true,
  });

  try {
    const cursor = await resolveCursor(client, cfg);
    const table = Table.findOne({ name: cfg.table_dest });

    const uids = [];
    for await (const msg of client.fetch({ uid: `${cursor + 1}:*` }, { uid: true })) {
      // « UID n:* » renvoie toujours au moins le dernier message du dossier,
      // même s'il est antérieur à n. Sans ce filtre, on relirait le dernier
      // message à chaque passage.
      if (msg.uid > cursor) uids.push(msg.uid);
    }
    if (!uids.length) return counts;

    uids.sort((a, b) => a - b);
    log(5, `${uids.length} message(s) à récupérer (UID ${uids[0]} → ${uids.at(-1)})`);

    for (let i = 0; i < uids.length; i += FETCH_BATCH) {
      for (const uid of uids.slice(i, i + FETCH_BATCH)) {
        counts.fetched++;
        try {
          const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
          if (!msg?.source) continue;
          const parsed = await simpleParser(msg.source);
          const row = toRow(cfg, uid, parsed);
          const id = await table.insertRow(row);
          counts.inserted++;

          // ★ L'événement part message par message, dès l'insertion — pas en fin
          // de lot. C'est lui qui pilote le workflow : le déclencheur sur
          // « MailRecu » reçoit l'identifiant de la ligne et enchaîne aussitôt.
          // Émettre après le lot ferait attendre le premier message la fin du
          // dernier, ce qui annulerait tout l'intérêt du temps réel.
          if (onMessage) await onMessage({ id, uid, ...row });
        } catch (e) {
          counts.errors++;
          log(2, `échec sur UID ${uid} : ${e.message}`);
        }
      }
    }
  } finally {
    lock.release();
    try {
      await client.logout();
    } catch (e) {
      /* la déconnexion peut échouer si le serveur a coupé : sans importance */
    }
  }
  log(5, `relève terminée : ${JSON.stringify(counts)}`);
  return counts;
};

/** Exécute la relève dans le bon schéma de tenant. */
const runSyncForTenant = async (cfg, tenant, onMessage) =>
  db.runWithTenant(tenant, () => runSync(cfg, onMessage));

module.exports = { runSync, runSyncForTenant, makeClient, log };
