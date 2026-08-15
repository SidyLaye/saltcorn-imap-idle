const Table = require("@saltcorn/data/models/table");
const db = require("@saltcorn/data/db");

let _deps = null;
const assertDependencies = () => {
  if (_deps) return _deps;
  let ImapFlow, simpleParser;
  try {
    ({ ImapFlow } = require("imapflow"));
  } catch (e) {
    throw new Error("dépendance imapflow absente ou non chargeable : " + e.message);
  }
  try {
    ({ simpleParser } = require("mailparser"));
  } catch (e) {
    throw new Error("dépendance mailparser absente ou non chargeable : " + e.message);
  }
  _deps = { ImapFlow, simpleParser };
  return _deps;
};

const FETCH_BATCH = 50;
const PENDING_BATCH = 25;
const INFLIGHT_TTL_MS = 10 * 60 * 1000;
const STATE_KEY = Symbol.for("saltcorn.imap-idle.global-state.v4");
const G = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
  uidValidity: new Map(),
  inFlight: new Map(),
});

const log = (level, msg) => {
  try { require("@saltcorn/data/models/eventlog").default?.log?.(level, msg); }
  catch (e) { try { console.log(`[imap-idle:${level}] ${msg}`); } catch (_) {} }
};

const makeClient = (cfg) => {
  const { ImapFlow } = assertDependencies();
  return new ImapFlow({
  host: cfg.host,
  port: Number(cfg.port || 993),
  secure: cfg.tls !== false,
  auth: { user: cfg.username, pass: cfg.password },
  tls: { rejectUnauthorized: !cfg.allow_self_signed },
  logger: false,
  });
};

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

const terminalInfo = async (raw) => {
  const issue = String(raw.issue || "").trim().toUpperCase();
  if (["TRAITE", "NON_LEAD", "DOUTE", "QUARANTAINE"].includes(issue)) return issue;
  // États volontairement NON terminaux : ils doivent être rejoués après le TTL.
  if (["SMTP_ECHEC", "QUARANTAINE_EN_ATTENTE", "QUARANTAINE_SMTP_ECHEC"].includes(issue))
    return null;

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

const emitOnce = async (cfg, tenant, row, onMessage, reason) => {
  const key = `${tenant || "default"}|${cfg.table_dest}|${row.id}`;
  const last = G.inFlight.get(key) || 0;
  if (Date.now() - last < INFLIGHT_TTL_MS) return false;

  const terminal = await terminalInfo(row);
  if (terminal) {
    // Migration douce des anciennes lignes : leur état terminal devient visible
    // pour les prochaines relèves, sans rejouer le workflow.
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
  const { simpleParser } = assertDependencies();
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
    await client.connect();
    const box = await client.mailboxOpen(cfg.folder || "INBOX", { readOnly: true });

    const key = mailboxKey(cfg, tenant);
    const validity = String(box.uidValidity || client.mailbox?.uidValidity || "");
    const previousValidity = G.uidValidity.get(key);
    const validityChanged = !!previousValidity && !!validity && previousValidity !== validity;
    if (validity) G.uidValidity.set(key, validity);

    let cursor = validityChanged ? 0 : await lastUid(cfg);
    const uidNext = Number(box.uidNext || client.mailbox?.uidNext || 0);

    // Après un redémarrage, le UIDVALIDITY mémoire est perdu. Si le serveur a
    // clairement redémarré sa séquence UID, on repart à zéro.
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
            // Hors changement UIDVALIDITY, l'UID existe déjà => ingestion déjà faite.
            if (!validityChanged) {
              const ex = (await table.getRows({ [cfg.f_uid || "uid"]: Number(m.uid) }, { limit: 1 }))[0];
              if (ex) continue;
            }
            const id = await table.insertRow(row);
            const saved = { id, ...row };
            inserted++;
            if (await emitOnce(cfg, tenant, saved, onMessage, "nouveau message")) emitted++;
          }
        }
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
        if (await emitOnce(cfg, tenant, saved, onMessage, "nouveau message")) emitted++;
      }
    }

    // Point essentiel : le max UID sert uniquement à l'INGESTION IMAP.
    // Le succès du workflow est suivi séparément avec email_brut.issue.
    // Une exception du workflow ne peut donc plus faire disparaître un mail.
    const rows = await table.getRows({});
    const candidats = rows
      .filter((r) => {
        const issue = String(r.issue || "").trim().toUpperCase();
        return !issue || ["SMTP_ECHEC", "QUARANTAINE_EN_ATTENTE", "QUARANTAINE_SMTP_ECHEC"].includes(issue);
      })
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, PENDING_BATCH);

    for (const r of candidats) {
      if (await emitOnce(cfg, tenant, r, onMessage, "rejeu pending")) replayed++;
    }

    return { inserted, emitted, replayed };
  } finally {
    try { await client.logout(); } catch (e) {}
  }
};

const runSync = async (cfg, onMessage) => runSyncCore(cfg, onMessage, db.getTenantSchema());
const runSyncForTenant = async (cfg, tenant, onMessage) =>
  db.runWithTenant(tenant, async () => runSyncCore(cfg, onMessage, tenant));

module.exports = { runSync, runSyncForTenant, makeClient, log, assertDependencies };
