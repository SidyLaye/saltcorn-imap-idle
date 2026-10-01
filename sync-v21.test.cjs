const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

const originalLoad = Module._load;
const data = { ld_mails: [], ld_leads: [], dzf_envois: [] };
Module._load = function (name, parent, isMain) {
  if (name === "@saltcorn/data/models/table") return {
    findOne: ({ name: table }) => data[table] && {
      getRows: async (where) => data[table].filter((row) =>
        Object.entries(where).every(([field, value]) => row[field] === value)),
    },
  };
  if (name === "@saltcorn/data/db") return {};
  return originalLoad.call(this, name, parent, isMain);
};
const { terminalInfo } = require("./sync-v21.cjs");
Module._load = originalLoad;

test("un lead est lu seulement après la fin du traitement et l'envoi confirmé", async () => {
  data.ld_mails = [{ id: 101, message_id: "email_brut_selection_habitat:42" }];
  data.ld_leads = [{ id: 201, mail_id: 101, statut: "pret", traite_le: new Date() }];
  data.dzf_envois = [];
  assert.equal(await terminalInfo({ id: 42 }), null);
  data.dzf_envois = [{ reference: "lead 201", statut: "simule" }];
  assert.equal(await terminalInfo({ id: 42 }), null);
  data.dzf_envois = [{ reference: "lead 201", statut: "envoye" }];
  assert.equal(await terminalInfo({ id: 42 }), "TRAITE");
  data.ld_leads[0].traite_le = null;
  assert.equal(await terminalInfo({ id: 42 }), null);
});

test("les alertes restent non lues, les messages écartés sont lus", async () => {
  data.ld_mails = [{ id: 102, message_id: "email_brut_selection_habitat:43" }];
  data.ld_leads = [{ id: 202, mail_id: 102, statut: "alerte", traite_le: new Date() }];
  data.dzf_envois = [{ reference: "lead 202", statut: "envoye" }];
  assert.equal(await terminalInfo({ id: 43 }), null);
  data.ld_leads[0].statut = "ignore";
  assert.equal(await terminalInfo({ id: 43 }), "TRAITE");
  assert.equal(await terminalInfo({ id: 44 }), null);
});
