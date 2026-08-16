/**
 * imap-idle V20 — Git-native Saltcorn loader
 *
 * Cette implémentation CommonJS est chargée par git-loader-v20.mjs.
 * Le point d’entrée ESM unique est volontaire : le loader Saltcorn actuel
 * fait import(main) puis retourne res.default. Le nom de main change en V20
 * pour casser le cache d’un ancien module installé depuis une source Git.
 */
console.log("### AMBS IMAP V20 CJS IMPLEMENTATION EVALUATED - plugin_name=imap-idle ###");

const cluster = require("cluster");

const getDb = () => require("@saltcorn/data/db");
const getTrigger = () => require("@saltcorn/data/models/trigger");

let CURRENT_CFG = {};
const supervisors = new Map();
const maintenanceTenants = new Set();

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
    return require("./sync-v20.cjs");
  } catch (e) {
    throw new Error(
      "imap-idle est chargé mais le moteur IMAP est indisponible : " +
      (e && e.message ? e.message : String(e))
    );
  }
};

const cfg = () => {
  if (!CURRENT_CFG || !CURRENT_CFG.host || !CURRENT_CFG.username || !CURRENT_CFG.table_dest) {
    throw new Error(
      "Configuration IMAP non chargée. Ouvre l'engrenage du module, enregistre la configuration puis recharge les plugins."
    );
  }
  return CURRENT_CFG;
};

const configuration_workflow = () => {
  console.log("### AMBS IMAP V20 configuration_workflow CALLED ###");
  const Workflow = require("@saltcorn/data/models/workflow");
  const Form = require("@saltcorn/data/models/form");

  return new Workflow({
    steps: [
      {
        name: "Compte IMAP",
        form: () => new Form({ fields: [
          { name: "host", label: "Serveur IMAP", type: "String", required: true },
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
          const Table = require("@saltcorn/data/models/table");
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
};

class IdleSupervisor {
  constructor(config, tenant) {
    this.cfg = config;
    this.tenant = tenant;
    this.stopped = false;
    this.client = null;
    this.timer = null;
    this.busy = false;
  }

  async start() {
    if (maintenanceTenants.has(this.tenant)) return;
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
    if (maintenanceTenants.has(this.tenant)) return;
    const db = getDb();
    const Trigger = getTrigger();
    return await db.runWithTenant(this.tenant, async () =>
      await Trigger.emitEvent("MailRecu", this.cfg.folder || "INBOX", null, payload)
    );
  }

  async sync(cause) {
    if (this.busy || this.stopped || maintenanceTenants.has(this.tenant)) return;
    this.busy = true;
    try {
      const s = loadSync();
      const counts = await s.runSyncForTenant(this.cfg, this.tenant, (p) => this.emit(p));
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
    while (!this.stopped && !maintenanceTenants.has(this.tenant)) {
      let client = null;
      try {
        const s = loadSync();
        client = s.makeClient(this.cfg);
        this.client = client;
        await client.connect();
        await client.mailboxOpen(this.cfg.folder || "INBOX", { readOnly: true });
        safeLog(4, `IDLE actif sur ${this.cfg.folder || "INBOX"}`);

        client.on("exists", () => {
          if (!maintenanceTenants.has(this.tenant))
            setImmediate(() => this.sync("notification IDLE"));
        });
        client.on("error", (e) => safeLog(2, `erreur IDLE : ${e.message}`));

        while (!this.stopped && !maintenanceTenants.has(this.tenant)) {
          await client.idle({ maxIdleTime: Number(this.cfg.idle_renew_s || 240) * 1000 });
        }
      } catch (e) {
        if (this.stopped || maintenanceTenants.has(this.tenant)) break;
        const wait = Number(this.cfg.reconnect_s || 30) * 1000;
        safeLog(2, `connexion IDLE perdue (${e.message}) — reconnexion dans ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      } finally {
        if (client) { try { await client.logout(); } catch (_) {} }
        this.client = null;
      }
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.client) { try { await this.client.logout(); } catch (_) {} }
    this.client = null;
  }
}

const stopSupervisor = async (tenant) => {
  const sup = supervisors.get(tenant);
  if (sup) {
    try { await sup.stop(); } catch (_) {}
    supervisors.delete(tenant);
  }
};

const startSupervisor = async (tenant) => {
  if (maintenanceTenants.has(tenant)) return;
  const c = cfg();
  await stopSupervisor(tenant);
  if (cluster.isWorker) return;
  const sup = new IdleSupervisor(c, tenant);
  supervisors.set(tenant, sup);
  sup.start().catch((e) => safeLog(1, `démarrage impossible : ${e.message}`));
};

const onLoad = async (configuration) => {
  // IMPORTANT : mémorisé AVANT toute opération susceptible d'échouer.
  CURRENT_CFG = { ...(configuration || {}) };
  console.log("### AMBS IMAP V20 onLoad CALLED ###");

  try {
    const db = getDb();
    const tenant = db.getTenantSchema();
    await stopSupervisor(tenant);

    if (!CURRENT_CFG.host || !CURRENT_CFG.username || !CURRENT_CFG.table_dest) return;
    if (cluster.isWorker) return;

    try { loadSync().assertDependencies(); }
    catch (e) {
      safeLog(1, `supervision IMAP non démarrée : ${e.message}`);
      return;
    }

    if (!maintenanceTenants.has(tenant)) await startSupervisor(tenant);
  } catch (e) {
    safeLog(1, `onLoad : ${e.message}`);
  }
};

const actionSync = async () => {
  const c = cfg();
  const db = getDb();
  const Trigger = getTrigger();
  const tenant = db.getTenantSchema();
  const s = loadSync();
  return await s.runSync(c, async (payload) =>
    await db.runWithTenant(tenant, async () =>
      await Trigger.emitEvent("MailRecu", c.folder || "INBOX", null, payload)
    )
  );
};

const actionImportPeriod = async ({ configuration = {}, ...rest } = {}) => {
  const c = cfg();
  const opts = { ...configuration, ...rest };
  return await loadSync().importPeriod(c, opts);
};

const actionMaintenance = async ({ configuration = {}, ...rest } = {}) => {
  const opts = { ...configuration, ...rest };
  const active = opts.active === true || opts.active === "true" || opts.active === 1 || opts.active === "1";
  const db = getDb();
  const tenant = db.getTenantSchema();

  if (active) {
    maintenanceTenants.add(tenant);
    await stopSupervisor(tenant);
    safeLog(4, `maintenance IMAP activée pour ${tenant}`);
    return { maintenance: true, tenant };
  }

  maintenanceTenants.delete(tenant);
  await startSupervisor(tenant);
  safeLog(4, `maintenance IMAP désactivée pour ${tenant}`);
  return { maintenance: false, tenant };
};

const actionTester = async () => {
  const c = cfg();
  let client = null;
  try {
    const s = loadSync();
    s.assertDependencies();
    client = s.makeClient(c);
    await client.connect();
    const box = await client.mailboxOpen(c.folder || "INBOX", { readOnly: true });
    return {
      ok: true,
      folder: c.folder || "INBOX",
      uid_next: box.uidNext || null,
      uid_validity: box.uidValidity ? String(box.uidValidity) : null,
    };
  } finally {
    if (client) { try { await client.logout(); } catch (_) {} }
  }
};

// IMPORTANT SALTCORN MODERNE:
// Dès qu'un plugin expose configuration_workflow, State.registerPlugin() appelle
// chaque surface configurable comme une fonction avec la configuration sauvegardée.
// Il ne faut donc PAS exporter ici des dictionnaires statiques.
const requirePluginCfg = (pluginConfig = {}) => {
  const c = { ...(pluginConfig || {}) };
  if (!c.host || !c.username || !c.table_dest) {
    throw new Error(
      "Configuration IMAP incomplète. Ouvre l'engrenage du module et enregistre la configuration."
    );
  }
  return c;
};

const actions = (pluginConfig = {}) => ({
  imap_idle_sync: {
    configFields: [],
    run: async () => {
      const c = requirePluginCfg(pluginConfig);
      const db = getDb();
      const Trigger = getTrigger();
      const tenant = db.getTenantSchema();
      const s = loadSync();
      return await s.runSync(c, async (payload) =>
        await db.runWithTenant(tenant, async () =>
          await Trigger.emitEvent("MailRecu", c.folder || "INBOX", null, payload)
        )
      );
    },
  },
  imap_import_periode: {
    configFields: [
      { name: "start_utc", label: "Début UTC inclus", type: "String" },
      { name: "end_utc", label: "Fin UTC exclue", type: "String" },
      { name: "dry_run", label: "Scanner seulement", type: "Bool", default: false },
      { name: "replace_existing", label: "Mettre à jour UID existants", type: "Bool", default: false },
    ],
    run: async ({ configuration = {}, ...rest } = {}) => {
      const c = requirePluginCfg(pluginConfig);
      return await loadSync().importPeriod(c, { ...configuration, ...rest });
    },
  },
  imap_idle_maintenance: {
    configFields: [
      { name: "active", label: "Maintenance active", type: "Bool", default: true },
    ],
    run: actionMaintenance,
  },
  imap_idle_tester: {
    configFields: [],
    run: async () => {
      const c = requirePluginCfg(pluginConfig);
      let client = null;
      try {
        const s = loadSync();
        s.assertDependencies();
        client = s.makeClient(c);
        await client.connect();
        const box = await client.mailboxOpen(c.folder || "INBOX", { readOnly: true });
        return {
          ok: true,
          folder: c.folder || "INBOX",
          uid_next: box.uidNext || null,
          uid_validity: box.uidValidity ? String(box.uidValidity) : null,
        };
      } finally {
        if (client) { try { await client.logout(); } catch (_) {} }
      }
    },
  },
});

const functions = (pluginConfig = {}) => ({
  imap_import_periode_fn: {
    run: async (start_utc, end_utc, dry_run = false) => {
      const c = requirePluginCfg(pluginConfig);
      return await loadSync().importPeriod(c, { start_utc, end_utc, dry_run });
    },
    isAsync: true,
    description: "Importe une période IMAP avec la configuration enregistrée du plugin",
    arguments: [
      { name: "start_utc", type: "String" },
      { name: "end_utc", type: "String" },
      { name: "dry_run", type: "Bool" },
    ],
  },
});

const eventTypes = (_pluginConfig = {}) => ({
  MailRecu: { hasChannel: true },
});

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "imap-idle",
  configuration_workflow,
  onLoad,
  eventTypes,
  actions,
  functions,
};
