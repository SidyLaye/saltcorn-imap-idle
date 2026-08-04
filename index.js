/**
 * imap-idle — relève IMAP en temps réel pour Saltcorn.
 *
 * Le module officiel `imap` fait du polling : on l'appelle, il récupère, il
 * s'arrête. Ce plugin maintient une connexion **IDLE** ouverte : le serveur
 * prévient dès qu'un message arrive, et la ligne est écrite en table dans la
 * seconde.
 *
 * Deux mécanismes, et le second n'est pas de la redondance :
 *
 *   • IDLE            — le temps réel.
 *   • Relève de secours — une passe périodique. Une connexion IDLE peut tomber
 *                         sans bruit : coupure réseau, redémarrage du serveur,
 *                         pare-feu qui coupe une session jugée inactive. Le
 *                         service continuerait de tourner sans plus rien
 *                         recevoir, et **aucune alerte ne se déclencherait**.
 */
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const Trigger = require("@saltcorn/data/models/trigger");
const db = require("@saltcorn/data/db");
const cluster = require("cluster");

const { runSync, runSyncForTenant, makeClient, log } = require("./sync");

// Une supervision par tenant : plusieurs clients peuvent coexister sur la même
// instance, chacun avec sa boîte.
const supervisors = new Map();

// ── Configuration ────────────────────────────────────────────────────
const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Compte IMAP",
        form: () =>
          new Form({
            fields: [
              { name: "host", label: "Serveur IMAP", type: "String", required: true,
                sublabel: "Nom du serveur seul, sans https:// ni port" },
              { name: "port", label: "Port", type: "Integer", default: 993 },
              { name: "tls", label: "TLS", type: "Bool", default: true,
                sublabel: "À cocher avec le port 993" },
              { name: "username", label: "Identifiant", type: "String", required: true },
              { name: "password", label: "Mot de passe", type: "String",
                input_type: "password", required: true,
                sublabel: "⚠ stocké en base : à prendre en compte côté RGPD" },
              { name: "folder", label: "Dossier", type: "String", default: "INBOX" },
              { name: "allow_self_signed", label: "Accepter un certificat auto-signé",
                type: "Bool", default: false },
            ],
          }),
      },
      {
        name: "Table et champs",
        form: async () => {
          const tables = await Table.find({}, { cached: true });
          return new Form({
            fields: [
              { name: "table_dest", label: "Table de destination", input_type: "select",
                required: true, options: tables.map((t) => t.name) },
              { name: "f_uid", label: "Champ UID", type: "String", default: "uid",
                required: true,
                sublabel: "Doit être de type Integer — c'est le curseur de lecture" },
              { name: "f_subject", label: "Champ objet", type: "String", default: "objet" },
              { name: "f_from", label: "Champ expéditeur", type: "String",
                default: "expediteur" },
              { name: "f_to", label: "Champ destinataire", type: "String",
                default: "destinataire" },
              { name: "f_date", label: "Champ date", type: "String", default: "date_envoi",
                sublabel: "Doit être de type Date" },
              { name: "f_text", label: "Champ corps texte", type: "String",
                default: "corps_texte" },
              { name: "f_html", label: "Champ corps HTML", type: "String",
                default: "corps_html", sublabel: "Doit être de type HTML" },
            ],
          });
        },
      },
      {
        name: "Temps réel",
        form: () =>
          new Form({
            fields: [
              { name: "idle_enabled", label: "Activer le temps réel (IDLE)",
                type: "Bool", default: true },
              { name: "idle_renew_s", label: "Renouvellement IDLE (s)",
                type: "Integer", default: 240,
                sublabel: "La RFC 2177 impose de relancer avant 29 min. 240 s "
                        + "traverse aussi les pare-feux agressifs." },
              { name: "safety_poll_s", label: "Relève de secours (s)",
                type: "Integer", default: 300,
                sublabel: "Filet si la connexion IDLE tombe sans bruit. "
                        + "Mettre 0 pour désactiver — déconseillé." },
              { name: "reconnect_s", label: "Délai avant reconnexion (s)",
                type: "Integer", default: 30 },
            ],
          }),
      },
    ],
  });

// ── Supervision d'une connexion IDLE ─────────────────────────────────
class IdleSupervisor {
  constructor(cfg, tenant) {
    this.cfg = cfg;
    this.tenant = tenant;
    this.stopped = false;
    this.client = null;
    this.timer = null;
    this.busy = false;
  }

  async start() {
    // Rattrapage au démarrage : ce qui est arrivé pendant l'arrêt.
    await this.sync("démarrage");

    if (this.cfg.safety_poll_s > 0) {
      this.timer = setInterval(
        () => this.sync("relève de secours"),
        this.cfg.safety_poll_s * 1000
      );
    }
    if (this.cfg.idle_enabled !== false) this.loop();
  }

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
          Trigger.emitEvent(
            "MailRecu",
            this.cfg.folder || "INBOX",
            null,
            payload
          );
        });
      };

      const counts = await runSyncForTenant(this.cfg, this.tenant, emit);
      if (counts.inserted)
        log(4, `${cause} : ${counts.inserted} message(s) enregistré(s)`);
    } catch (e) {
      log(2, `${cause} en échec : ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Boucle IDLE : se reconnecte indéfiniment tant qu'on ne l'arrête pas. */
  async loop() {
    while (!this.stopped) {
      try {
        const client = makeClient(this.cfg);
        this.client = client;
        await client.connect();
        // readOnly : aucun flag posé, la boîte du client reste intacte.
        await client.mailboxOpen(this.cfg.folder || "INBOX", { readOnly: true });
        log(4, `IDLE actif sur ${this.cfg.folder || "INBOX"}`);

        client.on("exists", () => {
          // Le serveur signale un nouveau message. On récupère hors de ce
          // callback pour ne pas bloquer la connexion IDLE.
          setImmediate(() => this.sync("notification IDLE"));
        });
        client.on("error", (e) => log(2, `erreur IDLE : ${e.message}`));

        // idle() rend la main au renouvellement ou à la rupture de connexion.
        while (!this.stopped) {
          await client.idle({ maxIdleTime: (this.cfg.idle_renew_s || 240) * 1000 });
        }
        await client.logout();
      } catch (e) {
        if (this.stopped) return;
        const wait = (this.cfg.reconnect_s || 30) * 1000;
        log(2, `connexion IDLE perdue (${e.message}) — nouvelle tentative dans `
              + `${wait / 1000} s. La relève de secours prend le relais entre-temps.`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      await this.client?.logout();
    } catch (e) {
      /* connexion déjà fermée */
    }
  }
}

// ── Cycle de vie ─────────────────────────────────────────────────────
const onLoad = async (cfg) => {
  const tenant = db.getTenantSchema();

  // Arrêt de la supervision précédente : onLoad est rappelé à chaque
  // modification de configuration. Sans cela, les connexions s'empileraient.
  const previous = supervisors.get(tenant);
  if (previous) await previous.stop();
  supervisors.delete(tenant);

  if (!cfg?.host || !cfg?.username || !cfg?.table_dest) return;

  // Une seule connexion par tenant. Sans ce test, chaque worker du cluster
  // ouvrirait la sienne et le même message serait traité N fois.
  if (cluster.isWorker) return;

  const sup = new IdleSupervisor(cfg, tenant);
  supervisors.set(tenant, sup);
  sup.start().catch((e) => log(1, `démarrage impossible : ${e.message}`));
};

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "imap-idle",
  configuration_workflow,
  onLoad,

  // Déclaré par le plugin, donc disponible dans la liste des événements sans
  // avoir à le créer à la main. Le canal est le dossier surveillé.
  //
  // Charge utile reçue par le déclencheur :
  //   { id, uid, objet, expediteur, destinataire, date_envoi, corps_texte, corps_html }
  eventTypes: () => ({ MailRecu: { hasChannel: true } }),

  actions: (cfg) => ({
    // Relève manuelle, utilisable dans un déclencheur Often en complément,
    // ou depuis un bouton pour tester.
    imap_idle_sync: {
      configFields: [],
      run: async () => {
        const tenant = db.getTenantSchema();
        return await runSync(cfg, async (payload) => {
          await db.runWithTenant(tenant, async () => {
            Trigger.emitEvent("MailRecu", cfg.folder || "INBOX", null, payload);
          });
        });
      },
    },
  }),
};
