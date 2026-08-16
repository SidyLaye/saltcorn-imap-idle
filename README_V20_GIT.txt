AMBS IMAP V20 — CORRECTION SPECIFIQUE SOURCE GIT SALTCORN
==========================================================

Cette version est conçue pour le mode Source = git de Saltcorn.

FICHIERS A LA RACINE DU DEPOT GIT :
- package.json
- git-loader-v20.mjs
- imap-idle-plugin-v20.cjs
- sync-v20.cjs

POINTS IMPORTANTS :
1. Le Name Saltcorn doit être exactement : imap-idle
2. Le plugin exporte explicitement : plugin_name = "imap-idle"
3. package.json.main pointe vers git-loader-v20.mjs
4. git-loader-v20.mjs est un vrai module ESM et fait export default plugin
5. Le nom du fichier main est versionné pour éviter de réutiliser le cache
   import() d'un ancien index.js lors d'une mise à jour Git.
6. L'implémentation métier reste en CommonJS dans imap-idle-plugin-v20.cjs.
7. Les dépendances imapflow et mailparser restent déclarées normalement.

INSTALLATION SALTCORN :
- Name : imap-idle
- Source : git
- Location : URL Git complète du dépôt, par exemple :
  https://github.com/OWNER/saltcorn-imap-idle.git
  ou une URL SSH valide si tu utilises une Deploy Key.

APRES PUSH :
- utilise l'action de mise à jour/rechargement du plugin Git ;
- si Saltcorn garde encore une ancienne installation, Clean modules and restart
  force la reconstruction du dossier git_plugins.

MARQUEURS LOGS ATTENDUS :
### AMBS IMAP V20 GIT ESM ENTRY LOADED ###
### AMBS IMAP V20 CJS IMPLEMENTATION EVALUATED - plugin_name=imap-idle ###
### AMBS IMAP V20 GIT DEFAULT EXPORT READY ###

Une fois ces trois lignes présentes, Saltcorn a forcément reçu un objet default
contenant configuration_workflow et plugin_name=imap-idle.
