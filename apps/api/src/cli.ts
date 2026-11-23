import { randomBytes } from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import { backupTo, get, loadConfig, newId, nowIso, openDb, run } from "@devpilot/storage";
import { hashPassword } from "./auth.js";
import { createDemoRepo, seedRoots } from "./seed.js";

const [cmd, ...rest] = process.argv.slice(2);
const config = loadConfig();
const db = openDb(config.dbFile);

function setup(): void {
  const username = rest.find((a) => a.startsWith("--user="))?.slice(7) ?? "owner";
  const fromEnv = process.env["DEVPILOT_OWNER_PASSWORD"];
  if (get(db, "SELECT id FROM user LIMIT 1")) { console.log("Ya existe un propietario. Para cambiar la contraseña usá: npm run reset-password"); return; }
  const password = fromEnv ?? randomBytes(12).toString("base64url");
  run(db, "INSERT INTO user(id,username,password_hash,created_at) VALUES(?,?,?,?)", newId("usr"), username, hashPassword(password), nowIso());
  console.log(`Propietario creado.\n  usuario:    ${username}\n  contraseña: ${fromEnv ? "(la definida en DEVPILOT_OWNER_PASSWORD)" : password}`);
  if (!fromEnv) console.log("Guardala ahora: no se vuelve a mostrar.");
}

async function demo(): Promise<void> {
  const parent = path.join(config.dataDir, "projects");
  const repo = await createDemoRepo(parent);
  const rootsAdded = seedRoots(db, { ...config, projectRoots: [parent] });
  const root = get<{ id: string }>(db, "SELECT id FROM allowed_root WHERE canonical_path = ?", realpathSync(parent))!;
  if (!get(db, "SELECT id FROM project WHERE repo_path = ?", repo)) {
    run(db, "INSERT INTO project(id,name,root_id,repo_path,status,enabled_checks,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)", newId("prj"), "demo-app", root.id, repo, "ACTIVE", JSON.stringify(["lint", "test", "typecheck"]), nowIso(), nowIso());
  }
  console.log(`Proyecto demo listo en ${repo}${rootsAdded.length ? " (root agregado)" : ""}`);
}

switch (cmd) {
  case "setup": setup(); break;
  case "reset-password": {
    const pw = process.env["DEVPILOT_OWNER_PASSWORD"] ?? randomBytes(12).toString("base64url");
    run(db, "UPDATE user SET password_hash=?", hashPassword(pw));
    run(db, "UPDATE session SET revoked_at=? WHERE revoked_at IS NULL", nowIso());
    console.log(`Contraseña actualizada y sesiones revocadas.${process.env["DEVPILOT_OWNER_PASSWORD"] ? "" : "\n  nueva contraseña: " + pw}`);
    break;
  }
  case "demo": await demo(); break;
  case "backup": {
    const dest = path.join(config.dataDir, "backups", `devpilot-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    backupTo(db, dest);
    console.log(`Backup creado: ${dest}`);
    break;
  }
  default:
    console.log("Uso: setup [--user=nombre] | demo | backup | reset-password");
    process.exitCode = cmd ? 1 : 0;
}
db.close();
