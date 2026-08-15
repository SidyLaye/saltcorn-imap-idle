/**
 * smtp-envoi — plugin SMTP du pipeline Sélection Habitat.
 *
 * send.js gère le transport et l'envoi.
 * index.js expose la configuration et les actions Saltcorn.
 */

const Workflow =
  require(
    "@saltcorn/data/models/workflow"
  );

const Form =
  require(
    "@saltcorn/data/models/form"
  );

const Table =
  require(
    "@saltcorn/data/models/table"
  );

const {
  runSend,
  makeTransport,
  normaliser,
  contexte,
  log
} =
  require(
    "./send"
  );


const configuration_workflow =
  () =>
    new Workflow({

      steps: [

        {
          name:
            "Serveur SMTP",

          form:
            () =>
              new Form({

                blurb:
                  "OVH mutualisé : ssl0.ovh.net, port 465, TLS coché. "
                  + "OVH Exchange : ex.mail.ovh.net. "
                  + "L'identifiant est l'adresse e-mail COMPLÈTE.",

                fields: [

                  {
                    name:
                      "host",

                    label:
                      "Serveur SMTP",

                    type:
                      "String",

                    required:
                      true,

                    default:
                      "ssl0.ovh.net",

                    sublabel:
                      "Nom du serveur seul, sans https:// ni port"
                  },

                  {
                    name:
                      "port",

                    label:
                      "Port",

                    type:
                      "Integer",

                    default:
                      465,

                    sublabel:
                      "465 avec TLS coché, ou 587 décoché (STARTTLS)"
                  },

                  {
                    name:
                      "tls",

                    label:
                      "TLS",

                    type:
                      "Bool",

                    default:
                      true,

                    sublabel:
                      "À cocher avec le port 465"
                  },

                  {
                    name:
                      "username",

                    label:
                      "Identifiant",

                    type:
                      "String",

                    required:
                      true,

                    sublabel:
                      "L'adresse e-mail complète"
                  },

                  {
                    name:
                      "password",

                    label:
                      "Mot de passe",

                    type:
                      "String",

                    input_type:
                      "password",

                    required:
                      true,

                    sublabel:
                      "Mot de passe du compte SMTP"
                  },

                  {
                    name:
                      "from_email",

                    label:
                      "Adresse expéditrice",

                    type:
                      "String",

                    required:
                      true,

                    sublabel:
                      "Adresse utilisée dans From. En général identique à l'identifiant SMTP."
                  },

                  /*
                   * NOM FACULTATIF.
                   */
                  {
                    name:
                      "from_nom",

                    label:
                      "Nom affiché (optionnel)",

                    type:
                      "String",

                    default:
                      "",

                    sublabel:
                      "Facultatif. Si vide, seule l'adresse expéditrice est utilisée."
                  },

                  {
                    name:
                      "allow_self_signed",

                    label:
                      "Accepter un certificat auto-signé",

                    type:
                      "Bool",

                    default:
                      false
                  }

                ]
              })
        },


        {
          name:
            "Journal et mode test",

          form:
            async () => {

<<<<<<< HEAD
              const tables =
                await Table.find(
                  {},
                  {
                    cached:
                      true
                  }
                );

=======
  /** Une relève, protégée contre le recouvrement. */
  async sync(cause) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      // ★ Un événement par message, émis dès son insertion.
      //
      // C'est « MailRecu » qui pilote la chaîne de traitement, pas le
      // déclencheur Insert de la table. Deux raisons :
      //
      //   • L'événement porte une charge utile explicite (identifiant de ligne,
      //     expéditeur, objet) : le déclencheur sait exactement sur quoi
      //     travailler, sans relire la table.
      //   • Le canal est le dossier surveillé. Le jour où plusieurs boîtes sont
      //     relevées, un déclencheur peut ne réagir qu'à l'une d'elles, sans
      //     filtrer dans le code.
      const emit = async (payload) => {
        await db.runWithTenant(this.tenant, async () => {
          return await Trigger.emitEvent(
            "MailRecu",
            this.cfg.folder || "INBOX",
            null,
            payload
          );
        });
      };

      const counts = await runSyncForTenant(this.cfg, this.tenant, emit);
      if (counts.inserted || counts.emitted || counts.replayed)
        log(4, `${cause} : ${counts.inserted || 0} enregistré(s), `
          + `${counts.emitted || 0} événement(s) nouveau(x), `
          + `${counts.replayed || 0} rejeu(x) pending`);
    } catch (e) {
      log(2, `${cause} en échec : ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
>>>>>>> ec056b5 (update)

              return new Form({

                fields: [

                  {
                    name:
                      "table_journal",

                    label:
                      "Table de journalisation",

                    input_type:
                      "select",

                    required:
                      true,

                    options:
                      tables.map(
                        (t) =>
                          t.name
                      ),

                    sublabel:
                      "Attendue : notification. Colonnes : lead, destinataire, role, user_id, objet, statut, erreur, envoye_le"
                  },

                  {
                    name:
                      "redirection_test",

                    label:
                      "Adresses de redirection (mode test)",

                    type:
                      "String",

                    default:
                      "",

                    sublabel:
                      "Séparées par des virgules. En mode test, le message groupé part vers ces adresses au lieu des vrais destinataires. Vide = simulation pure."
                  },

                  {
                    name:
                      "mode_test",

                    label:
                      "MODE TEST — ne pas écrire aux vrais destinataires",

                    type:
                      "Bool",

                    default:
                      true,

                    sublabel:
                      "Coché + redirection vide : aucun SMTP. Coché + redirection : envoi vers les adresses de test. Décoché : production."
                  }

                ]
              });
            }
        }

      ]
    });


module.exports = {
<<<<<<< HEAD

  sc_plugin_api_version:
    1,

=======
  sc_plugin_api_version: 1,
  plugin_name: "imap-idle",
  version: "8.0.0",
>>>>>>> ec056b5 (update)
  configuration_workflow,


<<<<<<< HEAD
  actions:
    (cfg) => ({


      smtp_envoi_lead: {

        configFields: [

          {
            name:
              "cle_destinataires",

            label:
              "Variable — destinataires",

            type:
              "String",

            default:
              "destinataires_prevus",

            sublabel:
              "Tableau [{email, role, user_id}], ou liste d'adresses"
          },

          {
            name:
              "cle_sujet",

            label:
              "Variable — objet",

            type:
              "String",

            default:
              "sujet"
          },

          {
            name:
              "cle_corps",

            label:
              "Variable — corps HTML",

            type:
              "String",

            default:
              "corpsMail"
          },

          {
            name:
              "cle_lead",

            label:
              "Variable — id du lead",

            type:
              "String",

            default:
              "lead"
          },

          {
            name:
              "cle_mode_test",

            label:
              "Variable — mode test local",

            type:
              "String",

            default:
              "mode_test"
          },

          {
            name:
              "role_defaut",

            label:
              "Rôle par défaut",

            type:
              "String",

            default:
              "negociateur"
          }

        ],


        run:
          async (args) => {

            try {

              const ctx =
                contexte(args);


              const c =
                args.configuration ||
                {};


              return await runSend({

                cfg,

                cibles:
                  normaliser(
                    ctx[
                      c.cle_destinataires ||
                      "destinataires_prevus"
                    ],
                    c.role_defaut ||
                    "negociateur"
                  ),

                sujet:
                  ctx[
                    c.cle_sujet ||
                    "sujet"
                  ] ||
                  "Nouveau lead",

                corps:
                  ctx[
                    c.cle_corps ||
                    "corpsMail"
                  ],

                leadId:
                  ctx[
                    c.cle_lead ||
                    "lead"
                  ],

                modeTestLocal:
                  c.cle_mode_test
                    ? ctx[
                        c.cle_mode_test
                      ] === true
                    : false
              });


            } catch (e) {


              log(
                1,
                `exception dans smtp_envoi_lead : ${e.message}`
              );


              return {
                nb_envoyes:
                  0,

                erreur_envoi:
                  `exception : ${e.message}`
              };
            }
          }
      },


      smtp_envoi_quarantaine: {

        configFields: [

          {
            name:
              "cle_motif",

            label:
              "Variable — motif",

            type:
              "String",

            default:
              "motif_quarantaine"
          },

          {
            name:
              "cle_email_id",

            label:
              "Variable — id e-mail source",

            type:
              "String",

            default:
              "email_id"
          },

          {
            name:
              "cle_reference",

            label:
              "Variable — référence extraite",

            type:
              "String",

            default:
              "reference"
          },

          {
            name:
              "cle_mode_test",

            label:
              "Variable — mode test local",

            type:
              "String",

            default:
              "mode_test"
          }

        ],


        run:
          async (args) => {

            try {

              const ctx =
                contexte(args);


              const c =
                args.configuration ||
                {};


              const motif =
                ctx[
                  c.cle_motif ||
                  "motif_quarantaine"
                ] ||
                "non précisé";


              const emailId =
                ctx[
                  c.cle_email_id ||
                  "email_id"
                ] ||
                "?";


              const ref =
                ctx[
                  c.cle_reference ||
                  "reference"
                ] ||
                "";


              const tDest =
                Table.findOne({
                  name:
                    "destinataire_custom"
                });


              const rows =
                tDest
                  ? await tDest.getRows({
                      portee:
                        "tous",

                      actif:
                        true
                    })
                  : [];


              return await runSend({

                cfg,

                cibles:
                  normaliser(
                    rows.map(
                      (r) =>
                        r.email
                    ),
                    "quarantaine"
                  ),

                sujet:
                  `[QUARANTAINE] e-mail ${emailId} — ${motif}`,

                corps:
                  `<p>Un e-mail n'a pas pu être traité automatiquement.</p><ul>`
                  + `<li><b>Motif :</b> ${motif}</li>`
                  + `<li><b>Référence extraite :</b> ${ref || "(aucune)"}</li>`
                  + `<li><b>E-mail source :</b> ${emailId}</li></ul>`
                  + `<p><b>Aucune écriture n'a été faite dans Immofacile.</b> Ce lead doit être traité à la main.</p>`,

                leadId:
                  null,

                modeTestLocal:
                  c.cle_mode_test
                    ? ctx[
                        c.cle_mode_test
                      ] === true
                    : false
              });


            } catch (e) {


              log(
                1,
                `exception dans smtp_envoi_quarantaine : ${e.message}`
              );


              return {
                nb_envoyes:
                  0,

                erreur_envoi:
                  `exception : ${e.message}`
              };
            }
          }
      },


      smtp_tester: {

        configFields: [

          {
            name:
              "adresse_test",

            label:
              "Envoyer à",

            type:
              "String",

            required:
              true,

            sublabel:
              "Une adresse que vous relevez vous-même"
          }

        ],


        run:
          async (args) => {

            const dest =
              (
                args.configuration ||
                {}
              ).adresse_test;


            try {

              const tr =
                makeTransport(
                  cfg
                );


              await tr.verify();


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


              await tr.sendMail({

                from:
                  expediteur,

                to:
                  dest,

                subject:
                  "Test SMTP — pipeline Sélection Habitat",

                html:
                  "<p>Si vous lisez ceci, l'envoi fonctionne.</p>",

                text:
                  "Si vous lisez ceci, l'envoi fonctionne."
              });


              try {
                tr.close();
              } catch (e) {}


              log(
                4,
                `test SMTP réussi vers ${dest}`
              );


              return {
                notify:
                  `✔ Envoyé à ${dest}. Vérifiez aussi le dossier spam.`
              };


            } catch (e) {


              log(
                2,
                `test SMTP en échec : ${e.message}`
              );


              return {
                error:
                  `✘ ${e.message}\n\n`
                  + `ETIMEDOUT / ESOCKET → port sortant bloqué ou serveur indisponible.\n`
                  + `EAUTH / 454 → authentification SMTP refusée ou temporairement limitée.\n`
                  + `wrong version number → vérifier port/TLS.`
              };
            }
          }
      }

    })
};
=======
  actions: (cfg) => ({
    // Relève manuelle, utilisable dans un déclencheur Often en complément,
    // ou depuis un bouton pour tester.
    imap_idle_sync: {
      configFields: [],
      run: async () => {
        const tenant = db.getTenantSchema();
        return await runSync(cfg, async (payload) => {
          await db.runWithTenant(tenant, async () => {
            return await Trigger.emitEvent("MailRecu", cfg.folder || "INBOX", null, payload);
          });
        });
      },
    },
  }),
};
>>>>>>> ec056b5 (update)
