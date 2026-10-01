const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

const rows = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, uid: i + 1, issue: null }));
const table = {
  getRows: async (where = {}) => rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)),
  getRow: async ({ id }) => rows.find((r) => r.id === id),
  updateRow: async (patch, id) => Object.assign(rows.find((r) => r.id === id), patch),
};
class FakeImap {
  async connect() {}
  async mailboxOpen() { return { uidValidity: 1, uidNext: 41 }; }
  async search(criteria) { return criteria.seen === false ? [] : rows.map((r) => r.uid); }
  async *fetch() {}
  async logout() {}
}
const original = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === "@saltcorn/data/models/table") return { findOne: ({ name: n }) => n === "email_brut" ? table : null };
  if (name === "@saltcorn/data/db") return { getTenantSchema: () => "test" };
  if (name === "imapflow") return { ImapFlow: FakeImap };
  if (name === "mailparser") return { simpleParser: async () => ({}) };
  if (name === "@saltcorn/data/models/eventlog") return { default: { log: () => {} } };
  return original.call(this, name, parent, isMain);
};
const { runSync } = require("./sync-v21.cjs");
test("les lignes en attente au-delà des 25 premières sont reprises sans doublon", async () => {
  const vus = [];
  const cfg = { table_dest: "email_brut", host: "example.org", username: "test", folder: "INBOX" };
  const first = await runSync(cfg, async (payload) => vus.push(payload.id));
  const second = await runSync(cfg, async (payload) => vus.push(payload.id));
  assert.equal(first.replayed, 25);
  assert.equal(second.replayed, 15);
  assert.equal(new Set(vus).size, 40);
  assert.equal(vus.includes(40), true);
});
