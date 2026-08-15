/**
 * imap-idle V11 — plugin Saltcorn pour la relève Sélection Habitat.
 *
 * POINT IMPORTANT V11 : ./sync, imapflow et mailparser ne sont pas chargés au
 * chargement initial du plugin. La configuration (engrenage), MailRecu et les
 * actions restent donc enregistrés même si une dépendance IMAP est absente.
 */
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const Trigger = require("@saltcorn/data/models/trigger");
const db = require("@saltcorn/data/db");
const cluster = require("cluster");

const supervisors = new Map();

const safeLog = (level, msg) => {
  try {
    const { getState } = require("@saltcorn/data/db/state");
    getState().log(level, `[imap-idle] ${msg}`);
  } catch (_) {
    try { console.log(`[imap-idle:${level}] ${msg}`); } catch (_) {}
  }
};

const loadSync = () => {
  try {
    return require("./sync");
  } catch (e) {
    throw new Error(
      "imap-idle est chargé, mais son moteur de relève est indisponible : " +
      (e && e.message ? e.message : String(e))
    );
  }
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Compte IMAP",
        form: () => new Form({ fields: [
          { name: "host", label: "Serveur IMAP", type: "String", required: true,
            sublabel: "Nom du serveur seul, sans https:// ni port" },
          { name: "port", label: "Port", type: "Integer", default: 993 },
          { name: "tls", label: "TLS", type: "Bool", default: true },
          { name: "username", label: "Identifiant", type: "String", required: true },
          { name: "password", label: "Mot de passe", type: "String",
            input_type: "password", required: true },
          { name: "folder", label: "Dossier", type: "String", default: "INBOX" },
          { name: "allow_self_signed", label: "Accepter un certificat auto-signé",
            type: "Bool", default: false },
        ] }),
      },
      {
        name: "Table et champs",
        form: async () => {
          const tables = await Table.find({}, { cached: true });
          return new Form({ fields: [
            { name: "table_dest", label: "Table de destination", input_type: "select",
              required: true, options: tables.map((t) => t.name) },
            { name: "f_uid", label: "Champ UID", type: "String", default: "uid", required: true },
            { name: "f_subject", label: "Champ objet", type: "String", default: "objet" },
            { name: "f_from", label: "Champ expéditeur", type: "String", default: "expediteur" },
            { name: "f_to", label: "Champ destinataire", type: "String", default: "destinataire" },
            { name: "f_date", label: "Champ date", type: "String", default: "date_envoi" },
            { name: "f_text", label: "Champ corps texte", type: "String", default: "corps_texte" },
            { name: "f_html", label: "Champ corps HTML", type: "String", default: "corps_html" },
          ] });
        },
      },
      {
        name: "Temps réel",
        form: () => new Form({ fields: [
          { name: "idle_enabled", label: "Activer le temps réel (IDLE)", type: "Bool", default: true },
          { name: "idle_renew_s", label: "Renouvellement IDLE (s)", type: "Integer", default: 240 },
          { name: "safety_poll_s", label: "Relève de secours (s)", type: "Integer", default: 300 },
          { name: "reconnect_s", label: "Délai avant reconnexion (s)", type: "Integer", default: 30 },
        ] }),
      },
    ],
  });

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
    await this.sync("démarrage");
    if (Number(this.cfg.safety_poll_s || 0) > 0) {
      this.timer = setInterval(
        () => this.sync("relève de secours"),
        Number(this.cfg.safety_poll_s) * 1000
      );
    }
    if (this.cfg.idle_enabled !== false) this.loop().catch((e) => safeLog(1, e.message));
  }

  async emit(payload) {
    return await db.runWithTenant(this.tenant, async () =>
      await Trigger.emitEvent("MailRecu", this.cfg.folder || "INBOX", null, payload)
    );
  }

  async sync(cause) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const sync = loadSync();
      const counts = await sync.runSyncForTenant(this.cfg, this.tenant, (p) => this.emit(p));
      if (counts.inserted || counts.emitted || counts.replayed) {
        safeLog(4, `${cause} : ${counts.inserted || 0} enregistré(s), ` +
          `${counts.emitted || 0} nouveau(x), ${counts.replayed || 0} rejeu(x)`);
      }
    } catch (e) {
      safeLog(2, `${cause} en échec : ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  async loop() {
    while (!this.stopped) {
      let client = null;
      try {
        const sync = loadSync();
        client = sync.makeClient(this.cfg);
        this.client = client;
        await client.connect();
        await client.mailboxOpen(this.cfg.folder || "INBOX", { readOnly: true });
        safeLog(4, `IDLE actif sur ${this.cfg.folder || "INBOX"}`);
        client.on("exists", () => setImmediate(() => this.sync("notification IDLE")));
        client.on("error", (e) => safeLog(2, `erreur IDLE : ${e.message}`));

        while (!this.stopped) {
          await client.idle({ maxIdleTime: Number(this.cfg.idle_renew_s || 240) * 1000 });
        }
      } catch (e) {
        if (this.stopped) break;
        const wait = Number(this.cfg.reconnect_s || 30) * 1000;
        safeLog(2, `connexion IDLE perdue (${e.message}) — nouvelle tentative dans ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      } finally {
        if (client) {
          try { await client.logout(); } catch (_) {}
        }
        this.client = null;
      }
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.client) {
      try { await this.client.logout(); } catch (_) {}
    }
  }
}

const onLoad = async (cfg) => {
  try {
    const tenant = db.getTenantSchema();
    const previous = supervisors.get(tenant);
    if (previous) await previous.stop();
    supervisors.delete(tenant);

    if (!cfg || !cfg.host || !cfg.username || !cfg.table_dest) return;
    // Un worker secondaire n'ouvre pas une deuxième session IDLE.
    if (cluster.isWorker) return;

    // Teste les dépendances, mais NE PROPAGE JAMAIS l'erreur au chargeur de plugin.
    // L'engrenage et les actions restent donc disponibles pour corriger la config.
    try { loadSync().assertDependencies(); }
    catch (e) { safeLog(1, `supervision IMAP non démarrée : ${e.message}`); return; }

    const sup = new IdleSupervisor(cfg, tenant);
    supervisors.set(tenant, sup);
    sup.start().catch((e) => safeLog(1, `démarrage impossible : ${e.message}`));
  } catch (e) {
    safeLog(1, `onLoad ignoré pour préserver le plugin : ${e.message}`);
  }
};

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "imap-idle",
  configuration_workflow,
  onLoad,
  eventTypes: () => ({ MailRecu: { hasChannel: true } }),

  actions: (cfg) => ({
    imap_idle_sync: {
      configFields: [],
      run: async () => {
        const sync = loadSync();
        const tenant = db.getTenantSchema();
        return await sync.runSync(cfg, async (payload) =>
          await db.runWithTenant(tenant, async () =>
            await Trigger.emitEvent("MailRecu", cfg.folder || "INBOX", null, payload)
          )
        );
      },
    },

    imap_idle_tester: {
      configFields: [],
      run: async () => {
        let client = null;
        try {
          const sync = loadSync();
          sync.assertDependencies();
          client = sync.makeClient(cfg);
          await client.connect();
          const box = await client.mailboxOpen(cfg.folder || "INBOX", { readOnly: true });
          return { notify: `✔ IMAP connecté — ${cfg.folder || "INBOX"} — UIDNEXT ${box.uidNext || "?"}` };
        } catch (e) {
          return { error: `✘ ${e.message}` };
        } finally {
          if (client) { try { await client.logout(); } catch (_) {} }
        }
      },
    },
  }),
};
