import { randomBytes } from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import { acquireDataLock, backupSettings, createBackup, get, inspectBackupSettings, loadConfig, newId, nowIso, openDb, restoreBackup, run } from "@devpilot/storage";
import { hashPassword } from "./auth.js";
import { createDemoRepo, seedRoots } from "./seed.js";

const [cmd, ...rest] = process.argv.slice(2);
const config = loadConfig();
if (cmd === "backup-config") {
  if (rest.length !== 1 || !rest[0]) throw new Error("Uso: npm run backup:config -- <archivo>");
  console.log(JSON.stringify(inspectBackupSettings(path.resolve(rest[0])), null, 2));
} else if (cmd === "restore") {
  if (rest.length !== 1 || !rest[0]) throw new Error("Uso: npm run restore -- <archivo>");
  restoreBackup(config.dataDir, config.dbFile, path.resolve(rest[0]));
  console.log("Backup restaurado.");
} else {
  const release = acquireDataLock(config.dataDir, "service");
  try {
    const db = openDb(config.dbFile);
    try { await command(db); } finally { db.close(); }
  } finally { release(); }
}

function setup(db: ReturnType<typeof openDb>): void {
  const username = rest.find((a) => a.startsWith("--user="))?.slice(7) ?? "owner";
  const fromEnv = process.env["DEVPILOT_OWNER_PASSWORD"];
  if (get(db, "SELECT id FROM user LIMIT 1")) { console.log("Ya existe un propietario. Para cambiar la contraseña usá: npm run reset-password"); return; }
  const password = fromEnv ?? randomBytes(12).toString("base64url");
  run(db, "INSERT INTO user(id,username,password_hash,created_at) VALUES(?,?,?,?)", newId("usr"), username, hashPassword(password), nowIso());
  console.log(`Propietario creado.\n  usuario:    ${username}\n  contraseña: ${fromEnv ? "(la definida en DEVPILOT_OWNER_PASSWORD)" : password}`);
  if (!fromEnv) console.log("Guardala ahora: no se vuelve a mostrar.");
}

async function demo(db: ReturnType<typeof openDb>): Promise<void> {
  const parent = path.join(config.dataDir, "projects");
  const repo = await createDemoRepo(parent);
  const rootsAdded = seedRoots(db, { ...config, projectRoots: [parent] });
  const root = get<{ id: string }>(db, "SELECT id FROM allowed_root WHERE canonical_path = ?", realpathSync(parent))!;
  if (!get(db, "SELECT id FROM project WHERE repo_path = ?", repo)) {
    run(db, "INSERT INTO project(id,name,root_id,repo_path,status,enabled_checks,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)", newId("prj"), "demo-app", root.id, repo, "ACTIVE", JSON.stringify(["lint", "test", "typecheck"]), nowIso(), nowIso());
  }
  console.log(`Proyecto demo listo en ${repo}${rootsAdded.length ? " (root agregado)" : ""}`);
}

async function command(db: ReturnType<typeof openDb>): Promise<void> {
  switch (cmd) {
    case "setup": setup(db); break;
    case "reset-password": {
      const pw = process.env["DEVPILOT_OWNER_PASSWORD"] ?? randomBytes(12).toString("base64url");
      run(db, "UPDATE user SET password_hash=?", hashPassword(pw));
      run(db, "UPDATE session SET revoked_at=? WHERE revoked_at IS NULL", nowIso());
      console.log(`Contraseña actualizada y sesiones revocadas.${process.env["DEVPILOT_OWNER_PASSWORD"] ? "" : "\n  nueva contraseña: " + pw}`);
      break;
    }
    case "demo": await demo(db); break;
    case "backup": {
      const dest = createBackup(db, config.dataDir, new Date(), backupSettings(config));
      console.log(`Backup creado: ${dest}`);
      break;
    }
    default:
      console.log("Uso: setup [--user=nombre] | demo | backup | backup-config <archivo> | restore <archivo> | reset-password");
      process.exitCode = cmd ? 1 : 0;
  }
}
