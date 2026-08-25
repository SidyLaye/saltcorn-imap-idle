/**
 * Saltcorn Git-native loader for imap-idle V23.
 *
 * V23 forces a new ESM entrypoint and clears the CJS cache before loading the
 * implementation, so Saltcorn cannot silently keep the previous plugin body.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

console.log("### AMBS IMAP V23 GIT ESM ENTRY LOADED ###");

for (const rel of ["./sync-v21.cjs", "./imap-idle-plugin-v21.cjs"]) {
  try {
    delete require.cache[require.resolve(rel)];
  } catch (_) {}
}

const plugin = require("./imap-idle-plugin-v21.cjs");

if (!plugin || typeof plugin !== "object") {
  throw new Error("imap-idle V23: le module interne n'a pas exporte un objet plugin");
}
if (plugin.plugin_name !== "imap-idle") {
  throw new Error(
    `imap-idle V23: plugin_name invalide (${String(plugin.plugin_name)}), attendu: imap-idle`
  );
}
if (typeof plugin.configuration_workflow !== "function") {
  throw new Error("imap-idle V23: configuration_workflow absent du module charge");
}

console.log(
  "### AMBS IMAP V23 GIT DEFAULT EXPORT READY ###",
  Object.keys(plugin)
);

export default plugin;
