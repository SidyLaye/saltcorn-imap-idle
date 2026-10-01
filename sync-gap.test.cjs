const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

const rows = [
  { id: 1, uid: 1, issue: "TRAITE" },
  { id: 3, uid: 3, issue: "TRAITE" },
];
const fetched = [];
const seenAdded = [];
const table = {
  getRows: async (where = {}) => rows.filter((x) => Object.entries(where).every(([k, v]) => x[k] === v)),
  getRow: async (where) => rows.find((x) => x.id === where.id),
  insertRow: async (row) => { const id = 10 + rows.length; rows.push({ id, ...row }); return id; },
  updateRow: async (patch, id) => Object.assign(rows.find((x) => x.id === id), patch),
};
class FakeImap {
  async connect() {}
  async mailboxOpen() { return { uidValidity: 1, uidNext: 4 }; }
  async search(criteria) { return criteria.seen === false ? [] : [1, 2, 3]; }
  async *fetch(range) {
    fetched.push(range);
    if (range === "2") yield { uid: 2, source: Buffer.from("message"), envelope: { subject: "Demande" }, internalDate: new Date() };
  }
  async messageFlagsAdd(uids) { seenAdded.push(...uids); }
  async logout() {}
}
const original = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === "@saltcorn/data/models/table") return { findOne: ({ name: n }) => n === "email_brut" ? table : null };
  if (name === "@saltcorn/data/db") return { getTenantSchema: () => "test" };
  if (name === "imapflow") return { ImapFlow: FakeImap };
  if (name === "mailparser") return { simpleParser: async () => ({ subject: "Demande", text: "Un prospect", from: { text: "a@example.org" }, to: { text: "b@example.org" } }) };
  if (name === "@saltcorn/data/models/eventlog") return { default: { log: () => {} } };
  return original.call(this, name, parent, isMain);
};
const { runSync } = require("./sync-v21.cjs");
test("réingère un UID manquant plus ancien que le plus grand UID", async () => {
  const emitted = [];
  const cfg = { table_dest: "email_brut", host: "example.org", username: "test", folder: "INBOX" };
  const first = await runSync(cfg, async (payload) => emitted.push(payload.uid));
  assert.equal(first.inserted, 1);
  assert.deepEqual(emitted, [2]);
  assert.equal(rows.filter((r) => r.uid === 2).length, 1);
  assert.deepEqual(fetched, ["2"]);
  const second = await runSync(cfg, async (payload) => emitted.push(payload.uid));
  assert.equal(second.inserted, 0);
  assert.deepEqual(emitted, [2]);
  assert.deepEqual(seenAdded, []);
});
