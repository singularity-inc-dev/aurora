// Writes (or updates) Paperclip's config.json for the server: authenticated mode,
// reachable from the internet through Caddy, data in the system PostgreSQL.
// Usage: node paperclip-config.mjs <config.json> <instanceDir> <publicUrl> <domain> <port> <dbUrlFile>
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [file, instance, publicUrl, domain, port, dbUrlFile] = process.argv.slice(2);
const old = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const config = {
  ...old,
  $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
  database: {
    mode: "postgres",
    connectionString: readFileSync(dbUrlFile, "utf8").trim(),
    // The daily backup (vt-backup) covers the database and the files together.
    backup: { enabled: false, intervalMinutes: 1440, retentionDays: 14, dir: `${instance}/data/backups` },
  },
  logging: { mode: "file", logDir: `${instance}/logs` },
  server: {
    deploymentMode: "authenticated",
    exposure: "public",
    host: "127.0.0.1",
    port: Number(port),
    allowedHostnames: [domain],
    serveUi: true,
  },
  auth: { baseUrlMode: "explicit", publicBaseUrl: publicUrl, disableSignUp: false },
  storage: { provider: "local_disk", localDisk: { baseDir: `${instance}/data/storage` } },
  secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: `${instance}/secrets/master.key` } },
  telemetry: { enabled: false },
  updates: { checkEnabled: false },
};
writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
