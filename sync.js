<<<<<<< HEAD
/**
 * SMTP du pipeline Sélection Habitat.
 *
 * - 1 lead = 1 seul sendMail()
 * - négociateur + secrétaire + custom en BCC
 * - transport SMTP partagé entre les leads
 * - une seule connexion active
 * - pas de retry automatique
 * - une ligne de journal par destinataire réel
 * - nom d'expéditeur facultatif
 */

const Table =
  require(
    "@saltcorn/data/models/table"
  );


const {
  getState
} =
  require(
    "@saltcorn/data/db/state"
  );


const log =
  (
    level,
    msg
  ) => {

    try {

      getState()
        .log(
          level,
          `[smtp-envoi] ${msg}`
        );

    } catch (e) {

      console.log(
        `[smtp-envoi] ${msg}`
      );
    }
  };


const contexte =
  (args) => ({

    ...(
      args &&
      args.row
        ? args.row
        : {}
    ),

    ...(
      args ||
      {}
    )

  });


/*
 * Destinataires.
 */
const normaliser =
  (
    brut,
    roleDefaut
  ) => {

    let liste =
      brut;


    if (
      typeof liste === "string"
    ) {

      const t =
        liste.trim();


      if (
        t.startsWith(
          "["
        )
      ) {

        try {

          liste =
            JSON.parse(
              t
            );

        } catch (e) {

          liste =
            t.split(
              ","
            );
=======
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const Table = require("@saltcorn/data/models/table");
const db = require("@saltcorn/data/db");

const FETCH_BATCH = 50;
const PENDING_BATCH = 25;
const INFLIGHT_TTL_MS = 10 * 60 * 1000;
const STATE_KEY = Symbol.for("saltcorn.imap-idle.global-state.v8");
const G = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
  uidValidity: new Map(),
  inFlight: new Map(),
});

const log = (level, msg) => {
  try { require("@saltcorn/data/models/eventlog").default?.log?.(level, msg); }
  catch (e) { try { console.log(`[imap-idle:${level}] ${msg}`); } catch (_) {} }
};

const makeClient = (cfg) => new ImapFlow({
  host: cfg.host,
  port: Number(cfg.port || 993),
  secure: cfg.tls !== false,
  auth: { user: cfg.username, pass: cfg.password },
  tls: { rejectUnauthorized: !cfg.allow_self_signed },
  logger: false,
});

const addrList = (x) => {
  if (!x) return "";
  if (Array.isArray(x)) return x.map(addrList).filter(Boolean).join(", ");
  if (typeof x === "string") return x;
  if (x.address) return x.name ? `${x.name} <${x.address}>` : x.address;
  if (x.value) return addrList(x.value);
  return "";
};

const lastUid = async (cfg) => {
  const table = Table.findOne({ name: cfg.table_dest });
  if (!table) throw new Error(`table destination introuvable : ${cfg.table_dest}`);
  const rows = await table.getRows({});
  let max = 0;
  for (const r of rows) {
    const n = Number(r[cfg.f_uid || "uid"]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
};

const mailboxKey = (cfg, tenant) => `${tenant || "default"}|${cfg.host}|${cfg.username}|${cfg.folder || "INBOX"}`;

/*
 * V8 — retrouver les mails dont le DERNIER état SMTP d'au moins un
 * destinataire est "echec". Cela répare aussi les messages traités par une
 * ancienne version qui aurait mis issue=TRAITE malgré un échec SMTP.
 */
const unresolvedSmtpRawIds = async () => {
  const out = new Set();
  try {
    const tN = Table.findOne({ name: "notification" });
    const tL = Table.findOne({ name: "lead" });
    if (!tN || !tL) return out;

    const notifs = await tN.getRows({});
    const latest = new Map();
    for (const n of notifs) {
      if (!n || n.lead == null || !n.destinataire) continue;
      const key = `${n.lead}|${String(n.destinataire).trim().toLowerCase()}`;
      const prev = latest.get(key);
      const ta = n.envoye_le ? new Date(n.envoye_le).getTime() : 0;
      const tb = prev && prev.envoye_le ? new Date(prev.envoye_le).getTime() : 0;
      if (!prev || ta > tb || (ta === tb && Number(n.id || 0) > Number(prev.id || 0))) latest.set(key, n);
    }

    const leadsKo = new Set();
    for (const n of latest.values()) {
      if (String(n.statut || "").toLowerCase() === "echec") leadsKo.add(Number(n.lead));
    }
    if (!leadsKo.size) return out;

    const leads = await tL.getRows({});
    for (const l of leads) {
      if (leadsKo.has(Number(l.id)) && l.email_brut != null) out.add(Number(l.email_brut));
    }
  } catch (e) {
    log(2, `détection SMTP pending impossible : ${e.message}`);
  }
  return out;
};

const terminalInfo = async (raw, smtpPending = new Set()) => {
  // Un dernier échec SMTP est prioritaire sur l'ancien marqueur TRAITE.
  if (smtpPending.has(Number(raw.id))) return null;

  const issue = String(raw.issue || "").trim().toUpperCase();
  if (["TRAITE", "NON_LEAD", "DOUTE", "QUARANTAINE"].includes(issue)) return issue;
  if (["SMTP_ECHEC", "QUARANTAINE_EN_ATTENTE", "QUARANTAINE_SMTP_ECHEC"].includes(issue)) return null;
  if (issue) return null;

  try {
    const tQ = Table.findOne({ name: "quarantaine" });
    if (tQ) {
      const q = (await tQ.getRows({ email_brut: raw.id }, { limit: 1 }))[0];
      if (q) return "QUARANTAINE";
    }
  } catch (e) {}

  try {
    const tL = Table.findOne({ name: "lead" });
    if (tL) {
      const l = (await tL.getRows({ email_brut: raw.id }, { limit: 1 }))[0];
      if (l && ["publie", "mis_a_jour"].includes(String(l.statut || "").toLowerCase())) return "TRAITE";
    }
  } catch (e) {}
  return null;
};

const payloadFromRow = (cfg, row) => ({
  id: row.id,
  uid: row[cfg.f_uid || "uid"],
  objet: row[cfg.f_subject || "objet"],
  expediteur: row[cfg.f_from || "expediteur"],
  destinataire: row[cfg.f_to || "destinataire"],
  date_envoi: row[cfg.f_date || "date_envoi"],
  corps_texte: row[cfg.f_text || "corps_texte"],
  corps_html: row[cfg.f_html || "corps_html"],
});

const emitOnce = async (cfg, tenant, row, onMessage, reason, smtpPending) => {
  const key = `${tenant || "default"}|${cfg.table_dest}|${row.id}`;
  const last = G.inFlight.get(key) || 0;
  if (Date.now() - last < INFLIGHT_TTL_MS) return false;

  const terminal = await terminalInfo(row, smtpPending);
  if (terminal) {
    if (!row.issue) {
      try {
        const t = Table.findOne({ name: cfg.table_dest });
        await t.updateRow({ issue: terminal }, row.id);
      } catch (e) {}
    }
    return false;
  }

  G.inFlight.set(key, Date.now());
  try {
    await onMessage(payloadFromRow(cfg, row));
    log(4, `${reason} : événement MailRecu émis pour ligne ${row.id}, UID ${row[cfg.f_uid || "uid"]}`);
    return true;
  } catch (e) {
    G.inFlight.delete(key);
    throw e;
  }
};

const parseMessage = async (cfg, message) => {
  const parsed = await simpleParser(message.source);
  const row = {};
  row[cfg.f_uid || "uid"] = Number(message.uid);
  row[cfg.f_subject || "objet"] = parsed.subject || message.envelope?.subject || "";
  row[cfg.f_from || "expediteur"] = parsed.from ? parsed.from.text : addrList(message.envelope?.from);
  row[cfg.f_to || "destinataire"] = parsed.to ? parsed.to.text : addrList(message.envelope?.to);
  row[cfg.f_date || "date_envoi"] = parsed.date || message.internalDate || new Date();
  row[cfg.f_text || "corps_texte"] = parsed.text || "";
  row[cfg.f_html || "corps_html"] = typeof parsed.html === "string" ? parsed.html : (parsed.html ? String(parsed.html) : "");
  return row;
};

const runSyncCore = async (cfg, onMessage, tenant) => {
  if (!cfg || !cfg.table_dest) throw new Error("configuration IMAP incomplète");
  const table = Table.findOne({ name: cfg.table_dest });
  if (!table) throw new Error(`table destination introuvable : ${cfg.table_dest}`);

  const client = makeClient(cfg);
  let inserted = 0, emitted = 0, replayed = 0;
  try {
    // Calcul une fois par relève : les anciens TRAITE+SMTP KO redeviennent replayables.
    const smtpPending = await unresolvedSmtpRawIds();

    await client.connect();
    const box = await client.mailboxOpen(cfg.folder || "INBOX", { readOnly: true });

    const key = mailboxKey(cfg, tenant);
    const validity = String(box.uidValidity || client.mailbox?.uidValidity || "");
    const previousValidity = G.uidValidity.get(key);
    const validityChanged = !!previousValidity && !!validity && previousValidity !== validity;
    if (validity) G.uidValidity.set(key, validity);

    let cursor = validityChanged ? 0 : await lastUid(cfg);
    const uidNext = Number(box.uidNext || client.mailbox?.uidNext || 0);
    if (!validityChanged && cursor > 0 && uidNext > 0 && cursor >= uidNext) {
      log(2, `séquence UID réinitialisée (cursor=${cursor}, uidNext=${uidNext}) — reprise depuis 0`);
      cursor = 0;
    }
    if (validityChanged) log(2, `UIDVALIDITY changé — reprise IMAP depuis UID 1`);

    const startUid = cursor + 1;
    if (uidNext === 0 || startUid < uidNext) {
      const range = `${startUid}:*`;
      const lot = [];
      for await (const message of client.fetch(range, {
        uid: true, source: true, envelope: true, internalDate: true
      }, { uid: true })) {
        if (!message.uid || Number(message.uid) <= cursor) continue;
        lot.push(message);
        if (lot.length >= FETCH_BATCH) {
          for (const m of lot.splice(0)) {
            const row = await parseMessage(cfg, m);
            if (!validityChanged) {
              const ex = (await table.getRows({ [cfg.f_uid || "uid"]: Number(m.uid) }, { limit: 1 }))[0];
              if (ex) continue;
            }
            const id = await table.insertRow(row);
            const saved = { id, ...row };
            inserted++;
            if (await emitOnce(cfg, tenant, saved, onMessage, "nouveau message", smtpPending)) emitted++;
          }
>>>>>>> ec056b5 (update)
        }


      } else {

        liste =
          t.split(
            ","
          );
      }
      for (const m of lot) {
        const row = await parseMessage(cfg, m);
        if (!validityChanged) {
          const ex = (await table.getRows({ [cfg.f_uid || "uid"]: Number(m.uid) }, { limit: 1 }))[0];
          if (ex) continue;
        }
        const id = await table.insertRow(row);
        const saved = { id, ...row };
        inserted++;
        if (await emitOnce(cfg, tenant, saved, onMessage, "nouveau message", smtpPending)) emitted++;
      }
    }

<<<<<<< HEAD

    if (
      !Array.isArray(
        liste
      )
    ) {

      return [];
    }


    const vus =
      new Set();


    const sortie =
      [];


    for (
      const d of liste
    ) {

      const o =
        typeof d === "string"

          ? {
              email:
                d
            }

          : (
              d ||
              {}
            );


      const email =
        String(
          o.email ||
          ""
        )
          .trim()
          .toLowerCase();


      if (
        !email ||
        !email.includes("@") ||
        vus.has(email)
      ) {

        continue;
      }


      vus.add(
        email
      );


      sortie.push({
        email,

        role:
          o.role ||
          roleDefaut ||
          "",

        user_id:
          o.user_id != null
            ? o.user_id
            : null
      });
    }


    return sortie;
  };


/*
 * HTML → texte.
 */
const enTexte =
  (html) =>
    String(
      html ||
      ""
    )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        ""
      )
      .replace(
        /<\/(p|div|li|tr|h[1-6])>/gi,
        "\n"
      )
      .replace(
        /<br\s*\/?>/gi,
        "\n"
      )
      .replace(
        /<li[^>]*>/gi,
        "- "
      )
      .replace(
        /<[^>]+>/g,
        ""
      )
      .replace(
        /&nbsp;/g,
        " "
      )
      .replace(
        /&amp;/g,
        "&"
      )
      .replace(
        /&lt;/g,
        "<"
      )
      .replace(
        /&gt;/g,
        ">"
      )
      .replace(
        /\n{3,}/g,
        "\n\n"
      )
      .trim();


/*
 * Journal.
 */
const journaliser =
  async (
    cfg,
    ligne
  ) => {

    try {

      const t =
        Table.findOne({
          name:
            cfg.table_journal ||
            "notification"
        });


      if (t) {

        await t.insertRow(
          ligne
        );
      }


    } catch (e) {

      log(
        2,
        `journalisation impossible : ${e.message}`
      );
    }
  };


const detailErreur =
  (e) => {

    const p =
      [];


    if (
      e &&
      e.code
    ) {

      p.push(
        String(
          e.code
        )
      );
    }


    if (
      e &&
      e.responseCode
    ) {

      p.push(
        `SMTP ${e.responseCode}`
      );
    }


    if (
      e &&
      e.response
    ) {

      p.push(
        String(
          e.response
        )
      );


    } else if (
      e &&
      e.message
    ) {

      p.push(
        String(
          e.message
        )
      );


    } else {

      p.push(
        String(e)
      );
    }


    return p
      .join(
        " — "
      )
      .slice(
        0,
        400
      );
  };


/*
 * Création transport.
 */
const creerTransport =
  (cfg) => {

    let nodemailer;


    try {

      nodemailer =
        require(
          "nodemailer"
        );


    } catch (e) {

      throw new Error(
        "nodemailer absent : le module n'a pas installé ses dépendances. "
        + "Désinstallez puis réinstallez smtp-envoi."
      );
    }


    return nodemailer.createTransport({

      host:
        cfg.host,

      port:
        cfg.port ||
        465,

      secure:
        cfg.tls !== false,

      auth: {
        user:
          cfg.username,

        pass:
          cfg.password
      },

      tls:
        cfg.allow_self_signed
          ? {
              rejectUnauthorized:
                false
            }
          : undefined,


      /*
       * POOL.
       *
       * Une seule connexion.
       *
       * Elle reste ouverte entre les leads.
       */
      pool:
        true,

      maxConnections:
        1,

      maxMessages:
        1000,


      /*
       * Plus de rateDelta/rateLimit.
       *
       * Il n'y a plus trois sendMail()
       * pour un lead.
       *
       * Il n'y en a qu'un.
       */
      connectionTimeout:
        15000,

      greetingTimeout:
        15000,

      socketTimeout:
        60000
    });
  };


/*
 * Utilisé par smtp_tester.
 *
 * Celui-ci reste indépendant du pool partagé.
 */
const makeTransport =
  (cfg) =>
    creerTransport(
      cfg
    );


/*
 * Pool partagé production.
 */
let transportPartage =
  null;


let signatureTransport =
  null;


const signatureCfg =
  (cfg) =>
    JSON.stringify([
      cfg.host ||
      "",

      cfg.port ||
      465,

      cfg.tls !== false,

      cfg.username ||
      "",

      cfg.password ||
      "",

      !!cfg.allow_self_signed
    ]);


const getSharedTransport =
  (cfg) => {

    const sig =
      signatureCfg(
        cfg
      );


    /*
     * Même configuration :
     * même connexion.
     */
    if (
      transportPartage &&
      signatureTransport === sig
    ) {

      return transportPartage;
    }


    /*
     * Configuration SMTP changée.
     */
    if (transportPartage) {

      try {

        transportPartage.close();

      } catch (e) {}
    }


    transportPartage =
      creerTransport(
        cfg
      );


    signatureTransport =
      sig;


    log(
      5,
      "nouveau transport SMTP partagé créé"
    );


    return transportPartage;
  };


const invaliderTransportPartage =
  (tr) => {

    if (
      !tr ||
      tr !== transportPartage
    ) {

      return;
    }


    try {

      transportPartage.close();

    } catch (e) {}


    transportPartage =
      null;


    signatureTransport =
      null;
  };


/*
 * FILE D'ENVOI.
 *
 * Plusieurs workflows peuvent arriver
 * presque simultanément.
 *
 * On ne lance pas deux transactions SMTP
 * simultanées avec le même compte.
 *
 * IMPORTANT :
 *
 * à l'intérieur d'UN lead,
 * les trois destinataires sont quand même
 * envoyés EN MÊME TEMPS via BCC.
 */
let fileEnvoi =
  Promise.resolve();


const dansFileEnvoi =
  (fn) => {

    const execution =
      fileEnvoi.then(
        fn
      );


    fileEnvoi =
      execution.catch(
        () =>
          undefined
      );


    return execution;
  };


const runSend =
  async ({
    cfg,
    cibles,
    sujet,
    corps,
    leadId,
    modeTestLocal
  }) => {


    const maintenant =
      new Date();


    const modeTest =
      cfg.mode_test === true ||
      modeTestLocal === true;


    if (
      !cibles.length
    ) {

      log(
        3,
        "aucun destinataire — envoi ignoré"
      );


      return {
        nb_envoyes:
          0,

        nb_echecs:
          0,

        erreur_envoi:
          "aucun destinataire"
      };
    }


    /*
     * Redirections de test.
     */
    const redirection = [
      ...new Set(

        String(
          cfg.redirection_test ||
          ""
        )
          .split(
            ","
          )
          .map(
            (e) =>
              e
                .trim()
                .toLowerCase()
          )
          .filter(
            (e) =>
              e.includes("@")
          )
      )
    ];


    /*
     * Mode test sans SMTP.
     */
    if (
      modeTest &&
      !redirection.length
    ) {

      for (
        const d of cibles
      ) {

        await journaliser(
          cfg,
          {
            lead:
              leadId ||
              null,

            destinataire:
              d.email,

            role:
              d.role,

            user_id:
              d.user_id,

            objet:
              sujet,

            statut:
              "simule",

            erreur:
              "",

            envoye_le:
              maintenant
          }
        );
      }


      return {
        nb_envoyes:
          0,

        nb_simules:
          cibles.length,

        nb_echecs:
          0,

        erreur_envoi:
          "",

        apercu_destinataires:
          cibles
            .map(
              (d) =>
                d.email
            )
            .join(
              ", "
            )
      };
    }


    /*
     * Nom expéditeur facultatif.
     */
    const expediteur =
      cfg.from_nom &&
      String(
        cfg.from_nom
      ).trim()

        ? {
            name:
              String(
                cfg.from_nom
              ).trim(),

            address:
              cfg.from_email
          }

        : cfg.from_email;


    /*
     * Production :
     *
     * négociateur
     * secrétaire
     * custom
     *
     * sont TOUS dans ce tableau.
     */
    const destinatairesSmtp =
      modeTest &&
      redirection.length

        ? redirection

        : cibles.map(
            (d) =>
              d.email
          );


    let info =
      null;


    let erreurGlobale =
      "";


    try {

      info =
        await dansFileEnvoi(

          async () => {

            const tr =
              getSharedTransport(
                cfg
              );


            try {

              /*
               * UN SEUL SMTP POUR LE LEAD.
               */
              return await tr.sendMail({

                from:
                  expediteur,


                /*
                 * LES 3 EN MÊME TEMPS.
                 *
                 * Ils ne voient pas
                 * les autres adresses.
                 */
                bcc:
                  destinatairesSmtp,


                subject:
                  sujet ||
                  "(sans objet)",


                html:
                  corps ||
                  "<p>(corps vide)</p>",


                text:
                  enTexte(
                    corps
                  ) ||
                  "(corps vide)",


                ...(
                  modeTest &&
                  redirection.length

                    ? {
                        headers: {

                          "X-Destinataires-Reels":
                            cibles
                              .map(
                                (d) =>
                                  d.email
                              )
                              .join(
                                ","
                              ),

                          "X-Mode-Test":
                            "1"
                        }
                      }

                    : {}
                )
              });


            } catch (e) {

              /*
               * PAS DE RETRY.
               *
               * Si la connexion est morte,
               * le prochain lead créera un nouveau pool.
               */
              invaliderTransportPartage(
                tr
              );


              throw e;
            }
          }
        );


    } catch (e) {

      erreurGlobale =
        detailErreur(
          e
        );


      log(
        2,
        `échec SMTP groupé : ${erreurGlobale}`
      );
    }


    /*
     * L'unique transaction SMTP a échoué.
     *
     * Donc aucun des trois n'a reçu le message.
     */
    if (!info) {

      for (
        const d of cibles
      ) {

        await journaliser(
          cfg,
          {
            lead:
              leadId ||
              null,

            destinataire:
              d.email,

            role:
              d.role,

            user_id:
              d.user_id,

            objet:
              sujet,

            statut:
              "echec",

            erreur:
              erreurGlobale,

            envoye_le:
              maintenant
          }
        );
      }


      return {
        nb_envoyes:
          0,

        nb_echecs:
          cibles.length,

        erreur_envoi:
          erreurGlobale
      };
    }


    /*
     * Redirection test réussie.
     */
    if (
      modeTest &&
      redirection.length
    ) {

      const vers =
        redirection.join(
          ", "
        );


      for (
        const d of cibles
      ) {

        await journaliser(
          cfg,
          {
            lead:
              leadId ||
              null,

            destinataire:
              d.email,

            role:
              d.role,

            user_id:
              d.user_id,

            objet:
              sujet,

            statut:
              "redirige",

            erreur:
              `redirigé vers ${vers}`,

            envoye_le:
              maintenant
          }
        );
      }


      return {
        nb_envoyes:
          cibles.length,

        nb_echecs:
          0,

        erreur_envoi:
          ""
      };
    }


    /*
     * Rejets SMTP individuels.
     */
    const rejetes =
      new Set(
        (
          info.rejected ||
          []
        )
          .map(
            (x) =>
              String(x)
                .trim()
                .toLowerCase()
          )
      );


    let envoyes =
      0;


    let echecs =
      0;


    const erreurs =
      [];


    for (
      const d of cibles
    ) {

      const email =
        String(
          d.email
        )
          .trim()
          .toLowerCase();


      const rejete =
        rejetes.has(
          email
        );


      const statut =
        rejete
          ? "echec"
          : "envoye";


      const erreur =
        rejete
          ? "adresse rejetée par le serveur SMTP"
          : "";


      if (rejete) {

        echecs++;


        erreurs.push(
          `${d.email} → ${erreur}`
        );


      } else {

        envoyes++;
      }


      /*
       * Une ligne dans notification
       * pour chaque destinataire réel.
       */
      await journaliser(
        cfg,
        {
          lead:
            leadId ||
            null,

          destinataire:
            d.email,

          role:
            d.role,

          user_id:
            d.user_id,

          objet:
            sujet,

          statut,

          erreur,

          envoye_le:
            maintenant
        }
      );
    }


    log(
      5,
      `envoi groupé terminé : ${envoyes} envoyé(s), ${echecs} échec(s)`
    );


    return {
      nb_envoyes:
        envoyes,

      nb_echecs:
        echecs,

      erreur_envoi:
        erreurs.join(
          " | "
        )
    };
  };


module.exports = {
  runSend,
  makeTransport,
  normaliser,
  contexte,
  enTexte,
  log
};
=======
    const rows = await table.getRows({});
    const candidats = rows
      .filter((r) => {
        const issue = String(r.issue || "").trim().toUpperCase();
        return smtpPending.has(Number(r.id)) || !issue ||
          ["SMTP_ECHEC", "QUARANTAINE_EN_ATTENTE", "QUARANTAINE_SMTP_ECHEC"].includes(issue);
      })
      // Les plus anciens pending d'abord, pour ne pas affamer un échec SMTP.
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, PENDING_BATCH);

    for (const r of candidats) {
      if (await emitOnce(cfg, tenant, r, onMessage,
        smtpPending.has(Number(r.id)) ? "rejeu echec SMTP" : "rejeu pending",
        smtpPending)) replayed++;
    }

    return { inserted, emitted, replayed, smtp_pending: smtpPending.size };
  } finally {
    try { await client.logout(); } catch (e) {}
  }
};

const runSync = async (cfg, onMessage) => runSyncCore(cfg, onMessage, db.getTenantSchema());
const runSyncForTenant = async (cfg, tenant, onMessage) =>
  db.runWithTenant(tenant, async () => runSyncCore(cfg, onMessage, tenant));

module.exports = { runSync, runSyncForTenant, makeClient, log };
>>>>>>> ec056b5 (update)
