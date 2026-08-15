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
        }


      } else {

        liste =
          t.split(
            ","
          );
      }
    }


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
