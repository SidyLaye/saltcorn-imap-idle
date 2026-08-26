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
const STATE_KEY = Symbol.for("saltcorn.imap-idle.global-state.v5");
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
  // Regle AMBS : dans info@, seuls les messages qui ont abouti au siege
  // ou a la quarantaine doivent etre marques comme lus.
  if (["NON_LEAD", "DOUTE"].includes(issue)) return null;
  if (["TRAITE", "QUARANTAINE"].includes(issue)) return issue;
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

const workflowTerminalInfo = async (raw) => {
  const issue = String(raw.issue || "").trim().toUpperCase();
  if (["TRAITE", "NON_LEAD", "DOUTE", "QUARANTAINE"].includes(issue)) return issue;
  return await terminalInfo(raw);
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

  const terminal = await workflowTerminalInfo(row);
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

const markSeenBatchSafe = async (client, uids, reason) => {
  const list = Array.from(uids || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return 0;

  try {
    if (typeof client.messageFlagsAdd !== "function")
      throw new Error("messageFlagsAdd indisponible");
    for (let i = 0; i < list.length; i += 200) {
      await client.messageFlagsAdd(list.slice(i, i + 200), ["\\Seen"], { uid: true });
    }
    log(4, `${reason} : ${list.length} message(s) marque(s) lu(s) dans INBOX`);
    return list.length;
  } catch (e) {
    log(2, `${reason} : marquage lu impossible : ${String(e && e.message ? e.message : e).slice(0, 400)}`);
    return 0;
  }
};

const unreadUidsSafe = async (client, reason) => {
  try {
    if (typeof client.search !== "function") throw new Error("search indisponible");
    const found = await client.search({ seen: false }, { uid: true });
    return (Array.isArray(found) ? found : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) {
    log(2, `${reason} : recherche non-lus impossible : ${String(e && e.message ? e.message : e).slice(0, 400)}`);
    return [];
  }
};

const markStoredTerminalUnread = async (cfg, table, client, reason) => {
  const unread = await unreadUidsSafe(client, reason);
  if (!unread.length) return 0;

  const unreadSet = new Set(unread.map(Number));
  const uidField = cfg.f_uid || "uid";
  const rows = await table.getRows({});
  const toMark = new Set();

  for (const row of rows) {
    const uid = Number(row[uidField]);
    if (!Number.isFinite(uid) || uid <= 0 || !unreadSet.has(uid)) continue;
    if (await terminalInfo(row)) toMark.add(uid);
  }

  return await markSeenBatchSafe(client, toMark, reason);
};

const markRowSeenIfTerminal = async (cfg, table, client, row, reason) => {
  const uid = Number(row[cfg.f_uid || "uid"]);
  if (!Number.isFinite(uid) || uid <= 0) return 0;

  let fresh = row;
  if (row && row.id) {
    try {
      fresh = (await table.getRow({ id: row.id })) || row;
    } catch (e) {
      fresh = row;
    }
  }

  const terminal = await terminalInfo(fresh);
  if (!terminal) return 0;

  return await markSeenBatchSafe(client, [uid], `${reason} (${terminal})`);
};

const runSyncCore = async (cfg, onMessage, tenant) => {
  if (!cfg || !cfg.table_dest) throw new Error("configuration IMAP incomplète");
  const table = Table.findOne({ name: cfg.table_dest });
  if (!table) throw new Error(`table destination introuvable : ${cfg.table_dest}`);

  const client = makeClient(cfg);
  let inserted = 0, emitted = 0, replayed = 0, marked_read = 0;
  try {
    await client.connect();
    const box = await client.mailboxOpen(cfg.folder || "INBOX", { readOnly: false });
    const rowsToEmit = [];
    marked_read += await markStoredTerminalUnread(cfg, table, client, "rattrapage lignes deja traitees");

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
              if (ex) {
                continue;
              }
            }
            const id = await table.insertRow(row);
            const saved = { id, ...row };
            inserted++;
            rowsToEmit.push(saved);
          }
        }
      }
      for (const m of lot) {
        const row = await parseMessage(cfg, m);
        if (!validityChanged) {
          const ex = (await table.getRows({ [cfg.f_uid || "uid"]: Number(m.uid) }, { limit: 1 }))[0];
          if (ex) {
            continue;
          }
        }
        const id = await table.insertRow(row);
        const saved = { id, ...row };
        inserted++;
        rowsToEmit.push(saved);
      }
      for (const saved of rowsToEmit) {
        if (await emitOnce(cfg, tenant, saved, onMessage, "nouveau message")) {
          emitted++;
          marked_read += await markRowSeenIfTerminal(cfg, table, client, saved, "nouveau message abouti");
        }
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
      if (await emitOnce(cfg, tenant, r, onMessage, "rejeu pending")) {
        replayed++;
        marked_read += await markRowSeenIfTerminal(cfg, table, client, r, "rejeu pending abouti");
      }
    }

    return { inserted, emitted, replayed, marked_read };
  } finally {
    try { await client.logout(); } catch (e) {}
  }
};

const runSync = async (cfg, onMessage) => runSyncCore(cfg, onMessage, db.getTenantSchema());
const runSyncForTenant = async (cfg, tenant, onMessage) =>
  db.runWithTenant(tenant, async () => runSyncCore(cfg, onMessage, tenant));


/* ──────────────────────────────────────────────────────────────────────────
 * Import ciblé par période IMAP, SANS déclencher le workflow.
 *
 * startUtc inclus, endUtc exclu. La recherche se fait côté serveur IMAP sur
 * l'INTERNALDATE. Les messages sont ensuite lus avec leur UID et insérés dans
 * la table configurée du plugin.
 * ────────────────────────────────────────────────────────────────────────── */
const asDate = (v, label) => {
  const d = v instanceof Date ? v : new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error(`${label} invalide : ${v}`);
  return d;
};

const boolOpt = (v, fallback = false) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "oui", "on"].includes(s)) return true;
  if (["false", "no", "non", "off"].includes(s)) return false;
  return fallback;
};

const mailboxPath = (mb) =>
  String((mb && (mb.path || mb.name)) || "").trim();

const mailboxSpecialUse = (mb) =>
  String((mb && mb.specialUse) || "");

const mailboxNoSelect = (mb) => {
  const flags = mb && mb.flags;
  if (flags && typeof flags.has === "function") return flags.has("\\Noselect");
  if (Array.isArray(flags))
    return flags.some((x) => String(x).toLowerCase() === "\\noselect");
  return false;
};

const mailboxIsTrash = (mb) => {
  const p = mailboxPath(mb);
  const su = mailboxSpecialUse(mb);
  return (
    /\\Trash/i.test(su) ||
    /(^|[\/.\s])(trash|corbeille|deleted items|deleted)([\/.\s]|$)/i.test(p)
  );
};

const mailboxIsSentDraftJunk = (mb) => {
  const p = mailboxPath(mb);
  const su = mailboxSpecialUse(mb);
  return (
    /\\(Sent|Drafts|Junk)/i.test(su) ||
    /(^|[\/.\s])(sent|sent items|envoy[eé]s?|drafts?|brouillons?|junk|spam|ind[eé]sirables?)([\/.\s]|$)/i.test(p)
  );
};

const listHistoricalMailboxes = async (client, cfg, opts) => {
  const allFolders = boolOpt(opts.all_folders ?? opts.allFolders, false);
  const includeTrash = boolOpt(opts.include_trash ?? opts.includeTrash, false);
  const receivedOnly = boolOpt(opts.received_only ?? opts.receivedOnly, true);

  if (!allFolders) {
    return [{
      path: String(opts.folder || cfg.folder || "INBOX"),
      specialUse: "\\Inbox",
      trash: false,
    }];
  }

  const listed = await client.list();
  let boxes = (Array.isArray(listed) ? listed : [])
    .filter((mb) => !mailboxNoSelect(mb))
    .filter((mb) => mailboxPath(mb));

  if (receivedOnly)
    boxes = boxes.filter((mb) => !mailboxIsSentDraftJunk(mb));

  if (!includeTrash)
    boxes = boxes.filter((mb) => !mailboxIsTrash(mb));

  const seen = new Set();
  const out = [];

  for (const mb of boxes) {
    const path = mailboxPath(mb);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      specialUse: mb.specialUse || null,
      trash: mailboxIsTrash(mb),
    });
  }

  // INBOX d'abord : si la même source existe dans plusieurs dossiers,
  // on conserve prioritairement la vraie ligne INBOX et son UID positif.
  out.sort((a, b) => {
    const ai = String(a.path).toUpperCase() === String(cfg.folder || "INBOX").toUpperCase() ? 0 : 1;
    const bi = String(b.path).toUpperCase() === String(cfg.folder || "INBOX").toUpperCase() ? 0 : 1;
    return ai - bi || String(a.path).localeCompare(String(b.path));
  });

  return out;
};

const closeMailboxSafe = async (client) => {
  try {
    if (typeof client.mailboxClose === "function") await client.mailboxClose();
  } catch (_) {}
};

const nextNegativeUid = async (table, cfg) => {
  const rows = await table.getRows({});
  let min = 0;
  const field = cfg.f_uid || "uid";

  for (const r of rows) {
    const n = Number(r[field]);
    if (Number.isFinite(n) && n < min) min = n;
  }

  return min - 1;
};

const historicalRow = async (cfg, message, localUid) => {
  const { simpleParser } = assertDependencies();
  const parsed = await simpleParser(message.source);
  const row = {};

  row[cfg.f_uid || "uid"] = Number(localUid);
  row[cfg.f_subject || "objet"] = parsed.subject || message.envelope?.subject || "";
  row[cfg.f_from || "expediteur"] =
    parsed.from ? parsed.from.text : addrList(message.envelope?.from);
  row[cfg.f_to || "destinataire"] =
    parsed.to ? parsed.to.text : addrList(message.envelope?.to);
  row[cfg.f_date || "date_envoi"] =
    parsed.date || message.internalDate || new Date();
  row[cfg.f_text || "corps_texte"] = parsed.text || "";
  row[cfg.f_html || "corps_html"] =
    typeof parsed.html === "string"
      ? parsed.html
      : (parsed.html ? String(parsed.html) : "");

  return row;
};

const hashSource = (source) => {
  const crypto = require("crypto");
  return crypto
    .createHash("sha1")
    .update(Buffer.isBuffer(source) ? source : Buffer.from(source || ""))
    .digest("hex");
};

const exactInternalDate = (message) => {
  if (!message || !message.internalDate) return null;
  const d = new Date(message.internalDate);
  return Number.isFinite(d.getTime()) ? d : null;
};

const inExactPeriod = (d, start, end) => {
  if (!d) return true;
  if (d < start) return false;
  if (d >= end) return false;
  return true;
};

const broadSearchDates = (start, end) => ({
  // IMAP SEARCH SINCE/BEFORE travaille au niveau de la date.
  // On élargit d'un jour de chaque côté puis on filtre exactement
  // avec internalDate pour conserver vendredi 00:00 -> cutoff à la seconde.
  since: new Date(start.getTime() - 24 * 60 * 60 * 1000),
  before: new Date(end.getTime() + 24 * 60 * 60 * 1000),
});

const searchUids = async (client, start, end) => {
  const matched = await client.search(
    broadSearchDates(start, end),
    { uid: true }
  );

  return (Array.isArray(matched) ? matched : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
};

const importPeriod = async (cfg, opts = {}) => {
  assertDependencies();

  if (!cfg || !cfg.host || !cfg.username || !cfg.table_dest)
    throw new Error("configuration IMAP incomplète");

  const start = asDate(opts.start_utc || opts.startUtc, "start_utc");
  const end = asDate(opts.end_utc || opts.endUtc, "end_utc");

  if (end <= start)
    throw new Error("end_utc doit être postérieur à start_utc");

  const dryRun = boolOpt(opts.dry_run ?? opts.dryRun, false);
  const replaceExisting = boolOpt(
    opts.replace_existing ?? opts.replaceExisting,
    false
  );
  const allFolders = boolOpt(opts.all_folders ?? opts.allFolders, false);
  const includeTrash = boolOpt(opts.include_trash ?? opts.includeTrash, false);
  const receivedOnly = boolOpt(opts.received_only ?? opts.receivedOnly, true);

  const table = Table.findOne({ name: cfg.table_dest });
  if (!table)
    throw new Error(`table destination introuvable : ${cfg.table_dest}`);

  const realtimeFolder = String(cfg.folder || "INBOX");
  const client = makeClient(cfg);

  const report = {
    ok: true,
    engine: allFolders ? "imap_multifolder_v21" : "imap_singlefolder_v21",
    dry_run: dryRun,
    folder: allFolders ? "MULTI" : realtimeFolder,
    realtime_folder: realtimeFolder,
    all_folders: allFolders,
    include_trash: includeTrash,
    received_only: receivedOnly,
    start_utc: start.toISOString(),
    end_utc: end.toISOString(),
    matched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    duplicates_skipped: 0,
    has_trash: false,
    folders: [],
    errors: [],
  };

  try {
    await client.connect();

    const boxes = await listHistoricalMailboxes(client, cfg, {
      ...opts,
      all_folders: allFolders,
      include_trash: includeTrash,
      received_only: receivedOnly,
    });

    if (!boxes.length)
      throw new Error("aucun dossier IMAP sélectionnable");

    let negativeUid = await nextNegativeUid(table, cfg);
    const seenHashes = new Set();

    for (const mb of boxes) {
      const fr = {
        folder: mb.path,
        special_use: mb.specialUse || null,
        trash: !!mb.trash,
        ok: false,
        candidates: 0,
        matched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        duplicates_skipped: 0,
        first_uid: null,
        last_uid: null,
        uid_mode:
          String(mb.path).toUpperCase() === realtimeFolder.toUpperCase()
            ? "imap_positive"
            : "historical_negative",
        error: null,
      };

      try {
        await closeMailboxSafe(client);
        await client.mailboxOpen(mb.path, { readOnly: true });

        const uids = await searchUids(client, start, end);
        fr.candidates = uids.length;

        if (uids.length) {
          fr.first_uid = uids[0];
          fr.last_uid = uids[uids.length - 1];
        }

        if (dryRun) {
          for (let i = 0; i < uids.length; i += 200) {
            const chunk = uids.slice(i, i + 200);
            if (!chunk.length) continue;

            for await (const message of client.fetch(
              chunk.join(","),
              { uid: true, internalDate: true },
              { uid: true }
            )) {
              const d = exactInternalDate(message);
              if (!inExactPeriod(d, start, end)) continue;
              fr.matched++;
              report.matched++;
            }
          }

          fr.ok = true;
          if (fr.trash) report.has_trash = true;
          report.folders.push(fr);
          continue;
        }

        for (let i = 0; i < uids.length; i += 100) {
          const chunk = uids.slice(i, i + 100);
          if (!chunk.length) continue;

          for await (const message of client.fetch(
            chunk.join(","),
            { uid: true, source: true, envelope: true, internalDate: true },
            { uid: true }
          )) {
            try {
              const realUid = Number(message.uid);
              if (!Number.isFinite(realUid) || realUid <= 0) continue;

              const d = exactInternalDate(message);
              if (!inExactPeriod(d, start, end)) continue;

              fr.matched++;
              report.matched++;

              const hash = hashSource(message.source);
              if (seenHashes.has(hash)) {
                fr.duplicates_skipped++;
                report.duplicates_skipped++;
                continue;
              }
              seenHashes.add(hash);

              const isRealtimeFolder =
                String(mb.path).toUpperCase() === realtimeFolder.toUpperCase();

              let localUid;
              if (isRealtimeFolder) {
                localUid = realUid;

                const existing = (
                  await table.getRows(
                    { [cfg.f_uid || "uid"]: localUid },
                    { limit: 1 }
                  )
                )[0];

                if (existing) {
                  if (replaceExisting) {
                    const row = await historicalRow(cfg, message, localUid);
                    await table.updateRow(row, existing.id);
                    fr.updated++;
                    report.updated++;
                  } else {
                    fr.skipped++;
                    report.skipped++;
                  }
                  continue;
                }
              } else {
                // UID IMAP est local au dossier. Un UID positif hors INBOX
                // polluerait lastUid() et pourrait faire sauter de nouveaux INBOX.
                localUid = negativeUid--;
              }

              const row = await historicalRow(cfg, message, localUid);
              await table.insertRow(row);

              fr.inserted++;
              report.inserted++;

            } catch (e) {
              const detail = {
                folder: mb.path,
                uid: Number(message && message.uid) || null,
                error: String(e && e.message ? e.message : e).slice(0, 600),
              };
              report.errors.push(detail);
            }
          }
        }

        fr.ok = true;
        if (fr.trash) report.has_trash = true;

      } catch (e) {
        fr.error = String(e && e.message ? e.message : e).slice(0, 800);
        report.errors.push({
          folder: mb.path,
          error: fr.error,
        });
      }

      report.folders.push(fr);
    }

    report.ok = report.errors.length === 0;
    return report;

  } finally {
    await closeMailboxSafe(client);
    try { await client.logout(); } catch (_) {}
  }
};

module.exports = {
  runSync,
  runSyncForTenant,
  makeClient,
  log,
  assertDependencies,
  importPeriod,
  payloadFromRow,
  markSeenBatchSafe,
};
