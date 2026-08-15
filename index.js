/**
 * imap-idle V19 DIAGNOSTIC LOADER
 * Purpose: prove whether Saltcorn reaches _loadMainFile/registerPlugin.
 * IMPORTANT: intentionally ZERO external dependencies and ZERO IMAP runtime code.
 */
console.log("### AMBS IMAP V19 DIAGNOSTIC MODULE EVALUATED - plugin_name=imap-idle ###");

const configuration_workflow = () => {
  console.log("### AMBS IMAP V19 configuration_workflow CALLED ###");
  const Workflow = require("@saltcorn/data/models/workflow");
  const Form = require("@saltcorn/data/models/form");

  return new Workflow({
    steps: [
      {
        name: "Compte IMAP",
        form: () =>
          new Form({
            fields: [
              { name: "host", label: "Serveur IMAP", type: "String", required: true },
              { name: "port", label: "Port", type: "Integer", default: 993 },
              { name: "tls", label: "TLS", type: "Bool", default: true },
              { name: "username", label: "Identifiant", type: "String", required: true },
              {
                name: "password",
                label: "Mot de passe",
                type: "String",
                input_type: "password",
                required: true
              },
              { name: "folder", label: "Dossier", type: "String", default: "INBOX" },
              {
                name: "allow_self_signed",
                label: "Accepter un certificat auto-signé",
                type: "Bool",
                default: false
              }
            ]
          })
      },
      {
        name: "Table et champs",
        form: async () => {
          const Table = require("@saltcorn/data/models/table");
          const tables = await Table.find({}, { cached: true });
          return new Form({
            fields: [
              {
                name: "table_dest",
                label: "Table de destination",
                input_type: "select",
                required: true,
                options: tables.map((t) => t.name)
              },
              { name: "f_uid", label: "Champ UID", type: "String", default: "uid", required: true },
              { name: "f_subject", label: "Champ objet", type: "String", default: "objet" },
              { name: "f_from", label: "Champ expéditeur", type: "String", default: "expediteur" },
              { name: "f_to", label: "Champ destinataire", type: "String", default: "destinataire" },
              { name: "f_date", label: "Champ date", type: "String", default: "date_envoi" },
              { name: "f_text", label: "Champ corps texte", type: "String", default: "corps_texte" },
              { name: "f_html", label: "Champ corps HTML", type: "String", default: "corps_html" }
            ]
          });
        }
      },
      {
        name: "Temps réel",
        form: () =>
          new Form({
            fields: [
              { name: "idle_enabled", label: "Activer le temps réel (IDLE)", type: "Bool", default: true },
              { name: "idle_renew_s", label: "Renouvellement IDLE (s)", type: "Integer", default: 240 },
              { name: "safety_poll_s", label: "Relève de secours (s)", type: "Integer", default: 300 },
              { name: "reconnect_s", label: "Délai avant reconnexion (s)", type: "Integer", default: 30 }
            ]
          })
      }
    ]
  });
};

const onLoad = async (configuration) => {
  console.log(
    "### AMBS IMAP V19 onLoad CALLED ###",
    configuration && typeof configuration === "object"
      ? Object.keys(configuration)
      : []
  );
};

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "imap-idle",
  configuration_workflow,
  onLoad
};
