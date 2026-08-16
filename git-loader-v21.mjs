/**
 * Saltcorn Git-native loader for imap-idle V21.
 *
 * Saltcorn's current PluginInstaller loads package.json.main with import()
 * and then uses res.default. This file therefore exposes an explicit ESM
 * default export and delegates the implementation to a versioned CJS file.
 *
 * The versioned main filename is intentional: when a Git plugin is refreshed
 * in the same Node process, reusing the same import URL can return the cached
 * module. A new main filename forces a new ESM module URL.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

console.log("### AMBS IMAP V21 GIT ESM ENTRY LOADED ###");

const plugin = require("./imap-idle-plugin-v21.cjs");

if (!plugin || typeof plugin !== "object") {
  throw new Error("imap-idle V21: le module interne n'a pas exporté un objet plugin");
}
if (plugin.plugin_name !== "imap-idle") {
  throw new Error(
    `imap-idle V21: plugin_name invalide (${String(plugin.plugin_name)}), attendu: imap-idle`
  );
}
if (typeof plugin.configuration_workflow !== "function") {
  throw new Error("imap-idle V21: configuration_workflow absent du module chargé");
}

console.log(
  "### AMBS IMAP V21 GIT DEFAULT EXPORT READY ###",
  Object.keys(plugin)
);

export default plugin;
